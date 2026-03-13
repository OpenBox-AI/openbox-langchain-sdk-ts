import { describe, it, expect } from "vitest";
import {
  Verdict,
  verdictFromString,
  verdictPriority,
  highestPriorityVerdict,
  verdictShouldStop,
  verdictRequiresApproval,
  parseGovernanceResponse,
  parseApprovalResponse,
} from "../src/types.js";

describe("verdictFromString", () => {
  it("parses v1.1 strings", () => {
    expect(verdictFromString("allow")).toBe(Verdict.ALLOW);
    expect(verdictFromString("constrain")).toBe(Verdict.CONSTRAIN);
    expect(verdictFromString("require_approval")).toBe(Verdict.REQUIRE_APPROVAL);
    expect(verdictFromString("block")).toBe(Verdict.BLOCK);
    expect(verdictFromString("halt")).toBe(Verdict.HALT);
  });

  it("parses v1.0 legacy strings", () => {
    expect(verdictFromString("continue")).toBe(Verdict.ALLOW);
    expect(verdictFromString("stop")).toBe(Verdict.HALT);
    expect(verdictFromString("require-approval")).toBe(Verdict.REQUIRE_APPROVAL);
  });

  it("defaults to ALLOW for unknown or null values", () => {
    expect(verdictFromString(null)).toBe(Verdict.ALLOW);
    expect(verdictFromString(undefined)).toBe(Verdict.ALLOW);
    expect(verdictFromString("nonsense")).toBe(Verdict.ALLOW);
    expect(verdictFromString("")).toBe(Verdict.ALLOW);
  });

  it("is case-insensitive", () => {
    expect(verdictFromString("BLOCK")).toBe(Verdict.BLOCK);
    expect(verdictFromString("HALT")).toBe(Verdict.HALT);
    expect(verdictFromString("Allow")).toBe(Verdict.ALLOW);
  });
});

describe("verdictPriority", () => {
  it("has correct priority order", () => {
    expect(verdictPriority(Verdict.ALLOW)).toBeLessThan(verdictPriority(Verdict.CONSTRAIN));
    expect(verdictPriority(Verdict.CONSTRAIN)).toBeLessThan(verdictPriority(Verdict.REQUIRE_APPROVAL));
    expect(verdictPriority(Verdict.REQUIRE_APPROVAL)).toBeLessThan(verdictPriority(Verdict.BLOCK));
    expect(verdictPriority(Verdict.BLOCK)).toBeLessThan(verdictPriority(Verdict.HALT));
  });
});

describe("highestPriorityVerdict", () => {
  it("returns HALT when present", () => {
    expect(highestPriorityVerdict([Verdict.ALLOW, Verdict.HALT, Verdict.BLOCK])).toBe(Verdict.HALT);
  });

  it("returns BLOCK when no HALT", () => {
    expect(highestPriorityVerdict([Verdict.ALLOW, Verdict.BLOCK, Verdict.CONSTRAIN])).toBe(Verdict.BLOCK);
  });

  it("returns ALLOW for empty list", () => {
    expect(highestPriorityVerdict([])).toBe(Verdict.ALLOW);
  });

  it("returns the single verdict when only one", () => {
    expect(highestPriorityVerdict([Verdict.REQUIRE_APPROVAL])).toBe(Verdict.REQUIRE_APPROVAL);
  });
});

describe("verdictShouldStop", () => {
  it("returns true for BLOCK and HALT", () => {
    expect(verdictShouldStop(Verdict.BLOCK)).toBe(true);
    expect(verdictShouldStop(Verdict.HALT)).toBe(true);
  });

  it("returns false for others", () => {
    expect(verdictShouldStop(Verdict.ALLOW)).toBe(false);
    expect(verdictShouldStop(Verdict.CONSTRAIN)).toBe(false);
    expect(verdictShouldStop(Verdict.REQUIRE_APPROVAL)).toBe(false);
  });
});

describe("verdictRequiresApproval", () => {
  it("returns true only for REQUIRE_APPROVAL", () => {
    expect(verdictRequiresApproval(Verdict.REQUIRE_APPROVAL)).toBe(true);
    expect(verdictRequiresApproval(Verdict.ALLOW)).toBe(false);
    expect(verdictRequiresApproval(Verdict.BLOCK)).toBe(false);
  });
});

describe("parseGovernanceResponse", () => {
  it("parses a full response", () => {
    const data = {
      verdict: "block",
      reason: "Policy violation",
      policy_id: "pol-123",
      risk_score: 0.9,
      governance_event_id: "evt-456",
    };
    const result = parseGovernanceResponse(data);
    expect(result.verdict).toBe(Verdict.BLOCK);
    expect(result.reason).toBe("Policy violation");
    expect(result.policy_id).toBe("pol-123");
    expect(result.risk_score).toBe(0.9);
  });

  it("parses guardrails_result", () => {
    const data = {
      verdict: "allow",
      guardrails_result: {
        input_type: "activity_input",
        redacted_input: { prompt: "[REDACTED]" },
        validation_passed: true,
        reasons: [],
      },
    };
    const result = parseGovernanceResponse(data);
    expect(result.guardrails_result).toBeDefined();
    expect(result.guardrails_result!.input_type).toBe("activity_input");
    expect(result.guardrails_result!.validation_passed).toBe(true);
  });

  it("handles legacy action field", () => {
    const data = { action: "continue" };
    const result = parseGovernanceResponse(data);
    expect(result.verdict).toBe(Verdict.ALLOW);
  });

  it("defaults to ALLOW for missing verdict", () => {
    const result = parseGovernanceResponse({});
    expect(result.verdict).toBe(Verdict.ALLOW);
  });
});

describe("parseApprovalResponse", () => {
  it("parses approval response with verdict", () => {
    const data = { verdict: "allow", reason: "Approved" };
    const result = parseApprovalResponse(data);
    expect(result.verdict).toBe(Verdict.ALLOW);
    expect(result.reason).toBe("Approved");
  });

  it("parses expired flag", () => {
    const data = { verdict: "require_approval", expired: true };
    const result = parseApprovalResponse(data);
    expect(result.expired).toBe(true);
  });
});
