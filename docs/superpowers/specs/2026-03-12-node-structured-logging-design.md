# Node.js SDK Structured Logging with Pino

## Problem

Node.js SDK uses `console.log`/`console.error` across 11 files (47 calls total). This causes:
- No log level control (only log/error, no debug/warn differentiation)
- No structured output (plain text with `[ComponentName]` prefixes)
- No programmatic log configuration (cannot redirect, filter, or aggregate)
- Inconsistent messages compared to the Python SDK which uses hierarchical `logging.getLogger()` with 4 levels

## Decision

Introduce `pino` as a structured logger with a 2-level hierarchy matching the Python SDK, user-injectable logger support, and unified log messages across both SDKs.

## Design

### Logger Module (`src/agent/logger.ts`)

A factory module that creates and manages the logger hierarchy.

```typescript
import pino, { type Logger } from 'pino';

const DEFAULT_LOGGER = pino({ name: 'clawops.agent' });

export function createAgentLogger(userLogger?: Logger): Logger {
  return userLogger ?? DEFAULT_LOGGER;
}

export function createPipelineLogger(parent: Logger): Logger {
  return parent.child({ module: 'pipeline' });
}

export type { Logger };
```

- `createAgentLogger()`: Returns user-provided logger or default pino instance with name `clawops.agent`
- `createPipelineLogger()`: Creates a child logger with `{ module: 'pipeline' }` for pipeline components

### User Injection Interface

`ClawOpsAgent` constructor accepts an optional `logger` field:

```typescript
import pino from 'pino';

const agent = new ClawOpsAgent({
  logger: pino({ level: 'debug', transport: { target: 'pino-pretty' } }),
});
```

When omitted, the SDK creates a default `pino({ name: 'clawops.agent' })` instance (info level, JSON output).

### Logger Propagation

```
ClawOpsAgent (agentLogger)
├── ControlWebSocket (agentLogger)
├── MediaWebSocket (agentLogger)
├── CallSession (agentLogger)
│   └── AudioRecorder (agentLogger)
├── MCPClient (agentLogger)
└── Pipeline components (pipelineLogger = agentLogger.child({ module: 'pipeline' }))
    ├── PipelineSession
    ├── DeepgramSTT
    ├── ElevenLabsTTS
    ├── OpenAIRealtime
    └── GeminiRealtime
```

Each component receives its logger via constructor parameter. No global/singleton state.

### Log Level Mapping

| Python | Pino | Usage |
|--------|------|-------|
| `log.info()` | `log.info()` | Connection, call state, session lifecycle, transcripts |
| `log.debug()` | `log.debug()` | Tool registration details, MCP config, tool results |
| `log.warning()` | `log.warn()` | Reconnection attempts, non-fatal issues |
| `log.error()` | `log.error()` | Exceptions, stream errors, tool failures |

### Message Mapping (Python → Node.js)

Below is the complete mapping. Node.js messages match Python SDK messages where an equivalent exists. Where Node.js has additional functionality (e.g. DTMF built-in tools in Gemini), messages follow the same style.

#### agent.ts (agentLogger)

| Current Node.js | New | Level |
|----------------|-----|-------|
| `console.log('[ClawOpsAgent] Connected on ...')` | `log.info('ClawOpsAgent connected on %s', fromNumber)` | info |
| `console.log('[ClawOpsAgent] Disconnected')` | `log.info('ClawOpsAgent disconnected')` | info |
| `console.log('[ClawOpsAgent] Outbound call initiated: ...')` | `log.info('Outbound call initiated: %s -> %s (%s)', from, to, callId)` | info |
| (missing - add) | `log.info('Incoming call: %s -> %s (%s)', from, to, callId)` | info |
| `console.log('[ClawOpsAgent] Outbound call ringing: ...')` | `log.info('Outbound call ringing: %s', callId)` | info |
| (missing - add from Python) | `log.info('Outbound call answered: %s -> %s (%s)', from, to, callId)` | info |
| (missing - add from Python) | `log.info('Outbound call failed: %s (%s)', callId, reason)` | info |
| (missing - add from Python) | `log.info('Call ended (server): %s', callId)` | info |
| (missing - add from Python) | `log.info('Media stream started: %s', callId)` | info |
| (missing - add from Python) | `log.info('Media stream stopped: %s', callId)` | info |
| (missing - add from Python) | `log.warning('Unknown outbound call: %s', callId)` | warn |
| `console.error('[ClawOpsAgent] Error in call session ...')` | `log.error({ err }, 'Call session error: %s', callId)` | error |
| `console.error('[ClawOpsAgent] MCP connection error: ...')` | `log.error({ err }, 'MCP connection error')` | error |
| `console.error('[ClawOpsAgent] feedDtmf error: ...')` | `log.error({ err }, 'DTMF feed error')` | error |
| (missing - add from Python) | `log.debug('Starting %d MCP server(s) for call %s', count, callId)` | debug |

