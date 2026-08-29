import type { SolapiMessageService, RequestSendMessagesSchema } from 'solapi';
import { upperType } from './_message-type.js';

/** 제네릭을 거쳐야 유니온(단건 | 배열)에 분배된다 */
type Elem<T> = T extends readonly (infer U)[] ? U : T;
export type SolapiMessage = Elem<RequestSendMessagesSchema>;

const VARIABLE_KEY = /^#\{.+\}$/;
const LEFTOVER = /#\{[^}]*\}/g;

/** solapi SDK 와 같은 규칙: `name` → `#{name}`, 이미 `#{...}` 면 그대로 */
const asKey = (key: string): string => (VARIABLE_KEY.test(key) ? key : `#{${key}}`);

export function render(content: string, variables: Record<string, string> = {}): string {
  let out = content;
  for (const [key, value] of Object.entries(variables)) {
    out = out.split(asKey(key)).join(value);
  }
  return out;
}

/** 치환되지 않고 남은 변수. 하나라도 있으면 발송하지 않는다 */
export const leftovers = (text: string): string[] => text.match(LEFTOVER) ?? [];

/**
 * 본문을 카카오 템플릿에서 만드는 타입.
 *
 * NSA(네이버 스마트알림)는 제외한다 — templateId 가 `naverOptions` 에 있고
 * 조회도 `getKakaoAlimtalkTemplate` 이 아닌 다른 API 라, 여기서 다루면 항상 실패한다.
 */
const KAKAO_TEMPLATE_TYPES = new Set(['ATA']);

export type FallbackSource = 'customFields' | 'template' | 'text';

/**
 * 문구 복원에 필요한 최소 모양.
 *
 * 발송 요청(`SolapiMessage`)과 조회 결과(`storedMessage`)를 둘 다 받는다 —
 * 조회 결과의 `kakaoOptions` 는 서버 정규화 포맷이라 `Record<string, unknown>` 으로 온다.
 */
export interface FallbackInput {
  type?: unknown;
  text?: string | null;
  customFields?: Record<string, string> | null;
  kakaoOptions?: Record<string, unknown> | null;
}

/** 정규화 포맷이든 요청 포맷이든 템플릿 참조를 안전하게 꺼낸다 */
function templateRef(kakaoOptions: unknown): {
  templateId?: string;
  variables?: Record<string, string>;
} {
  if (kakaoOptions === null || typeof kakaoOptions !== 'object') return {};
  const options = kakaoOptions as Record<string, unknown>;
  const templateId = typeof options.templateId === 'string' ? options.templateId : undefined;

  let variables: Record<string, string> | undefined;
  const raw = options.variables;
  if (raw !== null && typeof raw === 'object') {
    const entries = Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    if (entries.length > 0) variables = Object.fromEntries(entries);
  }
  return { templateId, variables };
}

export type FallbackText =
  | { ok: true; text: string; source: FallbackSource }
  | { ok: false; reason: 'unresolved_variables'; unresolved: string[]; source: FallbackSource }
  | { ok: false; reason: 'no_template_content' | 'no_text'; source: FallbackSource };

export interface ResolveOptions {
  /** 대체 문구를 읽어올 customFields 키 */
  field?: string;
  /**
   * 템플릿 본문 캐시. 호출자가 수명을 정한다.
   *
   * 값이 아니라 진행 중인 조회를 담는다 — 여러 건이 동시에 같은 템플릿을 찾을 때
   * 완료를 기다리며 캐시가 비어 있으면 같은 요청이 그 수만큼 나간다.
   */
  cache?: Map<string, Promise<string | undefined>>;
}

export const DEFAULT_FALLBACK_FIELD = 'clawopsFallbackText';

/**
 * 대체발송에 쓸 문구를 만든다.
 *
 * 솔라피는 이 문구를 콘솔(템플릿별 대체발송 설정)에만 두고 API 로 노출하지 않는다.
 * 알림톡은 대개 `text` 없이 `variables` 만 보내므로 템플릿 본문을 조회해 직접 치환한다.
 */
export async function resolveFallbackText(
  message: FallbackInput,
  solapi: SolapiMessageService,
  options: ResolveOptions = {},
): Promise<FallbackText> {
  const field = options.field ?? DEFAULT_FALLBACK_FIELD;

  // 고객이 명시한 문구가 있으면 그것이 정본이다
  const explicit = message.customFields?.[field];
  if (explicit !== undefined) return finish(explicit, 'customFields');

  // 그 외에는 메시지 타입이 출처를 정한다
  // 템플릿 참조가 있으면 그쪽이 우선이다. 조회 결과의 kakaoOptions 는 서버 정규화 포맷이라
  // templateId 가 없을 수도 있는데, 그때는 아래 text 경로로 내려간다
  const { templateId, variables } = templateRef(message.kakaoOptions);
  if (KAKAO_TEMPLATE_TYPES.has(upperType(message)) && templateId !== undefined) {
    const cache = options.cache;
    let pending = cache?.get(templateId);
    if (pending === undefined) {
      pending = solapi.getKakaoAlimtalkTemplate(templateId).then((template) => template.content);
      // await 하기 전에 등록해야 뒤따르는 호출이 같은 조회를 기다린다
      cache?.set(templateId, pending);
      // 실패는 캐시하지 않는다. 남겨두면 일시적 오류가 영구 실패가 된다
      pending.catch(() => cache?.delete(templateId));
    }
    const content = await pending;
    if (content === undefined) {
      return { ok: false, reason: 'no_template_content', source: 'template' };
    }
    return finish(render(content, variables), 'template');
  }

  if (message.text === undefined || message.text === null) {
    return { ok: false, reason: 'no_text', source: 'text' };
  }
  return finish(message.text, 'text');
}

function finish(text: string, source: FallbackSource): FallbackText {
  const unresolved = leftovers(text);
  return unresolved.length > 0
    ? { ok: false, reason: 'unresolved_variables', unresolved, source }
    : { ok: true, text, source };
}
