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
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

const sampleBlocked = {
  id: 'blk_1',
  recipient: '01012345678',
  channel: 'call',
  active: true,
  source: 'api',
  sourceRef: null,
  note: null,
  createdBy: null,
  createdAt: '2026-07-31T00:00:00Z',
  updatedAt: '2026-07-31T00:00:00Z',
  unblockedAt: null,
  unblockedSource: null,
  unblockedBy: null,
  unblockedNote: null,
};

const lastCall = (fetchFn: ReturnType<typeof mockResponse>) => {
  const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
  return { url: String(url), init };
};

describe('BlockedRecipients resource', () => {
  describe('create', () => {
    it('POSTs to /blocked-recipients with recipient/channel', async () => {
      const fetchFn = mockResponse(sampleBlocked, 201);
      const client = createClient(fetchFn);

      const res = await client.blockedRecipients.create({
        recipient: '010-1234-5678',
        channel: 'call',
        note: '상담 중 거부',
      });

      const { url, init } = lastCall(fetchFn);
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/blocked-recipients');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        recipient: '010-1234-5678',
        channel: 'call',
        note: '상담 중 거부',
      });
      // 서버가 정규화한 번호가 그대로 돌아온다.
      expect(res.recipient).toBe('01012345678');
      expect(res.active).toBe(true);
    });

    it('미지정 옵션은 body 에 실리지 않는다', async () => {
      const fetchFn = mockResponse(sampleBlocked, 201);
      const client = createClient(fetchFn);
      await client.blockedRecipients.create({ recipient: '01012345678', channel: 'message' });
      const body = JSON.parse(String(lastCall(fetchFn).init.body));
      expect(body).toEqual({ recipient: '01012345678', channel: 'message' });
      expect(body).not.toHaveProperty('source');
      expect(body).not.toHaveProperty('note');
    });

    it('이미 차단 중이면 서버가 200 을 주고 그대로 통과한다(멱등)', async () => {
      const fetchFn = mockResponse(sampleBlocked, 200);
      const client = createClient(fetchFn);
      const res = await client.blockedRecipients.create({
        recipient: '01012345678',
        channel: 'call',
      });
      expect(res.id).toBe('blk_1');
    });
  });

  describe('list', () => {
    it('필터를 query 로 넘기고 Page 를 돌려준다', async () => {
      const fetchFn = mockResponse({
        data: [sampleBlocked],
        meta: { page: 0, pageSize: 20, total: 1 },
      });
      const client = createClient(fetchFn);

      const page = await client.blockedRecipients.list({ channel: 'call', status: 'active' });

      const { url, init } = lastCall(fetchFn);
      expect(url).toContain('/blocked-recipients?');
      expect(url).toContain('channel=call');
      expect(url).toContain('status=active');
      expect(init.method).toBe('GET');
      expect(page.data).toHaveLength(1);
      expect(page.data[0]!.recipient).toBe('01012345678');
    });

    it('인자 없이 호출하면 query 가 붙지 않는다', async () => {
      const fetchFn = mockResponse({ data: [], meta: { page: 0, pageSize: 20, total: 0 } });
      const client = createClient(fetchFn);
      await client.blockedRecipients.list();
      expect(lastCall(fetchFn).url).toBe(
        'http://localhost:3000/v1/accounts/AC_test/blocked-recipients',
      );
    });
  });

  describe('retrieve', () => {
    it('GET /blocked-recipients/{id}', async () => {
      const fetchFn = mockResponse(sampleBlocked);
      const client = createClient(fetchFn);
      const res = await client.blockedRecipients.retrieve('blk_1');
      expect(lastCall(fetchFn).url).toBe(
        'http://localhost:3000/v1/accounts/AC_test/blocked-recipients/blk_1',
      );
      expect(res.id).toBe('blk_1');
    });
  });

  describe('update', () => {
    it('PATCH 로 메모만 바꾼다', async () => {
      const fetchFn = mockResponse({ ...sampleBlocked, note: '2차 확인' });
      const client = createClient(fetchFn);

      const res = await client.blockedRecipients.update('blk_1', { note: '2차 확인' });

      const { url, init } = lastCall(fetchFn);
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/blocked-recipients/blk_1');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(String(init.body))).toEqual({ note: '2차 확인' });
      expect(res.note).toBe('2차 확인');
    });

    it('note 를 생략하면 null 을 보내 메모를 지운다', async () => {
      const fetchFn = mockResponse(sampleBlocked);
      const client = createClient(fetchFn);
      await client.blockedRecipients.update('blk_1');
      expect(JSON.parse(String(lastCall(fetchFn).init.body))).toEqual({ note: null });
    });
  });

  describe('release', () => {
    it('DELETE 인데 삭제가 아니라 해제된 항목을 돌려준다', async () => {
      const released = {
        ...sampleBlocked,
        active: false,
        unblockedAt: '2026-07-31T01:00:00Z',
        unblockedSource: 'api',
        unblockedNote: '고객 재동의',
      };
      const fetchFn = mockResponse(released);
      const client = createClient(fetchFn);

      const res = await client.blockedRecipients.release('blk_1', { note: '고객 재동의' });

      const { url, init } = lastCall(fetchFn);
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/blocked-recipients/blk_1');
      expect(init.method).toBe('DELETE');
      expect(JSON.parse(String(init.body))).toEqual({ note: '고객 재동의' });
      // 항목이 사라지지 않고 이력으로 남는다 — 이게 이 endpoint 의 핵심 계약이다.
      expect(res.active).toBe(false);
      expect(res.unblockedAt).toBe('2026-07-31T01:00:00Z');
    });

    it('note 없이 호출하면 body 를 보내지 않는다', async () => {
      const fetchFn = mockResponse({ ...sampleBlocked, active: false });
      const client = createClient(fetchFn);
      await client.blockedRecipients.release('blk_1');
      expect(lastCall(fetchFn).init.body).toBeUndefined();
    });
  });

  describe('accounts() 컨텍스트', () => {
    it('다른 계정으로도 접근할 수 있다', async () => {
      const fetchFn = mockResponse({ data: [], meta: { page: 0, pageSize: 20, total: 0 } });
      const client = createClient(fetchFn);
      await client.accounts('AC_other').blockedRecipients.list();
      expect(lastCall(fetchFn).url).toContain('/v1/accounts/AC_other/blocked-recipients');
    });
  });

  // ⛔ 이 블록이 지키는 것은 **채널이 늘어도 SDK 가 안 죽는 것**이다.
  //
  //    `channel` 을 `z.enum(['call','message'])` 로 굳혀 뒀다가 서버가 `email` 을 더한 순간,
  //    이메일 항목이 하나라도 섞인 목록 조회가 **파싱 단계에서 통째로 실패**했다. 고객은
  //    자기가 콘솔에서 등록한 항목 때문에 SDK 가 깨지는 것을 겪는다. 응답 스키마를 좁히는
  //    것은 서버가 값을 늘리는 날 옛 SDK 를 전부 깨뜨리는 일이다.
  describe('채널 확장 내성', () => {
    it('email 채널 항목을 파싱한다', async () => {
      const fetchFn = mockResponse({
        ...sampleBlocked,
        recipient: 'kim@example.com',
        channel: 'email',
      });
      const client = createClient(fetchFn);
      const res = await client.blockedRecipients.retrieve('blk_1');

      expect(res.channel).toBe('email');
      expect(res.recipient).toBe('kim@example.com');
    });

    it('email 채널로 등록할 수 있다', async () => {
      const fetchFn = mockResponse(
        { ...sampleBlocked, recipient: 'kim@example.com', channel: 'email' },
        201,
      );
      const client = createClient(fetchFn);
      await client.blockedRecipients.create({ recipient: 'Kim@Example.com', channel: 'email' });

      // 소문자 정규화는 **서버가** 한다 — SDK 가 흉내내면 규칙이 두 곳이 되고 갈린다.
      const { init } = lastCall(fetchFn);
      expect(JSON.parse(String(init.body))).toEqual({
        recipient: 'Kim@Example.com',
        channel: 'email',
      });
    });

    it('⛔ 우리가 모르는 채널이 와도 죽지 않는다', async () => {
      const fetchFn = mockResponse({ ...sampleBlocked, channel: 'push' });
      const client = createClient(fetchFn);
      const res = await client.blockedRecipients.retrieve('blk_1');
      expect(res.channel).toBe('push');
    });

    it('⛔ 내부 접수 경로(ars·sms)도 그대로 읽는다 — source 는 공개 API 값만이 아니다', async () => {
      // ARS 9번·문자 회신으로 들어온 항목은 source 가 'ars'·'sms' 다. 공개 API 로 등록할 수
      // 있는 값(api·console·import·agent)만 허용하면 그 항목들에서 파싱이 깨진다.
      const fetchFn = mockResponse({
        data: [
          { ...sampleBlocked, source: 'ars' },
          { ...sampleBlocked, id: 'blk_2', source: 'sms' },
        ],
        meta: { page: 0, pageSize: 20, total: 2 },
      });
      const client = createClient(fetchFn);
      const page = await client.blockedRecipients.list();
      expect(page.data.map((r) => r.source)).toEqual(['ars', 'sms']);
    });
  });
});
