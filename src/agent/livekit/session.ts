/**
 * LiveKitSession — 유저의 LiveKit AgentSession 을 ClawOps `Session` 계약으로 감싼다.
 *
 * `ClawOpsAgent` 는 `Session`(pipeline/base.ts)만 알고 통화를 굴린다. 이 클래스가 그
 * 계약을 구현하면서 내부적으로 LiveKit AgentSession 을 돌린다 — room 없이.
 *
 * 유저는 관용적인 LiveKit 코드를 그대로 쓴다. `Agent` 서브클래스와 `AgentSession` 설정은
 * 손대지 않아도 되고, 유일한 차이는 `session.start({ room })` 을 우리가 room 없이
 * 대신 불러준다는 것이다.
 *
 * ⚠️ v0 은 동시통화 1건이다 (`ClawOpsAgent` 가 세션 인스턴스를 통화 간 공유한다).
 * `create` 를 팩토리로 받아두었으므로, 추후 통화당 격리로 넘어갈 때 유저 코드는 그대로 둔다.
 */

import type { Logger } from 'pino';

import { NOOP_LOGGER } from '../logger.js';
import type { CallSession } from '../session.js';
import type { Session } from '../pipeline/base.js';
import type { ToolRegistry } from '../tool.js';
import type { BuiltinTool } from '../builtin-tool.js';
import type { SessionTelemetry } from '../telemetry.js';
import { BufferingCall, attachBuffered } from '../pipeline/buffering-call.js';
import { loadClawOpsIO } from './io.js';
import type { ClawOpsAudioInputInstance, ClawOpsAudioOutputInstance } from './io.js';
import { createClawOpsPhoneTools } from './toolset.js';
import type { ClawOpsPhoneTools } from './toolset.js';

