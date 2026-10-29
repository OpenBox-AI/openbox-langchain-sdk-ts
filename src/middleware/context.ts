// Shared runtime context + enforcement/telemetry/correlation helpers for the
// middleware hooks. The hooks are the SOLE enforcement surface: gates call
// `runtime.evaluateLifecycle` (which evaluates AND enforces — throwing on
// BLOCK/HALT and driving approval), and every telemetry send goes through the
// non-enforcing evaluator.

import { toErrorInfo } from "../error-info.js";
import { buildWorkflowFailed, type LifecycleEventIdentity } from "../lifecycle-events.js";
import { evaluateLifecycleTelemetryOnly } from "../lifecycle-telemetry.js";
import type { ResolvedMiddlewareOptions } from "./options.js";
import type { ObTurn } from "./turn-state.js";
import {
  ActivityContext,
  ApprovalExpiredError,
  ApprovalRejectedError,
  ApprovalTimeoutError,
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
  verdictRequiresApproval,
  type ErrorInfo,
  type EvaluationResult,
  type EventEnvelope
} from "@openbox-ai/openbox-sdk-ts";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

/** A value or a promise of it — LangChain wrap handlers may return either. */
export type Awaitable<T> = T | Promise<T>;

/** Everything the hooks need beyond per-invocation turn state. */
export interface MiddlewareContext {
  runtime: OpenBoxRuntime;
  options: ResolvedMiddlewareOptions;
  workflowType: string;
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
 * Log a REQUIRE_APPROVAL returned on a model or tool ActivityCompleted. The
 * call already ran, so there is nothing left to gate: the run continues
 * without waiting, as in the other OpenBox SDKs — this only says why the
 * request stays pending on the dashboard.
 */
export function noteCompletionVerdict(
  ctx: MiddlewareContext,
  result: EvaluationResult | null,
  activityType: string
): void {
  if (result === null || !verdictRequiresApproval(result.verdict)) return;
  (ctx.options.logger ?? console).warn(
    `REQUIRE_APPROVAL returned after ${activityType} completed; continuing without waiting. ` +
      "Match the rule on ActivityStarted to gate the operation." +
      (result.reason ? ` Reason: ${result.reason}` : "")
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
  error: ErrorInfo
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
  orphanClose?: (error: ErrorInfo) => Promise<void>
): Promise<EvaluationResult> {
  try {
    return await ctx.runtime.evaluateLifecycle(envelope);
  } catch (error) {
    // Convert the caught error ONCE — name/stack survive to the wire (e.g.
    // `type: "ApprovalRejectedError"`), and the original error still rethrows.
    const info = toErrorInfo(error);
    if (orphanClose) await orphanClose(info);
    await closeWorkflow(ctx, turn, info);
    throw error;
  }
}

/**
 * The governance refusal behind `error`, if any. A hook-level stop raised
 * inside a provider's `fetch` reaches the caller wrapped by that client (the
 * OpenAI client reports it as "Connection error."), hiding the real reason.
 */
export function governanceCause(error: unknown): Error | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (
      current instanceof GovernanceBlockedError ||
      current instanceof GovernanceHaltError ||
      current instanceof GuardrailsValidationError ||
      current instanceof ApprovalRejectedError ||
      current instanceof ApprovalExpiredError ||
      current instanceof ApprovalTimeoutError
    ) {
      return current;
    }
    seen.add(current);
    current = current.cause;
  }
  return null;
}

/**
 * Run a model call or tool body inside its activity scope. A governance stop
 * raised by a hook inside it closes the workflow (afterAgent never runs after
 * a throw) and is rethrown as itself rather than as the client's wrapper.
 */
export async function runGoverned<R>(
  ctx: MiddlewareContext,
  turn: ObTurn,
  activityId: string,
  activityType: string,
  invoke: () => Awaitable<R>
): Promise<R> {
  try {
    return await runWithCorrelation(ctx, turn, activityId, activityType, invoke);
  } catch (error) {
    const governance = governanceCause(error);
    if (governance === null) throw error;
    await closeWorkflow(ctx, turn, toErrorInfo(governance));
    throw governance;
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
