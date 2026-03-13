/**
 * OpenBox LangChain SDK — Guardrails Redaction
 *
 * Applies input/output redaction from guardrails_result to the
 * data that flows into/out of tool and LLM executions.
 */

import { GuardrailsResult } from "./types.js";

/**
 * Apply input guardrails redaction to a tool input string or object.
 * Returns the (possibly redacted) value to use for execution.
 */
export function applyInputRedaction(
  originalInput: unknown,
  guardrails: GuardrailsResult | undefined
): unknown {
  if (!guardrails) return originalInput;
  if (guardrails.input_type !== "activity_input") return originalInput;
  if (guardrails.redacted_input === undefined || guardrails.redacted_input === null) {
    return originalInput;
  }

  const redacted = guardrails.redacted_input;

  // If original is a string and redacted is a string → replace directly
  if (typeof originalInput === "string" && typeof redacted === "string") {
    return redacted;
  }

  // If original is an object and redacted is an object → deep merge
  if (
    originalInput !== null &&
    typeof originalInput === "object" &&
    !Array.isArray(originalInput) &&
    redacted !== null &&
    typeof redacted === "object" &&
    !Array.isArray(redacted)
  ) {
    return deepMerge(
      originalInput as Record<string, unknown>,
      redacted as Record<string, unknown>
    );
  }

  // If redacted is wrapped in an array (mirrors Temporal activity_input list)
  if (Array.isArray(redacted) && redacted.length === 1) {
    return applyInputRedaction(originalInput, {
      ...guardrails,
      redacted_input: redacted[0],
    });
  }

  // Fallback: replace directly
  return redacted;
}

/**
 * Apply output guardrails redaction to tool output or LLM completion.
 * Returns the (possibly redacted) output.
 */
export function applyOutputRedaction(
  originalOutput: unknown,
  guardrails: GuardrailsResult | undefined
): unknown {
  if (!guardrails) return originalOutput;
  if (guardrails.input_type !== "activity_output") return originalOutput;
  if (guardrails.redacted_input === undefined || guardrails.redacted_input === null) {
    return originalOutput;
  }

  const redacted = guardrails.redacted_input;

  // String output → replace directly
  if (typeof originalOutput === "string" && typeof redacted === "string") {
    return redacted;
  }

  // Object output → deep merge
  if (
    originalOutput !== null &&
    typeof originalOutput === "object" &&
    !Array.isArray(originalOutput) &&
    redacted !== null &&
    typeof redacted === "object" &&
    !Array.isArray(redacted)
  ) {
    return deepMerge(
      originalOutput as Record<string, unknown>,
      redacted as Record<string, unknown>
    );
  }

  return redacted;
}

/**
 * Extract guardrails reason strings for error messages.
 */
export function getGuardrailsReasons(guardrails: GuardrailsResult): string[] {
  return (guardrails.reasons ?? [])
    .map((r) => r.reason)
    .filter(Boolean);
}

/**
 * Shallow-merge redacted fields into original object.
 * Only top-level keys present in redacted are overwritten.
 */
function deepMerge(
  original: Record<string, unknown>,
  redacted: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...original };
  for (const key of Object.keys(redacted)) {
    const redactedVal = redacted[key];
    const originalVal = original[key];

    if (
      redactedVal !== null &&
      typeof redactedVal === "object" &&
      !Array.isArray(redactedVal) &&
      originalVal !== null &&
      typeof originalVal === "object" &&
      !Array.isArray(originalVal)
    ) {
      result[key] = deepMerge(
        originalVal as Record<string, unknown>,
        redactedVal as Record<string, unknown>
      );
    } else {
      result[key] = redactedVal;
    }
  }
  return result;
}
