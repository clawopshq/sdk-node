/**
 * Call telemetry types and helpers for reporting SDK info,
 * session configuration, and call performance metrics.
 */

import os from 'os';
import { VERSION } from '../version.js';

export interface SdkInfo {
  name: string;
  version: string;
  runtime: string;
  os: string;
  /** What the server may assume about this SDK — see SDK_CAPABILITIES. */
  capabilities?: string[];
}

export interface ProviderInfo {
  provider: string;
  model: string;
}

export interface SessionTelemetry {
  sessionType: string;
  llm: ProviderInfo | null;
  stt: ProviderInfo | null;
  tts: ProviderInfo | null;
  voice: string | null;
  language: string;
  greetingEnabled: boolean;
  recordingEnabled: boolean;
  toolCount: number;
  mcpServerCount: number;
  builtinTools: string[];
}

export interface CallMetrics {
  firstResponseMs: number | null;
  turnCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  bargeInCount: number;
  endReason: string | null;
  errors: Array<{ type: string; message: string }>;
}

const MAX_ERRORS = 20;
const MAX_ERROR_MESSAGE_LENGTH = 200;

// What the server may assume about this SDK.
//
// `retire`: understands the `agent.retired` notice and does **not** reconnect after it. Only
//   for connections that declare this does the server clear the slot as soon as no call is in
//   progress. Without the declaration the server holds the old connection until its cap —
//   closing it early would make that SDK reconnect and evict the process that just took over.
export const SDK_CAPABILITIES = ['retire'] as const;

export function getSdkInfo(): SdkInfo {
  return {
    name: 'clawops-node',
    version: VERSION,
    runtime: `node/${process.versions.node}`,
    os: `${process.platform}/${os.arch()}`,
    capabilities: [...SDK_CAPABILITIES],
  };
}

export function createCallMetrics(): CallMetrics {
  return {
    firstResponseMs: null,
    turnCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
    bargeInCount: 0,
    endReason: null,
    errors: [],
  };
}

export function addMetricError(metrics: CallMetrics, err: Error): void {
  metrics.toolErrorCount++;
  if (metrics.errors.length < MAX_ERRORS) {
    metrics.errors.push({
      type: err.name || 'Error',
      message: (err.message || '').slice(0, MAX_ERROR_MESSAGE_LENGTH),
    });
  }
}
