import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wrapTool, wrapTools, wrapLLM, type WrappableTool } from "../src/wrappers.js";
import { OpenBoxCallbackHandler } from "../src/callback-handler.js";
import { RunBufferManager } from "../src/run-buffer.js";
import { GovernanceClient } from "../src/client.js";
import { GovernanceBlockedError, ApprovalRejectedError } from "../src/errors.js";
import { Verdict } from "../src/types.js";
import { resetHookGovernance } from "../src/hook-governance.js";

function makeHandler(overrides: Partial<InstanceType<typeof RunBufferManager>> = {}) {
  const client = {
    evaluateEvent: vi.fn().mockResolvedValue(null),
    pollApproval: vi.fn().mockResolvedValue(null),
    validateApiKey: vi.fn().mockResolvedValue(true),
  } as unknown as GovernanceClient;

  const buffer = new RunBufferManager();
  Object.assign(buffer, overrides);

  return new OpenBoxCallbackHandler({ client, buffer });
}

function makeTool(name: string): WrappableTool & { callCount: number; lastInput: unknown } {
  return {
    name,
    callCount: 0,
    lastInput: undefined,
    async _call(input: unknown) {
      this.callCount++;
      this.lastInput = input;
      return `result:${JSON.stringify(input)}`;
    },
  };
}

describe("wrapTool", () => {
  it("passes through original input when no redaction stored", async () => {
    const tool = makeTool("search");
    const handler = makeHandler();
    const wrapped = wrapTool(tool, handler);

    const result = await wrapped._call("original query");
    expect(result).toBe('result:"original query"');
    expect(tool.lastInput).toBe("original query");
  });

  it("uses redacted input when stored in buffer", async () => {
    const tool = makeTool("search");
    const handler = makeHandler();
    const buffer = (handler as unknown as { buffer: RunBufferManager }).buffer;

    // Register the run and set redacted input
    buffer.registerRun("run-abc", "tool", "search");
    buffer.setRedactedInput("run-abc", "[REDACTED] query");

    const wrapped = wrapTool(tool, handler);

    // Simulate runManager with runId
    const fakeRunManager = { runId: "run-abc" };
    const result = await (wrapped._call as Function)("original query", fakeRunManager);

    expect(result).toBe('result:"[REDACTED] query"');
    expect(tool.lastInput).toBe("[REDACTED] query");
  });

  it("uses redacted object input when stored", async () => {
    const tool = makeTool("email");
    const handler = makeHandler();
    const buffer = (handler as unknown as { buffer: RunBufferManager }).buffer;

    buffer.registerRun("run-xyz", "tool", "email");
    buffer.setRedactedInput("run-xyz", { to: "[REDACTED]", body: "hello" });

    const wrapped = wrapTool(tool, handler);
    const fakeRunManager = { runId: "run-xyz" };
    await (wrapped._call as Function)({ to: "alice@example.com", body: "hello" }, fakeRunManager);

    expect(tool.lastInput).toEqual({ to: "[REDACTED]", body: "hello" });
  });

  it("returns the same tool instance (mutates in place)", () => {
    const tool = makeTool("search");
    const handler = makeHandler();
    const wrapped = wrapTool(tool, handler);
    expect(wrapped).toBe(tool);
  });

  it("falls back to original input when runManager has no runId", async () => {
    const tool = makeTool("search");
    const handler = makeHandler();
    const buffer = (handler as unknown as { buffer: RunBufferManager }).buffer;
    buffer.registerRun("run-1", "tool", "search");
    buffer.setRedactedInput("run-1", "redacted");

    const wrapped = wrapTool(tool, handler);
    // No runManager — falls back
    const result = await wrapped._call("original");
    expect(tool.lastInput).toBe("original");
    expect(result).toBe('result:"original"');
  });
});

describe("wrapTools", () => {
  it("wraps all tools in array", () => {
    const tools = [makeTool("search"), makeTool("calculator"), makeTool("email")];
    const handler = makeHandler();
    const wrapped = wrapTools(tools as WrappableTool[], handler);
    expect(wrapped).toHaveLength(3);
    wrapped.forEach((t, i) => expect(t).toBe(tools[i]));
  });

  it("each wrapped tool uses its own runId independently", async () => {
    const search = makeTool("search");
    const email = makeTool("email");
    const handler = makeHandler();
    const buffer = (handler as unknown as { buffer: RunBufferManager }).buffer;

    buffer.registerRun("run-search", "tool", "search");
    buffer.setRedactedInput("run-search", "redacted-search");
    buffer.registerRun("run-email", "tool", "email");
    buffer.setRedactedInput("run-email", "redacted-email");

    const [wrappedSearch, wrappedEmail] = wrapTools([search, email] as WrappableTool[], handler);

    await (wrappedSearch!._call as Function)("original-search", { runId: "run-search" });
    await (wrappedEmail!._call as Function)("original-email", { runId: "run-email" });

    expect(search.lastInput).toBe("redacted-search");
    expect(email.lastInput).toBe("redacted-email");
  });
});

