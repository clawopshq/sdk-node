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
        page: 1,
        pageSize: 10,
      });

      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('GET');
      expect(url).toContain('/v1/accounts/AC_test/messages');
      expect(url).toContain('type=sms');
      expect(url).toContain('status=sent');
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
