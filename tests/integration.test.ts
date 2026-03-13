/**
 * Integration tests — mock OpenBox Core server responses end-to-end.
 *
 * These tests exercise the full callback handler pipeline with a mocked
 * GovernanceClient, verifying that events are built correctly, verdicts
 * are enforced, guardrails redaction flows through, and HITL works.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenBoxCallbackHandler } from "../src/callback-handler.js";
import { GovernanceClient } from "../src/client.js";
import { RunBufferManager } from "../src/run-buffer.js";
import { StreamingTokenBuffer } from "../src/streaming.js";
import { SpanCollector } from "../src/telemetry.js";
import {
  Verdict,
  type GovernanceVerdictResponse,
  type LangChainGovernanceEvent,
} from "../src/types.js";
import {
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
} from "../src/errors.js";

// ─── helpers ──────────────────────────────────────────────────────

function makeVerdict(
  verdict: Verdict,
  overrides: Partial<GovernanceVerdictResponse> = {}
): GovernanceVerdictResponse {
  return { verdict, ...overrides };
}

function makeClient(responseFactory: () => GovernanceVerdictResponse | null) {
  return {
    evaluateEvent: vi.fn().mockImplementation(() => Promise.resolve(responseFactory())),
    pollApproval: vi.fn().mockResolvedValue(makeVerdict(Verdict.ALLOW)),
    validateApiKey: vi.fn().mockResolvedValue(true),
  } as unknown as GovernanceClient;
}

const CHAIN_SERIALIZED = { id: ["langchain", "chains", "ConversationChain"], lc_kwargs: {} };
const LLM_SERIALIZED = { id: ["langchain", "chat_models", "ChatOpenAI"], lc_kwargs: {} };
const TOOL_SERIALIZED = { id: ["langchain", "tools", "SearchTool"], lc_kwargs: {} };
const RETRIEVER_SERIALIZED = { id: ["langchain", "retrievers", "VectorStoreRetriever"], lc_kwargs: {} };

function makeLLMResult(text = "Hello from LLM") {
  return {
    generations: [[{ text, message: { content: text } }]],
    llmOutput: {
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    },
  };
}

function makeHandler(client: GovernanceClient) {
  return new OpenBoxCallbackHandler({
    client,
    buffer: new RunBufferManager(),
    streamingBuffer: new StreamingTokenBuffer(),
    spanCollector: new SpanCollector(),
    sendChainStartEvent: true,
    sendChainEndEvent: true,
    sendToolStartEvent: true,
    sendToolEndEvent: true,
    sendLLMStartEvent: true,
    sendLLMEndEvent: true,
  });
}

// ─── Chain events ─────────────────────────────────────────────────

describe("Chain events", () => {
  it("sends ChainStarted event with correct fields", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleChainStart(
      CHAIN_SERIALIZED as any,
      { input: "hello" },
      "chain-run-1",
      undefined,
      [],
      {},
      "chain",
      "ConversationChain"
    );

    expect(client.evaluateEvent).toHaveBeenCalledOnce();
    const event = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as LangChainGovernanceEvent;
    expect(event.event_type).toBe("ChainStarted");
    expect(event.workflow_id).toBe("chain-run-1");
    expect(event.activity_id).toBe("chain-run-1");
    expect(event.activity_type).toBe("ConversationChain");
    expect(event.source).toBe("langchain-telemetry");
    expect(event.attempt).toBe(1);
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("sends ChainCompleted event with duration_ms", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleChainStart(CHAIN_SERIALIZED as any, {}, "chain-2");
    await handler.handleChainEnd({ output: "result" }, "chain-2");

    const completedCall = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls[1];
    const event = completedCall[0] as LangChainGovernanceEvent;
    expect(event.event_type).toBe("ChainCompleted");
    expect(event.status).toBe("completed");
    expect(event.duration_ms).toBeGreaterThanOrEqual(0);
    expect(event.activity_id).toBe("chain-2");
  });

  it("sends ChainFailed event on error", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleChainStart(CHAIN_SERIALIZED as any, {}, "chain-3");
    await handler.handleChainError(new Error("chain failed"), "chain-3");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const failedEvent = calls[1][0] as LangChainGovernanceEvent;
    expect(failedEvent.event_type).toBe("ChainFailed");
    expect(failedEvent.status).toBe("failed");
    expect(failedEvent.error?.message).toBe("chain failed");
  });

  it("throws GovernanceBlockedError on BLOCK verdict", async () => {
    const client = makeClient(() => makeVerdict(Verdict.BLOCK, { reason: "Policy violation" }));
    const handler = makeHandler(client);

    await expect(
      handler.handleChainStart(CHAIN_SERIALIZED as any, {}, "chain-block")
    ).rejects.toThrow(GovernanceBlockedError);
  });

  it("throws GovernanceHaltError on HALT verdict", async () => {
    const client = makeClient(() => makeVerdict(Verdict.HALT, { reason: "Critical halt" }));
    const handler = makeHandler(client);

    await expect(
      handler.handleChainStart(CHAIN_SERIALIZED as any, {}, "chain-halt")
    ).rejects.toThrow(GovernanceHaltError);
  });

  it("continues on ALLOW when no event config set (event disabled)", async () => {
    const client = makeClient(() => makeVerdict(Verdict.BLOCK));
    const handler = new OpenBoxCallbackHandler({
      client,
      buffer: new RunBufferManager(),
      sendChainStartEvent: false, // disabled
    });

    // Should not throw because event is disabled
    await expect(
      handler.handleChainStart(CHAIN_SERIALIZED as any, {}, "chain-5")
    ).resolves.toBeUndefined();
    expect(client.evaluateEvent).not.toHaveBeenCalled();
  });

  it("skips chain types in skipChainTypes", async () => {
    const client = makeClient(() => makeVerdict(Verdict.BLOCK));
    const handler = new OpenBoxCallbackHandler({
      client,
      buffer: new RunBufferManager(),
      sendChainStartEvent: true,
      skipChainTypes: new Set(["InternalChain"]),
    });

    await expect(
      handler.handleChainStart(CHAIN_SERIALIZED as any, {}, "chain-skip", undefined, [], {}, "chain", "InternalChain")
    ).resolves.toBeUndefined();
    expect(client.evaluateEvent).not.toHaveBeenCalled();
  });
});

// ─── LLM events ──────────────────────────────────────────────────

describe("LLM events", () => {
  it("sends LLMStarted with prompt and model", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleLLMStart(
      LLM_SERIALIZED as any,
      ["Tell me about AI"],
      "llm-1",
      "chain-1"
    );

    const event = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as LangChainGovernanceEvent;
    expect(event.event_type).toBe("LLMStarted");
    expect(event.activity_id).toBe("llm-1");
    expect(event.prompt).toContain("Tell me about AI");
  });

  it("sends LLMCompleted with token usage and completion", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleLLMStart(LLM_SERIALIZED as any, ["prompt"], "llm-2", "chain-1");
    await handler.handleLLMEnd(makeLLMResult("The answer is 42") as any, "llm-2", "chain-1");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const completedEvent = calls[1][0] as LangChainGovernanceEvent;
    expect(completedEvent.event_type).toBe("LLMCompleted");
    expect(completedEvent.input_tokens).toBe(10);
    expect(completedEvent.output_tokens).toBe(5);
    expect(completedEvent.total_tokens).toBe(15);
    expect(completedEvent.completion).toContain("The answer is 42");
    expect(completedEvent.status).toBe("completed");
  });

  it("accumulates streamed tokens into completion", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleLLMStart(LLM_SERIALIZED as any, ["prompt"], "llm-stream", "chain-1");
    await handler.handleLLMNewToken("Hello", { prompt: 0, completion: 0 }, "llm-stream");
    await handler.handleLLMNewToken(" ", { prompt: 0, completion: 1 }, "llm-stream");
    await handler.handleLLMNewToken("world", { prompt: 0, completion: 2 }, "llm-stream");
    await handler.handleLLMEnd(makeLLMResult("") as any, "llm-stream", "chain-1");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const completedEvent = calls[1][0] as LangChainGovernanceEvent;
    expect(completedEvent.completion).toBe("Hello world");
  });

  it("applies guardrails input redaction and stores in buffer", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW, {
      guardrails_result: {
        input_type: "activity_input",
        redacted_input: ["[REDACTED] prompt"],
        validation_passed: true,
        reasons: [],
      },
    }));
    const handler = makeHandler(client);
    const buffer = (handler as unknown as { buffer: RunBufferManager }).buffer;

    await handler.handleLLMStart(LLM_SERIALIZED as any, ["sensitive data"], "llm-redact");

    const redacted = buffer.getRedactedInput("llm-redact");
    // applyInputRedaction returns the redacted_input value from the server response directly
    expect(redacted).toEqual("[REDACTED] prompt");
  });

  it("throws GuardrailsValidationError when input validation_passed=false", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW, {
      guardrails_result: {
        input_type: "activity_input",
        redacted_input: null,
        validation_passed: false,
        reasons: [{ type: "pii", field: "prompt", reason: "Contains SSN" }],
      },
    }));
    const handler = makeHandler(client);

    await expect(
      handler.handleLLMStart(LLM_SERIALIZED as any, ["SSN: 123-45-6789"], "llm-guard")
    ).rejects.toThrow(GuardrailsValidationError);
  });

  it("sends LLMFailed event with error details", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleLLMStart(LLM_SERIALIZED as any, ["prompt"], "llm-fail");
    await handler.handleLLMError(new Error("Rate limit exceeded"), "llm-fail");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const failedEvent = calls[1][0] as LangChainGovernanceEvent;
    expect(failedEvent.event_type).toBe("LLMFailed");
    expect(failedEvent.error?.message).toBe("Rate limit exceeded");
  });
});

// ─── Tool events ─────────────────────────────────────────────────

describe("Tool events", () => {
  it("sends ToolStarted event with tool_name and input", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleToolStart(TOOL_SERIALIZED as any, "search query", "tool-1", "chain-1");

    const event = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as LangChainGovernanceEvent;
    expect(event.event_type).toBe("ToolStarted");
    expect(event.tool_name).toBe("SearchTool");
    expect(event.activity_input).toContain("search query");
    expect(event.attempt).toBe(1);
  });

  it("throws GovernanceBlockedError when ToolStarted returns BLOCK", async () => {
    const client = makeClient(() => makeVerdict(Verdict.BLOCK, { reason: "Forbidden tool" }));
    const handler = makeHandler(client);

    await expect(
      handler.handleToolStart(TOOL_SERIALIZED as any, "dangerous input", "tool-block")
    ).rejects.toThrow(GovernanceBlockedError);
  });

  it("sends ToolCompleted with redacted input if available", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW, {
      guardrails_result: {
        input_type: "activity_input",
        redacted_input: "[REDACTED]",
        validation_passed: true,
        reasons: [],
      },
    }));
    const handler = makeHandler(client);

    await handler.handleToolStart(TOOL_SERIALIZED as any, "original input", "tool-2");
    await handler.handleToolEnd("tool output", "tool-2");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const completedEvent = calls[1][0] as LangChainGovernanceEvent;
    expect(completedEvent.event_type).toBe("ToolCompleted");
    expect(completedEvent.activity_input).toEqual(["[REDACTED]"]);
    expect(completedEvent.activity_output).toBe("tool output");
  });

  it("sends ToolFailed event on error", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleToolStart(TOOL_SERIALIZED as any, "query", "tool-fail");
    await handler.handleToolError(new Error("Tool crashed"), "tool-fail");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const failedEvent = calls[1][0] as LangChainGovernanceEvent;
    expect(failedEvent.event_type).toBe("ToolFailed");
    expect(failedEvent.status).toBe("failed");
  });

  it("skips tool types in skipToolTypes", async () => {
    const client = makeClient(() => makeVerdict(Verdict.BLOCK));
    const handler = new OpenBoxCallbackHandler({
      client,
      buffer: new RunBufferManager(),
      sendToolStartEvent: true,
      skipToolTypes: new Set(["SearchTool"]),
    });

    await expect(
      handler.handleToolStart(TOOL_SERIALIZED as any, "query", "tool-skip")
    ).resolves.toBeUndefined();
    expect(client.evaluateEvent).not.toHaveBeenCalled();
  });

  it("throws GuardrailsValidationError on invalid tool output", async () => {
    let callCount = 0;
    const client = {
      evaluateEvent: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(makeVerdict(Verdict.ALLOW)); // ToolStarted
        return Promise.resolve(makeVerdict(Verdict.ALLOW, {             // ToolCompleted
          guardrails_result: {
            input_type: "activity_output",
            redacted_input: null,
            validation_passed: false,
            reasons: [{ type: "pii", field: "output", reason: "Contains credit card" }],
          },
        }));
      }),
      pollApproval: vi.fn(),
      validateApiKey: vi.fn(),
    } as unknown as GovernanceClient;

    const handler = makeHandler(client);
    await handler.handleToolStart(TOOL_SERIALIZED as any, "query", "tool-out-guard");

    await expect(
      handler.handleToolEnd("CC: 4111-1111-1111-1111", "tool-out-guard")
    ).rejects.toThrow(GuardrailsValidationError);
  });
});

// ─── Agent events ─────────────────────────────────────────────────

describe("Agent events", () => {
  it("sends AgentAction event", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);
    const buffer = (handler as unknown as { buffer: RunBufferManager }).buffer;
    buffer.registerRun("chain-1", "chain", "AgentExecutor");

    await handler.handleAgentAction(
      { tool: "search", toolInput: "query", log: "" },
      "chain-1"
    );

    const event = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as LangChainGovernanceEvent;
    expect(event.event_type).toBe("AgentAction");
    expect(event.tool_name).toBe("search");
    expect(event.tool_input).toBe("query");
  });

  it("throws GovernanceBlockedError on BLOCK verdict for agent action", async () => {
    const client = makeClient(() => makeVerdict(Verdict.BLOCK, { reason: "Tool not allowed" }));
    const handler = makeHandler(client);
    const buffer = (handler as unknown as { buffer: RunBufferManager }).buffer;
    buffer.registerRun("chain-blocked", "chain", "AgentExecutor");

    await expect(
      handler.handleAgentAction(
        { tool: "dangerous_tool", toolInput: "payload", log: "" },
        "chain-blocked"
      )
    ).rejects.toThrow(GovernanceBlockedError);
  });

  it("does not enforce when enforceAgentActions=false", async () => {
    const client = makeClient(() => makeVerdict(Verdict.BLOCK));
    const handler = new OpenBoxCallbackHandler({
      client,
      buffer: new RunBufferManager(),
      enforceAgentActions: false,
    });
    const buffer = (handler as unknown as { buffer: RunBufferManager }).buffer;
    buffer.registerRun("chain-noenfforce", "chain", "AgentExecutor");

    await expect(
      handler.handleAgentAction(
        { tool: "search", toolInput: "query", log: "" },
        "chain-noenfforce"
      )
    ).resolves.toBeUndefined();
  });

  it("sends AgentFinish event", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);
    const buffer = (handler as unknown as { buffer: RunBufferManager }).buffer;
    buffer.registerRun("chain-finish", "chain", "AgentExecutor");

    await handler.handleAgentFinish(
      { returnValues: { output: "final answer" }, log: "" },
      "chain-finish"
    );

    const event = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as LangChainGovernanceEvent;
    expect(event.event_type).toBe("AgentFinish");
    expect(event.status).toBe("completed");
  });
});

// ─── Retriever events ─────────────────────────────────────────────

describe("Retriever events", () => {
  it("sends RetrieverStarted and RetrieverCompleted", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleRetrieverStart(RETRIEVER_SERIALIZED as any, "find documents", "ret-1", "chain-1");
    await handler.handleRetrieverEnd(
      [{ pageContent: "doc content", metadata: {} }] as any,
      "ret-1",
      "chain-1"
    );

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].event_type).toBe("RetrieverStarted");
    expect(calls[1][0].event_type).toBe("RetrieverCompleted");
    expect(calls[1][0].status).toBe("completed");
  });
});

// ─── Run hierarchy ────────────────────────────────────────────────

describe("Run hierarchy tracking", () => {
  it("nested runs have correct root run_id in events", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleChainStart(CHAIN_SERIALIZED as any, {}, "root-chain");
    await handler.handleLLMStart(LLM_SERIALIZED as any, ["prompt"], "llm-nested", "root-chain");
    await handler.handleToolStart(TOOL_SERIALIZED as any, "query", "tool-nested", "root-chain");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    // All events should reference root-chain as workflow_id
    calls.forEach(([event]: [LangChainGovernanceEvent]) => {
      expect(event.workflow_id).toBe("root-chain");
    });
  });

  it("attempt counter increments on re-registration", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleToolStart(TOOL_SERIALIZED as any, "q", "tool-retry");
    await handler.handleToolStart(TOOL_SERIALIZED as any, "q", "tool-retry"); // re-register

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].attempt).toBe(1);
    expect(calls[1][0].attempt).toBe(2);
  });
});

// ─── Pending verdict check ────────────────────────────────────────

describe("Pre-execution pending verdict check", () => {
  it("throws if buffer has stored BLOCK verdict", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);
    const buffer = (handler as unknown as { buffer: RunBufferManager }).buffer;

    buffer.registerRun("tool-pre-block", "tool", "search");
    buffer.setVerdictForRun("tool-pre-block", Verdict.BLOCK, "Pre-blocked");

    await expect(
      handler.handleToolStart(TOOL_SERIALIZED as any, "query", "tool-pre-block")
    ).rejects.toThrow(GovernanceBlockedError);
    // evaluateEvent should NOT be called — blocked before sending
    expect(client.evaluateEvent).not.toHaveBeenCalled();
  });

  it("throws GovernanceHaltError if buffer has HALT verdict", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);
    const buffer = (handler as unknown as { buffer: RunBufferManager }).buffer;

    buffer.registerRun("tool-pre-halt", "tool", "search");
    buffer.setVerdictForRun("tool-pre-halt", Verdict.HALT, "Halted");

    await expect(
      handler.handleToolStart(TOOL_SERIALIZED as any, "query", "tool-pre-halt")
    ).rejects.toThrow(GovernanceHaltError);
  });
});

// ─── Fail open / closed ───────────────────────────────────────────

describe("Fail-open policy", () => {
  it("continues execution when evaluateEvent returns null (fail-open)", async () => {
    const client = makeClient(() => null);
    const handler = makeHandler(client);

    // Should not throw despite null response
    await expect(
      handler.handleChainStart(CHAIN_SERIALIZED as any, {}, "chain-null")
    ).resolves.toBeUndefined();
  });
});

// ─── Temporal SDK alignment ───────────────────────────────────────
// These tests verify the LangChain SDK emits the same server-contract
// fields as the Temporal Python SDK's ActivityGovernanceInterceptor.

describe("Temporal SDK alignment — server event type mapping", () => {
  it("ChainStarted maps to WorkflowStarted on the wire", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleChainStart(CHAIN_SERIALIZED as any, {}, "chain-wf");

    const [sentEvent] = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls[0] as [LangChainGovernanceEvent];
    // SDK-internal type preserved in event_type
    expect(sentEvent.event_type).toBe("ChainStarted");
    // Verify toServerEventType maps it correctly (mirrors Temporal WorkflowStarted)
    const { toServerEventType } = await import("../src/types.js");
    expect(toServerEventType("ChainStarted")).toBe("WorkflowStarted");
    expect(toServerEventType("ChainCompleted")).toBe("WorkflowCompleted");
    expect(toServerEventType("ChainFailed")).toBe("WorkflowFailed");
  });

  it("ToolStarted/Completed map to ActivityStarted/Completed (mirrors Temporal activity lifecycle)", async () => {
    const { toServerEventType } = await import("../src/types.js");
    expect(toServerEventType("ToolStarted")).toBe("ActivityStarted");
    expect(toServerEventType("ToolCompleted")).toBe("ActivityCompleted");
    expect(toServerEventType("ToolFailed")).toBe("ActivityCompleted");
  });

  it("LLMStarted/Completed map to ActivityStarted/Completed", async () => {
    const { toServerEventType } = await import("../src/types.js");
    expect(toServerEventType("LLMStarted")).toBe("ActivityStarted");
    expect(toServerEventType("LLMCompleted")).toBe("ActivityCompleted");
    expect(toServerEventType("LLMFailed")).toBe("ActivityCompleted");
  });

  it("AgentAction maps to ActivityStarted, AgentFinish to ActivityCompleted", async () => {
    const { toServerEventType } = await import("../src/types.js");
    expect(toServerEventType("AgentAction")).toBe("ActivityStarted");
    expect(toServerEventType("AgentFinish")).toBe("ActivityCompleted");
  });

  it("RetrieverStarted maps to ActivityStarted, RetrieverCompleted to ActivityCompleted", async () => {
    const { toServerEventType } = await import("../src/types.js");
    expect(toServerEventType("RetrieverStarted")).toBe("ActivityStarted");
    expect(toServerEventType("RetrieverCompleted")).toBe("ActivityCompleted");
    expect(toServerEventType("RetrieverFailed")).toBe("ActivityCompleted");
  });
});

describe("Temporal SDK alignment — activity_type field", () => {
  it("ToolStarted sends activity_type = tool name (mirrors Temporal activity_type)", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleToolStart(TOOL_SERIALIZED as any, "query", "tool-at-1", "chain-1");

    const event = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as LangChainGovernanceEvent;
    expect(event.activity_type).toBe("SearchTool");
  });

  it("ToolCompleted sends activity_type and duration_ms (mirrors Temporal ActivityCompleted)", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleToolStart(TOOL_SERIALIZED as any, "query", "tool-at-2");
    await handler.handleToolEnd("result", "tool-at-2");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const completedEvent = calls[1][0] as LangChainGovernanceEvent;
    expect(completedEvent.event_type).toBe("ToolCompleted");
    expect(completedEvent.activity_type).toBe("SearchTool");
    expect(completedEvent.duration_ms).toBeGreaterThanOrEqual(0);
    expect(completedEvent.status).toBe("completed");
  });

  it("LLMStarted does NOT send activity_type (prevents LLM class names polluting tool health matrix)", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleLLMStart(LLM_SERIALIZED as any, ["prompt"], "llm-at-1", "chain-1");

    const event = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as LangChainGovernanceEvent;
    expect(event.event_type).toBe("LLMStarted");
    expect(event.activity_type).toBeUndefined();
  });

  it("LLMCompleted does NOT send activity_type", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleLLMStart(LLM_SERIALIZED as any, ["prompt"], "llm-at-2");
    await handler.handleLLMEnd(makeLLMResult() as any, "llm-at-2");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const completedEvent = calls[1][0] as LangChainGovernanceEvent;
    expect(completedEvent.event_type).toBe("LLMCompleted");
    expect(completedEvent.activity_type).toBeUndefined();
  });

  it("LLMFailed does NOT send activity_type", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleLLMStart(LLM_SERIALIZED as any, ["prompt"], "llm-at-3");
    await handler.handleLLMError(new Error("timeout"), "llm-at-3");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const failedEvent = calls[1][0] as LangChainGovernanceEvent;
    expect(failedEvent.event_type).toBe("LLMFailed");
    expect(failedEvent.activity_type).toBeUndefined();
  });
});

describe("Temporal SDK alignment — task_queue field", () => {
  it("all events include task_queue field (required by server Temporal contract)", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleChainStart(CHAIN_SERIALIZED as any, {}, "chain-tq");
    await handler.handleLLMStart(LLM_SERIALIZED as any, ["p"], "llm-tq", "chain-tq");
    await handler.handleToolStart(TOOL_SERIALIZED as any, "q", "tool-tq", "chain-tq");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    calls.forEach(([event]: [LangChainGovernanceEvent]) => {
      expect(event.task_queue).toBeDefined();
      expect(typeof event.task_queue).toBe("string");
      expect(event.task_queue.length).toBeGreaterThan(0);
    });
  });
});

describe("Temporal SDK alignment — parent_run_id propagation", () => {
  it("nested tool events carry parent_run_id pointing to chain run", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleChainStart(CHAIN_SERIALIZED as any, {}, "chain-parent");
    await handler.handleToolStart(TOOL_SERIALIZED as any, "query", "tool-child", "chain-parent");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const toolEvent = calls[1][0] as LangChainGovernanceEvent;
    expect(toolEvent.parent_run_id).toBe("chain-parent");
  });

  it("nested LLM events carry parent_run_id pointing to chain run", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleChainStart(CHAIN_SERIALIZED as any, {}, "chain-parent-llm");
    await handler.handleLLMStart(LLM_SERIALIZED as any, ["p"], "llm-child", "chain-parent-llm");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const llmEvent = calls[1][0] as LangChainGovernanceEvent;
    expect(llmEvent.parent_run_id).toBe("chain-parent-llm");
  });
});

describe("Temporal SDK alignment — synthetic span for LLM observability", () => {
  it("LLMCompleted injects synthetic span with response_body containing token usage JSON", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleLLMStart(LLM_SERIALIZED as any, ["prompt"], "llm-span-1");
    await handler.handleLLMEnd(makeLLMResult() as any, "llm-span-1");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const completedEvent = calls[1][0] as LangChainGovernanceEvent;

    expect(completedEvent.spans).toBeDefined();
    expect(completedEvent.spans!.length).toBeGreaterThanOrEqual(1);

    const syntheticSpan = completedEvent.spans!.find(s => s.span_id.startsWith("llm-token-"));
    expect(syntheticSpan).toBeDefined();
    expect(syntheticSpan!.response_body).toBeDefined();

    const body = JSON.parse(syntheticSpan!.response_body!);
    expect(body.usage).toBeDefined();
  });

  it("synthetic span response_body contains model field for model usage chart", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleLLMStart(LLM_SERIALIZED as any, ["prompt"], "llm-span-2");
    await handler.handleLLMEnd(makeLLMResult() as any, "llm-span-2");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const completedEvent = calls[1][0] as LangChainGovernanceEvent;

    const syntheticSpan = completedEvent.spans!.find(s => s.span_id.startsWith("llm-token-"));
    expect(syntheticSpan).toBeDefined();

    const body = JSON.parse(syntheticSpan!.response_body!);
    expect(body.model).toBeDefined();
    expect(typeof body.model).toBe("string");
  });

  it("synthetic span contains duration_ns for latency distribution", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleLLMStart(LLM_SERIALIZED as any, ["prompt"], "llm-span-3");
    await handler.handleLLMEnd(makeLLMResult() as any, "llm-span-3");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const completedEvent = calls[1][0] as LangChainGovernanceEvent;

    const syntheticSpan = completedEvent.spans!.find(s => s.span_id.startsWith("llm-token-"));
    expect(syntheticSpan).toBeDefined();
    expect(syntheticSpan!.duration_ns).toBeTypeOf("number");
    expect(syntheticSpan!.duration_ns).toBeGreaterThanOrEqual(0);
  });

  it("synthetic span has llm.synthetic=true attribute to identify it", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleLLMStart(LLM_SERIALIZED as any, ["prompt"], "llm-span-4");
    await handler.handleLLMEnd(makeLLMResult() as any, "llm-span-4");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const completedEvent = calls[1][0] as LangChainGovernanceEvent;

    const syntheticSpan = completedEvent.spans!.find(s => s.span_id.startsWith("llm-token-"));
    expect(syntheticSpan!.attributes?.["llm.synthetic"]).toBe(true);
  });

  it("LLMCompleted with no tokens does NOT inject synthetic span", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    const emptyResult = {
      generations: [[{ text: "ok", message: { content: "ok" } }]],
      llmOutput: { tokenUsage: {} },
    };

    await handler.handleLLMStart(LLM_SERIALIZED as any, ["prompt"], "llm-span-5");
    await handler.handleLLMEnd(emptyResult as any, "llm-span-5");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    const completedEvent = calls[1][0] as LangChainGovernanceEvent;

    const syntheticSpan = completedEvent.spans?.find(s => s.span_id.startsWith("llm-token-"));
    expect(syntheticSpan).toBeUndefined();
  });
});

describe("Temporal SDK alignment — workflow/run identity fields", () => {
  it("all events include workflow_id, run_id, workflow_type, and source", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleChainStart(
      CHAIN_SERIALIZED as any, {}, "wf-id-1", undefined, [], {}, "chain", "MyChain"
    );

    const event = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as LangChainGovernanceEvent;
    expect(event.workflow_id).toBe("wf-id-1");
    expect(event.run_id).toBe("wf-id-1");
    expect(event.workflow_type).toBeDefined();
    expect(event.source).toBe("langchain-telemetry");
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("nested activities inherit root workflow_id as their workflow_id", async () => {
    const client = makeClient(() => makeVerdict(Verdict.ALLOW));
    const handler = makeHandler(client);

    await handler.handleChainStart(CHAIN_SERIALIZED as any, {}, "root-wf");
    await handler.handleToolStart(TOOL_SERIALIZED as any, "q", "act-1", "root-wf");
    await handler.handleLLMStart(LLM_SERIALIZED as any, ["p"], "act-2", "root-wf");

    const calls = (client.evaluateEvent as ReturnType<typeof vi.fn>).mock.calls;
    calls.forEach(([event]: [LangChainGovernanceEvent]) => {
      expect(event.workflow_id).toBe("root-wf");
    });
  });
});
