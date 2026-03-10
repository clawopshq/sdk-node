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
      streamSid: 'MZ123',
      start: {
        streamSid: 'MZ123',
        callSid: 'CA456',
        accountSid: 'AC789',
        tracks: ['inbound'],
        customParameters: { foo: 'bar' },
        mediaFormat: {
          encoding: 'audio/x-mulaw',
          sampleRate: 8000,
          channels: 1,
        },
      },
    };
    const result = parseStartEvent(data);
    expect(result.streamSid).toBe('MZ123');
    expect(result.callSid).toBe('CA456');
    expect(result.accountSid).toBe('AC789');
    expect(result.tracks).toEqual(['inbound']);
    expect(result.customParameters).toEqual({ foo: 'bar' });
    expect(result.mediaFormat.encoding).toBe('audio/x-mulaw');
    expect(result.mediaFormat.sampleRate).toBe(8000);
    expect(result.mediaFormat.channels).toBe(1);
  });

  it('falls back to defaults for missing fields', () => {
    const data = {
      event: 'start',
      start: {},
    };
    const result = parseStartEvent(data);
    expect(result.streamSid).toBe('');
    expect(result.callSid).toBe('');
    expect(result.accountSid).toBe('');
    expect(result.tracks).toEqual([]);
    expect(result.customParameters).toEqual({});
    expect(result.mediaFormat).toEqual({
      encoding: 'audio/x-mulaw',
      sampleRate: 8000,
      channels: 1,
    });
  });
});

describe('parseMediaEvent', () => {
  it('parses a media event with chunk', () => {
    const data = {
      event: 'media',
      media: {
        track: 'inbound',
        chunk: 'base64audiochunk==',
        timestamp: '1234',
      },
    };
    const result = parseMediaEvent(data);
    expect(result.track).toBe('inbound');
    expect(result.chunk).toBe('base64audiochunk==');
    expect(result.timestamp).toBe('1234');
  });

  it('falls back to payload if chunk is missing', () => {
    const data = {
      event: 'media',
      media: {
        track: 'inbound',
        payload: 'base64payload==',
        timestamp: '5678',
      },
    };
    const result = parseMediaEvent(data);
    expect(result.chunk).toBe('base64payload==');
  });

  it('uses defaults for missing media fields', () => {
    const data = {
      event: 'media',
      media: {},
    };
    const result = parseMediaEvent(data);
    expect(result.track).toBe('inbound');
    expect(result.chunk).toBe('');
    expect(result.timestamp).toBe('');
  });
});

describe('buildMediaResponse', () => {
  it('builds a valid JSON media response', () => {
    const json = buildMediaResponse('MZ123', 'dGVzdA==');
    const parsed = JSON.parse(json);
    expect(parsed.event).toBe('media');
    expect(parsed.streamSid).toBe('MZ123');
    expect(parsed.media.payload).toBe('dGVzdA==');
  });
});
