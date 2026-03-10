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
