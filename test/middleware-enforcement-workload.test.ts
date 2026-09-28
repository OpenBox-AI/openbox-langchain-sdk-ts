/**
 * LangChain enforcement over IAM v3 (keycloak_workload), end to end through
 * `createOpenBoxLangChainMiddleware` + `createAgent` with deterministic model
 * and tool stubs against a Core v3 + Keycloak double:
 * - ALLOW executes once; BLOCK/HALT execute zero times; approval holds the
 *   handler until approved; authentication/preparation failures execute zero times;
 * - startup, lifecycle, model/tool gates, HTTP hooks, approval, callbacks and
 *   completion telemetry share ONE correctly branded client and token cache;
 * - best-effort telemetry failures never reset identity mode or open a gate;
 * - credentials never enter LangChain state.
 */
import type { Serialized } from "@langchain/core/load/serializable";
import { createAgent, tool } from "langchain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ActivityBridge } from "../src/activity-bridge.js";
import { OpenBoxLangChainCoreCallbackHandler } from "../src/core-callback.js";
import {
  createOpenBoxLangChainMiddleware,
  type OpenBoxLangChainMiddlewareBundle,
  type OpenBoxLangChainMiddlewareOptions
} from "../src/middleware/index.js";
import { FakeChatModel, aiFinal, aiToolCall, humanTurn, makeEchoTool } from "./fakes.js";
import {
  WORKLOAD_API_KEY,
  WORKLOAD_API_URL,
  WorkloadCoreFake,
  generateWorkloadPem,
  json,
  type WorkloadCall
} from "./workload-core-fake.js";

const PEM = generateWorkloadPem();
const BRANDING = /^openbox-langchain-typescript-v\d/;

const bundles: OpenBoxLangChainMiddlewareBundle[] = [];
let realFetch: typeof fetch | undefined;

afterEach(async () => {
  while (bundles.length > 0) await bundles.pop()?.close();
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = undefined;
  vi.restoreAllMocks();
});

const isToolStart = (body: Record<string, unknown>, name = "echo"): boolean =>
  body.event_type === "ActivityStarted" && body.activity_type === name;
const isPreScreen = (body: Record<string, unknown>): boolean =>
  body.event_type === "ActivityStarted" && String(body.activity_id).endsWith("-pre");

async function governedAgent(
  core: WorkloadCoreFake,
  model: FakeChatModel,
  tools: Parameters<typeof createAgent>[0]["tools"] = [],
  extra: Partial<OpenBoxLangChainMiddlewareOptions> = {}
) {
  const openbox = await createOpenBoxLangChainMiddleware({
    apiUrl: WORKLOAD_API_URL,
    apiKey: WORKLOAD_API_KEY,
    identityMethod: "keycloak_workload",
    workloadPrivateKey: PEM,
    fetchImpl: core.fetchImpl,
    installInstrumentation: false,
    approvalPollIntervalMs: 1,
    agentName: "workload-agent",
    ...extra
  });
  bundles.push(openbox);
  const agent = createAgent({ model, tools: tools ?? [], middleware: [openbox.middleware] });
  return { openbox, agent };
}

function expectOneBrandedClient(core: WorkloadCoreFake, token = "lc-access-token-1"): void {
  expect(core.legacyCalls).toHaveLength(0);
  expect(core.governedCalls.length).toBeGreaterThan(0);
  for (const call of core.governedCalls) {
    expect(call.headers["x-openbox-workload-token"]).toBe(token);
    expect(call.headers["authorization"]).toBe(`Bearer ${WORKLOAD_API_KEY}`);
    expect(call.headers["x-openbox-sdk-version"]).toMatch(BRANDING);
  }
}

const eventTypes = (calls: WorkloadCall[]): string[] => calls.map((c) => String(c.body.event_type));

