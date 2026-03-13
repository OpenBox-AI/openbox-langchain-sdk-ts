/**
 * Tests for hook-level governance (PR #5 equivalent).
 *
 * Covers:
 * - configureHookGovernance / isHookGovernanceConfigured / resetHookGovernance
 * - evaluateHttpHook: ALLOW, BLOCK, HALT, REQUIRE_APPROVAL verdicts
 * - Short-circuit when activity already aborted
 * - fail_open vs fail_closed on API error
 * - Governed span dedup in SpanCollector
 * - RunBufferManager abort/halt fields
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  configureHookGovernance,
  resetHookGovernance,
  isHookGovernanceConfigured,
  evaluateHttpHook,
} from "../src/hook-governance.js";
import { RunBufferManager } from "../src/run-buffer.js";
import { SpanCollector } from "../src/telemetry.js";
import { GovernanceClient } from "../src/client.js";
import { GovernanceBlockedError, GovernanceHaltError } from "../src/errors.js";
import type { HttpSpan } from "../src/telemetry.js";

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function makeSpan(url = "https://api.example.com/data", method = "GET"): HttpSpan {
  return {
    span_id: "span-001",
    name: `HTTP ${method} /data`,
    kind: "client",
    start_time: Date.now(),
    attributes: {
      "http.method": method,
      "http.url": url,
    },
    status: { code: "OK" },
  };
}

function makeBuffer(runId = "run-1", rootRunId?: string): RunBufferManager {
  const buf = new RunBufferManager();
  buf.registerRun(runId, "tool", "my_tool", rootRunId);
  return buf;
}

function makeClient(verdictPayload: Record<string, unknown>): GovernanceClient {
  const client = {
    evaluateRaw: vi.fn().mockResolvedValue(verdictPayload),
  } as unknown as GovernanceClient;
  return client;
}

// ─────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetHookGovernance();
});

afterEach(() => {
  resetHookGovernance();
});

// ─────────────────────────────────────────────────────────────────
// 1. Configuration
// ─────────────────────────────────────────────────────────────────

describe("configureHookGovernance / isHookGovernanceConfigured", () => {
  it("returns false before configure", () => {
    expect(isHookGovernanceConfigured()).toBe(false);
  });

  it("returns true after configure", () => {
    const buffer = makeBuffer();
    const client = makeClient({ verdict: "allow" });
    configureHookGovernance({
      client,
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });
    expect(isHookGovernanceConfigured()).toBe(true);
  });

  it("returns false after reset", () => {
    const buffer = makeBuffer();
    const client = makeClient({ verdict: "allow" });
    configureHookGovernance({
      client,
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });
    resetHookGovernance();
    expect(isHookGovernanceConfigured()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. evaluateHttpHook — no-ops
// ─────────────────────────────────────────────────────────────────

describe("evaluateHttpHook — no-ops", () => {
  it("does nothing when not configured", async () => {
    await expect(
      evaluateHttpHook("started", makeSpan(), "run-1")
    ).resolves.toBeUndefined();
  });

  it("does nothing when runId is null", async () => {
    const buffer = makeBuffer();
    configureHookGovernance({
      client: makeClient({ verdict: "allow" }),
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });
    await expect(
      evaluateHttpHook("started", makeSpan(), null)
    ).resolves.toBeUndefined();
  });

  it("does nothing when runId has no buffer entry", async () => {
    const buffer = new RunBufferManager(); // empty — no registered run
    configureHookGovernance({
      client: makeClient({ verdict: "allow" }),
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });
    await expect(
      evaluateHttpHook("started", makeSpan(), "nonexistent-run")
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. ALLOW verdict
// ─────────────────────────────────────────────────────────────────

describe("evaluateHttpHook — ALLOW", () => {
  it("resolves without throwing on allow verdict", async () => {
    const buffer = makeBuffer("run-1");
    configureHookGovernance({
      client: makeClient({ verdict: "allow" }),
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });
    await expect(
      evaluateHttpHook("started", makeSpan(), "run-1")
    ).resolves.toBeUndefined();
    expect(buffer.isAborted("run-1")).toBe(false);
  });

  it("resolves on CONSTRAIN verdict (informational)", async () => {
    const buffer = makeBuffer("run-1");
    configureHookGovernance({
      client: makeClient({ verdict: "constrain", reason: "noted" }),
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });
    await expect(
      evaluateHttpHook("started", makeSpan(), "run-1")
    ).resolves.toBeUndefined();
    expect(buffer.isAborted("run-1")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. BLOCK verdict
// ─────────────────────────────────────────────────────────────────

describe("evaluateHttpHook — BLOCK", () => {
  it("throws GovernanceBlockedError with verdict=block", async () => {
    const buffer = makeBuffer("run-1");
    configureHookGovernance({
      client: makeClient({ verdict: "block", reason: "Policy violation" }),
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });

    await expect(
      evaluateHttpHook("started", makeSpan(), "run-1")
    ).rejects.toThrow(GovernanceBlockedError);

    const caught = await evaluateHttpHook("started", makeSpan(), "run-1").catch(
      (e) => e
    );
    expect(caught).toBeInstanceOf(GovernanceBlockedError);
    expect(caught.verdict).toBe("block");
    expect(caught.message).toBe("Policy violation");
    expect(caught.identifier).toBe("https://api.example.com/data");
  });

  it("sets buffer.aborted on BLOCK", async () => {
    const buffer = makeBuffer("run-1");
    configureHookGovernance({
      client: makeClient({ verdict: "block", reason: "Blocked" }),
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });

    await evaluateHttpHook("started", makeSpan(), "run-1").catch(() => {});
    expect(buffer.isAborted("run-1")).toBe(true);
    expect(buffer.getAbortReason("run-1")).toBe("Blocked");
    expect(buffer.isHaltRequested("run-1")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. HALT verdict
// ─────────────────────────────────────────────────────────────────

describe("evaluateHttpHook — HALT", () => {
  it("throws GovernanceBlockedError with verdict=halt", async () => {
    const buffer = makeBuffer("run-1");
    configureHookGovernance({
      client: makeClient({ verdict: "halt", reason: "Compliance breach" }),
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });

    const caught = await evaluateHttpHook("started", makeSpan(), "run-1").catch(
      (e) => e
    );
    expect(caught).toBeInstanceOf(GovernanceBlockedError);
    expect(caught.verdict).toBe("halt");
  });

  it("sets both aborted AND haltRequested on HALT", async () => {
    const buffer = makeBuffer("run-1");
    configureHookGovernance({
      client: makeClient({ verdict: "halt", reason: "Session terminated" }),
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });

    await evaluateHttpHook("started", makeSpan(), "run-1").catch(() => {});
    expect(buffer.isAborted("run-1")).toBe(true);
    expect(buffer.isHaltRequested("run-1")).toBe(true);
    expect(buffer.getAbortReason("run-1")).toBe("Session terminated");
  });

  it("also triggers on legacy 'stop' verdict string", async () => {
    const buffer = makeBuffer("run-1");
    configureHookGovernance({
      client: makeClient({ verdict: "stop", reason: "Legacy stop" }),
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });

    await evaluateHttpHook("started", makeSpan(), "run-1").catch(() => {});
    expect(buffer.isHaltRequested("run-1")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. REQUIRE_APPROVAL verdict
// ─────────────────────────────────────────────────────────────────

describe("evaluateHttpHook — REQUIRE_APPROVAL", () => {
  it("throws GovernanceBlockedError with verdict=require_approval", async () => {
    const buffer = makeBuffer("run-1");
    configureHookGovernance({
      client: makeClient({ verdict: "require_approval", reason: "Needs human" }),
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });

    const caught = await evaluateHttpHook("started", makeSpan(), "run-1").catch(
      (e) => e
    );
    expect(caught).toBeInstanceOf(GovernanceBlockedError);
    expect(caught.verdict).toBe("require_approval");
    expect(buffer.isAborted("run-1")).toBe(true);
    expect(buffer.isHaltRequested("run-1")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// 7. Abort short-circuit
// ─────────────────────────────────────────────────────────────────

describe("evaluateHttpHook — abort short-circuit", () => {
  it("short-circuits immediately when activity already aborted", async () => {
    const buffer = makeBuffer("run-1");
    buffer.setAborted("run-1", "Prior hook blocked");

    const client = makeClient({ verdict: "allow" });
    configureHookGovernance({
      client,
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });

    const caught = await evaluateHttpHook("started", makeSpan(), "run-1").catch(
      (e) => e
    );
    expect(caught).toBeInstanceOf(GovernanceBlockedError);
    expect(caught.verdict).toBe("block");
    // API should NOT have been called
    expect((client.evaluateRaw as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("does not short-circuit when a different runId is aborted", async () => {
    const buffer = new RunBufferManager();
    buffer.registerRun("run-1", "tool", "tool_a");
    buffer.registerRun("run-2", "tool", "tool_b");
    buffer.setAborted("run-2", "Other run aborted");

    configureHookGovernance({
      client: makeClient({ verdict: "allow" }),
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });

    await expect(
      evaluateHttpHook("started", makeSpan(), "run-1")
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// 8. fail_open vs fail_closed
// ─────────────────────────────────────────────────────────────────

describe("evaluateHttpHook — API error policies", () => {
  it("fail_open: swallows API error and allows operation", async () => {
    const buffer = makeBuffer("run-1");
    const client = {
      evaluateRaw: vi.fn().mockRejectedValue(new Error("Network error")),
    } as unknown as GovernanceClient;

    configureHookGovernance({
      client,
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });

    await expect(
      evaluateHttpHook("started", makeSpan(), "run-1")
    ).resolves.toBeUndefined();
    expect(buffer.isAborted("run-1")).toBe(false);
  });

  it("fail_closed: API error blocks operation with halt verdict", async () => {
    const buffer = makeBuffer("run-1");
    const client = {
      evaluateRaw: vi.fn().mockRejectedValue(new Error("Timeout")),
    } as unknown as GovernanceClient;

    configureHookGovernance({
      client,
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_closed",
    });

    const caught = await evaluateHttpHook("started", makeSpan(), "run-1").catch(
      (e) => e
    );
    expect(caught).toBeInstanceOf(GovernanceBlockedError);
    expect(caught.verdict).toBe("halt");
    expect(buffer.isAborted("run-1")).toBe(true);
  });

  it("fail_open: null API response (HTTP error) allows operation", async () => {
    const buffer = makeBuffer("run-1");
    const client = {
      evaluateRaw: vi.fn().mockResolvedValue(null),
    } as unknown as GovernanceClient;

    configureHookGovernance({
      client,
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });

    await expect(
      evaluateHttpHook("started", makeSpan(), "run-1")
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// 9. Governed span dedup in SpanCollector
// ─────────────────────────────────────────────────────────────────

describe("SpanCollector — governed span dedup", () => {
  it("getSpans excludes governed spans", () => {
    const collector = new SpanCollector();
    collector.setActiveRun("run-1");

    const spanA: HttpSpan = {
      ...makeSpan("https://api.example.com/a"),
      span_id: "span-A",
    };
    const spanB: HttpSpan = {
      ...makeSpan("https://api.example.com/b"),
      span_id: "span-B",
    };

    collector.addSpan(spanA, "run-1");
    collector.addSpan(spanB, "run-1");

    // Mark span-A as governed (already evaluated at hook level)
    collector.markSpanGoverned("span-A");

    const spans = collector.getSpans("run-1");
    expect(spans).toHaveLength(1);
    expect(spans[0].span_id).toBe("span-B");
  });

  it("getSpans returns all spans when none are governed", () => {
    const collector = new SpanCollector();
    collector.setActiveRun("run-1");
    collector.addSpan({ ...makeSpan(), span_id: "span-X" }, "run-1");
    collector.addSpan({ ...makeSpan(), span_id: "span-Y" }, "run-1");

    expect(collector.getSpans("run-1")).toHaveLength(2);
  });

  it("isSpanGoverned returns correct values", () => {
    const collector = new SpanCollector();
    collector.markSpanGoverned("governed-1");
    expect(collector.isSpanGoverned("governed-1")).toBe(true);
    expect(collector.isSpanGoverned("not-governed")).toBe(false);
  });

  it("activeRunId getter exposes current run", () => {
    const collector = new SpanCollector();
    expect(collector.activeRunId).toBeNull();
    collector.setActiveRun("run-42");
    expect(collector.activeRunId).toBe("run-42");
    collector.clearActiveRun();
    expect(collector.activeRunId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// 10. RunBufferManager — abort/halt fields
// ─────────────────────────────────────────────────────────────────

describe("RunBufferManager — abort/halt fields", () => {
  it("setAborted / isAborted / getAbortReason", () => {
    const buf = makeBuffer("run-1");
    expect(buf.isAborted("run-1")).toBe(false);
    buf.setAborted("run-1", "Blocked by hook");
    expect(buf.isAborted("run-1")).toBe(true);
    expect(buf.getAbortReason("run-1")).toBe("Blocked by hook");
  });

  it("setHaltRequested also sets aborted", () => {
    const buf = makeBuffer("run-1");
    buf.setHaltRequested("run-1", "Halt reason");
    expect(buf.isHaltRequested("run-1")).toBe(true);
    expect(buf.isAborted("run-1")).toBe(true);
    expect(buf.getAbortReason("run-1")).toBe("Halt reason");
  });

  it("isAborted returns false for unknown runId", () => {
    const buf = new RunBufferManager();
    expect(buf.isAborted("nonexistent")).toBe(false);
    expect(buf.isHaltRequested("nonexistent")).toBe(false);
    expect(buf.getAbortReason("nonexistent")).toBeUndefined();
  });

  it("setAborted does nothing for unknown runId", () => {
    const buf = new RunBufferManager();
    buf.setAborted("ghost", "reason");
    expect(buf.isAborted("ghost")).toBe(false);
  });

  it("abort state is independent per runId", () => {
    const buf = new RunBufferManager();
    buf.registerRun("run-A", "tool", "tool_a");
    buf.registerRun("run-B", "tool", "tool_b");
    buf.setAborted("run-A", "Blocked");
    expect(buf.isAborted("run-A")).toBe(true);
    expect(buf.isAborted("run-B")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// 11. GovernanceBlockedError — new fields
// ─────────────────────────────────────────────────────────────────

describe("GovernanceBlockedError — hook-level constructor", () => {
  it("hook-level: (verdict, reason, identifier)", () => {
    const err = new GovernanceBlockedError("block", "Policy X", "https://api.example.com");
    expect(err.verdict).toBe("block");
    expect(err.message).toBe("Policy X");
    expect(err.identifier).toBe("https://api.example.com");
    expect(err.name).toBe("GovernanceBlockedError");
  });

  it("hook-level: halt verdict", () => {
    const err = new GovernanceBlockedError("halt", "Session halted", "/some/path");
    expect(err.verdict).toBe("halt");
    expect(err.message).toBe("Session halted");
    expect(err.identifier).toBe("/some/path");
  });

  it("hook-level: require_approval verdict", () => {
    const err = new GovernanceBlockedError("require_approval", "Needs review", "");
    expect(err.verdict).toBe("require_approval");
    expect(err.message).toBe("Needs review");
  });

  it("legacy: (reason) — backward compatible", () => {
    const err = new GovernanceBlockedError("Blocked by governance");
    expect(err.verdict).toBe("block");
    expect(err.message).toBe("Blocked by governance");
    expect(err.identifier).toBe("");
  });

  it("instanceof check works", () => {
    const err = new GovernanceBlockedError("block", "reason", "url");
    expect(err instanceof GovernanceBlockedError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

describe("GovernanceHaltError — identifier field", () => {
  it("stores identifier", () => {
    const err = new GovernanceHaltError("Halt reason", "https://api.example.com/halt");
    expect(err.verdict).toBe("halt");
    expect(err.message).toBe("Halt reason");
    expect(err.identifier).toBe("https://api.example.com/halt");
  });

  it("defaults identifier to empty string", () => {
    const err = new GovernanceHaltError("Halt");
    expect(err.identifier).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────
// 12. Hook trigger payload shape (via evaluateRaw call)
// ─────────────────────────────────────────────────────────────────

describe("evaluateHttpHook — payload shape sent to evaluateRaw", () => {
  it("started stage sends correct hook_trigger shape", async () => {
    const buffer = makeBuffer("run-1");
    const client = makeClient({ verdict: "allow" });
    configureHookGovernance({
      client,
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });

    const span = makeSpan("https://api.openai.com/v1/chat/completions", "POST");
    span.request_body = '{"model":"gpt-4o"}';
    await evaluateHttpHook("started", span, "run-1");

    const evaluateRawMock = client.evaluateRaw as ReturnType<typeof vi.fn>;
    expect(evaluateRawMock).toHaveBeenCalledOnce();
    const payload = evaluateRawMock.mock.calls[0][0] as Record<string, unknown>;

    expect(payload.source).toBe("langchain-telemetry");
    expect(payload.event_type).toBe("ActivityStarted");
    expect(payload.task_queue).toBe("langchain");
    expect(payload.spans).toEqual([]);
    expect(payload.span_count).toBe(0);

    const trigger = payload.hook_trigger as Record<string, unknown>;
    expect(trigger.type).toBe("http_request");
    expect(trigger.stage).toBe("started");
    expect(trigger["http.method"]).toBe("POST");
    expect(trigger["http.url"]).toBe("https://api.openai.com/v1/chat/completions");
    expect(trigger.attribute_key_identifiers).toEqual(["http.method", "http.url"]);
    expect(trigger.request_body).toBe('{"model":"gpt-4o"}');
    // completed-only fields should be absent
    expect(trigger.response_body).toBeUndefined();
    expect(trigger["http.status_code"]).toBeUndefined();
  });

  it("completed stage includes response fields", async () => {
    const buffer = makeBuffer("run-1");
    const client = makeClient({ verdict: "allow" });
    configureHookGovernance({
      client,
      buffer,
      spanCollector: new SpanCollector(),
      onApiError: "fail_open",
    });

    const span = makeSpan("https://api.openai.com/v1/chat/completions", "POST");
    span.response_body = '{"choices":[]}';
    span.attributes["http.status_code"] = 200;
    await evaluateHttpHook("completed", span, "run-1");

    const evaluateRawMock = client.evaluateRaw as ReturnType<typeof vi.fn>;
    const payload = evaluateRawMock.mock.calls[0][0] as Record<string, unknown>;
    const trigger = payload.hook_trigger as Record<string, unknown>;
    expect(trigger.stage).toBe("completed");
    expect(trigger.response_body).toBe('{"choices":[]}');
    expect(trigger["http.status_code"]).toBe(200);
  });
});
