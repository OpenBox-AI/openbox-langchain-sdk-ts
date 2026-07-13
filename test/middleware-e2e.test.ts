import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { tool } from "langchain";
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

  it("correlates a governed tool's sync fs (mkdir/write/read) to the tool activity and drains it on close()", async () => {
    // Real base instrumentation is installed for THIS test so the sync fs
    // wrapper actually patches node:fs; every other e2e test opts out. The
    // process-global install is freed by `await openbox.close()` in `finally`.
    const scratch = mkdtempSync(path.join(os.tmpdir(), "openbox-lc-e2e-"));
    let toolReturn: string | undefined;
    let bundleClose: (() => Promise<void>) | undefined;
    try {
      const fsTool = tool(
        () => {
          const dir = path.join(scratch, "reports");
          mkdirSync(dir, { recursive: true });
          const file = path.join(dir, "out.txt");
          writeFileSync(file, "hello-from-sync-fs");
          toolReturn = readFileSync(file, "utf8");
          return toolReturn;
        },
        { name: "fs_tool", description: "does sync fs work", schema: z.object({}) }
      );
      const model = new FakeChatModel({ script: [aiToolCall("fs_tool", {}), aiFinal("done")] });
      const { agent, evaluates, openbox } = await buildGovernedAgent({
        model,
        tools: [fsTool],
        mwOptions: { installInstrumentation: true }
      });
      bundleClose = () => openbox.close();

      const result = await agent.invoke(humanTurn("go"));

      // Drain BEFORE asserting: the sync fs wrapper returns before its
      // completed-hook promise settles, so close() -> flush() is what makes the
      // spans durable/observable here.
      await openbox.close();

      expect(toolReturn).toBe("hello-from-sync-fs"); // tool body returned the real content
      expect(result.messages[result.messages.length - 1]?.content).toBe("done");

      const fileSpans = evaluates
        .flatMap((e) => (e.body.spans as Array<Record<string, unknown>> | undefined) ?? [])
        .filter((s) => s && s["hook_type"] === "file_operation" && s["stage"] === "completed");
      const names = fileSpans.map((s) => s["name"]);
      expect(names).toContain("file.read"); // readFileSync
      expect(names).toContain("file.write"); // writeFileSync + mkdirSync (both classified write, D6)
      expect(fileSpans.length).toBeGreaterThanOrEqual(3); // mkdir + write + read

      // Every file hook fired inside the fs_tool activity — correlated, not orphaned.
      const fileEvalBodies = evaluates.filter((e) =>
        ((e.body.spans as Array<Record<string, unknown>> | undefined) ?? []).some(
          (s) => s["hook_type"] === "file_operation"
        )
      );
      expect(fileEvalBodies.length).toBeGreaterThan(0);
      for (const e of fileEvalBodies) {
        expect(e.body.activity_type).toBe("fs_tool");
      }
    } finally {
      await bundleClose?.(); // idempotent; also frees the process-global install if an assert threw
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
