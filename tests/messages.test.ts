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

const sampleMessage = {
  messageId: 'MSG_123',
  status: 'queued',
  type: 'sms',
  to: '+15551234567',
  from: '+15559876543',
  body: 'Hello World',
  numMedia: 0,
  mediaUrl: [],
  direction: 'outbound',
  accountId: 'AC_test',
  dateCreated: '2024-01-01T00:00:00Z',
  dateUpdated: null,
};

describe('Messages resource', () => {
  describe('create', () => {
    it('idempotencyKey 를 IdempotencyKey 로 실어 보낸다', async () => {
      const mockFetch = mockResponse(sampleMessage, 201);
      const client = createClient(mockFetch);

      await client.messages.create({
        to: '01012345678',
        from: '07052358010',
        body: '안녕하세요',
        idempotencyKey: 'solapi:M4V2026',
      });

      const body = JSON.parse(String(mockFetch.mock.calls[0]![1]!.body));
      expect(body.IdempotencyKey).toBe('solapi:M4V2026');
    });

    it('idempotencyKey 미지정이면 본문에 넣지 않는다', async () => {
      const mockFetch = mockResponse(sampleMessage, 201);
      const client = createClient(mockFetch);

      await client.messages.create({ to: '01012345678', from: '07052358010', body: '안녕하세요' });

      const body = JSON.parse(String(mockFetch.mock.calls[0]![1]!.body));
      expect('IdempotencyKey' in body).toBe(false);
    });

    it('sends POST with PascalCase body', async () => {
      const fetchFn = mockResponse(sampleMessage);
      const client = createClient(fetchFn);

      const result = await client.messages.create({
        to: '+15551234567',
        from: '+15559876543',
        body: 'Hello World',
      });

      expect(fetchFn).toHaveBeenCalledOnce();
      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('POST');
      expect(url).toContain('/v1/accounts/AC_test/messages');

      const reqBody = JSON.parse(init!.body as string);
      expect(reqBody).toEqual({
        To: '+15551234567',
        From: '+15559876543',
        Body: 'Hello World',
      });

      expect(result.messageId).toBe('MSG_123');
    });

    it('includes optional Type and Subject', async () => {
      const fetchFn = mockResponse({ ...sampleMessage, type: 'mms' });
      const client = createClient(fetchFn);

      await client.messages.create({
        to: '+15551234567',
        from: '+15559876543',
        body: 'Hello',
        type: 'mms',
        subject: 'Test Subject',
      });

      const [, init] = fetchFn.mock.calls[0];
      const reqBody = JSON.parse(init!.body as string);
      expect(reqBody.Type).toBe('mms');
      expect(reqBody.Subject).toBe('Test Subject');
    });

    it('strips undefined optional fields', async () => {
      const fetchFn = mockResponse(sampleMessage);
      const client = createClient(fetchFn);

      await client.messages.create({
        to: '+15551234567',
        from: '+15559876543',
        body: 'Hello',
        type: undefined,
        subject: undefined,
      });

      const [, init] = fetchFn.mock.calls[0];
      const reqBody = JSON.parse(init!.body as string);
      expect(reqBody).not.toHaveProperty('Type');
      expect(reqBody).not.toHaveProperty('Subject');
    });
  });

  describe('list', () => {
    it('sends GET with filter query params', async () => {
      const listResponse = {
        data: [sampleMessage],
        meta: { total: 1, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const page = await client.messages.list({
        type: 'sms',
        status: 'sent',
        number: '07052358010',
        page: 1,
        pageSize: 10,
      });

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('GET');
      expect(url).toContain('/v1/accounts/AC_test/messages');
      expect(url).toContain('type=sms');
      expect(url).toContain('status=sent');
      expect(url).toContain('number=07052358010');
      expect(url).toContain('page=1');
      expect(url).toContain('pageSize=10');

      expect(page.data).toHaveLength(1);
      expect(page.data[0].messageId).toBe('MSG_123');
    });

    it('sends GET without query params when none provided', async () => {
      const listResponse = {
        data: [],
        meta: { total: 0, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      await client.messages.list();

      const [url] = fetchFn.mock.calls[0];
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/messages');
    });

    it('returns Page with pagination metadata', async () => {
      const listResponse = {
        data: [sampleMessage],
        meta: { total: 100, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const page = await client.messages.list();
      expect(page.meta.total).toBe(100);
      expect(page.hasNextPage()).toBe(true);
    });
  });

  describe('get', () => {
    it('sends GET to correct path with messageId', async () => {
      const fetchFn = mockResponse(sampleMessage);
      const client = createClient(fetchFn);

      const result = await client.messages.get('MSG_123');

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('GET');
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/messages/MSG_123');
      expect(result.messageId).toBe('MSG_123');
      expect(result.body).toBe('Hello World');
      expect(result.type).toBe('sms');
    });
  });
});

describe('카카오 알림톡 (ata)', () => {
  const sampleAta = {
    ...sampleMessage,
    messageId: 'MSG_ATA',
    type: 'ata',
    body: '홍길동님, 주문이 접수되었습니다.',
  };

  it('kakao 를 Kakao.ChannelId/TemplateId/Variables 로 실어 보낸다', async () => {
    const fetchFn = mockResponse(sampleAta, 201);
    const client = createClient(fetchFn);

    await client.messages.create({
      to: '01012345678',
      from: '07052358010',
      kakao: {
        channelId: 'clx9kak0001',
        templateId: 'clx9tpl0001',
        variables: { 고객명: '홍길동', '#{금액}': '12,000' },
      },
    });

    const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    expect(body.Kakao).toEqual({
      ChannelId: 'clx9kak0001',
      TemplateId: 'clx9tpl0001',
      Variables: { 고객명: '홍길동', '#{금액}': '12,000' },
    });
    // 본문은 템플릿이 정한다 — Body 를 지어내 실으면 서버가 400 이다.
    expect(body).not.toHaveProperty('Body');
  });

  it('variables 미지정이면 Variables 키 자체를 넣지 않는다', async () => {
    const fetchFn = mockResponse(sampleAta, 201);
    const client = createClient(fetchFn);

    await client.messages.create({
      to: '01012345678',
      from: '07052358010',
      kakao: { channelId: 'clx9kak0001', templateId: 'clx9tpl0001' },
    });

    const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    expect(body.Kakao).toEqual({ ChannelId: 'clx9kak0001', TemplateId: 'clx9tpl0001' });
  });

  it('fallback 을 Fallback 으로 실어 보낸다 — disabled: false 도 그대로 간다', async () => {
    const fetchFn = mockResponse(sampleAta, 201);
    const client = createClient(fetchFn);

    await client.messages.create({
      to: '01012345678',
      from: '07052358010',
      kakao: { channelId: 'clx9kak0001', templateId: 'clx9tpl0001' },
      fallback: { body: '주문이 접수되었습니다.', type: 'sms', disabled: false },
    });

    const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    expect(body.Fallback).toEqual({ Type: 'sms', Body: '주문이 접수되었습니다.', Disabled: false });
  });

  it('fallback 미지정이면 Fallback 키가 없다 — 서버가 템플릿 본문으로 대체발송한다', async () => {
    const fetchFn = mockResponse(sampleAta, 201);
    const client = createClient(fetchFn);

    await client.messages.create({
      to: '01012345678',
      from: '07052358010',
      kakao: { channelId: 'clx9kak0001', templateId: 'clx9tpl0001' },
    });

    const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    expect(body).not.toHaveProperty('Fallback');
  });

  // 회귀: 스키마가 'kakao' 를 기다리고 서버는 'ata' 를 줘서 조회가 통째로 던지던 버그.
  it("type: 'ata' 응답을 던지지 않고 파싱한다", async () => {
    const fetchFn = mockResponse(sampleAta);
    const client = createClient(fetchFn);

    const result = await client.messages.get('MSG_ATA');
    expect(result.type).toBe('ata');
  });

  it('알림톡이 섞인 목록이 통째로 실패하지 않는다', async () => {
    const fetchFn = mockResponse({
      data: [sampleMessage, sampleAta],
      meta: { total: 2, page: 0, pageSize: 20 },
    });
    const client = createClient(fetchFn);

    const page = await client.messages.list();
    expect(page.data.map((m) => m.type)).toEqual(['sms', 'ata']);
  });

  it('type: ata 로 알림톡만 필터한다', async () => {
    const fetchFn = mockResponse({ data: [sampleAta], meta: { total: 1, page: 0, pageSize: 20 } });
    const client = createClient(fetchFn);

    await client.messages.list({ type: 'ata' });
    expect(String(fetchFn.mock.calls[0]![0])).toContain('type=ata');
  });

  describe('타입 레벨 — 문자와 알림톡은 섞이지 않는다', () => {
    it('컴파일 시점에 막힌다', () => {
      const client = createClient(mockResponse(sampleAta, 201));
      const kakao = { channelId: 'clx9kak0001', templateId: 'clx9tpl0001' };

      // 실행하지 않는다 — tsc 의 @ts-expect-error 검사만 받으면 된다.
      const rejected = () => {
        // @ts-expect-error 알림톡에는 Body 를 실을 수 없다 (400 kakao_body_not_allowed)
        client.messages.create({ to: '01012345678', from: '070', body: '안녕', kakao });
        // @ts-expect-error 알림톡에는 첨부를 실을 수 없다
        client.messages.create({
          to: '01012345678',
          from: '070',
          kakao,
          mediaUrl: ['https://x/a.jpg'],
        });
        // @ts-expect-error kakao 를 실으면 Type 은 'ata' 뿐이다 (400 kakao_type_conflict)
        client.messages.create({ to: '01012345678', from: '070', kakao, type: 'sms' });
        // @ts-expect-error 문자에는 fallback 이 없다 — 대체발송은 알림톡의 개념이다
        client.messages.create({ to: '01012345678', from: '070', body: '안녕', fallback: {} });
      };

      expect(typeof rejected).toBe('function');
    });
  });
});
