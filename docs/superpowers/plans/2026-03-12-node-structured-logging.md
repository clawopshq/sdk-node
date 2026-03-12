# Node.js SDK Structured Logging Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all console.log/console.error with pino-based structured logging, matching Python SDK's logger hierarchy and messages.

**Architecture:** Create `src/agent/logger.ts` factory module. `ClawOpsAgent` accepts optional `logger` in options, creates default pino instance if not provided. Logger is propagated to all components via existing setter pattern. Two logger levels: `agentLogger` (core) and `pipelineLogger` (child with `{ module: 'pipeline' }`).

**Tech Stack:** pino ^9.0.0, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-12-node-structured-logging-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/agent/logger.ts` | Create | Logger factory: `createAgentLogger()`, `createPipelineLogger()` |
| `src/agent/agent.ts` | Modify | Accept `logger` option, use agentLogger, propagate via `setLogger()` |
| `src/agent/control-ws.ts` | Modify | Accept logger via setter, replace console calls |
| `src/agent/media-ws.ts` | Modify | Accept logger via setter, replace console calls |
| `src/agent/session.ts` | Modify | Accept logger via setter, replace console calls |
| `src/agent/recorder.ts` | Modify | Accept logger via setter, replace console calls |
| `src/agent/mcp/client.ts` | Modify | Accept logger via setter, replace console calls |
| `src/agent/pipeline/base.ts` | Modify | Add `setLogger()` to Session interface |
| `src/agent/pipeline/pipeline-session.ts` | Modify | Use pipelineLogger via setLogger, replace console calls |
| `src/agent/pipeline/deepgram-stt.ts` | Modify | Accept logger in constructor, replace console calls |
| `src/agent/pipeline/elevenlabs-tts.ts` | Modify | Accept logger in constructor, replace console calls |
| `src/agent/pipeline/openai-realtime.ts` | Modify | Use agentLogger via setLogger, replace console calls |
| `src/agent/pipeline/gemini-realtime.ts` | Modify | Use agentLogger via setLogger, replace console calls |
| `src/agent/index.ts` | Modify | Export Logger type |
| `package.json` | Modify | Add pino dependency |

---

## Chunk 1: Foundation (logger module + dependency + exports)

### Task 1: Add pino dependency and create logger module

**Files:**
- Modify: `package.json`
- Create: `src/agent/logger.ts`
- Modify: `src/agent/index.ts`

- [ ] **Step 1: Install pino**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm install pino
```

- [ ] **Step 2: Create logger.ts**

Create `src/agent/logger.ts`:

```typescript
/**
 * Logger factory for the ClawOps agent module.
 *
 * Provides a 2-level hierarchy matching the Python SDK:
 * - clawops.agent        (core: agent, session, control-ws, media-ws, recorder, mcp, realtime)
 * - clawops.agent.pipeline (pipeline: pipeline-session, stt, tts)
 */

import pino from 'pino';
import type { Logger } from 'pino';

const DEFAULT_LOGGER = pino({ name: 'clawops.agent' });

/** A silent logger that discards all output. */
export const NOOP_LOGGER = pino({ level: 'silent' });

/**
 * Create or return an agent-level logger.
 * If no user logger is provided, returns the default pino instance.
 */
export function createAgentLogger(userLogger?: Logger): Logger {
  return userLogger ?? DEFAULT_LOGGER;
}

/**
 * Create a pipeline child logger from a parent agent logger.
 * Adds `{ module: 'pipeline' }` to all log entries.
 */
export function createPipelineLogger(parent: Logger): Logger {
  return parent.child({ module: 'pipeline' });
}

export type { Logger };
```

- [ ] **Step 3: Export Logger type from index.ts**

Add to `src/agent/index.ts`:

```typescript
// Logger
export type { Logger } from './logger.js';
export { createAgentLogger, createPipelineLogger } from './logger.js';
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm run build
```

Expected: BUILD SUCCESS

