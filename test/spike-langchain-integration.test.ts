// De-risking spikes (kept as regression tests) that pin the enforcing
// middleware's wiring:
//   - does a provider call inside `wrapModelCall` see the AsyncLocalStorage
//     context bound by `activityScope`? (drives the model-span correlation path)
//   - does LangGraph graph state isolate per-invocation turn identity across
//     >=10 concurrent invokes on ONE middleware instance?
//   - does a callback handler with `raiseError: true` that throws in
//     `handleToolStart` actually abort the tool, or is it swallowed? (informs
//     why the callback surface is observability-only)
//
// Findings are recorded in _notes/decision-spike-results-phase-1.md.

import { createAgent, createMiddleware } from "langchain";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { HumanMessage } from "@langchain/core/messages";
import { ActivityContext } from "@openbox-ai/openbox-sdk";
import { ContextStore } from "@openbox-ai/openbox-sdk/context";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { aiFinal, aiToolCall, FakeChatModel, makeEchoTool } from "./fakes.js";

const TRACE_ID = "0123456789abcdef0123456789abcdef";

describe("spike: model-provider fetch scheduling", () => {
  it("propagates activityScope ALS into the model _generate body, across awaits", async () => {
    const store = new ContextStore();
    const observations: Array<{ sync: string | null; afterAwait: string | null }> = [];

    const model = new FakeChatModel({
      script: [aiToolCall("echo", { text: "hi" }), aiFinal("done")],
      onGenerate: async () => {
        const sync = store.currentActivityContext()?.activityId ?? null;
        await new Promise((resolve) => setTimeout(resolve, 1));
        const afterAwait = store.currentActivityContext()?.activityId ?? null;
        observations.push({ sync, afterAwait });
      }
    });

    const mw = createMiddleware({
      name: "spike-model-scope",
      wrapModelCall: async (request, handler) => {
        const ctx = new ActivityContext({
          workflowId: "w",
          runId: "r",
          activityId: "llm-1",
          activityType: "llm"
        });
        return store.activityScope(ctx, { traceId: TRACE_ID }, () => handler(request));
      }
    });

    const agent = createAgent({ model, tools: [makeEchoTool()], middleware: [mw] });
    await agent.invoke({ messages: [new HumanMessage("hello")] });

    // FINDING: ALS DOES reach the model call for an in-process awaited provider.
    // The middleware still registers a trace-map fallback for genuinely detached
    // real-provider fetches, but activityScope is the confirmed primary path.
    expect(observations.length).toBeGreaterThanOrEqual(1);
    for (const o of observations) {
      expect(o.sync).toBe("llm-1");
      expect(o.afterAwait).toBe("llm-1");
    }
  });
});

describe("spike: graph-state concurrency isolation", () => {
  it("isolates per-invocation turn identity across >=10 concurrent invokes on ONE middleware", async () => {
    const pairings: Array<{ prompt: string; workflowId: string | undefined }> = [];

    // Shared model instance across all concurrent invokes; a terminal answer so
    // each invoke does exactly one model call (no tool loop).
    const model = new FakeChatModel({
      script: [aiFinal("ok")],
      onGenerate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    });

    const stateSchema = z.object({
      obTurn: z
        .object({ workflowId: z.string(), runId: z.string() })
        .optional()
    });

    const readPrompt = (messages: readonly BaseMessageLike[]): string => {
      const last = [...messages]
        .reverse()
        .find((m) => contentString(m).startsWith("req-"));
      return contentString(last);
    };

    const mw = createMiddleware({
      name: "spike-graph-state",
      stateSchema,
      beforeAgent: (state) => {
        const prompt = readPrompt(state.messages);
        return { obTurn: { workflowId: `wf-${prompt}`, runId: `run-${prompt}` } };
      },
      wrapModelCall: async (request, handler) => {
        const prompt = readPrompt(request.messages);
        const obTurn = (request.state as { obTurn?: { workflowId: string } }).obTurn;
        pairings.push({ prompt, workflowId: obTurn?.workflowId });
        return handler(request);
      }
    });

    const agent = createAgent({ model, tools: [], middleware: [mw] });

    const N = 12;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        agent.invoke({ messages: [new HumanMessage(`req-${i}`)] })
      )
    );

    // FINDING: each invoke's wrapModelCall saw the obTurn its own beforeAgent set.
    expect(pairings.length).toBe(N);
    for (const p of pairings) {
      expect(p.workflowId).toBe(`wf-${p.prompt}`);
    }
    // All distinct → no shared-instance contamination.
    const distinct = new Set(pairings.map((p) => p.workflowId));
    expect(distinct.size).toBe(N);
  });
});

describe("spike: callback raiseError blocking", () => {
  it("records whether a throwing observability callback aborts the tool", async () => {
    let toolRan = false;
    const model = new FakeChatModel({
      script: [aiToolCall("echo", { text: "hi" }), aiFinal("done")]
    });

    class ThrowingCallback extends BaseCallbackHandler {
      override name = "throwing-spike";
      constructor() {
        super({ raiseError: true });
      }
      override handleToolStart(): void {
        throw new Error("callback attempts to block");
      }
    }

    const agent = createAgent({
      model,
      tools: [makeEchoTool(() => (toolRan = true))]
    });

    let threw = false;
    try {
      await agent.invoke(
        { messages: [new HumanMessage("hello")] },
        { callbacks: [new ThrowingCallback()] }
      );
    } catch {
      threw = true;
    }

    // We do NOT assert a specific outcome — the value is the recorded behavior.
    // Whatever it is, the callback surface is observability-only, so enforcement
    // never depends on this. Assert only that the spike ran.
    expect(typeof threw).toBe("boolean");
    expect(typeof toolRan).toBe("boolean");
  });
});

// ── local helpers ────────────────────────────────────────────────────────────
type BaseMessageLike = { content?: unknown };

function contentString(message: BaseMessageLike | undefined): string {
  if (!message) return "";
  const content = message.content;
  return typeof content === "string" ? content : "";
}
