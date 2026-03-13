import { describe, it, expect, vi } from "vitest";
import {
  enforceVerdict,
  eventTypeToContext,
  isHITLApplicable,
} from "../src/verdict-handler.js";
import {
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
} from "../src/errors.js";
import { GovernanceVerdictResponse, Verdict } from "../src/types.js";

function makeResponse(overrides: Partial<GovernanceVerdictResponse> = {}): GovernanceVerdictResponse {
  return {
    verdict: Verdict.ALLOW,
    ...overrides,
  };
}

describe("eventTypeToContext", () => {
  it("maps event types correctly", () => {
    expect(eventTypeToContext("ChainStarted")).toBe("chain_start");
    expect(eventTypeToContext("ChainCompleted")).toBe("chain_end");
    expect(eventTypeToContext("ToolStarted")).toBe("tool_start");
    expect(eventTypeToContext("ToolCompleted")).toBe("tool_end");
    expect(eventTypeToContext("LLMStarted")).toBe("llm_start");
    expect(eventTypeToContext("LLMCompleted")).toBe("llm_end");
    expect(eventTypeToContext("AgentAction")).toBe("agent_action");
    expect(eventTypeToContext("AgentFinish")).toBe("agent_finish");
    expect(eventTypeToContext("RetrieverStarted")).toBe("other");
  });
});

describe("isHITLApplicable", () => {
  it("returns true only for tool_start and llm_start", () => {
    expect(isHITLApplicable("tool_start")).toBe(true);
    expect(isHITLApplicable("llm_start")).toBe(true);
    expect(isHITLApplicable("chain_start")).toBe(false);
    expect(isHITLApplicable("tool_end")).toBe(false);
    expect(isHITLApplicable("chain_end")).toBe(false);
    expect(isHITLApplicable("other")).toBe(false);
  });
});

describe("enforceVerdict", () => {
  describe("ALLOW", () => {
    it("returns no-op result", () => {
      const result = enforceVerdict(makeResponse({ verdict: Verdict.ALLOW }), "tool_start");
      expect(result.requiresHITL).toBe(false);
      expect(result.blocked).toBe(false);
    });
  });

  describe("CONSTRAIN", () => {
    it("logs a warning and returns no-op", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = enforceVerdict(
        makeResponse({ verdict: Verdict.CONSTRAIN, reason: "constrained" }),
        "tool_start"
      );
      expect(result.requiresHITL).toBe(false);
      expect(result.blocked).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("constrained"));
      warnSpy.mockRestore();
    });

    it("does not log if no reason", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      enforceVerdict(makeResponse({ verdict: Verdict.CONSTRAIN }), "tool_start");
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("BLOCK", () => {
    it("throws GovernanceBlockedError", () => {
      expect(() =>
        enforceVerdict(
          makeResponse({ verdict: Verdict.BLOCK, reason: "blocked", policy_id: "pol-1" }),
          "tool_start"
        )
      ).toThrow(GovernanceBlockedError);
    });

    it("throws with reason in message", () => {
      expect(() =>
        enforceVerdict(makeResponse({ verdict: Verdict.BLOCK, reason: "too risky" }), "chain_start")
      ).toThrow("too risky");
    });

    it("no-op on end contexts (observability-only)", () => {
      expect(() =>
        enforceVerdict(makeResponse({ verdict: Verdict.BLOCK }), "tool_end")
      ).not.toThrow();
      expect(() =>
        enforceVerdict(makeResponse({ verdict: Verdict.BLOCK }), "chain_end")
      ).not.toThrow();
      expect(() =>
        enforceVerdict(makeResponse({ verdict: Verdict.BLOCK }), "llm_end")
      ).not.toThrow();
    });
  });

  describe("HALT", () => {
    it("throws GovernanceHaltError", () => {
      expect(() =>
        enforceVerdict(makeResponse({ verdict: Verdict.HALT, reason: "halt!" }), "tool_start")
      ).toThrow(GovernanceHaltError);
    });

    it("no-op on end contexts (observability-only)", () => {
      expect(() =>
        enforceVerdict(makeResponse({ verdict: Verdict.HALT }), "chain_end")
      ).not.toThrow();
    });
  });

  describe("REQUIRE_APPROVAL", () => {
    it("returns requiresHITL=true for tool_start", () => {
      const result = enforceVerdict(
        makeResponse({ verdict: Verdict.REQUIRE_APPROVAL }),
        "tool_start"
      );
      expect(result.requiresHITL).toBe(true);
    });

    it("returns requiresHITL=true for llm_start", () => {
      const result = enforceVerdict(
        makeResponse({ verdict: Verdict.REQUIRE_APPROVAL }),
        "llm_start"
      );
      expect(result.requiresHITL).toBe(true);
    });

    it("throws GovernanceBlockedError for chain_start (no HITL at chain level)", () => {
      expect(() =>
        enforceVerdict(makeResponse({ verdict: Verdict.REQUIRE_APPROVAL }), "chain_start")
      ).toThrow(GovernanceBlockedError);
    });

    it("no-op on tool_end (end events are observability-only)", () => {
      const result = enforceVerdict(
        makeResponse({ verdict: Verdict.REQUIRE_APPROVAL }),
        "tool_end"
      );
      expect(result.requiresHITL).toBe(false);
      expect(result.blocked).toBe(false);
    });
  });

  describe("Guardrails validation failure", () => {
    it("throws GuardrailsValidationError regardless of verdict", () => {
      const response = makeResponse({
        verdict: Verdict.ALLOW,
        guardrails_result: {
          input_type: "activity_input",
          redacted_input: null,
          validation_passed: false,
          reasons: [{ type: "pii", field: "email", reason: "Contains PII" }],
        },
      });
      expect(() => enforceVerdict(response, "tool_start")).toThrow(GuardrailsValidationError);
    });

    it("includes reason text in error", () => {
      const response = makeResponse({
        verdict: Verdict.ALLOW,
        guardrails_result: {
          input_type: "activity_input",
          redacted_input: null,
          validation_passed: false,
          reasons: [{ type: "pii", field: "phone", reason: "Phone number detected" }],
        },
      });
      expect(() => enforceVerdict(response, "llm_start")).toThrow("Phone number detected");
    });

    it("does not throw for validation_passed=true", () => {
      const response = makeResponse({
        verdict: Verdict.ALLOW,
        guardrails_result: {
          input_type: "activity_input",
          redacted_input: { prompt: "[REDACTED]" },
          validation_passed: true,
        },
      });
      expect(() => enforceVerdict(response, "tool_start")).not.toThrow();
    });
  });
});
