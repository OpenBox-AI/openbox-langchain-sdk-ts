import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SpanCollector,
  patchFetch,
  unpatchFetch,
  isFetchPatched,
  setupTelemetry,
} from "../src/telemetry.js";

describe("SpanCollector", () => {
  let collector: SpanCollector;

  beforeEach(() => {
    collector = new SpanCollector();
  });

  it("sets active run and stores spans", () => {
    collector.setActiveRun("run-1");
    collector.addSpan({
      span_id: "s1",
      name: "HTTP GET /api",
      kind: "client",
      start_time: 1000,
      attributes: { "http.method": "GET" },
      status: { code: "OK" },
    });
    const spans = collector.getSpans("run-1");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("HTTP GET /api");
  });

  it("attributes span to explicit runId over active run", () => {
    collector.setActiveRun("run-1");
    collector.addSpan(
      {
        span_id: "s1",
        name: "HTTP POST /search",
        kind: "client",
        start_time: 1000,
        attributes: {},
        status: { code: "OK" },
      },
      "run-2"
    );
    expect(collector.getSpans("run-1")).toHaveLength(0);
    expect(collector.getSpans("run-2")).toHaveLength(1);
  });

  it("returns empty array for unknown run", () => {
    expect(collector.getSpans("no-such-run")).toEqual([]);
  });

  it("clearActiveRun stops attributing spans", () => {
    collector.setActiveRun("run-1");
    collector.clearActiveRun();
    collector.addSpan({
      span_id: "s1",
      name: "HTTP GET /api",
      kind: "client",
      start_time: 1000,
      attributes: {},
      status: { code: "OK" },
    });
    expect(collector.getSpans("run-1")).toHaveLength(0);
  });

  it("clearSpans removes spans for a run", () => {
    collector.setActiveRun("run-1");
    collector.addSpan({
      span_id: "s1",
      name: "HTTP GET /api",
      kind: "client",
      start_time: 1000,
      attributes: {},
      status: { code: "OK" },
    });
    collector.clearSpans("run-1");
    expect(collector.getSpans("run-1")).toEqual([]);
  });

  it("tracks size", () => {
    expect(collector.size).toBe(0);
    collector.setActiveRun("run-1");
    expect(collector.size).toBe(1);
    collector.setActiveRun("run-2");
    expect(collector.size).toBe(2);
    collector.clearSpans("run-1");
    expect(collector.size).toBe(1);
  });

  it("accumulates multiple spans for a run", () => {
    collector.setActiveRun("run-1");
    for (let i = 0; i < 5; i++) {
      collector.addSpan({
        span_id: `s${i}`,
        name: `HTTP GET /api/${i}`,
        kind: "client",
        start_time: i * 100,
        attributes: {},
        status: { code: "OK" },
      });
    }
    expect(collector.getSpans("run-1")).toHaveLength(5);
  });
});

describe("patchFetch / unpatchFetch", () => {
  afterEach(() => {
    unpatchFetch();
  });

  it("isFetchPatched returns false before patching", () => {
    expect(isFetchPatched()).toBe(false);
  });

  it("patches global fetch", () => {
    const original = globalThis.fetch;
    const collector = new SpanCollector();
    patchFetch(collector);
    expect(isFetchPatched()).toBe(true);
    expect(globalThis.fetch).not.toBe(original);
  });

  it("is idempotent — patching twice is safe", () => {
    const collector = new SpanCollector();
    patchFetch(collector);
    const patched = globalThis.fetch;
    patchFetch(collector); // second call — no-op
    expect(globalThis.fetch).toBe(patched);
  });

  it("restores original fetch on unpatch", () => {
    const original = globalThis.fetch;
    const collector = new SpanCollector();
    patchFetch(collector);
    unpatchFetch();
    expect(globalThis.fetch).toBe(original);
    expect(isFetchPatched()).toBe(false);
  });

  it("captures a successful HTTP span", async () => {
    const collector = new SpanCollector();
    collector.setActiveRun("run-1");

    // Mock fetch to return a successful response
    const mockResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

    patchFetch(collector);

    await globalThis.fetch("https://api.example.com/search", {
      method: "POST",
      body: JSON.stringify({ query: "test" }),
    });

    const spans = collector.getSpans("run-1");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes["http.status_code"]).toBe(200);
    expect(spans[0]!.status.code).toBe("OK");
  });

  it("skips governance API URLs (no infinite loop)", async () => {
    const collector = new SpanCollector();
    collector.setActiveRun("run-1");

    const mockFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = mockFetch;

    patchFetch(collector);

    await globalThis.fetch("https://api.openbox.ai/api/v1/governance/evaluate");

    // Span should NOT be collected for governance URLs
    expect(collector.getSpans("run-1")).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("setupTelemetry", () => {
  afterEach(() => {
    unpatchFetch();
  });

  it("returns a SpanCollector", () => {
    const collector = setupTelemetry({ patchFetchEnabled: false });
    expect(collector).toBeInstanceOf(SpanCollector);
  });

  it("uses provided collector", () => {
    const myCollector = new SpanCollector();
    const result = setupTelemetry({ collector: myCollector, patchFetchEnabled: false });
    expect(result).toBe(myCollector);
  });

  it("patches fetch when patchFetchEnabled is true (default)", () => {
    setupTelemetry();
    expect(isFetchPatched()).toBe(true);
  });
});
