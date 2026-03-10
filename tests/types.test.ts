import { describe, it, expect } from 'vitest';
import { CallSchema, CallControlResponseSchema } from '../src/types/call.js';
import { PhoneNumberSchema } from '../src/types/number.js';
import { PaginationMetaSchema } from '../src/types/shared.js';

describe('CallSchema', () => {
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
