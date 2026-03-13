/**
 * OpenBox LangChain SDK — Safe JSON Serialization
 *
 * LangChain objects (AIMessage, HumanMessage, Document, ChatGeneration, etc.)
 * can contain non-serializable types, circular refs, or large binary data.
 * This module provides safe serialization for governance payloads.
 */

const MAX_STRING_LENGTH = 10_000;
const MAX_DEPTH = 8;

/**
 * Safely serialize any value to a JSON-compatible type.
 * Handles LangChain message objects, Documents, nested structures, circular refs.
 */
export function safeSerialize(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[max depth exceeded]";
  if (value === null || value === undefined) return value;

  const type = typeof value;

  if (type === "string") {
    const s = value as string;
    return s.length > MAX_STRING_LENGTH
      ? s.slice(0, MAX_STRING_LENGTH) + "...[truncated]"
      : s;
  }

  if (type === "number" || type === "boolean") return value;

  if (type === "bigint") return (value as bigint).toString();

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Uint8Array || Buffer && value instanceof Buffer) {
    try {
      return Buffer.from(value as Uint8Array).toString("utf8");
    } catch {
      return "[binary data]";
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => safeSerialize(item, depth + 1));
  }

  if (type === "object") {
    const obj = value as Record<string, unknown>;

    // LangChain AIMessage / HumanMessage / SystemMessage / BaseMessage
    if ("lc_id" in obj || "lc_kwargs" in obj) {
      return serializeLangChainMessage(obj, depth);
    }

    // LangChain Document
    if ("pageContent" in obj && "metadata" in obj) {
      return {
        pageContent: safeSerialize(obj["pageContent"], depth + 1),
        metadata: safeSerialize(obj["metadata"], depth + 1),
      };
    }

    // LangChain ChatGeneration / Generation
    if ("text" in obj && "generationInfo" in obj) {
      return {
        text: safeSerialize(obj["text"], depth + 1),
        generationInfo: safeSerialize(obj["generationInfo"], depth + 1),
      };
    }

    // LangChain LLMResult
    if ("generations" in obj && "llmOutput" in obj) {
      return {
        generations: safeSerialize(obj["generations"], depth + 1),
        llmOutput: safeSerialize(obj["llmOutput"], depth + 1),
      };
    }

    // Plain object — serialize all enumerable own properties
    try {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) {
        try {
          result[key] = safeSerialize(obj[key], depth + 1);
        } catch {
          result[key] = "[unserializable]";
        }
      }
      return result;
    } catch {
      return "[unserializable object]";
    }
  }

  // Functions, symbols, etc.
  return `[${type}]`;
}

function serializeLangChainMessage(
  obj: Record<string, unknown>,
  depth: number
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Extract the most useful fields
  if ("content" in obj) result["content"] = safeSerialize(obj["content"], depth + 1);
  if ("role" in obj) result["role"] = obj["role"];
  if ("name" in obj && obj["name"]) result["name"] = obj["name"];
  if ("tool_calls" in obj && obj["tool_calls"]) {
    result["tool_calls"] = safeSerialize(obj["tool_calls"], depth + 1);
  }
  if ("additional_kwargs" in obj && obj["additional_kwargs"]) {
    result["additional_kwargs"] = safeSerialize(obj["additional_kwargs"], depth + 1);
  }

  // Include _getType() result if available
  if (typeof (obj as { _getType?: () => string })["_getType"] === "function") {
    try {
      result["type"] = (obj as { _getType: () => string })["_getType"]();
    } catch {
      // ignore
    }
  }

  return result;
}

/**
 * Extract plain text content from a LangChain prompt or message array.
 * Used for sending prompts to governance.
 */
export function extractPromptText(prompts: unknown): string {
  if (!prompts) return "";

  if (typeof prompts === "string") return truncate(prompts);

  if (Array.isArray(prompts)) {
    // prompts is string[][] (for LLM) or BaseMessage[][] (for ChatModel)
    const flat = prompts.flat();
    return flat
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          if (typeof obj["content"] === "string") return obj["content"];
          if (typeof obj["text"] === "string") return obj["text"];
        }
        return String(item);
      })
      .join("\n")
      .slice(0, MAX_STRING_LENGTH);
  }

  return truncate(String(prompts));
}

/**
 * Extract completion text from an LLMResult.
 */
export function extractCompletionText(output: unknown): string {
  if (!output || typeof output !== "object") return "";
  const result = output as Record<string, unknown>;

  const generations = result["generations"];
  if (!Array.isArray(generations)) return "";

  const texts: string[] = [];
  for (const gen of generations.flat()) {
    if (!gen || typeof gen !== "object") continue;
    const g = gen as Record<string, unknown>;
    if (typeof g["text"] === "string") texts.push(g["text"]);
    else if (
      g["message"] &&
      typeof g["message"] === "object" &&
      typeof (g["message"] as Record<string, unknown>)["content"] === "string"
    ) {
      texts.push((g["message"] as Record<string, unknown>)["content"] as string);
    }
  }

  return truncate(texts.join("\n"));
}

/**
 * Extract token usage from LLMResult.llmOutput.
 */
export function extractTokenUsage(
  output: unknown
): { inputTokens?: number; outputTokens?: number; totalTokens?: number } {
  if (!output || typeof output !== "object") return {};
  const result = output as Record<string, unknown>;

  const llmOutput = result["llmOutput"] as Record<string, unknown> | undefined;
  if (!llmOutput) return {};

  const usage = (llmOutput["tokenUsage"] ??
    llmOutput["usage"] ??
    llmOutput["token_usage"]) as Record<string, unknown> | undefined;

  if (!usage) return {};

  return {
    inputTokens: asNumber(
      usage["promptTokens"] ?? usage["input_tokens"] ?? usage["prompt_tokens"]
    ),
    outputTokens: asNumber(
      usage["completionTokens"] ??
        usage["output_tokens"] ??
        usage["completion_tokens"]
    ),
    totalTokens: asNumber(usage["totalTokens"] ?? usage["total_tokens"]),
  };
}

/**
 * Extract model name from LLM serialized info.
 */
export function extractModelName(llm: unknown): string | undefined {
  if (!llm || typeof llm !== "object") return undefined;
  const obj = llm as Record<string, unknown>;

  // Direct model_name field
  if (typeof obj["model_name"] === "string") return obj["model_name"];
  if (typeof obj["model"] === "string") return obj["model"];
  if (typeof obj["modelName"] === "string") return obj["modelName"];

  // Nested in kwargs
  const kwargs = obj["kwargs"] as Record<string, unknown> | undefined;
  if (kwargs) {
    if (typeof kwargs["model_name"] === "string") return kwargs["model_name"];
    if (typeof kwargs["model"] === "string") return kwargs["model"];
  }

  return undefined;
}

/**
 * Extract finish reason from LLMResult.
 */
export function extractFinishReason(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const result = output as Record<string, unknown>;
  const generations = result["generations"];
  if (!Array.isArray(generations) || generations.length === 0) return undefined;
  const first = generations.flat()[0] as Record<string, unknown> | undefined;
  if (!first) return undefined;
  return (
    (first["generationInfo"] as Record<string, unknown> | undefined)?.[
      "finish_reason"
    ] as string | undefined
  );
}

function truncate(s: string): string {
  return s.length > MAX_STRING_LENGTH
    ? s.slice(0, MAX_STRING_LENGTH) + "...[truncated]"
    : s;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}

/**
 * Current UTC time in RFC3339 format.
 */
export function rfc3339Now(): string {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
}
