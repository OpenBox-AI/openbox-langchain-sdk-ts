/**
 * Tests for OpenBoxSignalMonitor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenBoxSignalMonitor } from "../src/signal-monitor.js";
import { GovernanceClient } from "../src/client.js";
import { Verdict } from "../src/types.js";
import { GovernanceHaltError, GovernanceBlockedError } from "../src/errors.js";

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function makeClient(overrides: Partial<GovernanceClient> = {}): GovernanceClient {
  return {
    evaluateEvent: vi.fn().mockResolvedValue({ verdict: Verdict.ALLOW, reason: undefined }),
    pollApproval: vi.fn().mockResolvedValue(null),
    validateApiKey: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GovernanceClient;
}

function makeAllowResponse() {
  return { verdict: Verdict.ALLOW, reason: undefined };
}

function makeHaltResponse(reason = "Halted by policy") {
  return { verdict: Verdict.HALT, reason };
}

function makeBlockResponse(reason = "Blocked by policy") {
  return { verdict: Verdict.BLOCK, reason };
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("OpenBoxSignalMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("starts not running", () => {
      const monitor = new OpenBoxSignalMonitor(makeClient());
      expect(monitor.status.running).toBe(false);
      expect(monitor.status.workflowId).toBeNull();
      expect(monitor.status.aborted).toBe(false);
      expect(monitor.status.pollCount).toBe(0);
    });
  });

  describe("start / stop", () => {
    it("becomes running after start()", () => {
      const monitor = new OpenBoxSignalMonitor(makeClient());
      const ctrl = new AbortController();
      monitor.start("wf-1", ctrl);
      expect(monitor.status.running).toBe(true);
      expect(monitor.status.workflowId).toBe("wf-1");
      monitor.stop();
    });

    it("stops cleanly", () => {
      const monitor = new OpenBoxSignalMonitor(makeClient());
      const ctrl = new AbortController();
      monitor.start("wf-1", ctrl);
      monitor.stop();
      expect(monitor.status.running).toBe(false);
      expect(monitor.status.workflowId).toBeNull();
    });

    it("safe to call stop() multiple times", () => {
      const monitor = new OpenBoxSignalMonitor(makeClient());
      expect(() => {
        monitor.stop();
        monitor.stop();
      }).not.toThrow();
    });

    it("restarting replaces previous session", () => {
      const monitor = new OpenBoxSignalMonitor(makeClient());
      const ctrl1 = new AbortController();
      const ctrl2 = new AbortController();
      monitor.start("wf-1", ctrl1);
      monitor.start("wf-2", ctrl2);
      expect(monitor.status.workflowId).toBe("wf-2");
      monitor.stop();
    });
  });

  describe("polling — ALLOW verdict", () => {
    it("does not abort on ALLOW", async () => {
      const client = makeClient({
        evaluateEvent: vi.fn().mockResolvedValue(makeAllowResponse()),
      });
      const monitor = new OpenBoxSignalMonitor(client, { pollIntervalMs: 100 });
      const ctrl = new AbortController();
      monitor.start("wf-allow", ctrl);

      // Advance past first poll interval
      await vi.advanceTimersByTimeAsync(150);

      expect(ctrl.signal.aborted).toBe(false);
      expect(monitor.status.aborted).toBe(false);
      expect(monitor.status.pollCount).toBeGreaterThanOrEqual(1);
      monitor.stop();
    });

    it("increments pollCount each interval", async () => {
      const client = makeClient({
        evaluateEvent: vi.fn().mockResolvedValue(makeAllowResponse()),
      });
      const monitor = new OpenBoxSignalMonitor(client, { pollIntervalMs: 100 });
      const ctrl = new AbortController();
      monitor.start("wf-count", ctrl);

      await vi.advanceTimersByTimeAsync(350);
      expect(monitor.status.pollCount).toBeGreaterThanOrEqual(3);
      monitor.stop();
    });
  });

  describe("polling — HALT verdict", () => {
    it("aborts the controller on HALT", async () => {
      const client = makeClient({
        evaluateEvent: vi.fn().mockResolvedValue(makeHaltResponse("halt reason")),
      });
      const monitor = new OpenBoxSignalMonitor(client, { pollIntervalMs: 100 });
      const ctrl = new AbortController();
      monitor.start("wf-halt", ctrl);

      await vi.advanceTimersByTimeAsync(150);

      expect(ctrl.signal.aborted).toBe(true);
      expect(monitor.status.aborted).toBe(true);
      expect(monitor.status.abortVerdict).toBe(Verdict.HALT);
      expect(monitor.status.abortReason).toBe("halt reason");
      expect(monitor.status.running).toBe(false);
    });

    it("abort reason is a GovernanceHaltError", async () => {
      const client = makeClient({
        evaluateEvent: vi.fn().mockResolvedValue(makeHaltResponse("policy halt")),
      });
      const monitor = new OpenBoxSignalMonitor(client, { pollIntervalMs: 100 });
      const ctrl = new AbortController();
      monitor.start("wf-halt-err", ctrl);

      await vi.advanceTimersByTimeAsync(150);

      expect(ctrl.signal.reason).toBeInstanceOf(GovernanceHaltError);
      expect((ctrl.signal.reason as GovernanceHaltError).message).toBe("policy halt");
      monitor.stop();
    });
  });

  describe("polling — BLOCK verdict", () => {
    it("aborts the controller on BLOCK", async () => {
      const client = makeClient({
        evaluateEvent: vi.fn().mockResolvedValue(makeBlockResponse("block reason")),
      });
      const monitor = new OpenBoxSignalMonitor(client, { pollIntervalMs: 100 });
      const ctrl = new AbortController();
      monitor.start("wf-block", ctrl);

      await vi.advanceTimersByTimeAsync(150);

      expect(ctrl.signal.aborted).toBe(true);
      expect(monitor.status.abortVerdict).toBe(Verdict.BLOCK);
      expect(monitor.status.abortReason).toBe("block reason");
    });

    it("abort reason is a GovernanceBlockedError", async () => {
      const client = makeClient({
        evaluateEvent: vi.fn().mockResolvedValue(makeBlockResponse("policy block")),
      });
      const monitor = new OpenBoxSignalMonitor(client, { pollIntervalMs: 100 });
      const ctrl = new AbortController();
      monitor.start("wf-block-err", ctrl);

      await vi.advanceTimersByTimeAsync(150);

      expect(ctrl.signal.reason).toBeInstanceOf(GovernanceBlockedError);
      monitor.stop();
    });
  });

  describe("API unreachable (null response)", () => {
    it("continues polling when API returns null (fail-open)", async () => {
      const client = makeClient({
        evaluateEvent: vi.fn().mockResolvedValue(null),
      });
      const monitor = new OpenBoxSignalMonitor(client, { pollIntervalMs: 100 });
      const ctrl = new AbortController();
      monitor.start("wf-null", ctrl);

      await vi.advanceTimersByTimeAsync(350);

      expect(ctrl.signal.aborted).toBe(false);
      expect(monitor.status.pollCount).toBeGreaterThanOrEqual(3);
      monitor.stop();
    });
  });

  describe("maxDurationMs safety ceiling", () => {
    it("stops polling after maxDurationMs", async () => {
      const client = makeClient({
        evaluateEvent: vi.fn().mockResolvedValue(makeAllowResponse()),
      });
      const monitor = new OpenBoxSignalMonitor(client, {
        pollIntervalMs: 100,
        maxDurationMs: 250,
      });
      const ctrl = new AbortController();
      monitor.start("wf-max", ctrl);

      await vi.advanceTimersByTimeAsync(500);

      // Should have stopped due to maxDurationMs
      expect(monitor.status.running).toBe(false);
      expect(ctrl.signal.aborted).toBe(false); // stopped cleanly, no abort
    });
  });

  describe("stops polling after abort", () => {
    it("does not poll again after HALT", async () => {
      const evaluateEvent = vi.fn().mockResolvedValue(makeHaltResponse());
      const client = makeClient({ evaluateEvent });
      const monitor = new OpenBoxSignalMonitor(client, { pollIntervalMs: 100 });
      const ctrl = new AbortController();
      monitor.start("wf-no-repoll", ctrl);

      await vi.advanceTimersByTimeAsync(150);
      const countAfterHalt = evaluateEvent.mock.calls.length;

      // Advance much further — should not poll again
      await vi.advanceTimersByTimeAsync(500);
      expect(evaluateEvent.mock.calls.length).toBe(countAfterHalt);
    });
  });
});
