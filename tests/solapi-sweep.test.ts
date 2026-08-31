import { describe, it, expect, vi } from 'vitest';
import type { SolapiMessageService } from 'solapi';
import { ClawOps } from '../src/client.js';
import {
  sweepFailedAlimtalk,
  RECOMMENDED_EXCLUDED_CODES,
  type SweepCursor,
} from '../src/solapi/index.js';

const FROM = '07052753934';
const MARKER = { clawopsFallback: '1' };

function clawops(seen: Array<Record<string, unknown>>) {
  return new ClawOps({
    apiKey: 'sk_test',
    accountId: 'AC_test',
    baseURL: 'http://localhost:3000',
    maxRetries: 0,
    fetch: vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      seen.push(body);
      return new Response(
        JSON.stringify({
          messageId: `MG${seen.length}`,
          status: 'queued',
          type: body.Type ?? 'sms',
          to: body.To,
          from: body.From,
          body: body.Body,
          numMedia: 0,
          mediaUrl: [],
          direction: 'outbound',
          accountId: 'AC_test',
          dateCreated: '2026-08-28T00:00:00Z',
          dateUpdated: null,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  });
}

interface Row {
  messageId: string;
  statusCode: string;
  to?: string;
  customFields?: Record<string, string> | null;
  text?: string | null;
  kakaoOptions?: Record<string, unknown> | null;
  dateUpdated?: string;
}

/** 목 데이터의 갱신 시각. 고정 날짜를 쓰면 lookback 창 밖으로 밀려나 테스트가 날짜에 따라 깨진다 */
const UPDATED_AT = new Date(Date.now() - 5 * 60_000).toISOString();
const CREATED_AT = new Date(Date.now() - 10 * 60_000).toISOString();

function solapiStub(rows: Row[], templates: Record<string, string | undefined> = {}) {
  const templateCalls: string[] = [];
  const queries: Array<Record<string, unknown>> = [];
  const service = {
    async getMessages(params: Record<string, unknown>) {
      queries.push(params);
      return {
        messageList: Object.fromEntries(
          rows.map((row) => [
            row.messageId,
            {
              to: '01011112222',
              from: '029302266',
              type: 'ATA',
              dateCreated: CREATED_AT,
              dateUpdated: UPDATED_AT,
              ...row,
            },
          ]),
        ),
        nextKey: null,
      };
    },
    async getKakaoAlimtalkTemplate(templateId: string) {
      templateCalls.push(templateId);
      return { content: templates[templateId] };
    },
  };
  return { service: service as unknown as SolapiMessageService, templateCalls, queries };
}

const row = (over: Partial<Row> & Pick<Row, 'messageId' | 'statusCode'>): Row => ({
  customFields: { ...MARKER },
  ...over,
});

describe('sweepFailedAlimtalk — 무엇을 집는가', () => {
  it('마커가 없는 건은 건드리지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub([
      row({
        messageId: 'MK1',
        statusCode: '3104',
        customFields: null,
        text: '고객이 직접 보낸 것',
      }),
    ]);

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
    });

    expect(seen).toEqual([]);
    expect(result.sent).toBe(0);
    expect(result.scanned).toBe(1);
  });

  it('대상 코드(3104)면 문자로 대체발송하고 멱등키를 붙인다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub([
      row({ messageId: 'MK1', statusCode: '3104', text: '주문이 접수되었습니다' }),
    ]);

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
    });

    expect(seen).toEqual([
      {
        To: '01011112222',
        From: FROM,
        Body: '주문이 접수되었습니다',
        Type: 'sms',
        IdempotencyKey: 'solapi:MK1',
      },
    ]);
    expect(result.sent).toBe(1);
    expect(result.processed).toEqual(['MK1']);
  });

  it('성공(4000)·발송중(3000)은 무시한다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub([
      row({ messageId: 'MK1', statusCode: '4000', text: 'x' }),
      row({ messageId: 'MK2', statusCode: '3000', text: 'x' }),
      row({ messageId: 'MK3', statusCode: '2000', text: 'x' }),
    ]);

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
    });

    expect(seen).toEqual([]);
    expect(result.sent).toBe(0);
    expect(result.blocked).toBe(0);
  });

  it('기본은 3XXX 를 전부 대체발송한다 — 알림톡에 31xx 만 오는 게 아니다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub([
      row({ messageId: 'MK1', statusCode: '3058', text: '전송경로 없음' }), // 실측에서 알림톡에 온 코드
      row({ messageId: 'MK2', statusCode: '3105', text: '미등록 템플릿' }),
      row({ messageId: 'MK3', statusCode: '3108', text: '야간' }),
    ]);

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
    });

    expect(result.sent).toBe(3);
    expect(result.blocked).toBe(0);
  });

  it('except 로 뺀 코드는 대체발송하지 않고 알린다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const blocked: unknown[] = [];
    const { service } = solapiStub([
      row({ messageId: 'MK1', statusCode: '3105', text: 'x' }), // 미등록 템플릿 = 설정 오류
      row({ messageId: 'MK2', statusCode: '3108', text: 'x' }), // 야간 = 규제
      row({ messageId: 'MK3', statusCode: '3104', text: '주문' }), // 수신자 사유 = 그대로 나간다
    ]);

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      except: RECOMMENDED_EXCLUDED_CODES,
      onBlocked: (event) => blocked.push(event),
    });

    expect(seen).toHaveLength(1);
    expect(result.sent).toBe(1);
    expect(result.blocked).toBe(2);
    expect(blocked).toEqual([
      {
        messageId: 'MK1',
        to: '01011112222',
        statusCode: '3105',
        ok: false,
        reason: 'code_not_eligible',
      },
      {
        messageId: 'MK2',
        to: '01011112222',
        statusCode: '3108',
        ok: false,
        reason: 'code_not_eligible',
      },
    ]);
  });

  it('수신거부(3061)는 RECOMMENDED_EXCLUDED_CODES 에 들어 있다', () => {
    expect(RECOMMENDED_EXCLUDED_CODES).toContain('3061');
  });

  it('on 으로 좁힌 뒤 except 로 다시 뺄 수 있다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub([
      row({ messageId: 'MK1', statusCode: '3104', text: 'a' }),
      row({ messageId: 'MK2', statusCode: '3107', text: 'b' }),
    ]);

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      on: ['3104', '3107'],
      except: ['3107'],
    });

    expect(result.sent).toBe(1);
    expect(result.blocked).toBe(1);
  });

  it('on: [] 은 아무것도 보내지 않는다 — 기본(전부)과 구별된다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub([row({ messageId: 'MK1', statusCode: '3104', text: 'a' })]);

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      on: [],
    });

    expect(seen).toEqual([]);
    expect(result.sent).toBe(0);
    expect(result.blocked).toBe(1);
  });

  it('on 은 대상을 좁힌다 — 준 코드만 나간다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub([
      row({ messageId: 'MK1', statusCode: '3108', text: '야간' }),
      row({ messageId: 'MK2', statusCode: '3104', text: '카톡 미사용' }),
    ]);

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      on: ['3108'],
    });

    expect(seen).toHaveLength(1);
    expect(result.sent).toBe(1);
    expect(result.blocked).toBe(1);
  });
});

