// wrapModelCall — the enforcing model-governance hook.
//
// First call in a turn REUSES the before-agent pre-screen verdict: it does NOT
// re-evaluate and does NOT re-drive approval (so a HITL run polls once, not
// twice). Redaction substitutes the guardrails redacted-input string into the
// user message and passes the MODIFIED request to the handler (a discarded copy
// would send the raw prompt). The model call runs inside an activity scope +
// trace-map fallback so base instrumentation correlates provider requests.

import { toErrorInfo } from "../error-info.js";
import { buildActivityCompleted, buildActivityStarted } from "../lifecycle-events.js";
import {
  buildRedactedUserMessage,
  extractHumanTurnPrompt
} from "../lifecycle-events-redaction.js";
import { extractResponseMetadata } from "../lifecycle-events-envelopes.js";
import {
  closeWorkflow,
  enforceGate,
  identityFor,
  runWithCorrelation,
  sendTelemetry,
  type Awaitable,
  type MiddlewareContext
} from "./context.js";
import { isFirstLlmCall } from "./message-extraction.js";
import type { ObTurn } from "./turn-state.js";
import type { ErrorInfo } from "@openbox-ai/openbox-sdk-ts";

const LLM_ACTIVITY_TYPE = "llm_call";

interface ModelRequestLike {
  messages: unknown[];
}

/** Splice the redacted user message into a NEW request; unchanged if nothing to redact. */
function applyRedaction<TReq extends ModelRequestLike>(
  request: TReq,
  redactedInput: unknown
): TReq {
  const redacted = buildRedactedUserMessage(request.messages, redactedInput);
  if (redacted === null) return request;
  const messages = [...request.messages];
  messages[redacted.index] = redacted.message;
  return { ...request, messages };
}

export async function handleWrapModelCall<TReq extends ModelRequestLike, TRes>(
  ctx: MiddlewareContext,
  turn: ObTurn,
  request: TReq,
  handler: (request: TReq) => Awaitable<TRes>
): Promise<TRes> {
  const promptText = extractHumanTurnPrompt(request.messages);

  // First call: reuse the pre-screen verdict (no re-evaluate, no re-poll).
  if (turn.preScreen !== null && isFirstLlmCall(request.messages)) {
    const activityId = turn.preScreen.activityId;
    const modified = applyRedaction(request, turn.preScreen.redactedInput);
    try {
      const response = await runWithCorrelation(ctx, turn, activityId, LLM_ACTIVITY_TYPE, () =>
        handler(modified)
      );
      await sendCompletion(ctx, turn, activityId, response);
      return response;
    } catch (callError) {
      await closeForError(ctx, turn, activityId, callError);
      throw callError;
    }
  }

  // Fresh call: enforce a model-start gate (send flag also gates enforcement).
  const activityId = globalThis.crypto.randomUUID();
  let redactedInput: unknown = null;
  if (ctx.options.sendLlmStartEvent) {
    const result = await enforceGate(
      ctx,
      turn,
      buildActivityStarted({
        ...identityFor(ctx, turn),
        activityId,
        activityType: LLM_ACTIVITY_TYPE,
        activityInput: [{ prompt: promptText }]
      })
    );
    redactedInput = result.guardrails?.redactedInput ?? null;
  }

  const modified = applyRedaction(request, redactedInput);
  try {
    const response = await runWithCorrelation(ctx, turn, activityId, LLM_ACTIVITY_TYPE, () =>
      handler(modified)
    );
    await sendCompletion(ctx, turn, activityId, response);
    return response;
  } catch (callError) {
    await closeForError(ctx, turn, activityId, callError);
    throw callError;
  }
}

/**
 * Close the records a failed model call would otherwise leave open.
 *
 * Every started row is answered exactly once: an ActivityStarted by one
 * ActivityCompleted, a WorkflowStarted by one close. The model call had no
 * error path, so anything thrown by the handler — a governance verdict raised
 * below this layer, an unverifiable inference receipt, a refused route, a plain
 * network fault — skipped the completion AND the workflow close, leaving the
 * session `pending` for ever with spans hanging off an activity that never
 * finished. `wrapToolCall` has answered a failed body this way since it was
 * written; this is the same treatment for the model call.
 *
 * The workflow closes here because a throw from the model call ends the run:
 * unlike a tool body, whose failure the agent may recover from and continue
 * past, nothing above this catches it. `closeWorkflow` is idempotent, so a
 * later close is still a no-op.
 */
async function closeForError(
  ctx: MiddlewareContext,
  turn: ObTurn,
  activityId: string,
  callError: unknown
): Promise<void> {
  const info: ErrorInfo = toErrorInfo(callError);
  await sendCompletion(ctx, turn, activityId, null, info);
  await closeWorkflow(ctx, turn, info);
}

async function sendCompletion(
  ctx: MiddlewareContext,
  turn: ObTurn,
  activityId: string,
  response: unknown,
  error?: ErrorInfo
): Promise<void> {
  if (!ctx.options.sendLlmEndEvent) return;
  await sendTelemetry(
    ctx,
    buildActivityCompleted({
      ...identityFor(ctx, turn),
      activityId,
      activityType: LLM_ACTIVITY_TYPE,
      result: error === undefined ? extractResponseMetadata(response) : null,
      error: error ?? null
    })
  );
}
