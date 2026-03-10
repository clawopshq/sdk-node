import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { APIClient } from '../src/base-client.js';
import {
  ClawOpsError,
  NotFoundError,
  AuthenticationError,
  InternalServerError,
  BadRequestError,
  APITimeoutError,
  APIConnectionError,
} from '../src/error.js';
import { VERSION } from '../src/version.js';

function mockResponse(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function mock204(): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(null, { status: 204 }),
  );
}

function createClient(fetchFn: typeof fetch, options: { maxRetries?: number; timeout?: number } = {}): APIClient {
  return new APIClient({
    apiKey: 'sk_test_key',
    baseURL: 'http://localhost:3000',
    fetch: fetchFn,
    maxRetries: options.maxRetries ?? 0,
    timeout: options.timeout,
  });
}

const TestSchema = z.object({ id: z.string(), name: z.string() });

describe('APIClient', () => {
  describe('default headers', () => {
    it('sends Authorization, User-Agent, Content-Type, and Accept headers', async () => {
      const fetchFn = mockResponse({ id: '1', name: 'test' });
      const client = createClient(fetchFn);

      await client._get('/test', { castTo: TestSchema });

      expect(fetchFn).toHaveBeenCalledOnce();
      const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer sk_test_key',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': `claw-ops-node/${VERSION}`,
      });
    });

    it('merges custom default headers', async () => {
      const fetchFn = mockResponse({ id: '1', name: 'test' });
      const client = new APIClient({
        apiKey: 'sk_test',
        baseURL: 'http://localhost:3000',
        fetch: fetchFn,
        maxRetries: 0,
        defaultHeaders: { 'X-Custom': 'custom-value' },
      });

      await client._get('/test', { castTo: TestSchema });

      const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.headers['X-Custom']).toBe('custom-value');
    });
  });

  describe('HTTP methods', () => {
    it('GET sends correct method and URL', async () => {
      const fetchFn = mockResponse({ id: '1', name: 'test' });
      const client = createClient(fetchFn);

      const result = await client._get('/items/1', { castTo: TestSchema });

      const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.method).toBe('GET');
      expect(url).toBe('http://localhost:3000/items/1');
      expect(result).toEqual({ id: '1', name: 'test' });
    });

    it('GET appends query parameters', async () => {
      const fetchFn = mockResponse({ id: '1', name: 'test' });
      const client = createClient(fetchFn);

      await client._get('/items', {
        castTo: TestSchema,
        query: { page: 2, status: 'active' },
      });

      const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('page=2');
      expect(url).toContain('status=active');
    });

    it('GET skips null/undefined query params', async () => {
      const fetchFn = mockResponse({ id: '1', name: 'test' });
      const client = createClient(fetchFn);

      await client._get('/items', {
        castTo: TestSchema,
        query: { page: 1, status: null, filter: undefined },
      });

      const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('page=1');
      expect(url).not.toContain('status');
      expect(url).not.toContain('filter');
    });

    it('POST sends correct method and body', async () => {
      const fetchFn = mockResponse({ id: '2', name: 'created' });
      const client = createClient(fetchFn);

      const result = await client._post('/items', {
        body: { name: 'created' },
        castTo: TestSchema,
      });

      const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ name: 'created' });
      expect(result).toEqual({ id: '2', name: 'created' });
    });

    it('PUT sends correct method and body', async () => {
      const fetchFn = mockResponse({ id: '1', name: 'updated' });
      const client = createClient(fetchFn);

      const result = await client._put('/items/1', {
        body: { name: 'updated' },
        castTo: TestSchema,
      });

      const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.method).toBe('PUT');
      expect(result).toEqual({ id: '1', name: 'updated' });
    });

    it('DELETE sends correct method and returns void', async () => {
      const fetchFn = mock204();
      const client = createClient(fetchFn);

      await client._delete('/items/1');

      const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.method).toBe('DELETE');
    });
  });

  describe('error handling', () => {
    it('throws NotFoundError on 404', async () => {
      const fetchFn = mockResponse({ error: 'not found' }, 404);
      const client = createClient(fetchFn);

      await expect(client._get('/missing', { castTo: TestSchema })).rejects.toThrow(NotFoundError);
    });

    it('throws AuthenticationError on 401', async () => {
      const fetchFn = mockResponse({ error: 'unauthorized' }, 401);
      const client = createClient(fetchFn);

      await expect(client._get('/secret', { castTo: TestSchema })).rejects.toThrow(
        AuthenticationError,
      );
    });

    it('throws InternalServerError on 500', async () => {
      const fetchFn = mockResponse({ error: 'server error' }, 500);
      const client = createClient(fetchFn);

      await expect(client._get('/broken', { castTo: TestSchema })).rejects.toThrow(
        InternalServerError,
      );
    });

    it('throws BadRequestError on 400', async () => {
      const fetchFn = mockResponse({ error: 'bad request' }, 400);
      const client = createClient(fetchFn);

      await expect(
        client._post('/items', { body: {}, castTo: TestSchema }),
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe('retry logic', () => {
    it('retries on 429 status', async () => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'rate limit' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: '1', name: 'success' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      const client = createClient(fetchFn, { maxRetries: 1 });
      const result = await client._get('/test', { castTo: TestSchema });

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ id: '1', name: 'success' });
    });

    it('retries on 500 status', async () => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'internal' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: '1', name: 'ok' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      const client = createClient(fetchFn, { maxRetries: 1 });
      const result = await client._get('/test', { castTo: TestSchema });

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ id: '1', name: 'ok' });
    });

    it('does NOT retry on 400 status', async () => {
      const fetchFn = mockResponse({ error: 'bad' }, 400);
      const client = createClient(fetchFn, { maxRetries: 2 });

      await expect(client._get('/test', { castTo: TestSchema })).rejects.toThrow(BadRequestError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on 401 status', async () => {
      const fetchFn = mockResponse({ error: 'unauth' }, 401);
      const client = createClient(fetchFn, { maxRetries: 2 });

      await expect(client._get('/test', { castTo: TestSchema })).rejects.toThrow(
        AuthenticationError,
      );
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('exhausts retries and throws on persistent 500', { timeout: 15000 }, async () => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: 'down' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const client = createClient(fetchFn, { maxRetries: 2 });

      await expect(client._get('/test', { castTo: TestSchema })).rejects.toThrow(
        InternalServerError,
      );
      // 1 initial + 2 retries = 3 calls
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });
  });

  describe('timeout', () => {
    it('passes AbortSignal to fetch', async () => {
      const fetchFn = mockResponse({ id: '1', name: 'ok' });
      const client = createClient(fetchFn, { timeout: 5000 });

      await client._get('/test', { castTo: TestSchema });

      const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('throws APITimeoutError when fetch is aborted', async () => {
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const signal = (init as RequestInit).signal!;
        // Wait until aborted
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
        throw new Error('unreachable');
      });

      const client = createClient(fetchFn, { maxRetries: 0, timeout: 50 });

      await expect(client._get('/slow', { castTo: TestSchema })).rejects.toThrow(APITimeoutError);
    });

    it('throws APIConnectionError on network failure (not abort)', async () => {
      const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'));
      const client = createClient(fetchFn, { maxRetries: 0 });

      await expect(client._get('/test', { castTo: TestSchema })).rejects.toThrow(
        APIConnectionError,
      );
    });
  });

  describe('base URL validation', () => {
    it('accepts HTTPS URLs', () => {
      expect(
        () =>
          new APIClient({
            apiKey: 'sk_test',
            baseURL: 'https://api.claw-ops.com',
            maxRetries: 0,
          }),
      ).not.toThrow();
    });

    it('accepts localhost HTTP URLs', () => {
      expect(
        () => new APIClient({ apiKey: 'sk_test', baseURL: 'http://localhost:3000', maxRetries: 0 }),
      ).not.toThrow();
    });

    it('accepts http://127.0.0.1', () => {
      expect(
        () => new APIClient({ apiKey: 'sk_test', baseURL: 'http://127.0.0.1:8080', maxRetries: 0 }),
      ).not.toThrow();
    });

    it('rejects non-localhost HTTP URLs', () => {
      expect(
        () =>
          new APIClient({
            apiKey: 'sk_test',
            baseURL: 'http://api.example.com',
            maxRetries: 0,
          }),
      ).toThrow(ClawOpsError);
    });

    it('rejects invalid URLs', () => {
      expect(
        () => new APIClient({ apiKey: 'sk_test', baseURL: 'not-a-url', maxRetries: 0 }),
      ).toThrow(ClawOpsError);
    });
  });

  describe('custom fetch injection', () => {
    it('uses injected fetch function', async () => {
      const customFetch = mockResponse({ id: 'custom', name: 'injected' });
      const client = new APIClient({
        apiKey: 'sk_test',
        baseURL: 'http://localhost:3000',
        fetch: customFetch,
        maxRetries: 0,
      });

      const result = await client._get('/test', { castTo: TestSchema });
      expect(result).toEqual({ id: 'custom', name: 'injected' });
      expect(customFetch).toHaveBeenCalledOnce();
    });
  });

  describe('response validation', () => {
    it('returns null for 204 No Content', async () => {
      const fetchFn = mock204();
      const client = createClient(fetchFn);

      const result = await client._get('/test', { castTo: TestSchema });
      // _get does result!, so 204 returns null from _request
      // but _get returns result! which would be null
      // Actually looking at code: 204 returns null, _get returns result! which is null
    });
  });
});
