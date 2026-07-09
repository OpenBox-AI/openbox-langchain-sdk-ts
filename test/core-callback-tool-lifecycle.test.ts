import type { Serialized } from "@langchain/core/load/serializable";
import { describe, expect, it } from "vitest";

import { ActivityBridge } from "../src/activity-bridge.js";
import { OpenBoxLangChainCoreCallbackHandler } from "../src/core-callback.js";
import type { OpenBoxLangChainCoreCallbackOptions } from "../src/core-callback-options.js";
import { makeFakeCoreRuntime, type FakeRuntimeBundle } from "./fakes.js";

const serial = (name: string): Serialized =>
  ({ lc: 1, type: "not_implemented", id: [name], name }) as unknown as Serialized;

interface Harness extends FakeRuntimeBundle {
  bridge: ActivityBridge;
  handler: OpenBoxLangChainCoreCallbackHandler;
  registered: string[];
  unregistered: string[];
}

function harness(
  configureCore?: (core: FakeRuntimeBundle["core"]) => void,
  extraOptions: Partial<OpenBoxLangChainCoreCallbackOptions> = {}
): Harness {
  const bundle = makeFakeCoreRuntime(configureCore);
  const bridge = new ActivityBridge();
  const registered: string[] = [];
  const unregistered: string[] = [];
  const handler = new OpenBoxLangChainCoreCallbackHandler({
    runtime: bundle.runtime,
    bridge,
    workflowId: "wf-1",
    runId: "run-1",
    workflowType: "LangChainRun",
    taskQueue: "langchain",
    registerTrace: (id) => registered.push(id),
    unregisterTrace: (id) => unregistered.push(id),
    ...extraOptions
  });
  return { ...bundle, bridge, handler, registered, unregistered };
}

describe("core callback — tool lifecycle (observability-only)", () => {
  it("emits ActivityStarted telemetry and registers a trace on tool start", async () => {
    const h = harness();
    await h.handler.handleToolStart(serial("echo"), "hello", "tool-1");

    expect(h.core.lifecycleRequests).toHaveLength(1);
    const body = h.core.lifecycleRequests[0]?.bodyJson as Record<string, unknown>;
    expect(body.activity_id).toBe("tool-1");
    expect(h.bridge.isCallbackOwned("wf-1", "tool-1", "tool_start")).toBe(true);
    expect(h.registered).toHaveLength(1);
    // NEVER enforces.
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("records a BLOCK verdict as a failed same-id completion WITHOUT throwing", async () => {
    const h = harness((c) => c.queueEvaluate({ body: { verdict: "block", reason: "denied" } }));

    await expect(
      h.handler.handleToolStart(serial("danger"), "payload", "tool-1")
    ).resolves.toBeUndefined();

    // start + failed completion, both same id, no -c suffix.
    expect(h.core.lifecycleRequests.length).toBe(2);
    const completed = h.core.lifecycleRequests[1]?.bodyJson as Record<string, unknown>;
    expect(completed.activity_id).toBe("tool-1");
    expect(completed.error).toBeTruthy();
    expect(JSON.stringify(completed)).not.toContain("-c");
    // Verdict stashed; enforcement never happened.
    expect(h.bridge.get("wf-1", "tool-1")?.startResult?.verdict).toBe("block");
    expect(h.bridge.isCallbackOwned("wf-1", "tool-1", "tool_complete")).toBe(true);
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("sends exactly one completion (same id) and unregisters the trace", async () => {
    const h = harness();
    await h.handler.handleToolStart(serial("echo"), "hi", "tool-1");
    await h.handler.handleToolEnd("result-text", "tool-1");
    // Duplicate/cross-dispatched end must not double-send.
    await h.handler.handleToolEnd("result-text", "tool-1");

    const completions = h.core.lifecycleRequests.filter(
      (r) => (r.bodyJson as Record<string, unknown>).activity_id === "tool-1" && !isStart(r.bodyJson)
    );
    expect(completions).toHaveLength(1);
    // The trace registered on start is the one unregistered on completion.
    expect(h.unregistered).toEqual([h.registered[0]]);
  });

  it("does not double-send on tool error after tool end", async () => {
    const h = harness();
    await h.handler.handleToolStart(serial("echo"), "hi", "tool-1");
    await h.handler.handleToolEnd("ok", "tool-1");
    const before = h.core.lifecycleRequests.length;
    await h.handler.handleToolError(new Error("late"), "tool-1");
    expect(h.core.lifecycleRequests.length).toBe(before);
  });

  it("suppresses record-less sends when recordLessOk is false", async () => {
    const h = harness(undefined, { recordLessOk: false });
    // No prepared record for this id → completion must not send.
    await h.handler.handleToolEnd("x", "orphan-1");
    expect(h.core.lifecycleRequests).toHaveLength(0);
  });
});

function isStart(bodyJson: unknown): boolean {
  const body = bodyJson as Record<string, unknown>;
  return body.error === undefined && body.result === undefined && body.activity_input !== undefined;
}
