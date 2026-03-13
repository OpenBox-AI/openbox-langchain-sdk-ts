/**
 * OpenBox LangChain SDK — HTTP Telemetry Span Collection (Phase 3)
 *
 * Patches the global `fetch` API and optionally axios to capture HTTP
 * request/response bodies for outbound calls made during tool/LLM execution.
 * Mirrors the Temporal SDK's otel_setup.py httpx monkey-patching.
 *
 * Spans are stored per run_id in a SpanCollector and attached to the
 * next governance event payload as `spans[]`.
 */

import { rfc3339Now } from "./serializer.js";

export interface HttpSpan {
  span_id: string;
  name: string;
  kind: "client";
  start_time: number;
  end_time?: number;
  duration_ns?: number;
  attributes: Record<string, unknown>;
  status: { code: string; description?: string };
  request_body?: string;
  response_body?: string;
  request_headers?: Record<string, string>;
  response_headers?: Record<string, string>;
}

// ═══════════════════════════════════════════════════════════════════
// SpanCollector — per-run HTTP span buffer
// ═══════════════════════════════════════════════════════════════════

export class SpanCollector {
  private readonly spans = new Map<string, HttpSpan[]>();
  private currentRunId: string | null = null;
  /** Span IDs evaluated at hook level — excluded from bulk ActivityCompleted payload */
  private readonly governedSpanIds = new Set<string>();

  /** Set the active run_id that spans will be attributed to */
  setActiveRun(runId: string): void {
    this.currentRunId = runId;
    if (!this.spans.has(runId)) {
      this.spans.set(runId, []);
    }
  }

  clearActiveRun(): void {
    this.currentRunId = null;
  }

  /** Expose current run_id for hook-governance lookup */
  get activeRunId(): string | null {
    return this.currentRunId;
  }

  addSpan(span: HttpSpan, runId?: string): void {
    const target = runId ?? this.currentRunId;
    if (!target) return;
    let bucket = this.spans.get(target);
    if (!bucket) {
      bucket = [];
      this.spans.set(target, bucket);
    }
    bucket.push(span);
  }

  /**
   * Mark a span as governed so it is excluded from the bulk ActivityCompleted
   * spans array (already individually evaluated at hook level).
   * Mirrors WorkflowSpanProcessor.mark_governed() in the Temporal SDK.
   */
  markSpanGoverned(spanId: string): void {
    this.governedSpanIds.add(spanId);
    // Safety cap: prevent unbounded growth (same as Temporal SDK's 10k limit)
    if (this.governedSpanIds.size > 10_000) {
      this.governedSpanIds.clear();
    }
  }

  isSpanGoverned(spanId: string): boolean {
    return this.governedSpanIds.has(spanId);
  }

  /**
   * Returns spans for a run, excluding any that were already evaluated by hook governance.
   */
  getSpans(runId: string): HttpSpan[] {
    const all = this.spans.get(runId) ?? [];
    if (this.governedSpanIds.size === 0) return all;
    return all.filter((s) => !this.governedSpanIds.has(s.span_id));
  }

  clearSpans(runId: string): void {
    this.spans.delete(runId);
  }

  get size(): number {
    return this.spans.size;
  }
}

// Global singleton span collector
export const globalSpanCollector = new SpanCollector();

// ═══════════════════════════════════════════════════════════════════
// fetch patching
// ═══════════════════════════════════════════════════════════════════

let _fetchPatched = false;
let _originalFetch: typeof globalThis.fetch | null = null;

/** URLs that should never be traced (prevents infinite loop to OpenBox Core itself) */
const IGNORED_URL_PATTERNS = [
  /\/api\/v1\/governance\//,
  /\/api\/v1\/auth\//,
];

function shouldIgnoreUrl(url: string): boolean {
  return IGNORED_URL_PATTERNS.some((p) => p.test(url));
}

function generateSpanId(): string {
  const uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
  return `http-${uuid}`;
}

function safeReadBody(body: unknown): string | undefined {
  if (!body) return undefined;
  if (typeof body === "string") return body.slice(0, 8192);
  try {
    return JSON.stringify(body).slice(0, 8192);
  } catch {
    return String(body).slice(0, 8192);
  }
}

function headersToRecord(headers: Headers | Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((val, key) => {
      // Skip authorization headers for privacy
      if (key.toLowerCase() !== "authorization") {
        out[key] = val;
      }
    });
    return out;
  }
  return Object.fromEntries(
    Object.entries(headers as Record<string, string>).filter(
      ([k]) => k.toLowerCase() !== "authorization"
    )
  );
}

/**
 * Patch the global fetch to capture HTTP spans and evaluate hook-level governance.
 * Safe to call multiple times — only patches once.
 *
 * Two-stage governance (mirrors otel_setup.py HTTP hooks in Temporal SDK):
 *   1. "started" — evaluated BEFORE the real fetch fires (blocking)
 *   2. "completed" — evaluated AFTER response received (informational only)
 */
