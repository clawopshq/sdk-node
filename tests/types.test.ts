import { describe, it, expect } from 'vitest';
import { CallSchema, CallControlResponseSchema, TransferLegSchema } from '../src/types/call.js';
import { PhoneNumberSchema } from '../src/types/number.js';
import { PaginationMetaSchema } from '../src/types/shared.js';

describe('CallSchema', () => {
  // 단건 조회의 전환 필드(clawops#1215). 서버 응답 모양 — warm 전환이 안내 뒤에 연결된 시도 하나(값은 가짜).
  it('parses transfer summary fields and transfers[]', () => {
    const data = {
      callId: 'CA00000000000000000000000000000001',
      status: 'completed',
      to: '01000000000',
      from: '07012345678',
      direction: 'outbound',
      duration: 62,
      accountId: 'AC123',
      dateCreated: '2026-10-13T07:20:13Z',
      transferTo: '0212345678',
      transferStatus: 'completed',
      transferDuration: 2,
      transferHangupCauseQ850: null,
      transferSipResponseCode: null,
      transferReasonText: null,
      transfers: [
        {
          sequence: 1,
          to: '0212345678',
          mode: 'warm',
          destinationType: 'pstn',
          status: 'completed',
          duration: 2,
          billable: true,
          billableDuration: 2,
          hangupCauseQ850: null,
          sipResponseCode: null,
          reasonText: null,
          startedAt: '2026-10-13T07:21:05.760Z',
          answeredAt: '2026-10-13T07:21:11.312Z',
          connectedAt: '2026-10-13T07:21:19.403Z',
          endedAt: '2026-10-13T07:21:20.989Z',
          timeout: 30,
        },
      ],
    };
    const result = CallSchema.parse(data);
    expect(result.transferStatus).toBe('completed');
    const leg = result.transfers![0];
    // 응답 시간 = answeredAt - startedAt (connectedAt 은 안내 뒤라 늦다).
    expect(Date.parse(leg.answeredAt!) - Date.parse(leg.startedAt!)).toBe(5552);
    expect(leg.timeout).toBe(30);
  });

  // 실제 서버는 이전 시도의 값도 키를 빼지 않고 null 로 보낸다(projectTransferLeg 의 ?? null).
  it('accepts legs from before answeredAt/timeout existed (explicit nulls, as the server sends)', () => {
    const data = {
      callId: 'CA1',
      status: 'completed',
      to: '0212345679',
      from: '07080588491',
      direction: 'inbound',
      accountId: 'AC123',
      dateCreated: '2026-08-27T04:11:02Z',
      transfers: [
        {
          sequence: 1,
          to: '0212345678',
          mode: 'blind',
          destinationType: 'pstn',
          status: 'no-answer',
          duration: null,
          billable: false,
          billableDuration: null,
          hangupCauseQ850: 19,
          sipResponseCode: 480,
          reasonText: null,
          startedAt: '2026-08-27T04:11:02.000Z',
          answeredAt: null,
          connectedAt: null,
          endedAt: '2026-08-27T04:11:32.000Z',
          timeout: null,
        },
      ],
    };
    const leg = CallSchema.parse(data).transfers![0];
    expect(leg.answeredAt).toBeNull();
    expect(leg.timeout).toBeNull();
  });

  // 시도 하나의 모양이 어긋났다고 통화 전체 조회가 실패하면 안 된다.
  it('does not reject the whole call when a leg is missing fields', () => {
    const result = CallSchema.safeParse({
      callId: 'CA3',
      status: 'completed',
      to: '1',
      from: '2',
      direction: 'inbound',
      accountId: 'AC123',
      dateCreated: '2026-10-13T00:00:00Z',
      transfers: [{ sequence: null, status: 'completed' }],
    });
    expect(result.success).toBe(true);
  });

  // 키가 빠진 게 아니라 **타입이 어긋난** 시도도 통화 전체를 실패시키지 않는다(이전엔 passthrough 로 받았다).
  it('keeps a leg with wrong-typed values as-is instead of failing the call', () => {
    const result = CallSchema.safeParse({
      callId: 'CA4',
      status: 'completed',
      to: '1',
      from: '2',
      direction: 'inbound',
      accountId: 'AC123',
      dateCreated: '2026-10-13T00:00:00Z',
      transfers: [{ sequence: 1, status: 'completed', billable: 'yes', timeout: '30' }],
    });
    expect(result.success).toBe(true);
    const leg = result.success ? result.data.transfers![0] : undefined;
    expect(leg?.status).toBe('completed');
    expect((leg as Record<string, unknown>).billable).toBe('yes'); // 받은 값 그대로
    // 스키마 기준으로는 어긋난 값이다 — 그래도 통화 조회는 성공해야 한다.
    expect(TransferLegSchema.safeParse(leg).success).toBe(false);
  });

  // 목록 조회는 transfers 를 싣지 않는다 — 없어도 파싱돼야 한다.
  it('parses a list row without transfers', () => {
    const result = CallSchema.parse({
      callId: 'CA2',
      status: 'completed',
      to: '1',
      from: '2',
      direction: 'inbound',
      accountId: 'AC123',
      dateCreated: '2026-10-13T00:00:00Z',
      transferTo: '01011112222',
      transferStatus: 'no-answer',
      transferDuration: null,
    });
    expect(result.transfers).toBeUndefined();
    expect(result.transferStatus).toBe('no-answer');
  });

  it('parses a valid call object', () => {
    const data = {
      callId: 'CA123',
      status: 'in-progress',
      to: '01012345678',
      from: '07012341234',
      direction: 'inbound',
      duration: 30,
      accountId: 'AC123',
      dateCreated: '2026-01-01T00:00:00Z',
      dateUpdated: '2026-01-01T00:01:00Z',
    };
    const result = CallSchema.parse(data);
    expect(result.callId).toBe('CA123');
    expect(result.status).toBe('in-progress');
    expect(result.direction).toBe('inbound');
  });

  it('rejects invalid status', () => {
    const data = {
      callId: 'CA123',
      status: 'invalid-status',
      to: '01012345678',
      from: '07012341234',
      direction: 'inbound',
      accountId: 'AC123',
      dateCreated: '2026-01-01T00:00:00Z',
    };
    expect(() => CallSchema.parse(data)).toThrow();
  });

  it('allows nullable duration', () => {
    const data = {
      callId: 'CA123',
      status: 'queued',
      to: '01012345678',
      from: '07012341234',
      direction: 'outbound',
      duration: null,
      accountId: 'AC123',
      dateCreated: '2026-01-01T00:00:00Z',
    };
    const result = CallSchema.parse(data);
    expect(result.duration).toBeNull();
  });

  it('parses hangup cause fields on a failed call', () => {
    const data = {
      callId: 'CA14ad61795d28ba036a383f66565376b4',
      status: 'failed',
      to: '07080588491',
      from: '07052361088',
      direction: 'outbound',
      duration: 0,
      accountId: 'AC123',
      dateCreated: '2026-07-30T17:18:15Z',
      hangupCause: 'invalid_number',
      hangupCauseQ850: 1,
      sipResponseCode: 404,
      hangupSource: 'carrier',
    };
    const result = CallSchema.parse(data);
    expect(result.hangupCause).toBe('invalid_number');
    expect(result.hangupCauseQ850).toBe(1);
    expect(result.sipResponseCode).toBe(404);
    expect(result.hangupSource).toBe('carrier');
  });

  it('allows hangup cause fields to be absent (진행 중이거나 사유 미상)', () => {
    const data = {
      callId: 'CA123',
      status: 'in-progress',
      to: '01012345678',
      from: '07012341234',
      direction: 'outbound',
      accountId: 'AC123',
      dateCreated: '2026-01-01T00:00:00Z',
    };
    const result = CallSchema.parse(data);
    expect(result.hangupCause).toBeUndefined();
    expect(result.hangupSource).toBeUndefined();
  });

  it('accepts an unknown hangupCause (서버가 cause 를 넓혀도 파싱 유지)', () => {
    const data = {
      callId: 'CA123',
      status: 'failed',
      to: '01012345678',
      from: '07012341234',
      direction: 'outbound',
      accountId: 'AC123',
      dateCreated: '2026-01-01T00:00:00Z',
      hangupCause: 'some_future_cause',
      hangupCauseQ850: 255,
    };
    const result = CallSchema.parse(data);
    expect(result.hangupCause).toBe('some_future_cause');
  });

  it('allows passthrough of extra fields', () => {
    const data = {
      callId: 'CA123',
      status: 'completed',
      to: '01012345678',
      from: '07012341234',
      direction: 'outbound',
      accountId: 'AC123',
      dateCreated: '2026-01-01T00:00:00Z',
      extraField: 'extra',
    };
    const result = CallSchema.parse(data);
    expect((result as Record<string, unknown>)['extraField']).toBe('extra');
  });
});

