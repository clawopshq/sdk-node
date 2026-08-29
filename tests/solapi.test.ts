import { describe, it, expect, vi } from 'vitest';
import { Schema } from 'effect';
import { detailGroupMessageResponseSchema } from 'solapi';
import type { SolapiMessageService, DetailGroupMessageResponse } from 'solapi';
import { ClawOps } from '../src/client.js';
import { ClawOpsMessageService, SolapiBridgeError } from '../src/solapi/index.js';
import { ClawOpsError } from '../src/error.js';
import { render, leftovers, resolveFallbackText } from '../src/solapi/fallback-text.js';
import { clawopsType, euckrByteLength } from '../src/solapi/_message-type.js';

type GroupInfo = DetailGroupMessageResponse['groupInfo'];

/** 스텁이 돌려주는 솔라피 groupInfo. 테스트가 읽는 필드만 채운다 */
function groupInfo(): GroupInfo {
  return {
    count: {
      total: 0,
      sentTotal: 0,
      sentFailed: 0,
      sentSuccess: 0,
      sentPending: 0,
      sentReplacement: 0,
      refund: 0,
      registeredFailed: 0,
      registeredSuccess: 0,
    },
    groupId: 'G4Vsolapi',
    accountId: 'ACsolapi',
  } as unknown as GroupInfo;
}

