/**
 * OpenBox LangChain SDK — Tool & LLM Wrappers
 *
 * These wrappers provide full in-place guardrails redaction parity with the
 * Temporal SDK. In Temporal, the SDK mutates input.args directly before
 * execute_activity() runs. In LangChain, callbacks are observational — the tool
 * has already received its input by the time handleToolStart fires.
 *
 * Solution: wrap the tool/LLM so that execution is intercepted AFTER governance
 * evaluates and BEFORE the underlying implementation runs.
 *
 * Usage:
 *   const safeTool = wrapTool(myTool, handler);
 *   const safeLLM  = wrapLLM(myChatModel, handler);
 */

import type { BaseLanguageModelInterface } from "@langchain/core/language_models/base";

import { OpenBoxCallbackHandler } from "./callback-handler.js";
import { GovernanceBlockedError } from "./errors.js";
import { pollUntilDecision } from "./hitl.js";
import type { HITLConfig } from "./types.js";

/** Minimal interface for any LangChain tool that has a _call method */
export interface WrappableTool {
  name: string;
  _call(input: unknown, runManager?: unknown): Promise<string>;
}

// ═══════════════════════════════════════════════════════════════════
// wrapTool
// ═══════════════════════════════════════════════════════════════════

/**
 * Wraps a LangChain tool so that:
 * 1. Guardrails-redacted input is used for execution (existing behaviour).
 * 2. A REQUIRE_APPROVAL verdict from a hook-level governance evaluation triggers
 *    HITL polling before retrying the tool call — mirroring the Temporal SDK's
 *    retryable ApplicationError(type="ApprovalPending") flow.
 *
 * @example
 * ```typescript
 * const safeTool = wrapTool(searchTool, handler);
 * const agent = createReactAgent({ llm, tools: [safeTool] });
 * ```
 */
export function wrapTool<T extends WrappableTool>(
  tool: T,
  handler: OpenBoxCallbackHandler
): T {
  const original = tool._call.bind(tool);

  // Override _call to intercept input after governance has run
  (tool as unknown as Record<string, unknown>)["_call"] = async function (
    input: unknown,
    runManager?: unknown
  ): Promise<string> {
    const runId = _extractRunId(runManager);

    // Resolve effective input (may be guardrails-redacted)
    const effectiveInput = (runId && handler.getRedactedInput(runId) !== undefined)
      ? handler.getRedactedInput(runId)
      : input;

    try {
      const toolResult = await original(
        effectiveInput as Parameters<typeof original>[0],
        runManager as Parameters<typeof original>[1]
      );
      // ── Post-execution AGE evaluation: send ToolCompleted event inline here,
      // before returning to LangChain, so REQUIRE_APPROVAL/BLOCK verdicts from
      // Behavior Rules can block the return value.
      // LangChain calls _call first, then handleToolEnd — by doing it here we
      // gate the return. handleToolEnd will skip re-evaluation via the wrapper flag.
      if (runId) {
        await handler.evaluateToolCompleted(runId, toolResult);
        // If output guardrails redacted the tool result, return the redacted version
        const redactedOutput = handler.getRedactedOutput(runId);
        if (redactedOutput !== undefined) {
          return typeof redactedOutput === "string" ? redactedOutput : JSON.stringify(redactedOutput);
        }
      }
      return toolResult;
    } catch (err) {
      // ── Hook-level REQUIRE_APPROVAL: poll for human decision, then retry once
      // Mirrors activity_interceptor raising retryable ApplicationError("ApprovalPending")
      if (
        err instanceof GovernanceBlockedError &&
        err.verdict === "require_approval" &&
        runId
      ) {
        const hitlConfig = _getHITLConfig(handler);
        if (hitlConfig.enabled) {
          const rootRunId = _getRootRunId(handler, runId);
          // Block until approved, rejected, or timed-out
          await pollUntilDecision(
            _getClient(handler),
            {
              workflowId: rootRunId,
              runId: rootRunId,
              activityId: runId,
              activityType: tool.name,
            },
            hitlConfig
          );
          // Approval granted — clear abort flag and retry the tool call once
          _clearAbort(handler, runId);
          return await original(
            effectiveInput as Parameters<typeof original>[0],
            runManager as Parameters<typeof original>[1]
          );
        }
      }
      throw err;
    }
  };

  return tool;
}

