/**
 * SMS 본문 상한(byte, UTF-8).
 * 서버의 판정 기준(`app/src/services/messages.ts` 의 `SMS_MAX_BYTES`)과 같아야 한다.
 * 어긋나면 우리가 sms 라고 보낸 건이 서버에서 `body_too_long` 으로 거절된다.
 */
export const SMS_MAX_BYTES = 200;

/** solapi 는 phoneNumberSchema 로 하이픈을 제거한다. 응답과 맞추려면 같은 규칙이 필요하다 */
export const normalizePhone = (value: string): string => value.replace(/-/g, '');

/**
 * ClawOps 로 보낼 때의 메시지 타입.
 * 명시된 sms/lms 는 그대로 존중하고, 그 외에는 서버와 같은 규칙으로 정한다.
 */
/** 메시지 타입을 한 가지 표기로 통일한다. 없으면 빈 문자열 */
export const upperType = (message: { type?: unknown }): string =>
  message.type === undefined ? '' : String(message.type).toUpperCase();

export function clawopsType(message: {
  type?: unknown;
  text?: string | null;
  subject?: string | null;
}): 'sms' | 'lms' {
  const type = upperType(message);
  if (type === 'SMS') return 'sms';
  if (type === 'LMS') return 'lms';
  if (message.subject !== undefined && message.subject !== null && message.subject !== '') {
    return 'lms';
  }
  return Buffer.byteLength(message.text ?? '', 'utf8') > SMS_MAX_BYTES ? 'lms' : 'sms';
}