/** ClawOps 응답을 흉내내는 fetch. `fail` 로 특정 호출만 실패시킬 수 있다 */
function clawopsFetch(
  seen: Array<Record<string, unknown>>,
  fail?: (call: number) => Response | undefined,
) {
  let call = 0;
  return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    call += 1;
    const forced = fail?.(call);
    if (forced) return forced;

    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    seen.push(body);
    return new Response(
      JSON.stringify({
        messageId: `MG${seen.length}`,
        status: 'queued',
        type: body.Type,
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
  });
}

function clawops(
  seen: Array<Record<string, unknown>>,
  fail?: (call: number) => Response | undefined,
) {
  return new ClawOps({
    apiKey: 'sk_test',
    accountId: 'AC_test',
    fetch: clawopsFetch(seen, fail),
    baseURL: 'http://localhost:3000',
    maxRetries: 0,
  });
}

interface SolapiStubOptions {
  failFor?: string[];
  throwOnAllFailed?: boolean;
  templates?: Record<string, string | undefined>;
  /** 실제 솔라피는 showMessageList: true 일 때만 messageList 를 준다 */
  omitMessageList?: boolean;
  /** 솔라피가 접수했다고 보고할 건수. 우리 집계가 이걸 덮는지 본다 */
  acceptedCount?: number;
  templateThrows?: boolean;
}

function solapiStub(options: SolapiStubOptions = {}) {
  const outgoing: Array<Record<string, unknown>> = [];
  const templateCalls: string[] = [];
  const failFor = new Set(options.failFor ?? []);

  const service = {
    async send(messages: unknown) {
      const list = Array.isArray(messages) ? messages : [messages];
      const messageList: unknown[] = [];
      const failedMessageList: unknown[] = [];
      for (const message of list as Array<Record<string, unknown>>) {
        outgoing.push(message);
        const recipients = Array.isArray(message.to) ? message.to : [message.to];
        for (const raw of recipients as string[]) {
          const to = raw.replace(/-/g, ''); // solapi 의 phoneNumberSchema 와 같은 정규화
          if (failFor.has(to)) {
            failedMessageList.push({
              to,
              from: String(message.from ?? ''),
              type: 'ATA',
              statusMessage: '접수 실패',
              country: '82',
              messageId: '',
              statusCode: '1010',
              accountId: 'ACsolapi',
            });
          } else {
            messageList.push({
              messageId: `MK${messageList.length + 1}`,
              statusCode: '2000',
              statusMessage: '정상 접수',
              accountId: 'ACsolapi',
              to,
              from: String(message.from ?? ''),
              type: message.type,
              country: '82',
              customFields: null,
            });
          }
        }
      }
      if (options.throwOnAllFailed && messageList.length === 0 && failedMessageList.length > 0) {
        throw Object.assign(new Error('접수 실패'), { failedMessageList });
      }
      const info = groupInfo();
      if (options.acceptedCount !== undefined) {
        (info.count as { total: number; registeredSuccess: number }).total = options.acceptedCount;
        (info.count as { registeredSuccess: number }).registeredSuccess = options.acceptedCount;
      }
      return {
        groupInfo: info,
        messageList: options.omitMessageList ? undefined : messageList,
        failedMessageList,
      };
    },
    async getKakaoAlimtalkTemplate(templateId: string) {
      templateCalls.push(templateId);
      if (options.templateThrows) throw new Error('일시적 서버 오류');
      return { content: options.templates?.[templateId] };
    },
    async getBalance() {
      return { balance: 12_345, point: 0 };
    },
  };

  return { service: service as unknown as SolapiMessageService, outgoing, templateCalls };
}

describe('render / leftovers', () => {
  it('#{name} 과 name 두 형태를 모두 치환한다', () => {
    expect(render('안녕 #{이름}님', { 이름: '권지혜' })).toBe('안녕 권지혜님');
    expect(render('안녕 #{이름}님', { '#{이름}': '권지혜' })).toBe('안녕 권지혜님');
  });

  it('치환되지 않은 변수를 찾아낸다', () => {
    expect(leftovers('주문 #{번호} 금액 #{금액}')).toEqual(['#{번호}', '#{금액}']);
    expect(leftovers('완성된 문구')).toEqual([]);
  });
});

describe('SMS/LMS 경계 — 서버와 같아야 한다', () => {
  // 서버(app/src/services/messages.ts 의 SMS_MAX_EUCKR_BYTES)와 어긋나면 우리가 sms 로 보낸
  // 건이 곧바로 400 body_too_long 이 된다. 상한은 UTF-8 이 아니라 **EUC-KR 90byte** 다 —
  // 통신사는 초과분을 거절하지 않고 90byte 에서 잘라 보내고 '전송성공'으로 리포트한다.
  it('EUC-KR 90byte 는 sms, 92byte 는 lms', () => {
    expect(euckrByteLength('가'.repeat(45))).toBe(90);
    expect(clawopsType({ text: '가'.repeat(45) })).toBe('sms');
    expect(clawopsType({ text: '가'.repeat(46) })).toBe('lms');
  });

  it('UTF-8 로는 200byte 이하여도 한글 45자를 넘으면 lms', () => {
    const text = '가'.repeat(46); // UTF-8 138byte — 옛 기준(200)에서는 sms 였다
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(200);
    expect(clawopsType({ text })).toBe('lms');
  });

  it('EUC-KR 밖 문자는 2byte 로 센다 (과대평가 = 안전)', () => {
    expect(euckrByteLength('a⸻')).toBe(3);
    expect(euckrByteLength('a😀')).toBe(3);
  });

  it('subject 가 있으면 짧아도 lms', () => {
    expect(clawopsType({ text: '짧음', subject: '제목' })).toBe('lms');
  });

  it('명시한 타입은 길이와 무관하게 존중한다', () => {
    expect(clawopsType({ type: 'SMS', text: '가'.repeat(46) })).toBe('sms');
  });
});

describe('resolveFallbackText', () => {
  it('customFields 가 있으면 그것이 정본이다', async () => {
    const { service, templateCalls } = solapiStub({ templates: { T1: '템플릿 본문' } });
    const result = await resolveFallbackText(
      {
        to: '01011112222',
        type: 'ATA',
        kakaoOptions: { pfId: 'PF', templateId: 'T1' },
        customFields: { clawopsFallbackText: '지정 문구' },
      },
      service,
    );
    expect(result).toEqual({ ok: true, text: '지정 문구', source: 'customFields' });
    expect(templateCalls).toEqual([]);
  });

  it('ATA 는 템플릿을 조회해 변수를 치환한다', async () => {
    const { service } = solapiStub({ templates: { T1: '#{고객명}님 주문 #{번호}' } });
    const result = await resolveFallbackText(
      {
        to: '01011112222',
        type: 'ATA',
        kakaoOptions: { pfId: 'PF', templateId: 'T1', variables: { 고객명: '권지혜', 번호: 'A1' } },
      },
      service,
    );
    expect(result).toEqual({ ok: true, text: '권지혜님 주문 A1', source: 'template' });
  });

  // solapi 의 `type` 은 optional 이고 서버가 vendor 옵션으로 추론한다. 실제 고객 코드는
  // `send({ to, from, kakaoOptions })` 처럼 type 을 생략하는데, 타입 문자열로 판정하던 시절엔
  // 이 경우가 템플릿 경로를 건너뛰고 `no_text` 로 떨어져 **대체발송이 통째로 안 나갔다**.
  // 실호출(2026-08-29)에서 잡혔고 스텁 테스트는 전부 type 을 명시해 못 잡았다.
  it('type 을 생략해도 templateId 가 있으면 템플릿을 조회한다', async () => {
    const { service } = solapiStub({ templates: { T1: '#{이름}님 환영합니다' } });
    const result = await resolveFallbackText(
      {
        to: '01011112222',
        kakaoOptions: { pfId: 'PF', templateId: 'T1', variables: { '#{이름}': '권혁' } },
      },
      service,
    );
    expect(result).toEqual({ ok: true, text: '권혁님 환영합니다', source: 'template' });
  });

  it('변수를 빠뜨리면 ok:false 로 막는다', async () => {
    const { service } = solapiStub({ templates: { T1: '#{고객명}님 주문 #{번호}' } });
    const result = await resolveFallbackText(
      {
        to: '01011112222',
        type: 'ATA',
        kakaoOptions: { pfId: 'PF', templateId: 'T1', variables: { 고객명: '권지혜' } },
      },
      service,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'unresolved_variables',
      unresolved: ['#{번호}'],
      source: 'template',
    });
  });

  it('템플릿을 쓰지 않는 타입은 text 가 본문이다', async () => {
    const { service, templateCalls } = solapiStub();
    const result = await resolveFallbackText(
      { to: '01011112222', type: 'CTA', kakaoOptions: { pfId: 'PF' }, text: '친구톡 본문' },
      service,
    );
    expect(result).toEqual({ ok: true, text: '친구톡 본문', source: 'text' });
    expect(templateCalls).toEqual([]);
  });

  it('같은 템플릿은 캐시에서 읽는다', async () => {
    const { service, templateCalls } = solapiStub({ templates: { T1: '본문' } });
    const cache = new Map<string, string | undefined>();
    const message = {
      to: '01011112222',
      type: 'ATA' as const,
      kakaoOptions: { pfId: 'PF', templateId: 'T1' },
    };
    await resolveFallbackText(message, service, { cache });
    await resolveFallbackText(message, service, { cache });
    expect(templateCalls).toEqual(['T1']);
  });
});

