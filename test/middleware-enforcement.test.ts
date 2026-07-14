import { tool } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";
import {
  aiFinal,
  aiToolCall,
  buildGovernedAgent,
  FakeChatModel,
  humanTurn,
  makeEchoTool,
  type CapturedEvaluate
} from "./fakes.js";

const eventTypes = (evaluates: CapturedEvaluate[]): string[] =>
  evaluates.map((e) => String(e.body.event_type));
const has = (evaluates: CapturedEvaluate[], eventType: string): boolean =>
  eventTypes(evaluates).includes(eventType);
const isPreScreen = (body: Record<string, unknown>): boolean =>
  body.event_type === "ActivityStarted" && String(body.activity_id).endsWith("-pre");

describe("middleware enforcement (e2e)", () => {
  it("emits WorkflowStarted -> SignalReceived -> pre-screen ... -> WorkflowCompleted and never enforces on ALLOW", async () => {
    const model = new FakeChatModel({ script: [aiToolCall("echo", { text: "hi" }), aiFinal("done")] });
    const { agent, evaluates, adapter } = await buildGovernedAgent({
      model,
      tools: [makeEchoTool()]
    });

    await agent.invoke(humanTurn("hello"));

    const types = eventTypes(evaluates);
    expect(types[0]).toBe("WorkflowStarted");
    expect(types[1]).toBe("SignalReceived");
    expect(isPreScreen(evaluates[2]!.body)).toBe(true);
    expect(types[types.length - 1]).toBe("WorkflowCompleted");
    // No adapter delegation anywhere on a fully-allowed run.
    expect(adapter.calls).toHaveLength(0);
    // Header identity branding.
    expect(evaluates[0]?.headers["x-openbox-sdk-version"]).toBe(
      "openbox-langchain-typescript-v1.0.1"
    );
  });

  it("blocks on a SignalReceived verdict, closes the workflow, and never calls the model", async () => {
    const model = new FakeChatModel({ script: [aiFinal("should not run")] });
    const { agent, evaluates, adapter } = await buildGovernedAgent({
      model,
      route: (body) =>
        body.event_type === "SignalReceived"
          ? { verdict: "block", reason: "signal denied" }
          : { verdict: "allow" }
    });

    await expect(agent.invoke(humanTurn("bad"))).rejects.toThrow();
    expect(model.callCount).toBe(0);
    expect(has(evaluates, "WorkflowFailed")).toBe(true); // closure telemetry before the throw
    expect(has(evaluates, "WorkflowCompleted")).toBe(false);
    expect(adapter.calls.some((c) => c.kind === "raiseLifecycleBlocked")).toBe(true);
  });

  it("blocks at the pre-screen so the first model call never runs", async () => {
    const model = new FakeChatModel({ script: [aiFinal("should not run")] });
    const { agent, evaluates } = await buildGovernedAgent({
      model,
      route: (body) =>
        isPreScreen(body) ? { verdict: "block", reason: "pre denied" } : { verdict: "allow" }
    });

    await expect(agent.invoke(humanTurn("screen me"))).rejects.toThrow();
    expect(model.callCount).toBe(0);
    expect(has(evaluates, "WorkflowFailed")).toBe(true);
  });

  it("a rejected approval closes the workflow with structured ApprovalRejectedError telemetry", async () => {
    const model = new FakeChatModel({ script: [aiFinal("should not run")] });
    const { agent, evaluates, adapter } = await buildGovernedAgent({
      model,
      route: (body) =>
        isPreScreen(body) ? { verdict: "require_approval" } : { verdict: "allow" },
      adapterOptions: { approvalOutcome: "reject" }
    });

    await expect(agent.invoke(humanTurn("needs approval"))).rejects.toThrow();
    expect(model.callCount).toBe(0);
    expect(adapter.calls.some((c) => c.kind === "handleApproval")).toBe(true);

    const failed = evaluates.find((e) => e.body.event_type === "WorkflowFailed");
    expect(failed).toBeDefined();
    const error = failed?.body.error as Record<string, unknown>;
    expect(error).toMatchObject({ type: "ApprovalRejectedError", message: "rejected by FakeAdapter" });
    expect(typeof error.stack_trace).toBe("string");
    expect(typeof failed?.body.error).not.toBe("string");
  });

  it("blocks a tool start: the tool body never runs and the orphan row is closed failed", async () => {
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

    await expect(agent.invoke(humanTurn("use tool"))).rejects.toThrow();
    expect(toolRan).toBe(false);
    // Orphan started row closed with a failed same-id completion.
    const toolCompletions = evaluates.filter(
      (e) => e.body.event_type === "ActivityCompleted" && e.body.activity_type === "echo"
    );
    expect(toolCompletions.length).toBeGreaterThanOrEqual(1);
    expect(toolCompletions[0]?.body.error).toMatchObject({
      type: "GovernanceBlockedError",
      message: "Governance block: tool denied"
    });
    expect(has(evaluates, "WorkflowFailed")).toBe(true);
    const failed = evaluates.find((e) => e.body.event_type === "WorkflowFailed");
    expect(failed?.body.error).toMatchObject({ type: "GovernanceBlockedError" });
    // NOTHING on the wire carries a top-level string error.
    for (const e of evaluates) {
      if (e.body.error !== undefined) expect(typeof e.body.error).not.toBe("string");
    }
  });

  it("blocks a fresh (non-first) model call before its handler", async () => {
    // model1 reuses the pre-screen (runs), tool runs, model2 is fresh and blocked.
    const model = new FakeChatModel({ script: [aiToolCall("echo", { text: "x" }), aiFinal("done")] });
    const { agent } = await buildGovernedAgent({
      model,
      tools: [makeEchoTool()],
      route: (body) =>
        body.event_type === "ActivityStarted" &&
        body.activity_type === "llm_call" &&
        !String(body.activity_id).endsWith("-pre")
          ? { verdict: "block", reason: "model denied" }
          : { verdict: "allow" }
    });

    await expect(agent.invoke(humanTurn("go"))).rejects.toThrow();
    // model1 ran; model2 was blocked before its handler.
    expect(model.callCount).toBe(1);
  });

  it("reuses the pre-screen approval for the first model call (polls once, not twice)", async () => {
    const model = new FakeChatModel({ script: [aiFinal("done")] });
    const { agent, adapter } = await buildGovernedAgent({
      model,
      adapterOptions: { approvalOutcome: "allow" },
      route: (body) =>
        isPreScreen(body)
          ? { verdict: "require_approval", approval_id: "appr-1" }
          : { verdict: "allow" }
    });

    await agent.invoke(humanTurn("please"));
    const approvals = adapter.calls.filter((c) => c.kind === "handleApproval");
    expect(approvals).toHaveLength(1);
    expect(model.callCount).toBe(1);
  });

  it("splices the redacted user message into the first model call's request", async () => {
    let seenPrompt: string | null = null;
    const model = new FakeChatModel({
      script: [aiFinal("done")],
      onGenerate: (messages) => {
        const human = messages.find((m) => m.getType() === "human");
        seenPrompt = typeof human?.content === "string" ? human.content : null;
      }
    });
    await (
      await buildGovernedAgent({
        model,
        route: (body) =>
          isPreScreen(body)
            ? { verdict: "allow", guardrails: { redacted_input: "my ssn is [REDACTED]" } }
            : { verdict: "allow" }
      })
    ).agent.invoke(humanTurn("my ssn is 111-22-3333"));

    expect(seenPrompt).toBe("my ssn is [REDACTED]");
  });

  it("runs the tool body inside a bound activity scope", async () => {
    let boundActivityType: string | null = null;
    const ref: { runtime?: OpenBoxRuntime } = {};
    const scopeTool = tool(
      () => {
        boundActivityType =
          ref.runtime?.contextStore.currentActivityContext()?.activityType ?? null;
        return "ok";
      },
      { name: "scoped", description: "reads scope", schema: z.object({}) }
    );
    const model = new FakeChatModel({ script: [aiToolCall("scoped", {}), aiFinal("done")] });
    const harness = await buildGovernedAgent({ model, tools: [scopeTool] });
    ref.runtime = harness.runtime;

    await harness.agent.invoke(humanTurn("run"));
    expect(boundActivityType).toBe("scoped");
  });

  it("still governs an empty or multimodal human turn (does not silently skip)", async () => {
    // Empty string content.
    const emptyModel = new FakeChatModel({ script: [aiFinal("ok")] });
    const empty = await buildGovernedAgent({ model: emptyModel });
    await empty.agent.invoke({ messages: [new HumanMessage("")] });
    expect(has(empty.evaluates, "SignalReceived")).toBe(true);
    expect(empty.evaluates.some((e) => isPreScreen(e.body))).toBe(true);

    // Multimodal content (no plain string).
    const mmModel = new FakeChatModel({ script: [aiFinal("ok")] });
    const mm = await buildGovernedAgent({ model: mmModel });
    await mm.agent.invoke({
      messages: [
        new HumanMessage({
          content: [
            { type: "text", text: "" },
            { type: "image_url", image_url: { url: "http://x" } }
          ]
        })
      ]
    });
    expect(has(mm.evaluates, "SignalReceived")).toBe(true);
    expect(mm.evaluates.some((e) => isPreScreen(e.body))).toBe(true);
  });
});
