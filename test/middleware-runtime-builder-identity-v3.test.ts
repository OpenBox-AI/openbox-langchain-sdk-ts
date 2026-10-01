/**
 * IAM v3 (keycloak_workload) and Okta bootstrap forwarding through
 * `buildMiddlewareRuntime` / `createOpenBoxLangChainMiddleware`: the options and
 * the OPENBOX_LANGCHAIN_* → OPENBOX_* environment layering reach the base SDK's
 * shared `OpenBoxClient.fromConfig` intact, with LangChain branding, and an
 * injected runtime always wins without a second client.
 */
import { workflowStarted } from "@openbox-ai/openbox-sdk-ts";
import { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import { OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenBoxLangChainMiddleware } from "../src/middleware/index.js";
import { buildMiddlewareRuntime } from "../src/middleware/runtime-builder.js";
import {
  WORKLOAD_API_KEY,
  WORKLOAD_API_URL,
  WorkloadCoreFake,
  generateWorkloadPem,
  json
} from "./workload-core-fake.js";

const PEM = generateWorkloadPem();
const OTHER_PEM = generateWorkloadPem();
const BRANDING = /^openbox-langchain-typescript-v\d/;
const WF = { workflowId: "wf-1", runId: "run-1", workflowType: "LangChainRun" };

afterEach(() => {
  vi.unstubAllEnvs();
});

function expectWorkloadTraffic(core: WorkloadCoreFake): void {
  expect(core.bootstrapCalls).toHaveLength(1);
  expect(core.tokenCalls).toHaveLength(1);
  expect(core.legacyCalls).toHaveLength(0);
  for (const call of core.governedCalls) {
    expect(call.path.startsWith("/api/v3/")).toBe(true);
    expect(call.headers["x-openbox-workload-token"]).toBe("lc-access-token-1");
    expect(call.headers["x-openbox-sdk-version"]).toMatch(BRANDING);
    expect(call.headers["x-openbox-agent-assertion"]).toBeUndefined();
    expect(call.headers["x-openbox-agent-signature"]).toBeUndefined();
  }
}

describe("buildMiddlewareRuntime — keycloak_workload forwarding", () => {
  it("forwards explicit options to a v3 client with LangChain branding", async () => {
    const core = new WorkloadCoreFake();
    const runtime = buildMiddlewareRuntime({
      apiUrl: WORKLOAD_API_URL,
      apiKey: WORKLOAD_API_KEY,
      identityMethod: "keycloak_workload",
      workloadPrivateKey: PEM,
      fetchImpl: core.fetchImpl
    });
    await runtime.evaluateLifecycle(workflowStarted(WF));
    expectWorkloadTraffic(core);
    expect(runtime.client.workloadIdentityMetadata()?.identitySource).toBe("okta");
    runtime.close();
  });

  it("resolves the key from OPENBOX_LANGCHAIN_WORKLOAD_PRIVATE_KEY", async () => {
    vi.stubEnv("OPENBOX_LANGCHAIN_API_URL", WORKLOAD_API_URL);
    vi.stubEnv("OPENBOX_LANGCHAIN_API_KEY", WORKLOAD_API_KEY);
    vi.stubEnv("OPENBOX_LANGCHAIN_WORKLOAD_PRIVATE_KEY", PEM);
    const core = new WorkloadCoreFake();
    const runtime = buildMiddlewareRuntime({ fetchImpl: core.fetchImpl });
    expect(runtime.config.resolvedIdentityMethod()).toBe("keycloak_workload");
    expect(runtime.config.resolvedWorkloadPrivateKey()).toBe(PEM);
    await runtime.evaluateLifecycle(workflowStarted(WF));
    expectWorkloadTraffic(core);
    runtime.close();
  });

  it("prefers the prefixed variable over OPENBOX_WORKLOAD_PRIVATE_KEY, and explicit over both", () => {
    vi.stubEnv("OPENBOX_WORKLOAD_PRIVATE_KEY", OTHER_PEM);
    vi.stubEnv("OPENBOX_LANGCHAIN_WORKLOAD_PRIVATE_KEY", PEM);
    const base = { apiUrl: WORKLOAD_API_URL, apiKey: WORKLOAD_API_KEY, fetchImpl: new WorkloadCoreFake().fetchImpl };
    expect(buildMiddlewareRuntime(base).config.resolvedWorkloadPrivateKey()).toBe(PEM);
    vi.unstubAllEnvs();
    vi.stubEnv("OPENBOX_WORKLOAD_PRIVATE_KEY", OTHER_PEM);
    expect(buildMiddlewareRuntime(base).config.resolvedWorkloadPrivateKey()).toBe(OTHER_PEM);
    expect(
      buildMiddlewareRuntime({ ...base, workloadPrivateKey: PEM }).config.resolvedWorkloadPrivateKey()
    ).toBe(PEM);
  });

  it("accepts the Okta key as the workload-key alias only under explicit keycloak_workload", async () => {
    const core = new WorkloadCoreFake();
    const runtime = buildMiddlewareRuntime({
      apiUrl: WORKLOAD_API_URL,
      apiKey: WORKLOAD_API_KEY,
      identityMethod: "keycloak_workload",
      oktaAgentPrivateKey: PEM,
      fetchImpl: core.fetchImpl
    });
    await runtime.evaluateLifecycle(workflowStarted(WF));
    expectWorkloadTraffic(core);
  });

  it("rejects conflicting identity configuration before any request", () => {
    const fetchImpl = vi.fn();
    expect(() =>
      buildMiddlewareRuntime({
        apiUrl: WORKLOAD_API_URL,
        apiKey: WORKLOAD_API_KEY,
        workloadPrivateKey: PEM,
        oktaAgentPrivateKey: OTHER_PEM,
        fetchImpl: fetchImpl
      })
    ).toThrow(/workloadPrivateKey/);
    expect(() =>
      buildMiddlewareRuntime({
        apiUrl: WORKLOAD_API_URL,
        apiKey: WORKLOAD_API_KEY,
        identityMethod: "keycloak_workload",
        fetchImpl: fetchImpl
      })
    ).toThrow(/no workload private key/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails on a missing key when the method is explicit instead of running unsigned", () => {
    expect(() =>
      buildMiddlewareRuntime({
        apiUrl: WORKLOAD_API_URL,
        apiKey: WORKLOAD_API_KEY,
        identityMethod: "keycloak_workload",
        fetchImpl: new WorkloadCoreFake().fetchImpl
      })
    ).toThrow(/no workload private key/);
  });
});

describe("buildMiddlewareRuntime — Okta key-only bootstrap forwarding", () => {
  it("forwards a key-only okta_ai_agent configuration as v2 bootstrap mode (never unsigned v1)", async () => {
    const calls: string[] = [];
    const fetchImpl = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(new URL(url).pathname);
      // Core answers bootstrap with a 404 (predates bootstrap) — enough to prove
      // the client asked for v2 metadata instead of sending an unsigned request.
      return Promise.resolve(json(404, { code: 404 }));
    }) as typeof fetch;
    const runtime = buildMiddlewareRuntime({
      apiUrl: WORKLOAD_API_URL,
      apiKey: WORKLOAD_API_KEY,
      oktaAgentPrivateKey: PEM,
      fetchImpl
    });
    expect(runtime.config.oktaBootstrapPrivateKey()).toBe(PEM);
    await expect(runtime.evaluateLifecycle(workflowStarted(WF))).rejects.toThrow(/does not support Okta identity bootstrap/);
    expect(calls).toEqual(["/api/v2/auth/bootstrap"]);
  });
});

