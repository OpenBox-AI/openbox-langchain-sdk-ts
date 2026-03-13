import { describe, it, expect } from "vitest";
import { RunBufferManager } from "../src/run-buffer.js";
import { Verdict } from "../src/types.js";

describe("RunBufferManager", () => {
  describe("registerRun", () => {
    it("registers a root run (no parentRunId)", () => {
      const mgr = new RunBufferManager();
      mgr.registerRun("root-1", "chain", "AgentExecutor");
      const buf = mgr.getBuffer("root-1");
      expect(buf).toBeDefined();
      expect(buf!.rootRunId).toBe("root-1");
      expect(buf!.runId).toBe("root-1");
      expect(buf!.parentRunId).toBeUndefined();
      expect(buf!.runType).toBe("chain");
      expect(buf!.name).toBe("AgentExecutor");
      expect(buf!.pendingApproval).toBe(false);
      expect(buf!.attempt).toBe(1);
    });

    it("increments attempt on re-registration (stale buffer)", () => {
      const mgr = new RunBufferManager();
      mgr.registerRun("run-1", "tool", "my_tool");
      expect(mgr.getAttempt("run-1")).toBe(1);
      mgr.registerRun("run-1", "tool", "my_tool"); // re-register same runId
      expect(mgr.getAttempt("run-1")).toBe(2);
      mgr.registerRun("run-1", "tool", "my_tool");
      expect(mgr.getAttempt("run-1")).toBe(3);
    });

    it("preserves pendingApproval across re-registration", () => {
      const mgr = new RunBufferManager();
      mgr.registerRun("run-1", "tool", "my_tool");
      mgr.setPendingApproval("run-1", true);
      mgr.registerRun("run-1", "tool", "my_tool"); // stale re-register
      expect(mgr.isPendingApproval("run-1")).toBe(true); // preserved
    });

    it("registers child runs and tracks root correctly", () => {
      const mgr = new RunBufferManager();
      mgr.registerRun("root-1", "chain", "AgentExecutor");
      mgr.registerRun("llm-1", "llm", "ChatOpenAI", "root-1");
      mgr.registerRun("tool-1", "tool", "search", "root-1");

      expect(mgr.getRootRunId("llm-1")).toBe("root-1");
      expect(mgr.getRootRunId("tool-1")).toBe("root-1");

      const llmBuf = mgr.getBuffer("llm-1");
      expect(llmBuf!.rootRunId).toBe("root-1");
      expect(llmBuf!.parentRunId).toBe("root-1");
    });

    it("tracks grandchild runs back to root", () => {
      const mgr = new RunBufferManager();
      mgr.registerRun("root-1", "chain", "AgentExecutor");
      mgr.registerRun("tool-1", "tool", "search", "root-1");
      mgr.registerRun("llm-nested", "llm", "ChatOpenAI", "tool-1");

      expect(mgr.getRootRunId("llm-nested")).toBe("root-1");
    });
  });

  describe("getRootRunId", () => {
    it("returns runId itself when not registered (defensive fallback)", () => {
      const mgr = new RunBufferManager();
      expect(mgr.getRootRunId("unknown-run")).toBe("unknown-run");
    });
  });

  describe("markCompleted / markFailed", () => {
    it("sets status and endTime on completed", () => {
      const mgr = new RunBufferManager();
      mgr.registerRun("run-1", "tool", "my_tool");
      mgr.markCompleted("run-1");
      const buf = mgr.getBuffer("run-1")!;
      expect(buf.status).toBe("completed");
      expect(buf.endTime).toBeGreaterThan(0);
    });

    it("sets status and endTime on failed", () => {
      const mgr = new RunBufferManager();
      mgr.registerRun("run-1", "tool", "my_tool");
      mgr.markFailed("run-1");
      const buf = mgr.getBuffer("run-1")!;
      expect(buf.status).toBe("failed");
      expect(buf.endTime).toBeGreaterThan(0);
    });
  });

  describe("setRedactedInput / getRedactedInput", () => {
    it("stores and retrieves redacted input", () => {
      const mgr = new RunBufferManager();
      mgr.registerRun("run-1", "tool", "my_tool");
      mgr.setRedactedInput("run-1", "[REDACTED]");
      expect(mgr.getRedactedInput("run-1")).toBe("[REDACTED]");
    });

    it("stores object redacted input", () => {
      const mgr = new RunBufferManager();
      mgr.registerRun("run-1", "tool", "my_tool");
      const redacted = { prompt: "[REDACTED]", user: "alice" };
      mgr.setRedactedInput("run-1", redacted);
      expect(mgr.getRedactedInput("run-1")).toEqual(redacted);
    });

    it("returns undefined for unknown run", () => {
      const mgr = new RunBufferManager();
      expect(mgr.getRedactedInput("no-such-run")).toBeUndefined();
    });

    it("silently ignores setRedactedInput for unknown run", () => {
      const mgr = new RunBufferManager();
      expect(() => mgr.setRedactedInput("no-such-run", "value")).not.toThrow();
    });
  });

  describe("getAttempt", () => {
    it("returns 1 for a freshly registered run", () => {
      const mgr = new RunBufferManager();
      mgr.registerRun("run-1", "tool", "my_tool");
      expect(mgr.getAttempt("run-1")).toBe(1);
    });

    it("returns 1 for unknown run (defensive fallback)", () => {
      const mgr = new RunBufferManager();
      expect(mgr.getAttempt("no-such-run")).toBe(1);
    });
  });

  describe("setVerdictForRun", () => {
    it("stores verdict and reason", () => {
      const mgr = new RunBufferManager();
      mgr.registerRun("run-1", "tool", "my_tool");
      mgr.setVerdictForRun("run-1", Verdict.BLOCK, "Too risky");
      const buf = mgr.getBuffer("run-1")!;
      expect(buf.verdict).toBe(Verdict.BLOCK);
      expect(buf.verdictReason).toBe("Too risky");
    });
  });

  describe("setPendingApproval / isPendingApproval", () => {
    it("tracks pending approval state", () => {
      const mgr = new RunBufferManager();
      mgr.registerRun("run-1", "tool", "my_tool");
      expect(mgr.isPendingApproval("run-1")).toBe(false);
      mgr.setPendingApproval("run-1", true);
      expect(mgr.isPendingApproval("run-1")).toBe(true);
      mgr.setPendingApproval("run-1", false);
      expect(mgr.isPendingApproval("run-1")).toBe(false);
    });

    it("returns false for unknown run", () => {
      const mgr = new RunBufferManager();
      expect(mgr.isPendingApproval("no-such-run")).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("removes all runs associated with a root", () => {
      const mgr = new RunBufferManager();
      mgr.registerRun("root-1", "chain", "AgentExecutor");
      mgr.registerRun("llm-1", "llm", "ChatOpenAI", "root-1");
      mgr.registerRun("tool-1", "tool", "search", "root-1");
      mgr.registerRun("root-2", "chain", "OtherChain");

      expect(mgr.size).toBe(4);
      mgr.cleanup("root-1");
      expect(mgr.size).toBe(1); // only root-2 remains

      expect(mgr.getBuffer("root-1")).toBeUndefined();
      expect(mgr.getBuffer("llm-1")).toBeUndefined();
      expect(mgr.getBuffer("tool-1")).toBeUndefined();
      expect(mgr.getBuffer("root-2")).toBeDefined();
    });

    it("is safe to call on unknown root", () => {
      const mgr = new RunBufferManager();
      expect(() => mgr.cleanup("nonexistent")).not.toThrow();
    });
  });
});