- [ ] **Step 5: Commit**

```bash
git add src/agent/logger.ts src/agent/index.ts package.json package-lock.json
git commit -m "feat(agent): add pino logger module and export Logger type"
```

---

### Task 2: Add setLogger to Session interface and update base.ts

**Files:**
- Modify: `src/agent/pipeline/base.ts`

- [ ] **Step 1: Add setLogger to Session interface**

In `src/agent/pipeline/base.ts`, add import and method to Session interface:

```typescript
import type { Logger } from 'pino';
```

Add to the `Session` interface after `stop()`:

```typescript
  /** Set the logger instance for this session. */
  setLogger?(logger: Logger): void;
```

- [ ] **Step 2: Verify build**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/agent/pipeline/base.ts
git commit -m "feat(agent): add setLogger to Session interface"
```

---

## Chunk 2: Core agent components (agent, control-ws, media-ws, session, recorder, mcp)

### Task 3: Update ControlWebSocket

**Files:**
- Modify: `src/agent/control-ws.ts`

- [ ] **Step 1: Add logger to ControlWebSocket**

Add import at top:

```typescript
import type { Logger } from 'pino';
import { NOOP_LOGGER } from './logger.js';
```

Add logger field and setter to the class:

```typescript
private _log: Logger = NOOP_LOGGER;

setLogger(logger: Logger): void {
  this._log = logger;
}
```

- [ ] **Step 2: Replace all console calls**

Replace in `_doConnect` (ws.on('open') callback — add connected log):

After `this._connectedResolve = null;` on line 111, add:
```typescript
this._log.info('Control WS connected: %s', this._url);
```

Replace `console.error('[ControlWebSocket] Failed to parse message')` (line 120):
```typescript
this._log.warn('Control WS parse error');
```

Replace `console.error('[ControlWebSocket] Error:', err.message)` (line 131):
```typescript
this._log.warn('Control WS error: %s', err.message);
```

In `_dispatchEvent`, replace both `console.error` (lines 143, 147):
```typescript
this._log.error({ err }, 'Control WS handler error: %s', event.event);
```

In `_scheduleReconnect`, add reconnect scheduling log before setTimeout:
```typescript
this._log.info('Control WS reconnecting in %.1fs...', delay / 1000);
```

Replace `console.error('[ControlWebSocket] Reconnect failed:', err)` (line 160):
```typescript
this._log.warn({ err }, 'Control WS reconnect failed');
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/agent/control-ws.ts
git commit -m "feat(agent): replace console with pino in ControlWebSocket"
```

---

### Task 4: Update MediaWebSocket

**Files:**
- Modify: `src/agent/media-ws.ts`

- [ ] **Step 1: Add logger to MediaWebSocket**

Add imports:

```typescript
import type { Logger } from 'pino';
import { NOOP_LOGGER } from './logger.js';
```

Add field to class:

```typescript
private _log: Logger = NOOP_LOGGER;
```

Add setter method:

```typescript
setLogger(logger: Logger): void {
  this._log = logger;
}
```

- [ ] **Step 2: Replace console calls and add new logs**

In `connect()`, after `resolve()` in ws.on('open') callback, add:
```typescript
this._log.info('Media WS connected: %s', url);
```

Replace `console.error('[MediaWebSocket] Error:', err.message)` (line 163):
```typescript
this._log.error({ err }, 'Media WS error');
```

- [ ] **Step 3: Verify build and commit**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm run build
git add src/agent/media-ws.ts
git commit -m "feat(agent): replace console with pino in MediaWebSocket"
```

---

### Task 5: Update CallSession

**Files:**
- Modify: `src/agent/session.ts`

- [ ] **Step 1: Add logger to CallSession**

Add imports:

```typescript
import type { Logger } from 'pino';
import { NOOP_LOGGER } from './logger.js';
```

Add field:

```typescript
private _log: Logger = NOOP_LOGGER;
```

Add setter:

