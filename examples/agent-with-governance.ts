/**
 * OpenBox LangChain SDK — Example: Agent with Governance
 *
 * Demonstrates full SDK integration:
 *  - createOpenBoxHandler() factory
 *  - wrapTools() for guardrails redaction
 *  - setupTelemetry() for HTTP span collection
 *  - Handling governance errors
 *
 * Run:
 *   OPENBOX_URL=http://localhost:8086 \
 *   OPENBOX_API_KEY=obx_test_... \
 *   OPENAI_API_KEY=sk-... \
 *   npx ts-node examples/agent-with-governance.ts
 */

import {
  createOpenBoxHandler,
  wrapTools,
  setupTelemetry,
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
  ApprovalTimeoutError,
  ApprovalRejectedError,
} from "../src/index.js";

// ─── Mock tool (replace with real LangChain tools in production) ──

const searchTool = {
  name: "search",
  description: "Search the web for information",
  async _call(input: unknown) {
    console.log(`[search] executing with input: ${JSON.stringify(input)}`);
    return `Results for: ${JSON.stringify(input)}`;
  },
};

const emailTool = {
  name: "send_email",
  description: "Send an email to a recipient",
  async _call(input: unknown) {
    console.log(`[send_email] sending: ${JSON.stringify(input)}`);
    return "Email sent successfully";
  },
};

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  // 1. Set up HTTP telemetry (captures outbound HTTP spans)
  const spanCollector = setupTelemetry();
  console.log("[telemetry] fetch patched for HTTP span collection");

  // 2. Create the governance handler (validates API key on startup)
  const handler = await createOpenBoxHandler({
    apiUrl: process.env["OPENBOX_URL"] ?? "http://localhost:8086",
    apiKey: process.env["OPENBOX_API_KEY"] ?? "obx_test_example_key",
    validate: false, // set true in production to verify key with server

    onApiError: "fail_open",   // continue if OpenBox Core is unreachable
    sendChainStartEvent: true,
    sendChainEndEvent: true,
    sendToolStartEvent: true,
    sendToolEndEvent: true,
    sendLLMStartEvent: true,
    sendLLMEndEvent: true,

    hitl: {
      enabled: true,
      pollIntervalMs: 5_000,
      maxWaitMs: 300_000,     // 5 min approval window
      skipToolTypes: new Set(["search"]), // search doesn't need approval
    },

    spanCollector,
  });

  // 3. Wrap tools so guardrails redaction is applied before execution
  const [wrappedSearch, wrappedEmail] = wrapTools(
    [searchTool, emailTool],
    handler
  );

  // 4. Simulate an agent run
  const runId = crypto.randomUUID();
  const chainSerializer = { id: ["example", "ExampleChain"] };
  const toolSerializer = { id: ["example", "tool"] };

  try {
    // Simulate chain start
    await handler.handleChainStart(
      chainSerializer as any,
      { input: "Send a summary email to alice@example.com" },
      runId,
      undefined, [], {}, "chain", "ExampleChain"
    );

    // Simulate tool use: search
    const searchRunId = crypto.randomUUID();
    await handler.handleToolStart(
      toolSerializer as any,
      "latest AI news",
      searchRunId,
      runId,
      [], {}, "search"
    );

    const searchResult = await (wrappedSearch! as any)._call("latest AI news", { runId: searchRunId });
    await handler.handleToolEnd(searchResult as string, searchRunId, runId);

    // Simulate tool use: send_email (may require HITL approval)
    const emailRunId = crypto.randomUUID();
    await handler.handleToolStart(
      toolSerializer as any,
      JSON.stringify({ to: "alice@example.com", subject: "AI News", body: searchResult }),
      emailRunId,
      runId,
      [], {}, "send_email"
    );

    const emailResult = await (wrappedEmail! as any)._call(
      { to: "alice@example.com", subject: "AI News", body: searchResult },
      { runId: emailRunId }
    );
    await handler.handleToolEnd(emailResult as string, emailRunId, runId);

    // Simulate chain end
    await handler.handleChainEnd({ output: "Done" }, runId);

    console.log("\n✓ Agent run completed successfully");
    console.log(`  HTTP spans collected: ${spanCollector.getSpans(runId).length}`);

  } catch (err) {
    if (err instanceof GovernanceHaltError) {
      console.error(`\n✗ HALT — session terminated by governance policy`);
      console.error(`  reason: ${err.message}`);
      if (err.policyId) console.error(`  policy: ${err.policyId}`);
      process.exit(2);
    }
    if (err instanceof GovernanceBlockedError) {
      console.warn(`\n⚠ BLOCKED — action prevented by governance`);
      console.warn(`  reason: ${err.message}`);
    }
    if (err instanceof GuardrailsValidationError) {
      console.warn(`\n⚠ GUARDRAILS — input/output failed validation`);
      console.warn(`  reasons: ${err.reasons.join(", ")}`);
    }
    if (err instanceof ApprovalTimeoutError) {
      console.warn(`\n⚠ TIMEOUT — HITL approval timed out after ${err.maxWaitMs}ms`);
    }
    if (err instanceof ApprovalRejectedError) {
      console.warn(`\n⚠ REJECTED — human reviewer rejected the action`);
      console.warn(`  reason: ${err.message}`);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