describe('sweepFailedAlimtalk — 문구 복원', () => {
  it('customFields 의 문구가 가장 우선한다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, templateCalls } = solapiStub(
      [
        row({
          messageId: 'MK1',
          statusCode: '3104',
          customFields: { ...MARKER, clawopsFallbackText: '지정 문구' },
          text: '알림톡 본문',
          kakaoOptions: { templateId: 'T1' },
        }),
      ],
      { T1: '템플릿 본문' },
    );

    await sweepFailedAlimtalk({ clawops: clawops(seen), solapi: service, from: FROM });

    expect(seen[0]!.Body).toBe('지정 문구');
    expect(templateCalls).toEqual([]);
  });

  it('text 가 없으면 템플릿을 조회해 변수를 치환한다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, templateCalls } = solapiStub(
      [
        row({
          messageId: 'MK1',
          statusCode: '3104',
          text: null,
          kakaoOptions: { templateId: 'T1', variables: { 고객명: '홍길동' } },
        }),
      ],
      { T1: '#{고객명}님 주문이 접수되었습니다' },
    );

    await sweepFailedAlimtalk({ clawops: clawops(seen), solapi: service, from: FROM });

    expect(seen[0]!.Body).toBe('홍길동님 주문이 접수되었습니다');
    expect(templateCalls).toEqual(['T1']);
  });

  it('미치환 변수가 남으면 발송하지 않고 알린다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const blocked: Array<{ reason: string }> = [];
    const { service } = solapiStub(
      [
        row({
          messageId: 'MK1',
          statusCode: '3104',
          text: null,
          kakaoOptions: { templateId: 'T1', variables: { 고객명: '홍길동' } },
        }),
      ],
      { T1: '#{고객명}님 주문 #{번호}' },
    );

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      onBlocked: (event) => blocked.push(event),
    });

    expect(seen).toEqual([]);
    expect(result.sent).toBe(0);
    expect(blocked[0]!.reason).toBe('unresolved_variables');
  });
});

