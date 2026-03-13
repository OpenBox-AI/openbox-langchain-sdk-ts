# OpenBox LangChain SDK — Test Agent

A LangChain agent + local server + React UI wired up to the OpenBox governance SDK.

## What it does

- Runs a multi-step banking support agent (BankBot) with governance-enabled tools (auth, transfers, loans, stock lookup)
- Intercepts LLM calls, tool calls, and outbound HTTP via the OpenBox handler
- Supports Guardrails (e.g. PII redaction), Policies (OPA/Rego), and Behavior Rules (span-based)
- Demonstrates Human-in-the-Loop (HITL) approvals

## Setup

```bash
cd sdk/test-agent
npm install

cp .env.example .env
# fill in your keys
```

### Environment variables

- **`OPENAI_API_KEY`** (required)
- **`OPENBOX_URL`** (required)
  - Example: `https://core.openbox.ai`
- **`OPENBOX_API_KEY`** (required)

For detailed governance configuration in the dashboard (Guardrails/Policies/Behavior/HITL), see `SETUP.md`.

## Run

```bash
# 1) Run the agent as a local HTTP server (API on :3141)
npm run server

# 2) Run the UI (Vite on :5174, proxies /api -> http://localhost:3141)
npm run ui
```

Then open:

- `http://localhost:5174`

### CLI mode (no UI)

```bash
npm run dev
```

## Example prompts

- `Please authenticate me: email jane.doe@example.com passport A12345678`
- `Transfer $2000 from CHK-001 to account 9876543210`
- `Transfer $20000 from CHK-001 to account 9876543210` (should trigger HITL if configured)
- `Transfer $60000 from CHK-001 to account 9876543210` (should be blocked/halt if configured)
- `What is the current price of AAPL?` (useful for Behavior Rule testing)

## Governance behavior

| Scenario | What happens |
|---|---|
| Guardrails violation | Request may be blocked or redacted depending on Guardrail settings |
| Policy `BLOCK` | Tool call is blocked; UI shows a blocked/halt outcome |
| Policy `REQUIRE_APPROVAL` | Agent pauses and polls until approved/rejected |
| Behavior Rule verdict | Evaluated on HTTP spans (e.g. stock price lookup) |

## SDK features demonstrated

- `createOpenBoxHandler()` — handler construction + configuration
- `setupTelemetry()` — patches global `fetch` for HTTP span collection
- `wrapTools()` — wraps tools for guardrails redaction and governance
- Event coverage across workflow/LLM/tool lifecycle

## Troubleshooting

- **UI loads but chat errors**
  - Ensure the agent server is running: `npm run server`
  - The UI proxies `GET/POST /api/*` to `http://localhost:3141` (see `ui/vite.config.ts`).
- **Port already in use**
  - Agent server uses `3141`. UI uses `5174`.
- **HITL never triggers**
  - Confirm you deployed Policies / Behavior Rules in the OpenBox dashboard (see `SETUP.md`).
