// LLM lifecycle telemetry for the observability callback surface.
//
// Telemetry + span-correlation only: NO enforcement and NO redaction here
// (callbacks cannot reliably mutate provider input — redaction is a middleware
// capability). Pre-screen reuse + the run-id alias let the first LLM call reuse
// an upstream verdict without a duplicate send or an orphan completion id.

import { buildActivityCompleted, buildActivityStarted } from "./lifecycle-events.js";
import { extractResponseMetadata } from "./lifecycle-events-envelopes.js";
import { extractHumanTurnPrompt } from "./lifecycle-events-redaction.js";
import { evaluateLifecycleTelemetryOnly } from "./lifecycle-telemetry.js";
import {
  callbackIdentity as identity,
  callbackLoggerOpt as logger,
  type CoreCallbackState
} from "./core-callback-options.js";
import { finishActivityTrace, registerActivityTrace } from "./core-callback-trace.js";
import type { EventEnvelope } from "@openbox-ai/openbox-sdk";

export const LLM_ACTIVITY_TYPE = "llm_call";

function buildLlmStartedEnvelope(
  state: CoreCallbackState,
  activityId: string,
  messages: unknown
): EventEnvelope {
  // Empty prompt still sends an empty activity_input entry (consistent shape).
  const prompt = extractHumanTurnPrompt(messages);
  return buildActivityStarted({
    ...identity(state),
    activityId,
    activityType: LLM_ACTIVITY_TYPE,
    activityInput: [{ prompt }]
  });
}

/** Handle a chat-model start: emit `ActivityStarted` telemetry (or reuse a pre-screen). */
export async function handleChatModelStartTelemetry(
  state: CoreCallbackState,
  _llm: unknown,
  messages: unknown,
  runId: string
): Promise<void> {
  const eventRunId = runId;

  // Resolve the alias FIRST so a cross-dispatched second call reuses the first
  // call's aliased record and verdict rather than re-deciding the branch.
  const existing = state.bridge.getByEventRunId(state.workflowId, eventRunId);
  let activityId: string;

  if (existing?.startResult != null) {
    activityId = existing.activityId;
    if (state.preScreen?.activityId === activityId) state.preScreen = null;
  } else if (state.preScreen !== null) {
    // Reuse the upstream pre-screen verdict for the first call (consumed once).
    activityId = state.preScreen.activityId;
    const result = state.preScreen.response;
    state.bridge.prepareLlm(state.workflowId, activityId, { eventRunId });
    state.bridge.markSent(state.workflowId, activityId, "llm_start");
    state.bridge.stashStartResult(state.workflowId, activityId, result);
    state.preScreen = null;
  } else {
    activityId = eventRunId;
    state.bridge.prepareLlm(state.workflowId, activityId, { eventRunId });
    if (!state.sendLlmStartEvent) return;
    const envelope = buildLlmStartedEnvelope(state, activityId, messages);
    const result = await evaluateLifecycleTelemetryOnly(state.runtime, envelope, logger(state));
    state.bridge.markSent(state.workflowId, activityId, "llm_start");
    if (result) state.bridge.stashStartResult(state.workflowId, activityId, result);
  }

  registerActivityTrace(state, eventRunId, activityId, LLM_ACTIVITY_TYPE);
}

/** Handle an LLM end/error: emit a same-id `ActivityCompleted`, guarded against double-send. */
export async function handleLlmCompletionTelemetry(
  state: CoreCallbackState,
  runId: string,
  outcome: { response?: unknown; error?: string }
): Promise<void> {
  const eventRunId = runId;
  const record = state.bridge.getByEventRunId(state.workflowId, eventRunId);

  let activityId: string;
  if (record === undefined) {
    if (!state.recordLessOk) {
      finishActivityTrace(state, eventRunId);
      return;
    }
    activityId = eventRunId;
  } else {
    activityId = record.activityId;
  }

  if (state.bridge.isCallbackOwned(state.workflowId, activityId, "llm_complete")) {
    finishActivityTrace(state, eventRunId);
    return;
  }
  if (!state.sendLlmEndEvent) {
    finishActivityTrace(state, eventRunId);
    return;
  }

  const envelope = buildActivityCompleted({
    ...identity(state),
    activityId,
    activityType: LLM_ACTIVITY_TYPE,
    result:
      outcome.response === undefined ? null : extractResponseMetadata(outcome.response),
    error: outcome.error ?? null
  });
  const verdict = await evaluateLifecycleTelemetryOnly(state.runtime, envelope, logger(state));
  if (verdict) state.bridge.stashCompletionResult(state.workflowId, activityId, verdict);
  state.bridge.markSent(state.workflowId, activityId, "llm_complete");
  finishActivityTrace(state, eventRunId);
}
