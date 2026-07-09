// Shared runtime context + enforcement/telemetry/correlation helpers for the
// middleware hooks. The hooks are the SOLE enforcement surface: gates call
// `runtime.evaluateLifecycle` (which evaluates AND enforces — throwing on
// BLOCK/HALT and driving approval), and every telemetry send goes through the
// non-enforcing evaluator.

import { buildWorkflowFailed, type LifecycleEventIdentity } from "../lifecycle-events.js";
import { evaluateLifecycleTelemetryOnly } from "../lifecycle-telemetry.js";
import type { ResolvedMiddlewareOptions } from "./options.js";
import type { ObTurn } from "./turn-state.js";
import { ActivityContext, type EvaluationResult, type EventEnvelope } from "@openbox-ai/openbox-sdk";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk/runtime";

/** A value or a promise of it — LangChain wrap handlers may return either. */
export type Awaitable<T> = T | Promise<T>;

/** Everything the hooks need beyond per-invocation turn state. */
export interface MiddlewareContext {
  runtime: OpenBoxRuntime;
  options: ResolvedMiddlewareOptions;
  workflowType: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Identity fields for the lifecycle event builders. */
export function identityFor(ctx: MiddlewareContext, turn: ObTurn): LifecycleEventIdentity {
  return {
    workflowId: turn.workflowId,
    runId: turn.runId,
    workflowType: ctx.workflowType,
    taskQueue: ctx.options.taskQueue,
    sessionId: ctx.options.sessionId,
    agentName: ctx.options.agentName
  };
}

/** Best-effort telemetry send (never enforces, never throws for a verdict). */
export async function sendTelemetry(
  ctx: MiddlewareContext,
  envelope: EventEnvelope
): Promise<EvaluationResult | null> {
  return evaluateLifecycleTelemetryOnly(
    ctx.runtime,
    envelope,
    ctx.options.logger ? { logger: ctx.options.logger } : {}
  );
}

/**
 * Send `workflowFailed` and mark the turn closed, once. Called by every
 * enforcing gate BEFORE it rethrows a block, so workflow-closure telemetry is
 * never lost on a blocked run (afterAgent does not run after a throw).
 */
export async function closeWorkflow(
  ctx: MiddlewareContext,
  turn: ObTurn,
  error: string
): Promise<void> {
  if (turn.workflowClosed) return;
  turn.workflowClosed = true;
  await sendTelemetry(ctx, buildWorkflowFailed({ ...identityFor(ctx, turn), error }));
}

/**
 * Evaluate + enforce a start-stage gate. On a block (or rejected approval) the
 * runtime throws; this closes the workflow (and any orphan start row) first,
 * then rethrows so the wrapped call never runs.
 */
export async function enforceGate(
  ctx: MiddlewareContext,
  turn: ObTurn,
  envelope: EventEnvelope,
  orphanClose?: (error: string) => Promise<void>
): Promise<EvaluationResult> {
  try {
    return await ctx.runtime.evaluateLifecycle(envelope);
  } catch (error) {
    const message = errorMessage(error);
    if (orphanClose) await orphanClose(message);
    await closeWorkflow(ctx, turn, message);
    throw error;
  }
}

/**
 * Run `invoke` inside an activity scope bound to the runtime's context store,
 * also registering a trace-map fallback (via the `traceId`) so base
 * instrumentation can correlate a detached provider fetch that escapes ALS.
 */
export function runWithCorrelation<R>(
  ctx: MiddlewareContext,
  turn: ObTurn,
  activityId: string,
  activityType: string,
  invoke: () => R
): R {
  const activityContext = new ActivityContext({
    workflowId: turn.workflowId,
    runId: turn.runId,
    workflowType: ctx.workflowType,
    taskQueue: ctx.options.taskQueue,
    activityId,
    activityType,
    agentName: ctx.options.agentName,
    sessionId: ctx.options.sessionId
  });
  const traceId = globalThis.crypto.randomUUID().replaceAll("-", "");
  return ctx.runtime.contextStore.activityScope(activityContext, { traceId }, invoke);
}
