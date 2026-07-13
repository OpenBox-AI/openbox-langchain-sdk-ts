import { HumanMessage } from "@langchain/core/messages";
import type { Serialized } from "@langchain/core/load/serializable";
import { EvaluationResult } from "@openbox-ai/openbox-sdk-ts";
import { describe, expect, it } from "vitest";

import { ActivityBridge } from "../src/activity-bridge.js";
import { OpenBoxLangChainCoreCallbackHandler } from "../src/core-callback.js";
import type { OpenBoxLangChainCoreCallbackOptions } from "../src/core-callback-options.js";
import { makeFakeCoreRuntime } from "./fakes.js";

const serial = (name: string): Serialized =>
  ({ lc: 1, type: "not_implemented", id: [name], name }) as unknown as Serialized;

const messages = () => [[new HumanMessage("hello world")]];

function harness(
  configureCore?: Parameters<typeof makeFakeCoreRuntime>[0],
  extraOptions: Partial<OpenBoxLangChainCoreCallbackOptions> = {}
) {
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
    registerTrace: (id) => registered.push(id),
    unregisterTrace: (id) => unregistered.push(id),
    ...extraOptions
  });
  return { ...bundle, bridge, handler, registered, unregistered };
}

describe("core callback — LLM lifecycle (observability-only)", () => {
  it("emits a same-id ActivityStarted then ActivityCompleted and never enforces", async () => {
    const h = harness();
    await h.handler.handleChatModelStart(serial("chat"), messages(), "llm-1");
    await h.handler.handleLLMEnd(
      { generations: [], llmOutput: {} },
      "llm-1"
    );

    expect(h.core.lifecycleRequests).toHaveLength(2);
    const start = h.core.lifecycleRequests[0]?.bodyJson as Record<string, unknown>;
    const end = h.core.lifecycleRequests[1]?.bodyJson as Record<string, unknown>;
    expect(start.activity_id).toBe("llm-1");
    expect(end.activity_id).toBe("llm-1");
    expect(JSON.stringify(end)).not.toContain("-c");
    expect(h.registered).toHaveLength(1);
    expect(h.unregistered).toEqual([h.registered[0]]);
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("reuses a pre-screen verdict for the first call with no duplicate start send", async () => {
    const preScreenResponse = EvaluationResult.fromDict({ verdict: "allow" });
    const h = harness(undefined, {
      preScreenResponse,
      preScreenActivityId: "run-1-pre"
    });

    await h.handler.handleChatModelStart(serial("chat"), messages(), "llm-1");
    // No start send — the verdict was reused, not re-evaluated.
    expect(h.core.lifecycleRequests).toHaveLength(0);
    // The callback run id now aliases to the pre-screen activity id.
    expect(h.bridge.resolveActivityId("wf-1", "llm-1")).toBe("run-1-pre");
    expect(h.bridge.isCallbackOwned("wf-1", "run-1-pre", "llm_start")).toBe(true);

    await h.handler.handleLLMEnd({ generations: [] }, "llm-1");
    const end = h.core.lifecycleRequests[0]?.bodyJson as Record<string, unknown>;
    expect(end.activity_id).toBe("run-1-pre");
    expect(JSON.stringify(end)).not.toContain("-c");
  });

  it("returns without throwing when the completion send fails", async () => {
    const h = harness((c) =>
      c.queueEvaluate(
        { body: { verdict: "allow" } }, // start
        { status: 401, body: { error: "unauthorized" } } // completion fails
      )
    );
    await h.handler.handleChatModelStart(serial("chat"), messages(), "llm-1");
    await expect(
      h.handler.handleLLMEnd({ generations: [] }, "llm-1")
    ).resolves.toBeUndefined();
    // Completion attempted (marked sent) even though the send failed.
    expect(h.bridge.isCallbackOwned("wf-1", "llm-1", "llm_complete")).toBe(true);
  });

  it("does not double-send on LLM error after LLM end", async () => {
    const h = harness();
    await h.handler.handleChatModelStart(serial("chat"), messages(), "llm-1");
    await h.handler.handleLLMEnd({ generations: [] }, "llm-1");
    const before = h.core.lifecycleRequests.length;
    await h.handler.handleLLMError(new Error("late"), "llm-1");
    expect(h.core.lifecycleRequests.length).toBe(before);
  });

  it("a model failure sends structured ErrorInfo — never a string", async () => {
    const h = harness();
    await h.handler.handleChatModelStart(serial("chat"), messages(), "llm-1");
    const thrown = new Error("provider 500");
    await h.handler.handleLLMError(thrown, "llm-1");

    const completed = h.core.lifecycleRequests.at(-1)?.bodyJson as Record<string, unknown>;
    expect(completed.error).toStrictEqual({
      type: "Error",
      message: "provider 500",
      stack_trace: thrown.stack
    });
    expect(typeof completed.error).not.toBe("string");
  });
});