/**
 * Wrap an array of tools at once.
 */
export function wrapTools<T extends WrappableTool>(
  tools: T[],
  handler: OpenBoxCallbackHandler
): T[] {
  return tools.map((t) => wrapTool(t, handler));
}

// ═══════════════════════════════════════════════════════════════════
// wrapLLM
// ═══════════════════════════════════════════════════════════════════

/**
 * Wraps a LangChain LLM/ChatModel so that guardrails-redacted prompts
 * are sent to the model instead of the original prompts.
 *
 * @example
 * ```typescript
 * const safeLLM = wrapLLM(new ChatOpenAI({ model: "gpt-4o" }), handler);
 * const chain = new ConversationChain({ llm: safeLLM, callbacks: [handler] });
 * ```
 */
export function wrapLLM<T extends BaseLanguageModelInterface>(
  llm: T,
  handler: OpenBoxCallbackHandler
): T {
  // Wrap the generate method (used by both LLMs and ChatModels)
  const originalGenerate = (llm as unknown as Record<string, unknown>)["generate"];
  if (typeof originalGenerate === "function") {
    (llm as unknown as Record<string, unknown>)["generate"] = async function (
      inputs: unknown[],
      options?: unknown,
      callbacks?: unknown
    ): Promise<unknown> {
      const runId = _extractRunIdFromOptions(options);
      if (runId) {
        const redacted = handler.getRedactedInput(runId);
        if (redacted !== undefined && Array.isArray(redacted)) {
          return (originalGenerate as Function).call(this, redacted, options, callbacks);
        }
      }
      return (originalGenerate as Function).call(this, inputs, options, callbacks);
    };
  }

  return llm;
}

// ═══════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════

function _extractRunId(runManager: unknown): string | undefined {
  if (!runManager || typeof runManager !== "object") return undefined;
  const rm = runManager as Record<string, unknown>;
  // LangChain CallbackManagerForToolRun exposes runId
  if (typeof rm["runId"] === "string") return rm["runId"];
  if (typeof rm["run_id"] === "string") return rm["run_id"];
  return undefined;
}

function _extractRunIdFromOptions(options: unknown): string | undefined {
  if (!options || typeof options !== "object") return undefined;
  const opts = options as Record<string, unknown>;
  if (typeof opts["runId"] === "string") return opts["runId"];
  if (typeof opts["run_id"] === "string") return opts["run_id"];
  // May be nested under callbacks
  const callbacks = opts["callbacks"];
  if (callbacks && typeof callbacks === "object") {
    const cbs = callbacks as Record<string, unknown>;
    if (typeof cbs["runId"] === "string") return cbs["runId"];
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────
// Internal accessors for hook-level HITL in wrapTool
// ─────────────────────────────────────────────────────────────────

function _getHITLConfig(handler: OpenBoxCallbackHandler): HITLConfig {
  return handler._getConfig().hitl;
}

function _getClient(handler: OpenBoxCallbackHandler) {
  return handler._getClient();
}

function _getRootRunId(handler: OpenBoxCallbackHandler, runId: string): string {
  return handler._getBuffer().getRootRunId(runId);
}

function _clearAbort(handler: OpenBoxCallbackHandler, runId: string): void {
  // Re-register doesn't exist, but we can clear by mutating the buffer entry.
  // The buffer stores aborted/haltRequested on the RunBuffer object directly —
  // access via getBuffer() and clear the flags so the retry can proceed.
  const buf = handler._getBuffer().getBuffer(runId);
  if (buf) {
    buf.aborted = false;
    buf.abortReason = undefined;
    buf.haltRequested = false;
    buf.haltReason = undefined;
  }
}
