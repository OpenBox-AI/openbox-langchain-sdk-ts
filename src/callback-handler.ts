/**
 * OpenBox LangChain SDK — OpenBoxCallbackHandler
 *
 * Extends LangChain's BaseCallbackHandler to intercept all chain/tool/LLM
 * lifecycle events and send them to OpenBox Core for governance evaluation.
 *
 * Single line integration:
 *   const handler = new OpenBoxCallbackHandler();
 *   const chain = new ConversationChain({ llm, callbacks: [handler] });
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { AgentAction, AgentFinish } from "@langchain/core/agents";
import type { LLMResult } from "@langchain/core/outputs";
import type { ChainValues } from "@langchain/core/utils/types";
import type { Serialized } from "@langchain/core/load/serializable";
import type { DocumentInterface } from "@langchain/core/documents";
import type { BaseMessage } from "@langchain/core/messages";

import { GovernanceClient } from "./client.js";
import { globalConfig, GovernanceConfig, mergeConfig, PartialGovernanceConfig } from "./config.js";
import { SpanCollector, globalSpanCollector } from "./telemetry.js";
import { StreamingTokenBuffer, globalStreamingBuffer } from "./streaming.js";
import { OpenBoxSignalMonitor } from "./signal-monitor.js";
import {
  applyInputRedaction,
  applyOutputRedaction,
} from "./guardrails.js";
import { pollUntilDecision } from "./hitl.js";
import { RunBufferManager } from "./run-buffer.js";
import {
  extractCompletionText,
  extractFinishReason,
  extractModelName,
  extractPromptText,
  extractTokenUsage,
  rfc3339Now,
  safeSerialize,
} from "./serializer.js";
import {
  enforceVerdict,
  eventTypeToContext,
} from "./verdict-handler.js";
import {
  GovernanceVerdictResponse,
  GuardrailsReason,
  Verdict,
  verdictShouldStop,
} from "./types.js";
import type { LangChainGovernanceEvent } from "./types.js";
import {
  ApprovalExpiredError,
  ApprovalRejectedError,
  ApprovalTimeoutError,
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
} from "./errors.js";
import { configureHookGovernance } from "./hook-governance.js";

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function _cleanGuardrailReason(reason: string): string {
  // Guardrail services may echo the full prompt/trace including agent scratchpad.
  // We only want the human-readable reason header and the quoted offending text.
  
  // 1) Strip ReAct "Question:" line (includes session context) wherever it appears
  reason = reason.replace(/\n?-\s*Question:\s*\[Session context\][^\n]*\n?/g, "");
  
  // 2) Strip agent scratchpad (Thought:, Action:, etc.)
  const markers = ["\n\nThought:", "\n\nThought", "\nThought:", "\nThought"];
  for (const m of markers) {
    const idx = reason.indexOf(m);
    if (idx >= 0) {
      return reason.slice(0, idx).trimEnd();
    }
  }
  return reason.trimEnd();
}

/**
 * Mirrors Temporal SDK's pattern (join reason strings), but we intentionally:
 * - take only the first reason (Core already returns a primary `reason`)
 * - trim off any agent scratchpad sections (e.g. "Thought:")
 */
function _getGuardrailFailureReasons(reasons?: GuardrailsReason[]): string[] {
  const first = reasons?.find((r) => r?.reason)?.reason;
  if (!first) {
    return ["Guardrails validation failed"];
  }
  return [_cleanGuardrailReason(first)];
}

// ═══════════════════════════════════════════════════════════════════
// Handler Options
// ═══════════════════════════════════════════════════════════════════

export interface OpenBoxCallbackHandlerOptions extends PartialGovernanceConfig {
  /** Pre-constructed GovernanceClient (optional — built from global config if omitted) */
  client?: GovernanceClient;
  /** Pre-constructed RunBufferManager (optional — creates a new one if omitted) */
  buffer?: RunBufferManager;
  /** HTTP span collector (defaults to globalSpanCollector) */
  spanCollector?: SpanCollector;
  /** Streaming token buffer (defaults to globalStreamingBuffer) */
  streamingBuffer?: StreamingTokenBuffer;
  /** Whether to enforce BLOCK/HALT on AgentAction/AgentFinish (default: true) */
  enforceAgentActions?: boolean;
  /**
   * Signal monitor for mid-run HALT/BLOCK (Temporal SignalReceived equivalent).
   * When provided together with abortController, the monitor auto-starts on root
   * ChainStarted and auto-stops on root ChainCompleted/ChainFailed.
   */
  signalMonitor?: OpenBoxSignalMonitor;
  /**
   * AbortController whose .signal should be passed to the LangChain executor.
   * The signal monitor will call .abort() if OpenBox returns HALT/BLOCK.
   */
  abortController?: AbortController;
}

