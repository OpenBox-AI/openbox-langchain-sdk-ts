// src/errors.ts
var OpenBoxError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "OpenBoxError";
  }
};
var OpenBoxAuthError = class extends OpenBoxError {
  constructor(message) {
    super(message);
    this.name = "OpenBoxAuthError";
  }
};
var OpenBoxNetworkError = class extends OpenBoxError {
  constructor(message) {
    super(message);
    this.name = "OpenBoxNetworkError";
  }
};
var OpenBoxInsecureURLError = class extends OpenBoxError {
  constructor(message) {
    super(message);
    this.name = "OpenBoxInsecureURLError";
  }
};
var GovernanceBlockedError = class extends OpenBoxError {
  constructor(verdictOrReason, reasonOrPolicyId, identifierOrRiskScore, policyId, riskScore) {
    const isHookCall = verdictOrReason === "block" || verdictOrReason === "halt" || verdictOrReason === "require_approval" || verdictOrReason === "stop";
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
      this.policyId = typeof reasonOrPolicyId === "string" ? reasonOrPolicyId : void 0;
      this.riskScore = typeof identifierOrRiskScore === "number" ? identifierOrRiskScore : void 0;
    }
    this.name = "GovernanceBlockedError";
  }
};
var GovernanceHaltError = class extends OpenBoxError {
  constructor(reason, identifier = "", policyId, riskScore) {
    super(reason);
    this.verdict = "halt";
    this.name = "GovernanceHaltError";
    this.identifier = identifier;
    this.policyId = policyId;
    this.riskScore = riskScore;
  }
};
var GuardrailsValidationError = class extends OpenBoxError {
  constructor(reasons) {
    super(`Guardrails validation failed: ${reasons.join("; ")}`);
    this.name = "GuardrailsValidationError";
    this.reasons = reasons;
  }
};
var ApprovalExpiredError = class extends OpenBoxError {
  constructor(message) {
    super(message);
    this.name = "ApprovalExpiredError";
  }
};
var ApprovalRejectedError = class extends OpenBoxError {
  constructor(reason) {
    super(reason);
    this.name = "ApprovalRejectedError";
  }
};
var ApprovalTimeoutError = class extends OpenBoxError {
  constructor(maxWaitMs) {
    super(`HITL approval timed out after ${maxWaitMs}ms`);
    this.name = "ApprovalTimeoutError";
    this.maxWaitMs = maxWaitMs;
  }
};

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
  ApprovalTimeoutError
};
