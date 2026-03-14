# @openbox/langchain-sdk

> Add real-time AI governance, policy enforcement, and human-in-the-loop approval to any LangChain agent — in under 10 lines of code.

[![npm version](https://img.shields.io/npm/v/@openbox/langchain-sdk)](https://www.npmjs.com/package/@openbox/langchain-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

The `@openbox/langchain-sdk` connects your LangChain agents to [OpenBox](https://openbox.ai) — giving you governance policies, guardrails, and human oversight without rewriting any agent logic.

**What it does:**
- Intercepts every tool call, LLM invocation, and outbound HTTP request your agent makes
- Evaluates each action in real-time against your policies and guardrails
- Blocks, halts, or requests human approval based on the verdict — before anything harmful executes
- Redacts PII and sensitive data from logs and downstream processing
- Populates the OpenBox dashboard with usage analytics, policy audit trails, and HITL approval queues

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Adding to an Existing Agent](#adding-to-an-existing-agent)
- [Configuration](#configuration)
- [Governance Verdicts](#governance-verdicts)
- [Human-in-the-Loop (HITL) Approvals](#human-in-the-loop-hitl-approvals)
- [Guardrails](#guardrails)
- [Hook-Level Governance](#hook-level-governance)
- [Error Handling](#error-handling)
- [Important: AgentExecutor Setup](#important-agentexecutor-setup)
- [Important: LLM Memory and Context Injection](#important-llm-memory-and-context-injection)
- [Signal Monitor (Mid-Run Halt)](#signal-monitor-mid-run-halt)
- [Configuration Reference](#configuration-reference)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)

---

## Installation

```bash
npm install @openbox/langchain-sdk
```

Peer dependency (install if not already present):

```bash
npm install @langchain/core
```

**Requirements:** Node.js >= 18

---

## Quick Start

Three lines is all it takes to connect a LangChain chain to OpenBox governance:

```typescript
import { createOpenBoxHandler } from "@openbox/langchain-sdk";
import { ChatOpenAI } from "@langchain/openai";
import { ConversationChain } from "langchain/chains";

const handler = await createOpenBoxHandler({
  apiUrl: process.env.OPENBOX_URL!,
  apiKey: process.env.OPENBOX_API_KEY!,
});

const llm = new ChatOpenAI({ model: "gpt-4o" });
const chain = new ConversationChain({ llm, callbacks: [handler] });

const result = await chain.call({ input: "Summarize this document..." });
```

That's it. Every chain, LLM, tool, and agent event now flows through OpenBox for policy evaluation. Set up policies and guardrails in the [OpenBox dashboard](https://core.openbox.ai) and they take effect immediately — no code changes needed.

---

## Adding to an Existing Agent

If you already have a LangChain agent, here is exactly what to change.

### Before

```typescript
import { AgentExecutor, createReactAgent } from "langchain/agents";
import { ChatOpenAI } from "@langchain/openai";
import { pull } from "langchain/hub";

const llm = new ChatOpenAI({ model: "gpt-4o" });
const tools = [searchTool, calculatorTool];
const prompt = await pull("hwchase17/react");
const agent = createReactAgent({ llm, tools, prompt });

const executor = new AgentExecutor({ agent, tools });

const result = await executor.invoke({ input: "What is 2 + 2?" });
```

### After (with OpenBox governance)

```typescript
import { AgentExecutor, createReactAgent } from "langchain/agents";
import { ChatOpenAI } from "@langchain/openai";
import { pull } from "langchain/hub";
import {
  createOpenBoxHandler,
  wrapTools,
  setupTelemetry,
} from "@openbox/langchain-sdk";

// Step 1: Enable HTTP span capture for hook-level governance
setupTelemetry();

// Step 2: Create the governance handler
const handler = await createOpenBoxHandler({
  apiUrl: process.env.OPENBOX_URL!,
  apiKey: process.env.OPENBOX_API_KEY!,
  hitl: {
    enabled: true,
    pollIntervalMs: 5_000,
    maxWaitMs: 600_000,
  },
});

const llm = new ChatOpenAI({ model: "gpt-4o" });
const tools = [searchTool, calculatorTool];

// Step 3: Wrap tools to enable HITL retry on approval
const governedTools = wrapTools(tools, handler);

const prompt = await pull("hwchase17/react");
const agent = createReactAgent({ llm, tools: governedTools, prompt });

// Step 4: Pass handler as a callback + configure error re-throw
const executor = new AgentExecutor({
  agent,
  tools: governedTools,
  callbacks: [handler],
  // IMPORTANT: re-throw governance errors so the agent halts correctly
  handleToolRuntimeErrors: (e: unknown) => {
    if (
      e instanceof GovernanceHaltError ||
      e instanceof GovernanceBlockedError ||
      e instanceof GuardrailsValidationError
    ) {
      throw e;
    }
    return `Tool error: ${e instanceof Error ? e.message : String(e)}`;
  },
});

// Step 5: Handle governance errors in your run loop
try {
  const result = await executor.invoke(
    { input: "What is 2 + 2?" },
    { callbacks: [handler], signal: handler.abortController?.signal }
  );
  console.log(result.output);
} catch (err) {
  if (err instanceof GovernanceHaltError) {
    console.error("Session halted by governance:", err.message);
  } else if (err instanceof GovernanceBlockedError) {
    console.warn("Action blocked:", err.message);
  } else if (err instanceof GuardrailsValidationError) {
    console.warn("Guardrails failed:", err.message);
  } else if (err instanceof ApprovalRejectedError) {
    console.warn("Approval rejected — session halted");
  }
}
```

> **Note:** Do **not** pass `callbacks: [handler]` to the `ChatOpenAI` constructor. Pass it only to `AgentExecutor` (or `chain.call`). LangChain propagates callbacks downward automatically — passing it to both causes every LLM event to fire twice, which doubles policy evaluations and can cause unexpected behaviour.

---

## Configuration

### Environment Variables

```bash
OPENBOX_URL=https://api.openbox.ai
OPENBOX_API_KEY=obx_live_your_key_here
OPENBOX_DEBUG=1       # optional: logs every governance request/response to /tmp/openbox.log
OPENBOX_TIMEOUT=30000 # optional: per-request timeout in ms (default: 30000)
```

### Full Configuration Reference

```typescript
const handler = await createOpenBoxHandler({
  // Required
  apiUrl: "https://api.openbox.ai",
  apiKey: "obx_live_...",

  // Startup validation
  validate: true,              // ping API key on startup — fails fast if misconfigured (default: true)

  // Error policy
  onApiError: "fail_open",     // "fail_open" (default) — log and continue if OpenBox is unreachable
                               // "fail_closed"          — block all actions if OpenBox is unreachable
  apiTimeout: 30_000,          // per-request timeout in ms (default: 30000)

  // Event filtering — set false to skip sending specific event types
  sendChainStartEvent: true,
  sendChainEndEvent:   true,
  sendToolStartEvent:  true,
  sendToolEndEvent:    true,
  sendLLMStartEvent:   true,
  sendLLMEndEvent:     true,

  // Skip specific named chain or tool types entirely
  skipChainTypes: ["SequentialChain", "InternalChain"],
  skipToolTypes:  ["health_check", "noop"],

  // Human-in-the-Loop
  hitl: {
    enabled: true,
    pollIntervalMs: 5_000,              // how often to poll for a decision (default: 5000)
    maxWaitMs: 600_000,                 // give up after this many ms (default: 600000 = 10 min)
    skipToolTypes: new Set(["safe_tool"]), // these tools never block for HITL
  },

  // Signal monitoring — polls for mid-run HALT/BLOCK signals from the dashboard
  enableSignalMonitor: true,   // default: false

  // Session tracking — shown in the OpenBox dashboard
  sessionId: "user-session-abc123",

  // Raise errors on guardrail failures (default: false — returns a blocked message instead)
  raiseError: true,
});
```

---

## Governance Verdicts

OpenBox evaluates every event against your configured policies and returns one of five verdicts:

| Verdict | What happens in the SDK |
|---|---|
| `ALLOW` | Execution continues normally |
| `CONSTRAIN` | Warning is logged; execution continues |
| `REQUIRE_APPROVAL` | SDK blocks and polls for a human decision on the OpenBox dashboard |
| `BLOCK` | `GovernanceBlockedError` is thrown immediately — current action is stopped |
| `HALT` | `GovernanceHaltError` is thrown — entire session is stopped |

**BLOCK vs HALT:** `BLOCK` stops the current action but the agent can continue. `HALT` terminates the entire session — the agent should not retry or continue. Always treat `GovernanceHaltError` as a terminal condition.

---

## Human-in-the-Loop (HITL) Approvals

When a policy returns `REQUIRE_APPROVAL`, the SDK pauses execution and polls OpenBox Core until a human makes a decision on the dashboard.

### How it works

1. Policy evaluates a tool call or LLM invocation and returns `REQUIRE_APPROVAL`
2. SDK calls `pollUntilDecision()`, which polls `/api/v1/governance/approval` every `pollIntervalMs`
3. The approval request appears in the OpenBox dashboard Approvals queue
4. A human reviewer approves or rejects it
5. **On approval:** execution continues (for `ToolStarted` events, the tool re-runs with the original input)
6. **On rejection:** `ApprovalRejectedError` is thrown → SDK converts it to `GovernanceHaltError` → session halts

### Minimal HITL setup

```typescript
import {
  createOpenBoxHandler,
  wrapTools,
  GovernanceHaltError,
  ApprovalRejectedError,
} from "@openbox/langchain-sdk";

const handler = await createOpenBoxHandler({
  apiUrl: process.env.OPENBOX_URL!,
  apiKey: process.env.OPENBOX_API_KEY!,
  hitl: {
    enabled: true,
    pollIntervalMs: 5_000,   // poll every 5 seconds
    maxWaitMs: 600_000,      // time out after 10 minutes
  },
});

// wrapTools is required for HITL to work correctly on tool-level REQUIRE_APPROVAL
const governedTools = wrapTools(myTools, handler);

const executor = new AgentExecutor({
  agent,
  tools: governedTools,
  callbacks: [handler],
  handleToolRuntimeErrors: (e) => {
    if (e instanceof GovernanceHaltError || e instanceof GovernanceBlockedError) throw e;
    return String(e);
  },
});
```

### HITL on ToolStarted vs ToolCompleted

HITL can be triggered at two points:

| Event | When it fires | Use case |
|---|---|---|
| `ToolStarted` | Before the tool executes | Pre-approve a sensitive action (e.g. large bank transfer) |
| `ToolCompleted` | After the tool returns its result | Review the output before it reaches the LLM |

Both are handled automatically. No configuration difference — just set up the corresponding policy rule in the dashboard.

### Policy example (Rego) — REQUIRE_APPROVAL on transfer over $5,000

```rego
package openbox.policy

result := {"decision": "REQUIRE_APPROVAL", "reason": "Transfers over $5,000 require manager approval"} if {
    input.event_type == "ActivityStarted"
    input.activity_type == "transfer_funds"
    not input.hook_trigger
    transfer := input.activity_input[0]
    transfer.amount > 5000
}
```

> **Important:** Always include `not input.hook_trigger` in your REQUIRE_APPROVAL and BLOCK rules. Hook events (outbound HTTP requests) generate a second `ActivityStarted` event for the same tool. Without this guard, the same tool call triggers two approval dialogs — one for the tool invocation and one for the HTTP request it makes.

---

## Guardrails

Guardrails validate and optionally redact input and output at the field level. They are configured in the OpenBox dashboard — no code changes needed.

### Supported guardrail types

| Type ID | Guardrail | What it does |
|---|---|---|
| `"1"` | PII Detection | Detects and redacts emails, SSNs, passport numbers, phone numbers, etc. |
| `"2"` | Content Filtering | Blocks specific topic categories (hate speech, self-harm, etc.) |
| `"3"` | Toxicity | Blocks abusive, threatening, or harassing language |
| `"4"` | Ban Words | Blocks messages containing specific words or phrases |

### What happens when a guardrail triggers

**Input guardrails** (evaluated on `ToolStarted` / `LLMStarted`):
- If `validation_passed: false` → `GuardrailsValidationError` is thrown (with `raiseError: true`) or a blocked message is returned
- If `redacted_input` is present → the SDK replaces the original input with the redacted version before the tool/LLM receives it

**Output guardrails** (evaluated on `ToolCompleted` / `LLMCompleted`):
- If redaction is present → the SDK replaces the tool result or LLM response with the redacted version before it reaches the next step in the chain

### Redaction is automatic with `wrapTools` / `wrapLLM`

```typescript
import { createOpenBoxHandler, wrapTools, wrapLLM } from "@openbox/langchain-sdk";

const handler = await createOpenBoxHandler({ ... });

// Wrap tools so redacted input is used when the tool actually executes
const governedTools = wrapTools(myTools, handler);

// Wrap LLM so redacted prompts are sent to the model
const governedLLM = wrapLLM(new ChatOpenAI({ model: "gpt-4o" }), handler);
```

Without `wrapTools`, the SDK **detects** PII and can block/validate — but the original (unredacted) input still reaches the tool. `wrapTools` ensures the redacted version is what actually executes.

### Example: PII redaction in action

Dashboard guardrail config: PII detection on `activity_input`, replace with `<EMAIL_ADDRESS>` and `<US_PASSPORT>`.

```
User input:  "Authenticate me: email john@example.com, passport A12345678"
Tool input:  { email: "john@example.com", passport: "A12345678" }
Redacted:    { email: "<EMAIL_ADDRESS>",  passport: "<US_PASSPORT>" }

→ The tool receives the redacted values
→ Governance logs show redacted values only — no PII stored
→ Authentication still succeeds if your tool can handle the redacted marker
```

---

## Hook-Level Governance

Every outbound `fetch()` call made during a tool or LLM execution is evaluated by OpenBox before and after it fires. This is **hook-level governance** — it lets you write policies that inspect the actual HTTP requests your agent makes, not just the tool inputs.

### Enable it

```typescript
import { createOpenBoxHandler, setupTelemetry } from "@openbox/langchain-sdk";

// Must be called before any fetch() happens — patches globalThis.fetch
setupTelemetry();

const handler = await createOpenBoxHandler({ ... });
```

### What gets evaluated

| Stage | When | SDK behaviour on BLOCK/HALT |
|---|---|---|
| `started` | Before the HTTP request fires | Request is cancelled — never reaches the server |
| `completed` | After response is received | Informational — errors are logged and swallowed |

### REQUIRE_APPROVAL on HTTP requests

If a hook policy returns `REQUIRE_APPROVAL` at the `started` stage, the SDK holds the HTTP request and polls for a human decision. With `wrapTool`:

- **Approved** → the original tool call is retried (the HTTP request fires again)
- **Rejected** → `ApprovalRejectedError` → `GovernanceHaltError` → session halts

```typescript
// This policy triggers HITL before any GET request to a stock price API
result := {"decision": "REQUIRE_APPROVAL", "reason": "Stock lookup requires approval"} if {
    input.hook_trigger.type == "http_request"
    input.hook_trigger.stage == "started"
    input.hook_trigger["http.method"] == "GET"
    contains(input.hook_trigger["http.url"], "finance.yahoo.com")
}
```

### How spans work with hooks

Each `fetch()` inside a tool generates a **span** in the HTTP telemetry. Spans evaluated individually at hook level are marked as *governed* and **excluded** from the bulk `activity_output` spans on `ToolCompleted`. This prevents the same HTTP request from being evaluated twice — once at the hook level and once in the bulk payload.

---

## Error Handling

Import and handle these errors in your agent's run loop:

```typescript
import {
  GovernanceHaltError,
  GovernanceBlockedError,
  GuardrailsValidationError,
  ApprovalRejectedError,
  ApprovalTimeoutError,
} from "@openbox/langchain-sdk";

try {
  const result = await executor.invoke(
    { input: "Transfer $20,000 to account 9876543210" },
    { callbacks: [handler], signal: handler.abortController?.signal }
  );
  console.log(result.output);
} catch (err) {
  if (err instanceof GovernanceHaltError) {
    // Policy issued HALT — entire session must stop
    // Do not retry. Inform the user and end the session.
    console.error("Session halted by governance policy:", err.message);
    // err.identifier — the URL that triggered the halt (hook-level), or "" (activity-level)

  } else if (err instanceof ApprovalRejectedError) {
    // A human reviewer rejected the action on the dashboard
    // The SDK converts this to GovernanceHaltError, so you'll typically catch the above.
    // This is only thrown directly if you call pollUntilDecision() manually.
    console.warn("Approval rejected:", err.message);

  } else if (err instanceof ApprovalTimeoutError) {
    // No human made a decision within maxWaitMs
    console.warn("Approval timed out after", err.maxWaitMs, "ms");

  } else if (err instanceof GovernanceBlockedError) {
    // A specific action was blocked — agent may continue with other actions
    console.warn("Action blocked:", err.message);
    // err.verdict    — "block" | "halt" | "require_approval"
    // err.identifier — URL that triggered this (hook-level), or "" (activity-level)

  } else if (err instanceof GuardrailsValidationError) {
    // Input or output failed a guardrail check
    // err.message contains the reason from OpenBox Core
    console.warn("Guardrails validation failed:", err.message);
  }
}
```

### Error hierarchy

```
Error
├── GovernanceHaltError       — HALT verdict or approval rejection converted to halt
│   └── .identifier           — URL that triggered it (hook-level), or ""
├── GovernanceBlockedError    — BLOCK verdict or REQUIRE_APPROVAL before HITL starts
│   ├── .verdict              — "block" | "halt" | "require_approval"
│   └── .identifier           — URL (hook-level), or ""
├── GuardrailsValidationError — guardrail check failed
│   └── .message              — reason string from OpenBox Core
├── ApprovalRejectedError     — human rejected on dashboard (usually converted to HaltError)
├── ApprovalExpiredError      — approval request expired on the server
└── ApprovalTimeoutError      — SDK timed out waiting for a decision
    └── .maxWaitMs            — the configured timeout value
```

---

## Important: AgentExecutor Setup

LangChain's `AgentExecutor` has a critical behaviour: **it silently converts tool errors into observation strings** by default. This means `GovernanceHaltError` becomes `Observation: ""` and the LLM tries to call the tool again — bypassing governance entirely.

**Always configure `handleToolRuntimeErrors` to re-throw governance errors:**

```typescript
import {
  GovernanceHaltError,
  GovernanceBlockedError,
  GuardrailsValidationError,
} from "@openbox/langchain-sdk";

const executor = new AgentExecutor({
  agent,
  tools: governedTools,
  callbacks: [handler],
  handleToolRuntimeErrors: (e: unknown) => {
    // Re-throw governance errors so they propagate correctly
    if (
      e instanceof GovernanceHaltError ||
      e instanceof GovernanceBlockedError ||
      e instanceof GuardrailsValidationError
    ) {
      throw e;
    }
    // All other tool errors become observation strings (normal LangChain behaviour)
    return `Tool error: ${e instanceof Error ? e.message : String(e)}`;
  },
});
```

Without this, after a `HALT` verdict the agent will retry the tool, see an empty observation, retry again, and eventually exhaust its `maxIterations` limit. The HALT is silently ignored.

---

## Important: LLM Memory and Context Injection

When you use `BufferMemory` or manually inject conversation history into the agent's `input` string, the LLM reads its own prior reasoning before deciding which tool to call. This can cause **pre-refusal** — the LLM skips calling a tool based on what it previously said, so no governance event is ever sent and policies are bypassed.

**Symptom:** You have a policy that should BLOCK or REQUIRE_APPROVAL a certain action. After the first time it fires, subsequent requests with the same input are silently allowed — no governance event appears in the dashboard.

**Cause:** The agent received something like this in its `input`:

```
[Conversation so far]
Human: Transfer $60,000 to account 9876543210
AI: I cannot process this transfer — it exceeds the $50,000 compliance limit.

[Customer]
Transfer $60,000 to account 9876543210
```

The LLM reads the prior AI response and reasons: *"I already decided this is blocked — I won't call `transfer_funds`."* No tool call → no governance event.

**The fix:** Replace raw conversation history injection with structured session state — only inject facts the agent needs to function (e.g. authentication status, user name), not prior AI reasoning turns:

```typescript
// ❌ Don't do this — prior AI turns bias tool-calling decisions
const historyText = conversationHistory
  .map((m) => `${m.role === "human" ? "Human" : "AI"}: ${m.content}`)
  .join("\n");
const enrichedInput = `[Conversation so far]\n${historyText}\n\n${userInput}`;

// ✅ Do this instead — structured state only, no prior AI reasoning
const sessionContext = isAuthenticated
  ? `[Session context] Customer authenticated: ${customer.name} (${customer.email})`
  : `[Session context] Customer not yet authenticated`;
const enrichedInput = `${sessionContext}\n\n${userInput}`;
```

Keep `conversationHistory` for bookkeeping and display, but do not inject it into the agent's `input`. Each turn should be stateless from the LLM's perspective beyond the minimal context it needs to act.

---

## Signal Monitor (Mid-Run Halt)

The `OpenBoxSignalMonitor` polls OpenBox Core on an interval and aborts the current run if a HALT or BLOCK signal arrives from the dashboard. This lets operators stop a running agent mid-execution without waiting for the current tool to finish.

```typescript
const handler = await createOpenBoxHandler({
  apiUrl: process.env.OPENBOX_URL!,
  apiKey: process.env.OPENBOX_API_KEY!,
  enableSignalMonitor: true,   // starts a polling loop for mid-run signals
});

const result = await executor.invoke(
  { input: "..." },
  {
    callbacks: [handler],
    signal: handler.abortController?.signal,  // connects AbortController to LangChain
  }
);

// Stop the monitor when the session ends (e.g. on SIGINT)
process.on("SIGINT", () => {
  handler.signalMonitor?.stop();
  process.exit(0);
});
```

When a signal arrives:
1. `abortController.abort()` is called — LangChain's executor sees the abort signal and stops
2. The current tool call throws `GovernanceHaltError`
3. Your `catch` block handles it normally

---

## Configuration Reference

### `createOpenBoxHandler(config)`

Factory function. Returns a configured `OpenBoxCallbackHandler`. Validates the API key on startup by default.

| Option | Type | Default | Description |
|---|---|---|---|
| `apiUrl` | `string` | — | OpenBox Core base URL |
| `apiKey` | `string` | — | API key (`obx_live_*` or `obx_test_*`) |
| `validate` | `boolean` | `true` | Ping API key on startup |
| `onApiError` | `"fail_open" \| "fail_closed"` | `"fail_open"` | Policy when OpenBox is unreachable |
| `apiTimeout` | `number` | `30000` | Per-request timeout in ms |
| `sendChainStartEvent` | `boolean` | `true` | Send `ChainStarted` events |
| `sendChainEndEvent` | `boolean` | `true` | Send `ChainCompleted` events |
| `sendToolStartEvent` | `boolean` | `true` | Send `ToolStarted` events |
| `sendToolEndEvent` | `boolean` | `true` | Send `ToolCompleted` events |
| `sendLLMStartEvent` | `boolean` | `true` | Send `LLMStarted` events |
| `sendLLMEndEvent` | `boolean` | `true` | Send `LLMCompleted` events |
| `skipChainTypes` | `string[]` | `[]` | Chain type names to skip entirely |
| `skipToolTypes` | `string[]` | `[]` | Tool names to skip entirely |
| `hitl.enabled` | `boolean` | `false` | Enable HITL polling |
| `hitl.pollIntervalMs` | `number` | `5000` | How often to poll for a decision |
| `hitl.maxWaitMs` | `number` | `600000` | Timeout before `ApprovalTimeoutError` |
| `hitl.skipToolTypes` | `Set<string>` | `new Set()` | Tools that never need HITL |
| `enableSignalMonitor` | `boolean` | `false` | Poll for mid-run HALT/BLOCK signals |
| `sessionId` | `string` | — | Session ID shown in the dashboard |
| `raiseError` | `boolean` | `false` | Throw `GuardrailsValidationError` on guardrail failure |

### `wrapTool(tool, handler)` / `wrapTools(tools, handler)`

Wraps one or more LangChain tools to enable:
1. **Input redaction** — if a guardrail redacted the tool input, the redacted version is what actually runs
2. **Output redaction** — if a guardrail redacted the tool output, the redacted version is returned to the LLM
3. **Hook-level HITL** — if an outbound HTTP request inside the tool triggers `REQUIRE_APPROVAL`, the tool call is held and retried after approval

Must be used with `callbacks: [handler]` on the executor. Both need the same `handler` instance.

### `wrapLLM(llm, handler)`

Wraps a `ChatOpenAI` or any `BaseLanguageModel` to ensure guardrails-redacted prompts are sent to the model instead of the original prompts.

### `setupTelemetry()`

Patches `globalThis.fetch` to capture HTTP spans and enable hook-level governance. Call once at startup, before any tool runs. Idempotent — safe to call multiple times.

---

## Architecture

```
Your LangChain Agent / Chain / LLM
          │
          ▼
 OpenBoxCallbackHandler   ← attach via callbacks: [handler]
   ├── handleChainStart / End / Error
   ├── handleLLMStart / End / Error       ← policy evaluated on each LLM call
   ├── handleToolStart / End / Error      ← policy evaluated on each tool call
   ├── handleAgentAction / Finish
   └── handleRetrieverStart / End / Error
          │
          ▼
   RunBufferManager          ← tracks run_id hierarchy, timing, abort/halt state
          │
          ▼
   GovernanceClient          ← HTTP POST to OpenBox Core
     ├── evaluateEvent()     ← activity-level events (tool, LLM, chain)
     └── evaluateRaw()       ← hook-level events (per fetch() call)
          │
          ▼
   enforceVerdict()
     ├── ALLOW / CONSTRAIN   → continue
     ├── BLOCK               → throw GovernanceBlockedError
     ├── HALT                → throw GovernanceHaltError
     └── REQUIRE_APPROVAL    → pollUntilDecision() → block until human decides
                                 ├── Approved     → continue (tool retried)
                                 └── Rejected     → throw GovernanceHaltError

─── Hook-Level (per fetch() inside tools) ─────────────────────────────

   setupTelemetry()          ← patches globalThis.fetch once at startup
     │
     ├── Stage "started"     → evaluateHttpHook() — BLOCK stops request before it fires
     └── Stage "completed"   → evaluateHttpHook() — informational, errors swallowed

   wrapTool()                ← catches hook REQUIRE_APPROVAL → polls → retries tool
```

### Key internal modules

| Module | Role |
|---|---|
| `callback-handler.ts` | `OpenBoxCallbackHandler` — main integration point |
| `client.ts` | `GovernanceClient` — HTTP layer to OpenBox Core |
| `run-buffer.ts` | `RunBufferManager` — tracks run hierarchy, timing, abort/halt flags |
| `verdict-handler.ts` | `enforceVerdict()` — maps AGE response to SDK action |
| `hitl.ts` | `pollUntilDecision()` — async HITL polling loop |
| `guardrails.ts` | `applyInputRedaction` / `applyOutputRedaction` |
| `wrappers.ts` | `wrapTool` / `wrapLLM` — intercept execution for redaction and HITL |
| `telemetry.ts` | `patchFetch` / `SpanCollector` — HTTP instrumentation |
| `hook-governance.ts` | Hook-level governance evaluator |
| `signal-monitor.ts` | `OpenBoxSignalMonitor` — mid-run abort polling |
| `errors.ts` | All governance error classes |

---

## Troubleshooting

### Agent retries after a BLOCK or HALT verdict

LangChain's `AgentExecutor` silently converts tool errors to observation strings unless `handleToolRuntimeErrors` is set. See [Important: AgentExecutor Setup](#important-agentexecutor-setup).

### Policy fires twice for the same tool call

You are likely missing `not input.hook_trigger` in your Rego rule. Hook events carry a `hook_trigger` field; direct tool events do not. Without this guard, both the tool invocation event and the outbound HTTP request it makes match your rule — two approval dialogs appear.

```rego
result := {"decision": "REQUIRE_APPROVAL", ...} if {
    input.activity_type == "transfer_funds"
    not input.hook_trigger    ← required
}
```

### Governance is bypassed — no events in the dashboard

Check `OPENBOX_DEBUG=1` logs. If you see no `ActivityStarted` event for the tool call, the LLM is pre-refusing to call the tool before it executes — reading prior conversation history and deciding not to act. See [Important: LLM Memory and Context Injection](#important-llm-memory-and-context-injection).

### HITL approval is rejected but agent calls the tool again

Missing `handleToolRuntimeErrors` configuration on `AgentExecutor`. When the approval rejection propagates as `ApprovalRejectedError`, LangChain swallows it as an observation string and the LLM retries. See [Important: AgentExecutor Setup](#important-agentexecutor-setup).

### `activity_input` in Rego is double-encoded

LangChain's ReAct agent double-encodes tool arguments as `{"input": "{\"amount\": 100}"}`. The SDK unwraps this automatically before building the governance event — `activity_input[0]` is always the actual tool arguments object. Use `is_object(t)` in Rego, not `json.unmarshal`:

```rego
transfer := t if {
    input.activity_type == "transfer_funds"
    count(input.activity_input) > 0
    t := input.activity_input[0]
    is_object(t)     ← correct
}
```

### Debugging

```bash
# Log every governance request and response
export OPENBOX_DEBUG=1

# After running your agent:
cat /tmp/openbox.log | grep "activity_type.*transfer_funds"
```

---

## Requirements

- **Node.js** >= 18
- **`@langchain/core`** >= 0.2.0

## License

MIT
