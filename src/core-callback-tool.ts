// Tool lifecycle telemetry for the observability callback surface.
//
// Every send is best-effort via `evaluateLifecycleTelemetryOnly`. This surface
// NEVER throws to abort a tool and NEVER calls the adapter — a BLOCK/HALT
// verdict on a start is recorded (a failed same-id completion) but not enforced.

import {
  buildActivityStarted,
  buildActivityCompleted
} from "./lifecycle-events.js";
import { enrichActivityInput } from "./lifecycle-events-envelopes.js";
import { evaluateLifecycleTelemetryOnly } from "./lifecycle-telemetry.js";
import {
  callbackIdentity as identity,
  callbackLoggerOpt as logger,
  type CoreCallbackState
} from "./core-callback-options.js";
import { finishActivityTrace, registerActivityTrace } from "./core-callback-trace.js";
import { toErrorInfo } from "./error-info.js";
import { readProp } from "./property-access.js";
import { toJsonSafe } from "./serialization.js";
import {
  verdictShouldStop,
  type ErrorInfo,
  type EvaluationResult,
  type JsonValue
} from "@openbox-ai/openbox-sdk-ts";

/** Build the tool ActivityStarted `activityInput` with the `__openbox` sentinel. */
export function buildToolStartedInput(
  toolArgs: unknown,
  toolType: string | null
): JsonValue[] {
  const base = toolArgs === undefined || toolArgs === null ? [] : [toJsonSafe(toolArgs)];
  return enrichActivityInput(base, { toolType }) ?? base;
}

function readMetaString(metadata: unknown, key: string): string | null {
  const value = readProp(metadata, key);
  return typeof value === "string" ? value : null;
}

function readMetaNumber(metadata: unknown, key: string): number | null {
  const value = readProp(metadata, key);
  return typeof value === "number" ? value : null;
}

/** Handle a tool start: emit `ActivityStarted` telemetry with ownership dedup. */
export async function handleToolStartTelemetry(
  state: CoreCallbackState,
  tool: unknown,
  input: unknown,
  runId: string,
  metadata: unknown,
  toolCallId: string | undefined
): Promise<void> {
  const activityId = runId;
  const toolName = (readProp(tool, "name") as string | undefined) ?? "unknown_tool";

  const existing = state.bridge.get(state.workflowId, activityId);
  if (existing === undefined && !state.recordLessOk) return;
  // Ownership precheck: the start was already sent (dedup / cross-dispatch).
  if (state.bridge.isCallbackOwned(state.workflowId, activityId, "tool_start")) return;

  let result: EvaluationResult | null;
  if (existing?.startResult != null) {
    // Evaluate-once: a sibling already evaluated and stashed the verdict.
    result = existing.startResult;
  } else {
    const toolType = state.toolTypeResolver?.(toolName) ?? null;
    state.bridge.prepareTool(state.workflowId, activityId, {
      toolName,
      toolType,
      toolCallId: toolCallId ?? null,
      langgraphNode: readMetaString(metadata, "langgraph_node"),
      langgraphStep: readMetaNumber(metadata, "langgraph_step")
    });
    if (!state.sendToolStartEvent) return;
    const activityInput = buildToolStartedInput(input, toolType);
    const envelope = buildActivityStarted({
      ...identity(state),
      activityId,
      activityType: toolName,
      activityInput
    });
    result = await evaluateLifecycleTelemetryOnly(state.runtime, envelope, logger(state));
    state.bridge.markSent(state.workflowId, activityId, "tool_start");
    if (result) state.bridge.stashStartResult(state.workflowId, activityId, result);
  }

  registerActivityTrace(state, activityId, activityId, toolName);

  // Governance said stop: record a failed same-id completion (telemetry), but
  // DO NOT throw — observability never blocks.
  if (result && verdictShouldStop(result.verdict)) {
    await closeOrphanStart(state, activityId, toolName, result);
  }
}

/** Handle a tool end/error: emit a same-id `ActivityCompleted`, guarded against double-send. */
export async function handleToolCompletionTelemetry(
  state: CoreCallbackState,
  runId: string,
  outcome: { result?: unknown; error?: ErrorInfo }
): Promise<void> {
  const activityId = runId;
  if (state.bridge.isCallbackOwned(state.workflowId, activityId, "tool_complete")) {
    finishActivityTrace(state, activityId);
    return;
  }
  const record = state.bridge.get(state.workflowId, activityId);
  if (record === undefined && !state.recordLessOk) {
    finishActivityTrace(state, activityId);
    return;
  }
  const toolName = record?.toolName ?? "unknown_tool";
  if (!state.sendToolEndEvent) {
    finishActivityTrace(state, activityId);
    return;
  }
  await sendToolCompleted(state, activityId, toolName, outcome);
  finishActivityTrace(state, activityId);
}

/** Send a same-id failed completion for a stop verdict on a start (telemetry-only). */
async function closeOrphanStart(
  state: CoreCallbackState,
  activityId: string,
  activityType: string,
  result: EvaluationResult
): Promise<void> {
  if (state.bridge.isCallbackOwned(state.workflowId, activityId, "tool_complete")) return;
  const envelope = buildActivityCompleted({
    ...identity(state),
    activityId,
    activityType,
    error: toErrorInfo(result.reason ?? `Governance ${result.verdict}`)
  });
  await evaluateLifecycleTelemetryOnly(state.runtime, envelope, logger(state));
  state.bridge.markSent(state.workflowId, activityId, "tool_complete");
}

async function sendToolCompleted(
  state: CoreCallbackState,
  activityId: string,
  toolName: string,
  outcome: { result?: unknown; error?: ErrorInfo }
): Promise<void> {
  const envelope = buildActivityCompleted({
    ...identity(state),
    activityId,
    activityType: toolName,
    result: outcome.result === undefined ? null : toJsonSafe(outcome.result),
    error: outcome.error ?? null
  });
  const verdict = await evaluateLifecycleTelemetryOnly(state.runtime, envelope, logger(state));
  if (verdict) state.bridge.stashCompletionResult(state.workflowId, activityId, verdict);
  state.bridge.markSent(state.workflowId, activityId, "tool_complete");
}
