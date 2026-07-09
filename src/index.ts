// Root entry point — MUST stay import-light.
//
// Only pure, side-effect-free symbols are re-exported here: SDK identity
// constants plus (added incrementally) the ActivityBridge, the
// observability-only core callback handler, and the lifecycle/telemetry
// helpers. This module MUST NOT statically import `langchain`,
// `@langchain/langgraph`, base-SDK instrumentation, network, or crypto — those
// live behind the `./middleware` subpath or lazy imports. The
// `scripts/check-root-import-light.mjs` guard and
// `test/package-boundaries.test.ts` both enforce this.

export { SDK_VERSION } from "./version.js";
export { SDK_ENGINE, SDK_LANGUAGE, SDK_PACKAGE_VERSION } from "./sdk-metadata.js";

// ActivityBridge — pure, framework-neutral ownership tracking for the
// observability callback surface (no network, no langchain).
export { ActivityBridge } from "./activity-bridge.js";
export type {
  ActivityRecord,
  EventType,
  ToolRecordMetadata
} from "./activity-bridge-records.js";

// Lifecycle event helpers — envelope builders (snake_case session/agent
// injection), tool-input enrichment, model-response metadata, human-prompt
// extraction, and input redaction. Pure; base-SDK factories only.
export {
  buildActivityCompleted,
  buildActivityStarted,
  buildSignalReceived,
  buildWorkflowCompleted,
  buildWorkflowFailed,
  buildWorkflowStarted,
  mergeSessionExtra
} from "./lifecycle-events.js";
export type {
  ActivityCompletedBuild,
  ActivityStartedBuild,
  LifecycleEventIdentity,
  SignalReceivedBuild,
  WorkflowFailedBuild
} from "./lifecycle-events.js";
export {
  enrichActivityInput,
  extractResponseMetadata
} from "./lifecycle-events-envelopes.js";
export {
  buildRedactedUserMessage,
  coerceRedactedText,
  extractHumanTurnPrompt
} from "./lifecycle-events-redaction.js";
export type { RedactedMessage } from "./lifecycle-events-redaction.js";

// The load-bearing non-enforcing telemetry evaluator, used by every completion
// event and observer send on both surfaces.
export { evaluateLifecycleTelemetryOnly } from "./lifecycle-telemetry.js";
export type { Logger, TelemetryEvaluateOptions } from "./lifecycle-telemetry.js";

// Observability-only core callback handler. Emits lifecycle telemetry + a
// best-effort span-correlation seam; NEVER blocks (enforcement is the
// middleware's job). Imports @langchain/core (allowed at root), never langchain.
export { OpenBoxLangChainCoreCallbackHandler } from "./core-callback.js";
export type { OpenBoxLangChainCoreCallbackOptions } from "./core-callback-options.js";
