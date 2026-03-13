import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AgentAction, AgentFinish } from '@langchain/core/agents';
import { LLMResult } from '@langchain/core/outputs';
import { ChainValues } from '@langchain/core/utils/types';
import { Serialized } from '@langchain/core/load/serializable';
import { DocumentInterface } from '@langchain/core/documents';
import { BaseMessage } from '@langchain/core/messages';
import { BaseLanguageModelInterface } from '@langchain/core/language_models/base';

/**
 * OpenBox LangChain SDK — Core Types
 */
declare enum Verdict {
    ALLOW = "allow",
    CONSTRAIN = "constrain",
    REQUIRE_APPROVAL = "require_approval",
    BLOCK = "block",
    HALT = "halt"
}
declare function verdictFromString(value: string | null | undefined): Verdict;
declare function verdictPriority(v: Verdict): number;
declare function highestPriorityVerdict(verdicts: Verdict[]): Verdict;
declare function verdictShouldStop(v: Verdict): boolean;
declare function verdictRequiresApproval(v: Verdict): boolean;
type LangChainEventType = "ChainStarted" | "ChainCompleted" | "ChainFailed" | "ToolStarted" | "ToolCompleted" | "ToolFailed" | "LLMStarted" | "LLMCompleted" | "LLMFailed" | "AgentAction" | "AgentFinish" | "RetrieverStarted" | "RetrieverCompleted" | "RetrieverFailed";
interface ErrorDetails {
    type: string;
    message: string;
    cause?: {
        type: string;
        message: string;
    };
}
interface SpanData {
    span_id: string;
    trace_id?: string;
    parent_span_id?: string;
    name: string;
    kind?: string;
    start_time?: number;
    end_time?: number;
    duration_ns?: number;
    attributes?: Record<string, unknown>;
    status?: {
        code: string;
        description?: string;
    };
    events?: Array<{
        name: string;
        timestamp: number;
        attributes?: Record<string, unknown>;
    }>;
    request_body?: string;
    response_body?: string;
    request_headers?: Record<string, string>;
    response_headers?: Record<string, string>;
}
type HookStage = "started" | "completed";
interface HttpHookTrigger {
    type: "http_request";
    stage: HookStage;
    "http.method": string;
    "http.url": string;
    attribute_key_identifiers: ["http.method", "http.url"];
    request_headers?: Record<string, string>;
    request_body?: string;
    response_headers?: Record<string, string>;
    response_body?: string;
    "http.status_code"?: number;
}
type HookTrigger = HttpHookTrigger;
interface LangChainGovernanceEvent {
    source: "workflow-telemetry";
    event_type: LangChainEventType;
    workflow_id: string;
    run_id: string;
    workflow_type: string;
    task_queue: string;
    timestamp: string;
    activity_id?: string;
    activity_type?: string;
    activity_input?: unknown[];
    activity_output?: unknown;
    workflow_output?: unknown;
    spans?: SpanData[];
    span_count?: number;
    status?: "completed" | "failed";
    start_time?: number;
    end_time?: number;
    duration_ms?: number;
    error?: ErrorDetails;
    llm_model?: string;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    finish_reason?: string;
    prompt?: string;
    completion?: string;
    tool_name?: string;
    tool_input?: unknown;
    parent_run_id?: string;
    session_id?: string;
    attempt?: number;
}
interface GuardrailsReason {
    type: string;
    field: string;
    reason: string;
}
interface GuardrailsResult {
    input_type: "activity_input" | "activity_output";
    redacted_input: unknown;
    validation_passed: boolean;
    reasons?: GuardrailsReason[];
    raw_logs?: Record<string, unknown>;
}
interface GovernanceVerdictResponse {
    verdict: Verdict;
    reason?: string;
    policy_id?: string;
    risk_score?: number;
    governance_event_id?: string;
    guardrails_result?: GuardrailsResult;
    approval_id?: string;
    approval_expiration_time?: string;
    trust_tier?: string;
    alignment_score?: number;
    behavioral_violations?: string[];
    constraints?: unknown[];
}
declare function parseGovernanceResponse(data: Record<string, unknown>): GovernanceVerdictResponse;
interface ApprovalResponse {
    verdict: Verdict;
    reason?: string;
    approval_expiration_time?: string;
    expired?: boolean;
}
declare function parseApprovalResponse(data: Record<string, unknown>): ApprovalResponse;
interface HITLConfig {
    enabled: boolean;
    pollIntervalMs: number;
    maxWaitMs: number;
    skipToolTypes?: Set<string>;
}
declare const DEFAULT_HITL_CONFIG: HITLConfig;

