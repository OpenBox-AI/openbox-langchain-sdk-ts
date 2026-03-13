/**
 * OpenBox LangChain SDK — Public API
 *
 * @example
 * ```typescript
 * import { createOpenBoxHandler } from "@openbox/langchain-sdk";
 *
 * const handler = await createOpenBoxHandler({
 *   apiUrl: process.env.OPENBOX_URL!,
 *   apiKey: process.env.OPENBOX_API_KEY!,
 * });
 *
 * const chain = new ConversationChain({ llm, callbacks: [handler] });
 * ```
 */

// ═══════════════════════════════════════════════════════════════════
// Core exports
// ═══════════════════════════════════════════════════════════════════

export {
  initialize,
  getGlobalConfig,
  mergeConfig,
  type GovernanceConfig,
  type InitializeOptions,
  type PartialGovernanceConfig,
} from "./config.js";

export {
  OpenBoxCallbackHandler,
  type OpenBoxCallbackHandlerOptions,
} from "./callback-handler.js";

export { GovernanceClient, type GovernanceClientConfig } from "./client.js";

export { RunBufferManager, type RunBuffer, type RunType } from "./run-buffer.js";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export {
  Verdict,
  verdictFromString,
  verdictPriority,
  highestPriorityVerdict,
  verdictShouldStop,
  verdictRequiresApproval,
  type LangChainEventType,
  type LangChainGovernanceEvent,
  type GovernanceVerdictResponse,
  type GuardrailsResult,
  type GuardrailsReason,
  type ApprovalResponse,
  type HITLConfig,
  DEFAULT_HITL_CONFIG,
  parseGovernanceResponse,
  parseApprovalResponse,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════

export {
  OpenBoxError,
  OpenBoxAuthError,
  OpenBoxNetworkError,
  OpenBoxInsecureURLError,
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
  ApprovalExpiredError,
  ApprovalRejectedError,
  ApprovalTimeoutError,
} from "./errors.js";

// ═══════════════════════════════════════════════════════════════════
// Utilities (advanced usage)
// ═══════════════════════════════════════════════════════════════════

export {
  enforceVerdict,
  eventTypeToContext,
  isHITLApplicable,
  type VerdictContext,
} from "./verdict-handler.js";

export { pollUntilDecision, type HITLPollParams } from "./hitl.js";

export {
  OpenBoxSignalMonitor,
  type SignalMonitorConfig,
  type SignalMonitorStatus,
} from "./signal-monitor.js";

export {
  applyInputRedaction,
  applyOutputRedaction,
  getGuardrailsReasons,
} from "./guardrails.js";

export {
  safeSerialize,
  extractPromptText,
  extractCompletionText,
  extractTokenUsage,
  extractModelName,
  extractFinishReason,
  rfc3339Now,
} from "./serializer.js";

// ═══════════════════════════════════════════════════════════════════
// Phase 2: Tool & LLM Wrappers
// ═══════════════════════════════════════════════════════════════════

export {
  wrapTool,
  wrapTools,
  wrapLLM,
  type WrappableTool,
} from "./wrappers.js";

// ═══════════════════════════════════════════════════════════════════
// Phase 3: HTTP Telemetry
// ═══════════════════════════════════════════════════════════════════

export {
  SpanCollector,
  globalSpanCollector,
  patchFetch,
  unpatchFetch,
  isFetchPatched,
  setupTelemetry,
  type HttpSpan,
  type TelemetryOptions,
} from "./telemetry.js";

// ═══════════════════════════════════════════════════════════════════
// Hook-Level Governance (PR #5 equivalent)
// ═══════════════════════════════════════════════════════════════════

export {
  configureHookGovernance,
  resetHookGovernance,
  isHookGovernanceConfigured,
  evaluateHttpHook,
} from "./hook-governance.js";

export {
  type HookStage,
  type HttpHookTrigger,
  type HookTrigger,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// Phase 3: Streaming
// ═══════════════════════════════════════════════════════════════════

export {
  StreamingTokenBuffer,
  globalStreamingBuffer,
  type StreamingBuffer,
} from "./streaming.js";

// ═══════════════════════════════════════════════════════════════════
// Factory function (mirrors create_openbox_worker from Temporal SDK)
// ═══════════════════════════════════════════════════════════════════

import { initialize } from "./config.js";
import { OpenBoxCallbackHandler, OpenBoxCallbackHandlerOptions } from "./callback-handler.js";
import { InitializeOptions } from "./config.js";
import { setupTelemetry as _setupTelemetry } from "./telemetry.js";

export interface CreateOpenBoxHandlerOptions
  extends InitializeOptions,
    Omit<OpenBoxCallbackHandlerOptions, "client"> {
  /**
   * If true, creates an AbortController + OpenBoxSignalMonitor and attaches them
   * to the handler automatically. The controller is accessible via handler.abortController.
   * Pass the controller's signal to your LangChain executor's RunnableConfig.
   */
  enableSignalMonitor?: boolean;
  /** Config for the signal monitor (only used if enableSignalMonitor is true). */
  signalMonitorConfig?: import("./signal-monitor.js").SignalMonitorConfig;
}

/**
 * Factory function: validates the API key, then returns a fully configured
 * OpenBoxCallbackHandler ready to attach to any LangChain chain or agent.
 *
 * @example
 * ```typescript
 * const handler = await createOpenBoxHandler({
 *   apiUrl: process.env.OPENBOX_URL!,
 *   apiKey: process.env.OPENBOX_API_KEY!,
 *   onApiError: "fail_closed",
 *   hitl: { enabled: true, pollIntervalMs: 5000, maxWaitMs: 300000 },
 * });
 *
 * const executor = new AgentExecutor({ agent, tools, callbacks: [handler] });
 * ```
 */
export async function createOpenBoxHandler(
  options: CreateOpenBoxHandlerOptions
): Promise<OpenBoxCallbackHandler> {
  await initialize({
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
    governanceTimeout: options.governanceTimeout,
    validate: options.validate ?? true,
  });

  const {
    apiUrl: _u, apiKey: _k, governanceTimeout: _t, validate: _v,
    enableSignalMonitor, signalMonitorConfig,
    ...handlerOptions
  } = options;
  void _u; void _k; void _t; void _v;

  if (enableSignalMonitor) {
    const { OpenBoxSignalMonitor: SignalMonitor } = await import("./signal-monitor.js");
    const { GovernanceClient: GClient } = await import("./client.js");
    const { globalConfig } = await import("./config.js");
    const gc = globalConfig.get();
    const client = new GClient({
      apiUrl: gc.apiUrl,
      apiKey: gc.apiKey,
      timeout: gc.governanceTimeout,
      onApiError: handlerOptions.onApiError ?? "fail_open",
    });
    const monitor = new SignalMonitor(client, signalMonitorConfig);
    const controller = new AbortController();
    handlerOptions.signalMonitor = monitor;
    handlerOptions.abortController = controller;
  }

  return new OpenBoxCallbackHandler(handlerOptions);
}