/**
 * 통화당 1회 호출되는 팩토리. `[AgentSession, Agent]` 를 반환한다.
 *
 * `call` 은 착신/일반 시작에서는 실제 CallSession, 발신 prewarm 중에는 null 이다
 * (prewarm 은 응답 전에 도는데 `Session.prewarm()` 이 call 을 넘겨주지 않는다).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LiveKitCreateFn = (call: CallSession | null) => Promise<[any, any]>;

export class LiveKitSession implements Session {
  private readonly _create: LiveKitCreateFn;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _session: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _agent: any = null;
  private _input: ClawOpsAudioInputInstance | null = null;
  private _output: ClawOpsAudioOutputInstance | null = null;
  private _phone: ClawOpsPhoneTools | null = null;
  private _target: CallSession | BufferingCall | null = null;
  /** 유저 원본 도구 스냅샷 (우리 도구 추가 전). attach 재적용 시 누적 방지. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _userToolCtx: any = null;

  private _toolRegistry: ToolRegistry | null = null;
  private _builtinTools: Set<BuiltinTool> | null = null;
  private _log: Logger = NOOP_LOGGER;

  // 동적 로드한 agents-js 네임스페이스 (boot 시 캐시).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _llm: any = null;

  constructor(create: LiveKitCreateFn) {
    this._create = create;
  }

  // ── ClawOpsAgent 가 duck-typing 으로 주입하는 setter ──────────

  setToolRegistry(registry: ToolRegistry): void {
    this._toolRegistry = registry;
  }

  setBuiltinTools(tools: Set<BuiltinTool>): void {
    this._builtinTools = tools;
  }

  setLogger(logger: Logger): void {
    this._log = logger;
  }

  getTelemetry(): SessionTelemetry | null {
    // 녹음/텔레메트리는 미디어 레이어에서 세션 무관하게 동작하므로 여기선 null.
    return null;
  }

  // ── Session 계약 ────────────────────────────────────────────

  async start(callSession: CallSession, tools?: ToolRegistry): Promise<void> {
    if (tools) this._toolRegistry = tools;
    await this._boot(callSession);
  }

  async prewarm(tools?: ToolRegistry): Promise<void> {
    if (tools) this._toolRegistry = tools;
    await this._boot(null);
  }

  async attach(callSession: CallSession): Promise<void> {
    // boot 성공 신호는 _session (부분 완료된 boot 은 _output 만 set 돼 있을 수 있다).
    if (!this._session || !this._output || !this._agent) {
      await this._boot(callSession);
      return;
    }
    const prev = this._target;
    this._output.setCall(callSession);
    this._target = callSession;
    // ⚠️ 아웃바운드 prewarm 은 _boot(null) 이 setter 실행 전에 돌아 도구를 비운 채
    // 시작한다. setter 는 이제 실행됐으므로 여기서 registry/builtin 도구를 다시 붙인다.
    await this._applyTools(callSession);
    attachBuffered(prev, callSession);
  }

  feedAudio(audio: Buffer, _timestamp?: number): void {
    this._input?.pushUlaw(audio);
  }

  async feedDtmf(digits: string): Promise<void> {
    if (!this._session) return;
    // generateReply 는 동기 메서드다. teardown 중에는 세션 activity 가 이미 정리돼
    // 던질 수 있으므로 삼킨다.
    try {
      this._session.generateReply({ userInput: `[전화 키패드 입력] ${digits}` });
    } catch (err) {
      this._log.debug({ err }, 'feedDtmf skipped (session not running)');
    }
  }

  async stop(): Promise<void> {
    this._input?.endInput();
    await this._closeAgentSession();
  }

  // ── 내부 ────────────────────────────────────────────────────

  private async _boot(call: CallSession | null): Promise<void> {
    // 재진입(attach 실패 폴백) 시 이전 세션이 새지 않도록 먼저 닫는다.
    await this._closeAgentSession();

    // agents import 와 IO 로드는 독립적이라 병렬로 (boot 1회, 이후 loadClawOpsIO 는 캐시).
    const [agents, io] = await Promise.all([
      import('@livekit/agents') as Promise<{ llm: unknown }>,
      loadClawOpsIO(),
    ]);
    this._llm = (agents as { llm: unknown }).llm;
    const { ClawOpsAudioInput, ClawOpsAudioOutput } = io;

    const target: CallSession | BufferingCall = call ?? new BufferingCall();

    const [session, agent] = await this._create(call);
    this._validate(session, agent);

    const input = new ClawOpsAudioInput();
    const output = new ClawOpsAudioOutput(target as unknown as {
      sendAudio(audio: Buffer): void | Promise<void>;
      clearAudio(): void;
    });
    this._input = input;
    this._output = output;

    session.input.audio = input;
    session.output.audio = output;
    // agents-js 의 room-less 레퍼런스(AgentsConsole)도 transcription sync 를 생략한다.
    // (transcript 는 conversation_item_added 로 별도 브리지한다 — _wireTranscripts.)
    session.output.transcription = null;

    this._wireTranscripts(session);

    this._agent = agent;
    // 우리 도구를 붙이기 전 유저 원본 도구를 스냅샷한다 (attach 재적용 시 누적 방지).
    this._userToolCtx = agent.toolCtx;
    await this._applyTools(call);

    // room 을 넘기지 않는 것이 이 통합의 전부다.
    await session.start({ agent });

    this._session = session;
    this._target = target;
  }

  /**
   * 유저 도구 + 브리지된 registry 도구 + 내장 전화 도구를 이름 충돌 없이 붙인다.
   *
   * 아웃바운드 prewarm(_boot(null))은 setter 실행 전에 돌아 registry/builtin 이 비어
   * 있고, 그 사이엔 통화가 연결되지 않아 도구를 쓸 일도 없다. 그래서 이때는 유저 도구만
   * 올리고, attach() 가 setter 실행 후 실제 도구를 붙이는 유일한 조립 지점이 된다.
   */
  private async _applyTools(call: CallSession | null): Promise<void> {
    if (!this._agent) return;
    const agent = this._agent;
    const llm = this._llm;

    if (call === null) {
      // prewarm — 아직 registry/builtin 이 없다. 유저 원본 ToolContext 를 그대로 재적용.
      await agent.updateTools(this._userToolCtx);
      return;
    }

    // 유저 도구(중첩 Toolset 포함)의 실제 함수 이름을 모은다 — 내장 도구와 겹칠 때
    // ToolContext.flatten() 이 "duplicate function name" 으로 통화를 떨구는 걸 막는다.
    const taken = new Set<string>(llm.sortedToolNames(this._userToolCtx));
    const bridged = this._bridgeRegistry(this._toolRegistry, taken);

    const enabled = this._builtinTools ?? new Set<BuiltinTool>();
    this._phone = createClawOpsPhoneTools(llm, { enabled, excludeNames: taken });
    this._phone.setCall(call);

    // ⚠️ sortedToolEntries 는 `[name, tool]` 쌍을 준다. updateTools/ToolContext 는 bare
    // tool 배열(ToolContextEntry[])을 받으므로 tool 만 추출해 넘긴다 — 쌍을 그대로 펼치면
    // 유저 도구가 유효하지 않은 엔트리로 취급돼 전부 유실된다.
    const userTools = (llm.sortedToolEntries(this._userToolCtx) as Array<[string, unknown]>).map(
      (entry) => entry[1],
    );
    await agent.updateTools([...userTools, ...bridged, this._phone.toolset]);
  }

  /** `@tool` / MCP 도구(ToolRegistry)를 LiveKit function tool 로 노출한다. */
  private _bridgeRegistry(registry: ToolRegistry | null, taken: Set<string>): unknown[] {
    if (!registry) return [];
    const llm = this._llm;
    const out: unknown[] = [];
    for (const def of registry.toOpenAITools()) {
      const name = def.function.name;
      if (taken.has(name)) continue; // 유저 도구가 우선.
      taken.add(name);
      out.push(
        llm.tool({
          name,
          description: def.function.description,
          parameters: def.function.parameters,
          execute: async (args: Record<string, unknown>) => {
            const result = await registry.call(name, args ?? {});
            return typeof result === 'string' ? result : JSON.stringify(result);
          },
        }),
      );
    }
    return out;
  }

  /**
   * LiveKit 의 최종 대화 항목을 ClawOps `transcript` 훅으로 흘려보낸다.
   *
   * 네이티브 세션(OpenAI/Gemini/Pipeline)은 `call._emit('transcript', role, text)` 를
   * 부른다. `@on('transcript')` 로 트랜스크립트를 모으는 기존 앱이 세션만 바꿔도 그대로
   * 돌게 하려면 여기서 같은 계약을 재현한다.
   *
   * `conversation_item_added` 는 user·assistant 최종 메시지가 히스토리에 커밋될 때 한
   * 번씩 뜬다 — 부분(interim) 중복 없이 최종만 얻는다. item 이 handoff 등 ChatMessage 가
   * 아니면 role/textContent 가 없어 자연히 걸러진다.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _wireTranscripts(session: any): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.on('conversation_item_added', (ev: any) => {
      const item = ev?.item;
      const role = item?.role;
      if (role !== 'user' && role !== 'assistant') return;
      const text = item?.textContent;
      if (!text) return;
      const target = this._target as unknown as { _emit?: (event: string, ...args: unknown[]) => void };
      // Node 의 _emit 은 동기다 — Python 처럼 fire-and-forget task 를 추적할 필요 없다.
      // prewarm 중이면 _target 이 BufferingCall 이라 _emit 이 드롭 카운트로 흡수한다.
      target?._emit?.('transcript', role, text);
    });
  }

  private async _closeAgentSession(): Promise<void> {
    if (this._output) {
      this._output.close();
      this._output = null;
    }
    if (this._session) {
      const s = this._session;
      this._session = null;
      try {
        if (typeof s.aclose === 'function') {
          await s.aclose();
        } else if (typeof s.close === 'function') {
          await s.close();
        }
      } catch (err) {
        this._log.warn({ err }, 'AgentSession close failed');
      }
    }
  }

  /**
   * LiveKit 이 조용히 넘어가는 두 조합을 우리가 막는다 — 실수하면 "말을 못 하는
   * 에이전트"가 아무 예외 없이 배포된다.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _validate(session: any, agent: any): void {
    let audioOutput: unknown;
    let tts: unknown;
    try {
      const llm = agent?.llm ?? session?.llm;
      tts = agent?.tts ?? session?.tts;
      audioOutput = llm?.capabilities?.audioOutput;
    } catch {
      return; // capabilities 를 못 읽으면 검증 생략 (거짓 양성 방지).
    }
    if (audioOutput === undefined || audioOutput === null) {
      return; // realtime 모델이 아니다 (일반 LLM + TTS 파이프라인).
    }
    if (audioOutput === false && (tts === undefined || tts === null)) {
      throw new Error(
        "RealtimeModel 이 modalities=['text'] 인데 tts 가 없습니다 — 에이전트가 소리를 " +
          "내지 못합니다. AgentSession(tts=...) 를 주거나 modalities 에 'audio' 를 넣으세요.",
      );
    }
    if (audioOutput === true && tts !== undefined && tts !== null) {
      this._log.warn(
        'RealtimeModel 이 오디오를 직접 출력하므로 tts 가 무시됩니다. TTS 를 쓰려면 ' +
          "RealtimeModel(modalities=['text']) 로 설정하세요.",
      );
    }
  }
}
