/**
 * 전환받는 쪽에 표시될 발신번호를 SDK 에서 고르는 경로 (`callerIdMode`).
 *
 * 왜 있나: call-engine 은 `callerIdMode: 'account'|'original'` 을 이미 지원하고 게이트웨이는
 * transfer 객체를 손대지 않고 넘긴다. 그런데 SDK 에 파라미터가 없어서, SDK 사용자가 원발신자
 * 승계를 하려면 `callerId: call.fromNumber` 를 넘기는 수밖에 없었다.
 *
 * 서버는 그 둘을 다르게 취급한다 — **번호는 지시, 모드는 선호**다. 승계할 수 없는 통화
 * (KCT 직결 인입이 아니거나 정규화 불가 발신번호, 실측 인바운드의 약 1.5%)에서 번호는
 * `UNOWNED_CALLER_ID` 로 **전환을 통째로 실패**시키고, 모드는 계정 번호로 내려앉고 성사시킨다.
 *
 * 파이썬 SDK 의 tests/agent/test_transfer_caller_id_mode.py 와 짝이다. 두 SDK 가 어긋나면
 * 문서 한 벌이 두 곳에서 거짓이 되므로, payload 키 이름까지 같이 고정한다.
 */
import { describe, it, expect } from 'vitest';

import { CallSession } from '../../src/agent/session.js';
import { getBuiltinToolSchemas } from '../../src/agent/pipeline/builtin-tool-schemas.js';
import { BuiltinTool } from '../../src/agent/builtin-tool.js';

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
    return { status: 'completed' };
  };
  return { call, sent };
}

describe('전환 callerIdMode', () => {
  it('모드를 주면 payload 에 실린다', async () => {
    const { call, sent } = makeCall();

    await call.transfer('15990011', { callerIdMode: 'original' });

    expect(sent[0]!['callerIdMode']).toBe('original');
  });

  it('안 주면 키가 붙지 않는다 — 기존 사용자 영향 0', async () => {
    const { call, sent } = makeCall();

    await call.transfer('15990011');

    expect('callerIdMode' in sent[0]!).toBe(false);
  });

  it("'account' 를 고른 것과 안 고른 것은 서버에서 구분돼야 한다", async () => {
    const { call, sent } = makeCall();

    await call.transfer('15990011', { callerIdMode: 'account' });

    expect(sent[0]!['callerIdMode']).toBe('account');
  });

  it('오타는 조용히 no-op 되지 않고 던진다', async () => {
    const { call, sent } = makeCall();

    await expect(
      // 런타임에서 오는 값(도구 인자·설정 파일)은 타입이 막아주지 않는다.
      call.transfer('15990011', { callerIdMode: 'origianl' as 'account' }),
    ).rejects.toThrow(/callerIdMode/);
    expect(sent).toEqual([]);
  });

  it('번호와 모드를 같이 주면 둘 다 그대로 보낸다 — 우선순위는 서버 몫', async () => {
    const { call, sent } = makeCall();

    await call.transfer('15990011', {
      callerId: '07012341234',
      callerIdMode: 'original',
    });

    expect(sent[0]!['callerId']).toBe('07012341234');
    expect(sent[0]!['callerIdMode']).toBe('original');
  });

  it('내장 도구가 모드를 노출한다', () => {
    const schemas = getBuiltinToolSchemas(new Set([BuiltinTool.TRANSFER_CALL]), 'chat');
    const fn = schemas[0]! as { function: { parameters: { properties: Record<string, any> } } };
    const props = fn.function.parameters.properties;

    expect(props['caller_id_mode'].enum).toEqual(['account', 'original']);
    // 원시 번호 경로는 남겨 둔다(프롬프트에서 쓰는 사용자를 깨뜨리지 않는다). 다만 설명이
    // 실패 결과를 분명히 해야 모델이 함부로 고르지 않는다.
    expect(props['caller_id'].description).toContain('fails the transfer');
  });

  it('파이썬 SDK 와 payload 키가 같다', async () => {
    // 두 SDK 가 어긋나면 문서 한 벌이 두 곳에서 거짓이 된다. 파이썬
    // CallSession.transfer 가 만드는 키 집합을 그대로 적어 두고 대조한다.
    const { call, sent } = makeCall();

    await call.transfer('15990011', { callerIdMode: 'original' });

    expect(Object.keys(sent[0]!).sort()).toEqual(
      [
        'afterTransfer',
        'callerId',
        'callerIdMode',
        'context',
        'destinationType',
        'holdMedia',
        'mode',
        'timeout',
        'to',
        'whisper',
      ].sort(),
    );
  });
});
