# OpenBox LangChain SDK — Test Agent

A real LangChain ReAct agent wired up to the OpenBox governance SDK.

## What it does

- Runs a multi-step ReAct agent with 3 tools: `calculator`, `web_search`, `send_report`
- Every LLM call and tool invocation is intercepted by the OpenBox governance handler
- HTTP spans are collected during tool execution via `setupTelemetry()`
- Guardrails redaction flows through `wrapTools()` — redacted inputs are used before the tool executes
- Governance errors (`BLOCK`, `HALT`, `REQUIRE_APPROVAL`) are caught and logged

## Setup

```bash
cd test-agent
npm install

cp .env.example .env
# fill in your keys
```

## Run

```bash
# Minimum — OpenBox in fail_open mode (runs without a live server)
OPENAI_API_KEY=sk-... npx tsx src/agent.ts

# Full — with a live OpenBox Core server
OPENAI_API_KEY=sk-... \
OPENBOX_URL=http://localhost:8086 \
OPENBOX_API_KEY=obx_... \
npx tsx src/agent.ts
```

## Queries the agent answers

1. `"What is 15% of 847, and what is the square root of that result?"` — uses the calculator tool
2. `"Search for information about LangChain and send a brief report"` — uses web_search + send_report

## Governance behavior

| Scenario | What happens |
|---|---|
| OpenBox unreachable | `onApiError: "fail_open"` → continues silently |
| `BLOCK` verdict | `GovernanceBlockedError` thrown — caught and logged |
| `HALT` verdict | `GovernanceHaltError` thrown — all further queries stop |
| Guardrails fail | `GuardrailsValidationError` thrown with reasons |
| `REQUIRE_APPROVAL` | HITL polling (disabled locally, enable with `hitl.enabled: true`) |

## SDK features demonstrated

- `createOpenBoxHandler()` — factory with API key validation
- `setupTelemetry()` — patches global `fetch` for HTTP span collection
- `wrapTools()` — wraps all tools for in-place guardrails redaction
- `handler.handleLLMNewToken()` — streaming token accumulation
- Full event coverage: `ChainStarted`, `LLMStarted`, `LLMCompleted`, `ToolStarted`, `ToolCompleted`, `AgentAction`, `AgentFinish`
