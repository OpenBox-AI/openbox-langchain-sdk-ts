// Pure message extraction for the middleware hooks. Operates on raw LangChain
// message shapes (typed classes or dicts). Role sets are preserved per call
// site, matching the Python originals exactly (do not unify them).

import { callMethod, isUnknownArray, readProp } from "../property-access.js";

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
 * Last human/user message text, or null. Role set matches the Python original:
 * `user`/`human` for dict-shaped messages, `human`/`generic` for `BaseMessage`
 * instances. Non-string content yields null (the turn is present but not text).
 */
export function extractLastUserMessage(messages: unknown): string | null {
  if (!isUnknownArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const role = messageRole(message);
    if (role === null) continue;
    const matches = isBaseMessage(message)
      ? role === "human" || role === "generic"
      : role === "user" || role === "human";
    if (!matches) continue;
    const content = readProp(message, "content");
    return typeof content === "string" ? content : null;
  }
  return null;
}

/**
 * True if the message list contains any human/user/generic turn. Used to decide
 * whether to govern a turn even when its text is empty or multimodal (so an
 * empty/multimodal human turn is NOT silently ungoverned).
 */
export function hasHumanTurn(messages: unknown): boolean {
  if (!isUnknownArray(messages)) return false;
  return messages.some((message) => {
    const role = messageRole(message);
    return role === "human" || role === "user" || role === "generic";
  });
}

/**
 * True when there is no prior assistant turn — i.e. this is the first model call
 * of the invocation. Derived from `messages` (stateless), never a mutable flag.
 */
export function isFirstLlmCall(messages: unknown): boolean {
  if (!isUnknownArray(messages)) return true;
  for (const message of messages) {
    const role = messageRole(message);
    if (role === "ai" || role === "assistant") return false;
  }
  return true;
}