```typescript
setLogger(logger: Logger): void {
  this._log = logger;
}
```

- [ ] **Step 2: Replace console calls**

Replace both `console.error` in `_emit` (lines 234, 238):
```typescript
this._log.error({ err }, 'CallSession handler error: %s', event);
```

In `collectDtmf()`, after collecting digits (before return), add:
```typescript
const result = collected.join('');
this._log.info('DTMF collected: %s', result);
return result;
```

- [ ] **Step 3: Verify build and commit**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm run build
git add src/agent/session.ts
git commit -m "feat(agent): replace console with pino in CallSession"
```

---

### Task 6: Update AudioRecorder

**Files:**
- Modify: `src/agent/recorder.ts`

- [ ] **Step 1: Add logger to AudioRecorder**

Add imports:

```typescript
import type { Logger } from 'pino';
import { NOOP_LOGGER } from './logger.js';
```

Add field:

```typescript
private _log: Logger = NOOP_LOGGER;
```

Add setter:

```typescript
setLogger(logger: Logger): void {
  this._log = logger;
}
```

- [ ] **Step 2: Replace console calls and add new logs**

In `start()`, after `this._started = true;` (line 71), add:
```typescript
this._log.info('Recording started: %s', this._dir);
```

Replace `console.error('Error writing inbound audio:', err)` (line 132):
```typescript
this._log.error({ err }, 'Recording write error (inbound)');
```

Replace `console.error('Error writing outbound audio:', err)` (line 146):
```typescript
this._log.error({ err }, 'Recording write error (outbound)');
```

In `stop()`, before the finally block (after WAV finalization), add:
```typescript
const maxSec = maxWritten / BYTES_PER_SECOND;
this._log.info('Recording stopped: %s (%.1fs)', this._dir, maxSec);
```

Replace `console.error('Error stopping recorder:', err)` (line 171):
```typescript
this._log.error({ err }, 'Recording stop error');
```

- [ ] **Step 3: Verify build and commit**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm run build
git add src/agent/recorder.ts
git commit -m "feat(agent): replace console with pino in AudioRecorder"
```

---

### Task 7: Update MCPClient

**Files:**
- Modify: `src/agent/mcp/client.ts`

- [ ] **Step 1: Add logger to MCPClient**

Add imports:

```typescript
import type { Logger } from 'pino';
import { NOOP_LOGGER } from '../logger.js';
```

Add field and setter:

```typescript
private _log: Logger = NOOP_LOGGER;

setLogger(logger: Logger): void {
  this._log = logger;
}
```

- [ ] **Step 2: Replace console calls and add new logs**

In `connect()`, replace `console.error('[MCPClient] Failed to connect...')` (line 41):
```typescript
this._log.error({ err }, 'MCP connection failed: %s', name);
```

In `disconnect()`, add closing log before each server close:
```typescript
this._log.debug('MCP closing: %s', name);
```

In `disconnect()`, replace `console.error('[MCPClient] Error disconnecting...')` (line 57):
```typescript
this._log.error({ err }, 'MCP disconnect error: %s', name);
```

In `_connectServer()`:

After creating the client (line 71), add transport type logging:
```typescript
if (config.type === 'stdio') {
  this._log.debug('MCP connecting (stdio): %s %s', config['command'], config['args']);
} else if (config.type === 'http') {
  this._log.debug('MCP connecting (http): %s', config['url']);
}
```

After `await client.connect(...)` (line 95), add:
```typescript
// ... (existing listTools code)
```

After the for loop that builds tools (after line 125), before `return tools;`, add:
```typescript
this._log.info('MCP server connected: %d tools found', tools.length);
this._log.debug('MCP tools: %s', tools.map(t => t.name));
```

In each tool's handler function (inside the `handler: async (args)` closure), add call_tool log:
```typescript
handler: async (args: Record<string, unknown>) => {
  this._log.debug('MCP call_tool: %s(%s)', toolDef.name, JSON.stringify(args));
  // ... existing code
```