#### control-ws.ts (agentLogger)

| Current Node.js | New | Level |
|----------------|-----|-------|
| `console.error('[ControlWebSocket] Failed to parse message')` | `log.warn('Control WS parse error')` | warn |
| `console.error('[ControlWebSocket] Error: ...')` | `log.warn('Control WS error: %s', err.message)` | warn |
| `console.error('[ControlWebSocket] Error in handler ...')` | `log.error({ err }, 'Control WS handler error: %s', event)` | error |
| `console.error('[ControlWebSocket] Reconnect failed: ...')` | `log.info('Control WS reconnecting in %.1fs...', delay)` | info |
| (missing - add from Python) | `log.info('Control WS connected: %s', url)` | info |

#### media-ws.ts (agentLogger)

| Current Node.js | New | Level |
|----------------|-----|-------|
| `console.error('[MediaWebSocket] Error: ...')` | `log.error({ err }, 'Media WS error')` | error |
| (missing - add from Python) | `log.info('Media WS connected: %s', url)` | info |
| (missing - add from Python) | `log.warn('DTMF send skipped (WS not connected): %s', digit)` | warn |

#### session.ts (agentLogger)

| Current Node.js | New | Level |
|----------------|-----|-------|
| `console.error('[CallSession] Error in ... handler: ...')` | `log.error({ err }, 'CallSession handler error: %s', event)` | error |
| (missing - add from Python) | `log.info('DTMF collected: %s', result)` | info |

#### recorder.ts (agentLogger)

| Current Node.js | New | Level |
|----------------|-----|-------|
| `console.error('Error writing inbound audio: ...')` | `log.error({ err }, 'Recording write error (inbound)')` | error |
| `console.error('Error writing outbound audio: ...')` | `log.error({ err }, 'Recording write error (outbound)')` | error |
| `console.error('Error stopping recorder: ...')` | `log.error({ err }, 'Recording stop error')` | error |
| (missing - add from Python) | `log.info('Recording started: %s', dir)` | info |
| (missing - add from Python) | `log.info('Recording stopped: %s (%.1fs)', dir, duration)` | info |

#### mcp/client.ts (agentLogger)

| Current Node.js | New | Level |
|----------------|-----|-------|
| `console.error('[MCPClient] Failed to connect ...')` | `log.error({ err }, 'MCP connection failed: %s', name)` | error |
| `console.error('[MCPClient] Error disconnecting ...')` | `log.error({ err }, 'MCP disconnect error: %s', name)` | error |
| (missing - add from Python) | `log.debug('MCP connecting (stdio): %s %s', command, args)` | debug |
| (missing - add from Python) | `log.debug('MCP connecting (http): %s', url)` | debug |
| (missing - add from Python) | `log.info('MCP server connected: %d tools found', count)` | info |
| (missing - add from Python) | `log.debug('MCP tools: %s', toolNames)` | debug |
| (missing - add from Python) | `log.debug('MCP closing: %s', server)` | debug |
| (missing - add from Python) | `log.debug('MCP call_tool: %s(%s)', name, args)` | debug |

#### pipeline/pipeline-session.ts (pipelineLogger)

