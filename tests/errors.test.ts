import { describe, it, expect } from "vitest";
import {
  OpenBoxError,
  OpenBoxAuthError,
  OpenBoxNetworkError,
  OpenBoxInsecureURLError,
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
  ApprovalExpiredError,
  ApprovalRejectedError,
  ApprovalTimeoutError,
} from "../src/errors.js";

describe("Error classes", () => {
  it("OpenBoxError has correct name", () => {
    const err = new OpenBoxError("test");
    expect(err.name).toBe("OpenBoxError");
    expect(err.message).toBe("test");
    expect(err instanceof Error).toBe(true);
  });

  it("OpenBoxAuthError extends OpenBoxError", () => {
    const err = new OpenBoxAuthError("bad key");
    expect(err instanceof OpenBoxAuthError).toBe(true);
    expect(err instanceof OpenBoxError).toBe(true);
    expect(err.name).toBe("OpenBoxAuthError");
  });

  it("OpenBoxNetworkError extends OpenBoxError", () => {
    const err = new OpenBoxNetworkError("unreachable");
    expect(err instanceof OpenBoxNetworkError).toBe(true);
    expect(err.name).toBe("OpenBoxNetworkError");
  });

  it("OpenBoxInsecureURLError extends OpenBoxError", () => {
    const err = new OpenBoxInsecureURLError("http://remote.host");
    expect(err instanceof OpenBoxInsecureURLError).toBe(true);
    expect(err.name).toBe("OpenBoxInsecureURLError");
  });

  it("GovernanceBlockedError stores policyId and riskScore (legacy constructor)", () => {
    const err = new GovernanceBlockedError("blocked", "pol-1", 0.8);
    expect(err.name).toBe("GovernanceBlockedError");
    expect(err.verdict).toBe("block");
    expect(err.policyId).toBe("pol-1");
    expect(err.riskScore).toBe(0.8);
    expect(err instanceof OpenBoxError).toBe(true);
  });

  it("GovernanceHaltError stores identifier, policyId and riskScore", () => {
    const err = new GovernanceHaltError("halted", "", "pol-2", 1.0);
    expect(err.name).toBe("GovernanceHaltError");
    expect(err.verdict).toBe("halt");
    expect(err.identifier).toBe("");
    expect(err.policyId).toBe("pol-2");
    expect(err.riskScore).toBe(1.0);
  });

  it("GuardrailsValidationError includes reasons in message", () => {
    const err = new GuardrailsValidationError(["contains PII", "profanity detected"]);
    expect(err.name).toBe("GuardrailsValidationError");
    expect(err.reasons).toEqual(["contains PII", "profanity detected"]);
    expect(err.message).toContain("contains PII");
    expect(err.message).toContain("profanity detected");
  });

  it("ApprovalExpiredError has correct name", () => {
    const err = new ApprovalExpiredError("expired");
    expect(err.name).toBe("ApprovalExpiredError");
  });

  it("ApprovalRejectedError has correct name", () => {
    const err = new ApprovalRejectedError("rejected by reviewer");
    expect(err.name).toBe("ApprovalRejectedError");
    expect(err.message).toBe("rejected by reviewer");
  });

  it("ApprovalTimeoutError stores maxWaitMs", () => {
    const err = new ApprovalTimeoutError(60_000);
    expect(err.name).toBe("ApprovalTimeoutError");
    expect(err.maxWaitMs).toBe(60_000);
    expect(err.message).toContain("60000");
  });
});
