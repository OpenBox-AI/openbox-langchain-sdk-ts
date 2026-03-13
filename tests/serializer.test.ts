import { describe, it, expect } from "vitest";
import {
  safeSerialize,
  extractPromptText,
  extractCompletionText,
  extractTokenUsage,
  extractModelName,
  extractFinishReason,
  rfc3339Now,
} from "../src/serializer.js";

describe("safeSerialize", () => {
  it("passes through primitives", () => {
    expect(safeSerialize("hello")).toBe("hello");
    expect(safeSerialize(42)).toBe(42);
    expect(safeSerialize(true)).toBe(true);
    expect(safeSerialize(null)).toBeNull();
    expect(safeSerialize(undefined)).toBeUndefined();
  });

  it("converts bigint to string", () => {
    expect(safeSerialize(BigInt("9007199254740993"))).toBe("9007199254740993");
  });

  it("converts Date to ISO string", () => {
    const d = new Date("2024-01-15T10:00:00.000Z");
    expect(safeSerialize(d)).toBe("2024-01-15T10:00:00.000Z");
  });

  it("serializes plain objects", () => {
    const result = safeSerialize({ a: 1, b: "two" }) as Record<string, unknown>;
    expect(result["a"]).toBe(1);
    expect(result["b"]).toBe("two");
  });

  it("serializes arrays", () => {
    const result = safeSerialize([1, "two", null]) as unknown[];
    expect(result).toEqual([1, "two", null]);
  });

  it("truncates long strings", () => {
    const long = "x".repeat(15_000);
    const result = safeSerialize(long) as string;
    expect(result.endsWith("...[truncated]")).toBe(true);
    expect(result.length).toBeLessThan(long.length);
  });

  it("handles LangChain message-like objects (has lc_id)", () => {
    const msg = {
      lc_id: ["langchain_core", "messages", "AIMessage"],
      content: "Hello, how can I help?",
      role: "assistant",
      additional_kwargs: {},
      _getType: () => "ai",
    };
    const result = safeSerialize(msg) as Record<string, unknown>;
    expect(result["content"]).toBe("Hello, how can I help?");
    expect(result["type"]).toBe("ai");
  });

  it("handles LangChain Document-like objects", () => {
    const doc = {
      pageContent: "Some document text",
      metadata: { source: "file.pdf", page: 1 },
    };
    const result = safeSerialize(doc) as Record<string, unknown>;
    expect(result["pageContent"]).toBe("Some document text");
    expect((result["metadata"] as Record<string, unknown>)["source"]).toBe("file.pdf");
  });

  it("handles LangChain LLMResult-like objects", () => {
    const result_obj = {
      generations: [[{ text: "Hello!" }]],
      llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    };
    const result = safeSerialize(result_obj) as Record<string, unknown>;
    expect(result["generations"]).toBeDefined();
    expect(result["llmOutput"]).toBeDefined();
  });

  it("stops at max depth", () => {
    let nested: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 12; i++) {
      nested = { child: nested };
    }
    // Should not throw, returns [max depth exceeded] somewhere deep
    expect(() => safeSerialize(nested)).not.toThrow();
  });

  it("returns [function] for functions", () => {
    expect(safeSerialize(() => {})).toBe("[function]");
  });
});

describe("extractPromptText", () => {
  it("handles string input", () => {
    expect(extractPromptText("What is AI?")).toBe("What is AI?");
  });

  it("handles string[][] (LLM format)", () => {
    const prompts = [["Hello", "How are you?"]];
    expect(extractPromptText(prompts)).toContain("Hello");
    expect(extractPromptText(prompts)).toContain("How are you?");
  });

  it("handles message array with content field", () => {
    const msgs = [[{ content: "Explain quantum physics" }]];
    expect(extractPromptText(msgs)).toContain("Explain quantum physics");
  });

  it("returns empty string for null/undefined", () => {
    expect(extractPromptText(null)).toBe("");
    expect(extractPromptText(undefined)).toBe("");
  });
});

describe("extractCompletionText", () => {
  it("extracts text from generations", () => {
    const output = {
      generations: [[{ text: "This is the answer." }]],
      llmOutput: {},
    };
    expect(extractCompletionText(output)).toBe("This is the answer.");
  });

  it("extracts from message.content", () => {
    const output = {
      generations: [[{ message: { content: "Chat response here" }, generationInfo: {} }]],
      llmOutput: {},
    };
    expect(extractCompletionText(output)).toContain("Chat response here");
  });

  it("returns empty string for missing generations", () => {
    expect(extractCompletionText({ llmOutput: {} })).toBe("");
    expect(extractCompletionText(null)).toBe("");
  });

  it("joins multiple generations", () => {
    const output = {
      generations: [[{ text: "Part 1" }, { text: "Part 2" }]],
      llmOutput: {},
    };
    const result = extractCompletionText(output);
    expect(result).toContain("Part 1");
    expect(result).toContain("Part 2");
  });
});

describe("extractTokenUsage", () => {
  it("extracts standard tokenUsage format", () => {
    const output = {
      llmOutput: {
        tokenUsage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        },
      },
    };
    const result = extractTokenUsage(output);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.totalTokens).toBe(150);
  });

  it("extracts snake_case format", () => {
    const output = {
      llmOutput: {
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          total_tokens: 280,
        },
      },
    };
    const result = extractTokenUsage(output);
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(80);
  });

  it("returns empty object when no llmOutput", () => {
    expect(extractTokenUsage({ generations: [] })).toEqual({});
    expect(extractTokenUsage(null)).toEqual({});
  });

  it("returns empty object when tokenUsage absent", () => {
    expect(extractTokenUsage({ llmOutput: {} })).toEqual({});
  });
});

describe("extractModelName", () => {
  it("extracts model_name field", () => {
    expect(extractModelName({ model_name: "gpt-4o" })).toBe("gpt-4o");
  });

  it("extracts model field", () => {
    expect(extractModelName({ model: "claude-3-5-sonnet" })).toBe("claude-3-5-sonnet");
  });

  it("extracts modelName (camelCase)", () => {
    expect(extractModelName({ modelName: "gemini-pro" })).toBe("gemini-pro");
  });

  it("extracts from nested kwargs", () => {
    expect(extractModelName({ kwargs: { model_name: "gpt-4-turbo" } })).toBe("gpt-4-turbo");
  });

  it("returns undefined when not found", () => {
    expect(extractModelName({})).toBeUndefined();
    expect(extractModelName(null)).toBeUndefined();
  });
});

describe("extractFinishReason", () => {
  it("extracts finish_reason from generationInfo", () => {
    const output = {
      generations: [
        [{ text: "done", generationInfo: { finish_reason: "stop" } }],
      ],
    };
    expect(extractFinishReason(output)).toBe("stop");
  });

  it("returns undefined when not available", () => {
    expect(extractFinishReason({})).toBeUndefined();
    expect(extractFinishReason(null)).toBeUndefined();
    expect(extractFinishReason({ generations: [] })).toBeUndefined();
  });
});

describe("rfc3339Now", () => {
  it("returns a valid ISO date string ending in Z", () => {
    const ts = rfc3339Now();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("returns a recent timestamp", () => {
    const before = Date.now();
    const ts = rfc3339Now();
    const after = Date.now();
    const parsed = new Date(ts).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});
