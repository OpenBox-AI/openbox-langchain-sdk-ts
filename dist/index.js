"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/errors.ts
var errors_exports = {};
__export(errors_exports, {
  ApprovalExpiredError: () => ApprovalExpiredError,
  ApprovalRejectedError: () => ApprovalRejectedError,
  ApprovalTimeoutError: () => ApprovalTimeoutError,
  GovernanceBlockedError: () => GovernanceBlockedError,
  GovernanceHaltError: () => GovernanceHaltError,
  GuardrailsValidationError: () => GuardrailsValidationError,
  OpenBoxAuthError: () => OpenBoxAuthError,
  OpenBoxError: () => OpenBoxError,
  OpenBoxInsecureURLError: () => OpenBoxInsecureURLError,
  OpenBoxNetworkError: () => OpenBoxNetworkError
});
var OpenBoxError, OpenBoxAuthError, OpenBoxNetworkError, OpenBoxInsecureURLError, GovernanceBlockedError, GovernanceHaltError, GuardrailsValidationError, ApprovalExpiredError, ApprovalRejectedError, ApprovalTimeoutError;
var init_errors = __esm({
  "src/errors.ts"() {
    "use strict";
    OpenBoxError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "OpenBoxError";
      }
    };
    OpenBoxAuthError = class extends OpenBoxError {
      constructor(message) {
        super(message);
        this.name = "OpenBoxAuthError";
      }
    };
    OpenBoxNetworkError = class extends OpenBoxError {
      constructor(message) {
        super(message);
        this.name = "OpenBoxNetworkError";
      }
    };
    OpenBoxInsecureURLError = class extends OpenBoxError {
      constructor(message) {
        super(message);
        this.name = "OpenBoxInsecureURLError";
      }
    };
    GovernanceBlockedError = class extends OpenBoxError {
      constructor(verdictOrReason, reasonOrPolicyId, identifierOrRiskScore, policyId, riskScore) {
        const isHookCall = verdictOrReason === "block" || verdictOrReason === "halt" || verdictOrReason === "require_approval" || verdictOrReason === "stop";
        if (isHookCall) {
          super(reasonOrPolicyId ?? verdictOrReason);
          this.verdict = verdictOrReason;
          this.identifier = typeof identifierOrRiskScore === "string" ? identifierOrRiskScore : "";
          this.policyId = policyId;
          this.riskScore = riskScore;
        } else {
          super(verdictOrReason);
          this.verdict = "block";
          this.identifier = "";
          this.policyId = typeof reasonOrPolicyId === "string" ? reasonOrPolicyId : void 0;
          this.riskScore = typeof identifierOrRiskScore === "number" ? identifierOrRiskScore : void 0;
        }
        this.name = "GovernanceBlockedError";
      }
    };
    GovernanceHaltError = class extends OpenBoxError {
      constructor(reason, identifier = "", policyId, riskScore) {
        super(reason);
        this.verdict = "halt";
        this.name = "GovernanceHaltError";
        this.identifier = identifier;
        this.policyId = policyId;
        this.riskScore = riskScore;
      }
    };
    GuardrailsValidationError = class extends OpenBoxError {
      constructor(reasons) {
        super(`Guardrails validation failed: ${reasons.join("; ")}`);
        this.name = "GuardrailsValidationError";
        this.reasons = reasons;
      }
    };
    ApprovalExpiredError = class extends OpenBoxError {
      constructor(message) {
        super(message);
        this.name = "ApprovalExpiredError";
      }
    };
    ApprovalRejectedError = class extends OpenBoxError {
      constructor(reason) {
        super(reason);
        this.name = "ApprovalRejectedError";
      }
    };
    ApprovalTimeoutError = class extends OpenBoxError {
      constructor(maxWaitMs) {
        super(`HITL approval timed out after ${maxWaitMs}ms`);
        this.name = "ApprovalTimeoutError";
        this.maxWaitMs = maxWaitMs;
      }
    };
  }
});

// src/types.ts
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
var Verdict, VERDICT_PRIORITY, DEFAULT_HITL_CONFIG;
var init_types = __esm({
  "src/types.ts"() {
    "use strict";
    Verdict = /* @__PURE__ */ ((Verdict2) => {
      Verdict2["ALLOW"] = "allow";
      Verdict2["CONSTRAIN"] = "constrain";
      Verdict2["REQUIRE_APPROVAL"] = "require_approval";
      Verdict2["BLOCK"] = "block";
      Verdict2["HALT"] = "halt";
      return Verdict2;
    })(Verdict || {});
    VERDICT_PRIORITY = {
      ["allow" /* ALLOW */]: 1,
      ["constrain" /* CONSTRAIN */]: 2,
      ["require_approval" /* REQUIRE_APPROVAL */]: 3,
      ["block" /* BLOCK */]: 4,
      ["halt" /* HALT */]: 5
    };
    DEFAULT_HITL_CONFIG = {
      enabled: true,
      pollIntervalMs: 5e3,
      maxWaitMs: 6e5,
      skipToolTypes: /* @__PURE__ */ new Set()
    };
  }
});

