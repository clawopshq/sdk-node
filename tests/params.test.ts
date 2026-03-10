import { describe, it, expect } from 'vitest';
import type { CallCreateParams, CallListParams, CallUpdateParams } from '../src/types/call-params.js';
import type { NumberCreateParams, NumberUpdateParams } from '../src/types/number-params.js';

describe('CallCreateParams type', () => {
  it('accepts valid create params', () => {
    const params: CallCreateParams = {
      to: '01012345678',
      from: '07012341234',
      url: 'https://example.com/twiml',
    };
    expect(params.to).toBe('01012345678');
    expect(params.from).toBe('07012341234');
    expect(params.url).toBe('https://example.com/twiml');
  });

  it('accepts optional fields', () => {
    const params: CallCreateParams = {
      to: '01012345678',
      from: '07012341234',
      url: 'https://example.com/twiml',
      statusCallback: 'https://example.com/status',
      statusCallbackEvent: 'completed',
    };
    expect(params.statusCallback).toBe('https://example.com/status');
    expect(params.statusCallbackEvent).toBe('completed');
  });
});

describe('CallListParams type', () => {
  it('accepts valid list params', () => {
    const params: CallListParams = {
      status: 'in-progress',
      page: 1,
      pageSize: 20,
    };
    expect(params.status).toBe('in-progress');
    expect(params.page).toBe(1);
    expect(params.pageSize).toBe(20);
  });

  it('accepts empty params', () => {
    const params: CallListParams = {};
    expect(params).toEqual({});
  });
});

describe('CallUpdateParams type', () => {
  it('accepts status update', () => {
    const params: CallUpdateParams = { status: 'completed' };
    expect(params.status).toBe('completed');
  });
});

describe('NumberCreateParams type', () => {
  it('accepts valid create params', () => {
    const params: NumberCreateParams = {
      webhookUrl: 'https://example.com/hook',
    };
    expect(params.webhookUrl).toBe('https://example.com/hook');
  });

  it('accepts empty params', () => {
    const params: NumberCreateParams = {};
    expect(params).toEqual({});
  });
});

describe('NumberUpdateParams type', () => {
  it('accepts valid update params', () => {
    const params: NumberUpdateParams = {
      webhookUrl: 'https://example.com/hook',
      webhookMethod: 'POST',
    };
    expect(params.webhookUrl).toBe('https://example.com/hook');
    expect(params.webhookMethod).toBe('POST');
  });
});
