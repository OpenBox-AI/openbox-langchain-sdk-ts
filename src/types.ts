/**
 * OpenBox LangChain SDK — Core Types
 */

// ═══════════════════════════════════════════════════════════════════
// Verdict
// ═══════════════════════════════════════════════════════════════════

export enum Verdict {
  ALLOW = "allow",
  CONSTRAIN = "constrain",
  REQUIRE_APPROVAL = "require_approval",
  BLOCK = "block",
  HALT = "halt",
}

const VERDICT_PRIORITY: Record<Verdict, number> = {
  [Verdict.ALLOW]: 1,
  [Verdict.CONSTRAIN]: 2,
  [Verdict.REQUIRE_APPROVAL]: 3,
  [Verdict.BLOCK]: 4,
  [Verdict.HALT]: 5,
};

export function verdictFromString(value: string | null | undefined): Verdict {
  if (!value) return Verdict.ALLOW;
  const normalized = value.toLowerCase().replace(/-/g, "_");
  if (normalized === "continue") return Verdict.ALLOW;
  if (normalized === "stop") return Verdict.HALT;
  if (normalized === "request_approval") return Verdict.REQUIRE_APPROVAL;
  const match = Object.values(Verdict).find((v) => v === normalized);
  return match ?? Verdict.ALLOW;
}

export function verdictPriority(v: Verdict): number {
  return VERDICT_PRIORITY[v];
}

export function highestPriorityVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return Verdict.ALLOW;
  return verdicts.reduce((a, b) =>
    verdictPriority(a) >= verdictPriority(b) ? a : b
  );
}

export function verdictShouldStop(v: Verdict): boolean {
  return v === Verdict.BLOCK || v === Verdict.HALT;
}

export function verdictRequiresApproval(v: Verdict): boolean {
  return v === Verdict.REQUIRE_APPROVAL;
}

// ═══════════════════════════════════════════════════════════════════
// Event Types
// ═══════════════════════════════════════════════════════════════════

export type LangChainEventType =
  | "ChainStarted"
  | "ChainCompleted"
  | "ChainFailed"
  | "ToolStarted"
  | "ToolCompleted"
  | "ToolFailed"
  | "LLMStarted"
  | "LLMCompleted"
  | "LLMFailed"
  | "AgentAction"
  | "AgentFinish"
  | "RetrieverStarted"
  | "RetrieverCompleted"
  | "RetrieverFailed";

// Server-accepted event types (OpenBox Core only accepts these 6)
export type ServerEventType =
  | "WorkflowStarted"
  | "WorkflowCompleted"
  | "WorkflowFailed"
  | "SignalReceived"
  | "ActivityStarted"
  | "ActivityCompleted";

/**
 * Maps a LangChain event type to the server-accepted Temporal equivalent.
 * Chain = Workflow, Tool/LLM/Agent/Retriever = Activity
 */
export function toServerEventType(t: LangChainEventType): ServerEventType {
  switch (t) {
    case "ChainStarted":       return "WorkflowStarted";
    case "ChainCompleted":     return "WorkflowCompleted";
    case "ChainFailed":        return "WorkflowFailed";
    case "ToolStarted":
    case "LLMStarted":
    case "AgentAction":
    case "RetrieverStarted":   return "ActivityStarted";
    case "ToolCompleted":
    case "ToolFailed":
    case "LLMCompleted":
    case "LLMFailed":
    case "AgentFinish":
    case "RetrieverCompleted":
    case "RetrieverFailed":    return "ActivityCompleted";
  }
}

// ═══════════════════════════════════════════════════════════════════
// Governance Event Payload (sent to OpenBox Core)
// ═══════════════════════════════════════════════════════════════════

export interface ErrorDetails {
  type: string;
  message: string;
  cause?: {
    type: string;
    message: string;
  };
}

export interface SpanData {
  span_id: string;
  trace_id?: string;
  parent_span_id?: string;
  name: string;
  kind?: string;
  start_time?: number;
  end_time?: number;
  duration_ns?: number;
  attributes?: Record<string, unknown>;
  status?: { code: string; description?: string };
  events?: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }>;
  request_body?: string;
  response_body?: string;
  request_headers?: Record<string, string>;
  response_headers?: Record<string, string>;
}

// ═══════════════════════════════════════════════════════════════════
// Hook Trigger (hook-level governance — per-request evaluation)
// ═══════════════════════════════════════════════════════════════════

export type HookStage = "started" | "completed";