// ═══════════════════════════════════════════════════════════════════
// OpenBoxCallbackHandler
// ═══════════════════════════════════════════════════════════════════

export class OpenBoxCallbackHandler extends BaseCallbackHandler {
  name = "OpenBoxCallbackHandler";

  private readonly client: GovernanceClient;
  private readonly buffer: RunBufferManager;
  private readonly config: GovernanceConfig;
  private readonly spanCollector: SpanCollector;
  private readonly streamingBuffer: StreamingTokenBuffer;
  private readonly enforceAgentActions: boolean;
  readonly signalMonitor?: OpenBoxSignalMonitor;
  /** AbortController wired to the signal monitor — pass .signal to your LangChain executor */
  readonly abortController?: AbortController;

  /**
   * Run IDs where wrapTool has already performed the AGE ToolCompleted evaluation.
   * handleToolEnd skips re-evaluation for these runs to avoid double-sending.
   */
  private readonly _toolEndHandledByWrapper = new Set<string>();

  constructor(options: OpenBoxCallbackHandlerOptions = {}) {
    super();
    this.config = mergeConfig(options);

    if (options.client) {
      this.client = options.client;
    } else {
      const gc = globalConfig.get();
      this.client = new GovernanceClient({
        apiUrl: gc.apiUrl,
        apiKey: gc.apiKey,
        timeout: gc.governanceTimeout,
        onApiError: this.config.onApiError,
      });
    }

    this.buffer = options.buffer ?? new RunBufferManager();
    this.spanCollector = options.spanCollector ?? globalSpanCollector;
    this.streamingBuffer = options.streamingBuffer ?? globalStreamingBuffer;
    this.enforceAgentActions = options.enforceAgentActions ?? true;
    this.signalMonitor = options.signalMonitor;
    this.abortController = options.abortController;

    // ── Critical: LangChain defaults awaitHandlers=false, which fires callbacks
    // into a background queue and proceeds immediately. We must await our handlers
    // so that pollUntilDecision(), enforceVerdict() throws, and HITL blocking
    // all actually gate LLM/tool execution before it starts.
    this.awaitHandlers = true;

    // ── Critical: LangChain wraps every callback in try/catch and swallows errors
    // unless raiseError=true. Without this, GuardrailsValidationError and
    // GovernanceBlockedError are silently logged as warnings and the LLM/tool
    // executes anyway — making blocking completely ineffective.
    this.raiseError = true;

    // ── Configure hook-level governance (mirrors worker.py set_temporal_client + otel_setup pass-through)
    configureHookGovernance({
      client: this.client,
      buffer: this.buffer,
      spanCollector: this.spanCollector,
      onApiError: this.config.onApiError ?? "fail_open",
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Chain Events
  // ─────────────────────────────────────────────────────────────────

  async handleChainStart(
    chain: Serialized,
    inputs: ChainValues,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runType?: string,
    name?: string
  ): Promise<void> {
    const chainName = name ?? chain?.id?.at(-1) ?? runType ?? "Chain";
    this.buffer.registerRun(runId, "chain", chainName, parentRunId);

    if (!this.config.sendChainStartEvent) return;
    if (this.config.skipChainTypes.has(chainName)) return;

    // ── Pre-execution: check for pending stop verdict (mirrors Temporal buffer.verdict.should_stop())
    this._checkPendingStopVerdict(runId);

    const rootRunId = this.buffer.getRootRunId(runId);
    const attempt = this.buffer.getAttempt(runId);

    // ── Signal monitor: auto-start on root chain (mirrors Temporal workflow entry point)
    if (!parentRunId && this.signalMonitor && this.abortController) {
      this.signalMonitor.start(rootRunId, this.abortController);
    }

    // Only send event for the root chain (WorkflowStarted). Sub-chains are LangChain
    // internals (agent executor loops, etc.) — Temporal has no equivalent concept.
    if (parentRunId) return;

    const event = this._buildEvent("ChainStarted", rootRunId, {
      activity_id: runId,
      activity_type: chainName,
      activity_input: [safeSerialize(inputs)],
      parent_run_id: parentRunId,
      attempt,
    });

    const response = await this.client.evaluateEvent(event);
    if (!response) return;

    const ctx = eventTypeToContext("ChainStarted");
    enforceVerdict(response, ctx);
    this._storeVerdict(runId, response);
  }

  async handleChainEnd(
    outputs: ChainValues,
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    const buf = this.buffer.getBuffer(runId);
    this.buffer.markCompleted(runId);

    const chainName = buf?.name ?? "Chain";
    if (!this.config.sendChainEndEvent) {
      this._cleanupIfRoot(runId, parentRunId);
      return;
    }
    if (this.config.skipChainTypes.has(chainName)) {
      this._cleanupIfRoot(runId, parentRunId);
      return;
    }

    const rootRunId = this.buffer.getRootRunId(runId);
    const endTimeMs = Date.now();
    const durationMs = buf ? endTimeMs - buf.startTime : undefined;
    const startTimeSec = buf ? buf.startTime / 1000 : undefined;
    const endTimeSec = endTimeMs / 1000;
    const attempt = this.buffer.getAttempt(runId);
    // Only send event for the root chain (WorkflowCompleted). Sub-chains are suppressed.
    if (parentRunId) {
      this._cleanupIfRoot(runId, parentRunId);
      return;
    }
    const chainEndEventType = "ChainCompleted";
    const serializedOutput = safeSerialize(outputs);

    const event = this._buildEvent(chainEndEventType, rootRunId, {
      activity_id: runId,
      activity_type: chainName,
      workflow_output: serializedOutput,
      activity_output: serializedOutput,
      status: "completed",
      start_time: startTimeSec,
      end_time: endTimeSec,
      duration_ms: durationMs,
      parent_run_id: parentRunId,
      attempt,
    });

    const response = await this.client.evaluateEvent(event);

    // ── Signal monitor: auto-stop on root chain end
    if (!parentRunId && this.signalMonitor) {
      this.signalMonitor.stop();
    }

    this._cleanupIfRoot(runId, parentRunId);

    if (!response) return;
    const ctx = eventTypeToContext("ChainCompleted");
    enforceVerdict(response, ctx);
  }

  async handleChainError(
    err: unknown,
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    const buf = this.buffer.getBuffer(runId);
    this.buffer.markFailed(runId);

    // ── Signal monitor: auto-stop on root chain failure
    if (!parentRunId && this.signalMonitor) {
      this.signalMonitor.stop();
    }

    const chainName = buf?.name ?? "Chain";
    const rootRunId = this.buffer.getRootRunId(runId);
    const durationMs = buf ? Date.now() - buf.startTime : undefined;
    const attempt = this.buffer.getAttempt(runId);

    const event = this._buildEvent("ChainFailed", rootRunId, {
      activity_id: runId,
      activity_type: chainName,
      status: "failed",
      duration_ms: durationMs,
      error: serializeError(err),
      parent_run_id: parentRunId,
      attempt,
    });

    this._cleanupIfRoot(runId, parentRunId);

    await this.client.evaluateEvent(event).catch(() => undefined);
  }

  // ─────────────────────────────────────────────────────────────────
  // LLM Events
  // ─────────────────────────────────────────────────────────────────

  /**
   * Called for ChatModel invocations — receives the actual BaseMessage[][] array
   * that will be sent to the API. With awaitHandlers=true we can mutate these
   * in-place so redacted content replaces PII before the OpenAI call fires.
   */
  async handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string
  ): Promise<void> {
    // Run the full LLMStart governance flow (registers run, evaluates, applies redaction)
    const prompts = messages.map((group) =>
      group.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n")
    );
    await this.handleLLMStart(llm, prompts, runId, parentRunId, extraParams, tags, metadata, name);

    // Now mutate messages in-place with any redacted content the server returned
    const redacted = this.buffer.getRedactedInput(runId);
    if (redacted !== undefined && Array.isArray(redacted)) {
      for (let i = 0; i < messages.length && i < redacted.length; i++) {
        const group = messages[i];
        const redactedText = typeof redacted[i] === "string" ? redacted[i] as string : undefined;
        if (redactedText && group) {
          // Replace the last human message content with the redacted version
          for (let j = group.length - 1; j >= 0; j--) {
            const msg = group[j];
            if (msg && (msg._getType() === "human" || msg._getType() === "generic")) {
              (msg as unknown as { content: string }).content = redactedText;
              break;
            }
          }
        }
      }
    }
  }

  async handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    name?: string
  ): Promise<void> {
    const llmName = name ?? llm?.id?.at(-1) ?? "LLM";
    this.buffer.registerRun(runId, "llm", llmName, parentRunId);
    this.streamingBuffer.start(runId, extractModelName(llm));
    this.spanCollector.setActiveRun(runId);

    if (!this.config.sendLLMStartEvent) return;

    // ── Pre-execution: check for pending stop verdict
    this._checkPendingStopVerdict(runId);

    // ── Pre-execution: if pending approval from previous attempt, poll first (mirrors Temporal retry)
    if (this.config.hitl.enabled && this.buffer.isPendingApproval(runId)) {
      await this._pollPendingApproval(runId, llmName);
    }

    const rootRunId = this.buffer.getRootRunId(runId);
    const modelName = extractModelName(llm);
    const promptText = extractPromptText(prompts);
    const attempt = this.buffer.getAttempt(runId);

    const event = this._buildEvent("LLMStarted", rootRunId, {
      activity_id: runId,
      activity_type: "agent_validatePrompt",
      activity_input: [{ prompt: promptText }],
      llm_model: modelName,
      prompt: promptText,
      parent_run_id: parentRunId,
      attempt,
    });

    const response = await this.client.evaluateEvent(event);
    if (!response) return;

    // ── Check guardrails validation failure first (mirrors Temporal order)
    this._checkGuardrailsInput(response);

    const ctx = eventTypeToContext("LLMStarted");
    const result = enforceVerdict(response, ctx);
    this._storeVerdict(runId, response);

    if (result.requiresHITL) {
      this.buffer.setPendingApproval(runId, true);
      await pollUntilDecision(
        this.client,
        { workflowId: rootRunId, runId: rootRunId, activityId: runId, activityType: llmName },
        this.config.hitl
      );
      this.buffer.setPendingApproval(runId, false);
    }

    // ── Apply input guardrails redaction — store in buffer so caller can retrieve via getRedactedInput()
    if (response.guardrails_result?.input_type === "activity_input") {
      const redacted = applyInputRedaction(prompts, response.guardrails_result);
      this.buffer.setRedactedInput(runId, redacted);
    }
  }

  async handleLLMEnd(
    output: LLMResult,
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    const buf = this.buffer.getBuffer(runId);
    this.buffer.markCompleted(runId);
    this.spanCollector.clearActiveRun();

    const llmName = buf?.name ?? "LLM";
    if (!this.config.sendLLMEndEvent) return;

    const rootRunId = this.buffer.getRootRunId(runId);
    const endTimeMs = Date.now();
    const durationMs = buf ? endTimeMs - buf.startTime : undefined;
    const startTimeSec = buf ? buf.startTime / 1000 : undefined;
    const endTimeSec = endTimeMs / 1000;
    const { inputTokens, outputTokens, totalTokens } = extractTokenUsage(output);
    const streamedText = this.streamingBuffer.getAccumulated(runId);
    const completionText = streamedText || extractCompletionText(output);
    this.streamingBuffer.clear(runId);
    const finishReason = extractFinishReason(output);
    const spans = this.spanCollector.getSpans(runId);
    this.spanCollector.clearSpans(runId);
    const modelName = extractModelName(output) ?? buf?.metadata?.["modelName"] as string | undefined;
    const attempt = buf?.attempt ?? 1;
    // Re-send activity_input on Completed (mirrors Temporal ActivityCompleted which sends both)
    const redactedInput = this.buffer.getRedactedInput(runId);

    // ── Inject synthetic LLM span so the server can extract:
    //   1. Token counts  — aggregateTokensFromSpans reads {usage:{prompt_tokens,completion_tokens}}
    //   2. Model metrics — extractSingleModelMetric reads {model:"...", usage:{...}}
    //   3. Latency       — extractLatenciesFromSpans reads span.duration_ns
    // With streaming, the real fetch response_body is raw SSE chunks, not parseable JSON.
    const allSpans = [...spans];
    if (inputTokens != null && outputTokens != null && (inputTokens > 0 || outputTokens > 0)) {
      const isAnthropic = modelName?.toLowerCase().includes("claude");
      const llmApiUrl = isAnthropic
        ? "https://api.anthropic.com/v1/messages"
        : "https://api.openai.com/v1/chat/completions";

      // response_body must include "model" for extractSingleModelMetric (model usage chart)
      const syntheticResponseBody = isAnthropic
        ? JSON.stringify({
            model: modelName ?? "claude",
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          })
        : JSON.stringify({
            model: modelName ?? "gpt",
            usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
          });

      // request_body fallback: extractModelFromRequest reads {model:"..."}
      const syntheticRequestBody = JSON.stringify({ model: modelName ?? "" });

      // duration_ns: extractLatenciesFromSpans reads this for latency distribution chart
      const durationNs = durationMs != null ? durationMs * 1_000_000 : undefined;

      allSpans.push({
        span_id: `llm-token-${runId}`,
        name: `LLM ${modelName ?? "completion"} token usage`,
        kind: "client",
        start_time: buf?.startTime ?? endTimeMs,
        end_time: endTimeMs,
        duration_ns: durationNs,
        attributes: {
          "http.method": "POST",
          "http.url": llmApiUrl,
          "http.status_code": 200,
          "llm.model": modelName,
          "llm.synthetic": true,
        },
        status: { code: "OK" },
        request_body: syntheticRequestBody,
        response_body: syntheticResponseBody,
      });
    }

    const event = this._buildEvent("LLMCompleted", rootRunId, {
      activity_id: runId,
      activity_input: redactedInput != null ? [safeSerialize(redactedInput)] : undefined,
      activity_output: safeSerialize(output),
      status: "completed",
      start_time: startTimeSec,
      end_time: endTimeSec,
      duration_ms: durationMs,
      llm_model: modelName,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      completion: completionText,
      finish_reason: finishReason,
      parent_run_id: parentRunId,
      attempt,
      span_count: allSpans.length,
      spans: allSpans.length > 0 ? allSpans : undefined,
    });

    const response = await this.client.evaluateEvent(event);
    if (!response) return;

    // ── Check guardrails output validation
    this._checkGuardrailsOutput(response);

    const ctx = eventTypeToContext("LLMCompleted");
    const result = enforceVerdict(response, ctx);

    // ── Post-execution REQUIRE_APPROVAL on completed event (mirrors Temporal post-execution HITL)
    if (result.requiresHITL) {
      this.buffer.setPendingApproval(runId, true);
      await pollUntilDecision(
        this.client,
        { workflowId: rootRunId, runId: rootRunId, activityId: runId, activityType: llmName },
        this.config.hitl
      );
      this.buffer.setPendingApproval(runId, false);
    }

    // ── Apply output guardrails redaction — store in buffer
    if (response.guardrails_result?.input_type === "activity_output" && response.guardrails_result.redacted_input != null) {
      const redacted = applyOutputRedaction(output, response.guardrails_result);
      this.buffer.setRedactedOutput(runId, redacted);
    }

    // ── Finally: check if a hook requested HALT during LLM execution
    if (this.buffer.isHaltRequested(runId)) {
      const reason = this.buffer.getAbortReason(runId) ?? "Halted by hook governance";
      if (this.abortController) this.abortController.abort();
      throw new GovernanceHaltError(reason);
    }
  }

  async handleLLMError(
    err: unknown,
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    const buf = this.buffer.getBuffer(runId);
    this.buffer.markFailed(runId);

    // ── Hook-level abort propagation (mirrors activity_interceptor GovernanceBlockedError catch block)
    // If a per-request hook blocked/halted, record it so subsequent tool calls short-circuit
    if (err instanceof GovernanceBlockedError) {
      if (err.verdict === "halt" || err.verdict === "stop") {
        this.buffer.setHaltRequested(runId, err.message);
        if (this.abortController) this.abortController.abort();
      } else {
        this.buffer.setAborted(runId, err.message);
      }
    }

    const rootRunId = this.buffer.getRootRunId(runId);
    const durationMs = buf ? Date.now() - buf.startTime : undefined;
    const attempt = buf?.attempt ?? 1;

    const event = this._buildEvent("LLMFailed", rootRunId, {
      activity_id: runId,
      status: "failed",
      duration_ms: durationMs,
      error: serializeError(err),
      parent_run_id: parentRunId,
      attempt,
    });

    await this.client.evaluateEvent(event).catch(() => undefined);
  }

  // ─────────────────────────────────────────────────────────────────
  // Tool Events
  // ─────────────────────────────────────────────────────────────────

  async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    name?: string
  ): Promise<void> {
    const toolName = name ?? tool?.id?.at(-1) ?? "Tool";
    this.buffer.registerRun(runId, "tool", toolName, parentRunId);
    this.spanCollector.setActiveRun(runId);

    if (!this.config.sendToolStartEvent) return;
    if (this.config.skipToolTypes.has(toolName)) return;
    if (this.config.hitl.skipToolTypes?.has(toolName)) return;

    // ── Pre-execution: check for pending stop verdict from a prior signal/chain event
    this._checkPendingStopVerdict(runId);

    // ── Pre-execution: if pending approval carried from a previous attempt, poll first
    if (this.config.hitl.enabled && this.buffer.isPendingApproval(runId)) {
      await this._pollPendingApproval(runId, toolName);
    }

    const rootRunId = this.buffer.getRootRunId(runId);
    const attempt = this.buffer.getAttempt(runId);

    // Unwrap LangChain's {input: "..."} envelope if present, so activity_input[0]
    // is the actual tool arguments object rather than a double-encoded string.
    let toolInputForEvent: unknown = input;
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        if (keys.length === 1 && keys[0] === "input" && typeof parsed["input"] === "string") {
          toolInputForEvent = JSON.parse(parsed["input"]);
        } else {
          toolInputForEvent = parsed;
        }
      }
    } catch {
      // input is not JSON — keep as string
    }

    const event = this._buildEvent("ToolStarted", rootRunId, {
      activity_id: runId,
      activity_type: toolName,
      activity_input: [safeSerialize(toolInputForEvent)],
      tool_name: toolName,
      tool_input: safeSerialize(input),
      parent_run_id: parentRunId,
      attempt,
    });

    const response = await this.client.evaluateEvent(event);
    if (!response) return;

    // ── Check guardrails validation failure
    this._checkGuardrailsInput(response);

    const ctx = eventTypeToContext("ToolStarted");
    const result = enforceVerdict(response, ctx);
    this._storeVerdict(runId, response);

    if (result.requiresHITL) {
      this.buffer.setPendingApproval(runId, true);
      try {
        await pollUntilDecision(
          this.client,
          { workflowId: rootRunId, runId: rootRunId, activityId: runId, activityType: toolName },
          this.config.hitl
        );
      } catch (pollErr) {
        this.buffer.setPendingApproval(runId, false);
        // Convert rejection/expiry/timeout → GovernanceHaltError so LangChain's
        // handleToolRuntimeErrors cannot swallow it as an observation and retry the tool.
        if (
          pollErr instanceof ApprovalRejectedError ||
          pollErr instanceof ApprovalExpiredError ||
          pollErr instanceof ApprovalTimeoutError
        ) {
          throw new GovernanceHaltError(
            (pollErr as Error).message ??
              `Approval rejected for ${toolName}`
          );
        }
        throw pollErr;
      }
      this.buffer.setPendingApproval(runId, false);
    }

    // ── Apply input guardrails redaction — store in buffer so user can call getRedactedInput(runId)
    if (response.guardrails_result?.input_type === "activity_input") {
      const redacted = applyInputRedaction(input, response.guardrails_result);
      this.buffer.setRedactedInput(runId, redacted);
    }
  }

  async handleToolEnd(
    output: string,
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    const buf = this.buffer.getBuffer(runId);
    this.buffer.markCompleted(runId);

    const toolName = buf?.name ?? "Tool";
    if (!this.config.sendToolEndEvent) return;
    if (this.config.skipToolTypes.has(toolName)) return;

    // ── Skip AGE evaluation if wrapTool already handled it inline (avoids double-send)
    if (this._toolEndHandledByWrapper.has(runId)) {
      this._toolEndHandledByWrapper.delete(runId);
      if (this.buffer.isHaltRequested(runId)) {
        const reason = this.buffer.getAbortReason(runId) ?? "Halted by hook governance";
        if (this.abortController) this.abortController.abort();
        throw new GovernanceHaltError(reason);
      }
      return;
    }

    await this._evaluateToolCompleted(runId, output, parentRunId);
  }

  /**
   * Send the ToolCompleted governance event and enforce the AGE verdict.
   * Called by handleToolEnd normally, or by wrapTool directly (before returning
   * to LangChain) so that REQUIRE_APPROVAL blocks the tool result.
   */
  async evaluateToolCompleted(runId: string, output: string, parentRunId?: string): Promise<void> {
    // Mark as handled so handleToolEnd skips re-evaluation
    this._toolEndHandledByWrapper.add(runId);
    await this._evaluateToolCompleted(runId, output, parentRunId);
  }

  private async _evaluateToolCompleted(runId: string, output: string, parentRunId?: string): Promise<void> {
    const buf = this.buffer.getBuffer(runId);
    const toolName = buf?.name ?? "Tool";

    const rootRunId = this.buffer.getRootRunId(runId);
    const endTimeMs = Date.now();
    const durationMs = buf ? endTimeMs - buf.startTime : undefined;
    const startTimeSec = buf ? buf.startTime / 1000 : undefined;
    const endTimeSec = endTimeMs / 1000;
    const attempt = buf?.attempt ?? 1;
    const spans = this.spanCollector.getSpans(runId);
    this.spanCollector.clearSpans(runId);

    const redactedInput = this.buffer.getRedactedInput(runId);

    // Use a disambiguated activity_id for ToolCompleted so the poll endpoint
    // finds this row rather than the ActivityStarted row (which shares the same runId).
    const completedActivityId = `${runId}-c`;
    const event = this._buildEvent("ToolCompleted", rootRunId, {
      activity_id: completedActivityId,
      activity_type: toolName,
      activity_input: redactedInput != null
        ? [safeSerialize(redactedInput)]
        : undefined,
      activity_output: typeof output === "string"
        ? safeSerialize({ result: output })
        : safeSerialize(output),
      tool_name: toolName,
      status: "completed",
      start_time: startTimeSec,
      end_time: endTimeSec,
      duration_ms: durationMs,
      parent_run_id: parentRunId,
      attempt,
      span_count: spans.length,
      spans: spans.length > 0 ? spans : undefined,
    });

    const response = await this.client.evaluateEvent(event);
    if (!response) {
      if (this.buffer.isHaltRequested(runId)) {
        const reason = this.buffer.getAbortReason(runId) ?? "Halted by hook governance";
        if (this.abortController) this.abortController.abort();
        throw new GovernanceHaltError(reason);
      }
      return;
    }

    this._checkGuardrailsOutput(response);

    const ctx = eventTypeToContext("ToolCompleted");
    const result = enforceVerdict(response, ctx);

    if (result.requiresHITL) {
      this.buffer.setPendingApproval(runId, true);
      try {
        await pollUntilDecision(
          this.client,
          { workflowId: rootRunId, runId: rootRunId, activityId: completedActivityId, activityType: toolName },
          this.config.hitl
        );
      } catch (pollErr) {
        this.buffer.setPendingApproval(runId, false);
        // Convert rejection/expiry/timeout → GovernanceHaltError so LangChain's
        // tool error handler cannot swallow it as an observation string.
        if (
          pollErr instanceof ApprovalRejectedError ||
          pollErr instanceof ApprovalExpiredError ||
          pollErr instanceof ApprovalTimeoutError
        ) {
          throw new GovernanceHaltError(pollErr.message);
        }
        throw pollErr;
      }
      this.buffer.setPendingApproval(runId, false);
    }

    if (response.guardrails_result?.input_type === "activity_output" && response.guardrails_result.redacted_input != null) {
      const redacted = applyOutputRedaction(output, response.guardrails_result);
      this.buffer.setRedactedOutput(runId, redacted);
    }

    if (this.buffer.isHaltRequested(runId)) {
      const reason = this.buffer.getAbortReason(runId) ?? "Halted by hook governance";
      if (this.abortController) this.abortController.abort();
      throw new GovernanceHaltError(reason);
    }
  }

  async handleToolError(
    err: unknown,
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    const buf = this.buffer.getBuffer(runId);
    this.buffer.markFailed(runId);

    // ── Hook-level abort propagation (mirrors activity_interceptor GovernanceBlockedError catch block)
    // If a per-request hook blocked/halted, record it so subsequent tool calls short-circuit
    if (err instanceof GovernanceBlockedError) {
      if (err.verdict === "halt" || err.verdict === "stop") {
        this.buffer.setHaltRequested(runId, err.message);
        if (this.abortController) this.abortController.abort();
      } else {
        this.buffer.setAborted(runId, err.message);
      }
    }

    const rootRunId = this.buffer.getRootRunId(runId);
    const durationMs = buf ? Date.now() - buf.startTime : undefined;
    const attempt = buf?.attempt ?? 1;

    const event = this._buildEvent("ToolFailed", rootRunId, {
      activity_id: runId,
      activity_type: buf?.name ?? "Tool",
      tool_name: buf?.name,
      status: "failed",
      duration_ms: durationMs,
      error: serializeError(err),
      parent_run_id: parentRunId,
      attempt,
    });

    await this.client.evaluateEvent(event).catch(() => undefined);
  }

  // ─────────────────────────────────────────────────────────────────
  // Streaming (Phase 3)
  // ─────────────────────────────────────────────────────────────────

  async handleLLMNewToken(
    token: string,
    _idx: { prompt: number; completion: number },
    runId: string
  ): Promise<void> {
    this.streamingBuffer.addToken(runId, token);
  }

  // ─────────────────────────────────────────────────────────────────
  // Agent Events — with BLOCK/HALT enforcement (Phase 3)
  // ─────────────────────────────────────────────────────────────────

  async handleAgentAction(
    action: AgentAction,
    runId: string,
    _parentRunId?: string
  ): Promise<void> {
    // No-op: AgentAction is a LangChain-internal routing step.
    // Temporal has no equivalent — tool governance is handled in handleToolStart.
    if (this.enforceAgentActions) this._checkPendingStopVerdict(runId);
  }

  async handleAgentFinish(
    _finish: AgentFinish,
    _runId: string,
    _parentRunId?: string
  ): Promise<void> {
    // No-op: AgentFinish is a LangChain-internal signal. Temporal has no equivalent.
  }

  // ─────────────────────────────────────────────────────────────────
  // Retriever Events (observability only)
  // ─────────────────────────────────────────────────────────────────

  async handleRetrieverStart(
    retriever: Serialized,
    _query: string,
    runId: string,
    parentRunId?: string
  ): Promise<void> {
    // Register for buffer tracking only — no governance event sent.
    // Retrievers are internal RAG plumbing; Temporal has no equivalent.
    const retrieverName = retriever?.id?.at(-1) ?? "Retriever";
    this.buffer.registerRun(runId, "retriever", retrieverName, parentRunId);
  }

  async handleRetrieverEnd(
    _documents: DocumentInterface[],
    runId: string,
    _parentRunId?: string
  ): Promise<void> {
    this.buffer.markCompleted(runId);
  }

  async handleRetrieverError(
    _err: unknown,
    runId: string,
    _parentRunId?: string
  ): Promise<void> {
    this.buffer.markFailed(runId);
  }

  /**
   * Public accessor: returns the guardrails-redacted input for a given runId.
   * Call this from a wrapped tool to retrieve what the governance server redacted
   * before passing to the underlying tool execution.
   *
   * @example
   * ```typescript
   * const redacted = handler.getRedactedInput(runId) ?? originalInput;
   * ```
   */
  getRedactedInput(runId: string): unknown {
    return this.buffer.getRedactedInput(runId);
  }

  getRedactedOutput(runId: string): unknown {
    return this.buffer.getRedactedOutput(runId);
  }

  /**
   * Mark that wrapTool has already sent the ToolCompleted AGE evaluation for this runId.
   * handleToolEnd will skip re-evaluation to avoid double-sending.
   */
  markToolEndHandledByWrapper(runId: string): void {
    this._toolEndHandledByWrapper.add(runId);
  }

  // ─────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Mirrors Temporal's pre-execution pending verdict check:
   * if a prior event on this run returned BLOCK/HALT, prevent execution.
   */
  private _checkPendingStopVerdict(runId: string): void {
    const buf = this.buffer.getBuffer(runId);
    if (!buf?.verdict) return;
    if (verdictShouldStop(buf.verdict)) {
      const reason = buf.verdictReason ?? "Blocked by prior governance verdict";
      if (buf.verdict === Verdict.HALT) {
        throw new GovernanceHaltError(reason);
      }
      throw new GovernanceBlockedError(reason);
    }
  }

  /**
   * Mirrors Temporal's pre-execution pending-approval check:
   * if buffer has pendingApproval=true from a previous attempt, poll until resolved.
   */
  private async _pollPendingApproval(runId: string, activityType: string): Promise<void> {
    const rootRunId = this.buffer.getRootRunId(runId);
    await pollUntilDecision(
      this.client,
      { workflowId: rootRunId, runId: rootRunId, activityId: runId, activityType },
      this.config.hitl
    );
    this.buffer.setPendingApproval(runId, false);
  }

  /**
   * Store the verdict from a pre-execution (Started) event response into the run buffer.
   * Only called for *Started* events — Completed/End events are observability-only
   * and must NOT poison the pending-stop buffer for subsequent runs.
   */
  private _storeVerdict(runId: string, response: GovernanceVerdictResponse): void {
    if (response.verdict && verdictShouldStop(response.verdict)) {
      this.buffer.setVerdictForRun(runId, response.verdict, response.reason);
    }
  }

  /**
   * Mirrors Temporal: check guardrails input validation_passed=false → throw before execution.
   * Builds short clean reason strings from guardrail type — never dumps raw content.
   */
  private _checkGuardrailsInput(response: GovernanceVerdictResponse): void {
    const gr = response.guardrails_result;
    if (gr && gr.input_type === "activity_input" && !gr.validation_passed) {
      const reasons = _getGuardrailFailureReasons(gr.reasons);
      throw new GuardrailsValidationError(reasons);
    }
  }

  /**
   * Mirrors Temporal: check guardrails output validation_passed=false → throw after execution.
   */
  private _checkGuardrailsOutput(response: GovernanceVerdictResponse): void {
    const gr = response.guardrails_result;
    if (gr && gr.input_type === "activity_output" && !gr.validation_passed) {
      const reasons = _getGuardrailFailureReasons(gr.reasons);
      throw new GuardrailsValidationError(
        reasons.length > 0 ? reasons : ["Guardrails output validation failed"]
      );
    }
  }

  private _buildEvent(
    eventType: LangChainGovernanceEvent["event_type"],
    rootRunId: string,
    extra: Partial<LangChainGovernanceEvent>
  ): LangChainGovernanceEvent {
    const buf = this.buffer.getBuffer(rootRunId);
    return {
      source: "workflow-telemetry",
      event_type: eventType,
      workflow_id: rootRunId,
      run_id: rootRunId,
      workflow_type: buf?.name ?? "LangChainRun",
      task_queue: "langchain",
      timestamp: rfc3339Now(),
      session_id: this.config.sessionId,
      ...extra,
    };
  }

  /** Clean up buffer when the root chain finishes */
  private _cleanupIfRoot(runId: string, parentRunId?: string): void {
    if (!parentRunId) {
      this.buffer.cleanup(runId);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // @internal accessors — used by wrappers.ts for hook-level HITL
  // Not part of the public API surface.
  // ─────────────────────────────────────────────────────────────────

  /** @internal */
  _getClient(): GovernanceClient { return this.client; }
  /** @internal */
  _getBuffer(): RunBufferManager { return this.buffer; }
  /** @internal */
  _getConfig(): GovernanceConfig { return this.config; }
}

// ─────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────

function serializeError(err: unknown): { type: string; message: string } {
  if (err instanceof Error) {
    return { type: err.name ?? "Error", message: err.message };
  }
  return { type: "UnknownError", message: String(err) };
}
