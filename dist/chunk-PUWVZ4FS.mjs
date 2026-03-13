import {
  GovernanceBlockedError,
  GovernanceHaltError
} from "./chunk-AF6ADJEG.mjs";

// src/serializer.ts
var MAX_STRING_LENGTH = 1e4;
var MAX_DEPTH = 8;
function safeSerialize(value, depth = 0) {
  if (depth > MAX_DEPTH) return "[max depth exceeded]";
  if (value === null || value === void 0) return value;
  const type = typeof value;
  if (type === "string") {
    const s = value;
    return s.length > MAX_STRING_LENGTH ? s.slice(0, MAX_STRING_LENGTH) + "...[truncated]" : s;
  }
  if (type === "number" || type === "boolean") return value;
  if (type === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array || Buffer && value instanceof Buffer) {
    try {
      return Buffer.from(value).toString("utf8");
    } catch {
      return "[binary data]";
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => safeSerialize(item, depth + 1));
  }
  if (type === "object") {
    const obj = value;
    if ("lc_id" in obj || "lc_kwargs" in obj) {
      return serializeLangChainMessage(obj, depth);
    }
    if ("pageContent" in obj && "metadata" in obj) {
      return {
        pageContent: safeSerialize(obj["pageContent"], depth + 1),
        metadata: safeSerialize(obj["metadata"], depth + 1)
      };
    }
    if ("text" in obj && "generationInfo" in obj) {
      return {
        text: safeSerialize(obj["text"], depth + 1),
        generationInfo: safeSerialize(obj["generationInfo"], depth + 1)
      };
    }
    if ("generations" in obj && "llmOutput" in obj) {
      return {
        generations: safeSerialize(obj["generations"], depth + 1),
        llmOutput: safeSerialize(obj["llmOutput"], depth + 1)
      };
    }
    try {
      const result = {};
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
  return `[${type}]`;
}
function serializeLangChainMessage(obj, depth) {
  const result = {};
  if ("content" in obj) result["content"] = safeSerialize(obj["content"], depth + 1);
  if ("role" in obj) result["role"] = obj["role"];
  if ("name" in obj && obj["name"]) result["name"] = obj["name"];
  if ("tool_calls" in obj && obj["tool_calls"]) {
    result["tool_calls"] = safeSerialize(obj["tool_calls"], depth + 1);
  }
  if ("additional_kwargs" in obj && obj["additional_kwargs"]) {
    result["additional_kwargs"] = safeSerialize(obj["additional_kwargs"], depth + 1);
  }
  if (typeof obj["_getType"] === "function") {
    try {
      result["type"] = obj["_getType"]();
    } catch {
    }
  }
  return result;
}
function extractPromptText(prompts) {
  if (!prompts) return "";
  if (typeof prompts === "string") return truncate(prompts);
  if (Array.isArray(prompts)) {
    const flat = prompts.flat();
    return flat.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const obj = item;
        if (typeof obj["content"] === "string") return obj["content"];
        if (typeof obj["text"] === "string") return obj["text"];
      }
      return String(item);
    }).join("\n").slice(0, MAX_STRING_LENGTH);
  }
  return truncate(String(prompts));
}
function extractCompletionText(output) {
  if (!output || typeof output !== "object") return "";
  const result = output;
  const generations = result["generations"];
  if (!Array.isArray(generations)) return "";
  const texts = [];
  for (const gen of generations.flat()) {
    if (!gen || typeof gen !== "object") continue;
    const g = gen;
    if (typeof g["text"] === "string") texts.push(g["text"]);
    else if (g["message"] && typeof g["message"] === "object" && typeof g["message"]["content"] === "string") {
      texts.push(g["message"]["content"]);
    }
  }
  return truncate(texts.join("\n"));
}
function extractTokenUsage(output) {
  if (!output || typeof output !== "object") return {};
  const result = output;
  const llmOutput = result["llmOutput"];
  if (!llmOutput) return {};
  const usage = llmOutput["tokenUsage"] ?? llmOutput["usage"] ?? llmOutput["token_usage"];
  if (!usage) return {};
  return {
    inputTokens: asNumber(
      usage["promptTokens"] ?? usage["input_tokens"] ?? usage["prompt_tokens"]
    ),
    outputTokens: asNumber(
      usage["completionTokens"] ?? usage["output_tokens"] ?? usage["completion_tokens"]
    ),
    totalTokens: asNumber(usage["totalTokens"] ?? usage["total_tokens"])
  };
}
function extractModelName(llm) {
  if (!llm || typeof llm !== "object") return void 0;
  const obj = llm;
  if (typeof obj["model_name"] === "string") return obj["model_name"];
  if (typeof obj["model"] === "string") return obj["model"];
  if (typeof obj["modelName"] === "string") return obj["modelName"];
  const kwargs = obj["kwargs"];
  if (kwargs) {
    if (typeof kwargs["model_name"] === "string") return kwargs["model_name"];
    if (typeof kwargs["model"] === "string") return kwargs["model"];
  }
  return void 0;
}
function extractFinishReason(output) {
  if (!output || typeof output !== "object") return void 0;
  const result = output;
  const generations = result["generations"];
  if (!Array.isArray(generations) || generations.length === 0) return void 0;
  const first = generations.flat()[0];
  if (!first) return void 0;
  return first["generationInfo"]?.["finish_reason"];
}
function truncate(s) {
  return s.length > MAX_STRING_LENGTH ? s.slice(0, MAX_STRING_LENGTH) + "...[truncated]" : s;
}
function asNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return isNaN(n) ? void 0 : n;
  }
  return void 0;
}
function rfc3339Now() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
}