| Current Node.js | New | Level |
|----------------|-----|-------|
| `console.error('[PipelineSession] Greeting error: ...')` | `log.error({ err }, 'Greeting error')` | error |
| `console.error('[PipelineSession] STT loop error: ...')` | `log.error({ err }, 'STT loop error')` | error |
| `console.error('[PipelineSession] Tool call error ...')` | `log.error({ err }, 'Tool call failed: %s', name)` | error |
| `console.error('[PipelineSession] TTS error: ...')` | `log.error({ err }, 'TTS error')` | error |
| (missing - add from Python) | `log.info('PipelineSession started')` | info |
| (missing - add from Python) | `log.info('PipelineSession stopped')` | info |
| (missing - add from Python) | `log.info('Barge-in: "%s" — clearing AI audio', transcript)` | info |
| (missing - add from Python) | `log.info('STT: %s', transcript)` | info |
| (missing - add from Python) | `log.info('LLM sentence: %s', buffer)` | info |
| (missing - add from Python) | `log.info('LLM final: %s', buffer)` | info |
| (missing - add from Python) | `log.info('Assistant: %s', text)` | info |
| (missing - add from Python) | `log.info('Response interrupted')` | info |
| (missing - add from Python) | `log.info('Response cancelled (no audio sent yet)')` | info |
| (missing - add from Python) | `log.info('Debounce expired, starting response')` | info |
| (missing - add from Python) | `log.warn('TTS audio received but session stopped')` | warn |

#### pipeline/deepgram-stt.ts (pipelineLogger)

| Current Node.js | New | Level |
|----------------|-----|-------|
| `console.error('[DeepgramSTT] WebSocket error: ...')` | `log.error({ err }, 'Deepgram STT error')` | error |
| (missing - add from Python) | `log.info('Deepgram STT connected')` | info |
| (missing - add from Python) | `log.info('Speech started (VAD)')` | info |
| (missing - add from Python) | `log.info('Speech detected (interim): %s', transcript)` | info |

#### pipeline/elevenlabs-tts.ts (pipelineLogger)

| Current Node.js | New | Level |
|----------------|-----|-------|
| `console.error('[ElevenLabsTTS] WebSocket error: ...')` | `log.error({ err }, 'ElevenLabs TTS error')` | error |
| (missing - add from Python) | `log.info('ElevenLabs TTS connected')` | info |
| (missing - add from Python) | `log.info('ElevenLabs sending text: %s', text)` | info |
| (missing - add from Python) | `log.info('ElevenLabs sending EOS')` | info |

#### pipeline/openai-realtime.ts (pipelineLogger)

| Current Node.js | New | Level |
|----------------|-----|-------|
| `console.error('[OpenAIRealtime] WebSocket error: ...')` | `log.error({ err }, 'OpenAI Realtime WS error')` | error |
| `console.error('[OpenAIRealtime] API error: ...')` | `log.error('OpenAI error: %o', error)` | error |
| `console.error('[OpenAIRealtime] Unknown tool: ...')` | `log.error('Unknown tool: %s', funcName)` | error |
| `console.error('[OpenAIRealtime] Tool call failed: ...')` | `log.error({ err }, 'Tool call failed: %s', funcName)` | error |
| (missing - add from Python) | `log.info('OpenAI Realtime connected')` | info |
| (missing - add from Python) | `log.info('Tool call: %s(%s)', funcName, args)` | info |
| (missing - add from Python) | `log.debug('Tool result: %s -> %s', funcName, result)` | debug |

#### pipeline/gemini-realtime.ts (pipelineLogger)

