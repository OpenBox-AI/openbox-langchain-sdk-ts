/**
 * Phase 10 (Framework SDK Adoption): proves an `okta_ai_agent` identity
 * configured through `OpenBoxLangChainMiddlewareOptions` reaches the base
 * SDK's client INTACT — this package never mints the assertion, selects the
 * endpoint, or classifies auth failures itself (proposal §13.2/§13.7). Uses
 * `FakeCore` (`@openbox-ai/openbox-sdk-ts/conformance`) as the fixture-backed
 * Core stub so the assertion is inspected exactly as Core would receive it.
 */
import { generateKeyPairSync } from "node:crypto";

import { workflowStarted } from "@openbox-ai/openbox-sdk-ts";
import { FakeCore } from "@openbox-ai/openbox-sdk-ts/conformance";
import { describe, expect, it } from "vitest";

import { buildMiddlewareRuntime } from "../src/middleware/runtime-builder.js";

const VALID_URL = "https://core.test";
const VALID_KEY = "obx_test_langchain_v2";

function generateTestRsaPkcs8Pem(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  return privateKey;
}

function decodeJwtPayload(compactJwt: string): Record<string, unknown> {
  const parts = compactJwt.split(".");
  expect(parts).toHaveLength(3);
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8")) as Record<
    string,
    unknown
  >;
}

function decodeJwtHeader(compactJwt: string): Record<string, unknown> {
  const parts = compactJwt.split(".");
  expect(parts).toHaveLength(3);
  return JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf-8")) as Record<
    string,
    unknown
  >;
}

describe("buildMiddlewareRuntime — okta_ai_agent identity forwarding (v2)", () => {
  it("reaches the base client intact: v2 endpoint, assertion header, and claims match the configured identity", async () => {
    const privateKey = generateTestRsaPkcs8Pem();
    const core = new FakeCore();

    const runtime = buildMiddlewareRuntime({
      apiUrl: VALID_URL,
      apiKey: VALID_KEY,
      agentId: "agent-uuid-1234",
      organizationId: "org-uuid-5678",
      deploymentId: "prod-us",
      agentProofAudience: "urn:openbox:prod-us:core",
      oktaAgentId: "wlp-external-okta-agent-id",
      oktaAgentKeyId: "okta-credential-kid-1",
      oktaAgentPrivateKey: privateKey,
      oktaAgentAlgorithm: "RS256",
      fetchImpl: core.fetchImpl
    });

    const result = await runtime.evaluateLifecycle(
      workflowStarted({ workflowId: "wf-1", runId: "run-1", workflowType: "test" })
    );

    expect(result).not.toBeNull();
    expect(core.evaluateRequests).toHaveLength(1);
    const request = core.evaluateRequests[0]!;

    // Endpoint selection: v2, never v1 (proposal §13.3 — no cross-version retry/fallback).
    expect(request.path).toBe("/api/v2/governance/evaluate");

    // v2 carries ONLY the assertion header — v1 DID identity headers must
    // never leak alongside it (contract §2.1).
    const assertion = request.headers["x-openbox-agent-assertion"];
    expect(assertion).toBeDefined();
    expect(request.headers["x-openbox-agent-did"]).toBeUndefined();
    expect(request.headers["x-openbox-agent-signature"]).toBeUndefined();
    expect(request.headers["x-openbox-agent-timestamp"]).toBeUndefined();
    expect(request.headers["x-openbox-agent-nonce"]).toBeUndefined();
    expect(request.headers["x-openbox-body-sha256"]).toBeUndefined();

    // Protected header + claims prove the CONFIGURED identity — not a
    // default/placeholder — reached the base client's signer intact.
    const header = decodeJwtHeader(assertion!);
    expect(header["alg"]).toBe("RS256");
    expect(header["kid"]).toBe("okta-credential-kid-1");
    expect(header["typ"]).toBe("openbox-agent-proof+jwt");

    const payload = decodeJwtPayload(assertion!);
    expect(payload["iss"]).toBe("wlp-external-okta-agent-id");
    expect(payload["sub"]).toBe("wlp-external-okta-agent-id");
    expect(payload["aud"]).toBe("urn:openbox:prod-us:core");
    expect(payload["obx_agent_id"]).toBe("agent-uuid-1234");
    expect(payload["obx_organization_id"]).toBe("org-uuid-5678");
    expect(payload["obx_deployment_id"]).toBe("prod-us");
    expect(payload["htm"]).toBe("POST");
    expect(payload["htu"]).toBe("/api/v2/governance/evaluate");

    runtime.close();
  });

  it("mutually exclusive with agentDid/agentPrivateKey — the base config rejects both (delegated, not re-validated locally)", () => {
    const privateKey = generateTestRsaPkcs8Pem();
    expect(() =>
      buildMiddlewareRuntime({
        apiUrl: VALID_URL,
        apiKey: VALID_KEY,
        agentDid: "did:aip:00000000-0000-0000-0000-000000000000",
        agentPrivateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        agentId: "agent-uuid-1234",
        organizationId: "org-uuid-5678",
        deploymentId: "prod-us",
        agentProofAudience: "urn:openbox:prod-us:core",
        oktaAgentId: "wlp-external-okta-agent-id",
        oktaAgentKeyId: "okta-credential-kid-1",
        oktaAgentPrivateKey: privateKey,
        oktaAgentAlgorithm: "RS256"
      })
    ).toThrow();
  });
});
