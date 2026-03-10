# Agent Framework Tests Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port all 95 Python Agent tests to Node.js/TypeScript (vitest), achieving test parity with the Python SDK.

**Architecture:** Each test file mirrors Python's `tests/agent/` structure, adapted for TypeScript/vitest. Uses `vi.mock()` and `vi.fn()` instead of `unittest.mock.patch`. All async tests use native async/await. Provider tests use `describe.each()` for parametrization.

**Tech Stack:** vitest, vi.mock/vi.fn, TypeScript, zod

---

## File Structure

```
tests/
├── agent/
│   ├── audio.test.ts              # 7 tests — ulaw/PCM16 codec, resampling
│   ├── tool.test.ts               # 10 tests — ToolRegistry, MCP tools, schema
│   ├── session.test.ts            # 3 tests — CallSession lifecycle, events
│   ├── control-ws.test.ts         # 2 tests — URL building (https→wss, http→ws)
│   ├── media-ws.test.ts           # 3 tests — parse/build media messages
│   ├── agent.test.ts              # 6 tests — ClawOpsAgent init, tool/event reg
│   ├── recorder.test.ts           # 5 tests — WAV header, file I/O
│   ├── pipeline-base.test.ts      # 2 tests — STT/TTS protocol compliance
│   ├── openai-llm.test.ts         # 3 tests — OpenAI LLM mock streaming
│   ├── anthropic-llm.test.ts      # 3 tests — Anthropic LLM mock streaming
│   ├── gemini-llm.test.ts         # 3 tests — Gemini LLM mock streaming
│   ├── openai-compat-llms.test.ts # 32 tests — 8 providers × 4 tests each
│   ├── deepgram-stt.test.ts       # 2 tests — DeepgramSTT protocol + mock
│   ├── elevenlabs-tts.test.ts     # 3 tests — ElevenLabsTTS protocol + mock
│   ├── pipeline-session.test.ts   # 2 tests — start/stop, audio feed
│   ├── realtime-session.test.ts   # 5 tests — OpenAIRealtime config/defaults
│   ├── gemini-realtime.test.ts    # 3 tests — GeminiRealtime config/defaults
│   ├── session-protocol.test.ts   # 3 tests — Session interface compliance
│   ├── mcp.test.ts                # 2 tests — MCPServerHTTP/Stdio creation
│   ├── mcp-client.test.ts         # 9 tests — MCPClient connect/call/close
│   ├── tracing.test.ts            # 10 tests — TracingConfig, attributes, spans
│   └── integration.test.ts        # 5 tests — full agent setup, imports
├── agent-exceptions.test.ts       # 2 tests — AgentError hierarchy
├── types.test.ts                  # 5 tests — Zod schema validation
└── params.test.ts                 # 5 tests — Param interface structure
```

