/**
 * 전환이 연결되지 않았을 때 **발신자에게** 들려주고 끊을 문장 (`failureMessage`).
 *
 * 왜 있나: `afterTransfer: 'terminate'` 에서 대상이 안 받으면 고객은 아무 말 없이 끊겼다.
 * whisper 는 **전화를 받은 담당자**에게만 들리므로 이 경우를 덮지 못한다 — 듣는 사람이 다르다.
 *
 * 파이썬 SDK 의 tests/agent/test_transfer_failure_announcement.py 와 짝이다. 두 SDK 가
 * 어긋나면 문서 한 벌이 두 곳에서 거짓이 되므로 payload 키 이름까지 같이 고정한다.
 */
import { describe, it, expect } from 'vitest';

import { CallSession } from '../../src/agent/session.js';

function makeCall(): { call: CallSession; sent: Record<string, unknown>[] } {
  const call = new CallSession({
    callId: 'CA_t',
    fromNumber: '01040494897',
    toNumber: '07012341234',
    accountId: 'AC',
    direction: 'inbound',
  });
  const sent: Record<string, unknown>[] = [];
  call._transferFn = async (params: Record<string, unknown>) => {
    sent.push(params);
    return { status: 'no-answer' };
  };
  return { call, sent };
}

describe('전환 실패 안내', () => {
  it('문장을 주면 payload 에 실린다', async () => {
    const { call, sent } = makeCall();

    await call.transfer('01012345678', { failureMessage: '연결되지 않았습니다.' });

    expect(sent[0]!['failureMessage']).toBe('연결되지 않았습니다.');
  });

  it('안 주면 키가 붙지 않는다 — 기존 사용자 영향 0', async () => {
    const { call, sent } = makeCall();

    await call.transfer('01012345678');

    expect('failureMessage' in sent[0]!).toBe(false);
    expect('failureVoice' in sent[0]!).toBe(false);
  });

  it('빈 문자열은 보내지 않는다 — 서버가 빈 문장을 합성하러 갈 이유가 없다', async () => {
    const { call, sent } = makeCall();

    await call.transfer('01012345678', { failureMessage: '' });

    expect('failureMessage' in sent[0]!).toBe(false);
  });

  it('음성은 문장과 함께 실린다', async () => {
    const { call, sent } = makeCall();

    await call.transfer('01012345678', {
      failureMessage: '연결되지 않았습니다.',
      failureVoice: 'cartesia:voice-uuid',
    });

    expect(sent[0]!['failureVoice']).toBe('cartesia:voice-uuid');
  });

  // whisper 와 듣는 사람이 반대다 — 둘은 함께 쓸 수 있어야 한다(담당자에게도, 발신자에게도).
  it('whisper 와 함께 쓸 수 있다', async () => {
    const { call, sent } = makeCall();

    await call.transfer('01012345678', {
      mode: 'warm',
      whisper: 'VIP 고객입니다.',
      failureMessage: '연결되지 않았습니다.',
    });

    expect(sent[0]!['whisper']).toBe('VIP 고객입니다.');
    expect(sent[0]!['failureMessage']).toBe('연결되지 않았습니다.');
  });
});
