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

const sampleCall = {
  callId: 'CA_123',
  status: 'queued',
  to: '+15551234567',
  from: '+15559876543',
  direction: 'outbound',
  duration: null,
  accountId: 'AC_test',
  dateCreated: '2024-01-01T00:00:00Z',
  dateUpdated: null,
};

describe('Calls resource', () => {
  describe('create', () => {
    it('sends POST with PascalCase body', async () => {
      const fetchFn = mockResponse(sampleCall);
      const client = createClient(fetchFn);

      const result = await client.calls.create({
        to: '+15551234567',
        from: '+15559876543',
        url: 'https://example.com/twiml',
      });

      expect(fetchFn).toHaveBeenCalledOnce();
      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('POST');
      expect(url).toContain('/v1/accounts/AC_test/calls');

      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({
        To: '+15551234567',
        From: '+15559876543',
        Url: 'https://example.com/twiml',
      });

      expect(result.callId).toBe('CA_123');
    });

    it('includes optional StatusCallback and StatusCallbackEvent', async () => {
      const fetchFn = mockResponse(sampleCall);
      const client = createClient(fetchFn);

      await client.calls.create({
        to: '+15551234567',
        from: '+15559876543',
        url: 'https://example.com/twiml',
        statusCallback: 'https://example.com/status',
        statusCallbackEvent: 'completed',
      });

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.StatusCallback).toBe('https://example.com/status');
      expect(body.StatusCallbackEvent).toBe('completed');
    });

    it('strips undefined optional fields', async () => {
      const fetchFn = mockResponse(sampleCall);
      const client = createClient(fetchFn);

      await client.calls.create({
        to: '+15551234567',
        from: '+15559876543',
        url: 'https://example.com/twiml',
        statusCallback: undefined,
      });

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body).not.toHaveProperty('StatusCallback');
    });
  });

  describe('list', () => {
    it('sends GET with query params', async () => {
      const listResponse = {
        data: [sampleCall],
        meta: { total: 1, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const page = await client.calls.list({ status: 'queued', page: 0, pageSize: 20 });

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('GET');
      expect(url).toContain('/v1/accounts/AC_test/calls');
      expect(url).toContain('status=queued');
      expect(url).toContain('page=0');
      expect(url).toContain('pageSize=20');

      expect(page.data).toHaveLength(1);
      expect(page.data[0].callId).toBe('CA_123');
    });

    it('sends GET without query params when none provided', async () => {
      const listResponse = {
        data: [sampleCall],
        meta: { total: 1, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const page = await client.calls.list();

      const [url] = fetchFn.mock.calls[0];
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/calls');
    });

    it('returns a Page with pagination metadata', async () => {
      const listResponse = {
        data: [sampleCall],
        meta: { total: 50, page: 0, pageSize: 20 },
      };
      const fetchFn = mockResponse(listResponse);
      const client = createClient(fetchFn);

      const page = await client.calls.list();
      expect(page.meta.total).toBe(50);
      expect(page.meta.page).toBe(0);
      expect(page.meta.pageSize).toBe(20);
      expect(page.hasNextPage()).toBe(true);
    });
  });

  describe('get', () => {
    it('sends GET to correct path with callId', async () => {
      const fetchFn = mockResponse(sampleCall);
      const client = createClient(fetchFn);

      const result = await client.calls.get('CA_123');

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('GET');
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/calls/CA_123');
      expect(result.callId).toBe('CA_123');
      expect(result.to).toBe('+15551234567');
    });
  });

  describe('update', () => {
    it('sends POST with Status: completed', async () => {
      const updateResponse = { callId: 'CA_123', status: 'completed' };
      const fetchFn = mockResponse(updateResponse);
      const client = createClient(fetchFn);

      const result = await client.calls.update('CA_123', { status: 'completed' });

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('POST');
      expect(url).toContain('/v1/accounts/AC_test/calls/CA_123');

      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ Status: 'completed' });
      expect(result.callId).toBe('CA_123');
      expect(result.status).toBe('completed');
    });

    it('defaults to status completed when no params given', async () => {
      const updateResponse = { callId: 'CA_123', status: 'completed' };
      const fetchFn = mockResponse(updateResponse);
      const client = createClient(fetchFn);

      await client.calls.update('CA_123');

      const [, init] = fetchFn.mock.calls[0];
      const body = JSON.parse(init!.body as string);
      expect(body.Status).toBe('completed');
    });
  });
});