- [ ] **Step 3: Verify build and commit**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm run build
git add src/agent/mcp/client.ts
git commit -m "feat(agent): replace console with pino in MCPClient"
```

---

### Task 8: Update ClawOpsAgent (main orchestrator)

**Files:**
- Modify: `src/agent/agent.ts`

This is the critical task — the agent creates all components and propagates the logger.

- [ ] **Step 1: Add logger imports and option**

Add imports:

```typescript
import type { Logger } from 'pino';
import { createAgentLogger, createPipelineLogger } from './logger.js';
```

Add `logger` to `ClawOpsAgentOptions`:

```typescript
/** Custom pino logger instance. If omitted, a default logger is created. */
logger?: Logger;
```

Add field to class:

```typescript
private _log: Logger;
private _pipelineLog: Logger;
```

In constructor, after existing initialization:

```typescript
this._log = createAgentLogger(options.logger);
this._pipelineLog = createPipelineLogger(this._log);
```

- [ ] **Step 2: Replace console calls in agent.ts**

Replace `console.log('[ClawOpsAgent] Connected on ...')` (line 175):
```typescript
this._log.info('ClawOpsAgent connected on %s', this._fromNumber);
```

Replace `console.log('[ClawOpsAgent] Disconnected')` (line 209):
```typescript
this._log.info('ClawOpsAgent disconnected');
```

Replace `console.log('[ClawOpsAgent] Outbound call initiated...')` (lines 253-255):
```typescript
this._log.info('Outbound call initiated: %s -> %s (%s)', this._fromNumber, to, callSession.callId);
```

In `_handleIncoming`, add incoming call log (after line 279, before call.accept):
```typescript
this._log.info('Incoming call: %s -> %s (%s)', fromNumber, this._fromNumber, callId);
```

Replace `console.error('[ClawOpsAgent] Error in call session...')` (line 288):
```typescript
this._log.error({ err }, 'Call session error: %s', callId);
```

In `_handleEnded`, add log before marking ended:
```typescript
this._log.info('Call ended (server): %s', callId);
```

In `_handleOutboundReady`, if session is not found in `_activeSessions`:
```typescript
// This case is already handled (session is created), but add warning for truly unknown calls
```

In `_handleFailed`, add log before emitting:
```typescript
this._log.info('Outbound call failed: %s (%s)', callId, (event['reason'] as string) ?? 'failed');
```

In `_startCallSession`, in mediaWs.onAudio callback, add media stream log at start:

After `await mediaWs.connect(...)`, add:
```typescript
this._log.info('Media stream started: %s', session.callId);
```

In `mediaWs.onClose` callback, add:
```typescript
this._log.info('Media stream stopped: %s', session.callId);
```

In `_handleOutboundReady`, replace `console.error` (line 328):
```typescript
this._log.error({ err }, 'Call session error: %s', callId);
```

Add answered log in `_handleOutboundReady` when session exists and mediaUrl present:
```typescript
this._log.info('Outbound call answered: %s -> %s (%s)', this._fromNumber, session.toNumber, callId);
```

Replace `console.log('[ClawOpsAgent] Outbound call ringing...')` (line 337):
```typescript
this._log.info('Outbound call ringing: %s', callId);
```

In `_handleFailed`, add log:
```typescript
this._log.info('Outbound call failed: %s (%s)', callId, (event['reason'] as string) ?? 'failed');
```

Replace `console.error('[ClawOpsAgent] feedDtmf error:', err)` (line 376):
```typescript
this._log.error({ err }, 'DTMF feed error');
```

Replace `console.error('[ClawOpsAgent] MCP connection error:', err)` (line 405):
```typescript
this._log.error({ err }, 'MCP connection error');
```

Add MCP server count log before the for loop (after line 396):
```typescript
this._log.debug('Starting %d MCP server(s) for call %s', this._mcpServers.length, session.callId);
```

Replace `console.error('[ClawOpsAgent] Call session error:', err)` (line 501):
```typescript
this._log.error({ err }, 'Call session error: %s', session.callId);
```

- [ ] **Step 3: Propagate logger to components**

In `connect()`, after creating ControlWebSocket, set logger:

```typescript
this._controlWs = new ControlWebSocket({...});
this._controlWs.setLogger(this._log);
```

In `_startCallSession()`:

Pass logger to MediaWebSocket:
```typescript
const mediaWs = new MediaWebSocket();
mediaWs.setLogger(this._log);
```

Pass logger to CallSession (need to add setter call after session creation - both in `_handleIncoming` and `_handleOutboundReady` and `call()`):

In `_handleIncoming` after creating session:
```typescript
session.setLogger(this._log);
```

In `_handleOutboundReady` after creating session:
```typescript
session.setLogger(this._log);
```

In `call()` after creating callSession:
```typescript
callSession.setLogger(this._log);
```

Pass logger to MCPClient:
```typescript
const client = new MCPClient();
client.setLogger(this._log);
```

Pass logger to AudioRecorder:
```typescript
recorder = new AudioRecorder(this._recordingPath, session.callId);
recorder.setLogger(this._log);
```

Pass logger to session handler via setLogger. Use the `_isPipelineSession` flag to choose which logger:

Add a private field to ClawOpsAgent:
```typescript
private _isPipelineSession = false;
```

In the constructor, after `this._session = options.session;`:
```typescript
// Detect PipelineSession at construction time (avoids fragile constructor.name check)
this._isPipelineSession = 'setToolRegistry' in this._session
  && '_stt' in this._session
  && '_llm' in this._session;
