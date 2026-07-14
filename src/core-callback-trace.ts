// Best-effort span-correlation seam for the observability callback surface.
//
// The callback does not scope AsyncLocalStorage around the actual tool/model
// execution (it only fires notifications), so it cannot bind context the way
// the middleware does. It instead registers the activity context under a fresh
// trace id via the context store's trace map — the "correlation seam" the
// integrating layer / instrumentation can resolve against. This is best-effort;
// the enforcing middleware is the primary, supported correlation path.

import type { CoreCallbackState } from "./core-callback-options.js";
import { ActivityContext } from "@openbox-ai/openbox-sdk-ts";

/** Generate a 32-hex trace id (the shape the context store's trace map accepts). */
function freshTraceId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

function buildActivityContext(
  state: CoreCallbackState,
  activityId: string,
  activityType: string
): ActivityContext {
  return new ActivityContext({
    workflowId: state.workflowId,
    runId: state.runId,
    workflowType: state.workflowType,
    taskQueue: state.taskQueue,
    activityId,
    activityType,
    agentName: state.agentName,
    sessionId: state.sessionId
  });
}

/**
 * Register a trace for one activity, keyed by `eventKey` (the run id) so the
 * matching completion can unregister it. Idempotent per event key.
 */
export function registerActivityTrace(
  state: CoreCallbackState,
  eventKey: string,
  activityId: string,
  activityType: string
): void {
  if (state.traceHandles.has(eventKey)) return;
  const traceId = freshTraceId();
  state.traceHandles.set(eventKey, traceId);
  try {
    state.registerTrace(traceId, buildActivityContext(state, activityId, activityType));
  } catch (error) {
    // Correlation is best-effort; a registration failure must not break telemetry.
    state.logger?.warn(`OpenBox trace registration failed: ${String(error)}`);
  }
}

/** Unregister and drop the trace for an event key, if any. */
export function finishActivityTrace(state: CoreCallbackState, eventKey: string): void {
  const traceId = state.traceHandles.get(eventKey);
  if (traceId === undefined) return;
  state.traceHandles.delete(eventKey);
  try {
    state.unregisterTrace(traceId);
  } catch (error) {
    state.logger?.warn(`OpenBox trace unregistration failed: ${String(error)}`);
  }
}