describe('ClawOpsMessageService', () => {
  it('문자는 ClawOps 로 PascalCase 본문을 보낸다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, outgoing } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    await messageService.send({ to: '01011112222', from: '07052753934', text: '안녕하세요' });

    expect(seen).toEqual([
      { To: '01011112222', From: '07052753934', Body: '안녕하세요', Type: 'sms' },
    ]);
    expect(outgoing).toEqual([]);
  });

  it('알림톡은 from 을 빼고 disableSms 를 켜서 솔라피로 넘긴다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, outgoing } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1', disableSms: false },
      text: '주문 접수',
    });

    expect(seen).toEqual([]);
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]).not.toHaveProperty('from');
    expect(outgoing[0]!.kakaoOptions).toMatchObject({ disableSms: true });
  });

  it('알림톡 접수 실패 시 템플릿 문구로 대체발송하고 sentReplacement 를 올린다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub({
      failFor: ['01011112222'],
      templates: { T1: '#{고객명}님 주문이 접수되었습니다' },
    });
    const events: unknown[] = [];
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
      fallback: { enabled: true, onFallback: (event) => events.push(event) },
    });

    const response = await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1', variables: { 고객명: '권지혜' } },
    });

    expect(seen).toEqual([
      {
        To: '01011112222',
        From: '07052753934',
        Body: '권지혜님 주문이 접수되었습니다',
        Type: 'sms',
      },
    ]);
    expect(response.groupInfo.count.sentReplacement).toBe(1);
    expect(response.failedMessageList).toEqual([]);
    expect(events).toEqual([
      { to: '01011112222', source: 'template', text: '권지혜님 주문이 접수되었습니다' },
    ]);
  });

  it('미치환 변수가 남으면 발송하지 않고 실패로 남긴다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub({
      failFor: ['01011112222'],
      templates: { T1: '#{고객명}님 주문 #{번호}' },
    });
    const blocked: unknown[] = [];
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
      fallback: { enabled: true, onBlocked: (event) => blocked.push(event) },
    });

    const response = await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1', variables: { 고객명: '권지혜' } },
    });

    expect(seen).toEqual([]);
    expect(response.groupInfo.count.sentReplacement).toBe(0);
    expect(response.failedMessageList).toHaveLength(1);
    expect(blocked).toEqual([
      {
        to: '01011112222',
        ok: false,
        reason: 'unresolved_variables',
        unresolved: ['#{번호}'],
        source: 'template',
      },
    ]);
  });

  it('disableSms: true 면 대체발송하지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub({ failFor: ['01011112222'], templates: { T1: '본문' } });
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    const response = await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1', disableSms: true },
    });

    expect(seen).toEqual([]);
    expect(response.failedMessageList).toHaveLength(1);
  });

  it('from 이 없으면 대체발송하지 않는다 (솔라피 규칙과 동일)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub({ failFor: ['01011112222'], templates: { T1: '본문' } });
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    const response = await messageService.send({
      to: '01011112222',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1' },
    });

    expect(seen).toEqual([]);
    expect(response.failedMessageList).toHaveLength(1);
  });

  it('전건 접수 실패로 SDK 가 예외를 던져도 대체발송한다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub({
      failFor: ['01011112222'],
      throwOnAllFailed: true,
      templates: { T1: '주문 접수' },
    });
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    const response = await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1' },
    });

    expect(seen).toHaveLength(1);
    expect(response.groupInfo.count.sentReplacement).toBe(1);
  });

  it('솔라피 전용 메서드는 원본으로 위임한다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    await expect(messageService.getBalance()).resolves.toEqual({ balance: 12_345, point: 0 });
  });

  it('solapi 없이 만들면 문자는 되고 솔라피 기능은 막힌다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      from: '07052753934',
    });

    await messageService.send({ to: '01011112222', text: '문자' });
    expect(seen).toHaveLength(1);

    const anyService = messageService as unknown as SolapiMessageService;
    expect(() => anyService.getBalance()).toThrow(/솔라피 기능/);
  });

  it('solapi 없이 알림톡을 보내려 하면 명확히 실패한다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      from: '07052753934',
    });

    await expect(
      messageService.send({ to: '01011112222', type: 'ATA', kakaoOptions: { pfId: 'PF' } }),
    ).rejects.toThrow(/solapi 인스턴스/);
  });
});

