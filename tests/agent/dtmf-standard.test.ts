/**
 * 키패드 입력을 표준(Twilio <Gather>·LiveKit GetDtmfTask·Pipecat DTMFAggregator) 방식에 맞춘 동작.
 *
 * 왜 있나: 2026-10-23 실통화(현대차 셔클 구성)에서 기본 구성의 결함이 나왔다(Python SDK 0.70.0 과 같은 수정).
 *   ① 자동 전달 대기 0.5초 < 사람 손 간격(0.33~0.94초) → 534 가 5·3·4 로 쪼개져 모델이 세 번 대답
 *   ② 자동 전달에 종료키가 없어 # 이 글자로 따로 들어감
 *   ③ collectDtmf 가 수집 전에 자동 전달된 키까지 가져가 「1534」
 *   ④ collectDtmf 대기가 안내 음성 재생 중에 흘러 누를 틈 없이 빈 값 → 통화 종료
 *   ⑤ (node 만) 자동 전달 버퍼가 에이전트에 하나뿐이라 동시 통화의 키가 섞였다
 */
import { describe, it, expect } from 'vitest';
import { ClawOpsAgent } from '../../src/agent/agent.js';
import { CallSession } from '../../src/agent/session.js';
import { MediaWebSocket, PLAYOUT_QUIET_MS } from '../../src/agent/media-ws.js';
import { holdAudioAllowed } from '../../src/agent/hold-audio.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recordingSession(feedDelayMs = 0) {
  const fed: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    fed,
    get maxInFlight() {
      return maxInFlight;
    },
    start: async () => {},
    feedAudio: () => {},
    stop: async () => {},
    feedDtmf: async (digits: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (feedDelayMs) await sleep(feedDelayMs);
      fed.push(digits);
      inFlight--;
    },
  };
}

function makeAgent(options: Record<string, unknown> = {}): ClawOpsAgent {
  return new ClawOpsAgent({
    apiKey: 'test',
    accountId: 'AC_test',
    from: '07012345678',
    session: recordingSession() as never,
    ...options,
  });
}

function attachCall(agent: ClawOpsAgent, session: unknown, callId = 'CA_t'): CallSession {
  const call = new CallSession({
    callId,
    fromNumber: '01000000000',
    toNumber: '07012345678',
    accountId: 'AC_test',
    direction: 'inbound',
  });
  (agent as any)._callSessions.set(callId, session);
  return call;
}

const press = (agent: ClawOpsAgent, call: CallSession, digit: string) =>
  (agent as any)._onDtmfEvent(call, digit);

function newCall(): CallSession {
  return new CallSession({
    callId: 'CA_t',
    fromNumber: '010',
    toNumber: '070',
    accountId: 'AC',
    direction: 'inbound',
  });
}

