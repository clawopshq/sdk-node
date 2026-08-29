/**
 * SMS 본문 상한. **EUC-KR 90byte 다** — UTF-8 이 아니다.
 *
 * 서버의 판정 기준(`app/src/services/messages.ts` 의 `SMS_MAX_EUCKR_BYTES`)과 같아야 한다.
 * 어긋나면 우리가 sms 라고 보낸 건이 서버에서 `body_too_long` 으로 거절된다.
 *
 * 솔라피의 SMS 기준(90byte EUC-KR)과 **동일하다**. 옮겨오는 코드의 분기 로직을 그대로 쓸 수 있다.
 */
export const SMS_MAX_EUCKR_BYTES = 90;

/**
 * EUC-KR 기준 바이트 수. ASCII 1byte, 그 외 2byte.
 *
 * EUC-KR 로 표현할 수 없는 문자는 게이트웨이가 `?` 한 글자로 치환하므로 실제로는 1byte 지만
 * 2byte 로 세어 과대평가 쪽에 둔다 — 이 방향의 오차는 본문 잘림을 만들지 않는다.
 */
export function euckrByteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) bytes += ch.codePointAt(0)! < 0x80 ? 1 : 2;
  return bytes;
}

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
  return euckrByteLength(message.text ?? '') > SMS_MAX_EUCKR_BYTES ? 'lms' : 'sms';
}
