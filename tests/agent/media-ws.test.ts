import { describe, it, expect } from 'vitest';
import {
  parseStartEvent,
  parseMediaEvent,
  buildMediaResponse,
  parseDtmfEvent,
  buildDtmfMessage,
} from '../../src/agent/media-ws.js';

describe('parseStartEvent', () => {
  it('parses a full start event', () => {
    const data = {
      event: 'start',
      start: {
        streamId: 'STR123',
        callId: 'CA456',
        accountId: 'AC789',
        mediaFormat: {
          sampleRate: 8000,
        },
      },
    };
    const result = parseStartEvent(data);
    expect(result.streamId).toBe('STR123');
    expect(result.callId).toBe('CA456');
    expect(result.accountId).toBe('AC789');
    expect(result.sampleRate).toBe(8000);
  });

  it('falls back to defaults for missing fields', () => {
    const data = {
      event: 'start',
      start: {},
    };
    const result = parseStartEvent(data);
    expect(result.streamId).toBe('');
    expect(result.callId).toBe('');
    expect(result.accountId).toBe('');
    expect(result.sampleRate).toBe(8000);
  });
});

describe('parseMediaEvent', () => {
  it('parses a media event with payload', () => {
    const data = {
      event: 'media',
      media: {
        payload: 'dGVzdA==',
        timestamp: '1234',
      },
    };
    const result = parseMediaEvent(data);
    expect(result.audio).toEqual(Buffer.from('test'));
    expect(result.timestamp).toBe(1234);
  });

  it('uses defaults for missing media fields', () => {
    const data = {
      event: 'media',
      media: {},
    };
    const result = parseMediaEvent(data);
    expect(result.audio).toEqual(Buffer.alloc(0));
    expect(result.timestamp).toBe(0);
  });
});

describe('buildMediaResponse', () => {
  it('builds a valid JSON media response without streamSid', () => {
    const json = buildMediaResponse('dGVzdA==');
    const parsed = JSON.parse(json);
    expect(parsed.event).toBe('media');
    expect(parsed.media.payload).toBe('dGVzdA==');
    expect(parsed.streamSid).toBeUndefined();
  });
});

describe('parseDtmfEvent', () => {
  it('parses a DTMF event', () => {
    const data = {
      event: 'dtmf',
      sequenceNumber: '5',
      dtmf: { digit: '1', track: 'inbound_track' },
    };
    const result = parseDtmfEvent(data);
    expect(result.digit).toBe('1');
    expect(result.track).toBe('inbound_track');
  });
});

describe('buildDtmfMessage', () => {
  it('builds a valid DTMF message', () => {
    const msg = buildDtmfMessage('5');
    expect(msg).toBe(JSON.stringify({ event: 'dtmf', dtmf: { digit: '5' } }));
  });

  it('throws on invalid digit', () => {
    expect(() => buildDtmfMessage('A')).toThrow('유효하지 않은 DTMF digit');
  });
});
