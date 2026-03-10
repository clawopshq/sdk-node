/**
 * OpenTelemetry span helpers. No-op when OpenTelemetry is not installed.
 */

import { getTracingConfig } from './config.js';

/** Tracer interface (subset of @opentelemetry/api Tracer). */
interface Tracer {
  startSpan(name: string, options?: Record<string, unknown>): Span;
  startActiveSpan<T>(
    name: string,
    options: Record<string, unknown>,
    fn: (span: Span) => T,
  ): T;
}

/** Span interface (subset of @opentelemetry/api Span). */
interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(error: Error): void;
  end(): void;
}

// Cached tracer instance
let _tracer: Tracer | null = null;

/**
 * Get the tracer, or null if tracing is not enabled/available.
 */
async function getTracer(): Promise<Tracer | null> {
  const config = getTracingConfig();
  if (!config.enabled) return null;

  if (_tracer) return _tracer;

  try {
    const otel = await import('@opentelemetry/api');
    const provider = config.tracerProvider ?? otel.trace.getTracerProvider();
    _tracer = (provider as { getTracer: (name: string, version?: string) => Tracer }).getTracer(
      config.serviceName ?? 'clawops-agent',
      '1.0.0',
    );
    return _tracer;
  } catch {
    // OpenTelemetry not installed
    return null;
  }
}

/**
 * Start a new span. Returns a no-op span if tracing is not available.
 */
export async function startSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>,
): Promise<Span> {
  const tracer = await getTracer();
  if (!tracer) {
    return createNoOpSpan();
  }

  const span = tracer.startSpan(name, {
    attributes,
  });
  return span;
}

/**
 * Run a function within a new active span.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = await getTracer();
  if (!tracer) {
    return fn(createNoOpSpan());
  }

  const span = tracer.startSpan(name, { attributes });
  try {
    const result = await fn(span);
    span.setStatus({ code: 1 }); // OK
    return result;
  } catch (err) {
    span.setStatus({ code: 2, message: String(err) }); // ERROR
    if (err instanceof Error) {
      span.recordException(err);
    }
    throw err;
  } finally {
    span.end();
  }
}

function createNoOpSpan(): Span {
  return {
    setAttribute() {},
    setStatus() {},
    recordException() {},
    end() {},
  };
}

/** Reset the cached tracer (for testing). */
export function _resetTracer(): void {
  _tracer = null;
}