describe('CallControlResponseSchema', () => {
  it('parses a valid control response', () => {
    const data = { callId: 'CA123', status: 'completed' };
    const result = CallControlResponseSchema.parse(data);
    expect(result.callId).toBe('CA123');
    expect(result.status).toBe('completed');
  });
});

describe('PhoneNumberSchema', () => {
  it('parses a valid phone number', () => {
    const data = {
      number: '07012341234',
      source: 'kt',
      webhookUrl: 'https://example.com/hook',
      webhookMethod: 'POST',
      createdAt: '2026-01-01T00:00:00Z',
    };
    const result = PhoneNumberSchema.parse(data);
    expect(result.number).toBe('07012341234');
    expect(result.webhookMethod).toBe('POST');
  });

  it('allows nullable optional fields', () => {
    const data = {
      number: '07012341234',
      source: null,
      webhookUrl: null,
      webhookMethod: null,
      createdAt: null,
    };
    const result = PhoneNumberSchema.parse(data);
    expect(result.source).toBeNull();
  });

  it('works with minimal data', () => {
    const data = { number: '07012341234' };
    const result = PhoneNumberSchema.parse(data);
    expect(result.number).toBe('07012341234');
  });
});

describe('PaginationMetaSchema', () => {
  it('parses valid pagination meta', () => {
    const data = { total: 100, page: 1, pageSize: 20 };
    const result = PaginationMetaSchema.parse(data);
    expect(result.total).toBe(100);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
  });

  it('rejects missing required fields', () => {
    expect(() => PaginationMetaSchema.parse({ total: 100 })).toThrow();
  });
});