export function patchFetch(collector: SpanCollector = globalSpanCollector): void {
  if (_fetchPatched) return;
  if (typeof globalThis.fetch !== "function") return;

  _originalFetch = globalThis.fetch;
  _fetchPatched = true;

  globalThis.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;

    // Skip tracing for ignored URLs
    if (shouldIgnoreUrl(url)) {
      return _originalFetch!(input, init);
    }

    const spanId = generateSpanId();
    const startTime = Date.now();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");

    // Capture request body
    let requestBody: string | undefined;
    try {
      if (init?.body) {
        requestBody = safeReadBody(init.body);
      } else if (input instanceof Request && input.body) {
        const cloned = input.clone();
        requestBody = await cloned.text().catch(() => undefined);
      }
    } catch {
      // ignore
    }

    const requestHeaders = headersToRecord(
      init?.headers as Headers | Record<string, string> | undefined
    );

    // ── Stage 1: "started" hook governance (blocking — fetch does not fire if blocked)
    // Lazily import to avoid circular dependency at module load time
    const { evaluateHttpHook, isHookGovernanceConfigured } = await import("./hook-governance.js");
    const activeRunId = collector.activeRunId;

    if (isHookGovernanceConfigured() && activeRunId) {
      const startedSpan: HttpSpan = {
        span_id: spanId,
        name: `HTTP ${method} ${url}`,
        kind: "client",
        start_time: startTime,
        attributes: {
          "http.method": method,
          "http.url": url,
        },
        status: { code: "OK" },
        request_body: requestBody,
        request_headers: requestHeaders,
      };
      // Throws GovernanceBlockedError/GovernanceHaltError if verdict blocks
      await evaluateHttpHook("started", startedSpan, activeRunId);
    }

    let response: Response;
    let statusCode = 0;
    let statusText = "";
    let responseBody: string | undefined;
    let responseHeaders: Record<string, string> = {};

    try {
      response = await _originalFetch!(input, init);
      statusCode = response.status;
      statusText = response.statusText;
      responseHeaders = headersToRecord(response.headers);

      // Clone response to read body without consuming it
      try {
        const cloned = response.clone();
        const text = await cloned.text();
        responseBody = text.slice(0, 8192);
      } catch {
        // ignore — body may not be readable
      }

      const endTime = Date.now();
      const span: HttpSpan = {
        span_id: spanId,
        name: `HTTP ${method} ${new URL(url).pathname}`,
        kind: "client",
        start_time: startTime,
        end_time: endTime,
        duration_ns: (endTime - startTime) * 1_000_000,
        attributes: {
          "http.method": method,
          "http.url": url,
          "http.status_code": statusCode,
          "http.host": new URL(url).host,
        },
        status: {
          code: statusCode >= 400 ? "ERROR" : "OK",
          description: statusCode >= 400 ? statusText : undefined,
        },
        request_body: requestBody,
        response_body: responseBody,
        request_headers: requestHeaders,
        response_headers: responseHeaders,
      };

      // ── Stage 2: "completed" hook governance (informational — errors swallowed)
      if (isHookGovernanceConfigured() && activeRunId) {
        await evaluateHttpHook("completed", span, activeRunId).catch(() => {});
        // NOTE: do NOT markSpanGoverned here. Spans must remain in the ToolCompleted
        // payload so Core's AGE can evaluate Behavior Rules on ActivityCompleted events.
        // The hook's ActivityStarted events go through OPA/policy only — not AGE.
      }

      collector.addSpan(span, activeRunId ?? undefined);
      return response;
    } catch (err) {
      const endTime = Date.now();
      const span: HttpSpan = {
        span_id: spanId,
        name: `HTTP ${method} ${url}`,
        kind: "client",
        start_time: startTime,
        end_time: endTime,
        duration_ns: (endTime - startTime) * 1_000_000,
        attributes: {
          "http.method": method,
          "http.url": url,
          "http.error": err instanceof Error ? err.message : String(err),
        },
        status: { code: "ERROR", description: String(err) },
        request_body: requestBody,
        request_headers: requestHeaders,
      };
      collector.addSpan(span, activeRunId ?? undefined);
      throw err;
    }
  };
}

/**
 * Restore the original fetch (useful in tests).
 */
export function unpatchFetch(): void {
  if (_fetchPatched && _originalFetch) {
    globalThis.fetch = _originalFetch;
    _fetchPatched = false;
    _originalFetch = null;
  }
}

export function isFetchPatched(): boolean {
  return _fetchPatched;
}

// ═══════════════════════════════════════════════════════════════════
// setupTelemetry — convenience entry point
// ═══════════════════════════════════════════════════════════════════

export interface TelemetryOptions {
  /** Collector to use (defaults to globalSpanCollector) */
  collector?: SpanCollector;
  /** Whether to patch fetch (default: true) */
  patchFetchEnabled?: boolean;
}

/**
 * Set up HTTP telemetry collection.
 * Call once at app startup, before any LangChain calls.
 *
 * @example
 * ```typescript
 * setupTelemetry();
 * const handler = await createOpenBoxHandler({ ... });
 * ```
 */
export function setupTelemetry(options: TelemetryOptions = {}): SpanCollector {
  const collector = options.collector ?? globalSpanCollector;
  if (options.patchFetchEnabled !== false) {
    patchFetch(collector);
  }
  return collector;
}