describe('전화번호 정규화와 실패 짝짓기', () => {
  it('하이픈이 든 번호도 대체발송된다 (solapi 는 하이픈을 지워 돌려준다)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub({
      failFor: ['01011112222'],
      templates: { T1: '주문이 접수되었습니다' },
    });
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '070-5275-3934',
    });

    const response = await messageService.send({
      to: '010-1111-2222',
      from: '070-5275-3934',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1' },
    });

    expect(response.groupInfo.count.sentReplacement).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ To: '01011112222', From: '07052753934' });
  });

  it('같은 수신자에게 두 건을 보내면 각자의 템플릿 문구로 대체발송한다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub({
      failFor: ['01011112222'],
      templates: { T1: '첫번째 문구', T2: '두번째 문구' },
    });
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    await messageService.send([
      {
        to: '01011112222',
        from: '07052753934',
        type: 'ATA',
        kakaoOptions: { pfId: 'PF', templateId: 'T1' },
      },
      {
        to: '01011112222',
        from: '07052753934',
        type: 'ATA',
        kakaoOptions: { pfId: 'PF', templateId: 'T2' },
      },
    ]);

    expect(seen.map((s) => s.Body)).toEqual(['첫번째 문구', '두번째 문구']);
  });

  it('카카오가 아닌 타입은 from 과 옵션을 그대로 넘긴다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, outgoing } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'RCS_SMS',
      rcsOptions: { brandId: 'B', templateId: 'R1' },
      text: 'RCS',
    });

    expect(outgoing[0]).toMatchObject({ from: '07052753934' });
    expect(outgoing[0]).not.toHaveProperty('kakaoOptions');
    expect(seen).toEqual([]);
  });

  it('imageId 가 있으면 조용히 버리지 않고 실패한다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    await expect(
      messageService.send({ to: '01011112222', type: 'MMS', text: '사진', imageId: 'IMG1' }),
    ).rejects.toThrow(/imageId/);
    expect(seen).toEqual([]);
  });

  it('예약 발송을 즉시 발송으로 바꾸지 않고 막는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    await expect(
      messageService.send(
        { to: '01011112222', text: '문자' },
        { scheduledDate: new Date('2030-01-01') },
      ),
    ).rejects.toThrow(/scheduledDate/);
    expect(seen).toEqual([]);
  });

  it('한 건이 실패해도 나머지 발송 기록을 잃지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen, (call) =>
        call === 2
          ? new Response(JSON.stringify({ error: '수신거부 번호입니다' }), {
              status: 422,
              headers: { 'Content-Type': 'application/json' },
            })
          : undefined,
      ),
      solapi: service,
      from: '07052753934',
    });

    const response = await messageService.send({
      to: ['01011112222', '01022223333', '01033334444'],
      text: '문자',
    });

    expect(response.messageList).toHaveLength(2);
    expect(response.failedMessageList).toHaveLength(1);
    expect(response.failedMessageList[0]).toMatchObject({ statusCode: 'CLAWOPS' });
  });

  it('문자 전용 서비스를 async 함수에서 반환할 수 있다', async () => {
    const messageService = new ClawOpsMessageService({
      clawops: clawops([]),
      from: '07052753934',
    });

    const factory = async () => messageService;
    await expect(factory()).resolves.toBe(messageService);
    expect(() => JSON.stringify({ messageService })).not.toThrow();
  });

  it('NSA 는 카카오 템플릿을 조회하지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, templateCalls } = solapiStub({ failFor: ['01011112222'] });
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'NSA',
      naverOptions: { talkId: 'T', templateId: 'N1' },
      text: '네이버 알림',
    });

    expect(templateCalls).toEqual([]);
  });
});

