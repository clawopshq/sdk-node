import { describe, it, expect } from 'vitest';
import {
  parseStartEvent,
  parseMediaEvent,
  buildMediaResponse,
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