export interface HttpHookTrigger {
  type: "http_request";
  stage: HookStage;
  "http.method": string;
  "http.url": string;
  attribute_key_identifiers: ["http.method", "http.url"];
  request_headers?: Record<string, string>;
  request_body?: string;
  // completed stage only
  response_headers?: Record<string, string>;
  response_body?: string;
  "http.status_code"?: number;
}

export type HookTrigger = HttpHookTrigger;

export interface LangChainGovernanceEvent {
  // Base fields — matches OpenBox Core contract
  source: "workflow-telemetry";
  event_type: LangChainEventType;   // SDK-internal label (mapped to server type before sending)
  workflow_id: string;              // = root chain run_id (UUID)
  run_id: string;                   // = root chain run_id
  workflow_type: string;            // = chain class name or agent name
  task_queue: string;               // = "langchain" (required by server)
  timestamp: string;                // RFC3339 UTC

  // Activity-equivalent fields
  activity_id?: string;       // = tool/LLM run_id
  activity_type?: string;     // = tool name or LLM class name
  activity_input?: unknown[];
  activity_output?: unknown;
  workflow_output?: unknown;  // = final chain output (WorkflowCompleted only — mirrors Temporal)
  spans?: SpanData[];
  span_count?: number;
  status?: "completed" | "failed";
  start_time?: number;        // Unix epoch seconds (float) — mirrors Temporal SDK
  end_time?: number;          // Unix epoch seconds (float) — mirrors Temporal SDK
  duration_ms?: number;
  error?: ErrorDetails;

  // LangChain-specific extensions
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

// ═══════════════════════════════════════════════════════════════════
// Governance Response (from OpenBox Core)
// ═══════════════════════════════════════════════════════════════════

export interface GuardrailsReason {
  type: string;
  field: string;
  reason: string;
}

export interface GuardrailsResult {
  input_type: "activity_input" | "activity_output";
  redacted_input: unknown;
  validation_passed: boolean;
  reasons?: GuardrailsReason[];
  raw_logs?: Record<string, unknown>;
}

export interface GovernanceVerdictResponse {
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

export function parseGovernanceResponse(data: Record<string, unknown>): GovernanceVerdictResponse {
  const verdictRaw = (data["verdict"] ?? data["action"]) as string | undefined;
  const verdict = verdictFromString(verdictRaw);

  let guardrailsResult: GuardrailsResult | undefined;
  if (data["guardrails_result"] && typeof data["guardrails_result"] === "object") {
    const gr = data["guardrails_result"] as Record<string, unknown>;
    guardrailsResult = {
      input_type: (gr["input_type"] as "activity_input" | "activity_output") ?? "activity_input",
      redacted_input: gr["redacted_input"],
      validation_passed: gr["validation_passed"] !== false,
      reasons: (gr["reasons"] as GuardrailsReason[]) ?? [],
      raw_logs: gr["raw_logs"] as Record<string, unknown> | undefined,
    };
  }

  return {
    verdict,
    reason: data["reason"] as string | undefined,
    policy_id: data["policy_id"] as string | undefined,
    risk_score: (data["risk_score"] as number) ?? 0,
    governance_event_id: data["governance_event_id"] as string | undefined,
    guardrails_result: guardrailsResult,
    approval_id: data["approval_id"] as string | undefined,
    approval_expiration_time: data["approval_expiration_time"] as string | undefined,
    trust_tier: data["trust_tier"] as string | undefined,
    alignment_score: data["alignment_score"] as number | undefined,
    behavioral_violations: data["behavioral_violations"] as string[] | undefined,
    constraints: data["constraints"] as unknown[] | undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Approval Response (from /api/v1/governance/approval)
// ═══════════════════════════════════════════════════════════════════

export interface ApprovalResponse {
  verdict: Verdict;
  reason?: string;
  approval_expiration_time?: string;
  expired?: boolean;
}

export function parseApprovalResponse(data: Record<string, unknown>): ApprovalResponse {
  return {
    verdict: verdictFromString((data["verdict"] ?? data["action"]) as string | undefined),
    reason: data["reason"] as string | undefined,
    approval_expiration_time: data["approval_expiration_time"] as string | undefined,
    expired: data["expired"] as boolean | undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════
// HITL Config
// ═══════════════════════════════════════════════════════════════════

export interface HITLConfig {
  enabled: boolean;
  pollIntervalMs: number;
  maxWaitMs: number;
  skipToolTypes?: Set<string>;
}

export const DEFAULT_HITL_CONFIG: HITLConfig = {
  enabled: true,
  pollIntervalMs: 5_000,
  maxWaitMs: 600_000,
  skipToolTypes: new Set(),
};
