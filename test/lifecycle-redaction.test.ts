import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  buildRedactedUserMessage,
  coerceRedactedText,
  extractHumanTurnPrompt
} from "../src/lifecycle-events-redaction.js";

describe("extractHumanTurnPrompt", () => {
  it("reads the human turn from a flat BaseMessage list", () => {
    const msgs = [new SystemMessage("sys"), new HumanMessage("hello there")];
    expect(extractHumanTurnPrompt(msgs)).toBe("hello there");
  });

  it("reads the handleChatModelStart nested shape", () => {
    const msgs = [[new SystemMessage("sys"), new HumanMessage("nested prompt")]];
    expect(extractHumanTurnPrompt(msgs)).toBe("nested prompt");
  });

  it("reads dict-shaped messages and joins multiple human turns", () => {
    const msgs = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ignored" },
      { role: "human", content: "second" }
    ];
    expect(extractHumanTurnPrompt(msgs)).toBe("first\nsecond");
  });

  it("extracts text parts from multimodal content", () => {
    const msg = new HumanMessage({
      content: [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: "http://x" } }
      ]
    });
    expect(extractHumanTurnPrompt([msg])).toBe("describe");
  });

  it("returns empty string when there is no human turn", () => {
    expect(extractHumanTurnPrompt([new SystemMessage("only system")])).toBe("");
    expect(extractHumanTurnPrompt("not a list")).toBe("");
  });
});

describe("coerceRedactedText", () => {
  it("passes a plain string through", () => {
    expect(coerceRedactedText("[REDACTED]")).toBe("[REDACTED]");
  });
  it("unwraps a legacy list of {prompt|text}", () => {
    expect(coerceRedactedText([{ prompt: "p" }])).toBe("p");
    expect(coerceRedactedText([{ text: "t" }])).toBe("t");
    expect(coerceRedactedText(["s"])).toBe("s");
  });
  it("returns null for empty / unrecognized", () => {
    expect(coerceRedactedText("")).toBeNull();
    expect(coerceRedactedText(null)).toBeNull();
    expect(coerceRedactedText([])).toBeNull();
    expect(coerceRedactedText({ nope: 1 })).toBeNull();
  });
});

describe("buildRedactedUserMessage", () => {
  it("returns null when redactedInput is empty (no-op)", () => {
    const msgs = [new HumanMessage("secret 555-1234")];
    expect(buildRedactedUserMessage(msgs, null)).toBeNull();
    expect(buildRedactedUserMessage(msgs, "")).toBeNull();
  });

  it("replaces the last human turn's string content and does NOT mutate the original", () => {
    const original = new HumanMessage("my ssn is 111-22-3333");
    const msgs = [new SystemMessage("sys"), original];

    const result = buildRedactedUserMessage(msgs, "my ssn is [REDACTED]");
    expect(result).not.toBeNull();
    expect(result!.index).toBe(1);
    const redacted = result!.message as HumanMessage;
    expect(redacted.content).toBe("my ssn is [REDACTED]");
    expect(redacted.getType()).toBe("human");
    // Original object untouched.
    expect(original.content).toBe("my ssn is 111-22-3333");
  });

  it("redacts only text blocks in multimodal content, leaving non-text blocks", () => {
    const original = new HumanMessage({
      content: [
        { type: "text", text: "leak 555-9999" },
        { type: "image_url", image_url: { url: "http://img" } }
      ]
    });
    const result = buildRedactedUserMessage([original], "leak [REDACTED]");
    expect(result).not.toBeNull();
    const content = (result!.message as HumanMessage).content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: "text", text: "leak [REDACTED]" });
    expect(content[1]).toMatchObject({ type: "image_url" });
  });

  it("never touches system or AI turns", () => {
    const msgs = [new SystemMessage("sys secret"), new AIMessage("ai secret")];
    expect(buildRedactedUserMessage(msgs, "REDACTED")).toBeNull();
  });

  it("handles dict-shaped user messages", () => {
    const msgs = [{ role: "user", content: "call 555-0000" }];
    const result = buildRedactedUserMessage(msgs, "call [REDACTED]");
    expect(result).not.toBeNull();
    expect((result!.message as { content: string }).content).toBe("call [REDACTED]");
  });
});
