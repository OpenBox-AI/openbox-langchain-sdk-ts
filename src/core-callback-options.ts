// Constructor options for the observability-only core callback handler, plus the
// resolved internal state shared with the tool/LLM lifecycle helpers.

import type { ActivityBridge } from "./activity-bridge.js";
import type { Logger } from "./lifecycle-telemetry.js";
import type { ActivityContext, EvaluationResult } from "@openbox-ai/openbox-sdk";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk/runtime";

/**
 * Options for `OpenBoxLangChainCoreCallbackHandler`.
 *
 * This surface is OBSERVABILITY-ONLY: it emits lifecycle telemetry and a
 * best-effort span-correlation seam, and NEVER blocks execution. Enforcement
 * lives in the create-agent middleware.
 */
export interface OpenBoxLangChainCoreCallbackOptions {
  /** Runtime providing the client + context store the telemetry helper uses. */
  runtime: OpenBoxRuntime;
  /** Ownership channel; handler-owned, never a module-global. */
  bridge: ActivityBridge;
  workflowId: string;
  runId: string;
  workflowType: string;
  taskQueue?: string | null;
  sessionId?: string | null;
  agentName?: string | null;
  /** Emit `ActivityStarted`/`ActivityCompleted` for tool calls (default true). */
  sendToolStartEvent?: boolean;
  sendToolEndEvent?: boolean;
  /** Emit `ActivityStarted`/`ActivityCompleted` for LLM calls (default true). */
  sendLlmStartEvent?: boolean;
  sendLlmEndEvent?: boolean;
  /** Maps a tool name to a tool-type label for `__openbox` enrichment. */
  toolTypeResolver?: (toolName: string) => string | null;
  /** An already-evaluated verdict for the FIRST LLM call (avoids a duplicate send). */
  preScreenResponse?: EvaluationResult | null;
  /** The activity id the pre-screen verdict was evaluated against. */
  preScreenActivityId?: string | null;
  /**
   * When true (default), the handler may send a lifecycle event even with no
   * bridge record yet. When false (embedded under a lifecycle owner), it must
   * NOT send without a record — prevents a nested double-send.
   */
  recordLessOk?: boolean;
  /** Trace-registration seam; defaults to the runtime's context store. */
  registerTrace?: (traceId: string, ctx: ActivityContext) => void;
  unregisterTrace?: (traceId: string) => void;
  /** Diagnostic sink for suppressed telemetry-send failures. */
  logger?: Logger;
}

/** Mutable pre-screen slot (consumed once by the first LLM call). */
export interface PreScreenSlot {
  response: EvaluationResult;
  activityId: string;
}

/** Resolved handler state (defaults applied) shared with the lifecycle helpers. */
export interface CoreCallbackState {
  runtime: OpenBoxRuntime;
  bridge: ActivityBridge;
  workflowId: string;
  runId: string;
  workflowType: string;
  taskQueue: string | null;
  sessionId: string | null;
  agentName: string | null;
  sendToolStartEvent: boolean;
  sendToolEndEvent: boolean;
  sendLlmStartEvent: boolean;
  sendLlmEndEvent: boolean;
  toolTypeResolver: ((toolName: string) => string | null) | null;
  recordLessOk: boolean;
  logger: Logger | undefined;
  /** Consumed-once pre-screen verdict for the first LLM call. */
  preScreen: PreScreenSlot | null;
  registerTrace: (traceId: string, ctx: ActivityContext) => void;
  unregisterTrace: (traceId: string) => void;
  /** eventKey (run id) -> registered trace id, so completion can unregister. */
  traceHandles: Map<string, string>;
}

/** Common event-builder identity fields derived from the state. */
export function callbackIdentity(state: CoreCallbackState): {
  workflowId: string;
  runId: string;
  workflowType: string;
  taskQueue: string | null;
  sessionId: string | null;
  agentName: string | null;
} {
  return {
    workflowId: state.workflowId,
    runId: state.runId,
    workflowType: state.workflowType,
    taskQueue: state.taskQueue,
    sessionId: state.sessionId,
    agentName: state.agentName
  };
}

/** Wrap the state's logger into the telemetry-helper options shape. */
export function callbackLoggerOpt(state: CoreCallbackState): { logger?: Logger } {
  return state.logger ? { logger: state.logger } : {};
}