describe('솔라피 응답 계약', () => {
  it('문자만 보낸 응답이 솔라피 스키마를 만족한다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    const response = await messageService.send({ to: '01011112222', text: '문자' });

    // 하드코딩한 groupInfo 가 솔라피 계약과 어긋나면 여기서 잡힌다.
    // 손으로 옮겨적은 CHARGE_KEYS 가 낡는 것을 사람 눈 대신 디코더가 본다
    expect(() =>
      Schema.decodeUnknownSync(detailGroupMessageResponseSchema)(response),
    ).not.toThrow();
  });

  it('groupId 로 솔라피 그룹이 아님을 알 수 있다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    const ours = await messageService.send({ to: '01011112222', text: '문자' });
    expect(ours.groupInfo.groupId).toMatch(/^CLAWOPS-/);

    // 솔라피가 준 groupInfo 는 그대로 이어받는다
    const mixed = await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1' },
    });
    expect(mixed.groupInfo.groupId).toBe('G4Vsolapi');
  });
});

describe('에러 계약과 JS 규약', () => {
  it('던지는 에러가 모두 ClawOpsError 를 상속한다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      from: '07052753934',
    });

    await expect(
      messageService.send(
        { to: '01011112222', text: '문자' },
        { scheduledDate: new Date('2030-01-01') },
      ),
    ).rejects.toBeInstanceOf(ClawOpsError);

    await expect(
      messageService.send({ to: '01011112222', type: 'MMS', text: 'x', imageId: 'IMG' }),
    ).rejects.toBeInstanceOf(SolapiBridgeError);
  });

  it('문자 전용 모드에서도 Object.prototype 의 것들은 정상 동작한다', () => {
    const messageService = new ClawOpsMessageService({ clawops: clawops([]), from: '07052753934' });

    expect(() => Object.prototype.hasOwnProperty.call(messageService, 'send')).not.toThrow();
    expect(() => (messageService as unknown as object).toString()).not.toThrow();
    expect(() => JSON.stringify({ messageService })).not.toThrow();
  });

  it('같은 템플릿을 동시에 찾아도 조회는 한 번만 나간다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const recipients = ['01011112222', '01022223333', '01033334444', '01044445555'];
    const { service, templateCalls } = solapiStub({
      failFor: recipients,
      templates: { T1: '주문이 접수되었습니다' },
    });
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    const response = await messageService.send(
      recipients.map((to) => ({
        to,
        from: '07052753934',
        type: 'ATA' as const,
        kakaoOptions: { pfId: 'PF', templateId: 'T1' },
      })),
    );

    expect(response.groupInfo.count.sentReplacement).toBe(4);
    expect(templateCalls).toEqual(['T1']); // 동시에 4건이 찾아도 한 번
  });

  it('solapi 를 런타임에만 아는 경우에도 생성할 수 있다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub();
    // 실제 코드에서 흔한 모양: 설정이 있을 때만 솔라피를 붙인다
    const maybe: SolapiMessageService | undefined = service;
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      from: '07052753934',
      solapi: maybe,
    });

    await messageService.send({ to: '01011112222', text: '문자' });
    expect(seen).toHaveLength(1);
  });
});

