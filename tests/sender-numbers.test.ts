import { describe, it, expect, vi } from 'vitest';
import { ClawOps } from '../src/client.js';

function createClient(mockFetch: typeof fetch) {
  return new ClawOps({
    apiKey: 'sk_test',
    accountId: 'AC_test',
    fetch: mockFetch,
    baseURL: 'http://localhost:3000',
    maxRetries: 0,
  });
}

function mockResponse(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

const lastCall = (fetchFn: ReturnType<typeof mockResponse>) => {
  const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
  return { url: String(url), init };
};

const sample = {
  id: 'sn_1',
  number: '07052361008',
  type: '070',
  verificationMethod: 'own_provisioned',
  status: 'approved',
  createdAt: '2026-10-20T07:02:11.000Z',
};

describe('SenderNumbers resource', () => {
  it('list — GET /sender-numbers, 발신번호·유예·한도', async () => {
    const body = {
      senderNumbers: [sample],
      grace: [{ number: '07052753809', expiresAt: '2026-11-03T14:59:59.000Z' }],
      limit: { used: 1, limit: 5, reached: false },
    };
    const fetchFn = mockResponse(body);
    const result = await createClient(fetchFn).senderNumbers.list();
    const { url, init } = lastCall(fetchFn);
    expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/sender-numbers');
    expect(init.method).toBe('GET');
    expect(result.senderNumbers[0].number).toBe('07052361008');
    expect(result.grace[0].expiresAt).toBe('2026-11-03T14:59:59.000Z');
    expect(result.limit).toEqual({ used: 1, limit: 5, reached: false });
  });

  it('list — 명의 미확인이면 limit=null, 한도 미정이면 limit.limit=null', async () => {
    const r1 = await createClient(mockResponse({ senderNumbers: [], grace: [], limit: null })).senderNumbers.list();
    expect(r1.limit).toBeNull();
    const r2 = await createClient(
      mockResponse({ senderNumbers: [], grace: [], limit: { used: 0, limit: null, reached: false } }),
    ).senderNumbers.list();
    expect(r2.limit?.limit).toBeNull();
  });

  it('list — 서버가 새 type·status 값을 보내도 파싱이 깨지지 않는다', async () => {
    const r = await createClient(
      mockResponse({ senderNumbers: [{ ...sample, type: 'future', status: 'future' }], grace: [], limit: null }),
    ).senderNumbers.list();
    expect(r.senderNumbers[0].type).toBe('future');
  });

  it('create — POST /sender-numbers { number }', async () => {
    const fetchFn = mockResponse(sample, 201);
    const created = await createClient(fetchFn).senderNumbers.create({ number: '070-5236-1008' });
    const { url, init } = lastCall(fetchFn);
    expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/sender-numbers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ number: '070-5236-1008' });
    expect(created.id).toBe('sn_1');
  });

  it('create — 409 중복은 code 로 구분할 수 있다', async () => {
    const fetchFn = mockResponse(
      { error: '이미 등록된 발신번호입니다.', code: 'sender_number_already_registered' },
      409,
    );
    await expect(createClient(fetchFn).senderNumbers.create({ number: '07052361008' })).rejects.toMatchObject({
      status: 409,
      code: 'sender_number_already_registered',
    });
  });

  it('delete — DELETE /sender-numbers/{id}', async () => {
    const fetchFn = mockResponse(null, 204);
    await createClient(fetchFn).senderNumbers.delete('sn_1');
    const { url, init } = lastCall(fetchFn);
    expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/sender-numbers/sn_1');
    expect(init.method).toBe('DELETE');
  });

  it('accounts(id).senderNumbers 는 그 계정 경로를 쓴다', async () => {
    const fetchFn = mockResponse({ senderNumbers: [], grace: [], limit: null });
    await createClient(fetchFn).accounts('AC_other').senderNumbers.list();
    expect(lastCall(fetchFn).url).toBe('http://localhost:3000/v1/accounts/AC_other/sender-numbers');
  });
});

describe('numbers.create — smsSender', () => {
  const number = { number: '07052753973', source: 'pool', routingType: 'webhook' };

  it('자동 등록 결과를 smsSender 로 돌려준다', async () => {
    const ok = await createClient(
      mockResponse({ ...number, smsSender: { registered: true, senderNumberId: 'sn_9' } }, 201),
    ).numbers.create();
    expect(ok.smsSender).toEqual({ registered: true, senderNumberId: 'sn_9' });

    const skipped = await createClient(
      mockResponse({ ...number, smsSender: { registered: false, reason: 'sender_number_limit_reached' } }, 201),
    ).numbers.create();
    expect(skipped.smsSender?.registered).toBe(false);
    expect(skipped.smsSender?.reason).toBe('sender_number_limit_reached');
  });

  it('smsSender 가 없는 응답(옛 서버)도 그대로 받는다', async () => {
    const r = await createClient(mockResponse(number, 201)).numbers.create();
    expect(r.smsSender).toBeUndefined();
  });
});
