// Human-turn prompt extraction + input redaction.
//
// Redaction contract (differs from the Python in-place mutation on purpose):
// this module BUILDS and RETURNS a redacted human/user message plus its index;
// it does NOT splice. The enforcing middleware is responsible for putting the
// returned message back into the live `request.messages` that reaches the model
// — a discarded copy would leave the raw prompt in the request (the leak).
//
// Core returns ONE coerced `redactedInput` value (a string, or a legacy
// list-wrapped `{prompt|text}` / string), NOT a per-block multimodal structure.
// `coerceRedactedText` normalizes it to a single string (or null → no-op).

import { callMethod, isUnknownArray, readProp } from "./property-access.js";

/** A redacted replacement message and the index it should replace. */
export interface RedactedMessage {
  readonly index: number;
  readonly message: unknown;
}

/** Message roles treated as human-authored for prompt extraction. */
const HUMAN_ROLES = new Set(["human", "user", "generic"]);

function messageRole(message: unknown): string | null {
  const viaGetType = callMethod(message, "getType");
  if (typeof viaGetType === "string") return viaGetType;
  const role = readProp(message, "role") ?? readProp(message, "type");
  return typeof role === "string" ? role : null;
}

function isBaseMessage(message: unknown): boolean {
  return typeof readProp(message, "getType") === "function";
}

/**
 * Extract human/user turn text from a LangChain messages structure. Accepts the
 * `handleChatModelStart` shape (`BaseMessage[][]`), a flat message list, or
 * dict-shaped messages. Joins all human-authored text with newlines. Returns
 * `""` when no human turn is found (callers treat that as "nothing to redact").
 */
export function extractHumanTurnPrompt(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const item of messages) {
    if (Array.isArray(item)) {
      for (const inner of item) appendHumanText(inner, parts);
    } else {
      appendHumanText(item, parts);
    }
  }
  return parts.join("\n");
}

function appendHumanText(message: unknown, parts: string[]): void {
  const role = messageRole(message);
  if (role === null || !HUMAN_ROLES.has(role)) return;
  const content = readProp(message, "content");
  if (typeof content === "string") {
    if (content) parts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (readProp(part, "type") === "text") {
        const text = readProp(part, "text");
        if (typeof text === "string" && text) parts.push(text);
      }
    }
  }
}

/** Normalize a `GuardrailsResult.redactedInput` (typed `unknown`) to plain text, or null. */
export function coerceRedactedText(redactedInput: unknown): string | null {
  if (typeof redactedInput === "string") return redactedInput || null;
  if (isUnknownArray(redactedInput) && redactedInput.length > 0) {
    const first = redactedInput[0];
    if (typeof first === "object" && first !== null) {
      const text = readProp(first, "prompt") ?? readProp(first, "text");
      return typeof text === "string" && text ? text : null;
    }
    if (typeof first === "string") return first || null;
  }
  return null;
}

/**
 * Build a redacted replacement for the LAST human/user turn, or `null` when
 * there is nothing to redact. Walks in reverse; matches human/user/generic for
 * `BaseMessage` instances and user/human for dict-shaped messages (each call
 * site's exact role set preserved). Non-text content blocks pass through
 * untouched; system/AI turns are never touched.
 */
export function buildRedactedUserMessage(
  messages: readonly unknown[],
  redactedInput: unknown
): RedactedMessage | null {
  const redactedText = coerceRedactedText(redactedInput);
  if (redactedText === null) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isRedactableRole(message)) continue;
    const content = redactContent(readProp(message, "content"), redactedText);
    return { index: i, message: rebuildWithContent(message, content) };
  }
  return null;
}

function isRedactableRole(message: unknown): boolean {
  const role = messageRole(message);
  if (role === null) return false;
  return isBaseMessage(message)
    ? role === "human" || role === "user" || role === "generic"
    : role === "user" || role === "human";
}

/** Replace text content with the redacted string; leave non-text blocks untouched. */
function redactContent(content: unknown, redactedText: string): unknown {
  if (typeof content === "string") return redactedText;
  if (isUnknownArray(content)) {
    let placed = false;
    return content.map((block) => {
      if (readProp(block, "type") === "text") {
        const text = placed ? "" : redactedText;
        placed = true;
        return { ...(block as Record<string, unknown>), text };
      }
      return block;
    });
  }
  // Unknown content shape: fail safe by replacing the whole thing.
  return redactedText;
}

/** Rebuild the message immutably, preserving its class + role + metadata. */
function rebuildWithContent(original: unknown, newContent: unknown): unknown {
  const ctor = readProp(original, "constructor");
  if (isBaseMessage(original) && typeof ctor === "function") {
    const fields: Record<string, unknown> = {
      content: newContent,
      additional_kwargs: readProp(original, "additional_kwargs"),
      response_metadata: readProp(original, "response_metadata"),
      id: readProp(original, "id"),
      name: readProp(original, "name")
    };
    const role = readProp(original, "role");
    if (role !== undefined) fields.role = role;
    const Ctor = ctor as unknown as new (fields: Record<string, unknown>) => unknown;
    return new Ctor(fields);
  }
  if (typeof original === "object" && original !== null) {
    return { ...(original as Record<string, unknown>), content: newContent };
  }
  return { content: newContent };
}