describe("createOpenBoxLangChainMiddleware — injected runtime precedence", () => {
  it("uses the injected runtime's client and ignores separate middleware credentials", async () => {
    const injectedCore = new WorkloadCoreFake();
    const config = OpenBoxConfig.resolve({
      environ: {},
      apiUrl: WORKLOAD_API_URL,
      apiKey: WORKLOAD_API_KEY,
      workloadPrivateKey: PEM
    });
    const runtime = new OpenBoxRuntime(config, {
      client: OpenBoxClient.fromConfig(config, { fetchImpl: injectedCore.fetchImpl })
    });
    const ignoredFetch = vi.fn();
    const openbox = await createOpenBoxLangChainMiddleware({
      runtime,
      installInstrumentation: false,
      identityMethod: "keycloak_workload",
      workloadPrivateKey: OTHER_PEM,
      apiKey: "obx_test_ignored_key",
      fetchImpl: ignoredFetch
    });

    expect(openbox.runtime).toBe(runtime);
    expect(ignoredFetch).not.toHaveBeenCalled();
    // Startup validation ran on the injected client, over v3.
    expect(injectedCore.governedCalls.map((c) => c.path)).toEqual(["/api/v3/auth/validate"]);
    expect(injectedCore.governedCalls[0]!.headers["authorization"]).toBe(`Bearer ${WORKLOAD_API_KEY}`);

    await openbox.close();
    await expect(runtime.client.validateApiKey()).rejects.toThrow(/has been closed/);
  });

  it("validates at startup through the workload client and fails fast on acquisition errors", async () => {
    const core = new WorkloadCoreFake();
    core.bootstrap = () => json(409, { code: 409, reason_code: "workload_identity_unavailable" });
    await expect(
      createOpenBoxLangChainMiddleware({
        apiUrl: WORKLOAD_API_URL,
        apiKey: WORKLOAD_API_KEY,
        workloadPrivateKey: PEM,
        installInstrumentation: false,
        fetchImpl: core.fetchImpl
      })
    ).rejects.toThrow(/no usable active workload authority/);
    expect(core.legacyCalls).toHaveLength(0);
    expect(core.governedCalls).toHaveLength(0);
  });
});