describe('라우팅 경계와 집계', () => {
  it('fallback 을 끄면 솔라피 요청을 손대지 않는다 — 저쪽 대체발송을 죽이면 안 된다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, outgoing } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
      fallback: false,
    });

    await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1' },
    });

    // from 이 그대로 남고 disableSms 도 건드리지 않아야 솔라피가 자기 대체발송을 한다
    expect(outgoing[0]).toMatchObject({ from: '07052753934' });
    expect(outgoing[0]!.kakaoOptions).not.toHaveProperty('disableSms');
  });

  it('type 없이 kakaoOptions 만 있어도 솔라피로 간다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, outgoing } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    // solapi 의 type 은 optional 이고 서버가 옵션으로 종류를 추론한다.
    // type 만 보고 가르면 이 알림톡이 빈 본문 문자로 나간다
    await messageService.send({
      to: '01011112222',
      from: '07052753934',
      kakaoOptions: { pfId: 'PF', templateId: 'T1', variables: { 고객명: '홍길동' } },
    });

    expect(seen).toEqual([]);
    expect(outgoing).toHaveLength(1);
  });

  it('솔라피 집계를 덮지 않고 우리 몫을 더한다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    // messageList 는 showMessageList: true 일 때만 오므로 기본 호출에서는 비어 있다
    const { service } = solapiStub({ omitMessageList: true, acceptedCount: 50 });
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    const response = await messageService.send([
      {
        to: '01011112222',
        from: '07052753934',
        type: 'ATA',
        kakaoOptions: { pfId: 'PF', templateId: 'T1' },
      },
      { to: '01022223333', from: '07052753934', text: '문자' },
    ]);

    // 솔라피가 접수한 50건이 사라지지 않아야 한다
    expect(response.groupInfo.count.registeredSuccess).toBe(51);
    expect(response.groupInfo.count.total).toBe(51);
  });

  it('알림톡만 보내도 예약 발송은 막는다 — 대체 문자가 지금 나가버린다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    await expect(
      messageService.send(
        {
          to: '01011112222',
          from: '07052753934',
          type: 'ATA',
          kakaoOptions: { pfId: 'PF', templateId: 'T1' },
        },
        { scheduledDate: new Date('2030-01-01') },
      ),
    ).rejects.toThrow(/scheduledDate/);
  });

  it('mode 를 안 켜도 마커는 심는다 — 크론에서 스윕을 부르는 구성이 있다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, outgoing } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1' },
    });

    expect(outgoing[0]!.customFields).toMatchObject({ clawopsFallback: '1' });
  });

  it('템플릿 조회가 실패해도 send() 전체를 죽이지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service } = solapiStub({ failFor: ['01011112222'], templateThrows: true });
    const blocked: Array<{ reason: string }> = [];
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
      fallback: { enabled: true, onBlocked: (event) => blocked.push(event) },
    });

    const response = await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1' },
    });

    expect(response.failedMessageList).toHaveLength(1);
    expect(blocked[0]!.reason).toBe('no_template_content');
  });

  it('대체발송이 실패하면 onFallback 을 부르지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const events: unknown[] = [];
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
    const { service } = solapiStub({ failFor: ['01011112222'], templates: { T1: '주문 접수' } });
    const messageService = new ClawOpsMessageService({
      clawops: rejecting,
      solapi: service,
      from: '07052753934',
      fallback: { enabled: true, onFallback: (event) => events.push(event) },
    });

    const response = await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1' },
    });

    expect(events).toEqual([]); // 도달했다고 오해할 로그를 남기지 않는다
    expect(response.failedMessageList).toHaveLength(1);
  });

  it("mode: 'sweep' 인데 solapi 가 없으면 조용히 넘기지 않는다", () => {
    expect(
      () =>
        new ClawOpsMessageService({
          clawops: clawops([]),
          from: '07052753934',
          fallback: { enabled: true, mode: 'sweep' },
        }),
    ).toThrow(/solapi 인스턴스/);
  });
});