/**
 * OpenBox LangChain SDK — Governance HTTP Client
 */

interface GovernanceClientConfig {
    apiUrl: string;
    apiKey: string;
    timeout?: number;
    onApiError?: "fail_open" | "fail_closed";
}
interface ApprovalPollParams {
    workflowId: string;
    runId: string;
    activityId: string;
}
declare class GovernanceClient {
    private readonly apiUrl;
    private readonly apiKey;
    private readonly timeout;
    private readonly onApiError;
    constructor(config: GovernanceClientConfig);
    validateApiKey(): Promise<void>;
    /**
     * Send a governance event to OpenBox Core.
     * Returns null on network failure if fail_open.
     * Throws OpenBoxNetworkError on network failure if fail_closed.
     */
    evaluateEvent(event: LangChainGovernanceEvent): Promise<GovernanceVerdictResponse | null>;
    /**
     * Poll for HITL approval status.
     * Returns null on network failure (caller handles retry logic).
     */
    pollApproval(params: ApprovalPollParams): Promise<ApprovalResponse | null>;
    /**
     * Send a pre-built payload to the governance evaluate endpoint.
     * Used by hook-level governance where the payload is already fully assembled
     * (no event_type translation needed — caller sets event_type directly).
     *
     * Returns the raw parsed JSON response, or null on failure (fail_open).
     * Throws OpenBoxNetworkError on failure if fail_closed.
     */
    evaluateRaw(payload: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    /**
     * Build a fail-closed HALT response for when the API is unreachable and
     * onApiError = "fail_closed".
     */
    static haltResponse(reason: string): GovernanceVerdictResponse;
    private _headers;
}

/**
 * OpenBox LangChain SDK — Signal Monitor
 *
 * LangChain's equivalent of Temporal's SignalReceived event.
 *
 * In Temporal, a Signal is an external message sent to a running workflow
 * that can carry a HALT/BLOCK verdict mid-execution. LangChain has no native
 * signal concept, but we can replicate it using:
 *
 *   1. A background polling loop that checks OpenBox Core for a stop verdict
 *      on the current session (workflow_id = root chain run_id).
 *   2. An AbortController whose signal is passed to LangChain's RunnableConfig.
 *   3. When a HALT/BLOCK verdict arrives, we abort the controller — LangChain
 *      propagates an AbortError and stops the agent cleanly between steps.
 *
 * Usage:
 *   const monitor = new OpenBoxSignalMonitor(client, { pollIntervalMs: 3000 });
 *   const abortController = new AbortController();
 *
 *   monitor.start(workflowId, abortController);
 *
 *   await executor.invoke(input, {
 *     signal: abortController.signal,
 *     callbacks: [handler],
 *   });
 *
 *   monitor.stop();
 */

interface SignalMonitorConfig {
    /** How often to poll OpenBox Core for a stop verdict (ms). Default: 3000 */
    pollIntervalMs?: number;
    /** Stop polling after this many ms regardless (safety ceiling). Default: 3_600_000 (1hr) */
    maxDurationMs?: number;
    /** If true, throw a GovernanceHaltError/GovernanceBlockedError after aborting. Default: true */
    throwOnAbort?: boolean;
}
interface SignalMonitorStatus {
    running: boolean;
    workflowId: string | null;
    pollCount: number;
    aborted: boolean;
    abortReason?: string;
    abortVerdict?: Verdict;
}
/**
 * Background signal monitor — polls OpenBox Core for a stop verdict on the
 * current session and aborts the LangChain executor's AbortController on HALT/BLOCK.
 *
 * This mirrors Temporal's SignalReceived interceptor where a governance signal
 * stores a verdict that blocks the next activity.
 */
declare class OpenBoxSignalMonitor {
    private readonly client;
    private readonly config;
    private _timer;
    private _running;
    private _workflowId;
    private _controller;
    private _pollCount;
    private _aborted;
    private _abortReason?;
    private _abortVerdict?;
    private _startedAt;
    constructor(client: GovernanceClient, config?: SignalMonitorConfig);
    /**
     * Start background polling for the given workflow session.
     *
     * @param workflowId  Root chain run_id (= workflow_id sent to OpenBox)
     * @param controller  AbortController whose .signal is passed to the LangChain executor
     */
    start(workflowId: string, controller: AbortController): void;
    /**
     * Stop the background poller. Safe to call multiple times.
     */
    stop(): void;
    get status(): SignalMonitorStatus;
    private _scheduleNext;
    private _poll;
}

/**
 * OpenBox LangChain SDK — Configuration & Initialization
 */

interface GovernanceConfig {
    onApiError: "fail_open" | "fail_closed";
    apiTimeout: number;
    sendChainStartEvent: boolean;
    sendChainEndEvent: boolean;
    sendToolStartEvent: boolean;
    sendToolEndEvent: boolean;
    sendLLMStartEvent: boolean;
    sendLLMEndEvent: boolean;
    skipChainTypes: Set<string>;
    skipToolTypes: Set<string>;
    hitl: HITLConfig;
    sessionId?: string;
}
type PartialGovernanceConfig = Partial<Omit<GovernanceConfig, "skipChainTypes" | "skipToolTypes" | "hitl">> & {
    skipChainTypes?: Set<string> | string[];
    skipToolTypes?: Set<string> | string[];
    hitl?: Partial<HITLConfig>;
};
declare function mergeConfig(partial: PartialGovernanceConfig): GovernanceConfig;
interface GlobalConfig {
    apiUrl: string;
    apiKey: string;
    governanceTimeout: number;
}
declare function getGlobalConfig(): GlobalConfig;
interface InitializeOptions {
    apiUrl: string;
    apiKey: string;
    governanceTimeout?: number;
    validate?: boolean;
}
declare function initialize(options: InitializeOptions): Promise<void>;

/**
 * OpenBox LangChain SDK — HTTP Telemetry Span Collection (Phase 3)
 *
 * Patches the global `fetch` API and optionally axios to capture HTTP
 * request/response bodies for outbound calls made during tool/LLM execution.
 * Mirrors the Temporal SDK's otel_setup.py httpx monkey-patching.
 *
 * Spans are stored per run_id in a SpanCollector and attached to the
 * next governance event payload as `spans[]`.
 */
interface HttpSpan {
    span_id: string;
    name: string;
    kind: "client";
    start_time: number;
    end_time?: number;
    duration_ns?: number;
    attributes: Record<string, unknown>;
    status: {
        code: string;
        description?: string;
    };
    request_body?: string;
    response_body?: string;
    request_headers?: Record<string, string>;
    response_headers?: Record<string, string>;
}
declare class SpanCollector {
    private readonly spans;
    private currentRunId;
    /** Span IDs evaluated at hook level — excluded from bulk ActivityCompleted payload */
    private readonly governedSpanIds;
    /** Set the active run_id that spans will be attributed to */
    setActiveRun(runId: string): void;
    clearActiveRun(): void;
    /** Expose current run_id for hook-governance lookup */
    get activeRunId(): string | null;
    addSpan(span: HttpSpan, runId?: string): void;
    /**
     * Mark a span as governed so it is excluded from the bulk ActivityCompleted
     * spans array (already individually evaluated at hook level).
     * Mirrors WorkflowSpanProcessor.mark_governed() in the Temporal SDK.
     */
    markSpanGoverned(spanId: string): void;
    isSpanGoverned(spanId: string): boolean;
    /**
     * Returns spans for a run, excluding any that were already evaluated by hook governance.
     */
    getSpans(runId: string): HttpSpan[];
    clearSpans(runId: string): void;
    get size(): number;
}
declare const globalSpanCollector: SpanCollector;
/**
 * Patch the global fetch to capture HTTP spans and evaluate hook-level governance.
 * Safe to call multiple times — only patches once.
 *
 * Two-stage governance (mirrors otel_setup.py HTTP hooks in Temporal SDK):
 *   1. "started" — evaluated BEFORE the real fetch fires (blocking)
 *   2. "completed" — evaluated AFTER response received (informational only)
 */
declare function patchFetch(collector?: SpanCollector): void;
/**
 * Restore the original fetch (useful in tests).
 */
declare function unpatchFetch(): void;
declare function isFetchPatched(): boolean;
interface TelemetryOptions {
    /** Collector to use (defaults to globalSpanCollector) */
    collector?: SpanCollector;
    /** Whether to patch fetch (default: true) */
    patchFetchEnabled?: boolean;
}
/**
 * Set up HTTP telemetry collection.
 * Call once at app startup, before any LangChain calls.
 *
 * @example
 * ```typescript
 * setupTelemetry();
 * const handler = await createOpenBoxHandler({ ... });
 * ```
 */
declare function setupTelemetry(options?: TelemetryOptions): SpanCollector;

/**
 * OpenBox LangChain SDK — Streaming Token Buffer (Phase 3)
 *
 * Accumulates streamed LLM tokens per run_id so that governance can evaluate
 * the full completion once streaming ends (handleLLMEnd fires with the full
 * LLMResult even for streaming models in LangChain >= 0.2).
 *
 * This module provides a per-run token accumulator that the callback handler
 * can use to build rich streaming telemetry.
 */
interface StreamingBuffer {
    runId: string;
    tokens: string[];
    startTime: number;
    model?: string;
}
declare class StreamingTokenBuffer {
    private readonly buffers;
    start(runId: string, model?: string): void;
    addToken(runId: string, token: string): void;
    getAccumulated(runId: string): string;
    getBuffer(runId: string): StreamingBuffer | undefined;
    clear(runId: string): void;
    get size(): number;
}
declare const globalStreamingBuffer: StreamingTokenBuffer;

/**
 * OpenBox LangChain SDK — RunBufferManager
 *
 * Tracks per-run state across the LangChain callback lifecycle.
 * Maps child run_ids back to their root chain run_id (= workflow_id).
 */

type RunType = "chain" | "llm" | "tool" | "agent" | "retriever";
interface RunBuffer {
    rootRunId: string;
    runId: string;
    parentRunId?: string;
    runType: RunType;
    name: string;
    startTime: number;
    endTime?: number;
    status?: "completed" | "failed";
    pendingApproval: boolean;
    verdict?: Verdict;
    verdictReason?: string;
    /** Attempt number — incremented each time the same runId is re-registered (retries) */
    attempt: number;
    /** Redacted input from guardrails — available via getRedactedInput() */
    redactedInput?: unknown;
    /** Redacted output from guardrails — available via getRedactedOutput() */
    redactedOutput?: unknown;
    metadata?: Record<string, unknown>;
    /** Set by hook governance when a per-request verdict blocks execution */
    aborted?: boolean;
    abortReason?: string;
    /** Set when hook verdict is HALT — triggers abortController.abort() in finally */
    haltRequested?: boolean;
    haltReason?: string;
}
declare class RunBufferManager {
    /** run_id → RunBuffer */
    private readonly buffers;
    /** run_id → root run_id */
    private readonly runToRoot;
    /**
     * Register a new run. Call on every handleChainStart / handleToolStart / handleLLMStart.
     * If parentRunId is undefined, this run IS the root.
     * If the runId is already registered (stale buffer from a previous session), it is reset.
     */
    registerRun(runId: string, runType: RunType, name: string, parentRunId?: string): void;
    /**
     * Get the root run_id for any run in the hierarchy.
     * Returns runId itself if not found (defensive).
     */
    getRootRunId(runId: string): string;
    getBuffer(runId: string): RunBuffer | undefined;
    markCompleted(runId: string): void;
    markFailed(runId: string): void;
    setVerdictForRun(runId: string, verdict: Verdict, reason?: string): void;
    setPendingApproval(runId: string, pending: boolean): void;
    isPendingApproval(runId: string): boolean;
    setAborted(runId: string, reason: string): void;
    isAborted(runId: string): boolean;
    getAbortReason(runId: string): string | undefined;
    setHaltRequested(runId: string, reason: string): void;
    isHaltRequested(runId: string): boolean;
    setRedactedInput(runId: string, value: unknown): void;
    getRedactedInput(runId: string): unknown;
    setRedactedOutput(runId: string, value: unknown): void;
    getRedactedOutput(runId: string): unknown;
    getAttempt(runId: string): number;
    /**
     * Remove all buffers associated with a root run (cleanup after chain ends).
     */
    cleanup(rootRunId: string): void;
    /** Total number of tracked runs (useful for debugging). */
    get size(): number;
}

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

interface OpenBoxCallbackHandlerOptions extends PartialGovernanceConfig {
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
declare class OpenBoxCallbackHandler extends BaseCallbackHandler {
    name: string;
    private readonly client;
    private readonly buffer;
    private readonly config;
    private readonly spanCollector;
    private readonly streamingBuffer;
    private readonly enforceAgentActions;
    readonly signalMonitor?: OpenBoxSignalMonitor;
    /** AbortController wired to the signal monitor — pass .signal to your LangChain executor */
    readonly abortController?: AbortController;
    /**
     * Run IDs where wrapTool has already performed the AGE ToolCompleted evaluation.
     * handleToolEnd skips re-evaluation for these runs to avoid double-sending.
     */
    private readonly _toolEndHandledByWrapper;
    constructor(options?: OpenBoxCallbackHandlerOptions);
    handleChainStart(chain: Serialized, inputs: ChainValues, runId: string, parentRunId?: string, _tags?: string[], _metadata?: Record<string, unknown>, runType?: string, name?: string): Promise<void>;
    handleChainEnd(outputs: ChainValues, runId: string, parentRunId?: string): Promise<void>;
    handleChainError(err: unknown, runId: string, parentRunId?: string): Promise<void>;
    /**
     * Called for ChatModel invocations — receives the actual BaseMessage[][] array
     * that will be sent to the API. With awaitHandlers=true we can mutate these
     * in-place so redacted content replaces PII before the OpenAI call fires.
     */
    handleChatModelStart(llm: Serialized, messages: BaseMessage[][], runId: string, parentRunId?: string, extraParams?: Record<string, unknown>, tags?: string[], metadata?: Record<string, unknown>, name?: string): Promise<void>;
    handleLLMStart(llm: Serialized, prompts: string[], runId: string, parentRunId?: string, _extraParams?: Record<string, unknown>, _tags?: string[], _metadata?: Record<string, unknown>, name?: string): Promise<void>;
    handleLLMEnd(output: LLMResult, runId: string, parentRunId?: string): Promise<void>;
    handleLLMError(err: unknown, runId: string, parentRunId?: string): Promise<void>;
    handleToolStart(tool: Serialized, input: string, runId: string, parentRunId?: string, _tags?: string[], _metadata?: Record<string, unknown>, name?: string): Promise<void>;
    handleToolEnd(output: string, runId: string, parentRunId?: string): Promise<void>;
    /**
     * Send the ToolCompleted governance event and enforce the AGE verdict.
     * Called by handleToolEnd normally, or by wrapTool directly (before returning
     * to LangChain) so that REQUIRE_APPROVAL blocks the tool result.
     */
    evaluateToolCompleted(runId: string, output: string, parentRunId?: string): Promise<void>;
    private _evaluateToolCompleted;
    handleToolError(err: unknown, runId: string, parentRunId?: string): Promise<void>;
    handleLLMNewToken(token: string, _idx: {
        prompt: number;
        completion: number;
    }, runId: string): Promise<void>;
    handleAgentAction(action: AgentAction, runId: string, _parentRunId?: string): Promise<void>;
    handleAgentFinish(_finish: AgentFinish, _runId: string, _parentRunId?: string): Promise<void>;
    handleRetrieverStart(retriever: Serialized, _query: string, runId: string, parentRunId?: string): Promise<void>;
    handleRetrieverEnd(_documents: DocumentInterface[], runId: string, _parentRunId?: string): Promise<void>;
    handleRetrieverError(_err: unknown, runId: string, _parentRunId?: string): Promise<void>;
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
    getRedactedInput(runId: string): unknown;
    getRedactedOutput(runId: string): unknown;
    /**
     * Mark that wrapTool has already sent the ToolCompleted AGE evaluation for this runId.
     * handleToolEnd will skip re-evaluation to avoid double-sending.
     */
    markToolEndHandledByWrapper(runId: string): void;
    /**
     * Mirrors Temporal's pre-execution pending verdict check:
     * if a prior event on this run returned BLOCK/HALT, prevent execution.
     */
    private _checkPendingStopVerdict;
    /**
     * Mirrors Temporal's pre-execution pending-approval check:
     * if buffer has pendingApproval=true from a previous attempt, poll until resolved.
     */
    private _pollPendingApproval;
    /**
     * Store the verdict from a pre-execution (Started) event response into the run buffer.
     * Only called for *Started* events — Completed/End events are observability-only
     * and must NOT poison the pending-stop buffer for subsequent runs.
     */
    private _storeVerdict;
    /**
     * Mirrors Temporal: check guardrails input validation_passed=false → throw before execution.
     * Builds short clean reason strings from guardrail type — never dumps raw content.
     */
    private _checkGuardrailsInput;
    /**
     * Mirrors Temporal: check guardrails output validation_passed=false → throw after execution.
     */
    private _checkGuardrailsOutput;
    private _buildEvent;
    /** Clean up buffer when the root chain finishes */
    private _cleanupIfRoot;
    /** @internal */
    _getClient(): GovernanceClient;
    /** @internal */
    _getBuffer(): RunBufferManager;
    /** @internal */
    _getConfig(): GovernanceConfig;
}

/**
 * OpenBox LangChain SDK — Custom Error Classes
 */
declare class OpenBoxError extends Error {
    constructor(message: string);
}
declare class OpenBoxAuthError extends OpenBoxError {
    constructor(message: string);
}
declare class OpenBoxNetworkError extends OpenBoxError {
    constructor(message: string);
}
declare class OpenBoxInsecureURLError extends OpenBoxError {
    constructor(message: string);
}
declare class GovernanceBlockedError extends OpenBoxError {
    /** Normalized verdict: "block" | "halt" | "require_approval" */
    readonly verdict: string;
    /** Resource identifier (URL, file path, etc.) that triggered the block */
    readonly identifier: string;
    readonly policyId?: string;
    readonly riskScore?: number;
    constructor(verdictOrReason: string, reasonOrPolicyId?: string, identifierOrRiskScore?: string | number, policyId?: string, riskScore?: number);
}
declare class GovernanceHaltError extends OpenBoxError {
    readonly verdict: "halt";
    /** Resource identifier that triggered the halt */
    readonly identifier: string;
    readonly policyId?: string;
    readonly riskScore?: number;
    constructor(reason: string, identifier?: string, policyId?: string, riskScore?: number);
}
declare class GuardrailsValidationError extends OpenBoxError {
    readonly reasons: string[];
    constructor(reasons: string[]);
}
declare class ApprovalExpiredError extends OpenBoxError {
    constructor(message: string);
}
declare class ApprovalRejectedError extends OpenBoxError {
    constructor(reason: string);
}
declare class ApprovalTimeoutError extends OpenBoxError {
    readonly maxWaitMs: number;
    constructor(maxWaitMs: number);
}

/**
 * OpenBox LangChain SDK — Verdict Enforcement
 *
 * Maps GovernanceVerdictResponse → action (throw error, log, or no-op).
 */

/**
 * Context for verdict enforcement — determines which error to throw
 * and whether HITL is applicable.
 */
type VerdictContext = "chain_start" | "chain_end" | "tool_start" | "tool_end" | "llm_start" | "llm_end" | "agent_action" | "agent_finish" | "other";
declare function eventTypeToContext(eventType: LangChainEventType): VerdictContext;
/**
 * Whether HITL polling applies to this context.
 * HITL only applies to "start" events (before execution).
 * For "end" events, REQUIRE_APPROVAL → treat as BLOCK.
 */
declare function isHITLApplicable(context: VerdictContext): boolean;
interface VerdictEnforcementResult {
    /** True if HITL polling should begin */
    requiresHITL: boolean;
    /** True if execution should be blocked (non-HITL) */
    blocked: boolean;
}
/**
 * Enforce the governance verdict by throwing the appropriate error
 * or returning a result indicating what the caller should do next.
 *
 * Throws synchronously for BLOCK/HALT/guardrails failure.
 * Returns { requiresHITL: true } when HITL polling should begin.
 * Returns { blocked: false, requiresHITL: false } for ALLOW/CONSTRAIN.
 */
declare function enforceVerdict(response: GovernanceVerdictResponse, context: VerdictContext): VerdictEnforcementResult;

/**
 * OpenBox LangChain SDK — Human-in-the-Loop (HITL) Approval Polling
 *
 * LangChain has no built-in retry mechanism (unlike Temporal).
 * When governance returns REQUIRE_APPROVAL, we block inside the async
 * callback handler by polling until a decision is made or timeout occurs.
 */

interface HITLPollParams {
    workflowId: string;
    runId: string;
    activityId: string;
    activityType: string;
}
/**
 * Block until governance approves, rejects, or times out.
 *
 * Resolves successfully when approval is granted (ALLOW verdict).
 * Throws on rejection, expiry, timeout, or HALT/BLOCK verdict.
 */
declare function pollUntilDecision(client: GovernanceClient, params: HITLPollParams, config: HITLConfig): Promise<void>;

/**
 * OpenBox LangChain SDK — Guardrails Redaction
 *
 * Applies input/output redaction from guardrails_result to the
 * data that flows into/out of tool and LLM executions.
 */

/**
 * Apply input guardrails redaction to a tool input string or object.
 * Returns the (possibly redacted) value to use for execution.
 */
declare function applyInputRedaction(originalInput: unknown, guardrails: GuardrailsResult | undefined): unknown;
/**
 * Apply output guardrails redaction to tool output or LLM completion.
 * Returns the (possibly redacted) output.
 */
declare function applyOutputRedaction(originalOutput: unknown, guardrails: GuardrailsResult | undefined): unknown;
/**
 * Extract guardrails reason strings for error messages.
 */
declare function getGuardrailsReasons(guardrails: GuardrailsResult): string[];

/**
 * OpenBox LangChain SDK — Safe JSON Serialization
 *
 * LangChain objects (AIMessage, HumanMessage, Document, ChatGeneration, etc.)
 * can contain non-serializable types, circular refs, or large binary data.
 * This module provides safe serialization for governance payloads.
 */
/**
 * Safely serialize any value to a JSON-compatible type.
 * Handles LangChain message objects, Documents, nested structures, circular refs.
 */
declare function safeSerialize(value: unknown, depth?: number): unknown;
/**
 * Extract plain text content from a LangChain prompt or message array.
 * Used for sending prompts to governance.
 */
declare function extractPromptText(prompts: unknown): string;
/**
 * Extract completion text from an LLMResult.
 */
declare function extractCompletionText(output: unknown): string;
/**
 * Extract token usage from LLMResult.llmOutput.
 */
declare function extractTokenUsage(output: unknown): {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
};
/**
 * Extract model name from LLM serialized info.
 */
declare function extractModelName(llm: unknown): string | undefined;
/**
 * Extract finish reason from LLMResult.
 */
declare function extractFinishReason(output: unknown): string | undefined;
/**
 * Current UTC time in RFC3339 format.
 */
declare function rfc3339Now(): string;

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

/** Minimal interface for any LangChain tool that has a _call method */
interface WrappableTool {
    name: string;
    _call(input: unknown, runManager?: unknown): Promise<string>;
}
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
declare function wrapTool<T extends WrappableTool>(tool: T, handler: OpenBoxCallbackHandler): T;
/**
 * Wrap an array of tools at once.
 */
declare function wrapTools<T extends WrappableTool>(tools: T[], handler: OpenBoxCallbackHandler): T[];
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
declare function wrapLLM<T extends BaseLanguageModelInterface>(llm: T, handler: OpenBoxCallbackHandler): T;

/**
 * OpenBox LangChain SDK — Hook-Level Governance
 *
 * Evaluates every outbound HTTP request made during a tool/LLM execution
 * at two stages: "started" (blocking, before request fires) and "completed"
 * (informational, after response received).
 *
 * Mirrors openbox-temporal-sdk-python/openbox/hook_governance.py.
 *
 * Architecture:
 *   1. telemetry.ts patchFetch detects an outbound HTTP call
 *   2. patchFetch calls evaluateHttpHook("started", ...) before firing
 *   3. If verdict is BLOCK/HALT/REQUIRE_APPROVAL → GovernanceBlockedError thrown
 *      → fetch never fires, tool execution aborts
 *   4. After response received → evaluateHttpHook("completed", ...) — fire-and-forget
 *   5. Span is marked governed → not re-sent in bulk ActivityCompleted spans
 */

interface HookGovernanceConfig {
    client: GovernanceClient;
    buffer: RunBufferManager;
    spanCollector: SpanCollector;
    onApiError: "fail_open" | "fail_closed";
}
/**
 * Configure hook-level governance. Call once when setting up the handler.
 * Mirrors hook_governance.configure() in the Temporal SDK.
 */
declare function configureHookGovernance(options: HookGovernanceConfig): void;
/**
 * Check if hook-level governance is active.
 * telemetry.ts uses this to decide whether to evaluate per-request.
 */
declare function isHookGovernanceConfigured(): boolean;
/**
 * Reset hook governance config (used in tests / cleanup).
 */
declare function resetHookGovernance(): void;
/**
 * Evaluate governance for an HTTP request at a given stage.
 *
 * - "started": called BEFORE the real fetch fires. Throws GovernanceBlockedError
 *   if verdict is BLOCK/HALT/REQUIRE_APPROVAL — the fetch never executes.
 * - "completed": called AFTER response received. Errors are swallowed (informational).
 *
 * Mirrors hook_governance.evaluate_async() in the Temporal SDK.
 *
 * @param stage    "started" | "completed"
 * @param span     HttpSpan being evaluated (may be partial for "started")
 * @param runId    LangChain run_id of the active tool/LLM run
 */
declare function evaluateHttpHook(stage: "started" | "completed", span: HttpSpan, runId: string | null): Promise<void>;

interface CreateOpenBoxHandlerOptions extends InitializeOptions, Omit<OpenBoxCallbackHandlerOptions, "client"> {
    /**
     * If true, creates an AbortController + OpenBoxSignalMonitor and attaches them
     * to the handler automatically. The controller is accessible via handler.abortController.
     * Pass the controller's signal to your LangChain executor's RunnableConfig.
     */
    enableSignalMonitor?: boolean;
    /** Config for the signal monitor (only used if enableSignalMonitor is true). */
    signalMonitorConfig?: SignalMonitorConfig;
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
declare function createOpenBoxHandler(options: CreateOpenBoxHandlerOptions): Promise<OpenBoxCallbackHandler>;

export { ApprovalExpiredError, ApprovalRejectedError, type ApprovalResponse, ApprovalTimeoutError, type CreateOpenBoxHandlerOptions, DEFAULT_HITL_CONFIG, GovernanceBlockedError, GovernanceClient, type GovernanceClientConfig, type GovernanceConfig, GovernanceHaltError, type GovernanceVerdictResponse, type GuardrailsReason, type GuardrailsResult, GuardrailsValidationError, type HITLConfig, type HITLPollParams, type HookStage, type HookTrigger, type HttpHookTrigger, type HttpSpan, type InitializeOptions, type LangChainEventType, type LangChainGovernanceEvent, OpenBoxAuthError, OpenBoxCallbackHandler, type OpenBoxCallbackHandlerOptions, OpenBoxError, OpenBoxInsecureURLError, OpenBoxNetworkError, OpenBoxSignalMonitor, type PartialGovernanceConfig, type RunBuffer, RunBufferManager, type RunType, type SignalMonitorConfig, type SignalMonitorStatus, SpanCollector, type StreamingBuffer, StreamingTokenBuffer, type TelemetryOptions, Verdict, type VerdictContext, type WrappableTool, applyInputRedaction, applyOutputRedaction, configureHookGovernance, createOpenBoxHandler, enforceVerdict, evaluateHttpHook, eventTypeToContext, extractCompletionText, extractFinishReason, extractModelName, extractPromptText, extractTokenUsage, getGlobalConfig, getGuardrailsReasons, globalSpanCollector, globalStreamingBuffer, highestPriorityVerdict, initialize, isFetchPatched, isHITLApplicable, isHookGovernanceConfigured, mergeConfig, parseApprovalResponse, parseGovernanceResponse, patchFetch, pollUntilDecision, resetHookGovernance, rfc3339Now, safeSerialize, setupTelemetry, unpatchFetch, verdictFromString, verdictPriority, verdictRequiresApproval, verdictShouldStop, wrapLLM, wrapTool, wrapTools };