// src/hook-governance.ts
var _config = null;
function configureHookGovernance(options) {
  _config = options;
}
function isHookGovernanceConfigured() {
  return _config !== null;
}
function resetHookGovernance() {
  _config = null;
}
function buildHookPayload(span, stage, runId) {
  if (!_config) return null;
  const { buffer } = _config;
  const buf = buffer.getBuffer(runId);
  if (!buf) return null;
  const rootRunId = buffer.getRootRunId(runId);
  const hookTrigger = {
    type: "http_request",
    stage,
    "http.method": span.attributes["http.method"] ?? "GET",
    "http.url": span.attributes["http.url"] ?? "",
    attribute_key_identifiers: ["http.method", "http.url"],
    request_headers: span.request_headers,
    request_body: span.request_body,
    ...stage === "completed" ? {
      response_headers: span.response_headers,
      response_body: span.response_body,
      "http.status_code": span.attributes["http.status_code"]
    } : {}
  };
  return {
    source: "workflow-telemetry",
    event_type: "ActivityStarted",
    workflow_id: rootRunId,
    run_id: rootRunId,
    workflow_type: buf.name,
    activity_id: runId,
    activity_type: buf.name,
    task_queue: "langchain",
    spans: [],
    span_count: 0,
    hook_trigger: hookTrigger,
    timestamp: rfc3339Now()
  };
}
function handleVerdictResponse(data, url, runId) {
  if (!_config) return;
  const verdictRaw = (data["verdict"] ?? data["action"])?.toLowerCase().replace(/-/g, "_") ?? "allow";
  if (verdictRaw === "halt" || verdictRaw === "stop") {
    const reason = data["reason"] ?? "Halted by hook governance";
    _config.buffer.setHaltRequested(runId, reason);
    throw new GovernanceBlockedError("halt", reason, url);
  }
  if (verdictRaw === "block") {
    const reason = data["reason"] ?? "Blocked by hook governance";
    _config.buffer.setAborted(runId, reason);
    throw new GovernanceBlockedError("block", reason, url);
  }
  if (verdictRaw === "require_approval" || verdictRaw === "request_approval") {
    const reason = data["reason"] ?? "Approval required";
    _config.buffer.setAborted(runId, reason);
    throw new GovernanceBlockedError("require_approval", reason, url);
  }
}
async function evaluateHttpHook(stage, span, runId) {
  if (!_config) return;
  if (!runId) return;
  const { buffer, onApiError } = _config;
  if (buffer.isAborted(runId)) {
    const reason = buffer.getAbortReason(runId) ?? "Activity aborted by prior hook verdict";
    throw new GovernanceBlockedError("block", reason, span.attributes["http.url"] ?? "");
  }
  const url = span.attributes["http.url"] ?? "";
  const payload = buildHookPayload(span, stage, runId);
  if (!payload) return;
  try {
    const response = await _config.client.evaluateRaw(payload);
    if (!response) return;
    handleVerdictResponse(response, url, runId);
  } catch (err) {
    if (err instanceof GovernanceBlockedError || err instanceof GovernanceHaltError) {
      throw err;
    }
    if (onApiError === "fail_closed") {
      const msg = err instanceof Error ? err.message : String(err);
      _config.buffer.setAborted(runId, msg);
      throw new GovernanceBlockedError("halt", `Governance API error: ${msg}`, url);
    }
    console.warn("[OpenBox] Hook governance evaluation failed (fail_open):", err);
  }
}

export {
  safeSerialize,
  extractPromptText,
  extractCompletionText,
  extractTokenUsage,
  extractModelName,
  extractFinishReason,
  rfc3339Now,
  configureHookGovernance,
  isHookGovernanceConfigured,
  resetHookGovernance,
  evaluateHttpHook
};