| Current Node.js | New | Level |
|----------------|-----|-------|
| `console.error('[GeminiRealtime] SDK error: ...')` | `log.error({ err }, 'Gemini receive error')` | error |
| `console.log('[GeminiRealtime] Connection closed: ...')` | `log.warn('Gemini connection closed: code=%s', code)` | warn |
| `console.log('[GeminiRealtime] Turn complete')` | `log.debug('Gemini turn complete')` | debug |
| `console.log('[GeminiRealtime] Barge-in detected')` | `log.info('Gemini: barge-in detected')` | info |
| `console.log('[GeminiRealtime] [TRANSCRIPT-USER] ...')` | `log.info('[TRANSCRIPT-USER] %s', text)` | info |
| `console.log('[GeminiRealtime] [TRANSCRIPT-ASSISTANT] ...')` | `log.info('[TRANSCRIPT-ASSISTANT] %s', text)` | info |
| `console.log('[GeminiRealtime] Tool call cancelled: ...')` | `log.info('Gemini tool call cancelled: %s', ids)` | info |
| `console.log('[GeminiRealtime] toolCall: ...')` | (remove - redundant with per-call log below) | — |
| `console.log('[GeminiRealtime] Tool call: ...')` | `log.info('Tool call: %s(%s)', name, args)` | info |
| `console.log('[GeminiRealtime] hang_up: ending call')` | `log.info('hang_up: ending call')` | info |
| `console.log('[GeminiRealtime] collect_dtmf: ...')` | `log.info('collect_dtmf: waiting (maxDigits=%d, timeout=%d)', max, timeout)` | info |
| `console.log('[GeminiRealtime] DTMF collected: ...')` | `log.info('DTMF collected: %s', result)` | info |
| `console.error('[GeminiRealtime] collect_dtmf error: ...')` | `log.error({ err }, 'collect_dtmf error')` | error |
| `console.log('[GeminiRealtime] send_dtmf: digits=...')` | `log.info('send_dtmf: digits="%s"', digits)` | info |
| `console.log('[GeminiRealtime] send_dtmf: sent')` | `log.info('send_dtmf: sent')` | info |
| `console.error('[GeminiRealtime] send_dtmf error: ...')` | `log.error({ err }, 'send_dtmf error')` | error |
| `console.error('[GeminiRealtime] Unknown tool: ...')` | `log.error('Unknown tool: %s', name)` | error |
| `console.log('[GeminiRealtime] Tool result: ...')` | `log.debug('Tool result: %s -> %s', name, result)` | debug |
| `console.error('[GeminiRealtime] Tool call failed: ...')` | `log.error({ err }, 'Tool call failed: %s', name)` | error |
| `console.log('[GeminiRealtime] Sending ... tool response(s)')` | `log.debug('Sending %d tool response(s)', count)` | debug |
| (missing - add from Python) | `log.debug('Gemini SDK config: model=%s, voice=%s', model, voice)` | debug |
| (missing - add from Python) | `log.debug('Gemini SDK tool count: %d', count)` | debug |
| (missing - add from Python) | `log.info('Gemini Live SDK session connected')` | info |

### Dependency Change

Add `pino` to `dependencies` in `package.json`:

```json
{
  "dependencies": {
    "pino": "^9.0.0",
    "zod": "^3.23.0"
  }
}
```

### Files Changed

| File | Action |
|------|--------|
| `src/agent/logger.ts` | **New** — logger factory |
| `src/agent/agent.ts` | Replace console → agentLogger, add `logger` option |
| `src/agent/control-ws.ts` | Replace console → agentLogger |
| `src/agent/media-ws.ts` | Replace console → agentLogger |
| `src/agent/session.ts` | Replace console → agentLogger |
| `src/agent/recorder.ts` | Replace console → agentLogger |
| `src/agent/mcp/client.ts` | Replace console → agentLogger |
| `src/agent/pipeline/pipeline-session.ts` | Replace console → pipelineLogger |
| `src/agent/pipeline/deepgram-stt.ts` | Replace console → pipelineLogger |
| `src/agent/pipeline/elevenlabs-tts.ts` | Replace console → pipelineLogger |
| `src/agent/pipeline/openai-realtime.ts` | Replace console → pipelineLogger |
| `src/agent/pipeline/gemini-realtime.ts` | Replace console → pipelineLogger |
| `package.json` | Add pino dependency |

### Testing

- Verify `npm run build` succeeds with no TypeScript errors
- Verify existing tests pass (`npm test`)
- Manual verification: default logger outputs JSON at info level, debug messages suppressed