describe("wrapLLM", () => {
  it("returns the same LLM instance", () => {
    const llm = {
      generate: vi.fn().mockResolvedValue({ generations: [] }),
    } as unknown as Parameters<typeof wrapLLM>[0];
    const handler = makeHandler();
    const wrapped = wrapLLM(llm, handler);
    expect(wrapped).toBe(llm);
  });

  it("passes through when no redacted input stored", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({ generations: [[{ text: "hello" }]] });
    const llm = { generate: mockGenerate } as unknown as Parameters<typeof wrapLLM>[0];
    const handler = makeHandler();
    const wrapped = wrapLLM(llm, handler);

    const result = await (wrapped as unknown as { generate: Function }).generate(
      ["what is AI?"],
      { runId: "run-1" }
    );

    expect(mockGenerate).toHaveBeenCalledWith(["what is AI?"], { runId: "run-1" }, undefined);
    expect(result.generations).toHaveLength(1);
  });

  it("uses redacted prompts when stored in buffer", async () => {
    const mockGenerate = vi.fn().mockResolvedValue({ generations: [[{ text: "response" }]] });
    const llm = { generate: mockGenerate } as unknown as Parameters<typeof wrapLLM>[0];
    const handler = makeHandler();
    const buffer = (handler as unknown as { buffer: RunBufferManager }).buffer;

    buffer.registerRun("run-llm-1", "llm", "ChatOpenAI");
    buffer.setRedactedInput("run-llm-1", ["[REDACTED] query"]);

    const wrapped = wrapLLM(llm, handler);
    await (wrapped as unknown as { generate: Function }).generate(
      ["original query"],
      { runId: "run-llm-1" }
    );

    expect(mockGenerate).toHaveBeenCalledWith(
      ["[REDACTED] query"],
      { runId: "run-llm-1" },
      undefined
    );
  });

  it("does not wrap if generate is not a function", () => {
    const llm = { model: "gpt-4o" } as unknown as Parameters<typeof wrapLLM>[0];
    const handler = makeHandler();
    // Should not throw
    expect(() => wrapLLM(llm, handler)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// Hook-level REQUIRE_APPROVAL HITL in wrapTool
// ─────────────────────────────────────────────────────────────────

describe("wrapTool — hook-level REQUIRE_APPROVAL HITL", () => {
  afterEach(() => {
    resetHookGovernance();
  });

  it("polls for approval and retries tool call when verdict is require_approval + HITL enabled", async () => {
    const client = {
      evaluateEvent: vi.fn().mockResolvedValue(null),
      validateApiKey: vi.fn().mockResolvedValue(true),
      // First poll returns pending, second returns approved
      pollApproval: vi.fn()
        .mockResolvedValueOnce({ verdict: Verdict.REQUIRE_APPROVAL, expired: false })
        .mockResolvedValueOnce({ verdict: Verdict.ALLOW, expired: false }),
    } as unknown as GovernanceClient;

    const buffer = new RunBufferManager();
    buffer.registerRun("run-1", "tool", "my_tool");

    const handler = new OpenBoxCallbackHandler({
      client,
      buffer,
      hitl: { enabled: true, pollIntervalMs: 1, maxWaitMs: 5000 },
    });

    // Simulate a tool whose _call throws GovernanceBlockedError("require_approval")
    // on the first invocation (hook blocked), succeeds on second (after approval)
    let callCount = 0;
    const tool: WrappableTool = {
      name: "my_tool",
      async _call(input: unknown) {
        callCount++;
        if (callCount === 1) {
          // First call: hook blocks with require_approval
          buffer.setAborted("run-1", "Needs approval");
          throw new GovernanceBlockedError("require_approval", "Needs human review", "https://api.example.com");
        }
        return `approved:${JSON.stringify(input)}`;
      },
    };

    const wrapped = wrapTool(tool, handler);
    const fakeRunManager = { runId: "run-1" };

    const result = await (wrapped._call as Function)("some input", fakeRunManager);

    expect(result).toBe('approved:"some input"');
    expect(callCount).toBe(2);
    // pollApproval should have been called until ALLOW
    expect((client.pollApproval as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("propagates rejection: throws ApprovalRejectedError when reviewer rejects", async () => {
    const client = {
      evaluateEvent: vi.fn().mockResolvedValue(null),
      validateApiKey: vi.fn().mockResolvedValue(true),
      pollApproval: vi.fn().mockResolvedValue({
        verdict: Verdict.BLOCK,
        reason: "Request denied",
        expired: false,
      }),
    } as unknown as GovernanceClient;

    const buffer = new RunBufferManager();
    buffer.registerRun("run-2", "tool", "my_tool");

    const handler = new OpenBoxCallbackHandler({
      client,
      buffer,
      hitl: { enabled: true, pollIntervalMs: 1, maxWaitMs: 5000 },
    });

    const tool: WrappableTool = {
      name: "my_tool",
      async _call() {
        buffer.setAborted("run-2", "Needs approval");
        throw new GovernanceBlockedError("require_approval", "Needs human review", "https://api.example.com");
      },
    };

    const wrapped = wrapTool(tool, handler);
    const fakeRunManager = { runId: "run-2" };

    await expect(
      (wrapped._call as Function)("input", fakeRunManager)
    ).rejects.toThrow(ApprovalRejectedError);
  });

  it("re-throws GovernanceBlockedError as-is when HITL is disabled", async () => {
    const client = {
      evaluateEvent: vi.fn().mockResolvedValue(null),
      validateApiKey: vi.fn().mockResolvedValue(true),
      pollApproval: vi.fn(),
    } as unknown as GovernanceClient;

    const buffer = new RunBufferManager();
    buffer.registerRun("run-3", "tool", "my_tool");

    const handler = new OpenBoxCallbackHandler({
      client,
      buffer,
      hitl: { enabled: false, pollIntervalMs: 1, maxWaitMs: 5000 },
    });

    const tool: WrappableTool = {
      name: "my_tool",
      async _call() {
        throw new GovernanceBlockedError("require_approval", "Needs approval", "https://api.example.com");
      },
    };

    const wrapped = wrapTool(tool, handler);
    const fakeRunManager = { runId: "run-3" };

    const err = await (wrapped._call as Function)("input", fakeRunManager).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GovernanceBlockedError);
    expect((err as GovernanceBlockedError).verdict).toBe("require_approval");
    // pollApproval should never have been called
    expect((client.pollApproval as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("re-throws non-approval GovernanceBlockedError (BLOCK) without polling", async () => {
    const client = {
      evaluateEvent: vi.fn().mockResolvedValue(null),
      validateApiKey: vi.fn().mockResolvedValue(true),
      pollApproval: vi.fn(),
    } as unknown as GovernanceClient;

    const buffer = new RunBufferManager();
    buffer.registerRun("run-4", "tool", "my_tool");

    const handler = new OpenBoxCallbackHandler({
      client,
      buffer,
      hitl: { enabled: true, pollIntervalMs: 1, maxWaitMs: 5000 },
    });

    const tool: WrappableTool = {
      name: "my_tool",
      async _call() {
        throw new GovernanceBlockedError("block", "Policy blocked", "https://api.example.com");
      },
    };

    const wrapped = wrapTool(tool, handler);
    const fakeRunManager = { runId: "run-4" };

    const err = await (wrapped._call as Function)("input", fakeRunManager).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GovernanceBlockedError);
    expect((err as GovernanceBlockedError).verdict).toBe("block");
    // No polling for BLOCK — only REQUIRE_APPROVAL triggers HITL
    expect((client.pollApproval as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("clears abort flag before retry so subsequent hooks can proceed", async () => {
    const client = {
      evaluateEvent: vi.fn().mockResolvedValue(null),
      validateApiKey: vi.fn().mockResolvedValue(true),
      pollApproval: vi.fn().mockResolvedValue({ verdict: Verdict.ALLOW, expired: false }),
    } as unknown as GovernanceClient;

    const buffer = new RunBufferManager();
    buffer.registerRun("run-5", "tool", "my_tool");

    const handler = new OpenBoxCallbackHandler({
      client,
      buffer,
      hitl: { enabled: true, pollIntervalMs: 1, maxWaitMs: 5000 },
    });

    let firstCall = true;
    const tool: WrappableTool = {
      name: "my_tool",
      async _call() {
        if (firstCall) {
          firstCall = false;
          buffer.setAborted("run-5", "Needs approval");
          throw new GovernanceBlockedError("require_approval", "Approval needed", "https://api.example.com");
        }
        // After retry: verify abort flag was cleared
        return `aborted:${buffer.isAborted("run-5")}`;
      },
    };

    const wrapped = wrapTool(tool, handler);
    const result = await (wrapped._call as Function)("x", { runId: "run-5" });
    expect(result).toBe("aborted:false");
  });
});
