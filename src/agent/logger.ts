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