describe("ALLOW / BLOCK / HALT over v3", () => {
  it("ALLOW runs model and tool exactly once over one branded client and one token", async () => {
    const core = new WorkloadCoreFake();
    const model = new FakeChatModel({ script: [aiToolCall("echo", { text: "hi" }), aiFinal("done")] });
    let toolRuns = 0;
    const { agent } = await governedAgent(core, model, [makeEchoTool(() => (toolRuns += 1))]);

    await agent.invoke(humanTurn("hello"));

    expect(model.callCount).toBe(2);
    expect(toolRuns).toBe(1);
    expect(core.bootstrapCalls).toHaveLength(1);
    expect(core.tokenCalls).toHaveLength(1);
    // Startup validation plus every lifecycle gate and completion shared it.
    expect(core.governedCalls[0]!.path).toBe("/api/v3/auth/validate");
    const types = eventTypes(core.evaluateCalls);
    expect(types[0]).toBe("WorkflowStarted");
    expect(types).toContain("SignalReceived");
    expect(types[types.length - 1]).toBe("WorkflowCompleted");
    expectOneBrandedClient(core);
  });

  it("BLOCK on the tool start executes the tool zero times", async () => {
    const core = new WorkloadCoreFake();
    core.evaluate = (call) =>
      json(200, isToolStart(call.body) ? { verdict: "block", reason: "tool denied" } : { verdict: "allow" });
    const model = new FakeChatModel({ script: [aiToolCall("echo", { text: "x" }), aiFinal("done")] });
    let toolRuns = 0;
    const { agent } = await governedAgent(core, model, [makeEchoTool(() => (toolRuns += 1))]);

    await expect(agent.invoke(humanTurn("use tool"))).rejects.toThrow(/tool denied/);
    expect(toolRuns).toBe(0);
    expectOneBrandedClient(core);
  });

  it("HALT on the user signal executes the model zero times", async () => {
    const core = new WorkloadCoreFake();
    core.evaluate = (call) =>
      json(200, call.body.event_type === "SignalReceived" ? { verdict: "halt", reason: "stop" } : { verdict: "allow" });
    const model = new FakeChatModel({ script: [aiFinal("never")] });
    const { agent } = await governedAgent(core, model);

    await expect(agent.invoke(humanTurn("go"))).rejects.toThrow();
    expect(model.callCount).toBe(0);
    expectOneBrandedClient(core);
  });
});

describe("approval over v3", () => {
  it("keeps the model blocked until approval, then runs it once", async () => {
    const core = new WorkloadCoreFake();
    core.evaluate = (call) => json(200, isPreScreen(call.body) ? { verdict: "require_approval" } : { verdict: "allow" });
    const decisions = [{ action: "require_approval" }, { action: "require_approval" }, { action: "allow" }];
    core.approval = () => json(200, decisions.shift() ?? { action: "allow" });
    let pollsBeforeModel = -1;
    const model = new FakeChatModel({
      script: [aiFinal("approved answer")],
      onGenerate: () => {
        pollsBeforeModel = core.calls.filter((c) => c.path === "/api/v3/governance/approval").length;
      }
    });
    const { agent } = await governedAgent(core, model);

    await agent.invoke(humanTurn("needs approval"));
    expect(pollsBeforeModel).toBe(3);
    expect(model.callCount).toBe(1);
    expectOneBrandedClient(core);
  });

  it("a rejected approval executes the model zero times", async () => {
    const core = new WorkloadCoreFake();
    core.evaluate = (call) => json(200, isPreScreen(call.body) ? { verdict: "require_approval" } : { verdict: "allow" });
    core.approval = () => json(200, { action: "block", reason: "denied by reviewer" });
    const model = new FakeChatModel({ script: [aiFinal("never")] });
    const { agent } = await governedAgent(core, model);

    await expect(agent.invoke(humanTurn("needs approval"))).rejects.toThrow();
    expect(model.callCount).toBe(0);
  });

  it("an approval authentication failure never releases the handler", async () => {
    const core = new WorkloadCoreFake();
    core.evaluate = (call) => json(200, isPreScreen(call.body) ? { verdict: "require_approval" } : { verdict: "allow" });
    core.approval = () => json(401, { code: 401 });
    const model = new FakeChatModel({ script: [aiFinal("never")] });
    const { agent } = await governedAgent(core, model);

    await expect(agent.invoke(humanTurn("needs approval"))).rejects.toThrow();
    expect(model.callCount).toBe(0);
    expect(core.legacyCalls).toHaveLength(0);
  });
});

