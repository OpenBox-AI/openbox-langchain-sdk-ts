import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateApiKeyFormat,
  validateUrlSecurity,
  mergeConfig,
  globalConfig,
  initialize,
  DEFAULT_GOVERNANCE_CONFIG,
} from "../src/config.js";
import { OpenBoxAuthError, OpenBoxInsecureURLError, OpenBoxNetworkError } from "../src/errors.js";

describe("validateApiKeyFormat", () => {
  it("accepts valid live key", () => {
    expect(validateApiKeyFormat("obx_live_abc123")).toBe(true);
  });

  it("accepts valid test key", () => {
    expect(validateApiKeyFormat("obx_test_mykey_01")).toBe(true);
  });

  it("accepts keys with underscores in suffix", () => {
    expect(validateApiKeyFormat("obx_test_my_api_key_123")).toBe(true);
  });

  it("rejects missing prefix", () => {
    expect(validateApiKeyFormat("abc123")).toBe(false);
  });

  it("rejects wrong prefix", () => {
    expect(validateApiKeyFormat("sk-abc123")).toBe(false);
    expect(validateApiKeyFormat("obx_prod_abc123")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateApiKeyFormat("")).toBe(false);
  });
});

describe("validateUrlSecurity", () => {
  it("allows HTTPS for any host", () => {
    expect(() => validateUrlSecurity("https://api.openbox.ai")).not.toThrow();
    expect(() => validateUrlSecurity("https://remote.host:8080")).not.toThrow();
  });

  it("allows HTTP for localhost", () => {
    expect(() => validateUrlSecurity("http://localhost:8086")).not.toThrow();
    expect(() => validateUrlSecurity("http://127.0.0.1:8086")).not.toThrow();
  });

  it("rejects HTTP for non-localhost", () => {
    expect(() => validateUrlSecurity("http://api.openbox.ai")).toThrow(OpenBoxInsecureURLError);
    expect(() => validateUrlSecurity("http://192.168.1.1:8086")).toThrow(OpenBoxInsecureURLError);
  });

  it("rejects invalid URL", () => {
    expect(() => validateUrlSecurity("not-a-url")).toThrow(OpenBoxInsecureURLError);
  });
});

describe("mergeConfig", () => {
  it("uses defaults when no options provided", () => {
    const config = mergeConfig({});
    expect(config.onApiError).toBe("fail_open");
    expect(config.apiTimeout).toBe(30_000);
    expect(config.sendChainStartEvent).toBe(true);
    expect(config.hitl.enabled).toBe(true);
    expect(config.hitl.pollIntervalMs).toBe(5_000);
  });

  it("overrides specific fields", () => {
    const config = mergeConfig({ onApiError: "fail_closed", apiTimeout: 10_000 });
    expect(config.onApiError).toBe("fail_closed");
    expect(config.apiTimeout).toBe(10_000);
    expect(config.sendChainStartEvent).toBe(true); // default preserved
  });

  it("converts skipChainTypes array to Set", () => {
    const config = mergeConfig({ skipChainTypes: ["InternalChain", "DebugChain"] });
    expect(config.skipChainTypes instanceof Set).toBe(true);
    expect(config.skipChainTypes.has("InternalChain")).toBe(true);
  });

  it("merges hitl config", () => {
    const config = mergeConfig({ hitl: { pollIntervalMs: 3_000, maxWaitMs: 60_000 } });
    expect(config.hitl.pollIntervalMs).toBe(3_000);
    expect(config.hitl.maxWaitMs).toBe(60_000);
    expect(config.hitl.enabled).toBe(true); // default preserved
  });
});

describe("initialize", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws OpenBoxInsecureURLError for HTTP on non-localhost", async () => {
    await expect(
      initialize({ apiUrl: "http://remote.host", apiKey: "obx_test_key1" })
    ).rejects.toThrow(OpenBoxInsecureURLError);
  });

  it("throws OpenBoxAuthError for invalid key format", async () => {
    await expect(
      initialize({ apiUrl: "http://localhost:8086", apiKey: "bad-key" })
    ).rejects.toThrow(OpenBoxAuthError);
  });

  it("throws OpenBoxAuthError when server returns 401", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401 });
    await expect(
      initialize({ apiUrl: "http://localhost:8086", apiKey: "obx_test_key1" })
    ).rejects.toThrow(OpenBoxAuthError);
  });

  it("throws OpenBoxNetworkError when server returns 500", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500 });
    await expect(
      initialize({ apiUrl: "http://localhost:8086", apiKey: "obx_test_key1" })
    ).rejects.toThrow(OpenBoxNetworkError);
  });

  it("succeeds and configures global config on 200", async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await initialize({ apiUrl: "http://localhost:8086", apiKey: "obx_test_key1" });
    const gc = globalConfig.get();
    expect(gc.apiUrl).toBe("http://localhost:8086");
    expect(gc.apiKey).toBe("obx_test_key1");
  });

  it("skips server validation when validate=false", async () => {
    await initialize({
      apiUrl: "http://localhost:8086",
      apiKey: "obx_test_key1",
      validate: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const gc = globalConfig.get();
    expect(gc.apiKey).toBe("obx_test_key1");
  });

  it("strips trailing slash from apiUrl", async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await initialize({ apiUrl: "http://localhost:8086/", apiKey: "obx_test_key1" });
    expect(globalConfig.get().apiUrl).toBe("http://localhost:8086");
  });
});