```

Then in `_startCallSession`, after the existing setBuiltinTools block:
```typescript
if ('setLogger' in sessionHandler && typeof sessionHandler.setLogger === 'function') {
  sessionHandler.setLogger(this._isPipelineSession ? this._pipelineLog : this._log);
}
```

This should go right after the existing setToolRegistry / setRecorder / setBuiltinTools block.

- [ ] **Step 4: Verify build**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent.ts
git commit -m "feat(agent): integrate pino logger in ClawOpsAgent with propagation"
```

---

## Chunk 3: Pipeline components (pipeline-session, stt, tts, realtime sessions)

### Task 9: Update PipelineSession

**Files:**
- Modify: `src/agent/pipeline/pipeline-session.ts`

- [ ] **Step 1: Add logger**

Add imports:

```typescript
import type { Logger } from 'pino';
import { NOOP_LOGGER } from '../logger.js';
```

Add field:

```typescript
private _log: Logger = NOOP_LOGGER;
```

Add setter that propagates to child STT/TTS:

```typescript
setLogger(logger: Logger): void {
  this._log = logger;
  // Propagate to STT and TTS if they support setLogger
  if ('setLogger' in this._stt && typeof (this._stt as any).setLogger === 'function') {
    (this._stt as any).setLogger(logger);
  }
  if ('setLogger' in this._tts && typeof (this._tts as any).setLogger === 'function') {
    (this._tts as any).setLogger(logger);
  }
}
```

- [ ] **Step 2: Replace console calls and add new logs**

In `start()`, after `this._running = true;` (line 126), add:
```typescript
this._log.info('PipelineSession started');
```

Replace `console.error('[PipelineSession] Greeting error:', err)` (line 139):
```typescript
this._log.error({ err }, 'Greeting error');
```

Replace `console.error('[PipelineSession] STT loop error:', err)` (line 145):
```typescript
this._log.error({ err }, 'STT loop error');
```

In `stop()`, after `this._running = false;` (line 164), add:
```typescript
this._log.info('PipelineSession stopped');
```

In `_runSttLoop()`, in the interim/interrupt block (line 176-181), add log:
```typescript
this._log.info('Barge-in: "%s" — clearing AI audio', event.transcript.substring(0, 30));
```

