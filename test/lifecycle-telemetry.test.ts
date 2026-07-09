import { describe, expect, it, vi } from "vitest";

import { buildActivityCompleted } from "../src/lifecycle-events.js";
import { evaluateLifecycleTelemetryOnly } from "../src/lifecycle-telemetry.js";
import { makeFakeCoreRuntime } from "./fakes.js";

const event = () =>
  buildActivityCompleted({
    workflowId: "wf-1",
    runId: "run-1",
    workflowType: "LangChainRun",
    activityId: "a-1",
    activityType: "tool",
    taskQueue: "langchain",
    sessionId: "sess-1",
    agentName: "agent-1",
    result: { ok: true }
  });

describe("evaluateLifecycleTelemetryOnly", () => {
  it("returns the EvaluationResult on success", async () => {
    const { runtime, core } = makeFakeCoreRuntime((c) =>
      c.queueEvaluate({ body: { verdict: "allow" } })
    );
    const result = await evaluateLifecycleTelemetryOnly(runtime, event());
    expect(result?.verdict).toBe("allow");
    expect(core.evaluateRequests).toHaveLength(1);
  });

  it("sends snake_case wire keys in the payload", async () => {
    const { runtime, core } = makeFakeCoreRuntime();
    await evaluateLifecycleTelemetryOnly(runtime, event());
    const body = core.lifecycleRequests[0]?.bodyJson as Record<string, unknown>;
    expect(body.session_id).toBe("sess-1");
    expect(body.agent_name).toBe("agent-1");
    expect(body.task_queue).toBe("langchain");
  });

  it("RETURNS a BLOCK verdict without throwing and without enforcing", async () => {
    const { runtime, core, adapter } = makeFakeCoreRuntime((c) =>
      c.queueEvaluate({ body: { verdict: "block", reason: "nope" } })
    );
    const result = await evaluateLifecycleTelemetryOnly(runtime, event());
    expect(result?.verdict).toBe("block");
    // Never enforced: no adapter delegation, no approval poll.
    expect(adapter.calls).toHaveLength(0);
    expect(core.approvalRequests).toHaveLength(0);
  });

  it("returns null (never throws) on an auth failure", async () => {
    const warn = vi.fn();
    const { runtime, adapter } = makeFakeCoreRuntime((c) =>
      c.queueEvaluate({ status: 401, body: { error: "unauthorized" } })
    );
    const result = await evaluateLifecycleTelemetryOnly(runtime, event(), {
      logger: { warn }
    });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(adapter.calls).toHaveLength(0);
  });

  it("returns the fail-open fallback result on a network error (default fail_open)", async () => {
    const { runtime } = makeFakeCoreRuntime((c) => c.queueEvaluate({ networkError: "down" }));
    const result = await evaluateLifecycleTelemetryOnly(runtime, event());
    // Under fail_open the client returns a fallback ALLOW rather than throwing.
    expect(result?.verdict).toBe("allow");
    expect(result?.fallbackUsed).toBe(true);
  });
});
