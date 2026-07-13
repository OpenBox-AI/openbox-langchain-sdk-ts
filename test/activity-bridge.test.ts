import { EvaluationResult } from "@openbox-ai/openbox-sdk-ts";
import { describe, expect, it } from "vitest";

import { ActivityBridge } from "../src/activity-bridge.js";

const WF = "wf-1";

function blockResult(reason = "blocked"): EvaluationResult {
  return EvaluationResult.fromDict({ verdict: "block", reason });
}

describe("ActivityBridge ownership", () => {
  it("reports not-owned when no record exists", () => {
    const bridge = new ActivityBridge();
    expect(bridge.isCallbackOwned(WF, "a-1", "tool_start")).toBe(false);
  });

  it("reports not-owned when a record exists but the sent-flag is false", () => {
    const bridge = new ActivityBridge();
    bridge.prepareTool(WF, "a-1");
    expect(bridge.isCallbackOwned(WF, "a-1", "tool_start")).toBe(false);
  });

  it("reports owned only for the exact event type that was marked sent", () => {
    const bridge = new ActivityBridge();
    bridge.prepareTool(WF, "a-1");
    bridge.markSent(WF, "a-1", "tool_start");
    expect(bridge.isCallbackOwned(WF, "a-1", "tool_start")).toBe(true);
    // A different event type on the same record is NOT owned.
    expect(bridge.isCallbackOwned(WF, "a-1", "tool_complete")).toBe(false);
    expect(bridge.isCallbackOwned(WF, "a-1", "llm_start")).toBe(false);
  });

  it("keeps tool and llm start ownership independent", () => {
    const bridge = new ActivityBridge();
    bridge.prepareLlm(WF, "llm-1");
    bridge.markSent(WF, "llm-1", "llm_start");
    expect(bridge.isCallbackOwned(WF, "llm-1", "llm_start")).toBe(true);
    expect(bridge.isCallbackOwned(WF, "llm-1", "tool_start")).toBe(false);
  });
});

describe("ActivityBridge idempotent prepare", () => {
  it("returns the same record and preserves stashed verdicts on a second prepareTool", () => {
    const bridge = new ActivityBridge();
    const first = bridge.prepareTool(WF, "a-1", { toolName: "echo" });
    bridge.markSent(WF, "a-1", "tool_start");
    const verdict = blockResult("first");
    bridge.stashStartResult(WF, "a-1", verdict);

    const second = bridge.prepareTool(WF, "a-1", { toolName: "SHOULD-NOT-CLOBBER" });
    expect(second).toBe(first);
    expect(second.toolName).toBe("echo");
    expect(second.sentFlags.tool_start).toBe(true);
    expect(second.startResult).toBe(verdict);
  });

  it("returns the same record and preserves stashed verdicts on a second prepareLlm", () => {
    const bridge = new ActivityBridge();
    const first = bridge.prepareLlm(WF, "llm-1");
    const start = blockResult("start");
    const completion = blockResult("done");
    bridge.stashStartResult(WF, "llm-1", start);
    bridge.stashCompletionResult(WF, "llm-1", completion);

    const second = bridge.prepareLlm(WF, "llm-1");
    expect(second).toBe(first);
    expect(second.startResult).toBe(start);
    expect(second.completionResult).toBe(completion);
  });
});

describe("ActivityBridge run-id alias", () => {
  it("resolves a run id to the aliased (pre-screen) activity id", () => {
    const bridge = new ActivityBridge();
    // Pre-screen row keyed differently than the LLM callback run id.
    bridge.prepareLlm(WF, "run-1-pre");
    bridge.aliasRunId(WF, "run-1", "run-1-pre");

    expect(bridge.resolveActivityId(WF, "run-1")).toBe("run-1-pre");
    expect(bridge.getByEventRunId(WF, "run-1")?.activityId).toBe("run-1-pre");
  });

  it("registers the alias via prepareLlm's eventRunId option", () => {
    const bridge = new ActivityBridge();
    bridge.prepareLlm(WF, "run-2-pre", { eventRunId: "run-2" });
    expect(bridge.getByEventRunId(WF, "run-2")?.activityId).toBe("run-2-pre");
  });

  it("falls back to the run id itself when unaliased", () => {
    const bridge = new ActivityBridge();
    bridge.prepareLlm(WF, "run-3");
    expect(bridge.resolveActivityId(WF, "run-3")).toBe("run-3");
    expect(bridge.getByEventRunId(WF, "run-3")?.activityId).toBe("run-3");
  });

  it("returns undefined resolving against an unknown workflow", () => {
    const bridge = new ActivityBridge();
    expect(bridge.getByEventRunId("nope", "run-x")).toBeUndefined();
    expect(bridge.resolveActivityId("nope", "run-x")).toBe("run-x");
    expect(bridge.get("nope", "a")).toBeUndefined();
  });
});

describe("ActivityBridge sweep", () => {
  it("returns all records for a workflow and empties it", () => {
    const bridge = new ActivityBridge();
    bridge.prepareTool(WF, "a-1");
    bridge.prepareLlm(WF, "llm-1");

    const swept = bridge.sweepWorkflow(WF);
    expect(swept.map((r) => r.activityId).sort()).toEqual(["a-1", "llm-1"]);
    // Workflow is gone afterwards.
    expect(bridge.get(WF, "a-1")).toBeUndefined();
    expect(bridge.sweepWorkflow(WF)).toEqual([]);
  });
});

describe("ActivityBridge instance isolation", () => {
  it("shares no state between two instances", () => {
    const a = new ActivityBridge();
    const b = new ActivityBridge();
    a.prepareTool(WF, "a-1");
    a.markSent(WF, "a-1", "tool_start");

    expect(a.isCallbackOwned(WF, "a-1", "tool_start")).toBe(true);
    expect(b.get(WF, "a-1")).toBeUndefined();
    expect(b.isCallbackOwned(WF, "a-1", "tool_start")).toBe(false);
  });
});
