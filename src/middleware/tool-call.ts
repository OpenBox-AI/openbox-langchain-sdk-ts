// wrapToolCall — the enforcing tool-governance hook.
//
// ToolStarted (ENFORCE, throw-before-handler) -> tool body inside an activity
// scope (so base instrumentation correlates the tool's HTTP/DB work) ->
// ToolCompleted (telemetry). A stop verdict on the start closes the orphan
// started row with a failed same-id completion AND closes the workflow before
// rethrowing. Unlike the callback surface, the middleware tool input is NOT
// enriched with the `__openbox` sentinel (Python parity).

import { buildActivityCompleted, buildActivityStarted } from "../lifecycle-events.js";
import { toJsonSafe } from "../serialization.js";
import {
  enforceGate,
  errorMessage,
  identityFor,
  runWithCorrelation,
  sendTelemetry,
  type Awaitable,
  type MiddlewareContext
} from "./context.js";
import type { ObTurn } from "./turn-state.js";

interface ToolRequestLike {
  toolCall: { name: string; args?: Record<string, unknown>; id?: string };
}

export async function handleWrapToolCall<TReq extends ToolRequestLike, TRes>(
  ctx: MiddlewareContext,
  turn: ObTurn,
  request: TReq,
  handler: (request: TReq) => Awaitable<TRes>
): Promise<TRes> {
  const toolName = request.toolCall.name;
  const toolArgs = request.toolCall.args ?? {};

  if (ctx.options.skipToolTypes.has(toolName)) {
    return handler(request);
  }

  const activityId = globalThis.crypto.randomUUID();

  if (ctx.options.sendToolStartEvent) {
    await enforceGate(
      ctx,
      turn,
      buildActivityStarted({
        ...identityFor(ctx, turn),
        activityId,
        activityType: toolName,
        activityInput: [toJsonSafe(toolArgs)]
      }),
      // On a stop verdict, close the orphan started row (failed, same id).
      (error) => sendToolCompleted(ctx, turn, activityId, toolName, { error })
    );
  }

  try {
    const result = await runWithCorrelation(ctx, turn, activityId, toolName, () =>
      handler(request)
    );
    await sendToolCompleted(ctx, turn, activityId, toolName, { result });
    return result;
  } catch (bodyError) {
    // A tool BODY failure (not a governance block) — record a failed completion
    // and rethrow. Not a governance closure, so the workflow is not closed here.
    await sendToolCompleted(ctx, turn, activityId, toolName, {
      error: errorMessage(bodyError)
    });
    throw bodyError;
  }
}

async function sendToolCompleted(
  ctx: MiddlewareContext,
  turn: ObTurn,
  activityId: string,
  toolName: string,
  outcome: { result?: unknown; error?: string }
): Promise<void> {
  if (!ctx.options.sendToolEndEvent) return;
  await sendTelemetry(
    ctx,
    buildActivityCompleted({
      ...identityFor(ctx, turn),
      activityId,
      activityType: toolName,
      result: outcome.result === undefined ? null : toJsonSafe(outcome.result),
      error: outcome.error ?? null
    })
  );
}
