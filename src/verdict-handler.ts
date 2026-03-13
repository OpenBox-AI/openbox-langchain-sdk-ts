/**
 * OpenBox LangChain SDK — Verdict Enforcement
 *
 * Maps GovernanceVerdictResponse → action (throw error, log, or no-op).
 */

import {
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
} from "./errors.js";
import {
  GovernanceVerdictResponse,
  LangChainEventType,
  Verdict,
  verdictRequiresApproval,
  verdictShouldStop,
} from "./types.js";

/**
 * Context for verdict enforcement — determines which error to throw
 * and whether HITL is applicable.
 */
export type VerdictContext =
  | "chain_start"
  | "chain_end"
  | "tool_start"
  | "tool_end"
  | "llm_start"
  | "llm_end"
  | "agent_action"
  | "agent_finish"
  | "other";

export function eventTypeToContext(eventType: LangChainEventType): VerdictContext {
  switch (eventType) {
    case "ChainStarted": return "chain_start";
    case "ChainCompleted": return "chain_end";
    case "ToolStarted": return "tool_start";
    case "ToolCompleted": return "tool_end";
    case "LLMStarted": return "llm_start";
    case "LLMCompleted": return "llm_end";
    case "AgentAction": return "agent_action";
    case "AgentFinish": return "agent_finish";
    default: return "other";
  }
}

/**
 * Whether HITL polling applies to this context.
 * HITL only applies to "start" events (before execution).
 * For "end" events, REQUIRE_APPROVAL → treat as BLOCK.
 */
export function isHITLApplicable(context: VerdictContext): boolean {
  // tool_end and llm_end are included: AGE Behavior Rules evaluate on ActivityCompleted
  // and can return REQUIRE_APPROVAL, which must trigger HITL polling not a throw.
  return (
    context === "tool_start" ||
    context === "tool_end" ||
    context === "llm_start" ||
    context === "llm_end" ||
    context === "agent_action"
  );
}

export interface VerdictEnforcementResult {
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
export function enforceVerdict(
  response: GovernanceVerdictResponse,
  context: VerdictContext
): VerdictEnforcementResult {
  const { verdict, reason, policy_id, risk_score } = response;

  // Chain/agent end contexts are observability-only — AGE does not evaluate these
  // tool_end and llm_end carry AGE Behavior Rule verdicts and must be enforced
  const isObservationOnlyContext =
    context === "chain_end" ||
    context === "agent_finish" ||
    context === "other";

  if (isObservationOnlyContext) {
    return { requiresHITL: false, blocked: false };
  }

  // 1. Guardrails validation failure — always block regardless of verdict
  if (
    response.guardrails_result &&
    !response.guardrails_result.validation_passed
  ) {
    const reasons = (response.guardrails_result.reasons ?? []).map(
      (r) => r.reason
    ).filter(Boolean);
    throw new GuardrailsValidationError(
      reasons.length > 0 ? reasons : ["Guardrails validation failed"]
    );
  }

  // 2. HALT — throw immediately, no retry
  if (verdict === Verdict.HALT) {
    throw new GovernanceHaltError(
      reason ?? "Workflow halted by governance policy",
      "",       // identifier — not available at activity level
      policy_id,
      risk_score
    );
  }

  // 3. BLOCK — throw immediately
  if (verdict === Verdict.BLOCK) {
    throw new GovernanceBlockedError(
      reason ?? "Action blocked by governance policy",
      policy_id,
      risk_score
    );
  }

  // 4. REQUIRE_APPROVAL
  if (verdictRequiresApproval(verdict)) {
    if (isHITLApplicable(context)) {
      // Return signal to start HITL polling — caller handles it
      return { requiresHITL: true, blocked: false };
    } else {
      // REQUIRE_APPROVAL on end events or chain level → treat as BLOCK
      throw new GovernanceBlockedError(
        reason ?? "Action requires approval but cannot be paused at this stage",
        policy_id,
        risk_score
      );
    }
  }

  // 5. CONSTRAIN — log warning, continue
  if (verdict === Verdict.CONSTRAIN) {
    if (reason) {
      console.warn(
        `[OpenBox] Governance constraint: ${reason}${policy_id ? ` (policy: ${policy_id})` : ""}`
      );
    }
    return { requiresHITL: false, blocked: false };
  }

  // 6. ALLOW — no action
  return { requiresHITL: false, blocked: false };
}

/**
 * Quick check — does this verdict immediately stop execution?
 * Used for fast-path checks without throwing.
 */
export function verdictStops(verdict: Verdict): boolean {
  return verdictShouldStop(verdict);
}