/** media WS 대역 — release() 를 부를 때까지 안내가 재생 중인 것처럼 군다. */
function fakePlayout() {
  let release!: () => void;
  const played = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  let aborted = false;
  const waitPlayedOut = (timeoutMs: number, signal?: AbortSignal) => {
    calls++;
    return new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      signal?.addEventListener('abort', () => {
        aborted = true;
        clearTimeout(t);
        resolve(false);
      });
      played.then(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  };
  return {
    waitPlayedOut,
    release: () => release(),
    get calls() {
      return calls;
    },
    get aborted() {
      return aborted;
    },
  };
}

describe('① 기본 대기 2초', () => {
  it('기본값은 대기 2초·종료키 #·자리 수 없음', () => {
    const agent = makeAgent() as any;
    expect(agent._passiveDtmfDebounceMs).toBe(2000);
    expect(agent._passiveDtmfFinishKey).toBe('#');
    expect(agent._passiveDtmfMaxDigits).toBeNull();
  });

  it('사람 속도로 누른 세 자리가 한 번에 간다', async () => {
    // 0.8초 간격(실측)을 대기 비율 그대로 줄인다: 간격 80ms < 대기 200ms
    const agent = makeAgent({ passiveDtmfDebounceMs: 200 });
    const s = recordingSession();
    const call = attachCall(agent, s);
    for (const d of '534') {
      press(agent, call, d);
      await sleep(80);
    }
    await sleep(350);
    expect(s.fed).toEqual(['534']);
  });
});

describe('② 종료키·자리 수', () => {
  it('종료키는 즉시 확정하고 값에서 빠진다', async () => {
    const agent = makeAgent({ passiveDtmfDebounceMs: 5000 });
    const s = recordingSession();
    const call = attachCall(agent, s);
    for (const d of '534#') press(agent, call, d);
    await sleep(30);
    expect(s.fed).toEqual(['534']);
  });

  it('빈 버퍼에 종료키만 누르면 그 키를 넘긴다', async () => {
    const agent = makeAgent({ passiveDtmfDebounceMs: 5000 });
    const s = recordingSession();
    const call = attachCall(agent, s);
    press(agent, call, '#');
    await sleep(30);
    expect(s.fed).toEqual(['#']);
  });

  it('종료키를 끄면 #도 보통 키다', async () => {
    const agent = makeAgent({ passiveDtmfDebounceMs: 100, passiveDtmfFinishKey: null });
    const s = recordingSession();
    const call = attachCall(agent, s);
    for (const d of '12#') press(agent, call, d);
    await sleep(250);
    expect(s.fed).toEqual(['12#']);
  });

  it('자리 수가 차면 즉시 확정한다', async () => {
    const agent = makeAgent({ passiveDtmfDebounceMs: 5000, passiveDtmfMaxDigits: 4 });
    const s = recordingSession();
    const call = attachCall(agent, s);
    for (const d of '123456') press(agent, call, d);
    await sleep(30);
    // 넘친 두 자리는 다음 값으로 넘어간다(「자리 수가 항상 같을 때만」 쓰라는 이유).
    expect(s.fed).toEqual(['1234']);
    (call as any)._markEnded();
  });

  it.each([
    { passiveDtmfFinishKey: 'A' },
    { passiveDtmfFinishKey: '##' },
    { passiveDtmfFinishKey: '' },
    { passiveDtmfMaxDigits: 0 },
    { passiveDtmfMaxDigits: 1.5 },
    { passiveDtmfDebounceMs: -1 },
  ])('잘못된 설정은 생성할 때 막는다 %o', (opts) => {
    expect(() => makeAgent(opts)).toThrow();
  });

  it('연달아 확정된 자동 전달은 차례로 보낸다', async () => {
    const agent = makeAgent({ passiveDtmfDebounceMs: 5000 });
    const s = recordingSession(40);
    const call = attachCall(agent, s);
    for (const d of '1#2#') press(agent, call, d);
    await sleep(200);
    expect(s.fed).toEqual(['1', '2']);
    expect(s.maxInFlight).toBe(1);
  });
});

describe('⑤ 동시 통화', () => {
  it('두 통화가 같은 대기 창에서 눌러도 각자 자기 키만 받는다', async () => {
    const agent = makeAgent({ passiveDtmfDebounceMs: 60 });
    const sa = recordingSession();
    const sb = recordingSession();
    const a = attachCall(agent, sa, 'CA_a');
    const b = attachCall(agent, sb, 'CA_b');
    press(agent, a, '1');
    press(agent, b, '9');
    press(agent, a, '2');
    press(agent, b, '8');
    await sleep(200);
    expect(sa.fed).toEqual(['12']);
    expect(sb.fed).toEqual(['98']);
  });

  it('끝난 통화의 대기 중 키는 주입하지 않는다', async () => {
    const agent = makeAgent({ passiveDtmfDebounceMs: 60 });
    const s = recordingSession();
    const call = attachCall(agent, s);
    press(agent, call, '1');
    (call as any)._markEnded();
    await sleep(150);
    expect(s.fed).toEqual([]);
  });
});

describe('③ 수집 구간 안의 키만', () => {
  it('자동 전달된 키는 다음 수집에 섞이지 않는다 (실통화 「1534」)', async () => {
    const agent = makeAgent({ passiveDtmfDebounceMs: 50 });
    const s = recordingSession();
    const call = attachCall(agent, s);
    press(agent, call, '1');
    await sleep(100);
    expect(s.fed).toEqual(['1']);

    const task = call.collectDtmf({ maxDigits: 4, timeout: 0.3 });
    await sleep(20);
    for (const d of '534#') press(agent, call, d);
    expect(await task).toBe('534');
    await sleep(100);
    expect(s.fed).toEqual(['1']);
  });

  it('수집이 열리면 대기 중인 자동 전달 키를 바로 넘긴다', async () => {
    const agent = makeAgent({ passiveDtmfDebounceMs: 5000 });
    const s = recordingSession();
    const call = attachCall(agent, s);
    press(agent, call, '1'); // 5초 대기 중
    const task = call.collectDtmf({ maxDigits: 3, timeout: 0.2 });
    await sleep(30);
    expect(s.fed).toEqual(['1']);
    for (const d of '534') press(agent, call, d);
    expect(await task).toBe('534');
  });

  it('수집을 열 때 남은 키를 버린다', async () => {
    const call = newCall();
    (call as any)._dtmfBuffer.push('9'); // 구간 밖에서 들어온 키(방어 대상)
    const task = call.collectDtmf({ maxDigits: 3, timeout: 0.2 });
    await sleep(20);
    call._routeDtmf('1');
    call._routeDtmf('2');
    expect(await task).toBe('12');
  });
});

describe('④ 대기는 안내 재생이 끝난 뒤부터', () => {
  it('안내 재생 중엔 대기가 흐르지 않는다 (실통화 s5)', async () => {
    const call = newCall();
    const playout = fakePlayout();
    call._waitPlayedOut = playout.waitPlayedOut;
    let done = false;
    const task = call.collectDtmf({ maxDigits: 3, timeout: 0.1 }).then((v) => {
      done = true;
      return v;
    });
    await sleep(400); // timeout 의 4배
    expect(done).toBe(false);
    playout.release();
    await sleep(30);
    call._routeDtmf('5');
    call._routeDtmf('3');
    expect(await task).toBe('53');
    expect(playout.calls).toBe(1);
  });

  it('재생이 끝난 뒤부터 자리 사이 대기를 센다', async () => {
    const call = newCall();
    const playout = fakePlayout();
    call._waitPlayedOut = playout.waitPlayedOut;
    const task = call.collectDtmf({ maxDigits: 3, timeout: 0.15 });
    await sleep(300);
    playout.release();
    const released = Date.now();
    expect(await task).toBe('');
    expect(Date.now() - released).toBeGreaterThanOrEqual(140);
  });

  it('재생 중 첫 키를 받고 안내를 끊고, 재생 대기는 접는다', async () => {
    const agent = makeAgent();
    const s = recordingSession();
    const call = attachCall(agent, s);
    const playout = fakePlayout();
    call._waitPlayedOut = playout.waitPlayedOut;
    let cleared = 0;
    call._bindTransport(
      () => {},
      () => {
        cleared++;
      },
      async () => {},
    );
    const task = call.collectDtmf({ maxDigits: 3, timeout: 0.2 });
    await sleep(30);
    press(agent, call, '5'); // 안내가 아직 재생 중
    await sleep(10);
    press(agent, call, '3');
    press(agent, call, '4');
    expect(await task).toBe('534');
    expect(cleared).toBeGreaterThan(0);
    expect(playout.aborted).toBe(true);
    expect(s.fed).toEqual([]);
  });

  it('재생이 먼저 끝나면 걸어 둔 첫 키 resolver 를 거둔다(다음 키를 잃지 않는다)', async () => {
    const call = newCall();
    const playout = fakePlayout();
    call._waitPlayedOut = playout.waitPlayedOut;
    const task = call.collectDtmf({ maxDigits: 2, timeout: 0.3 });
    await sleep(20);
    playout.release();
    await sleep(20);
    call._routeDtmf('1');
    call._routeDtmf('2');
    expect(await task).toBe('12');
  });

  it('재생 끝을 못 알아도 상한에서 센다', async () => {
    const call = newCall();
    call._waitPlayedOut = fakePlayout().waitPlayedOut; // release 안 함
    const t0 = Date.now();
    expect(await call.collectDtmf({ maxDigits: 3, timeout: 0.05, maxWait: 0.2 })).toBe('');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('재생 끝 확인이 실패해도 수집은 계속된다', async () => {
    const call = newCall();
    call._waitPlayedOut = () => Promise.reject(new Error('closing'));
    const task = call.collectDtmf({ maxDigits: 2, timeout: 0.2 });
    await sleep(20);
    call._routeDtmf('1');
    call._routeDtmf('2');
    expect(await task).toBe('12');
  });
});

describe('MediaWebSocket.waitPlayedOut', () => {
  function withFakeWs(onMark: (mws: MediaWebSocket, name: string) => void) {
    const mws = new MediaWebSocket();
    const ws = {
      readyState: 1,
      send(raw: string) {
        const msg = JSON.parse(raw);
        if (msg.event === 'mark') onMark(mws, msg.mark.name);
      },
      close() {
        this.readyState = 3;
      },
    };
    (mws as any)._ws = ws;
    (mws as any)._formatValidated = true;
    return mws;
  }

  it('mark 를 보내기 전에 waiter 를 건다(즉시 echo 를 놓치지 않는다)', async () => {
    const mws = withFakeWs((m, name) => {
      const resolve = (m as any)._markWaiters.get(name);
      expect(resolve).toBeDefined();
      resolve();
    });
    const t0 = Date.now();
    expect(await mws.waitPlayedOut(2000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
    expect((mws as any)._markWaiters.size).toBe(0);
  });

  it('소켓이 닫히면 재생 끝 대기가 바로 풀린다', async () => {
    const mws = withFakeWs(() => {});
    const t0 = Date.now();
    const p = mws.waitPlayedOut(30_000);
    await sleep(20);
    mws.close();
    expect(await p).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('오디오가 이어서 들어오는 동안엔 mark 를 보내지 않는다', async () => {
    let sentAt = 0;
    const mws = withFakeWs((m, name) => {
      sentAt = Date.now();
      (m as any)._markWaiters.get(name)();
    });
    const trickle = (async () => {
      for (let i = 0; i < 5; i++) {
        mws.sendAudio('AA==');
        (mws as any)._audioQueue.length = 0; // 송신 루프가 바로 내보낸 것과 같다
        await sleep(100);
      }
    })();
    await sleep(5);
    const t0 = Date.now();
    expect(await mws.waitPlayedOut(5000)).toBe(true);
    await trickle;
    expect(sentAt - t0).toBeGreaterThanOrEqual(400 + PLAYOUT_QUIET_MS - 60);
  });

  it('abort 되면 접고 false', async () => {
    const mws = withFakeWs(() => {});
    const ac = new AbortController();
    const p = mws.waitPlayedOut(30_000, ac.signal);
    await sleep(20);
    ac.abort();
    expect(await p).toBe(false);
    expect((mws as any)._markWaiters.size).toBe(0);
  });
});

describe('대기음', () => {
  it('키를 받는 도구에는 대기음을 틀지 않는다', () => {
    expect(holdAudioAllowed(['lookup_order'])).toBe(true);
    expect(holdAudioAllowed(['collect_dtmf'])).toBe(false);
    expect(holdAudioAllowed(['lookup_order', 'collect_dtmf'])).toBe(false);
  });
});

describe('코드 리뷰 반영', () => {
  it('재생 끝 대기가 길어져도 abort 리스너가 쌓이지 않는다', async () => {
    const mws = new MediaWebSocket();
    (mws as any)._ws = {
      readyState: 1,
      send(raw: string) {
        const msg = JSON.parse(raw);
        if (msg.event === 'mark') (mws as any)._markWaiters.get(msg.mark.name)();
      },
      close() {},
    };
    (mws as any)._formatValidated = true;
    const ac = new AbortController();
    let added = 0;
    let removed = 0;
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    (ac.signal as any).addEventListener = (...a: Parameters<AbortSignal['addEventListener']>) => {
      added++;
      origAdd(...a);
    };
    (ac.signal as any).removeEventListener = (
      ...a: Parameters<AbortSignal['removeEventListener']>
    ) => {
      removed++;
      origRemove(...a);
    };
    const trickle = (async () => {
      for (let i = 0; i < 4; i++) {
        mws.sendAudio('AA==');
        (mws as any)._audioQueue.length = 0;
        await sleep(100);
      }
    })();
    await sleep(5);
    expect(await mws.waitPlayedOut(5000, ac.signal)).toBe(true);
    await trickle;
    // 조용한 구간 대기마다 붙인 리스너는 타이머가 끝날 때 떼었다(마지막 mark 대기 하나만 남을 수 있다).
    expect(added - removed).toBeLessThanOrEqual(1);
  });

  it('앞선 주입을 기다리는 사이 통화가 끝나면 남은 주입을 보내지 않는다', async () => {
    const agent = makeAgent({ passiveDtmfDebounceMs: 5000 });
    const s = recordingSession(60);
    const call = attachCall(agent, s);
    call._bindTransport(
      () => {},
      () => {},
      async () => {},
    );
    press(agent, call, '1');
    press(agent, call, '#'); // '1' 주입 시작(60ms 걸림)
    press(agent, call, '2');
    press(agent, call, '#'); // '2' 는 줄 서서 기다림
    await sleep(20);
    (call as any)._markEnded();
    await sleep(200);
    expect(s.fed).toEqual(['1']);
  });
});
