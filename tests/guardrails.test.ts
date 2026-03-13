import { describe, it, expect } from "vitest";
import {
  applyInputRedaction,
  applyOutputRedaction,
  getGuardrailsReasons,
} from "../src/guardrails.js";
import { GuardrailsResult } from "../src/types.js";

function makeGuardrails(
  overrides: Partial<GuardrailsResult> = {}
): GuardrailsResult {
  return {
    input_type: "activity_input",
    redacted_input: null,
    validation_passed: true,
    ...overrides,
  };
}

describe("applyInputRedaction", () => {
  it("returns original when no guardrails", () => {
    expect(applyInputRedaction("hello", undefined)).toBe("hello");
  });

  it("returns original when input_type is activity_output", () => {
    const gr = makeGuardrails({ input_type: "activity_output", redacted_input: "REDACTED" });
    expect(applyInputRedaction("original", gr)).toBe("original");
  });

  it("returns original when redacted_input is null", () => {
    const gr = makeGuardrails({ redacted_input: null });
    expect(applyInputRedaction("original", gr)).toBe("original");
  });

  it("replaces string input with redacted string", () => {
    const gr = makeGuardrails({ redacted_input: "[REDACTED]" });
    expect(applyInputRedaction("my secret", gr)).toBe("[REDACTED]");
  });

  it("deep merges object input with redacted object", () => {
    const original = { prompt: "tell me secrets", user_id: "u-123", extra: "keep" };
    const gr = makeGuardrails({
      redacted_input: { prompt: "[REDACTED]", user_id: "u-123" },
    });
    const result = applyInputRedaction(original, gr) as Record<string, unknown>;
    expect(result["prompt"]).toBe("[REDACTED]");
    expect(result["user_id"]).toBe("u-123");
    expect(result["extra"]).toBe("keep"); // not in redacted → preserved
  });

  it("handles nested object redaction", () => {
    const original = { config: { model: "gpt-4", temperature: 0.7 }, prompt: "hi" };
    const gr = makeGuardrails({
      redacted_input: { config: { model: "[REDACTED]" } },
    });
    const result = applyInputRedaction(original, gr) as Record<string, unknown>;
    const config = result["config"] as Record<string, unknown>;
    expect(config["model"]).toBe("[REDACTED]");
    expect(config["temperature"]).toBe(0.7); // preserved
  });

  it("unwraps single-element array redacted_input", () => {
    const gr = makeGuardrails({ redacted_input: ["[REDACTED EMAIL]"] });
    const result = applyInputRedaction("user@example.com", gr);
    expect(result).toBe("[REDACTED EMAIL]");
  });
});

describe("applyOutputRedaction", () => {
  it("returns original when no guardrails", () => {
    expect(applyOutputRedaction("output", undefined)).toBe("output");
  });

  it("returns original when input_type is activity_input", () => {
    const gr = makeGuardrails({ input_type: "activity_input", redacted_input: "X" });
    expect(applyOutputRedaction("output", gr)).toBe("output");
  });

  it("replaces string output with redacted string", () => {
    const gr = makeGuardrails({
      input_type: "activity_output",
      redacted_input: "[OUTPUT REDACTED]",
    });
    expect(applyOutputRedaction("sensitive result", gr)).toBe("[OUTPUT REDACTED]");
  });

  it("deep merges object output", () => {
    const original = { result: "confidential data", status: "ok" };
    const gr = makeGuardrails({
      input_type: "activity_output",
      redacted_input: { result: "[REDACTED]" },
    });
    const result = applyOutputRedaction(original, gr) as Record<string, unknown>;
    expect(result["result"]).toBe("[REDACTED]");
    expect(result["status"]).toBe("ok");
  });
});

describe("getGuardrailsReasons", () => {
  it("returns reason strings", () => {
    const gr = makeGuardrails({
      reasons: [
        { type: "pii", field: "email", reason: "Email address detected" },
        { type: "profanity", field: "text", reason: "Profanity detected" },
      ],
    });
    const reasons = getGuardrailsReasons(gr);
    expect(reasons).toEqual(["Email address detected", "Profanity detected"]);
  });

  it("returns empty array when no reasons", () => {
    const gr = makeGuardrails({ reasons: [] });
    expect(getGuardrailsReasons(gr)).toEqual([]);
  });

  it("returns empty array when reasons undefined", () => {
    const gr = makeGuardrails({ reasons: undefined });
    expect(getGuardrailsReasons(gr)).toEqual([]);
  });
});
