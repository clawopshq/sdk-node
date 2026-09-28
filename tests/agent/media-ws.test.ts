import { describe, it, expect, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import {
  parseStartEvent,
  parseMediaEvent,
  buildMediaResponse,
  parseDtmfEvent,
  buildDtmfMessage,
  MediaWebSocket,
  warnIfPlaintext,
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

describe('MediaWebSocket.connect (clawops#1250)', () => {
  it('does not send the account API key as an Authorization header', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const seen = new Promise<Record<string, string | string[] | undefined>>((resolve) => {
      wss.on('connection', (_sock, req) => resolve(req.headers));
    });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const { port } = wss.address() as AddressInfo;

    const media = new MediaWebSocket();
    await media.connect(
      `ws://127.0.0.1:${port}/v1/agent/media/CA1?token=t`,
      'sk_live_should_not_be_sent',
    );
    const headers = await seen;

    expect(headers['authorization']).toBeUndefined();
    await media.close();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});

describe('warnIfPlaintext', () => {
  it('warns for ws:// to a public host without leaking the token', () => {
    const warn = vi.fn();
    warnIfPlaintext('ws://api.claw-ops.com/v1/agent/media/CA1?token=secret', { warn } as never);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('stays quiet for wss:// and loopback ws://', () => {
    const warn = vi.fn();
    warnIfPlaintext('wss://api.claw-ops.com/v1/agent/media/CA1?token=t', { warn } as never);
    warnIfPlaintext('ws://127.0.0.1:3100/v1/agent/media/CA1?token=t', { warn } as never);
    warnIfPlaintext('ws://localhost:3100/v1/agent/media/CA1?token=t', { warn } as never);
    expect(warn).not.toHaveBeenCalled();
  });
});
