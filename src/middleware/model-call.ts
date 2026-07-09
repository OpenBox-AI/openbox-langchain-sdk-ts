// wrapModelCall — the enforcing model-governance hook.
//
// First call in a turn REUSES the before-agent pre-screen verdict: it does NOT
// re-evaluate and does NOT re-drive approval (so a HITL run polls once, not
// twice). Redaction substitutes the guardrails redacted-input string into the
// user message and passes the MODIFIED request to the handler (a discarded copy
// would send the raw prompt). The model call runs inside an activity scope +
// trace-map fallback so base instrumentation correlates provider requests.

import { buildActivityCompleted, buildActivityStarted } from "../lifecycle-events.js";
import { buildRedactedUserMessage } from "../lifecycle-events-redaction.js";
import { extractResponseMetadata } from "../lifecycle-events-envelopes.js";
import { extractHumanTurnPrompt } from "../lifecycle-events-redaction.js";
import {
  enforceGate,
  identityFor,
  runWithCorrelation,
  sendTelemetry,
  type Awaitable,
  type MiddlewareContext
} from "./context.js";
import { isFirstLlmCall } from "./message-extraction.js";
import type { ObTurn } from "./turn-state.js";

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
    const response = await runWithCorrelation(ctx, turn, activityId, LLM_ACTIVITY_TYPE, () =>
      handler(modified)
    );
    await sendCompletion(ctx, turn, activityId, response);
    return response;
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
  const response = await runWithCorrelation(ctx, turn, activityId, LLM_ACTIVITY_TYPE, () =>
    handler(modified)
  );
  await sendCompletion(ctx, turn, activityId, response);
  return response;
}

async function sendCompletion(
  ctx: MiddlewareContext,
  turn: ObTurn,
  activityId: string,
  response: unknown
): Promise<void> {
  if (!ctx.options.sendLlmEndEvent) return;
  await sendTelemetry(
    ctx,
    buildActivityCompleted({
      ...identityFor(ctx, turn),
      activityId,
      activityType: LLM_ACTIVITY_TYPE,
      result: extractResponseMetadata(response)
    })
  );
}
