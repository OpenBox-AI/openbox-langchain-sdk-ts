// src/types.ts
var Verdict = /* @__PURE__ */ ((Verdict2) => {
  Verdict2["ALLOW"] = "allow";
  Verdict2["CONSTRAIN"] = "constrain";
  Verdict2["REQUIRE_APPROVAL"] = "require_approval";
  Verdict2["BLOCK"] = "block";
  Verdict2["HALT"] = "halt";
  return Verdict2;
})(Verdict || {});
var VERDICT_PRIORITY = {
  ["allow" /* ALLOW */]: 1,
  ["constrain" /* CONSTRAIN */]: 2,
  ["require_approval" /* REQUIRE_APPROVAL */]: 3,
  ["block" /* BLOCK */]: 4,
  ["halt" /* HALT */]: 5
};
function verdictFromString(value) {
  if (!value) return "allow" /* ALLOW */;
  const normalized = value.toLowerCase().replace(/-/g, "_");
  if (normalized === "continue") return "allow" /* ALLOW */;
  if (normalized === "stop") return "halt" /* HALT */;
  if (normalized === "request_approval") return "require_approval" /* REQUIRE_APPROVAL */;
  const match = Object.values(Verdict).find((v) => v === normalized);
  return match ?? "allow" /* ALLOW */;
}
function verdictPriority(v) {
  return VERDICT_PRIORITY[v];
}
function highestPriorityVerdict(verdicts) {
  if (verdicts.length === 0) return "allow" /* ALLOW */;
  return verdicts.reduce(
    (a, b) => verdictPriority(a) >= verdictPriority(b) ? a : b
  );
}
function verdictShouldStop(v) {
  return v === "block" /* BLOCK */ || v === "halt" /* HALT */;
}
function verdictRequiresApproval(v) {
  return v === "require_approval" /* REQUIRE_APPROVAL */;
}
function toServerEventType(t) {
  switch (t) {
    case "ChainStarted":
      return "WorkflowStarted";
    case "ChainCompleted":
      return "WorkflowCompleted";
    case "ChainFailed":
      return "WorkflowFailed";
    case "ToolStarted":
    case "LLMStarted":
    case "AgentAction":
    case "RetrieverStarted":
      return "ActivityStarted";
    case "ToolCompleted":
    case "ToolFailed":
    case "LLMCompleted":
    case "LLMFailed":
    case "AgentFinish":
    case "RetrieverCompleted":
    case "RetrieverFailed":
      return "ActivityCompleted";
  }
}
function parseGovernanceResponse(data) {
  const verdictRaw = data["verdict"] ?? data["action"];
  const verdict = verdictFromString(verdictRaw);
  let guardrailsResult;
  if (data["guardrails_result"] && typeof data["guardrails_result"] === "object") {
    const gr = data["guardrails_result"];
    guardrailsResult = {
      input_type: gr["input_type"] ?? "activity_input",
      redacted_input: gr["redacted_input"],
      validation_passed: gr["validation_passed"] !== false,
      reasons: gr["reasons"] ?? [],
      raw_logs: gr["raw_logs"]
    };
  }
  return {
    verdict,
    reason: data["reason"],
    policy_id: data["policy_id"],
    risk_score: data["risk_score"] ?? 0,
    governance_event_id: data["governance_event_id"],
    guardrails_result: guardrailsResult,
    approval_id: data["approval_id"],
    approval_expiration_time: data["approval_expiration_time"],
    trust_tier: data["trust_tier"],
    alignment_score: data["alignment_score"],
    behavioral_violations: data["behavioral_violations"],
    constraints: data["constraints"]
  };
}
function parseApprovalResponse(data) {
  return {
    verdict: verdictFromString(data["verdict"] ?? data["action"]),
    reason: data["reason"],
    approval_expiration_time: data["approval_expiration_time"],
    expired: data["expired"]
  };
}
var DEFAULT_HITL_CONFIG = {
  enabled: true,
  pollIntervalMs: 5e3,
  maxWaitMs: 6e5,
  skipToolTypes: /* @__PURE__ */ new Set()
};

export {
  Verdict,
  verdictFromString,
  verdictPriority,
  highestPriorityVerdict,
  verdictShouldStop,
  verdictRequiresApproval,
  toServerEventType,
  parseGovernanceResponse,
  parseApprovalResponse,
  DEFAULT_HITL_CONFIG
};
