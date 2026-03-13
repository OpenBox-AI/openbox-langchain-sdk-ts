import { describe, it, expect, beforeEach } from "vitest";
import { StreamingTokenBuffer } from "../src/streaming.js";

describe("StreamingTokenBuffer", () => {
  let buf: StreamingTokenBuffer;

  beforeEach(() => {
    buf = new StreamingTokenBuffer();
  });

  it("accumulates tokens for a run", () => {
    buf.start("run-1");
    buf.addToken("run-1", "Hello");
    buf.addToken("run-1", " ");
    buf.addToken("run-1", "world");
    expect(buf.getAccumulated("run-1")).toBe("Hello world");
  });

  it("starts fresh for each run", () => {
    buf.start("run-1");
    buf.addToken("run-1", "A");
    buf.start("run-2");
    buf.addToken("run-2", "B");
    expect(buf.getAccumulated("run-1")).toBe("A");
    expect(buf.getAccumulated("run-2")).toBe("B");
  });

  it("resets tokens when start() is called again for same run", () => {
    buf.start("run-1");
    buf.addToken("run-1", "old");
    buf.start("run-1"); // restart
    buf.addToken("run-1", "new");
    expect(buf.getAccumulated("run-1")).toBe("new");
  });

  it("returns empty string for unknown run", () => {
    expect(buf.getAccumulated("no-such-run")).toBe("");
  });

  it("ignores addToken for unknown run", () => {
    expect(() => buf.addToken("no-such-run", "x")).not.toThrow();
    expect(buf.getAccumulated("no-such-run")).toBe("");
  });

  it("stores model name on start", () => {
    buf.start("run-1", "gpt-4o");
    expect(buf.getBuffer("run-1")?.model).toBe("gpt-4o");
  });

  it("clears a run", () => {
    buf.start("run-1");
    buf.addToken("run-1", "hello");
    buf.clear("run-1");
    expect(buf.getAccumulated("run-1")).toBe("");
    expect(buf.size).toBe(0);
  });

  it("tracks size correctly", () => {
    expect(buf.size).toBe(0);
    buf.start("run-1");
    buf.start("run-2");
    expect(buf.size).toBe(2);
    buf.clear("run-1");
    expect(buf.size).toBe(1);
  });

  it("handles many tokens", () => {
    buf.start("run-1");
    const tokens = Array.from({ length: 1000 }, (_, i) => `t${i}`);
    tokens.forEach((t) => buf.addToken("run-1", t));
    const result = buf.getAccumulated("run-1");
    expect(result).toBe(tokens.join(""));
  });
});
