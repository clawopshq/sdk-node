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

const sampleWebhookLog = {
  id: 'WHL_123',
  webhookId: 'WH_456',
  event: 'call.completed',
  requestUrl: 'https://example.com/webhook',
  requestPayload: { callId: 'CA_789', status: 'completed' },
  responseStatus: 200,
  responseBody: '{"ok":true}',
  responseTimeMs: 150,
  status: 'delivered',
  attempt: 1,
  maxAttempts: 3,
  createdAt: '2024-01-01T00:00:00Z',
  completedAt: '2024-01-01T00:00:01Z',
};

describe('WebhookLogs resource', () => {
  describe('list', () => {
    it('sends GET to correct path with webhookId', async () => {
      const listResponse = {
        data: [sampleWebhookLog],
        meta: { total: 1, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const page = await client.webhookLogs.list('WH_456');

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('GET');
      expect(url).toContain('/v1/accounts/AC_test/webhooks/WH_456/logs');

      expect(page.data).toHaveLength(1);
      expect(page.data[0].id).toBe('WHL_123');
      expect(page.data[0].webhookId).toBe('WH_456');
      expect(page.data[0].event).toBe('call.completed');
      expect(page.data[0].status).toBe('delivered');
    });

    it('sends pagination query params', async () => {
      const listResponse = {
        data: [sampleWebhookLog],
        meta: { total: 50, page: 2, pageSize: 10 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const page = await client.webhookLogs.list('WH_456', { page: 2, pageSize: 10 });

      const [url] = fetchFn.mock.calls[0];
      expect(url).toContain('page=2');
      expect(url).toContain('pageSize=10');
      expect(page.meta.total).toBe(50);
      expect(page.meta.page).toBe(2);
    });

    it('sends GET without query params when none provided', async () => {
      const listResponse = {
        data: [],
        meta: { total: 0, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      await client.webhookLogs.list('WH_456');

      const [url] = fetchFn.mock.calls[0];
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/webhooks/WH_456/logs');
    });

    it('returns Page with correct pagination metadata', async () => {
      const listResponse = {
        data: [sampleWebhookLog],
        meta: { total: 100, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const page = await client.webhookLogs.list('WH_456');
      expect(page.hasNextPage()).toBe(true);
      expect(page.meta.total).toBe(100);
    });

    it('returns empty page when no logs exist', async () => {
      const listResponse = {
        data: [],
        meta: { total: 0, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const page = await client.webhookLogs.list('WH_456');
      expect(page.data).toHaveLength(0);
      expect(page.hasNextPage()).toBe(false);
    });

    it('preserves all webhook log fields', async () => {
      const listResponse = {
        data: [sampleWebhookLog],
        meta: { total: 1, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const page = await client.webhookLogs.list('WH_456');
      const log = page.data[0];

      expect(log.requestUrl).toBe('https://example.com/webhook');
      expect(log.requestPayload).toEqual({ callId: 'CA_789', status: 'completed' });
      expect(log.responseStatus).toBe(200);
      expect(log.responseBody).toBe('{"ok":true}');
      expect(log.responseTimeMs).toBe(150);
      expect(log.attempt).toBe(1);
      expect(log.maxAttempts).toBe(3);
      expect(log.createdAt).toBe('2024-01-01T00:00:00Z');
      expect(log.completedAt).toBe('2024-01-01T00:00:01Z');
    });
  });
});
