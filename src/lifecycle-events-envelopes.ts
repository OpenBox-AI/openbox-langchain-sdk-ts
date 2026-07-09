// Activity-input enrichment and model-response metadata extraction.

import { asFiniteNumber, readProp } from "./property-access.js";
import type { JsonValue } from "@openbox-ai/openbox-sdk";

/**
 * Append an `__openbox` metadata sentinel to the END of an activity-input list
 * so governance policies can classify tools/subagents without a Core change.
 *
 * Appended ONLY when `toolType` or `subagentName` is set — unclassified tools
 * get no sentinel. NOT sanitized: forging this sentinel via a malicious tool
 * payload is a documented non-goal; callers append it after building the input
 * from trusted fields.
 */
export function enrichActivityInput(
  baseInput: readonly JsonValue[] | null | undefined,
  meta: { toolType?: string | null; subagentName?: string | null }
): JsonValue[] | null {
  const toolType = meta.toolType ?? null;
  const subagentName = meta.subagentName ?? null;
  if (toolType === null && subagentName === null) {
    return baseInput ? [...baseInput] : null;
  }
  const sentinel: Record<string, JsonValue> = {};
  if (toolType !== null) sentinel.tool_type = toolType;
  if (subagentName !== null) sentinel.subagent_name = subagentName;
  const result: JsonValue[] = baseInput ? [...baseInput] : [];
  result.push({ __openbox: sentinel });
  return result;
}

// ── model-response metadata ────────────────────────────────────────────────

/**
 * Extract `{ llm_model, input_tokens, output_tokens, total_tokens, completion,
 * has_tool_calls }` from a model response (an `AIMessage` or a generation
 * wrapper carrying `.message`). Snake_case keys — this feeds the wire `result`
 * field. Missing fields are `null`.
 */
export function extractResponseMetadata(response: unknown): Record<string, JsonValue> {
  const message = readProp(response, "message") ?? response;
  const result: Record<string, JsonValue> = {};

  const responseMetadata = readProp(message, "response_metadata");
  if (typeof responseMetadata === "object" && responseMetadata !== null) {
    const meta = responseMetadata as Record<string, unknown>;
    const model = meta.model_name ?? meta.model;
    result.llm_model = typeof model === "string" ? model : null;
  }

  const usage = readProp(message, "usage_metadata");
  if (typeof usage === "object" && usage !== null) {
    const u = usage as Record<string, unknown>;
    const input = asFiniteNumber(u.input_tokens) ?? asFiniteNumber(u.prompt_tokens);
    const output = asFiniteNumber(u.output_tokens) ?? asFiniteNumber(u.completion_tokens);
    result.input_tokens = input;
    result.output_tokens = output;
    result.total_tokens = input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null;
  }

  const content = readProp(message, "content");
  if (typeof content === "string") {
    result.completion = content;
  } else if (Array.isArray(content)) {
    const texts = content
      .map((part) => (readProp(part, "type") === "text" ? readProp(part, "text") : undefined))
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    result.completion = texts.length > 0 ? texts.join(" ") : null;
  }

  const toolCalls = readProp(message, "tool_calls");
  result.has_tool_calls = Array.isArray(toolCalls) && toolCalls.length > 0;

  return result;
}
