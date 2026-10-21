import { describe, it, expect, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
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
    const info = vi.fn();
    media.setLogger({ info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never);
    try {
      await media.connect(
        `ws://127.0.0.1:${port}/v1/agent/media/CA1?token=secret_token`,
        'sk_live_should_not_be_sent',
      );
      const headers = await seen;

      expect(headers['authorization']).toBeUndefined();
      expect(info).toHaveBeenCalled();
      expect(JSON.stringify(info.mock.calls)).not.toContain('secret_token');
    } finally {
      media.close();
      await new Promise<void>((r) => wss.close(() => r()));
    }
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

describe('explicit media format negotiation', () => {
  it.each([true, false])('revalidates PCM on the same object after reconnect, matching=%s', async (matching) => {
    const { MediaProfile, mediaContract } = await import('../../src/agent/media-profile.js');
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new MediaWebSocket({ expectedMediaProfile: MediaProfile.PCM_S16LE_16000 });
    const start = vi.fn(); client.onStart(start);
    const sendStart = (peer: import('ws').WebSocket, profile: Parameters<typeof mediaContract>[0]) => {
      const format = mediaContract(profile);
      peer.send(JSON.stringify({ event: 'start', start: { mediaFormat: {
        encoding: format.encoding, sampleRate: format.sampleRate, channels: 1,
      } } }));
    };
    try {
      let connected = once(server, 'connection');
      await client.connect(url);
      const [first] = await connected;
      sendStart(first, MediaProfile.PCM_S16LE_16000);
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      const closed = once(first, 'close'); client.close(); await closed;

      const audio = Buffer.alloc(640, 7).toString('base64');
      client.sendAudio(audio);
      connected = once(server, 'connection');
      await client.connect(url);
      const [second] = await connected;
      const received: { media?: { payload?: string } }[] = [];
      second.on('message', (bytes: Buffer) => received.push(JSON.parse(bytes.toString())));
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(received).toEqual([]);
      sendStart(second, matching ? MediaProfile.PCM_S16LE_16000 : MediaProfile.MULAW_8000);
      if (matching) {
        await vi.waitFor(() => expect(received).toHaveLength(1));
        expect(received[0]?.media?.payload).toBe(audio);
        expect(start).toHaveBeenCalledTimes(2);
      } else {
        await vi.waitFor(() => expect(client.isConnected).toBe(false));
        expect(received).toEqual([]);
        expect(start).toHaveBeenCalledTimes(1);
      }
    } finally {
      client.close(); server.clients.forEach(ws => ws.terminate());
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('keeps legacy 8kHz immediate sending unchanged across reconnects', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const client = new MediaWebSocket();
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const audio = Buffer.alloc(160, 0xff).toString('base64');
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const connected = once(server, 'connection');
        await client.connect(url);
        const [peer] = await connected;
        const received = once(peer, 'message');
        client.sendAudio(audio);
        const [raw] = await received;
        expect(JSON.parse(raw.toString()).media.payload).toBe(audio);
        const closed = once(peer, 'close'); client.close(); await closed;
      }
    } finally {
      client.close(); server.clients.forEach(ws => ws.terminate());
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each([true, false])('gates queued PCM before matching start=%s', async (matching) => {
    const { MediaProfile, mediaContract } = await import('../../src/agent/media-profile.js');
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const received: unknown[] = [];
    let peer: import('ws').WebSocket;
    const connected = new Promise<void>(resolve => server.once('connection', ws => {
      peer = ws;
      ws.on('message', bytes => received.push(JSON.parse(bytes.toString())));
      resolve();
    }));
    const client = new MediaWebSocket({ expectedMediaProfile: MediaProfile.PCM_S16LE_16000 });
    const start = vi.fn(); client.onStart(start);
    try {
      client.sendAudio(Buffer.alloc(640).toString('base64'));
      await client.connect(`ws://127.0.0.1:${port}`);
      await connected;
      await new Promise(r => setTimeout(r, 30));
      expect(received).toEqual([]);
      const format = mediaContract(matching ? MediaProfile.PCM_S16LE_16000 : MediaProfile.MULAW_8000);
      peer!.send(JSON.stringify({ event: 'start', start: { mediaFormat: { encoding: format.encoding, sampleRate: format.sampleRate, channels: 1 } } }));
      await new Promise(r => setTimeout(r, 50));
      expect(start).toHaveBeenCalledTimes(matching ? 1 : 0);
      expect(received).toHaveLength(matching ? 1 : 0);
      if (!matching) expect(client.isConnected).toBe(false);
    } finally {
      client.close(); server.clients.forEach(ws => ws.terminate());
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
