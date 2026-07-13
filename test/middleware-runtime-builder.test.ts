import { ApprovalPoller } from "@openbox-ai/openbox-sdk-ts/approvals";
import { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import { FakeCore } from "@openbox-ai/openbox-sdk-ts/conformance";
import { describe, expect, it } from "vitest";

import { DEFAULT_APPROVAL_MAX_WAIT_MS } from "../src/middleware/options.js";
import { resolveApprovalMaxWait } from "../src/middleware/runtime-builder.js";

describe("resolveApprovalMaxWait (never hangs on the default path)", () => {
  it("uses the finite default when neither option nor config sets a wait", () => {
    expect(resolveApprovalMaxWait({}, null)).toBe(DEFAULT_APPROVAL_MAX_WAIT_MS);
    expect(DEFAULT_APPROVAL_MAX_WAIT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_APPROVAL_MAX_WAIT_MS)).toBe(true);
  });

  it("honors an explicit null opt-out (poll indefinitely)", () => {
    expect(resolveApprovalMaxWait({ approvalMaxWaitMs: null }, 5000)).toBeNull();
  });

  it("prefers an explicit option value", () => {
    expect(resolveApprovalMaxWait({ approvalMaxWaitMs: 1234 }, 5000)).toBe(1234);
  });

  it("falls back to a finite config value when set", () => {
    expect(resolveApprovalMaxWait({}, 5000)).toBe(5000);
  });
});

describe("ApprovalPoller with a finite wait terminates (does not hang)", () => {
  it("rejects rather than polling forever when Core never approves", async () => {
    const core = new FakeCore();
    core.failAllApprovals("core unreachable");
    const client = new OpenBoxClient("https://core.test", "obx_test_key", {
      fetchImpl: core.fetchImpl
    });
    const poller = new ApprovalPoller(client, { pollIntervalMs: 1, maxWaitMs: 40 });

    await expect(
      poller.waitForDecision("wf-1", "run-1", "act-1")
    ).rejects.toThrow();
  });
});
