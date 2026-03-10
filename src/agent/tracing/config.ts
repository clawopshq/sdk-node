/**
 * Tracing configuration for OpenTelemetry integration.
 */

export interface TracingConfig {
  /** Whether tracing is enabled. Default: false */
  enabled: boolean;
  /** Service name for traces. Default: 'clawops-agent' */
  serviceName?: string;
  /**
   * Optional TracerProvider instance from @opentelemetry/api.
   * If not provided, the global tracer provider will be used.
   */
  tracerProvider?: unknown;
}

const DEFAULT_CONFIG: TracingConfig = {
  enabled: false,
  serviceName: 'clawops-agent',
};

let _currentConfig: TracingConfig = { ...DEFAULT_CONFIG };

/** Get the current tracing configuration. */
export function getTracingConfig(): TracingConfig {
  return _currentConfig;
}

/** Set the tracing configuration. */
export function setTracingConfig(config: Partial<TracingConfig>): void {
  _currentConfig = { ..._currentConfig, ...config };
}

/** Reset tracing configuration to defaults. */
export function resetTracingConfig(): void {
  _currentConfig = { ...DEFAULT_CONFIG };
}
