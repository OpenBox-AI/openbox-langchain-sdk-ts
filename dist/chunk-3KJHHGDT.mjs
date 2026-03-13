import {
  DEFAULT_HITL_CONFIG
} from "./chunk-2LY2CEP6.mjs";
import {
  OpenBoxAuthError,
  OpenBoxInsecureURLError,
  OpenBoxNetworkError
} from "./chunk-AF6ADJEG.mjs";

// src/config.ts
var API_KEY_PATTERN = /^obx_(live|test)_[a-zA-Z0-9_]+$/;
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
var DEFAULT_GOVERNANCE_CONFIG = {
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
var _GlobalConfig = class {
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
var globalConfig = new _GlobalConfig();
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

export {
  validateApiKeyFormat,
  validateUrlSecurity,
  DEFAULT_GOVERNANCE_CONFIG,
  mergeConfig,
  globalConfig,
  getGlobalConfig,
  initialize
};