describe("authentication and preparation failures stop protected execution", () => {
  const acquisitionFailures: Array<[string, (core: WorkloadCoreFake) => void]> = [
    ["bootstrap outage", (core) => (core.bootstrap = () => json(503, {}))],
    [
      "no active workload authority",
      (core) => (core.bootstrap = () => json(409, { code: 409, reason_code: "workload_identity_unavailable" }))
    ],
    ["Keycloak rejecting the key", (core) => (core.token = () => json(401, { error: "invalid_client" }))],
    ["token endpoint unreachable", (core) => (core.token = () => Promise.reject(new TypeError("fetch failed")))]
  ];

  it.each(acquisitionFailures)("%s at startup: middleware creation fails, even under fail_open", async (_label, arrange) => {
    const core = new WorkloadCoreFake();
    arrange(core);
    const model = new FakeChatModel({ script: [aiFinal("never")] });

    await expect(governedAgent(core, model, [], { onApiError: "fail_open" })).rejects.toThrow();
    expect(model.callCount).toBe(0);
    expect(core.legacyCalls).toHaveLength(0);
    expect(core.evaluateCalls).toHaveLength(0);
  });

  it.each(acquisitionFailures)("%s after startup: the model executes zero times, even under fail_open", async (_label, arrange) => {
    const core = new WorkloadCoreFake();
    const model = new FakeChatModel({ script: [aiFinal("never")] });
    const { agent, openbox } = await governedAgent(core, model, [], { onApiError: "fail_open" });
    arrange(core);
    // Drop the startup token so the next governed call must re-acquire against the failing authority.
    await openbox.runtime.client.refreshWorkloadIdentity().catch(() => undefined);
    const authCallsBefore = core.bootstrapCalls.length + core.tokenCalls.length;

    await expect(agent.invoke(humanTurn("hello"))).rejects.toThrow();
    // The gate itself tried to re-acquire, and failed, before the model could run.
    expect(core.bootstrapCalls.length + core.tokenCalls.length).toBeGreaterThan(authCallsBefore);
    expect(model.callCount).toBe(0);
    expect(core.legacyCalls).toHaveLength(0);
    expect(core.evaluateCalls).toHaveLength(0);
  });

  it("a runtime 401 at the tool gate executes the tool zero times and is not replayed", async () => {
    const core = new WorkloadCoreFake();
    core.evaluate = (call) => (isToolStart(call.body) ? json(401, { code: 401 }) : json(200, { verdict: "allow" }));
    const model = new FakeChatModel({ script: [aiToolCall("echo", { text: "x" }), aiFinal("done")] });
    let toolRuns = 0;
    const { agent } = await governedAgent(core, model, [makeEchoTool(() => (toolRuns += 1))]);

    await expect(agent.invoke(humanTurn("use tool"))).rejects.toThrow(/workload-authenticated evaluate/);
    expect(toolRuns).toBe(0);
    expect(core.evaluateCalls.filter((c) => isToolStart(c.body))).toHaveLength(1);
    expect(core.legacyCalls).toHaveLength(0);
  });
});

