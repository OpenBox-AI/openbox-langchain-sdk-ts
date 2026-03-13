import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GovernanceClient } from "../src/client.js";
import { OpenBoxNetworkError } from "../src/errors.js";
import { Verdict } from "../src/types.js";

const BASE_URL = "http://localhost:8086";
const API_KEY = "obx_test_key1";

function makeClient(onApiError: "fail_open" | "fail_closed" = "fail_open") {
  return new GovernanceClient({ apiUrl: BASE_URL, apiKey: API_KEY, onApiError });
}

function makeEvent() {
  return {
    source: "langchain-telemetry" as const,
    event_type: "ToolStarted" as const,
    workflow_id: "wf-123",
    run_id: "wf-123",
    workflow_type: "AgentExecutor",
    timestamp: new Date().toISOString(),
    activity_id: "tool-456",
    activity_type: "search",
  };
}

describe("GovernanceClient.evaluateEvent", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed response on success", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ verdict: "allow", reason: "ok" }),
    });

    const client = makeClient();
    const result = await client.evaluateEvent(makeEvent());

    expect(result).not.toBeNull();
    expect(result!.verdict).toBe(Verdict.ALLOW);
  });

  it("returns null on HTTP error when fail_open", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500 });
    const client = makeClient("fail_open");
    const result = await client.evaluateEvent(makeEvent());
    expect(result).toBeNull();
  });

  it("throws OpenBoxNetworkError on HTTP error when fail_closed", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500 });
    const client = makeClient("fail_closed");
    await expect(client.evaluateEvent(makeEvent())).rejects.toThrow(OpenBoxNetworkError);
  });

  it("returns null on network failure when fail_open", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const client = makeClient("fail_open");
    const result = await client.evaluateEvent(makeEvent());
    expect(result).toBeNull();
  });

  it("throws OpenBoxNetworkError on network failure when fail_closed", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const client = makeClient("fail_closed");
    await expect(client.evaluateEvent(makeEvent())).rejects.toThrow(OpenBoxNetworkError);
  });

  it("sends correct Authorization header", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ verdict: "allow" }),
    });
    const client = makeClient();
    await client.evaluateEvent(makeEvent());

    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/v1/governance/evaluate`);
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${API_KEY}`);
  });

  it("parses block verdict correctly", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        verdict: "block",
        reason: "Policy violation",
        policy_id: "pol-1",
        risk_score: 0.95,
      }),
    });
    const client = makeClient();
    const result = await client.evaluateEvent(makeEvent());
    expect(result!.verdict).toBe(Verdict.BLOCK);
    expect(result!.reason).toBe("Policy violation");
    expect(result!.policy_id).toBe("pol-1");
  });
});

describe("GovernanceClient.pollApproval", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns approval response with allow verdict", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ verdict: "allow", reason: "Approved by reviewer" }),
    });
    const client = makeClient();
    const result = await client.pollApproval({
      workflowId: "wf-123",
      runId: "wf-123",
      activityId: "tool-456",
    });
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe(Verdict.ALLOW);
  });

  it("returns null on HTTP failure", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 404 });
    const client = makeClient();
    const result = await client.pollApproval({
      workflowId: "wf-123",
      runId: "wf-123",
      activityId: "tool-456",
    });
    expect(result).toBeNull();
  });

  it("returns null on network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    const client = makeClient();
    const result = await client.pollApproval({
      workflowId: "wf-123",
      runId: "wf-123",
      activityId: "tool-456",
    });
    expect(result).toBeNull();
  });

  it("marks expired=true when expiration time is in the past", async () => {
    const pastTime = new Date(Date.now() - 10_000).toISOString();
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        verdict: "require_approval",
        approval_expiration_time: pastTime,
      }),
    });
    const client = makeClient();
    const result = await client.pollApproval({
      workflowId: "wf-123",
      runId: "wf-123",
      activityId: "tool-456",
    });
    expect(result!.expired).toBe(true);
  });
});

describe("GovernanceClient.haltResponse", () => {
  it("returns a HALT verdict response", () => {
    const resp = GovernanceClient.haltResponse("API unreachable");
    expect(resp.verdict).toBe(Verdict.HALT);
    expect(resp.reason).toBe("API unreachable");
  });
});