In `_runSttLoop()`, in the final transcript block (line 184), add log before handleUserSpeech:
```typescript
this._log.info('STT: %s', event.transcript);
```

In `_respond()`, after building fullResponse, before pushing to conversation, add:
```typescript
this._log.info('Assistant: %s', fullResponse.substring(0, 100));
```

In `_respond()`, add LLM sentence/final logs inside the for-await loop for text chunks:
```typescript
// After accumulating text, log sentence-level output
this._log.info('LLM sentence: %s', fullResponse.substring(0, 80));
```

After the loop ends (after `for await`), if there's remaining text:
```typescript
this._log.info('LLM final: %s', fullResponse.substring(0, 80));
```

In `_synthesizeAndSend()`, at the start if `!this._running`:
```typescript
this._log.info('Response cancelled (no audio sent yet)');
```

In `_synthesizeAndSend()`, if `!this._speaking` inside the TTS loop (user interrupted):
```typescript
this._log.info('Response interrupted');
```

In `_synthesizeAndSend()`, if session is stopped but TTS audio arrives:
```typescript
this._log.warn('TTS audio received but session stopped');
```

Replace `console.error('[PipelineSession] Tool call error...')` (line 348):
```typescript
this._log.error({ err }, 'Tool call failed: %s', name);
```

Replace `console.error('[PipelineSession] TTS error:', err)` (line 380):
```typescript
this._log.error({ err }, 'TTS error');
```

- [ ] **Step 3: Verify build and commit**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm run build
git add src/agent/pipeline/pipeline-session.ts
git commit -m "feat(agent): replace console with pino in PipelineSession"
```

---

### Task 10: Update DeepgramSTT

**Files:**
- Modify: `src/agent/pipeline/deepgram-stt.ts`

- [ ] **Step 1: Add logger**

Add imports:

```typescript
import type { Logger } from 'pino';
import { NOOP_LOGGER } from '../logger.js';
```

Add field and setter to class:

```typescript
private _log: Logger = NOOP_LOGGER;

setLogger(logger: Logger): void {
  this._log = logger;
}
```

- [ ] **Step 2: Replace console calls and add new logs**

In `transcribe()`, after WebSocket connects (after `await new Promise` on line 129-132), add:
```typescript
this._log.info('Deepgram STT connected');
```

Replace `console.error('[DeepgramSTT] WebSocket error:', err.message)` (line 120):
```typescript
this._log.error({ err }, 'Deepgram STT error');
```

In the `ws.on('message')` callback, add VAD and interim speech logs:

When `speechFinal` triggers a final event, add before pushing to eventQueue:
```typescript
if (isFinal && transcript) {
  this._log.info('Speech started (VAD)');
}
```

For interim results:
```typescript
if (!isFinal && !speechFinal && transcript) {
  this._log.info('Speech detected (interim): %s', transcript.substring(0, 40));
}
```

- [ ] **Step 3: Verify build and commit**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm run build
git add src/agent/pipeline/deepgram-stt.ts
git commit -m "feat(agent): replace console with pino in DeepgramSTT"
```

---

### Task 11: Update ElevenLabsTTS

**Files:**
- Modify: `src/agent/pipeline/elevenlabs-tts.ts`

- [ ] **Step 1: Add logger**

Add imports:

```typescript
import type { Logger } from 'pino';
import { NOOP_LOGGER } from '../logger.js';
```

Add field and setter:

```typescript
private _log: Logger = NOOP_LOGGER;

setLogger(logger: Logger): void {
  this._log = logger;
}
```

- [ ] **Step 2: Replace console calls and add new logs**

In `_synthesizeStreaming()`, after WebSocket connects (after `await new Promise` on line 166-169), add:
```typescript
this._log.info('ElevenLabs TTS connected');
```

Replace `console.error('[ElevenLabsTTS] WebSocket error:', err.message)` (line 157):
```typescript
this._log.error({ err }, 'ElevenLabs TTS error');
```