describe("best-effort telemetry never resets identity or opens a gate", () => {
  it("a rejected telemetry send is suppressed, and the next enforcing gate re-acquires on v3", async () => {
    const core = new WorkloadCoreFake();
    let first = true;
    core.evaluate = (call) => {
      if (call.body.event_type === "WorkflowStarted" && first) {
        first = false;
        return json(401, { code: 401 });
      }
      return json(200, { verdict: "allow" });
    };
    const warn = vi.fn();
    const model = new FakeChatModel({ script: [aiFinal("ok")] });
    const { agent } = await governedAgent(core, model, [], { logger: { warn } });

    await agent.invoke(humanTurn("hello"));

    expect(model.callCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/telemetry evaluate failed \(send suppressed\)/));
    const logged = warn.mock.calls.flat().join("\n");
    expect(logged).not.toContain("lc-access-token");
    expect(logged).not.toContain(WORKLOAD_API_KEY);
    // The 401 discarded token 1; the next gate bootstrapped again — still v3.
    expect(core.bootstrapCalls).toHaveLength(2);
    expect(core.legacyCalls).toHaveLength(0);
    const signal = core.evaluateCalls.find((c) => c.body.event_type === "SignalReceived")!;
    expect(signal.headers["x-openbox-workload-token"]).toBe("lc-access-token-2");
  });

  it("a telemetry failure cannot make a failing enforcing gate succeed", async () => {
    const core = new WorkloadCoreFake();
    core.evaluate = () => json(401, { code: 401 });
    const model = new FakeChatModel({ script: [aiFinal("never")] });
    const { agent } = await governedAgent(core, model, [], { logger: { warn: vi.fn() } });

    await expect(agent.invoke(humanTurn("hello"))).rejects.toThrow();
    expect(model.callCount).toBe(0);
  });
});

describe("one shared client across every surface", () => {
  it("governs the tool's HTTP hook with the same workload token", async () => {
    const core = new WorkloadCoreFake();
    const external: string[] = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      external.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }));
    });
    const httpTool = tool(
      async () => {
        const response = await fetch("https://inventory.example/items");
        return response.text();
      },
      { name: "inventory", description: "reads inventory", schema: z.object({}) }
    );
    const model = new FakeChatModel({ script: [aiToolCall("inventory", {}), aiFinal("done")] });
    const { agent } = await governedAgent(core, model, [httpTool], { installInstrumentation: true });

    await agent.invoke(humanTurn("check stock"));

    expect(external).toEqual(["https://inventory.example/items"]);
    const hookCalls = core.evaluateCalls.filter((c) => Array.isArray(c.body.spans));
    expect(hookCalls.length).toBeGreaterThanOrEqual(1);
    expect(hookCalls.every((c) => JSON.stringify(c.body.spans).includes("https://inventory.example/items"))).toBe(true);
    expect(core.bootstrapCalls).toHaveLength(1);
    expectOneBrandedClient(core);
  });

  it("the observability callback sends through the same runtime client and token cache", async () => {
    const core = new WorkloadCoreFake();
    const { openbox } = await governedAgent(core, new FakeChatModel({ script: [aiFinal("ok")] }));
    const handler = new OpenBoxLangChainCoreCallbackHandler({
      runtime: openbox.runtime,
      bridge: new ActivityBridge(),
      workflowId: "wf-callback",
      runId: "run-callback",
      workflowType: "LangChainRun",
      taskQueue: "langchain"
    });
    const serial = { lc: 1, type: "not_implemented", id: ["echo"], name: "echo" } as unknown as Serialized;

    await handler.handleToolStart(serial, "payload", "tool-1");

    expect(core.evaluateCalls.some((c) => c.body.workflow_id === "wf-callback")).toBe(true);
    expect(core.bootstrapCalls).toHaveLength(1);
    expectOneBrandedClient(core);
  });

  it("keeps credentials and client objects out of LangChain state", async () => {
    const core = new WorkloadCoreFake();
    const model = new FakeChatModel({ script: [aiToolCall("echo", { text: "hi" }), aiFinal("done")] });
    const { agent } = await governedAgent(core, model, [makeEchoTool()]);

    const state = await agent.invoke(humanTurn("hello"));
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain("lc-access-token");
    expect(serialized).not.toContain(WORKLOAD_API_KEY);
    expect(serialized).not.toContain("contractVersion");
  });
});
