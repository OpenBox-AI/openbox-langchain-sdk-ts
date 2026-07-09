import { tool } from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk/runtime";
import {
  aiFinal,
  aiToolCall,
  buildGovernedAgent,
  FakeChatModel,
  humanTurn,
  makeEchoTool,
  type CapturedEvaluate
} from "./fakes.js";

const seq = (evaluates: CapturedEvaluate[]): string[] =>
  evaluates.map((e) => String(e.body.event_type));

describe("middleware end-to-end (fakes only, no network)", () => {
  it("runs a tool-calling agent under ALLOW with the full ordered event sequence", async () => {
    const model = new FakeChatModel({ script: [aiToolCall("echo", { text: "hi" }), aiFinal("done")] });
    const { agent, evaluates, adapter } = await buildGovernedAgent({
      model,
      tools: [makeEchoTool()]
    });

    const result = await agent.invoke(humanTurn("hello"));

    // WorkflowStarted -> SignalReceived -> pre-screen(llm) -> model1 completion ->
    // tool start/complete -> model2 start/complete -> WorkflowCompleted.
    expect(seq(evaluates)).toEqual([
      "WorkflowStarted",
      "SignalReceived",
      "ActivityStarted", // pre-screen (llm_call, -pre)
      "ActivityCompleted", // model call 1 (reused pre-screen)
      "ActivityStarted", // tool start
      "ActivityCompleted", // tool complete
      "ActivityStarted", // model call 2
      "ActivityCompleted", // model call 2 complete
      "WorkflowCompleted"
    ]);
    expect(adapter.calls).toHaveLength(0);
    const last = result.messages[result.messages.length - 1];
    expect(last?.content).toBe("done");
  });

  it("correlates an async operation inside a governed TOOL to the tool activity", async () => {
    const ref: { runtime?: OpenBoxRuntime } = {};
    let observed: { type: string | null; id: string | null } | null = null;
    const httpTool = tool(
      async () => {
        // Simulate provider/HTTP work that awaits — the activity context must
        // survive the await so base instrumentation tags spans with this tool.
        await new Promise((resolve) => setTimeout(resolve, 2));
        const ctx = ref.runtime?.contextStore.currentActivityContext();
        observed = { type: ctx?.activityType ?? null, id: ctx?.activityId ?? null };
        return "ok";
      },
      { name: "fetcher", description: "does async work", schema: z.object({}) }
    );
    const model = new FakeChatModel({ script: [aiToolCall("fetcher", {}), aiFinal("done")] });
    const h = await buildGovernedAgent({ model, tools: [httpTool] });
    ref.runtime = h.runtime;

    await h.agent.invoke(humanTurn("go"));
    expect(observed).not.toBeNull();
    expect(observed!.type).toBe("fetcher");
    expect(observed!.id).toBeTruthy();
  });

  it("correlates an async operation inside the MODEL provider call to the LLM activity", async () => {
    const ref: { runtime?: OpenBoxRuntime } = {};
    let observed: string | null = null;
    const model = new FakeChatModel({
      script: [aiFinal("done")],
      onGenerate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        observed = ref.runtime?.contextStore.currentActivityContext()?.activityType ?? null;
      }
    });
    const h = await buildGovernedAgent({ model });
    ref.runtime = h.runtime;

    await h.agent.invoke(humanTurn("hello"));
    // ALS reached the model provider call (the primary correlation path).
    expect(observed).toBe("llm_call");
  });

  it("rejects the invoke and closes the workflow when a tool is blocked", async () => {
    const model = new FakeChatModel({ script: [aiToolCall("echo", { text: "x" }), aiFinal("done")] });
    let toolRan = false;
    const { agent, evaluates } = await buildGovernedAgent({
      model,
      tools: [makeEchoTool(() => (toolRan = true))],
      route: (body) =>
        body.event_type === "ActivityStarted" && body.activity_type === "echo"
          ? { verdict: "block", reason: "tool denied" }
          : { verdict: "allow" }
    });

    await expect(agent.invoke(humanTurn("go"))).rejects.toThrow();
    expect(toolRan).toBe(false);
    // workflowFailed telemetry precedes the rejection.
    expect(seq(evaluates)).toContain("WorkflowFailed");
    expect(seq(evaluates)).not.toContain("WorkflowCompleted");
  });
});
