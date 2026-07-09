import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  enrichActivityInput,
  extractResponseMetadata
} from "../src/lifecycle-events-envelopes.js";

describe("enrichActivityInput (__openbox sentinel)", () => {
  it("appends the sentinel with only the set keys, at the end", () => {
    const out = enrichActivityInput([{ prompt: "hi" }], {
      toolType: "search",
      subagentName: null
    });
    expect(out).toEqual([{ prompt: "hi" }, { __openbox: { tool_type: "search" } }]);
  });

  it("includes both classification keys when present", () => {
    const out = enrichActivityInput(null, { toolType: "search", subagentName: "researcher" });
    expect(out).toEqual([
      { __openbox: { tool_type: "search", subagent_name: "researcher" } }
    ]);
  });

  it("returns the base input unchanged (copied) for an unclassified tool", () => {
    const base = [{ prompt: "hi" }];
    const out = enrichActivityInput(base, {});
    expect(out).toEqual(base);
    expect(out).not.toBe(base); // copied, not the same reference
    expect(enrichActivityInput(null, {})).toBeNull();
  });
});

describe("extractResponseMetadata", () => {
  it("pulls model, tokens, completion, and tool-call flag from a response", () => {
    // Duck-typed input (an AIMessage-shaped object or a real AIMessage both work).
    const message = {
      content: "the answer",
      response_metadata: { model_name: "gpt-x" },
      usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
    };
    const meta = extractResponseMetadata(message);
    expect(meta.llm_model).toBe("gpt-x");
    expect(meta.input_tokens).toBe(10);
    expect(meta.output_tokens).toBe(4);
    expect(meta.total_tokens).toBe(14);
    expect(meta.completion).toBe("the answer");
    expect(meta.has_tool_calls).toBe(false);
  });

  it("unwraps a generation wrapper carrying .message and detects tool calls", () => {
    const message = new AIMessage({
      content: "",
      tool_calls: [{ name: "echo", args: {}, id: "c1", type: "tool_call" }]
    });
    const meta = extractResponseMetadata({ message });
    expect(meta.has_tool_calls).toBe(true);
  });

  it("joins text parts from multimodal completion content", () => {
    const message = {
      content: [
        { type: "text", text: "part one" },
        { type: "text", text: "part two" }
      ]
    };
    expect(extractResponseMetadata(message).completion).toBe("part one part two");
  });

  it("is resilient to a bare/empty response", () => {
    const meta = extractResponseMetadata({});
    expect(meta.has_tool_calls).toBe(false);
  });
});
