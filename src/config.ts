/**
 * OpenBox LangChain SDK — Configuration & Initialization
 */

import {
  OpenBoxAuthError,
  OpenBoxInsecureURLError,
  OpenBoxNetworkError,
} from "./errors.js";
import { DEFAULT_HITL_CONFIG, HITLConfig } from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// API Key validation
// ═══════════════════════════════════════════════════════════════════

const API_KEY_PATTERN = /^obx_(live|test)_[a-zA-Z0-9_]+$/;

export function validateApiKeyFormat(apiKey: string): boolean {
  return API_KEY_PATTERN.test(apiKey);
}

export function validateUrlSecurity(apiUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new OpenBoxInsecureURLError(`Invalid URL: ${apiUrl}`);
  }

  const isLocalhost =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1";

  if (parsed.protocol === "http:" && !isLocalhost) {
    throw new OpenBoxInsecureURLError(
      `Insecure HTTP URL detected: ${apiUrl}. ` +
        "Use HTTPS for non-localhost URLs to protect API keys in transit."
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// GovernanceConfig
// ═══════════════════════════════════════════════════════════════════

export interface GovernanceConfig {
  onApiError: "fail_open" | "fail_closed";
  apiTimeout: number;
  sendChainStartEvent: boolean;
  sendChainEndEvent: boolean;
  sendToolStartEvent: boolean;
  sendToolEndEvent: boolean;
  sendLLMStartEvent: boolean;
  sendLLMEndEvent: boolean;
  skipChainTypes: Set<string>;
  skipToolTypes: Set<string>;
  hitl: HITLConfig;
  sessionId?: string;
}

export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = {
  onApiError: "fail_open",
  apiTimeout: 30_000,
  sendChainStartEvent: true,
  sendChainEndEvent: true,
  sendToolStartEvent: true,
  sendToolEndEvent: true,
  sendLLMStartEvent: true,
  sendLLMEndEvent: true,
  skipChainTypes: new Set(),
  skipToolTypes: new Set(),
  hitl: { ...DEFAULT_HITL_CONFIG },
};

export type PartialGovernanceConfig = Partial<
  Omit<GovernanceConfig, "skipChainTypes" | "skipToolTypes" | "hitl">
> & {
  skipChainTypes?: Set<string> | string[];
  skipToolTypes?: Set<string> | string[];
  hitl?: Partial<HITLConfig>;
};

export function mergeConfig(partial: PartialGovernanceConfig): GovernanceConfig {
  return {
    ...DEFAULT_GOVERNANCE_CONFIG,
    ...partial,
    skipChainTypes: partial.skipChainTypes
      ? new Set(partial.skipChainTypes)
      : new Set(),
    skipToolTypes: partial.skipToolTypes
      ? new Set(partial.skipToolTypes)
      : new Set(),
    hitl: {
      ...DEFAULT_HITL_CONFIG,
      ...(partial.hitl ?? {}),
      skipToolTypes: partial.hitl?.skipToolTypes
        ? new Set(partial.hitl.skipToolTypes)
        : new Set(),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Global Config Singleton
// ═══════════════════════════════════════════════════════════════════

interface GlobalConfig {
  apiUrl: string;
  apiKey: string;
  governanceTimeout: number;
}

class _GlobalConfig {
  private _apiUrl = "";
  private _apiKey = "";
  private _governanceTimeout = 30_000;

  configure(apiUrl: string, apiKey: string, governanceTimeout = 30_000): void {
    this._apiUrl = apiUrl.replace(/\/$/, "");
    this._apiKey = apiKey;
    this._governanceTimeout = governanceTimeout;
  }

  isConfigured(): boolean {
    return Boolean(this._apiUrl && this._apiKey);
  }

  get(): GlobalConfig {
    return {
      apiUrl: this._apiUrl,
      apiKey: this._apiKey,
      governanceTimeout: this._governanceTimeout,
    };
  }
}

export const globalConfig = new _GlobalConfig();

export function getGlobalConfig(): GlobalConfig {
  return globalConfig.get();
}

// ═══════════════════════════════════════════════════════════════════
// Server-side API key validation
// ═══════════════════════════════════════════════════════════════════

async function validateApiKeyWithServer(
  apiUrl: string,
  apiKey: string,
  timeout: number
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${apiUrl}/api/v1/auth/validate`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "OpenBox-LangChain-SDK/0.1.0",
      },
      signal: controller.signal,
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

// ═══════════════════════════════════════════════════════════════════
// initialize()
// ═══════════════════════════════════════════════════════════════════

export interface InitializeOptions {
  apiUrl: string;
  apiKey: string;
  governanceTimeout?: number;
  validate?: boolean;
}

export async function initialize(options: InitializeOptions): Promise<void> {
  const { apiUrl, apiKey, governanceTimeout = 30_000, validate = true } = options;

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
