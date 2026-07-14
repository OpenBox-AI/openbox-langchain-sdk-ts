import { describe, expect, it } from "vitest";

import { aiFinal, buildGovernedAgent, FakeChatModel, humanTurn } from "./fakes.js";

describe("middleware concurrency isolation", () => {
  it("keeps per-invocation turn identity isolated across many concurrent invokes on ONE agent", async () => {
    // Shared model + agent across all invokes; a small async gap forces overlap.
    const model = new FakeChatModel({
      script: [aiFinal("ok")],
      onGenerate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    });
    const { agent, evaluates } = await buildGovernedAgent({ model });

    const N = 12;
    await Promise.all(
      Array.from({ length: N }, (_, i) => agent.invoke(humanTurn(`req-${i}`)))
    );

    // Group SignalReceived events by workflow_id; each workflow must carry
    // exactly one prompt, and prompt<->workflow must be a bijection (no bleed).
    const signals = evaluates.filter((e) => e.body.event_type === "SignalReceived");
    expect(signals).toHaveLength(N);

    const byWorkflow = new Map<string, Set<string>>();
    for (const s of signals) {
      const wf = String(s.body.workflow_id);
      const prompt = String((s.body.signal_args as string[])[0]);
      const set = byWorkflow.get(wf) ?? new Set<string>();
      set.add(prompt);
      byWorkflow.set(wf, set);
    }

    // N distinct workflows, each with exactly one prompt, all prompts distinct.
    expect(byWorkflow.size).toBe(N);
    const prompts = new Set<string>();
    for (const set of byWorkflow.values()) {
      expect(set.size).toBe(1);
      prompts.add([...set][0]!);
    }
    expect(prompts.size).toBe(N);
    expect([...prompts].sort()).toEqual(
      Array.from({ length: N }, (_, i) => `req-${i}`).sort()
    );
  });

  it("does not leak turn state after repeated blocked invokes", async () => {
    const model = new FakeChatModel({ script: [aiFinal("nope")] });
    const { agent, evaluates } = await buildGovernedAgent({
      model,
      route: (body) =>
        body.event_type === "SignalReceived"
          ? { verdict: "block", reason: "denied" }
          : { verdict: "allow" }
    });

    for (let i = 0; i < 8; i += 1) {
      await expect(agent.invoke(humanTurn(`blocked-${i}`))).rejects.toThrow();
    }
    // Each blocked run closes its own workflow exactly once — 8 blocks, 8 closures.
    const failed = evaluates.filter((e) => e.body.event_type === "WorkflowFailed");
    expect(failed).toHaveLength(8);
    const distinctWorkflows = new Set(failed.map((e) => String(e.body.workflow_id)));
    expect(distinctWorkflows.size).toBe(8);
  });
});