In `_synthesizeStreaming`, in the feedPromise text loop, add text send log:
```typescript
this._log.info('ElevenLabs sending text: %s', chunk.substring(0, 60));
```

In `_synthesizeStreaming`, when sending EOS (end-of-stream empty text):
```typescript
this._log.info('ElevenLabs sending EOS');
```

- [ ] **Step 3: Verify build and commit**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm run build
git add src/agent/pipeline/elevenlabs-tts.ts
git commit -m "feat(agent): replace console with pino in ElevenLabsTTS"
```

---

### Task 12: Update OpenAIRealtime

**Files:**
- Modify: `src/agent/pipeline/openai-realtime.ts`

- [ ] **Step 1: Add logger**

Add imports:

```typescript
import type { Logger } from 'pino';
import { NOOP_LOGGER } from '../logger.js';
```

Add field:

```typescript
private _log: Logger = NOOP_LOGGER;
```

Add setter:

```typescript
setLogger(logger: Logger): void {
  this._log = logger;
}
```

- [ ] **Step 2: Replace console calls and add new logs**

In `start()`, in ws.on('open') callback, after `_sendSessionUpdate()`, add:
```typescript
this._log.info('OpenAI Realtime connected');
```

Replace `console.error('[OpenAIRealtime] WebSocket error:', err.message)` (line 182):
```typescript
this._log.error({ err }, 'OpenAI Realtime WS error');
```

Replace `console.error('[OpenAIRealtime] API error:', msg['error'])` (line 319):
```typescript
this._log.error('OpenAI error: %o', msg['error']);
```

In `_handleToolCall`, add tool call log before processing:
```typescript
this._log.info('Tool call: %s(%s)', funcName, (item['arguments'] as string) ?? '{}');
```

Replace `console.error('[OpenAIRealtime] Unknown tool: ...')` (line 444):
```typescript
this._log.error('Unknown tool: %s', funcName);
```

Replace `console.error('[OpenAIRealtime] Tool call failed: ...')` (line 453):
```typescript
this._log.error({ err }, 'Tool call failed: %s', funcName);
```

After tool call succeeds, add debug log for result:
```typescript
this._log.debug('Tool result: %s -> %s', funcName, String(result).substring(0, 200));
```

- [ ] **Step 3: Verify build and commit**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm run build
git add src/agent/pipeline/openai-realtime.ts
git commit -m "feat(agent): replace console with pino in OpenAIRealtime"
```

---

### Task 13: Update GeminiRealtime

**Files:**
- Modify: `src/agent/pipeline/gemini-realtime.ts`

- [ ] **Step 1: Add logger**

Add imports:

```typescript
import type { Logger } from 'pino';
import { NOOP_LOGGER } from '../logger.js';
```

Add field:

```typescript
private _log: Logger = NOOP_LOGGER;
```

Add setter:

```typescript
setLogger(logger: Logger): void {
  this._log = logger;
}
```

- [ ] **Step 2: Replace all console calls**

In `start()`, add config debug logs before `client.live.connect()`:
```typescript
this._log.debug('Gemini SDK config: model=%s, voice=%s', this._model, this._voice);
this._log.debug('Gemini SDK tool count: %d', toolSchemas.length);
```

After `client.live.connect()` resolves, add:
```typescript
this._log.info('Gemini Live SDK session connected');
```

Replace `console.error('[GeminiRealtime] SDK error:', err)` (line 273):
```typescript
this._log.error({ err }, 'Gemini receive error');
```

Replace `console.log('[GeminiRealtime] Connection closed: ...')` (lines 276-278):
```typescript
this._log.warn('Gemini connection closed: code=%s', (ev as { code?: number })?.code ?? 'unknown');
```

In `_handleMessage`:

Replace `console.log('[GeminiRealtime] Turn complete')` (line 380):
```typescript
this._log.debug('Gemini turn complete');
```