describe('sweepFailedAlimtalk — 다시 보내지 않는다', () => {
  it('커서가 이동하고, 두 번째 스윕에서는 요청이 아예 안 나간다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const rows = [row({ messageId: 'MK1', statusCode: '3104', text: '주문 접수' })];
    const { service, queries } = solapiStub(rows);
    const client = clawops(seen);

    const first = await sweepFailedAlimtalk({ clawops: client, solapi: service, from: FROM });
    expect(seen).toHaveLength(1);
    expect(first.cursor.updatedAt).toBe(UPDATED_AT);
    expect(first.cursor.seen).toEqual(['MK1']);

    // 같은 데이터가 다시 조회돼도 커서의 경계 목록이 막는다
    const second = await sweepFailedAlimtalk({
      clawops: client,
      solapi: service,
      from: FROM,
      cursor: first.cursor,
    });

    expect(seen).toHaveLength(1); // 요청이 늘지 않았다
    expect(second.sent).toBe(0);
    expect(queries[1]!.startDate).toEqual(new Date(UPDATED_AT));
  });

  it('처리 집합으로도 막는다 — 커서가 못 잡는 재갱신 대비', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub([
      row({ messageId: 'MK1', statusCode: '3104', text: '주문 접수' }),
    ]);

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      skip: (messageId) => messageId === 'MK1',
    });

    expect(seen).toEqual([]);
    expect(result.sent).toBe(0);
  });

  it('커서를 잃어도 멱등키가 같아 문자는 두 번 나가지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub([
      row({ messageId: 'MK1', statusCode: '3104', text: '주문 접수' }),
    ]);
    const client = clawops(seen);

    // 프로세스 재시작 — 커서 없이 두 번 돈다
    await sweepFailedAlimtalk({ clawops: client, solapi: service, from: FROM });
    await sweepFailedAlimtalk({ clawops: client, solapi: service, from: FROM });

    expect(seen).toHaveLength(2); // 요청은 두 번 나갔지만
    expect(seen[0]!.IdempotencyKey).toBe('solapi:MK1');
    expect(seen[1]!.IdempotencyKey).toBe(seen[0]!.IdempotencyKey); // 서버가 두 번째를 막는다
  });

  it('커서가 없으면 lookback 만큼 거슬러 조회한다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, queries } = solapiStub([]);

    await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      lookbackMs: 3_600_000,
    });

    const startDate = queries[0]!.startDate as Date;
    const elapsed = Date.now() - startDate.getTime();
    expect(elapsed).toBeGreaterThanOrEqual(3_600_000);
    expect(elapsed).toBeLessThan(3_600_000 + 5_000);
  });
});

describe('SweepCursor 는 직렬화 가능하다', () => {
  it('JSON 왕복 후에도 그대로 쓸 수 있다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub([row({ messageId: 'MK1', statusCode: '3104', text: 'x' })]);

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
    });
    const roundTripped: SweepCursor = JSON.parse(JSON.stringify(result.cursor));

    expect(roundTripped).toEqual(result.cursor);
  });
});

describe('sweepFailedAlimtalk — 경계 상황', () => {
  it('결과가 아직 안 나온 건(빈 코드)은 실패로 알리지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const blocked: unknown[] = [];
    const { service } = solapiStub([
      { messageId: 'MK1', statusCode: '', customFields: { ...MARKER }, text: 'x' } as Row,
    ]);

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      onBlocked: (event) => blocked.push(event),
    });

    // 리포트를 기다리는 중인 건으로 사람을 깨우면 안 된다
    expect(blocked).toEqual([]);
    expect(result.blocked).toBe(0);
    expect(seen).toEqual([]);
  });

  it('페이지 상한에 걸리면 커서를 옮기지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    // nextKey 를 계속 돌려줘 상한(50페이지)에 걸리게 한다
    const service = {
      async getMessages() {
        return {
          messageList: {
            MK1: {
              messageId: 'MK1',
              statusCode: '4000',
              to: '01011112222',
              dateUpdated: UPDATED_AT,
              dateCreated: CREATED_AT,
            },
          },
          nextKey: 'MORE',
        };
      },
      async getKakaoAlimtalkTemplate() {
        return { content: undefined };
      },
    } as unknown as SolapiMessageService;

    const before: SweepCursor = { updatedAt: CREATED_AT, seen: [] };
    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      cursor: before,
    });

    expect(result.truncated).toBe(true);
    // 커서를 옮기면 못 본 구간을 영영 다시 안 본다
    expect(result.cursor).toEqual(before);
  });

  it('types 로 훑을 메시지 타입을 넓힐 수 있다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, queries } = solapiStub([]);

    await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      types: ['ATA', 'CTA'],
    });

    expect(queries.map((q) => q.type)).toEqual(['ATA', 'CTA']);
  });

  it('concurrency 0 이어도 조용히 누락되지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub([
      row({ messageId: 'MK1', statusCode: '3104', text: '주문 접수' }),
    ]);

    // `Number(process.env.X)` 가 미설정 시 0 이 되는 흔한 경로
    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      concurrency: 0,
    });

    expect(result.sent).toBe(1);
    expect(seen).toHaveLength(1);
  });
});