Total: ~114 new tests across 25 files (some Python tests don't apply to JS, e.g. Sync/Async split, pyproject.toml checks)

---

## Chunk 1: Foundation Tests (audio, session, control-ws, media-ws, exceptions, types, params)

### Task 1: Audio codec tests

**Files:**
- Create: `tests/agent/audio.test.ts`
- Reference: `src/agent/audio.ts`

- [ ] **Step 1: Write audio codec tests**

```typescript
import { describe, it, expect } from 'vitest';
import { ulawToPcm16, pcm16ToUlaw, resamplePcm16, DECODE_TABLE } from '../src/agent/audio.js';

describe('audio codec', () => {
  it('decodes ulaw silence (0xFF) to near-zero PCM16', () => {
    const ulaw = Buffer.alloc(160, 0xff);
    const pcm = ulawToPcm16(ulaw);
    expect(pcm.length).toBe(320);
    const sample = pcm.readInt16LE(0);
    expect(Math.abs(sample)).toBeLessThan(10);
  });

  it('decodes ulaw returning correct length (160 -> 320)', () => {
    const ulaw = Buffer.alloc(160, 0x80);
    const pcm = ulawToPcm16(ulaw);
    expect(pcm.length).toBe(320);
  });

  it('handles empty input', () => {
    const pcm = ulawToPcm16(Buffer.alloc(0));
    expect(pcm.length).toBe(0);
    const ulaw = pcm16ToUlaw(Buffer.alloc(0));
    expect(ulaw.length).toBe(0);
  });

  it('encodes PCM16 silence to ulaw 0xFF', () => {
    const pcm = Buffer.alloc(320, 0);
    const ulaw = pcm16ToUlaw(pcm);
    expect(ulaw.length).toBe(160);
    expect(ulaw[0]).toBe(0xff);
  });

  it('roundtrips ulaw -> PCM16 -> ulaw', () => {
    const original = Buffer.from([0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70]);
    const pcm = ulawToPcm16(original);
    const back = pcm16ToUlaw(pcm);
    for (let i = 0; i < original.length; i++) {
      expect(back[i]).toBe(original[i]);
    }
  });

  it('resamples 8kHz to 16kHz (doubles length)', () => {
    const pcm8k = Buffer.alloc(160 * 2); // 160 samples at 16-bit
    const pcm16k = resamplePcm16(pcm8k, 8000, 16000);
    expect(pcm16k.length).toBe(160 * 2 * 2);
  });

  it('resamples 24kHz to 8kHz (thirds length)', () => {
    const pcm24k = Buffer.alloc(480 * 2); // 480 samples at 16-bit
    const pcm8k = resamplePcm16(pcm24k, 24000, 8000);
    expect(pcm8k.length).toBe(160 * 2);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/agent/audio.test.ts`
Expected: 7 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/agent/audio.test.ts
git commit -m "test: add audio codec tests (ulaw, PCM16, resample)"
```

---

### Task 2: CallSession tests

**Files:**
- Create: `tests/agent/session.test.ts`
- Reference: `src/agent/session.ts`

- [ ] **Step 1: Write session tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { CallSession } from '../src/agent/session.js';

describe('CallSession', () => {
  function makeSession() {
    const sendAudio = vi.fn();
    const clearAudio = vi.fn();
    const hangup = vi.fn();
    const session = new CallSession({
      callId: 'CA123',
      fromNumber: '07012341234',
      toNumber: '01012345678',
      accountId: 'AC123',
      direction: 'inbound',
      sendAudio,
      clearAudio,
      hangup,
    });
    return { session, sendAudio, clearAudio, hangup };
  }

  it('initializes with call metadata', () => {
    const { session } = makeSession();
    expect(session.callId).toBe('CA123');
    expect(session.fromNumber).toBe('07012341234');
    expect(session.toNumber).toBe('01012345678');
    expect(session.accountId).toBe('AC123');
    expect(session.direction).toBe('inbound');
    expect(session.status).toBe('queued');
  });

  it('sends audio via bound transport function', async () => {
    const { session, sendAudio } = makeSession();
    const audio = Buffer.from([1, 2, 3]);
    await session.sendAudio(audio);
    expect(sendAudio).toHaveBeenCalledWith(audio);
  });

  it('emits events and invokes handlers', async () => {
    const { session } = makeSession();
    const handler = vi.fn();
    session.on('call_start', handler);
    session._emit('call_start');
    expect(handler).toHaveBeenCalledWith(session);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/agent/session.test.ts`
Expected: 3 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/agent/session.test.ts
git commit -m "test: add CallSession lifecycle tests"
```

---

### Task 3: Control WebSocket URL tests

**Files:**
- Create: `tests/agent/control-ws.test.ts`
- Reference: `src/agent/control-ws.ts`

- [ ] **Step 1: Write URL building tests**

```typescript
import { describe, it, expect } from 'vitest';
import { buildControlWsUrl } from '../src/agent/control-ws.js';

describe('buildControlWsUrl', () => {
  it('converts HTTPS to WSS', () => {
    const url = buildControlWsUrl('https://api.claw-ops.com', 'AC123', '07012341234');
    expect(url).toMatch(/^wss:\/\//);
    expect(url).toContain('AC123');
    expect(url).toContain('07012341234');
  });

  it('converts HTTP to WS', () => {
    const url = buildControlWsUrl('http://localhost:8080', 'AC123', '07012341234');
    expect(url).toMatch(/^ws:\/\//);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/agent/control-ws.test.ts`
Expected: 2 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/agent/control-ws.test.ts
git commit -m "test: add control WebSocket URL building tests"
```

---

### Task 4: Media WebSocket message tests

**Files:**
- Create: `tests/agent/media-ws.test.ts`
- Reference: `src/agent/media-ws.ts`

- [ ] **Step 1: Write media message tests**

```typescript
import { describe, it, expect } from 'vitest';
import { parseStartEvent, parseMediaEvent, buildMediaResponse } from '../src/agent/media-ws.js';

describe('media-ws', () => {
  it('parses start event', () => {
    const msg = {
      event: 'start',
      sequenceNumber: '1',
      start: {
        streamId: 'MZ123',
        callId: 'CA123',
        accountId: 'AC123',
        tracks: ['inbound'],
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        customParameters: {},
      },
    };
    const result = parseStartEvent(msg);
    expect(result.callId).toBe('CA123');
    expect(result.streamId).toBe('MZ123');
  });

  it('parses media event with base64 payload', () => {
    const payload = Buffer.from([0xff, 0x7f, 0x00]).toString('base64');
    const msg = {
      event: 'media',
      media: { track: 'inbound', chunk: '1', timestamp: '5', payload },
    };
    const result = parseMediaEvent(msg);
    expect(result.length).toBe(3);
    expect(result[0]).toBe(0xff);
  });

  it('builds media response message', () => {
    const audio = Buffer.from([0xff, 0x7f]);
    const msg = buildMediaResponse(audio);
    expect(msg.event).toBe('media');
    expect(msg.media.payload).toBe(audio.toString('base64'));
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/agent/media-ws.test.ts`
Expected: 3 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/agent/media-ws.test.ts
git commit -m "test: add media WebSocket message parsing tests"
```

---

### Task 5: Agent exception hierarchy tests

**Files:**
- Create: `tests/agent-exceptions.test.ts`
- Reference: `src/error.ts`

- [ ] **Step 1: Write exception hierarchy tests**

```typescript
import { describe, it, expect } from 'vitest';
import { AgentError, AgentConnectionError, ClawOpsError } from '../src/error.js';

describe('Agent exceptions', () => {
  it('AgentError is instance of ClawOpsError', () => {
    const err = new AgentError('test');
    expect(err).toBeInstanceOf(ClawOpsError);
    expect(err).toBeInstanceOf(AgentError);
  });

  it('AgentConnectionError is instance of AgentError', () => {
    const err = new AgentConnectionError('ws failed');
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toBeInstanceOf(ClawOpsError);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/agent-exceptions.test.ts`
Expected: 2 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/agent-exceptions.test.ts
git commit -m "test: add agent exception hierarchy tests"
```

---

### Task 6: Zod types validation tests

**Files:**
- Create: `tests/types.test.ts`
- Reference: `src/types/*.ts`

- [ ] **Step 1: Write type validation tests**

```typescript
import { describe, it, expect } from 'vitest';
import { CallSchema, CallControlResponseSchema } from '../src/types/call.js';
import { PhoneNumberSchema } from '../src/types/number.js';
import { PaginationMetaSchema } from '../src/types/shared.js';

describe('Zod type schemas', () => {
  it('parses Call from API response', () => {
    const data = {
      callId: 'CA123',
      accountId: 'AC123',
      to: '01012345678',
      from: '07012341234',
      status: 'completed',
      direction: 'outbound',
      dateCreated: '2026-01-01T00:00:00Z',
      dateUpdated: '2026-01-01T00:01:00Z',
    };
    const call = CallSchema.parse(data);
    expect(call.callId).toBe('CA123');
    expect(call.status).toBe('completed');
  });

  it('parses CallControlResponse', () => {
    const data = { callId: 'CA123', status: 'completed', message: 'ok' };
    const res = CallControlResponseSchema.parse(data);
    expect(res.callId).toBe('CA123');
  });

  it('parses PhoneNumber from API', () => {
    const data = {
      phoneNumber: '07012340001',
      accountId: 'AC123',
      dateCreated: '2026-01-01T00:00:00Z',
      dateUpdated: '2026-01-01T00:00:00Z',
    };
    const num = PhoneNumberSchema.parse(data);
    expect(num.phoneNumber).toBe('07012340001');
  });

  it('allows extra fields (passthrough)', () => {
    const data = {
      callId: 'CA123', accountId: 'AC123', to: '010', from: '070',
      status: 'queued', direction: 'inbound',
      dateCreated: '2026-01-01T00:00:00Z', dateUpdated: '2026-01-01T00:00:00Z',
      unknownField: 'extra',
    };
    const call = CallSchema.parse(data);
    expect((call as any).unknownField).toBe('extra');
  });

  it('parses PaginationMeta', () => {
    const data = { total: 100, page: 0, pageSize: 20 };
    const meta = PaginationMetaSchema.parse(data);
    expect(meta.total).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/types.test.ts`
Expected: 5 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/types.test.ts
git commit -m "test: add Zod schema validation tests"
```

---

### Task 7: Param interface tests

**Files:**
- Create: `tests/params.test.ts`
- Reference: `src/types/*-params.ts`

- [ ] **Step 1: Write param structure tests**

```typescript
import { describe, it, expect } from 'vitest';
import type { CallCreateParams, CallListParams, CallUpdateParams } from '../src/types/call-params.js';
import type { NumberCreateParams, NumberUpdateParams } from '../src/types/number-params.js';

describe('Param interfaces', () => {
  it('CallCreateParams has required fields', () => {
    const params: CallCreateParams = { to: '010', from: '070', url: 'https://...' };
    expect(params.to).toBe('010');
    expect(params.from).toBe('070');
    expect(params.url).toBe('https://...');
  });

  it('CallListParams accepts optional filters', () => {
    const params: CallListParams = { status: 'completed', page: 0, pageSize: 20 };
    expect(params.status).toBe('completed');
  });

  it('CallUpdateParams accepts status', () => {
    const params: CallUpdateParams = { status: 'completed' };
    expect(params.status).toBe('completed');
  });

  it('NumberCreateParams accepts source', () => {
    const params: NumberCreateParams = { source: 'pool' };
    expect(params.source).toBe('pool');
  });

  it('NumberUpdateParams accepts webhookUrl', () => {
    const params: NumberUpdateParams = { webhookUrl: 'https://...' };
    expect(params.webhookUrl).toBe('https://...');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/params.test.ts`
Expected: 5 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/params.test.ts
git commit -m "test: add param interface structure tests"
```

---

## Chunk 2: Tool, Recorder, Agent Tests

### Task 8: ToolRegistry tests

**Files:**
- Create: `tests/agent/tool.test.ts`
- Reference: `src/agent/tool.ts`

- [ ] **Step 1: Write ToolRegistry tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry, functionTool } from '../src/agent/tool.js';

describe('ToolRegistry', () => {
  it('registers a function tool', () => {
    const registry = new ToolRegistry();
    const tool = functionTool('greet', 'Says hello', { name: { type: 'string' } }, async ({ name }) => `Hello ${name}`);
    registry.register(tool);
    const tools = registry.toOpenAITools();
    expect(tools).toHaveLength(1);
    expect(tools[0].function.name).toBe('greet');
  });

  it('generates correct OpenAI tool schema', () => {
    const registry = new ToolRegistry();
    const tool = functionTool('search', 'Searches', { query: { type: 'string' }, limit: { type: 'number' } }, async () => 'ok');
    registry.register(tool);
    const schema = registry.toOpenAITools()[0];
    expect(schema.type).toBe('function');
    expect(schema.function.parameters.properties).toHaveProperty('query');
    expect(schema.function.parameters.properties).toHaveProperty('limit');
  });

  it('calls a registered tool', async () => {
    const registry = new ToolRegistry();
    const tool = functionTool('add', 'Adds', { a: { type: 'number' }, b: { type: 'number' } }, async ({ a, b }) => String(a + b));
    registry.register(tool);
    const result = await registry.call('add', { a: 1, b: 2 });
    expect(result).toBe('3');
  });

  it('throws on non-existent tool', async () => {
    const registry = new ToolRegistry();
    await expect(registry.call('nope', {})).rejects.toThrow();
  });

  it('registers MCP tools', () => {
    const mockClient = { callTool: vi.fn() };
    const mcpTools = [
      { name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    ];
    const registry = new ToolRegistry();
    registry.registerMcpTools(mcpTools as any, mockClient as any);
    const tools = registry.toOpenAITools();
    expect(tools.some((t: any) => t.function.name === 'web_search')).toBe(true);
  });

  it('throws on tool name conflict', () => {
    const registry = new ToolRegistry();
    const tool = functionTool('dup', 'Dup', {}, async () => 'ok');
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow();
  });

  it('calls MCP tool via registry', async () => {
    const callTool = vi.fn().mockResolvedValue('mcp result');
    const mockClient = { callTool };
    const mcpTools = [
      { name: 'mcp_fn', description: 'MCP function', inputSchema: { type: 'object', properties: {} } },
    ];
    const registry = new ToolRegistry();
    registry.registerMcpTools(mcpTools as any, mockClient as any);
    const result = await registry.call('mcp_fn', {});
    expect(callTool).toHaveBeenCalledWith('mcp_fn', {});
  });

  it('clears MCP tools', () => {
    const mockClient = { callTool: vi.fn() };
    const mcpTools = [
      { name: 'temp', description: 'Temp', inputSchema: { type: 'object', properties: {} } },
    ];
    const registry = new ToolRegistry();
    registry.registerMcpTools(mcpTools as any, mockClient as any);
    expect(registry.toOpenAITools()).toHaveLength(1);
    registry.clearMcpTools();
    expect(registry.toOpenAITools()).toHaveLength(0);
  });

  it('fork creates independent copy', () => {
    const registry = new ToolRegistry();
    const tool = functionTool('base', 'Base', {}, async () => 'ok');
    registry.register(tool);
    const forked = registry.fork();
    const mcpTools = [
      { name: 'mcp_only', description: 'Only in fork', inputSchema: { type: 'object', properties: {} } },
    ];
    forked.registerMcpTools(mcpTools as any, { callTool: vi.fn() } as any);
    expect(forked.toOpenAITools()).toHaveLength(2);
    expect(registry.toOpenAITools()).toHaveLength(1);
  });

  it('includes both local and MCP tools in schema', () => {
    const registry = new ToolRegistry();
    registry.register(functionTool('local', 'Local', {}, async () => 'ok'));
    registry.registerMcpTools(
      [{ name: 'remote', description: 'Remote', inputSchema: { type: 'object', properties: {} } }] as any,
      { callTool: vi.fn() } as any,
    );
    const tools = registry.toOpenAITools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t: any) => t.function.name).sort()).toEqual(['local', 'remote']);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/agent/tool.test.ts`
Expected: 10 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/agent/tool.test.ts
git commit -m "test: add ToolRegistry tests (register, schema, MCP, fork)"
```

---

### Task 9: AudioRecorder tests

**Files:**
- Create: `tests/agent/recorder.test.ts`
- Reference: `src/agent/recorder.ts`

- [ ] **Step 1: Write recorder tests**

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AudioRecorder } from '../src/agent/recorder.js';

describe('AudioRecorder', () => {
  function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-test-'));
  }

  it('generates valid WAV header', () => {
    const dir = tmpDir();
    const recorder = new AudioRecorder('CA123', dir);
    recorder.writeInbound(Buffer.alloc(320));
    recorder.stop();
    const inFile = path.join(dir, 'CA123_in.wav');
    expect(fs.existsSync(inFile)).toBe(true);
    const header = Buffer.alloc(44);
    const fd = fs.openSync(inFile, 'r');
    fs.readSync(fd, header, 0, 44, 0);
    fs.closeSync(fd);
    expect(header.toString('ascii', 0, 4)).toBe('RIFF');
    expect(header.toString('ascii', 8, 12)).toBe('WAVE');
    fs.rmSync(dir, { recursive: true });
  });

  it('creates files on write', () => {
    const dir = tmpDir();
    const recorder = new AudioRecorder('CA123', dir);
    recorder.writeInbound(Buffer.alloc(320));
    recorder.stop();
    expect(fs.existsSync(path.join(dir, 'CA123_in.wav'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'CA123_mix.wav'))).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });

  it('accumulates multiple inbound chunks', () => {
    const dir = tmpDir();
    const recorder = new AudioRecorder('CA123', dir);
    recorder.writeInbound(Buffer.alloc(320));
    recorder.writeInbound(Buffer.alloc(320));
    recorder.stop();
    const stat = fs.statSync(path.join(dir, 'CA123_in.wav'));
    expect(stat.size).toBe(44 + 640); // WAV header + 2 chunks
    fs.rmSync(dir, { recursive: true });
  });

  it('updates WAV header data size on stop', () => {
    const dir = tmpDir();
    const recorder = new AudioRecorder('CA123', dir);
    recorder.writeInbound(Buffer.alloc(160));
    recorder.stop();
    const buf = fs.readFileSync(path.join(dir, 'CA123_in.wav'));
    const dataSize = buf.readUInt32LE(40);
    expect(dataSize).toBe(160);
    fs.rmSync(dir, { recursive: true });
  });

  it('does nothing before first write', () => {
    const dir = tmpDir();
    const recorder = new AudioRecorder('CA_NONE', dir);
    recorder.stop();
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(0);
    fs.rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/agent/recorder.test.ts`
Expected: 5 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/agent/recorder.test.ts
git commit -m "test: add AudioRecorder WAV header and file I/O tests"
```

---

### Task 10: ClawOpsAgent tests

**Files:**
- Create: `tests/agent/agent.test.ts`
- Reference: `src/agent/agent.ts`

- [ ] **Step 1: Write agent tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ClawOpsAgent, OpenAIRealtime } from '../src/agent/index.js';
import { AgentError } from '../src/error.js';

// Mock OpenAI Realtime to avoid requiring openai package
vi.mock('../src/agent/pipeline/openai-realtime.js', () => ({
  OpenAIRealtime: class {
    constructor(public options: any = {}) {}
    async start() {}
    async stop() {}
  },
}));

describe('ClawOpsAgent', () => {
  function makeSession() {
    return new OpenAIRealtime({ systemPrompt: 'test' });
  }

  it('initializes with api key, account id, and session', () => {
    const agent = new ClawOpsAgent({
      from: '07012341234',
      session: makeSession(),
      apiKey: 'sk_test',
      accountId: 'AC123',
    });
    expect(agent).toBeDefined();
  });

  it('registers tools via agent.tool()', () => {
    const agent = new ClawOpsAgent({
      from: '07012341234',
      session: makeSession(),
      apiKey: 'sk_test',
      accountId: 'AC123',
    });
    agent.tool('greet', 'Says hello', { name: { type: 'string' } }, async ({ name }) => `Hi ${name}`);
    // No assertion needed — just verify no error thrown
  });

  it('registers event handlers via agent.on()', () => {
    const agent = new ClawOpsAgent({
      from: '07012341234',
      session: makeSession(),
      apiKey: 'sk_test',
      accountId: 'AC123',
    });
    const handler = vi.fn();
    agent.on('call_start', handler);
    // No assertion needed — just verify no error thrown
  });

  it('reads credentials from environment variables', () => {
    const origKey = process.env['CLAWOPS_API_KEY'];
    const origAcct = process.env['CLAWOPS_ACCOUNT_ID'];
    process.env['CLAWOPS_API_KEY'] = 'sk_env';
    process.env['CLAWOPS_ACCOUNT_ID'] = 'AC_env';
    try {
      const agent = new ClawOpsAgent({ from: '07012341234', session: makeSession() });
      expect(agent).toBeDefined();
    } finally {
      if (origKey) process.env['CLAWOPS_API_KEY'] = origKey; else delete process.env['CLAWOPS_API_KEY'];
      if (origAcct) process.env['CLAWOPS_ACCOUNT_ID'] = origAcct; else delete process.env['CLAWOPS_ACCOUNT_ID'];
    }
  });

  it('throws AgentError when api_key missing', () => {
    const origKey = process.env['CLAWOPS_API_KEY'];
    delete process.env['CLAWOPS_API_KEY'];
    try {
      expect(() => new ClawOpsAgent({ from: '070', session: makeSession(), accountId: 'AC123' })).toThrow(AgentError);
    } finally {
      if (origKey) process.env['CLAWOPS_API_KEY'] = origKey;
    }
  });

  it('throws when session is missing', () => {
    expect(() => new ClawOpsAgent({ from: '070', apiKey: 'sk', accountId: 'AC123' } as any)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/agent/agent.test.ts`
Expected: 6 tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/agent/agent.test.ts
git commit -m "test: add ClawOpsAgent initialization tests"
```

---

## Chunk 3: Pipeline Provider Tests (LLM, STT, TTS, Realtime)

### Task 11: Pipeline base protocol tests

**Files:**
- Create: `tests/agent/pipeline-base.test.ts`
- Reference: `src/agent/pipeline/base.ts`

- [ ] **Step 1: Write protocol compliance tests**

```typescript
import { describe, it, expect } from 'vitest';
import type { STT, TTS, SpeechEvent, LLMChunk } from '../src/agent/pipeline/base.js';

describe('pipeline base protocols', () => {
  it('STT protocol works with custom implementation', async () => {
    const stt: STT = {
      async *transcribe(audioStream: AsyncIterable<Buffer>): AsyncGenerator<SpeechEvent> {
        for await (const _ of audioStream) {
          yield { type: 'final', transcript: 'hello' };
        }
      },
    };
    async function* fakeAudio() { yield Buffer.alloc(320); }
    const events: SpeechEvent[] = [];
    for await (const e of stt.transcribe(fakeAudio())) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    expect(events[0].transcript).toBe('hello');
  });

  it('TTS protocol works with custom implementation', async () => {
    const tts: TTS = {
      get sampleRate() { return 24000; },
      async *synthesize(textStream: AsyncIterable<string>): AsyncGenerator<Buffer> {
        for await (const text of textStream) {
          yield Buffer.from(text);
        }
      },
    };
    async function* fakeText() { yield '안녕'; }
    const chunks: Buffer[] = [];
    for await (const c of tts.synthesize(fakeText())) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(1);
    expect(tts.sampleRate).toBe(24000);
  });
});
```

- [ ] **Step 2: Run test, commit**

Run: `npx vitest run tests/agent/pipeline-base.test.ts`

```bash
git add tests/agent/pipeline-base.test.ts
git commit -m "test: add pipeline STT/TTS protocol compliance tests"
```

---

### Task 12: OpenAI LLM tests

**Files:**
- Create: `tests/agent/openai-llm.test.ts`
- Reference: `src/agent/pipeline/openai-llm.ts`

- [ ] **Step 1: Write OpenAI LLM tests with mock**

Test the OpenAILLM class by mocking the `openai` module. Verify:
1. Implements LLM interface (has `generate` async generator method)
2. Streams text chunks correctly
3. Handles tool call chunks and emits tool_calls LLMChunk

The mock should simulate OpenAI's streaming response with choice deltas.

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/openai-llm.test.ts
git commit -m "test: add OpenAI LLM streaming tests"
```

---

### Task 13: Anthropic LLM tests

**Files:**
- Create: `tests/agent/anthropic-llm.test.ts`
- Reference: `src/agent/pipeline/anthropic-llm.ts`

- [ ] **Step 1: Write Anthropic LLM tests with mock**

Same pattern as OpenAI but mock `@anthropic-ai/sdk`. Test content_block_delta events for text and tool_use.

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/anthropic-llm.test.ts
git commit -m "test: add Anthropic LLM streaming tests"
```

---

### Task 14: Gemini LLM tests

**Files:**
- Create: `tests/agent/gemini-llm.test.ts`
- Reference: `src/agent/pipeline/gemini-llm.ts`

- [ ] **Step 1: Write Gemini LLM tests with mock**

Mock `@google/genai`. Test text part iteration and function_call parsing.

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/gemini-llm.test.ts
git commit -m "test: add Gemini LLM streaming tests"
```

---

### Task 15: OpenAI-compatible LLM providers tests (8 providers × 4 tests)

**Files:**
- Create: `tests/agent/openai-compat-llms.test.ts`
- Reference: `src/agent/pipeline/openai-compat-llm.ts`, `*-llm.ts` (7 providers)

- [ ] **Step 1: Write parametrized tests for all 8 providers**

Use `describe.each()` to test OllamaLLM, MistralLLM, GroqLLM, PerplexityLLM, TogetherLLM, FireworksLLM, DeepSeekLLM, XaiLLM. Each provider gets 4 tests:
1. Implements LLM interface (has `generate` method)
2. Correct base URL and API key environment variable
3. Text generation streaming
4. Tool call generation

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/openai-compat-llms.test.ts
git commit -m "test: add OpenAI-compat LLM provider tests (8 providers)"
```

---

### Task 16: Deepgram STT tests

**Files:**
- Create: `tests/agent/deepgram-stt.test.ts`
- Reference: `src/agent/pipeline/deepgram-stt.ts`

- [ ] **Step 1: Write Deepgram STT tests**

1. Protocol compliance (implements STT interface)
2. Mock WebSocket transcription flow with SpeechEvent generation

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/deepgram-stt.test.ts
git commit -m "test: add Deepgram STT tests"
```

---

### Task 17: ElevenLabs TTS tests

**Files:**
- Create: `tests/agent/elevenlabs-tts.test.ts`
- Reference: `src/agent/pipeline/elevenlabs-tts.ts`

- [ ] **Step 1: Write ElevenLabs TTS tests**

1. Protocol compliance (implements TTS interface)
2. Sample rate extraction from output format (`pcm_24000` → 24000)
3. Mock WebSocket synthesis flow

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/elevenlabs-tts.test.ts
git commit -m "test: add ElevenLabs TTS tests"
```

---

### Task 18: PipelineSession tests

**Files:**
- Create: `tests/agent/pipeline-session.test.ts`
- Reference: `src/agent/pipeline/pipeline-session.ts`

- [ ] **Step 1: Write PipelineSession tests**

1. Start/stop lifecycle (verifies session can be started and stopped)
2. Audio feed (verifies audio queuing during active session)

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/pipeline-session.test.ts
git commit -m "test: add PipelineSession lifecycle tests"
```

---

### Task 19: OpenAI Realtime session tests

**Files:**
- Create: `tests/agent/realtime-session.test.ts`
- Reference: `src/agent/pipeline/openai-realtime.ts`

- [ ] **Step 1: Write OpenAI Realtime tests**

1. Default config values (voice, model, language)
2. Custom config override
3. Initialization with custom parameters
4. Default values match config
5. Session object is constructable

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/realtime-session.test.ts
git commit -m "test: add OpenAI Realtime session config tests"
```

---

### Task 20: Gemini Realtime session tests

**Files:**
- Create: `tests/agent/gemini-realtime.test.ts`
- Reference: `src/agent/pipeline/gemini-realtime.ts`

- [ ] **Step 1: Write Gemini Realtime tests**

1. Initialization with custom parameters
2. Default model, voice, language
3. Tool schema includes hang_up

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/gemini-realtime.test.ts
git commit -m "test: add Gemini Realtime session tests"
```

---

### Task 21: Session protocol compliance tests

**Files:**
- Create: `tests/agent/session-protocol.test.ts`
- Reference: `src/agent/pipeline/base.ts`

- [ ] **Step 1: Write session protocol tests**

Verify OpenAIRealtime, GeminiRealtime, and PipelineSession all implement the Session interface (have `start` and `stop` methods).

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/session-protocol.test.ts
git commit -m "test: add Session protocol compliance tests"
```

---

## Chunk 4: MCP, Tracing, Integration Tests

### Task 22: MCP server config tests

**Files:**
- Create: `tests/agent/mcp.test.ts`
- Reference: `src/agent/mcp/stdio.ts`, `src/agent/mcp/http.ts`

- [ ] **Step 1: Write MCP config tests**

```typescript
import { describe, it, expect } from 'vitest';
import { mcpServerStdio, mcpServerHTTP } from '../src/agent/mcp/index.js';

describe('MCP server config', () => {
  it('MCPServerHTTP stores URL', () => {
    const config = mcpServerHTTP('https://mcp.example.com', { headers: { Authorization: 'Bearer tok' } });
    expect(config.url).toBe('https://mcp.example.com');
    expect(config.type).toBe('http');
  });

  it('MCPServerStdio stores command', () => {
    const config = mcpServerStdio('npx', { args: ['@mcp/server'] });
    expect(config.command).toBe('npx');
    expect(config.type).toBe('stdio');
  });
});
```

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/mcp.test.ts
git commit -m "test: add MCP server config tests"
```

---

### Task 23: MCPClient tests

**Files:**
- Create: `tests/agent/mcp-client.test.ts`
- Reference: `src/agent/mcp/client.ts`

- [ ] **Step 1: Write MCPClient tests**

Test MCPClient with mocked `@modelcontextprotocol/sdk`:
1. Init with stdio server config
2. Init with HTTP server config
3. Connect discovers tools (stdio)
4. Connect discovers tools (HTTP)
5. Connect lists multiple tools
6. Call tool returns result
7. Call tool error result
8. Close cleans up
9. Close without connect is safe

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/mcp-client.test.ts
git commit -m "test: add MCPClient connect/call/close tests"
```

---

### Task 24: Tracing tests

**Files:**
- Create: `tests/agent/tracing.test.ts`
- Reference: `src/agent/tracing/config.ts`, `src/agent/tracing/attributes.ts`, `src/agent/tracing/spans.ts`

- [ ] **Step 1: Write tracing tests**

1. TracingConfig default values (enabled=true, serviceName='clawops-agent')
2. TracingConfig custom values
3. Call attributes exist (CALL_ID, CALL_FROM, CALL_TO, CALL_DURATION_MS)
4. GenAI attributes exist (GEN_AI_SYSTEM, GEN_AI_REQUEST_MODEL)
5. MCP attributes exist (MCP_SERVER_TYPE, MCP_TOOLS_COUNT)
6. Tool attributes exist (TOOL_NAME, TOOL_SOURCE)
7. Span functions are no-op without OpenTelemetry
8. startSpan creates callable span
9. setTracingConfig / getTracingConfig / resetTracingConfig work
10. Multiple span helper functions exist

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/tracing.test.ts
git commit -m "test: add tracing config, attributes, and span tests"
```

---

### Task 25: Integration tests

**Files:**
- Create: `tests/agent/integration.test.ts`
- Reference: `src/agent/index.ts`

- [ ] **Step 1: Write integration tests**

```typescript
import { describe, it, expect, vi } from 'vitest';

// Mock openai to avoid requiring the package
vi.mock('../src/agent/pipeline/openai-realtime.js', () => ({
  OpenAIRealtime: class {
    constructor(public options: any = {}) {}
    async start() {}
    async stop() {}
  },
}));

describe('Agent integration', () => {
  it('full agent setup with tools and events', async () => {
    const { ClawOpsAgent, OpenAIRealtime } = await import('../src/agent/index.js');
    const agent = new ClawOpsAgent({
      from: '07012341234',
      session: new OpenAIRealtime({ systemPrompt: 'test' }),
      apiKey: 'sk_test',
      accountId: 'AC123',
    });
    agent.tool('check', 'Check order', { id: { type: 'string' } }, async ({ id }) => `OK ${id}`);
    agent.on('call_start', async () => {});
    expect(agent).toBeDefined();
  });

  it('tool execution integration', async () => {
    const { ToolRegistry, functionTool } = await import('../src/agent/index.js');
    const registry = new ToolRegistry();
    const tool = functionTool('add', 'Adds numbers', { a: { type: 'number' }, b: { type: 'number' } }, async ({ a, b }) => String(a + b));
    registry.register(tool);
    const schema = registry.toOpenAITools();
    expect(schema[0].function.name).toBe('add');
    const result = await registry.call('add', { a: 5, b: 3 });
    expect(result).toBe('8');
  });

  it('CallSession lifecycle', async () => {
    const { CallSession } = await import('../src/agent/index.js');
    const session = new CallSession({
      callId: 'CA_INT',
      fromNumber: '070',
      toNumber: '010',
      accountId: 'AC',
      direction: 'inbound',
      sendAudio: vi.fn(),
      clearAudio: vi.fn(),
      hangup: vi.fn(),
    });
    expect(session.callId).toBe('CA_INT');
    expect(session.direction).toBe('inbound');
    expect(session.duration).toBeGreaterThanOrEqual(0);
  });

  it('agent with MCP servers config', async () => {
    const { ClawOpsAgent, OpenAIRealtime, mcpServerStdio } = await import('../src/agent/index.js');
    const agent = new ClawOpsAgent({
      from: '07012341234',
      session: new OpenAIRealtime({ systemPrompt: 'test' }),
      apiKey: 'sk_test',
      accountId: 'AC123',
      mcpServers: [mcpServerStdio('npx', { args: ['@mcp/server'] })],
    });
    expect(agent).toBeDefined();
  });

  it('all public imports are accessible', async () => {
    const agent = await import('../src/agent/index.js');
    expect(agent.ClawOpsAgent).toBeDefined();
    expect(agent.OpenAIRealtime).toBeDefined();
    expect(agent.GeminiRealtime).toBeDefined();
    expect(agent.PipelineSession).toBeDefined();
    expect(agent.DeepgramSTT).toBeDefined();
    expect(agent.ElevenLabsTTS).toBeDefined();
    expect(agent.OpenAILLM).toBeDefined();
    expect(agent.AnthropicLLM).toBeDefined();
    expect(agent.GeminiLLM).toBeDefined();
    expect(agent.OllamaLLM).toBeDefined();
    expect(agent.MistralLLM).toBeDefined();
    expect(agent.GroqLLM).toBeDefined();
    expect(agent.PerplexityLLM).toBeDefined();
    expect(agent.TogetherLLM).toBeDefined();
    expect(agent.FireworksLLM).toBeDefined();
    expect(agent.DeepSeekLLM).toBeDefined();
    expect(agent.XaiLLM).toBeDefined();
    expect(agent.CallSession).toBeDefined();
    expect(agent.ToolRegistry).toBeDefined();
    expect(agent.AudioRecorder).toBeDefined();
    expect(agent.MCPClient).toBeDefined();
    expect(agent.pcm16ToUlaw).toBeDefined();
    expect(agent.ulawToPcm16).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test, commit**

```bash
git add tests/agent/integration.test.ts
git commit -m "test: add agent integration tests"
```

---

### Task 26: Final verification

- [ ] **Step 1: Run all tests**

```bash
npx vitest run
```

Expected: All tests pass (~260+ total)

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: Commit and push**

```bash
git add -A
git commit -m "test: complete agent test suite (parity with Python SDK)"
git push
```