Replace `console.log('[GeminiRealtime] Barge-in detected')` (line 386):
```typescript
this._log.info('Gemini: barge-in detected');
```

Replace `console.log('[GeminiRealtime] [TRANSCRIPT-USER] ...')` (line 397):
```typescript
this._log.info('[TRANSCRIPT-USER] %s', inputText);
```

Replace `console.log('[GeminiRealtime] [TRANSCRIPT-ASSISTANT] ...')` (line 404):
```typescript
this._log.info('[TRANSCRIPT-ASSISTANT] %s', outputText);
```

Replace `console.log('[GeminiRealtime] Tool call cancelled: ...')` (lines 419-420):
```typescript
this._log.info('Gemini tool call cancelled: %s', (toolCancellation.ids ?? []).join(', '));
```

In `_handleToolCall`:

Remove `console.log('[GeminiRealtime] toolCall: ...')` (lines 468-469) — redundant with per-call log.

Replace `console.log('[GeminiRealtime] Tool call: ...')` (line 477):
```typescript
this._log.info('Tool call: %s(%s)', name, JSON.stringify(args));
```

Replace `console.log('[GeminiRealtime] hang_up: ending call')` (line 481):
```typescript
this._log.info('hang_up: ending call');
```

Replace `console.log('[GeminiRealtime] collect_dtmf: ...')` (lines 492-494):
```typescript
this._log.info('collect_dtmf: waiting (maxDigits=%d, timeout=%d)', (args['max_digits'] as number) ?? 4, (args['timeout'] as number) ?? 5);
```

Replace `console.log('[GeminiRealtime] DTMF collected: ...')` (line 500):
```typescript
this._log.info('DTMF collected: %s', result || '(empty)');
```

Replace `console.error('[GeminiRealtime] collect_dtmf error:', err)` (line 502):
```typescript
this._log.error({ err }, 'collect_dtmf error');
```

Replace `console.log('[GeminiRealtime] send_dtmf: digits=...')` (line 518):
```typescript
this._log.info('send_dtmf: digits="%s"', (args['digits'] as string) ?? '');
```

Replace `console.log('[GeminiRealtime] send_dtmf: sent')` (line 521):
```typescript
this._log.info('send_dtmf: sent');
```

Replace `console.error('[GeminiRealtime] send_dtmf error:', err)` (line 523):
```typescript
this._log.error({ err }, 'send_dtmf error');
```

Replace `console.error('[GeminiRealtime] Unknown tool: ...')` (line 532):
```typescript
this._log.error('Unknown tool: %s', name);
```

Replace `console.log('[GeminiRealtime] Tool result: ...')` (line 540):
```typescript
this._log.debug('Tool result: %s -> %s', name, resultStr.substring(0, 200));
```

Replace `console.error('[GeminiRealtime] Tool call failed: ...')` (line 547):
```typescript
this._log.error({ err }, 'Tool call failed: %s', name);
```

Replace `console.log('[GeminiRealtime] Sending ... tool response(s)')` (line 557):
```typescript
this._log.debug('Sending %d tool response(s)', responses.length);
```

- [ ] **Step 3: Verify build and commit**

```bash
cd /Users/ghyeok/Developments/clawops-node && npm run build
git add src/agent/pipeline/gemini-realtime.ts
git commit -m "feat(agent): replace console with pino in GeminiRealtime"
```

---

## Chunk 4: Final verification

### Task 14: Verify no remaining console calls and full build

- [ ] **Step 1: Grep for remaining console.log/console.error in agent/**

```bash
cd /Users/ghyeok/Developments/clawops-node && grep -rn 'console\.\(log\|error\|warn\)' src/agent/
```

Expected: NO results (zero remaining console calls in agent module)

- [ ] **Step 2: Full build**

```bash
npm run build
```

Expected: BUILD SUCCESS with no TypeScript errors

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: All existing tests pass

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -A && git commit -m "chore: clean up remaining console calls in agent module"
```

Only run if Step 1 found remaining console calls.
