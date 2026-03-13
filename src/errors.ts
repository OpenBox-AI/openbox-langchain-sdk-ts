/**
 * OpenBox LangChain SDK — Custom Error Classes
 */

export class OpenBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenBoxError";
  }
}

export class OpenBoxAuthError extends OpenBoxError {
  constructor(message: string) {
    super(message);
    this.name = "OpenBoxAuthError";
  }
}

export class OpenBoxNetworkError extends OpenBoxError {
  constructor(message: string) {
    super(message);
    this.name = "OpenBoxNetworkError";
  }
}

export class OpenBoxInsecureURLError extends OpenBoxError {
  constructor(message: string) {
    super(message);
    this.name = "OpenBoxInsecureURLError";
  }
}

export class GovernanceBlockedError extends OpenBoxError {
  /** Normalized verdict: "block" | "halt" | "require_approval" */
  readonly verdict: string;
  /** Resource identifier (URL, file path, etc.) that triggered the block */
  readonly identifier: string;
  readonly policyId?: string;
  readonly riskScore?: number;

  constructor(
    verdictOrReason: string,
    reasonOrPolicyId?: string,
    identifierOrRiskScore?: string | number,
    policyId?: string,
    riskScore?: number
  ) {
    // Overload 1 (hook-level): new GovernanceBlockedError(verdict, reason, identifier)
    // Overload 2 (legacy):     new GovernanceBlockedError(reason, policyId?, riskScore?)
    const isHookCall =
      verdictOrReason === "block" ||
      verdictOrReason === "halt" ||
      verdictOrReason === "require_approval" ||
      verdictOrReason === "stop";

    if (isHookCall) {
      super(reasonOrPolicyId ?? verdictOrReason);
      this.verdict = verdictOrReason;
      this.identifier = typeof identifierOrRiskScore === "string" ? identifierOrRiskScore : "";
      this.policyId = policyId;
      this.riskScore = riskScore;
    } else {
      super(verdictOrReason);
      this.verdict = "block";
      this.identifier = "";
      this.policyId = typeof reasonOrPolicyId === "string" ? reasonOrPolicyId : undefined;
      this.riskScore = typeof identifierOrRiskScore === "number" ? identifierOrRiskScore : undefined;
    }
    this.name = "GovernanceBlockedError";
  }
}

export class GovernanceHaltError extends OpenBoxError {
  readonly verdict = "halt" as const;
  /** Resource identifier that triggered the halt */
  readonly identifier: string;
  readonly policyId?: string;
  readonly riskScore?: number;

  constructor(reason: string, identifier = "", policyId?: string, riskScore?: number) {
    super(reason);
    this.name = "GovernanceHaltError";
    this.identifier = identifier;
    this.policyId = policyId;
    this.riskScore = riskScore;
  }
}

export class GuardrailsValidationError extends OpenBoxError {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`Guardrails validation failed: ${reasons.join("; ")}`);
    this.name = "GuardrailsValidationError";
    this.reasons = reasons;
  }
}

export class ApprovalExpiredError extends OpenBoxError {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalExpiredError";
  }
}

export class ApprovalRejectedError extends OpenBoxError {
  constructor(reason: string) {
    super(reason);
    this.name = "ApprovalRejectedError";
  }
}

export class ApprovalTimeoutError extends OpenBoxError {
  readonly maxWaitMs: number;

  constructor(maxWaitMs: number) {
    super(`HITL approval timed out after ${maxWaitMs}ms`);
    this.name = "ApprovalTimeoutError";
    this.maxWaitMs = maxWaitMs;
  }
}
