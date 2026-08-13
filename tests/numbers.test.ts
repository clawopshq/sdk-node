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

const sampleNumber = {
  number: '+15551234567',
  source: 'local',
  webhookUrl: 'https://example.com/webhook',
  webhookMethod: 'POST',
  createdAt: '2024-01-01T00:00:00Z',
};

describe('Numbers resource', () => {
  describe('create', () => {
    it('sends POST with camelCase body (webhookUrl)', async () => {
      const fetchFn = mockResponse(sampleNumber);
      const client = createClient(fetchFn);

      const result = await client.numbers.create({
        webhookUrl: 'https://example.com/webhook',
      });

      expect(fetchFn).toHaveBeenCalledOnce();
      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('POST');
      expect(url).toContain('/v1/accounts/AC_test/numbers');

      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ webhookUrl: 'https://example.com/webhook' });
      expect(result.number).toBe('+15551234567');
    });

    it('sends POST with webhook headers and status callback', async () => {
      const fetchFn = mockResponse(sampleNumber);
      const client = createClient(fetchFn);

      await client.numbers.create({
        webhookUrl: 'https://my-app.com/voice',
        webhookMethod: 'POST',
        webhookHeaders: { 'X-Webhook-Token': 'abc123' },
        statusCallback: 'https://my-app.com/call-status',
        statusCallbackEvents: 'initiated ringing answered completed transfer',
      });

      const [, init] = fetchFn.mock.calls[0];
      expect(JSON.parse(init!.body as string)).toEqual({
        webhookUrl: 'https://my-app.com/voice',
        webhookMethod: 'POST',
        webhookHeaders: { 'X-Webhook-Token': 'abc123' },
        statusCallback: 'https://my-app.com/call-status',
        statusCallbackEvents: 'initiated ringing answered completed transfer',
      });
    });

    it('sends POST without body when no params given', async () => {
      const fetchFn = mockResponse(sampleNumber);
      const client = createClient(fetchFn);

      await client.numbers.create();

      const [, init] = fetchFn.mock.calls[0];
      expect(init!.body).toBeUndefined();
    });
  });

  describe('list', () => {
    it('sends GET and returns array of numbers', async () => {
      const listResponse = { data: [sampleNumber] };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const result = await client.numbers.list();

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('GET');
      expect(url).toContain('/v1/accounts/AC_test/numbers');
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe('+15551234567');
    });

    it('returns empty array when no numbers exist', async () => {
      const listResponse = { data: [] };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const result = await client.numbers.list();
      expect(result).toEqual([]);
    });

    // 0.28.0 까지는 routingType 이 webhook/sip/softphone 으로 좁혀져 있어, 에이전트에
    // 연결된 번호 하나가 목록 조회 전체를 파싱 실패시켰다.
    it('accepts every routing type, including ones added later', async () => {
      const fetchFn = mockResponse({
        data: [
          { number: '07012340001', routingType: 'agent', agentId: 'AG7c2f9b1e4a6d' },
          { number: '07012340002', routingType: 'callflow', callFlowId: 'CF41b8e07d9c25' },
          { number: '07012340003', routingType: 'forward', forwardTo: '07012340001' },
          { number: '15551234', routingType: 'forward', numberType: 'representative' },
          { number: '07012340004', routingType: 'webhook', dictionaryId: 'DC6b41e8f0a92c' },
          { number: '07012340005', routingType: 'some-future-routing' },
        ],
      });
      const client = createClient(fetchFn);

      const result = await client.numbers.list();

      expect(result.map((n) => n.routingType)).toEqual([
        'agent',
        'callflow',
        'forward',
        'forward',
        'webhook',
        'some-future-routing',
      ]);
      expect(result[0].agentId).toBe('AG7c2f9b1e4a6d');
      expect(result[1].callFlowId).toBe('CF41b8e07d9c25');
      expect(result[2].forwardTo).toBe('07012340001');
      expect(result[3].numberType).toBe('representative');
      expect(result[4].dictionaryId).toBe('DC6b41e8f0a92c');
    });
  });

  describe('update', () => {
    it('sends PUT with webhookUrl and webhookMethod', async () => {
      const updatedNumber = {
        ...sampleNumber,
        webhookUrl: 'https://new.example.com/hook',
        webhookMethod: 'GET',
      };
      const fetchFn = mockResponse(updatedNumber);
      const client = createClient(fetchFn);

      const result = await client.numbers.update('+15551234567', {
        webhookUrl: 'https://new.example.com/hook',
        webhookMethod: 'GET',
      });

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('PUT');
      expect(url).toContain('/v1/accounts/AC_test/numbers/+15551234567');

      const body = JSON.parse(init!.body as string);
      expect(body.webhookUrl).toBe('https://new.example.com/hook');
      expect(body.webhookMethod).toBe('GET');
      expect(result.number).toBe('+15551234567');
    });

    it('sends only changed fields (strips undefined)', async () => {
      const fetchFn = mockResponse(sampleNumber);
      const client = createClient(fetchFn);

      await client.numbers.update('+15551234567', {
        webhookUrl: 'https://example.com/new',
      });

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ webhookUrl: 'https://example.com/new' });
      expect(body).not.toHaveProperty('webhookMethod');
    });

    it('routes a number to a managed agent', async () => {
      const fetchFn = mockResponse({
        number: '07012340001',
        routingType: 'agent',
        agentId: 'AG7c2f9b1e4a6d',
      });
      const client = createClient(fetchFn);

      const result = await client.numbers.update('07012340001', {
        routingType: 'agent',
        agentId: 'AG7c2f9b1e4a6d',
        callContextUrl: 'https://my-app.com/call-context',
      });

      const [, init] = fetchFn.mock.calls[0];
      expect(JSON.parse(init!.body as string)).toEqual({
        routingType: 'agent',
        agentId: 'AG7c2f9b1e4a6d',
        callContextUrl: 'https://my-app.com/call-context',
      });
      expect(result.routingType).toBe('agent');
      expect(result.agentId).toBe('AG7c2f9b1e4a6d');
    });

    it('routes a number to a call flow and to another owned number', async () => {
      // 한 테스트에서 두 번 호출하므로 매번 새 Response 를 만든다 — 같은 인스턴스를
      // 재사용하면 두 번째 호출에서 본문이 이미 소비돼 파싱에 실패한다.
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
        new Response(JSON.stringify({ number: '07012340001', routingType: 'callflow' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const client = createClient(fetchFn);

      await client.numbers.update('07012340001', {
        routingType: 'callflow',
        callFlowId: 'CF41b8e07d9c25',
      });
      expect(JSON.parse(fetchFn.mock.calls[0][1]!.body as string)).toEqual({
        routingType: 'callflow',
        callFlowId: 'CF41b8e07d9c25',
      });

      await client.numbers.update('07012340001', {
        routingType: 'forward',
        forwardTo: '07012340002',
      });
      expect(JSON.parse(fetchFn.mock.calls[1][1]!.body as string)).toEqual({
        routingType: 'forward',
        forwardTo: '07012340002',
      });
    });

    it('sends status callback and dictionary settings', async () => {
      const fetchFn = mockResponse(sampleNumber);
      const client = createClient(fetchFn);

      await client.numbers.update('07012340001', {
        statusCallback: 'https://my-app.com/call-status',
        statusCallbackEvents: 'initiated ringing answered completed transfer',
        dictionaryId: 'DC6b41e8f0a92c',
      });

      const [, init] = fetchFn.mock.calls[0];
      expect(JSON.parse(init!.body as string)).toEqual({
        statusCallback: 'https://my-app.com/call-status',
        statusCallbackEvents: 'initiated ringing answered completed transfer',
        dictionaryId: 'DC6b41e8f0a92c',
      });
    });
  });

  describe('delete', () => {
    it('sends DELETE to correct path', async () => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, { status: 204 }),
      );
      const client = createClient(fetchFn);

      await client.numbers.delete('+15551234567');

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('DELETE');
      expect(url).toContain('/v1/accounts/AC_test/numbers/+15551234567');
    });

    it('returns void (no error thrown)', async () => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, { status: 204 }),
      );
      const client = createClient(fetchFn);

      const result = await client.numbers.delete('+15551234567');
      expect(result).toBeUndefined();
    });
  });
});
