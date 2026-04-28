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

const sampleLink = {
  linkId: 'lnk_1',
  url: 'http://localhost:3000/assign/lnk_1',
  status: 'pending',
  createdAt: '2026-04-01T00:00:00Z',
  expiresAt: '2026-04-08T00:00:00Z',
  consumedAt: null,
  webhookUrl: null,
  webhookMethod: 'POST',
  note: null,
  assignment: null,
};

describe('AssignmentLinks resource', () => {
  describe('create', () => {
    it('POSTs to /assignment-links and returns token/url/expiresAt', async () => {
      const fetchFn = mockResponse(
        { token: 'tok', url: 'http://localhost:3000/assign/tok', expiresAt: '2026-05-01T00:00:00Z' },
        201,
      );
      const client = createClient(fetchFn);
      const res = await client.assignmentLinks.create();
      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('POST');
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/assignment-links');
      expect(res.token).toBe('tok');
      expect(res.url).toContain('/assign/tok');
    });

    it('forwards webhookUrl/webhookMethod/note in body', async () => {
      const fetchFn = mockResponse(
        { token: 't', url: 'u', expiresAt: '2026-05-01T00:00:00Z' },
        201,
      );
      const client = createClient(fetchFn);
      await client.assignmentLinks.create({
        webhookUrl: 'https://x',
        webhookMethod: 'GET',
        note: 'n',
      });
      const [, init] = fetchFn.mock.calls[0];
      expect(init!.body).toBeDefined();
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ webhookUrl: 'https://x', webhookMethod: 'GET', note: 'n' });
    });
  });

  describe('list', () => {
    it('GETs the list and returns Page<AssignmentLink>', async () => {
      const fetchFn = mockResponse({
        data: [sampleLink],
        meta: { page: 0, pageSize: 20, total: 1 },
      });
      const client = createClient(fetchFn);
      const page = await client.assignmentLinks.list();
      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('GET');
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/assignment-links');
      expect(page.data).toHaveLength(1);
      expect(page.data[0].linkId).toBe('lnk_1');
      expect(page.meta.total).toBe(1);
    });

    it('includes status/page/pageSize in query', async () => {
      const fetchFn = mockResponse({ data: [], meta: { page: 2, pageSize: 50, total: 0 } });
      const client = createClient(fetchFn);
      await client.assignmentLinks.list({ status: 'consumed', page: 2, pageSize: 50 });
      const [url] = fetchFn.mock.calls[0];
      expect(url).toContain('status=consumed');
      expect(url).toContain('page=2');
      expect(url).toContain('pageSize=50');
    });
  });

  describe('retrieve', () => {
    it('GETs the detail with assignment info', async () => {
      const fetchFn = mockResponse({
        ...sampleLink,
        status: 'consumed',
        consumedAt: '2026-04-02T00:00:00Z',
        assignment: {
          number: '07012340001',
          name: '홍길동',
          consumedAt: '2026-04-02T00:00:00Z',
          releasedAt: null,
        },
      });
      const client = createClient(fetchFn);
      const link = await client.assignmentLinks.retrieve('lnk_1');
      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('GET');
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/assignment-links/lnk_1');
      expect(link.status).toBe('consumed');
      expect(link.assignment?.number).toBe('07012340001');
    });
  });

  describe('revoke', () => {
    it('DELETEs the link', async () => {
      const fetchFn = mockResponse({ ok: true });
      const client = createClient(fetchFn);
      await client.assignmentLinks.revoke('lnk_1');
      const [url, init] = fetchFn.mock.calls[0];
      expect(init!.method).toBe('DELETE');
      expect(url).toBe('http://localhost:3000/v1/accounts/AC_test/assignment-links/lnk_1');
    });
  });
});