describe('sweepFailedAlimtalk — 조용히 틀리지 않는다', () => {
  it('3XXX 가 아닌 코드는 실패로 알리지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const blocked: unknown[] = [];
    const { service } = solapiStub([
      row({ messageId: 'MK1', statusCode: '2254', text: 'x' }), // 플랫폼 내부 스팸 처리
      row({ messageId: 'MK2', statusCode: '9999', text: 'x' }), // 벤더가 나중에 추가한 코드
    ]);

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      onBlocked: (event) => blocked.push(event),
    });

    // 모르는 값으로 사람을 깨우지 않는다
    expect(blocked).toEqual([]);
    expect(result.blocked).toBe(0);
  });

  it('조회 창을 lookback 폭으로 제한한다 — 안 그러면 창이 넓어지기만 한다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, queries } = solapiStub([]);
    const long_ago = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      cursor: { updatedAt: long_ago, seen: [] },
      lookbackMs: 3_600_000,
    });

    const { startDate, endDate } = queries[0] as { startDate: Date; endDate: Date };
    expect(endDate.getTime() - startDate.getTime()).toBe(3_600_000);
  });

  it('커서의 seen 이 스윕마다 부풀지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub([row({ messageId: 'MK1', statusCode: '4000', text: 'x' })]);
    const client = clawops(seen);

    let cursor = (await sweepFailedAlimtalk({ clawops: client, solapi: service, from: FROM }))
      .cursor;
    const first = cursor.seen.length;
    cursor = (await sweepFailedAlimtalk({ clawops: client, solapi: service, from: FROM, cursor }))
      .cursor;
    cursor = (await sweepFailedAlimtalk({ clawops: client, solapi: service, from: FROM, cursor }))
      .cursor;

    expect(cursor.seen.length).toBe(first);
  });

  it('ClawOps 가 거절하면 스윕을 멈추지 않고 그 건만 알린다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const blocked: Array<{ reason: string }> = [];
    const rejecting = new ClawOps({
      apiKey: 'sk_test',
      accountId: 'AC_test',
      baseURL: 'http://localhost:3000',
      maxRetries: 0,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: '수신거부 번호입니다' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    });
    const { service } = solapiStub([
      row({ messageId: 'MK1', statusCode: '3104', text: '주문 접수' }),
      row({ messageId: 'MK2', statusCode: '3104', text: '배송 시작' }),
    ]);

    // 한 건이 던지면 커서가 안 옮겨져 대체발송이 영영 진행되지 않는다
    const result = await sweepFailedAlimtalk({
      clawops: rejecting,
      solapi: service,
      from: FROM,
      onBlocked: (event) => blocked.push(event),
    });

    expect(result.blocked).toBe(2);
    expect(blocked.map((b) => b.reason)).toEqual(['send_rejected', 'send_rejected']);
  });

  it('템플릿 조회가 실패해도 스윕 전체가 죽지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const blocked: Array<{ reason: string }> = [];
    const service = {
      async getMessages() {
        return {
          messageList: {
            MK1: {
              messageId: 'MK1',
              statusCode: '3104',
              type: 'ATA',
              to: '01011112222',
              text: null,
              kakaoOptions: { templateId: 'T1' },
              customFields: { ...MARKER },
              dateUpdated: UPDATED_AT,
              dateCreated: CREATED_AT,
            },
          },
          nextKey: null,
        };
      },
      async getKakaoAlimtalkTemplate() {
        throw new Error('일시적 서버 오류');
      },
    } as unknown as SolapiMessageService;

    const result = await sweepFailedAlimtalk({
      clawops: clawops(seen),
      solapi: service,
      from: FROM,
      onBlocked: (event) => blocked.push(event),
    });

    expect(result.blocked).toBe(1);
    expect(blocked[0]!.reason).toBe('no_template_content');
  });
});