describe('손댈 수 없으면 원본을 그대로 넘긴다', () => {
  it('브랜드메시지(kakaoOptions.bms)는 건드리지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, outgoing } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'BMS_TEXT',
      kakaoOptions: { pfId: 'PF', bms: { targeting: 'M' } },
    });

    // 같은 필드를 쓰는 다른 제품이라 대체발송 규칙이 다르다. 손대면 저쪽 기능을 죽인다
    expect(outgoing[0]).toMatchObject({ from: '07052753934' });
    expect(outgoing[0]!.kakaoOptions).not.toHaveProperty('disableSms');
    expect(outgoing[0]!.customFields).toBeUndefined();
  });

  it('customFields 가 10개면 마커를 심지 못하므로 손대지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, outgoing } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    const full = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, 'v']));
    await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1' },
      customFields: full,
    });

    // 마커 없이 disableSms 만 켜면 우리도 저쪽도 대체발송을 못 한다
    expect(outgoing[0]).toMatchObject({ from: '07052753934' });
    expect(outgoing[0]!.kakaoOptions).not.toHaveProperty('disableSms');
    expect(outgoing[0]!.customFields).toEqual(full);
  });

  it('disableSms: true 면 마커도 심지 않는다', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { service, outgoing } = solapiStub();
    const messageService = new ClawOpsMessageService({
      clawops: clawops(seen),
      solapi: service,
      from: '07052753934',
    });

    await messageService.send({
      to: '01011112222',
      from: '07052753934',
      type: 'ATA',
      kakaoOptions: { pfId: 'PF', templateId: 'T1', disableSms: true },
    });

    expect(outgoing[0]!.customFields).toBeUndefined();
  });
});
