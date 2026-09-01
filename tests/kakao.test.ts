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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockResponse(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body, status));
}

const sampleChannel = {
  id: 'clx9kak0001',
  searchId: 'example',
  name: '러너스 고객센터',
  categoryCode: '00100010001',
  status: 'connected',
  managerPhoneMasked: '010-****-5678',
  connectedAt: '2026-09-01T00:00:00.000Z',
  syncedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const sampleTemplate = {
  id: 'clx9tpl0001',
  channelId: 'clx9kak0001',
  name: '주문 접수 안내',
  content: '#{고객명}님, 주문이 접수되었습니다.',
  status: 'APPROVED',
  dormant: false,
  sendable: true,
  assignType: 'CHANNEL',
  messageType: 'BA',
  emphasizeType: 'NONE',
  variables: ['#{고객명}'],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const page = (data: unknown[], meta = { total: data.length, page: 0, pageSize: 20 }) => ({
  data,
  meta,
});

describe('kakao.channels', () => {
  it('목록을 조회하고 status 필터를 실어 보낸다', async () => {
    const fetchFn = mockResponse(page([sampleChannel]));
    const client = createClient(fetchFn);

    const result = await client.kakao.channels.list({ status: 'connected', pageSize: 50 });

    const [url, init] = fetchFn.mock.calls[0];
    expect(init!.method).toBe('GET');
    expect(String(url)).toContain('/v1/accounts/AC_test/kakao/channels');
    expect(String(url)).toContain('status=connected');
    expect(String(url)).toContain('pageSize=50');
    expect(result.data[0].id).toBe('clx9kak0001');
    expect(result.data[0].status).toBe('connected');
  });

  it('필터가 없으면 쿼리 없이 부른다', async () => {
    const fetchFn = mockResponse(page([]));
    const client = createClient(fetchFn);

    await client.kakao.channels.list();
    expect(String(fetchFn.mock.calls[0]![0])).toBe(
      'http://localhost:3000/v1/accounts/AC_test/kakao/channels',
    );
  });

  it('다음 페이지를 이어 받는다', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(page([sampleChannel], { total: 2, page: 0, pageSize: 1 })),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          page([{ ...sampleChannel, id: 'clx9kak0002' }], { total: 2, page: 1, pageSize: 1 }),
        ),
      );
    const client = createClient(fetchFn);

    const p1 = await client.kakao.channels.list({ pageSize: 1 });
    expect(p1.hasNextPage()).toBe(true);
    const p2 = await p1.nextPage();
    expect(p2.data[0].id).toBe('clx9kak0002');
  });

  it('상세를 조회한다 — 이 호출만 카카오 상태를 재확인한다', async () => {
    const fetchFn = mockResponse({ ...sampleChannel, status: 'needs_attention' });
    const client = createClient(fetchFn);

    const channel = await client.kakao.channels.retrieve('clx9kak0001');

    expect(String(fetchFn.mock.calls[0]![0])).toBe(
      'http://localhost:3000/v1/accounts/AC_test/kakao/channels/clx9kak0001',
    );
    expect(channel.status).toBe('needs_attention');
  });

  it('인증번호를 요청한다 — 202 응답에 인증번호는 없다', async () => {
    const fetchFn = mockResponse(
      {
        requested: true,
        searchId: 'example',
        phoneNumberMasked: '010-****-5678',
        retryAfterSeconds: 60,
      },
      202,
    );
    const client = createClient(fetchFn);

    const result = await client.kakao.channels.requestToken({
      searchId: '@example',
      phoneNumber: '010-1234-5678',
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(init!.method).toBe('POST');
    expect(String(url)).toBe('http://localhost:3000/v1/accounts/AC_test/kakao/channels/token');
    expect(JSON.parse(String(init!.body))).toEqual({
      searchId: '@example',
      phoneNumber: '010-1234-5678',
    });
    expect(result.retryAfterSeconds).toBe(60);
  });

  it('연결한다 — 이미 연결된 채널이면 200 으로 기존 연결이 온다(멱등)', async () => {
    const fetchFn = mockResponse(sampleChannel, 200);
    const client = createClient(fetchFn);

    const channel = await client.kakao.channels.connect({
      searchId: 'example',
      phoneNumber: '010-1234-5678',
      categoryCode: '00100010001',
      token: '394812',
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(init!.method).toBe('POST');
    expect(String(url)).toBe('http://localhost:3000/v1/accounts/AC_test/kakao/channels');
    expect(JSON.parse(String(init!.body))).toEqual({
      searchId: 'example',
      phoneNumber: '010-1234-5678',
      categoryCode: '00100010001',
      token: '394812',
    });
    expect(channel.id).toBe('clx9kak0001');
  });

  it('해제하면 해제된 채널 정보가 돌아온다', async () => {
    const fetchFn = mockResponse(sampleChannel);
    const client = createClient(fetchFn);

    const channel = await client.kakao.channels.disconnect('clx9kak0001');

    const [url, init] = fetchFn.mock.calls[0];
    expect(init!.method).toBe('DELETE');
    expect(String(url)).toBe(
      'http://localhost:3000/v1/accounts/AC_test/kakao/channels/clx9kak0001',
    );
    expect(channel.id).toBe('clx9kak0001');
  });
});

describe('kakao.templates', () => {
  it('channelId 를 쿼리로 실어 보낸다', async () => {
    const fetchFn = mockResponse(page([sampleTemplate]));
    const client = createClient(fetchFn);

    const result = await client.kakao.templates.list({ channelId: 'clx9kak0001' });

    const [url] = fetchFn.mock.calls[0];
    expect(String(url)).toContain('/v1/accounts/AC_test/kakao/templates');
    expect(String(url)).toContain('channelId=clx9kak0001');
    expect(result.data[0].sendable).toBe(true);
    expect(result.data[0].variables).toEqual(['#{고객명}']);
  });

  it('검수 상태가 우리가 모르는 값이어도 파싱한다 — 카카오 쪽 열린 집합이다', async () => {
    const fetchFn = mockResponse(
      page([{ ...sampleTemplate, status: 'REJECTED', sendable: false, dormant: false }]),
    );
    const client = createClient(fetchFn);

    const result = await client.kakao.templates.list({ channelId: 'clx9kak0001' });
    expect(result.data[0].status).toBe('REJECTED');
    expect(result.data[0].sendable).toBe(false);
  });
});

describe('kakao.channelCategories', () => {
  it('페이지네이션 없이 data/meta 를 그대로 돌려준다', async () => {
    const fetchFn = mockResponse({
      data: [{ code: '00100010001', name: '고객센터' }],
      meta: { fetchedAt: '2026-09-01T00:00:00.000Z', cached: true },
    });
    const client = createClient(fetchFn);

    const result = await client.kakao.channelCategories();

    expect(String(fetchFn.mock.calls[0]![0])).toBe(
      'http://localhost:3000/v1/accounts/AC_test/kakao/channel-categories',
    );
    expect(result.data[0].code).toBe('00100010001');
    expect(result.meta.cached).toBe(true);
  });
});

describe('멀티 계정', () => {
  it('accounts(id).kakao 가 그 계정 경로로 나간다', async () => {
    const fetchFn = mockResponse(page([sampleTemplate]));
    const client = createClient(fetchFn);

    await client.accounts('AC_other').kakao.templates.list({ channelId: 'clx9kak0001' });

    expect(String(fetchFn.mock.calls[0]![0])).toContain('/v1/accounts/AC_other/kakao/templates');
  });
});
