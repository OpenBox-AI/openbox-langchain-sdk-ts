import { prepareLifecyclePayload } from "@openbox-ai/openbox-sdk";
import { describe, expect, it } from "vitest";

import {
  buildActivityCompleted,
  buildActivityStarted,
  buildSignalReceived,
  buildWorkflowCompleted,
  buildWorkflowFailed,
  buildWorkflowStarted,
  mergeSessionExtra
} from "../src/lifecycle-events.js";

function wire(envelope: ReturnType<typeof buildActivityStarted>): Record<string, unknown> {
  return prepareLifecyclePayload(envelope, {}).payload;
}

const identity = {
  workflowId: "wf-1",
  runId: "run-1",
  workflowType: "LangChainRun",
  taskQueue: "langchain",
  sessionId: "sess-1",
  agentName: "agent-1"
};

describe("lifecycle event builders — snake_case wire keys", () => {
  it("threads sessionId/agentName/taskQueue as snake_case wire keys", () => {
    const payload = wire(
      buildActivityStarted({ ...identity, activityId: "a-1", activityType: "tool" })
    );
    expect(payload.session_id).toBe("sess-1");
    expect(payload.agent_name).toBe("agent-1");
    expect(payload.task_queue).toBe("langchain");
    expect(payload.activity_id).toBe("a-1");
    expect(payload.activity_type).toBe("tool");
    // No camelCase leakage.
    expect(payload.sessionId).toBeUndefined();
    expect(payload.agentName).toBeUndefined();
  });

  it("reuses the start activityId on completion with no -c suffix", () => {
    const started = wire(
      buildActivityStarted({ ...identity, activityId: "a-1", activityType: "tool" })
    );
    const completed = wire(
      buildActivityCompleted({
        ...identity,
        activityId: "a-1",
        activityType: "tool",
        result: { ok: true }
      })
    );
    expect(started.activity_id).toBe("a-1");
    expect(completed.activity_id).toBe("a-1");
    expect(String(completed.activity_id)).not.toContain("-c");
    expect(JSON.stringify(completed)).not.toContain("-c");
  });

  it("lets caller-supplied extra win over injected session/agent (set-if-absent)", () => {
    const payload = wire(
      buildActivityStarted({
        ...identity,
        activityId: "a-1",
        activityType: "tool",
        extra: { session_id: "caller-wins" }
      })
    );
    expect(payload.session_id).toBe("caller-wins");
    expect(payload.agent_name).toBe("agent-1");
  });

  it("carries the signal name on SignalReceived", () => {
    const payload = wire(
      buildSignalReceived({ ...identity, signalName: "user_message" })
    );
    expect(payload.signal_name).toBe("user_message");
  });

  it("emits a WorkflowStarted with identity only", () => {
    const payload = wire(buildWorkflowStarted(identity));
    expect(payload.workflow_id).toBe("wf-1");
    expect(payload.run_id).toBe("run-1");
    expect(payload.workflow_type).toBe("LangChainRun");
  });

  it("emits a WorkflowCompleted with snake_case session/agent", () => {
    const payload = wire(buildWorkflowCompleted(identity));
    expect(payload.workflow_id).toBe("wf-1");
    expect(payload.session_id).toBe("sess-1");
    expect(payload.agent_name).toBe("agent-1");
  });

  it("emits a WorkflowFailed carrying the error", () => {
    const payload = wire(buildWorkflowFailed({ ...identity, error: "governance block" }));
    expect(payload.workflow_id).toBe("wf-1");
    expect(payload.error).toBe("governance block");
  });
});

describe("mergeSessionExtra", () => {
  it("returns null when there is nothing to send", () => {
    expect(mergeSessionExtra(null, null, null)).toBeNull();
    expect(mergeSessionExtra(undefined, undefined, undefined)).toBeNull();
  });

  it("injects snake_case keys and preserves caller extra", () => {
    expect(mergeSessionExtra({ foo: "bar" }, "s", "a")).toEqual({
      foo: "bar",
      session_id: "s",
      agent_name: "a"
    });
  });
});
