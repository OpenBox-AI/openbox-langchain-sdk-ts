/**
 * OpenBox LangChain SDK — Hook-Level Governance
 *
 * Evaluates every outbound HTTP request made during a tool/LLM execution
 * at two stages: "started" (blocking, before request fires) and "completed"
 * (informational, after response received).
 *
 * Mirrors openbox-temporal-sdk-python/openbox/hook_governance.py.
 *
 * Architecture:
 *   1. telemetry.ts patchFetch detects an outbound HTTP call
 *   2. patchFetch calls evaluateHttpHook("started", ...) before firing
 *   3. If verdict is BLOCK/HALT/REQUIRE_APPROVAL → GovernanceBlockedError thrown
 *      → fetch never fires, tool execution aborts
 *   4. After response received → evaluateHttpHook("completed", ...) — fire-and-forget
 *   5. Span is marked governed → not re-sent in bulk ActivityCompleted spans
 */

import { GovernanceClient } from "./client.js";
import { RunBufferManager } from "./run-buffer.js";
import { SpanCollector, type HttpSpan } from "./telemetry.js";
import { rfc3339Now } from "./serializer.js";
import {
  GovernanceBlockedError,
  GovernanceHaltError,
} from "./errors.js";
import type { HttpHookTrigger } from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// Module-level config (set once via configure())
// ═══════════════════════════════════════════════════════════════════

interface HookGovernanceConfig {
  client: GovernanceClient;
  buffer: RunBufferManager;
  spanCollector: SpanCollector;
  onApiError: "fail_open" | "fail_closed";
}

let _config: HookGovernanceConfig | null = null;

/**
 * Configure hook-level governance. Call once when setting up the handler.
 * Mirrors hook_governance.configure() in the Temporal SDK.
 */
export function configureHookGovernance(options: HookGovernanceConfig): void {
  _config = options;
}

/**
 * Check if hook-level governance is active.
 * telemetry.ts uses this to decide whether to evaluate per-request.
 */
export function isHookGovernanceConfigured(): boolean {
  return _config !== null;
}

/**
 * Reset hook governance config (used in tests / cleanup).
 */
export function resetHookGovernance(): void {
  _config = null;
}

// ═══════════════════════════════════════════════════════════════════
// Payload builder
// ═══════════════════════════════════════════════════════════════════

function buildHookPayload(
  span: HttpSpan,
  stage: "started" | "completed",
  runId: string
): Record<string, unknown> | null {
  if (!_config) return null;

  const { buffer } = _config;
  const buf = buffer.getBuffer(runId);
  if (!buf) return null;

  const rootRunId = buffer.getRootRunId(runId);

  const hookTrigger: HttpHookTrigger = {
    type: "http_request",
    stage,
    "http.method": (span.attributes["http.method"] as string) ?? "GET",
    "http.url": (span.attributes["http.url"] as string) ?? "",
    attribute_key_identifiers: ["http.method", "http.url"],
    request_headers: span.request_headers,
    request_body: span.request_body,
    ...(stage === "completed"
      ? {
          response_headers: span.response_headers,
          response_body: span.response_body,
          "http.status_code": span.attributes["http.status_code"] as number | undefined,
        }
      : {}),
  };

  return {
    source: "workflow-telemetry",
    event_type: "ActivityStarted",
    workflow_id: rootRunId,
    run_id: rootRunId,
    workflow_type: buf.name,
    activity_id: runId,
    activity_type: buf.name,
    task_queue: "langchain",
    spans: [],
    span_count: 0,
    hook_trigger: hookTrigger,
    timestamp: rfc3339Now(),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Verdict handling
// ═══════════════════════════════════════════════════════════════════

function handleVerdictResponse(
  data: Record<string, unknown>,
  url: string,
  runId: string
): void {
  if (!_config) return;

  const verdictRaw = ((data["verdict"] ?? data["action"]) as string | undefined)
    ?.toLowerCase()
    .replace(/-/g, "_") ?? "allow";

  if (verdictRaw === "halt" || verdictRaw === "stop") {
    const reason = (data["reason"] as string) ?? "Halted by hook governance";
    _config.buffer.setHaltRequested(runId, reason);
    throw new GovernanceBlockedError("halt", reason, url);
  }

  if (verdictRaw === "block") {
    const reason = (data["reason"] as string) ?? "Blocked by hook governance";
    _config.buffer.setAborted(runId, reason);
    throw new GovernanceBlockedError("block", reason, url);
  }

  if (verdictRaw === "require_approval" || verdictRaw === "request_approval") {
    const reason = (data["reason"] as string) ?? "Approval required";
    _config.buffer.setAborted(runId, reason);
    throw new GovernanceBlockedError("require_approval", reason, url);
  }

  // ALLOW / CONSTRAIN — continue
}

// ═══════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════

/**
 * Evaluate governance for an HTTP request at a given stage.
 *
 * - "started": called BEFORE the real fetch fires. Throws GovernanceBlockedError
 *   if verdict is BLOCK/HALT/REQUIRE_APPROVAL — the fetch never executes.
 * - "completed": called AFTER response received. Errors are swallowed (informational).
 *
 * Mirrors hook_governance.evaluate_async() in the Temporal SDK.
 *
 * @param stage    "started" | "completed"
 * @param span     HttpSpan being evaluated (may be partial for "started")
 * @param runId    LangChain run_id of the active tool/LLM run
 */
export async function evaluateHttpHook(
  stage: "started" | "completed",
  span: HttpSpan,
  runId: string | null
): Promise<void> {
  if (!_config) return;
  if (!runId) return;

  const { buffer, onApiError } = _config;

  // Short-circuit: if the activity was already aborted by a prior hook, throw immediately
  if (buffer.isAborted(runId)) {
    const reason = buffer.getAbortReason(runId) ?? "Activity aborted by prior hook verdict";
    throw new GovernanceBlockedError("block", reason, (span.attributes["http.url"] as string) ?? "");
  }

  const url = (span.attributes["http.url"] as string) ?? "";
  const payload = buildHookPayload(span, stage, runId);
  if (!payload) return;

  try {
    const response = await _config.client.evaluateRaw(payload);
    if (!response) return;

    handleVerdictResponse(response, url, runId);
  } catch (err) {
    // Re-throw our own governance errors
    if (err instanceof GovernanceBlockedError || err instanceof GovernanceHaltError) {
      throw err;
    }
    // API/network error — apply error policy
    if (onApiError === "fail_closed") {
      const msg = err instanceof Error ? err.message : String(err);
      _config.buffer.setAborted(runId, msg);
      throw new GovernanceBlockedError("halt", `Governance API error: ${msg}`, url);
    }
    // fail_open: log and continue
    console.warn("[OpenBox] Hook governance evaluation failed (fail_open):", err);
  }
}
