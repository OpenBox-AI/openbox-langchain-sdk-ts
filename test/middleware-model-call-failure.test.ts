// A model call that throws must still close its records.
//
// Every started row is answered exactly once: an ActivityStarted by one
// ActivityCompleted, a WorkflowStarted by one close. `wrapToolCall` has done
// this for a failed tool body since it was written; `wrapModelCall` did not, so
// anything thrown by the handler — a governance verdict raised below this layer,
// an unverifiable inference receipt, a refused route, a plain network fault —
// left the activity open and the session `pending` for ever, with spans hanging
// off an activity that never finished.

import { describe, expect, it } from "vitest";

import {
  aiFinal,
  buildGovernedAgent,
  FakeChatModel,
  humanTurn,
  type CapturedEvaluate
} from "./fakes.js";

const eventTypes = (evaluates: CapturedEvaluate[]): string[] =>
  evaluates.map((e) => String(e.body.event_type));

const count = (evaluates: CapturedEvaluate[], eventType: string): number =>
  eventTypes(evaluates).filter((t) => t === eventType).length;

/** Every ActivityStarted answered by exactly one ActivityCompleted with the same id. */
const activityPairs = (evaluates: CapturedEvaluate[]): Map<string, string[]> => {
  const pairs = new Map<string, string[]>();
  for (const e of evaluates) {
    const type = String(e.body.event_type);
    if (type !== "ActivityStarted" && type !== "ActivityCompleted") continue;
    const id = String(e.body.activity_id);
    pairs.set(id, [...(pairs.get(id) ?? []), type]);
  }
  return pairs;
};

const failingModel = (message: string): FakeChatModel =>
  new FakeChatModel({
    script: [aiFinal("never reached")],
    onGenerate: () => {
      throw new Error(message);
    }
  });

describe("a model call that throws", () => {
  it("closes the activity and the workflow, and rethrows", async () => {
    const { agent, evaluates } = await buildGovernedAgent({
      model: failingModel("inference receipt did not verify")
    });

    await expect(agent.invoke(humanTurn("hello"))).rejects.toThrow(/receipt did not verify/);

    expect(count(evaluates, "ActivityCompleted")).toBe(1);
    expect(count(evaluates, "WorkflowFailed")).toBe(1);
    expect(count(evaluates, "WorkflowCompleted")).toBe(0);
    for (const [activityId, stages] of activityPairs(evaluates)) {
      expect(stages, `activity ${activityId}`).toEqual(["ActivityStarted", "ActivityCompleted"]);
    }
  });

  it("records the error in the shape Core requires, not as a bare string", async () => {
    const { evaluates, agent } = await buildGovernedAgent({
      model: failingModel("no route satisfies this floor")
    });

    await expect(agent.invoke(humanTurn("hello"))).rejects.toThrow();

    const completed = evaluates.find((e) => e.body.event_type === "ActivityCompleted");
    expect(completed?.body.error).toMatchObject({ message: expect.stringContaining("no route") });
    // A failed call has no response metadata to report.
    expect(completed?.body.result ?? null).toBeNull();
  });

  it("closes the workflow once, even though the same turn opened it", async () => {
    const { agent, evaluates } = await buildGovernedAgent({ model: failingModel("boom") });
    await expect(agent.invoke(humanTurn("hello"))).rejects.toThrow();
    expect(count(evaluates, "WorkflowStarted")).toBe(count(evaluates, "WorkflowFailed"));
  });

  it("leaves a successful run exactly as it was", async () => {
    const { agent, evaluates } = await buildGovernedAgent({
      model: new FakeChatModel({ script: [aiFinal("done")] })
    });

    await agent.invoke(humanTurn("hello"));

    expect(count(evaluates, "WorkflowCompleted")).toBe(1);
    expect(count(evaluates, "WorkflowFailed")).toBe(0);
    const completed = evaluates.find((e) => e.body.event_type === "ActivityCompleted");
    expect(completed?.body.error ?? null).toBeNull();
    for (const [, stages] of activityPairs(evaluates)) {
      expect(stages).toEqual(["ActivityStarted", "ActivityCompleted"]);
    }
  });

  it("respects sendLlmEndEvent: false, which suppresses the completion by design", async () => {
    const { agent, evaluates } = await buildGovernedAgent({
      model: failingModel("boom"),
      mwOptions: { sendLlmEndEvent: false }
    });

    await expect(agent.invoke(humanTurn("hello"))).rejects.toThrow();

    expect(count(evaluates, "ActivityCompleted")).toBe(0);
    // The run is still closed — the workflow does not depend on that option.
    expect(count(evaluates, "WorkflowFailed")).toBe(1);
  });
});
