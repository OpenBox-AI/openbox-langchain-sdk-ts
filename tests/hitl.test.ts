import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pollUntilDecision } from "../src/hitl.js";
import { GovernanceClient } from "../src/client.js";
import {
  ApprovalExpiredError,
  ApprovalRejectedError,
  ApprovalTimeoutError,
} from "../src/errors.js";
import { DEFAULT_HITL_CONFIG, Verdict } from "../src/types.js";

function makeClient(approvalResponses: Array<Record<string, unknown> | null>): GovernanceClient {
  const client = new GovernanceClient({
    apiUrl: "http://localhost:8086",
    apiKey: "obx_test_key1",
  });
  let callCount = 0;
  vi.spyOn(client, "pollApproval").mockImplementation(async () => {
    const resp = approvalResponses[callCount] ?? approvalResponses.at(-1) ?? null;
    callCount++;
    if (resp === null) return null;
    const { parseApprovalResponse } = await import("../src/types.js");
    return parseApprovalResponse(resp);
  });
  return client;
}

const FAST_CONFIG = {
  ...DEFAULT_HITL_CONFIG,
  pollIntervalMs: 10,   // 10ms for tests
  maxWaitMs: 500,        // 500ms max
};

const PARAMS = {
  workflowId: "wf-123",
  runId: "wf-123",
  activityId: "tool-456",
  activityType: "send_email",
};

describe("pollUntilDecision", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when approval is granted (ALLOW)", async () => {
    const client = makeClient([{ verdict: "allow" }]);
    await expect(
      Promise.all([pollUntilDecision(client, PARAMS, FAST_CONFIG), vi.runAllTimersAsync()])
    ).resolves.toBeDefined();
  });

  it("polls multiple times before allow", async () => {
    const client = makeClient([
      { verdict: "require_approval" },
      { verdict: "require_approval" },
      { verdict: "allow" },
    ]);
    await Promise.all([pollUntilDecision(client, PARAMS, FAST_CONFIG), vi.runAllTimersAsync()]);
    expect(client.pollApproval).toHaveBeenCalledTimes(3);
  });

  it("throws ApprovalRejectedError on HALT verdict", async () => {
    const client = makeClient([{ verdict: "halt", reason: "Rejected by admin" }]);
    await expect(
      Promise.all([pollUntilDecision(client, PARAMS, FAST_CONFIG), vi.runAllTimersAsync()])
    ).rejects.toThrow(ApprovalRejectedError);
  });

  it("throws an error on BLOCK verdict", async () => {
    const client = makeClient([{ verdict: "block", reason: "Denied" }]);
    await expect(
      Promise.all([pollUntilDecision(client, PARAMS, FAST_CONFIG), vi.runAllTimersAsync()])
    ).rejects.toThrow(Error);
  });

  it("throws ApprovalExpiredError when expired=true", async () => {
    const client = makeClient([{ verdict: "require_approval", expired: true }]);
    await expect(
      Promise.all([pollUntilDecision(client, PARAMS, FAST_CONFIG), vi.runAllTimersAsync()])
    ).rejects.toThrow(ApprovalExpiredError);
  });

  it("throws ApprovalExpiredError when expiration_time is in the past", async () => {
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const client = makeClient([]);
    vi.spyOn(client, "pollApproval").mockResolvedValue({
      verdict: Verdict.REQUIRE_APPROVAL,
      approval_expiration_time: pastTime,
      expired: true,
    });
    await expect(
      Promise.all([pollUntilDecision(client, PARAMS, FAST_CONFIG), vi.runAllTimersAsync()])
    ).rejects.toThrow(ApprovalExpiredError);
  });

  it("throws ApprovalTimeoutError when max_wait_ms exceeded", async () => {
    const client = makeClient([{ verdict: "require_approval" }]);
    const tightConfig = { ...FAST_CONFIG, pollIntervalMs: 10, maxWaitMs: 25 };
    await expect(
      Promise.all([pollUntilDecision(client, PARAMS, tightConfig), vi.runAllTimersAsync()])
    ).rejects.toThrow(ApprovalTimeoutError);
  });

  it("keeps polling when API returns null (network failure)", async () => {
    // null responses are skipped (continue) without throwing — prove by resolving
    const client = makeClient([{ verdict: "allow" }]);
    vi.spyOn(client, "pollApproval")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ verdict: Verdict.ALLOW });
    await Promise.all([pollUntilDecision(client, PARAMS, FAST_CONFIG), vi.runAllTimersAsync()]);
    expect(client.pollApproval).toHaveBeenCalled();
  });
});