// src/config.ts
var config_exports = {};
__export(config_exports, {
  DEFAULT_GOVERNANCE_CONFIG: () => DEFAULT_GOVERNANCE_CONFIG,
  getGlobalConfig: () => getGlobalConfig,
  globalConfig: () => globalConfig,
  initialize: () => initialize,
  mergeConfig: () => mergeConfig,
  validateApiKeyFormat: () => validateApiKeyFormat,
  validateUrlSecurity: () => validateUrlSecurity
});
function validateApiKeyFormat(apiKey) {
  return API_KEY_PATTERN.test(apiKey);
}
function validateUrlSecurity(apiUrl) {
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new OpenBoxInsecureURLError(`Invalid URL: ${apiUrl}`);
  }
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol === "http:" && !isLocalhost) {
    throw new OpenBoxInsecureURLError(
      `Insecure HTTP URL detected: ${apiUrl}. Use HTTPS for non-localhost URLs to protect API keys in transit.`
    );
  }
}
function mergeConfig(partial) {
  return {
    ...DEFAULT_GOVERNANCE_CONFIG,
    ...partial,
    skipChainTypes: partial.skipChainTypes ? new Set(partial.skipChainTypes) : /* @__PURE__ */ new Set(),
    skipToolTypes: partial.skipToolTypes ? new Set(partial.skipToolTypes) : /* @__PURE__ */ new Set(),
    hitl: {
      ...DEFAULT_HITL_CONFIG,
      ...partial.hitl ?? {},
      skipToolTypes: partial.hitl?.skipToolTypes ? new Set(partial.hitl.skipToolTypes) : /* @__PURE__ */ new Set()
    }
  };
}
function getGlobalConfig() {
  return globalConfig.get();
}
async function validateApiKeyWithServer(apiUrl, apiKey, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${apiUrl}/api/v1/auth/validate`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "OpenBox-LangChain-SDK/0.1.0"
      },
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) {
      throw new OpenBoxAuthError(
        "Invalid API key. Check your API key at dashboard.openbox.ai"
      );
    }
    if (!response.ok) {
      throw new OpenBoxNetworkError(
        `Cannot reach OpenBox Core at ${apiUrl}: HTTP ${response.status}`
      );
    }
  } catch (err) {
    if (err instanceof OpenBoxAuthError || err instanceof OpenBoxNetworkError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new OpenBoxNetworkError(
      `Cannot reach OpenBox Core at ${apiUrl}: ${message}`
    );
  } finally {
    clearTimeout(timer);
  }
}
async function initialize(options) {
  const { apiUrl, apiKey, governanceTimeout = 3e4, validate = true } = options;
  validateUrlSecurity(apiUrl);
  if (!validateApiKeyFormat(apiKey)) {
    throw new OpenBoxAuthError(
      `Invalid API key format. Expected 'obx_live_*' or 'obx_test_*', got: '${apiKey.slice(0, 15)}...'`
    );
  }
  globalConfig.configure(apiUrl.replace(/\/$/, ""), apiKey, governanceTimeout);
  if (validate) {
    await validateApiKeyWithServer(
      apiUrl.replace(/\/$/, ""),
      apiKey,
      governanceTimeout
    );
  }
}
var API_KEY_PATTERN, DEFAULT_GOVERNANCE_CONFIG, _GlobalConfig, globalConfig;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
    init_errors();
    init_types();
    API_KEY_PATTERN = /^obx_(live|test)_[a-zA-Z0-9_]+$/;
    DEFAULT_GOVERNANCE_CONFIG = {
      onApiError: "fail_open",
      apiTimeout: 3e4,
      sendChainStartEvent: true,
      sendChainEndEvent: true,
      sendToolStartEvent: true,
      sendToolEndEvent: true,
      sendLLMStartEvent: true,
      sendLLMEndEvent: true,
      skipChainTypes: /* @__PURE__ */ new Set(),
      skipToolTypes: /* @__PURE__ */ new Set(),
      hitl: { ...DEFAULT_HITL_CONFIG }
    };
    _GlobalConfig = class {
      constructor() {
        this._apiUrl = "";
        this._apiKey = "";
        this._governanceTimeout = 3e4;
      }
      configure(apiUrl, apiKey, governanceTimeout = 3e4) {
        this._apiUrl = apiUrl.replace(/\/$/, "");
        this._apiKey = apiKey;
        this._governanceTimeout = governanceTimeout;
      }
      isConfigured() {
        return Boolean(this._apiUrl && this._apiKey);
      }
      get() {
        return {
          apiUrl: this._apiUrl,
          apiKey: this._apiKey,
          governanceTimeout: this._governanceTimeout
        };
      }
    };
    globalConfig = new _GlobalConfig();
  }
});

// src/client.ts
var client_exports = {};
__export(client_exports, {
  GovernanceClient: () => GovernanceClient
});
var GovernanceClient;
var init_client = __esm({
  "src/client.ts"() {
    "use strict";
    init_errors();
    init_types();
    GovernanceClient = class {
      constructor(config) {
        this.apiUrl = config.apiUrl.replace(/\/$/, "");
        this.apiKey = config.apiKey;
        this.timeout = config.timeout ?? 3e4;
        this.onApiError = config.onApiError ?? "fail_open";
      }
      async validateApiKey() {
        const { OpenBoxAuthError: OpenBoxAuthError2 } = await Promise.resolve().then(() => (init_errors(), errors_exports));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
          const response = await fetch(`${this.apiUrl}/api/v1/auth/validate`, {
            method: "GET",
            headers: this._headers(),
            signal: controller.signal
          });
          if (response.status === 401 || response.status === 403) {
            throw new OpenBoxAuthError2(
              "Invalid API key. Check your API key at dashboard.openbox.ai"
            );
          }
          if (!response.ok) {
            throw new OpenBoxNetworkError(
              `Cannot reach OpenBox Core at ${this.apiUrl}: HTTP ${response.status}`
            );
          }
        } catch (err) {
          if (err instanceof OpenBoxNetworkError || err.name === "OpenBoxAuthError") {
            throw err;
          }
          const message = err instanceof Error ? err.message : String(err);
          throw new OpenBoxNetworkError(
            `Cannot reach OpenBox Core at ${this.apiUrl}: ${message}`
          );
        } finally {
          clearTimeout(timer);
        }
      }
      /**
       * Send a governance event to OpenBox Core.
       * Returns null on network failure if fail_open.
       * Throws OpenBoxNetworkError on network failure if fail_closed.
       */
      async evaluateEvent(event) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
          const serverPayload = {
            ...event,
            event_type: toServerEventType(event.event_type),
            task_queue: event.task_queue ?? "langchain",
            source: "workflow-telemetry"
          };
          if (process.env["OPENBOX_DEBUG"] === "1") {
            console.log("[OpenBox Debug] governance request:", JSON.stringify(serverPayload, null, 2));
          }
          const response = await fetch(
            `${this.apiUrl}/api/v1/governance/evaluate`,
            {
              method: "POST",
              headers: this._headers(),
              body: JSON.stringify(serverPayload),
              signal: controller.signal
            }
          );
          if (!response.ok) {
            const msg = `HTTP ${response.status}`;
            if (this.onApiError === "fail_closed") {
              throw new OpenBoxNetworkError(
                `Governance API error: ${msg}`
              );
            }
            return null;
          }
          const data = await response.json();
          if (process.env["OPENBOX_DEBUG"] === "1") {
            console.log("[OpenBox Debug] governance response:", JSON.stringify(data, null, 2));
          }
          return parseGovernanceResponse(data);
        } catch (err) {
          if (err instanceof OpenBoxNetworkError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          if (this.onApiError === "fail_closed") {
            throw new OpenBoxNetworkError(
              `Governance API unreachable: ${message}`
            );
          }
          return null;
        } finally {
          clearTimeout(timer);
        }
      }
      /**
       * Poll for HITL approval status.
       * Returns null on network failure (caller handles retry logic).
       */
      async pollApproval(params) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
          const response = await fetch(
            `${this.apiUrl}/api/v1/governance/approval`,
            {
              method: "POST",
              headers: this._headers(),
              body: JSON.stringify({
                workflow_id: params.workflowId,
                run_id: params.runId,
                activity_id: params.activityId
              }),
              signal: controller.signal
            }
          );
          if (!response.ok) {
            return null;
          }
          const data = await response.json();
          const parsed = parseApprovalResponse(data);
          if (parsed.approval_expiration_time && !parsed.expired) {
            const expiry = new Date(parsed.approval_expiration_time).getTime();
            if (expiry < Date.now()) {
              parsed.expired = true;
            }
          }
          return parsed;
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      }
      /**
       * Send a pre-built payload to the governance evaluate endpoint.
       * Used by hook-level governance where the payload is already fully assembled
       * (no event_type translation needed — caller sets event_type directly).
       *
       * Returns the raw parsed JSON response, or null on failure (fail_open).
       * Throws OpenBoxNetworkError on failure if fail_closed.
       */
      async evaluateRaw(payload) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
          const response = await fetch(
            `${this.apiUrl}/api/v1/governance/evaluate`,
            {
              method: "POST",
              headers: this._headers(),
              body: JSON.stringify(payload),
              signal: controller.signal
            }
          );
          if (!response.ok) {
            if (this.onApiError === "fail_closed") {
              throw new OpenBoxNetworkError(`Governance API error: HTTP ${response.status}`);
            }
            return null;
          }
          return await response.json();
        } catch (err) {
          if (err instanceof OpenBoxNetworkError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          if (this.onApiError === "fail_closed") {
            throw new OpenBoxNetworkError(`Governance API unreachable: ${message}`);
          }
          return null;
        } finally {
          clearTimeout(timer);
        }
      }
      /**
       * Build a fail-closed HALT response for when the API is unreachable and
       * onApiError = "fail_closed".
       */
      static haltResponse(reason) {
        return {
          verdict: "halt" /* HALT */,
          reason
        };
      }
      _headers() {
        return {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "OpenBox-LangChain-SDK/0.1.0"
        };
      }
    };
  }
});

// src/serializer.ts
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
var MAX_STRING_LENGTH, MAX_DEPTH;
var init_serializer = __esm({
  "src/serializer.ts"() {
    "use strict";
    MAX_STRING_LENGTH = 1e4;
    MAX_DEPTH = 8;
  }
});

// src/hook-governance.ts
var hook_governance_exports = {};
__export(hook_governance_exports, {
  configureHookGovernance: () => configureHookGovernance,
  evaluateHttpHook: () => evaluateHttpHook,
  isHookGovernanceConfigured: () => isHookGovernanceConfigured,
  resetHookGovernance: () => resetHookGovernance
});
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
var _config;
var init_hook_governance = __esm({
  "src/hook-governance.ts"() {
    "use strict";
    init_serializer();
    init_errors();
    _config = null;
  }
});

// src/signal-monitor.ts
var signal_monitor_exports = {};
__export(signal_monitor_exports, {
  OpenBoxSignalMonitor: () => OpenBoxSignalMonitor
});
var OpenBoxSignalMonitor;
var init_signal_monitor = __esm({
  "src/signal-monitor.ts"() {
    "use strict";
    init_errors();
    init_types();
    OpenBoxSignalMonitor = class {
      constructor(client, config = {}) {
        this._timer = null;
        this._running = false;
        this._workflowId = null;
        this._controller = null;
        this._pollCount = 0;
        this._aborted = false;
        this._startedAt = 0;
        this.client = client;
        this.config = {
          pollIntervalMs: config.pollIntervalMs ?? 3e3,
          maxDurationMs: config.maxDurationMs ?? 36e5,
          throwOnAbort: config.throwOnAbort ?? true
        };
      }
      /**
       * Start background polling for the given workflow session.
       *
       * @param workflowId  Root chain run_id (= workflow_id sent to OpenBox)
       * @param controller  AbortController whose .signal is passed to the LangChain executor
       */
      start(workflowId, controller) {
        if (this._running) {
          this.stop();
        }
        this._workflowId = workflowId;
        this._controller = controller;
        this._running = true;
        this._aborted = false;
        this._pollCount = 0;
        this._startedAt = Date.now();
        this._scheduleNext();
      }
      /**
       * Stop the background poller. Safe to call multiple times.
       */
      stop() {
        this._running = false;
        if (this._timer !== null) {
          clearTimeout(this._timer);
          this._timer = null;
        }
        this._workflowId = null;
        this._controller = null;
      }
      get status() {
        return {
          running: this._running,
          workflowId: this._workflowId,
          pollCount: this._pollCount,
          aborted: this._aborted,
          abortReason: this._abortReason,
          abortVerdict: this._abortVerdict
        };
      }
      _scheduleNext() {
        if (!this._running) return;
        this._timer = setTimeout(() => {
          this._poll().catch(() => {
            if (this._running) this._scheduleNext();
          });
        }, this.config.pollIntervalMs);
      }
      async _poll() {
        if (!this._running || !this._workflowId || !this._controller) return;
        if (Date.now() - this._startedAt > this.config.maxDurationMs) {
          this.stop();
          return;
        }
        this._pollCount++;
        const signalEvent = {
          source: "workflow-telemetry",
          event_type: "AgentAction",
          // maps to ActivityStarted on server
          workflow_id: this._workflowId,
          run_id: this._workflowId,
          workflow_type: "SignalCheck",
          task_queue: "langchain",
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          activity_id: `signal-${this._pollCount}-${this._workflowId}`,
          activity_type: "SignalReceived",
          activity_input: [{ signal: "openbox-poll", poll_count: this._pollCount }]
        };
        const response = await this.client.evaluateEvent(signalEvent);
        if (!response) {
          if (this._running) this._scheduleNext();
          return;
        }
        const { verdict, reason } = response;
        if (verdictShouldStop(verdict)) {
          this._aborted = true;
          this._abortReason = reason ?? (verdict === "halt" /* HALT */ ? "Agent halted by governance policy" : "Agent blocked by governance policy");
          this._abortVerdict = verdict;
          this._controller.abort(
            verdict === "halt" /* HALT */ ? new GovernanceHaltError(this._abortReason) : new GovernanceBlockedError(this._abortReason)
          );
          this.stop();
          return;
        }
        if (this._running) this._scheduleNext();
      }
    };
  }
});

// src/index.ts
var index_exports = {};
__export(index_exports, {
  ApprovalExpiredError: () => ApprovalExpiredError,
  ApprovalRejectedError: () => ApprovalRejectedError,
  ApprovalTimeoutError: () => ApprovalTimeoutError,
  DEFAULT_HITL_CONFIG: () => DEFAULT_HITL_CONFIG,
  GovernanceBlockedError: () => GovernanceBlockedError,
  GovernanceClient: () => GovernanceClient,
  GovernanceHaltError: () => GovernanceHaltError,
  GuardrailsValidationError: () => GuardrailsValidationError,
  OpenBoxAuthError: () => OpenBoxAuthError,
  OpenBoxCallbackHandler: () => OpenBoxCallbackHandler,
  OpenBoxError: () => OpenBoxError,
  OpenBoxInsecureURLError: () => OpenBoxInsecureURLError,
  OpenBoxNetworkError: () => OpenBoxNetworkError,
  OpenBoxSignalMonitor: () => OpenBoxSignalMonitor,
  RunBufferManager: () => RunBufferManager,
  SpanCollector: () => SpanCollector,
  StreamingTokenBuffer: () => StreamingTokenBuffer,
  Verdict: () => Verdict,
  applyInputRedaction: () => applyInputRedaction,
  applyOutputRedaction: () => applyOutputRedaction,
  configureHookGovernance: () => configureHookGovernance,
  createOpenBoxHandler: () => createOpenBoxHandler,
  enforceVerdict: () => enforceVerdict,
  evaluateHttpHook: () => evaluateHttpHook,
  eventTypeToContext: () => eventTypeToContext,
  extractCompletionText: () => extractCompletionText,
  extractFinishReason: () => extractFinishReason,
  extractModelName: () => extractModelName,
  extractPromptText: () => extractPromptText,
  extractTokenUsage: () => extractTokenUsage,
  getGlobalConfig: () => getGlobalConfig,
  getGuardrailsReasons: () => getGuardrailsReasons,
  globalSpanCollector: () => globalSpanCollector,
  globalStreamingBuffer: () => globalStreamingBuffer,
  highestPriorityVerdict: () => highestPriorityVerdict,
  initialize: () => initialize,
  isFetchPatched: () => isFetchPatched,
  isHITLApplicable: () => isHITLApplicable,
  isHookGovernanceConfigured: () => isHookGovernanceConfigured,
  mergeConfig: () => mergeConfig,
  parseApprovalResponse: () => parseApprovalResponse,
  parseGovernanceResponse: () => parseGovernanceResponse,
  patchFetch: () => patchFetch,
  pollUntilDecision: () => pollUntilDecision,
  resetHookGovernance: () => resetHookGovernance,
  rfc3339Now: () => rfc3339Now,
  safeSerialize: () => safeSerialize,
  setupTelemetry: () => setupTelemetry,
  unpatchFetch: () => unpatchFetch,
  verdictFromString: () => verdictFromString,
  verdictPriority: () => verdictPriority,
  verdictRequiresApproval: () => verdictRequiresApproval,
  verdictShouldStop: () => verdictShouldStop,
  wrapLLM: () => wrapLLM,
  wrapTool: () => wrapTool,
  wrapTools: () => wrapTools
});
module.exports = __toCommonJS(index_exports);
init_config();

// src/callback-handler.ts
var import_base = require("@langchain/core/callbacks/base");
init_client();
init_config();

// src/telemetry.ts
var SpanCollector = class {
  constructor() {
    this.spans = /* @__PURE__ */ new Map();
    this.currentRunId = null;
    /** Span IDs evaluated at hook level — excluded from bulk ActivityCompleted payload */
    this.governedSpanIds = /* @__PURE__ */ new Set();
  }
  /** Set the active run_id that spans will be attributed to */
  setActiveRun(runId) {
    this.currentRunId = runId;
    if (!this.spans.has(runId)) {
      this.spans.set(runId, []);
    }
  }
  clearActiveRun() {
    this.currentRunId = null;
  }
  /** Expose current run_id for hook-governance lookup */
  get activeRunId() {
    return this.currentRunId;
  }
  addSpan(span, runId) {
    const target = runId ?? this.currentRunId;
    if (!target) return;
    let bucket = this.spans.get(target);
    if (!bucket) {
      bucket = [];
      this.spans.set(target, bucket);
    }
    bucket.push(span);
  }
  /**
   * Mark a span as governed so it is excluded from the bulk ActivityCompleted
   * spans array (already individually evaluated at hook level).
   * Mirrors WorkflowSpanProcessor.mark_governed() in the Temporal SDK.
   */
  markSpanGoverned(spanId) {
    this.governedSpanIds.add(spanId);
    if (this.governedSpanIds.size > 1e4) {
      this.governedSpanIds.clear();
    }
  }
  isSpanGoverned(spanId) {
    return this.governedSpanIds.has(spanId);
  }
  /**
   * Returns spans for a run, excluding any that were already evaluated by hook governance.
   */
  getSpans(runId) {
    const all = this.spans.get(runId) ?? [];
    if (this.governedSpanIds.size === 0) return all;
    return all.filter((s) => !this.governedSpanIds.has(s.span_id));
  }
  clearSpans(runId) {
    this.spans.delete(runId);
  }
  get size() {
    return this.spans.size;
  }
};
var globalSpanCollector = new SpanCollector();
var _fetchPatched = false;
var _originalFetch = null;
var IGNORED_URL_PATTERNS = [
  /\/api\/v1\/governance\//,
  /\/api\/v1\/auth\//
];
function shouldIgnoreUrl(url) {
  return IGNORED_URL_PATTERNS.some((p) => p.test(url));
}
function generateSpanId() {
  const uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : r & 3 | 8).toString(16);
  });
  return `http-${uuid}`;
}
function safeReadBody(body) {
  if (!body) return void 0;
  if (typeof body === "string") return body.slice(0, 8192);
  try {
    return JSON.stringify(body).slice(0, 8192);
  } catch {
    return String(body).slice(0, 8192);
  }
}
function headersToRecord(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out = {};
    headers.forEach((val, key) => {
      if (key.toLowerCase() !== "authorization") {
        out[key] = val;
      }
    });
    return out;
  }
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([k]) => k.toLowerCase() !== "authorization"
    )
  );
}
function patchFetch(collector = globalSpanCollector) {
  if (_fetchPatched) return;
  if (typeof globalThis.fetch !== "function") return;
  _originalFetch = globalThis.fetch;
  _fetchPatched = true;
  globalThis.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (shouldIgnoreUrl(url)) {
      return _originalFetch(input, init);
    }
    const spanId = generateSpanId();
    const startTime = Date.now();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    let requestBody;
    try {
      if (init?.body) {
        requestBody = safeReadBody(init.body);
      } else if (input instanceof Request && input.body) {
        const cloned = input.clone();
        requestBody = await cloned.text().catch(() => void 0);
      }
    } catch {
    }
    const requestHeaders = headersToRecord(
      init?.headers
    );
    const { evaluateHttpHook: evaluateHttpHook2, isHookGovernanceConfigured: isHookGovernanceConfigured2 } = await Promise.resolve().then(() => (init_hook_governance(), hook_governance_exports));
    const activeRunId = collector.activeRunId;
    if (isHookGovernanceConfigured2() && activeRunId) {
      const startedSpan = {
        span_id: spanId,
        name: `HTTP ${method} ${url}`,
        kind: "client",
        start_time: startTime,
        attributes: {
          "http.method": method,
          "http.url": url
        },
        status: { code: "OK" },
        request_body: requestBody,
        request_headers: requestHeaders
      };
      await evaluateHttpHook2("started", startedSpan, activeRunId);
    }
    let response;
    let statusCode = 0;
    let statusText = "";
    let responseBody;
    let responseHeaders = {};
    try {
      response = await _originalFetch(input, init);
      statusCode = response.status;
      statusText = response.statusText;
      responseHeaders = headersToRecord(response.headers);
      try {
        const cloned = response.clone();
        const text = await cloned.text();
        responseBody = text.slice(0, 8192);
      } catch {
      }
      const endTime = Date.now();
      const span = {
        span_id: spanId,
        name: `HTTP ${method} ${new URL(url).pathname}`,
        kind: "client",
        start_time: startTime,
        end_time: endTime,
        duration_ns: (endTime - startTime) * 1e6,
        attributes: {
          "http.method": method,
          "http.url": url,
          "http.status_code": statusCode,
          "http.host": new URL(url).host
        },
        status: {
          code: statusCode >= 400 ? "ERROR" : "OK",
          description: statusCode >= 400 ? statusText : void 0
        },
        request_body: requestBody,
        response_body: responseBody,
        request_headers: requestHeaders,
        response_headers: responseHeaders
      };
      if (isHookGovernanceConfigured2() && activeRunId) {
        await evaluateHttpHook2("completed", span, activeRunId).catch(() => {
        });
      }
      collector.addSpan(span, activeRunId ?? void 0);
      return response;
    } catch (err) {
      const endTime = Date.now();
      const span = {
        span_id: spanId,
        name: `HTTP ${method} ${url}`,
        kind: "client",
        start_time: startTime,
        end_time: endTime,
        duration_ns: (endTime - startTime) * 1e6,
        attributes: {
          "http.method": method,
          "http.url": url,
          "http.error": err instanceof Error ? err.message : String(err)
        },
        status: { code: "ERROR", description: String(err) },
        request_body: requestBody,
        request_headers: requestHeaders
      };
      collector.addSpan(span, activeRunId ?? void 0);
      throw err;
    }
  };
}
function unpatchFetch() {
  if (_fetchPatched && _originalFetch) {
    globalThis.fetch = _originalFetch;
    _fetchPatched = false;
    _originalFetch = null;
  }
}
function isFetchPatched() {
  return _fetchPatched;
}
function setupTelemetry(options = {}) {
  const collector = options.collector ?? globalSpanCollector;
  if (options.patchFetchEnabled !== false) {
    patchFetch(collector);
  }
  return collector;
}

// src/streaming.ts
var StreamingTokenBuffer = class {
  constructor() {
    this.buffers = /* @__PURE__ */ new Map();
  }
  start(runId, model) {
    this.buffers.set(runId, {
      runId,
      tokens: [],
      startTime: Date.now(),
      model
    });
  }
  addToken(runId, token) {
    const buf = this.buffers.get(runId);
    if (buf) buf.tokens.push(token);
  }
  getAccumulated(runId) {
    return this.buffers.get(runId)?.tokens.join("") ?? "";
  }
  getBuffer(runId) {
    return this.buffers.get(runId);
  }
  clear(runId) {
    this.buffers.delete(runId);
  }
  get size() {
    return this.buffers.size;
  }
};
var globalStreamingBuffer = new StreamingTokenBuffer();

// src/guardrails.ts
function applyInputRedaction(originalInput, guardrails) {
  if (!guardrails) return originalInput;
  if (guardrails.input_type !== "activity_input") return originalInput;
  if (guardrails.redacted_input === void 0 || guardrails.redacted_input === null) {
    return originalInput;
  }
  const redacted = guardrails.redacted_input;
  if (typeof originalInput === "string" && typeof redacted === "string") {
    return redacted;
  }
  if (originalInput !== null && typeof originalInput === "object" && !Array.isArray(originalInput) && redacted !== null && typeof redacted === "object" && !Array.isArray(redacted)) {
    return deepMerge(
      originalInput,
      redacted
    );
  }
  if (Array.isArray(redacted) && redacted.length === 1) {
    return applyInputRedaction(originalInput, {
      ...guardrails,
      redacted_input: redacted[0]
    });
  }
  return redacted;
}
function applyOutputRedaction(originalOutput, guardrails) {
  if (!guardrails) return originalOutput;
  if (guardrails.input_type !== "activity_output") return originalOutput;
  if (guardrails.redacted_input === void 0 || guardrails.redacted_input === null) {
    return originalOutput;
  }
  const redacted = guardrails.redacted_input;
  if (typeof originalOutput === "string" && typeof redacted === "string") {
    return redacted;
  }
  if (originalOutput !== null && typeof originalOutput === "object" && !Array.isArray(originalOutput) && redacted !== null && typeof redacted === "object" && !Array.isArray(redacted)) {
    return deepMerge(
      originalOutput,
      redacted
    );
  }
  return redacted;
}
function getGuardrailsReasons(guardrails) {
  return (guardrails.reasons ?? []).map((r) => r.reason).filter(Boolean);
}
function deepMerge(original, redacted) {
  const result = { ...original };
  for (const key of Object.keys(redacted)) {
    const redactedVal = redacted[key];
    const originalVal = original[key];
    if (redactedVal !== null && typeof redactedVal === "object" && !Array.isArray(redactedVal) && originalVal !== null && typeof originalVal === "object" && !Array.isArray(originalVal)) {
      result[key] = deepMerge(
        originalVal,
        redactedVal
      );
    } else {
      result[key] = redactedVal;
    }
  }
  return result;
}

// src/hitl.ts
init_errors();
init_types();
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function pollUntilDecision(client, params, config) {
  const deadline = Date.now() + config.maxWaitMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ApprovalTimeoutError(config.maxWaitMs);
    }
    await sleep(Math.min(config.pollIntervalMs, remaining));
    if (Date.now() >= deadline) {
      throw new ApprovalTimeoutError(config.maxWaitMs);
    }
    const response = await client.pollApproval({
      workflowId: params.workflowId,
      runId: params.runId,
      activityId: params.activityId
    });
    if (!response) {
      continue;
    }
    if (response.expired) {
      throw new ApprovalExpiredError(
        `Approval expired for ${params.activityType} (activity_id=${params.activityId})`
      );
    }
    const { verdict, reason } = response;
    if (verdict === "allow" /* ALLOW */) {
      return;
    }
    if (verdictShouldStop(verdict)) {
      throw new ApprovalRejectedError(
        reason ?? `Approval rejected for ${params.activityType}`
      );
    }
    if (verdict === "block" /* BLOCK */) {
      throw new GovernanceBlockedError(
        reason ?? `Approval rejected for ${params.activityType}`
      );
    }
  }
}

// src/run-buffer.ts
var RunBufferManager = class {
  constructor() {
    /** run_id → RunBuffer */
    this.buffers = /* @__PURE__ */ new Map();
    /** run_id → root run_id */
    this.runToRoot = /* @__PURE__ */ new Map();
  }
  /**
   * Register a new run. Call on every handleChainStart / handleToolStart / handleLLMStart.
   * If parentRunId is undefined, this run IS the root.
   * If the runId is already registered (stale buffer from a previous session), it is reset.
   */
  registerRun(runId, runType, name, parentRunId) {
    const rootRunId = parentRunId ? this.runToRoot.get(parentRunId) ?? parentRunId : runId;
    const existing = this.buffers.get(runId);
    const attempt = existing ? existing.attempt + 1 : 1;
    this.runToRoot.set(runId, rootRunId);
    this.buffers.set(runId, {
      rootRunId,
      runId,
      parentRunId,
      runType,
      name,
      startTime: Date.now(),
      pendingApproval: existing?.pendingApproval ?? false,
      verdict: existing?.verdict,
      verdictReason: existing?.verdictReason,
      attempt
    });
  }
  /**
   * Get the root run_id for any run in the hierarchy.
   * Returns runId itself if not found (defensive).
   */
  getRootRunId(runId) {
    return this.runToRoot.get(runId) ?? runId;
  }
  getBuffer(runId) {
    return this.buffers.get(runId);
  }
  markCompleted(runId) {
    const buf = this.buffers.get(runId);
    if (buf) {
      buf.endTime = Date.now();
      buf.status = "completed";
    }
  }
  markFailed(runId) {
    const buf = this.buffers.get(runId);
    if (buf) {
      buf.endTime = Date.now();
      buf.status = "failed";
    }
  }
  setVerdictForRun(runId, verdict, reason) {
    const buf = this.buffers.get(runId);
    if (buf) {
      buf.verdict = verdict;
      buf.verdictReason = reason;
    }
  }
  setPendingApproval(runId, pending) {
    const buf = this.buffers.get(runId);
    if (buf) {
      buf.pendingApproval = pending;
    }
  }
  isPendingApproval(runId) {
    return this.buffers.get(runId)?.pendingApproval ?? false;
  }
  setAborted(runId, reason) {
    const buf = this.buffers.get(runId);
    if (buf) {
      buf.aborted = true;
      buf.abortReason = reason;
    }
  }
  isAborted(runId) {
    return this.buffers.get(runId)?.aborted ?? false;
  }
  getAbortReason(runId) {
    return this.buffers.get(runId)?.abortReason;
  }
  setHaltRequested(runId, reason) {
    const buf = this.buffers.get(runId);
    if (buf) {
      buf.haltRequested = true;
      buf.haltReason = reason;
      buf.aborted = true;
      buf.abortReason = reason;
    }
  }
  isHaltRequested(runId) {
    return this.buffers.get(runId)?.haltRequested ?? false;
  }
  setRedactedInput(runId, value) {
    const buf = this.buffers.get(runId);
    if (buf) buf.redactedInput = value;
  }
  getRedactedInput(runId) {
    return this.buffers.get(runId)?.redactedInput;
  }
  setRedactedOutput(runId, value) {
    const buf = this.buffers.get(runId);
    if (buf) buf.redactedOutput = value;
  }
  getRedactedOutput(runId) {
    return this.buffers.get(runId)?.redactedOutput;
  }
  getAttempt(runId) {
    return this.buffers.get(runId)?.attempt ?? 1;
  }
  /**
   * Remove all buffers associated with a root run (cleanup after chain ends).
   */
  cleanup(rootRunId) {
    const toDelete = [];
    for (const [runId, rootId] of this.runToRoot.entries()) {
      if (rootId === rootRunId) {
        toDelete.push(runId);
      }
    }
    for (const runId of toDelete) {
      this.buffers.delete(runId);
      this.runToRoot.delete(runId);
    }
  }
  /** Total number of tracked runs (useful for debugging). */
  get size() {
    return this.buffers.size;
  }
};

// src/callback-handler.ts
init_serializer();

// src/verdict-handler.ts
init_errors();
init_types();
function eventTypeToContext(eventType) {
  switch (eventType) {
    case "ChainStarted":
      return "chain_start";
    case "ChainCompleted":
      return "chain_end";
    case "ToolStarted":
      return "tool_start";
    case "ToolCompleted":
      return "tool_end";
    case "LLMStarted":
      return "llm_start";
    case "LLMCompleted":
      return "llm_end";
    case "AgentAction":
      return "agent_action";
    case "AgentFinish":
      return "agent_finish";
    default:
      return "other";
  }
}
function isHITLApplicable(context) {
  return context === "tool_start" || context === "tool_end" || context === "llm_start" || context === "llm_end" || context === "agent_action";
}
function enforceVerdict(response, context) {
  const { verdict, reason, policy_id, risk_score } = response;
  const isObservationOnlyContext = context === "chain_end" || context === "agent_finish" || context === "other";
  if (isObservationOnlyContext) {
    return { requiresHITL: false, blocked: false };
  }
  if (response.guardrails_result && !response.guardrails_result.validation_passed) {
    const reasons = (response.guardrails_result.reasons ?? []).map(
      (r) => r.reason
    ).filter(Boolean);
    throw new GuardrailsValidationError(
      reasons.length > 0 ? reasons : ["Guardrails validation failed"]
    );
  }
  if (verdict === "halt" /* HALT */) {
    throw new GovernanceHaltError(
      reason ?? "Workflow halted by governance policy",
      "",
      // identifier — not available at activity level
      policy_id,
      risk_score
    );
  }
  if (verdict === "block" /* BLOCK */) {
    throw new GovernanceBlockedError(
      reason ?? "Action blocked by governance policy",
      policy_id,
      risk_score
    );
  }
  if (verdictRequiresApproval(verdict)) {
    if (isHITLApplicable(context)) {
      return { requiresHITL: true, blocked: false };
    } else {
      throw new GovernanceBlockedError(
        reason ?? "Action requires approval but cannot be paused at this stage",
        policy_id,
        risk_score
      );
    }
  }
  if (verdict === "constrain" /* CONSTRAIN */) {
    if (reason) {
      console.warn(
        `[OpenBox] Governance constraint: ${reason}${policy_id ? ` (policy: ${policy_id})` : ""}`
      );
    }
    return { requiresHITL: false, blocked: false };
  }
  return { requiresHITL: false, blocked: false };
}

// src/callback-handler.ts
init_types();
init_errors();
init_hook_governance();
function _cleanGuardrailReason(reason) {
  reason = reason.replace(/\n?-\s*Question:\s*\[Session context\][^\n]*\n?/g, "");
  const markers = ["\n\nThought:", "\n\nThought", "\nThought:", "\nThought"];
  for (const m of markers) {
    const idx = reason.indexOf(m);
    if (idx >= 0) {
      return reason.slice(0, idx).trimEnd();
    }
  }
  return reason.trimEnd();
}
function _getGuardrailFailureReasons(reasons) {
  const first = reasons?.find((r) => r?.reason)?.reason;
  if (!first) {
    return ["Guardrails validation failed"];
  }
  return [_cleanGuardrailReason(first)];
}
var OpenBoxCallbackHandler = class extends import_base.BaseCallbackHandler {
  constructor(options = {}) {
    super();
    this.name = "OpenBoxCallbackHandler";
    /**
     * Run IDs where wrapTool has already performed the AGE ToolCompleted evaluation.
     * handleToolEnd skips re-evaluation for these runs to avoid double-sending.
     */
    this._toolEndHandledByWrapper = /* @__PURE__ */ new Set();
    this.config = mergeConfig(options);
    if (options.client) {
      this.client = options.client;
    } else {
      const gc = globalConfig.get();
      this.client = new GovernanceClient({
        apiUrl: gc.apiUrl,
        apiKey: gc.apiKey,
        timeout: gc.governanceTimeout,
        onApiError: this.config.onApiError
      });
    }
    this.buffer = options.buffer ?? new RunBufferManager();
    this.spanCollector = options.spanCollector ?? globalSpanCollector;
    this.streamingBuffer = options.streamingBuffer ?? globalStreamingBuffer;
    this.enforceAgentActions = options.enforceAgentActions ?? true;
    this.signalMonitor = options.signalMonitor;
    this.abortController = options.abortController;
    this.awaitHandlers = true;
    this.raiseError = true;
    configureHookGovernance({
      client: this.client,
      buffer: this.buffer,
      spanCollector: this.spanCollector,
      onApiError: this.config.onApiError ?? "fail_open"
    });
  }
  // ─────────────────────────────────────────────────────────────────
  // Chain Events
  // ─────────────────────────────────────────────────────────────────
  async handleChainStart(chain, inputs, runId, parentRunId, _tags, _metadata, runType, name) {
    const chainName = name ?? chain?.id?.at(-1) ?? runType ?? "Chain";
    this.buffer.registerRun(runId, "chain", chainName, parentRunId);
    if (!this.config.sendChainStartEvent) return;
    if (this.config.skipChainTypes.has(chainName)) return;
    this._checkPendingStopVerdict(runId);
    const rootRunId = this.buffer.getRootRunId(runId);
    const attempt = this.buffer.getAttempt(runId);
    if (!parentRunId && this.signalMonitor && this.abortController) {
      this.signalMonitor.start(rootRunId, this.abortController);
    }
    if (parentRunId) return;
    const event = this._buildEvent("ChainStarted", rootRunId, {
      activity_id: runId,
      activity_type: chainName,
      activity_input: [safeSerialize(inputs)],
      parent_run_id: parentRunId,
      attempt
    });
    const response = await this.client.evaluateEvent(event);
    if (!response) return;
    const ctx = eventTypeToContext("ChainStarted");
    enforceVerdict(response, ctx);
    this._storeVerdict(runId, response);
  }
  async handleChainEnd(outputs, runId, parentRunId) {
    const buf = this.buffer.getBuffer(runId);
    this.buffer.markCompleted(runId);
    const chainName = buf?.name ?? "Chain";
    if (!this.config.sendChainEndEvent) {
      this._cleanupIfRoot(runId, parentRunId);
      return;
    }
    if (this.config.skipChainTypes.has(chainName)) {
      this._cleanupIfRoot(runId, parentRunId);
      return;
    }
    const rootRunId = this.buffer.getRootRunId(runId);
    const endTimeMs = Date.now();
    const durationMs = buf ? endTimeMs - buf.startTime : void 0;
    const startTimeSec = buf ? buf.startTime / 1e3 : void 0;
    const endTimeSec = endTimeMs / 1e3;
    const attempt = this.buffer.getAttempt(runId);
    if (parentRunId) {
      this._cleanupIfRoot(runId, parentRunId);
      return;
    }
    const chainEndEventType = "ChainCompleted";
    const serializedOutput = safeSerialize(outputs);
    const event = this._buildEvent(chainEndEventType, rootRunId, {
      activity_id: runId,
      activity_type: chainName,
      workflow_output: serializedOutput,
      activity_output: serializedOutput,
      status: "completed",
      start_time: startTimeSec,
      end_time: endTimeSec,
      duration_ms: durationMs,
      parent_run_id: parentRunId,
      attempt
    });
    const response = await this.client.evaluateEvent(event);
    if (!parentRunId && this.signalMonitor) {
      this.signalMonitor.stop();
    }
    this._cleanupIfRoot(runId, parentRunId);
    if (!response) return;
    const ctx = eventTypeToContext("ChainCompleted");
    enforceVerdict(response, ctx);
  }
  async handleChainError(err, runId, parentRunId) {
    const buf = this.buffer.getBuffer(runId);
    this.buffer.markFailed(runId);
    if (!parentRunId && this.signalMonitor) {
      this.signalMonitor.stop();
    }
    const chainName = buf?.name ?? "Chain";
    const rootRunId = this.buffer.getRootRunId(runId);
    const durationMs = buf ? Date.now() - buf.startTime : void 0;
    const attempt = this.buffer.getAttempt(runId);
    const event = this._buildEvent("ChainFailed", rootRunId, {
      activity_id: runId,
      activity_type: chainName,
      status: "failed",
      duration_ms: durationMs,
      error: serializeError(err),
      parent_run_id: parentRunId,
      attempt
    });
    this._cleanupIfRoot(runId, parentRunId);
    await this.client.evaluateEvent(event).catch(() => void 0);
  }
  // ─────────────────────────────────────────────────────────────────
  // LLM Events
  // ─────────────────────────────────────────────────────────────────
  /**
   * Called for ChatModel invocations — receives the actual BaseMessage[][] array
   * that will be sent to the API. With awaitHandlers=true we can mutate these
   * in-place so redacted content replaces PII before the OpenAI call fires.
   */
  async handleChatModelStart(llm, messages, runId, parentRunId, extraParams, tags, metadata, name) {
    const prompts = messages.map(
      (group) => group.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n")
    );
    await this.handleLLMStart(llm, prompts, runId, parentRunId, extraParams, tags, metadata, name);
    const redacted = this.buffer.getRedactedInput(runId);
    if (redacted !== void 0 && Array.isArray(redacted)) {
      for (let i = 0; i < messages.length && i < redacted.length; i++) {
        const group = messages[i];
        const redactedText = typeof redacted[i] === "string" ? redacted[i] : void 0;
        if (redactedText && group) {
          for (let j = group.length - 1; j >= 0; j--) {
            const msg = group[j];
            if (msg && (msg._getType() === "human" || msg._getType() === "generic")) {
              msg.content = redactedText;
              break;
            }
          }
        }
      }
    }
  }
  async handleLLMStart(llm, prompts, runId, parentRunId, _extraParams, _tags, _metadata, name) {
    const llmName = name ?? llm?.id?.at(-1) ?? "LLM";
    this.buffer.registerRun(runId, "llm", llmName, parentRunId);
    this.streamingBuffer.start(runId, extractModelName(llm));
    this.spanCollector.setActiveRun(runId);
    if (!this.config.sendLLMStartEvent) return;
    this._checkPendingStopVerdict(runId);
    if (this.config.hitl.enabled && this.buffer.isPendingApproval(runId)) {
      await this._pollPendingApproval(runId, llmName);
    }
    const rootRunId = this.buffer.getRootRunId(runId);
    const modelName = extractModelName(llm);
    const promptText = extractPromptText(prompts);
    const attempt = this.buffer.getAttempt(runId);
    const event = this._buildEvent("LLMStarted", rootRunId, {
      activity_id: runId,
      activity_type: "agent_validatePrompt",
      activity_input: [{ prompt: promptText }],
      llm_model: modelName,
      prompt: promptText,
      parent_run_id: parentRunId,
      attempt
    });
    const response = await this.client.evaluateEvent(event);
    if (!response) return;
    this._checkGuardrailsInput(response);
    const ctx = eventTypeToContext("LLMStarted");
    const result = enforceVerdict(response, ctx);
    this._storeVerdict(runId, response);
    if (result.requiresHITL) {
      this.buffer.setPendingApproval(runId, true);
      await pollUntilDecision(
        this.client,
        { workflowId: rootRunId, runId: rootRunId, activityId: runId, activityType: llmName },
        this.config.hitl
      );
      this.buffer.setPendingApproval(runId, false);
    }
    if (response.guardrails_result?.input_type === "activity_input") {
      const redacted = applyInputRedaction(prompts, response.guardrails_result);
      this.buffer.setRedactedInput(runId, redacted);
    }
  }
  async handleLLMEnd(output, runId, parentRunId) {
    const buf = this.buffer.getBuffer(runId);
    this.buffer.markCompleted(runId);
    this.spanCollector.clearActiveRun();
    const llmName = buf?.name ?? "LLM";
    if (!this.config.sendLLMEndEvent) return;
    const rootRunId = this.buffer.getRootRunId(runId);
    const endTimeMs = Date.now();
    const durationMs = buf ? endTimeMs - buf.startTime : void 0;
    const startTimeSec = buf ? buf.startTime / 1e3 : void 0;
    const endTimeSec = endTimeMs / 1e3;
    const { inputTokens, outputTokens, totalTokens } = extractTokenUsage(output);
    const streamedText = this.streamingBuffer.getAccumulated(runId);
    const completionText = streamedText || extractCompletionText(output);
    this.streamingBuffer.clear(runId);
    const finishReason = extractFinishReason(output);
    const spans = this.spanCollector.getSpans(runId);
    this.spanCollector.clearSpans(runId);
    const modelName = extractModelName(output) ?? buf?.metadata?.["modelName"];
    const attempt = buf?.attempt ?? 1;
    const redactedInput = this.buffer.getRedactedInput(runId);
    const allSpans = [...spans];
    if (inputTokens != null && outputTokens != null && (inputTokens > 0 || outputTokens > 0)) {
      const isAnthropic = modelName?.toLowerCase().includes("claude");
      const llmApiUrl = isAnthropic ? "https://api.anthropic.com/v1/messages" : "https://api.openai.com/v1/chat/completions";
      const syntheticResponseBody = isAnthropic ? JSON.stringify({
        model: modelName ?? "claude",
        usage: { input_tokens: inputTokens, output_tokens: outputTokens }
      }) : JSON.stringify({
        model: modelName ?? "gpt",
        usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens }
      });
      const syntheticRequestBody = JSON.stringify({ model: modelName ?? "" });
      const durationNs = durationMs != null ? durationMs * 1e6 : void 0;
      allSpans.push({
        span_id: `llm-token-${runId}`,
        name: `LLM ${modelName ?? "completion"} token usage`,
        kind: "client",
        start_time: buf?.startTime ?? endTimeMs,
        end_time: endTimeMs,
        duration_ns: durationNs,
        attributes: {
          "http.method": "POST",
          "http.url": llmApiUrl,
          "http.status_code": 200,
          "llm.model": modelName,
          "llm.synthetic": true
        },
        status: { code: "OK" },
        request_body: syntheticRequestBody,
        response_body: syntheticResponseBody
      });
    }
    const event = this._buildEvent("LLMCompleted", rootRunId, {
      activity_id: runId,
      activity_input: redactedInput != null ? [safeSerialize(redactedInput)] : void 0,
      activity_output: safeSerialize(output),
      status: "completed",
      start_time: startTimeSec,
      end_time: endTimeSec,
      duration_ms: durationMs,
      llm_model: modelName,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      completion: completionText,
      finish_reason: finishReason,
      parent_run_id: parentRunId,
      attempt,
      span_count: allSpans.length,
      spans: allSpans.length > 0 ? allSpans : void 0
    });
    const response = await this.client.evaluateEvent(event);
    if (!response) return;
    this._checkGuardrailsOutput(response);
    const ctx = eventTypeToContext("LLMCompleted");
    const result = enforceVerdict(response, ctx);
    if (result.requiresHITL) {
      this.buffer.setPendingApproval(runId, true);
      await pollUntilDecision(
        this.client,
        { workflowId: rootRunId, runId: rootRunId, activityId: runId, activityType: llmName },
        this.config.hitl
      );
      this.buffer.setPendingApproval(runId, false);
    }
    if (response.guardrails_result?.input_type === "activity_output" && response.guardrails_result.redacted_input != null) {
      const redacted = applyOutputRedaction(output, response.guardrails_result);
      this.buffer.setRedactedOutput(runId, redacted);
    }
    if (this.buffer.isHaltRequested(runId)) {
      const reason = this.buffer.getAbortReason(runId) ?? "Halted by hook governance";
      if (this.abortController) this.abortController.abort();
      throw new GovernanceHaltError(reason);
    }
  }
  async handleLLMError(err, runId, parentRunId) {
    const buf = this.buffer.getBuffer(runId);
    this.buffer.markFailed(runId);
    if (err instanceof GovernanceBlockedError) {
      if (err.verdict === "halt" || err.verdict === "stop") {
        this.buffer.setHaltRequested(runId, err.message);
        if (this.abortController) this.abortController.abort();
      } else {
        this.buffer.setAborted(runId, err.message);
      }
    }
    const rootRunId = this.buffer.getRootRunId(runId);
    const durationMs = buf ? Date.now() - buf.startTime : void 0;
    const attempt = buf?.attempt ?? 1;
    const event = this._buildEvent("LLMFailed", rootRunId, {
      activity_id: runId,
      status: "failed",
      duration_ms: durationMs,
      error: serializeError(err),
      parent_run_id: parentRunId,
      attempt
    });
    await this.client.evaluateEvent(event).catch(() => void 0);
  }
  // ─────────────────────────────────────────────────────────────────
  // Tool Events
  // ─────────────────────────────────────────────────────────────────
  async handleToolStart(tool, input, runId, parentRunId, _tags, _metadata, name) {
    const toolName = name ?? tool?.id?.at(-1) ?? "Tool";
    this.buffer.registerRun(runId, "tool", toolName, parentRunId);
    this.spanCollector.setActiveRun(runId);
    if (!this.config.sendToolStartEvent) return;
    if (this.config.skipToolTypes.has(toolName)) return;
    if (this.config.hitl.skipToolTypes?.has(toolName)) return;
    this._checkPendingStopVerdict(runId);
    if (this.config.hitl.enabled && this.buffer.isPendingApproval(runId)) {
      await this._pollPendingApproval(runId, toolName);
    }
    const rootRunId = this.buffer.getRootRunId(runId);
    const attempt = this.buffer.getAttempt(runId);
    let toolInputForEvent = input;
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        if (keys.length === 1 && keys[0] === "input" && typeof parsed["input"] === "string") {
          toolInputForEvent = JSON.parse(parsed["input"]);
        } else {
          toolInputForEvent = parsed;
        }
      }
    } catch {
    }
    const event = this._buildEvent("ToolStarted", rootRunId, {
      activity_id: runId,
      activity_type: toolName,
      activity_input: [safeSerialize(toolInputForEvent)],
      tool_name: toolName,
      tool_input: safeSerialize(input),
      parent_run_id: parentRunId,
      attempt
    });
    const response = await this.client.evaluateEvent(event);
    if (!response) return;
    this._checkGuardrailsInput(response);
    const ctx = eventTypeToContext("ToolStarted");
    const result = enforceVerdict(response, ctx);
    this._storeVerdict(runId, response);
    if (result.requiresHITL) {
      this.buffer.setPendingApproval(runId, true);
      try {
        await pollUntilDecision(
          this.client,
          { workflowId: rootRunId, runId: rootRunId, activityId: runId, activityType: toolName },
          this.config.hitl
        );
      } catch (pollErr) {
        this.buffer.setPendingApproval(runId, false);
        if (pollErr instanceof ApprovalRejectedError || pollErr instanceof ApprovalExpiredError || pollErr instanceof ApprovalTimeoutError) {
          throw new GovernanceHaltError(
            pollErr.message ?? `Approval rejected for ${toolName}`
          );
        }
        throw pollErr;
      }
      this.buffer.setPendingApproval(runId, false);
    }
    if (response.guardrails_result?.input_type === "activity_input") {
      const redacted = applyInputRedaction(input, response.guardrails_result);
      this.buffer.setRedactedInput(runId, redacted);
    }
  }
  async handleToolEnd(output, runId, parentRunId) {
    const buf = this.buffer.getBuffer(runId);
    this.buffer.markCompleted(runId);
    const toolName = buf?.name ?? "Tool";
    if (!this.config.sendToolEndEvent) return;
    if (this.config.skipToolTypes.has(toolName)) return;
    if (this._toolEndHandledByWrapper.has(runId)) {
      this._toolEndHandledByWrapper.delete(runId);
      if (this.buffer.isHaltRequested(runId)) {
        const reason = this.buffer.getAbortReason(runId) ?? "Halted by hook governance";
        if (this.abortController) this.abortController.abort();
        throw new GovernanceHaltError(reason);
      }
      return;
    }
    await this._evaluateToolCompleted(runId, output, parentRunId);
  }
  /**
   * Send the ToolCompleted governance event and enforce the AGE verdict.
   * Called by handleToolEnd normally, or by wrapTool directly (before returning
   * to LangChain) so that REQUIRE_APPROVAL blocks the tool result.
   */
  async evaluateToolCompleted(runId, output, parentRunId) {
    this._toolEndHandledByWrapper.add(runId);
    await this._evaluateToolCompleted(runId, output, parentRunId);
  }
  async _evaluateToolCompleted(runId, output, parentRunId) {
    const buf = this.buffer.getBuffer(runId);
    const toolName = buf?.name ?? "Tool";
    const rootRunId = this.buffer.getRootRunId(runId);
    const endTimeMs = Date.now();
    const durationMs = buf ? endTimeMs - buf.startTime : void 0;
    const startTimeSec = buf ? buf.startTime / 1e3 : void 0;
    const endTimeSec = endTimeMs / 1e3;
    const attempt = buf?.attempt ?? 1;
    const spans = this.spanCollector.getSpans(runId);
    this.spanCollector.clearSpans(runId);
    const redactedInput = this.buffer.getRedactedInput(runId);
    const completedActivityId = `${runId}-c`;
    const event = this._buildEvent("ToolCompleted", rootRunId, {
      activity_id: completedActivityId,
      activity_type: toolName,
      activity_input: redactedInput != null ? [safeSerialize(redactedInput)] : void 0,
      activity_output: typeof output === "string" ? safeSerialize({ result: output }) : safeSerialize(output),
      tool_name: toolName,
      status: "completed",
      start_time: startTimeSec,
      end_time: endTimeSec,
      duration_ms: durationMs,
      parent_run_id: parentRunId,
      attempt,
      span_count: spans.length,
      spans: spans.length > 0 ? spans : void 0
    });
    const response = await this.client.evaluateEvent(event);
    if (!response) {
      if (this.buffer.isHaltRequested(runId)) {
        const reason = this.buffer.getAbortReason(runId) ?? "Halted by hook governance";
        if (this.abortController) this.abortController.abort();
        throw new GovernanceHaltError(reason);
      }
      return;
    }
    this._checkGuardrailsOutput(response);
    const ctx = eventTypeToContext("ToolCompleted");
    const result = enforceVerdict(response, ctx);
    if (result.requiresHITL) {
      this.buffer.setPendingApproval(runId, true);
      try {
        await pollUntilDecision(
          this.client,
          { workflowId: rootRunId, runId: rootRunId, activityId: completedActivityId, activityType: toolName },
          this.config.hitl
        );
      } catch (pollErr) {
        this.buffer.setPendingApproval(runId, false);
        if (pollErr instanceof ApprovalRejectedError || pollErr instanceof ApprovalExpiredError || pollErr instanceof ApprovalTimeoutError) {
          throw new GovernanceHaltError(pollErr.message);
        }
        throw pollErr;
      }
      this.buffer.setPendingApproval(runId, false);
    }
    if (response.guardrails_result?.input_type === "activity_output" && response.guardrails_result.redacted_input != null) {
      const redacted = applyOutputRedaction(output, response.guardrails_result);
      this.buffer.setRedactedOutput(runId, redacted);
    }
    if (this.buffer.isHaltRequested(runId)) {
      const reason = this.buffer.getAbortReason(runId) ?? "Halted by hook governance";
      if (this.abortController) this.abortController.abort();
      throw new GovernanceHaltError(reason);
    }
  }
  async handleToolError(err, runId, parentRunId) {
    const buf = this.buffer.getBuffer(runId);
    this.buffer.markFailed(runId);
    if (err instanceof GovernanceBlockedError) {
      if (err.verdict === "halt" || err.verdict === "stop") {
        this.buffer.setHaltRequested(runId, err.message);
        if (this.abortController) this.abortController.abort();
      } else {
        this.buffer.setAborted(runId, err.message);
      }
    }
    const rootRunId = this.buffer.getRootRunId(runId);
    const durationMs = buf ? Date.now() - buf.startTime : void 0;
    const attempt = buf?.attempt ?? 1;
    const event = this._buildEvent("ToolFailed", rootRunId, {
      activity_id: runId,
      activity_type: buf?.name ?? "Tool",
      tool_name: buf?.name,
      status: "failed",
      duration_ms: durationMs,
      error: serializeError(err),
      parent_run_id: parentRunId,
      attempt
    });
    await this.client.evaluateEvent(event).catch(() => void 0);
  }
  // ─────────────────────────────────────────────────────────────────
  // Streaming (Phase 3)
  // ─────────────────────────────────────────────────────────────────
  async handleLLMNewToken(token, _idx, runId) {
    this.streamingBuffer.addToken(runId, token);
  }
  // ─────────────────────────────────────────────────────────────────
  // Agent Events — with BLOCK/HALT enforcement (Phase 3)
  // ─────────────────────────────────────────────────────────────────
  async handleAgentAction(action, runId, _parentRunId) {
    if (this.enforceAgentActions) this._checkPendingStopVerdict(runId);
  }
  async handleAgentFinish(_finish, _runId, _parentRunId) {
  }
  // ─────────────────────────────────────────────────────────────────
  // Retriever Events (observability only)
  // ─────────────────────────────────────────────────────────────────
  async handleRetrieverStart(retriever, _query, runId, parentRunId) {
    const retrieverName = retriever?.id?.at(-1) ?? "Retriever";
    this.buffer.registerRun(runId, "retriever", retrieverName, parentRunId);
  }
  async handleRetrieverEnd(_documents, runId, _parentRunId) {
    this.buffer.markCompleted(runId);
  }
  async handleRetrieverError(_err, runId, _parentRunId) {
    this.buffer.markFailed(runId);
  }
  /**
   * Public accessor: returns the guardrails-redacted input for a given runId.
   * Call this from a wrapped tool to retrieve what the governance server redacted
   * before passing to the underlying tool execution.
   *
   * @example
   * ```typescript
   * const redacted = handler.getRedactedInput(runId) ?? originalInput;
   * ```
   */
  getRedactedInput(runId) {
    return this.buffer.getRedactedInput(runId);
  }
  getRedactedOutput(runId) {
    return this.buffer.getRedactedOutput(runId);
  }
  /**
   * Mark that wrapTool has already sent the ToolCompleted AGE evaluation for this runId.
   * handleToolEnd will skip re-evaluation to avoid double-sending.
   */
  markToolEndHandledByWrapper(runId) {
    this._toolEndHandledByWrapper.add(runId);
  }
  // ─────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────
  /**
   * Mirrors Temporal's pre-execution pending verdict check:
   * if a prior event on this run returned BLOCK/HALT, prevent execution.
   */
  _checkPendingStopVerdict(runId) {
    const buf = this.buffer.getBuffer(runId);
    if (!buf?.verdict) return;
    if (verdictShouldStop(buf.verdict)) {
      const reason = buf.verdictReason ?? "Blocked by prior governance verdict";
      if (buf.verdict === "halt" /* HALT */) {
        throw new GovernanceHaltError(reason);
      }
      throw new GovernanceBlockedError(reason);
    }
  }
  /**
   * Mirrors Temporal's pre-execution pending-approval check:
   * if buffer has pendingApproval=true from a previous attempt, poll until resolved.
   */
  async _pollPendingApproval(runId, activityType) {
    const rootRunId = this.buffer.getRootRunId(runId);
    await pollUntilDecision(
      this.client,
      { workflowId: rootRunId, runId: rootRunId, activityId: runId, activityType },
      this.config.hitl
    );
    this.buffer.setPendingApproval(runId, false);
  }
  /**
   * Store the verdict from a pre-execution (Started) event response into the run buffer.
   * Only called for *Started* events — Completed/End events are observability-only
   * and must NOT poison the pending-stop buffer for subsequent runs.
   */
  _storeVerdict(runId, response) {
    if (response.verdict && verdictShouldStop(response.verdict)) {
      this.buffer.setVerdictForRun(runId, response.verdict, response.reason);
    }
  }
  /**
   * Mirrors Temporal: check guardrails input validation_passed=false → throw before execution.
   * Builds short clean reason strings from guardrail type — never dumps raw content.
   */
  _checkGuardrailsInput(response) {
    const gr = response.guardrails_result;
    if (gr && gr.input_type === "activity_input" && !gr.validation_passed) {
      const reasons = _getGuardrailFailureReasons(gr.reasons);
      throw new GuardrailsValidationError(reasons);
    }
  }
  /**
   * Mirrors Temporal: check guardrails output validation_passed=false → throw after execution.
   */
  _checkGuardrailsOutput(response) {
    const gr = response.guardrails_result;
    if (gr && gr.input_type === "activity_output" && !gr.validation_passed) {
      const reasons = _getGuardrailFailureReasons(gr.reasons);
      throw new GuardrailsValidationError(
        reasons.length > 0 ? reasons : ["Guardrails output validation failed"]
      );
    }
  }
  _buildEvent(eventType, rootRunId, extra) {
    const buf = this.buffer.getBuffer(rootRunId);
    return {
      source: "workflow-telemetry",
      event_type: eventType,
      workflow_id: rootRunId,
      run_id: rootRunId,
      workflow_type: buf?.name ?? "LangChainRun",
      task_queue: "langchain",
      timestamp: rfc3339Now(),
      session_id: this.config.sessionId,
      ...extra
    };
  }
  /** Clean up buffer when the root chain finishes */
  _cleanupIfRoot(runId, parentRunId) {
    if (!parentRunId) {
      this.buffer.cleanup(runId);
    }
  }
  // ─────────────────────────────────────────────────────────────────
  // @internal accessors — used by wrappers.ts for hook-level HITL
  // Not part of the public API surface.
  // ─────────────────────────────────────────────────────────────────
  /** @internal */
  _getClient() {
    return this.client;
  }
  /** @internal */
  _getBuffer() {
    return this.buffer;
  }
  /** @internal */
  _getConfig() {
    return this.config;
  }
};
function serializeError(err) {
  if (err instanceof Error) {
    return { type: err.name ?? "Error", message: err.message };
  }
  return { type: "UnknownError", message: String(err) };
}

// src/index.ts
init_client();
init_types();
init_errors();
init_signal_monitor();
init_serializer();

// src/wrappers.ts
init_errors();
function wrapTool(tool, handler) {
  const original = tool._call.bind(tool);
  tool["_call"] = async function(input, runManager) {
    const runId = _extractRunId(runManager);
    const effectiveInput = runId && handler.getRedactedInput(runId) !== void 0 ? handler.getRedactedInput(runId) : input;
    try {
      const toolResult = await original(
        effectiveInput,
        runManager
      );
      if (runId) {
        await handler.evaluateToolCompleted(runId, toolResult);
        const redactedOutput = handler.getRedactedOutput(runId);
        if (redactedOutput !== void 0) {
          return typeof redactedOutput === "string" ? redactedOutput : JSON.stringify(redactedOutput);
        }
      }
      return toolResult;
    } catch (err) {
      if (err instanceof GovernanceBlockedError && err.verdict === "require_approval" && runId) {
        const hitlConfig = _getHITLConfig(handler);
        if (hitlConfig.enabled) {
          const rootRunId = _getRootRunId(handler, runId);
          await pollUntilDecision(
            _getClient(handler),
            {
              workflowId: rootRunId,
              runId: rootRunId,
              activityId: runId,
              activityType: tool.name
            },
            hitlConfig
          );
          _clearAbort(handler, runId);
          return await original(
            effectiveInput,
            runManager
          );
        }
      }
      throw err;
    }
  };
  return tool;
}
function wrapTools(tools, handler) {
  return tools.map((t) => wrapTool(t, handler));
}
function wrapLLM(llm, handler) {
  const originalGenerate = llm["generate"];
  if (typeof originalGenerate === "function") {
    llm["generate"] = async function(inputs, options, callbacks) {
      const runId = _extractRunIdFromOptions(options);
      if (runId) {
        const redacted = handler.getRedactedInput(runId);
        if (redacted !== void 0 && Array.isArray(redacted)) {
          return originalGenerate.call(this, redacted, options, callbacks);
        }
      }
      return originalGenerate.call(this, inputs, options, callbacks);
    };
  }
  return llm;
}
function _extractRunId(runManager) {
  if (!runManager || typeof runManager !== "object") return void 0;
  const rm = runManager;
  if (typeof rm["runId"] === "string") return rm["runId"];
  if (typeof rm["run_id"] === "string") return rm["run_id"];
  return void 0;
}
function _extractRunIdFromOptions(options) {
  if (!options || typeof options !== "object") return void 0;
  const opts = options;
  if (typeof opts["runId"] === "string") return opts["runId"];
  if (typeof opts["run_id"] === "string") return opts["run_id"];
  const callbacks = opts["callbacks"];
  if (callbacks && typeof callbacks === "object") {
    const cbs = callbacks;
    if (typeof cbs["runId"] === "string") return cbs["runId"];
  }
  return void 0;
}
function _getHITLConfig(handler) {
  return handler._getConfig().hitl;
}
function _getClient(handler) {
  return handler._getClient();
}
function _getRootRunId(handler, runId) {
  return handler._getBuffer().getRootRunId(runId);
}
function _clearAbort(handler, runId) {
  const buf = handler._getBuffer().getBuffer(runId);
  if (buf) {
    buf.aborted = false;
    buf.abortReason = void 0;
    buf.haltRequested = false;
    buf.haltReason = void 0;
  }
}

// src/index.ts
init_hook_governance();
init_config();
async function createOpenBoxHandler(options) {
  await initialize({
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
    governanceTimeout: options.governanceTimeout,
    validate: options.validate ?? true
  });
  const {
    apiUrl: _u,
    apiKey: _k,
    governanceTimeout: _t,
    validate: _v,
    enableSignalMonitor,
    signalMonitorConfig,
    ...handlerOptions
  } = options;
  void _u;
  void _k;
  void _t;
  void _v;
  if (enableSignalMonitor) {
    const { OpenBoxSignalMonitor: SignalMonitor } = await Promise.resolve().then(() => (init_signal_monitor(), signal_monitor_exports));
    const { GovernanceClient: GClient } = await Promise.resolve().then(() => (init_client(), client_exports));
    const { globalConfig: globalConfig2 } = await Promise.resolve().then(() => (init_config(), config_exports));
    const gc = globalConfig2.get();
    const client = new GClient({
      apiUrl: gc.apiUrl,
      apiKey: gc.apiKey,
      timeout: gc.governanceTimeout,
      onApiError: handlerOptions.onApiError ?? "fail_open"
    });
    const monitor = new SignalMonitor(client, signalMonitorConfig);
    const controller = new AbortController();
    handlerOptions.signalMonitor = monitor;
    handlerOptions.abortController = controller;
  }
  return new OpenBoxCallbackHandler(handlerOptions);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ApprovalExpiredError,
  ApprovalRejectedError,
  ApprovalTimeoutError,
  DEFAULT_HITL_CONFIG,
  GovernanceBlockedError,
  GovernanceClient,
  GovernanceHaltError,
  GuardrailsValidationError,
  OpenBoxAuthError,
  OpenBoxCallbackHandler,
  OpenBoxError,
  OpenBoxInsecureURLError,
  OpenBoxNetworkError,
  OpenBoxSignalMonitor,
  RunBufferManager,
  SpanCollector,
  StreamingTokenBuffer,
  Verdict,
  applyInputRedaction,
  applyOutputRedaction,
  configureHookGovernance,
  createOpenBoxHandler,
  enforceVerdict,
  evaluateHttpHook,
  eventTypeToContext,
  extractCompletionText,
  extractFinishReason,
  extractModelName,
  extractPromptText,
  extractTokenUsage,
  getGlobalConfig,
  getGuardrailsReasons,
  globalSpanCollector,
  globalStreamingBuffer,
  highestPriorityVerdict,
  initialize,
  isFetchPatched,
  isHITLApplicable,
  isHookGovernanceConfigured,
  mergeConfig,
  parseApprovalResponse,
  parseGovernanceResponse,
  patchFetch,
  pollUntilDecision,
  resetHookGovernance,
  rfc3339Now,
  safeSerialize,
  setupTelemetry,
  unpatchFetch,
  verdictFromString,
  verdictPriority,
  verdictRequiresApproval,
  verdictShouldStop,
  wrapLLM,
  wrapTool,
  wrapTools
});
