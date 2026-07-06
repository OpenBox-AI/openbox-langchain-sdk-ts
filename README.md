# OpenBox SDK for LangChain (JS/TS)

OpenBox SDK provides governance and observability for LangChain agents by capturing agent/model/tool lifecycle events, HTTP telemetry, database queries, and file operations, then sending them to OpenBox Core for policy evaluation.

Key Features:

- 9 event types (SignalReceived, WorkflowStarted, WorkflowCompleted, LLMStarted, LLMCompleted, ToolStarted, ToolCompleted, ActivityStarted, ActivityCompleted)
- 6-tier verdict system (ALLOW, MONITOR, CONSTRAIN, REQUIRE_APPROVAL, BLOCK, HALT)
- Hook-level governance — per-operation evaluation (HTTP requests, file I/O, database queries) with started/completed stages
- HTTP/Database/File I/O instrumentation via runtime monkey-patching — no OpenTelemetry dependency
- Guardrails: Input/output validation and redaction
- Human-in-the-loop approval with expiration handling
- Explicit lifecycle hooks (`beforeAgent` / `afterAgent` / `wrapModelCall` / `wrapToolCall` / `wrapMemoryOp`) — wrap only what you want governed, no framework magic
- Optional Ed25519 request signing (AIP protocol) for deployments that require signed governance calls

## Installation

Not yet published to the npm registry — install from source:

```bash
git clone https://github.com/OpenBox-AI/openbox-langchain-sdk-ts.git
cd openbox-langchain-sdk-ts
npm install
npm run build
```

`dist/` is gitignored on `main`, so consumers normally run the build
themselves as above.

Once a version has been published via
[`.github/workflows/release.yml`](.github/workflows/release.yml) (triggered
by pushing a bare-semver tag like `1.0.0`), you'll be able to install it
directly from the registry instead:

```bash
npm install @openbox/langchain-governance
```

Requirements:

- Node.js 18+ (the SDK patches the global `fetch` API introduced in Node 18 for HTTP telemetry)
- `@langchain/core` >= 0.2.0 (peer dependency — bring your own LangChain version; the middleware only ever sees plain message arrays, never LangChain classes)
- TypeScript 5.4+ (only if building from source)

## Quick Start

Wrap the lifecycle of an agent turn with `beforeAgent` / `wrapModelCall` / `afterAgent`:

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { OpenBoxLangChainMiddleware } from "@openbox/langchain-governance";

const mw = new OpenBoxLangChainMiddleware({
  apiKey: process.env.OPENBOX_API_KEY!,
  openboxUrl: "https://core.openbox.ai",   // optional, this is the default
  agentName: "MyContentAgent",
  hitl: { enabled: true, pollIntervalMs: 5000, timeoutMs: 300000 },
});

const model = new ChatOpenAI({ modelName: "gpt-4o" });

const messages = [
  ["system", "You are a helpful assistant."],
  ["human", "Write a LinkedIn post about AI governance."],
];

// 1. Signal governance that the agent is starting
await mw.beforeAgent({ messages });

// 2. Wrap the model call — governance fires LLMStarted + LLMCompleted
const response = await mw.wrapModelCall(messages, () =>
  model.invoke(messages)
);

// 3. Signal governance that the agent completed
await mw.afterAgent({ messages: [...messages, response] });

console.log(response);
```

There is no factory or plugin that wires this up for you — the three
calls above are the entire integration surface. Call them from wherever
your agent loop already lives (a LangGraph node, a plain function, a
Temporal activity, etc).

### Wrapping Tool Calls

```typescript
const toolResult = await mw.wrapToolCall(
  "wikipedia_search",          // tool name
  { query: "AI governance" },  // tool args
  () => myWikipediaTool.invoke("AI governance"),
);
```

### Wrapping Memory Operations

Scopes a memory load/save so any HTTP/DB calls made inside it are
attributed to that activity on the dashboard:

```typescript
const variables = await mw.wrapMemoryOp("loadMemoryVariables", () =>
  memory.loadMemoryVariables({ input: userInput }),
);
```

## Configuration

### Environment Variables

```
OPENBOX_API_KEY=obx_live_...
OPENBOX_API_URL=https://core.openbox.ai   # optional override

# Optional — Ed25519 identity for signed (AIP) requests. Leave unset to
# authenticate with the Bearer API key alone.
OPENBOX_AGENT_DID=
OPENBOX_AGENT_PRIVATE_KEY=
```

### Constructor Options

```typescript
const mw = new OpenBoxLangChainMiddleware({
  apiKey: "obx_live_...",
  openboxUrl: "https://core.openbox.ai",
  agentName: "MyContentAgent",          // workflow_type label on the dashboard
  sessionId: "session-123",             // groups multiple runs under one session
  taskQueue: "langchain",               // queue tag on all events

  onApiError: "fail_open",              // or "fail_closed"
  governanceTimeout: 30000,

  hitl: { enabled: true, pollIntervalMs: 5000, timeoutMs: 300000 },

  // Tool event filtering
  skipToolTypes: new Set(["internal_lookup"]),
  toolTypeMap: { wikipedia_search: "search" },

  // Per-event-type toggles (all default true)
  sendChainStartEvent: true,
  sendChainEndEvent: true,
  sendLlmStartEvent: true,
  sendLlmEndEvent: true,
  sendToolStartEvent: true,
  sendToolEndEvent: true,

  // Hook-level instrumentation toggles
  instrumentHttp: true,        // default true
  instrumentDatabases: true,   // default true
  instrumentFileIo: false,     // default false

  // Ed25519 identity for signed (AIP) requests — optional
  agentDid: process.env.OPENBOX_AGENT_DID,
  agentPrivateKey: process.env.OPENBOX_AGENT_PRIVATE_KEY,
});
```

| Option | Default | Description |
|---|---|---|
| `apiKey` | required | OpenBox API key |
| `openboxUrl` | `https://core.openbox.ai` | OpenBox Core API URL |
| `agentName` | `LangChainRun` | Workflow type label on the dashboard |
| `sessionId` | — | Groups multiple runs under one session |
| `taskQueue` | `langchain` | Queue tag on all events |
| `onApiError` | `fail_open` | `fail_open` = continue on API error; `fail_closed` = throw |
| `governanceTimeout` | `30000` | Per-request timeout (ms) to OpenBox Core |
| `hitl.enabled` | `true` | Enable human-in-the-loop approval polling |
| `hitl.pollIntervalMs` | `5000` | How often to poll for approval |
| `hitl.timeoutMs` | `300000` | Max wait time for approval (5 min) |
| `skipToolTypes` | `new Set()` | Tool names to skip governance for |
| `toolTypeMap` | `{}` | Map tool name → tool_type tag |
| `instrumentHttp` | `true` | Patch `fetch` + `node:http`/`node:https` for HTTP telemetry |
| `instrumentDatabases` | `true` | Patch `pg`, `mysql2`, `mongodb`, `redis`, `ioredis` for query telemetry |
| `instrumentFileIo` | `false` | Patch `fs` for file-operation telemetry |
| `agentDid` / `agentPrivateKey` | — | Optional Ed25519 identity for signed (AIP) requests |

## Governance Verdicts

OpenBox Core returns a verdict indicating what action the SDK should take.

| Verdict | Behavior |
|---|---|
| `allow` | Continue execution normally |
| `monitor` | Continue execution normally |
| `constrain` | Log constraints, continue |
| `require_approval` | Pause, poll HITL until approved/rejected/timed out |
| `block` | Throw `GovernanceBlockedError` |
| `halt` | Throw `GovernanceHaltError` |

Guardrail violations throw `GuardrailsValidationError` with a `reasons` array, independently of the verdict arm.

Backward-compatible verdict strings:

- `"continue"` → `allow`
- `"stop"` → `halt`
- `"request_approval"` → `require_approval`

## Event Types

| Event | Trigger | Notable Fields |
|---|---|---|
| `SignalReceived` | Agent turn starts, user prompt found | `signal_name`, `signal_args` |
| `WorkflowStarted` | Agent turn starts | `activity_type`, `activity_input` |
| `WorkflowCompleted` | Agent turn ends | `workflow_output`, `status`, `error` |
| `LLMStarted` | Before a wrapped model call | `prompt`, `activity_input` |
| `LLMCompleted` | After a wrapped model call | `llm_model`, `input_tokens`, `output_tokens`, `total_tokens`, `has_tool_calls`, `completion`, `duration_ms` |
| `ToolStarted` | Before a wrapped tool call | `tool_name`, `tool_type`, `activity_input` |
| `ToolCompleted` | After a wrapped tool call | `tool_name`, `activity_output`, `status`, `duration_ms` |
| `ActivityStarted` / `ActivityCompleted` | Wrapped memory op (`wrapMemoryOp`) | `activity_type`, `status`, `duration_ms` |

OpenBox Core only accepts Temporal SDK canonical event types. Before a
request hits the wire, `LLMStarted`/`LLMCompleted` and
`ToolStarted`/`ToolCompleted` are translated to `ActivityStarted`/
`ActivityCompleted`, with the original LangChain-specific name preserved
in `metadata.sdk_event_type`.

## Guardrails (Input/Output Redaction)

OpenBox Core can validate and redact sensitive data on the LLM-call path.
When a `guardrails_result` comes back on the `LLMStarted` response, the
SDK rewrites the outgoing prompt in-place before the model call runs:

```jsonc
// Response to LLMStarted
{
  "verdict": "allow",
  "guardrails_result": {
    "input_type": "activity_input",
    "redacted_input": [{ "prompt": "[REDACTED]" }],
    "validation_passed": true,
    "reasons": []
  }
}

// If validation fails:
{
  "validation_passed": false,
  "reasons": [
    { "type": "pii", "field": "email", "reason": "Contains PII" }
  ]
}
```

A failed validation throws `GuardrailsValidationError` with the
collected `reasons`.

## Error Handling

Configure error policy via `onApiError`:

| Policy | Behavior |
|---|---|
| `fail_open` (default) | If the governance API fails, allow the call to continue |
| `fail_closed` | If the governance API fails, throw `SoftGovernanceError` |

## Supported Instrumentation

Enabled via `instrumentHttp` / `instrumentDatabases` / `instrumentFileIo` on the middleware constructor. All instrumentation is applied with `require`-time monkey-patching — there is no OpenTelemetry dependency.

### HTTP

- Global `fetch` (Node 18+) — full request + response body capture
- `node:http` / `node:https` — full request + response body capture

Response bodies are only captured for `application/json` and `text/*`
content types, with a 5s read timeout so a hanging response body never
blocks the call.

### Databases

Query-level governance via `require`-time monkey-patching, active whenever a module is already loaded or gets `require`'d after the middleware is constructed:

| Library | Patch Point | Can Block? |
|---|---|---|
| `pg` | `Client.prototype.query` / `Pool.prototype.query` | Yes |
| `mysql2` | `Connection.prototype.query` | Yes |
| `mongodb` | `Collection.prototype.{find,findOne,insertOne,updateOne,deleteOne,aggregate}` | Yes |
| `redis` | `sendCommand` on clients from `createClient()` | Yes |
| `ioredis` | `sendCommand` on the client prototype | Yes |

### File I/O

- `fs.promises.{readFile,writeFile,appendFile,open}` (including reads/writes/close on the returned file handle)
- Callback-style `fs.{readFile,writeFile,appendFile}`
- Skips system paths (`/dev/`, `/proc/`, `/sys/`, `/node_modules/`)
- Disabled by default — set `instrumentFileIo: true` to enable

## Hook-Level Governance

Every HTTP request and database query made *during* a wrapped
`wrapModelCall`/`wrapToolCall`/`wrapMemoryOp` call is evaluated by
OpenBox Core in real time, at two stages:

| Stage | Trigger | Data Available |
|---|---|---|
| `started` | Before the request/query is sent | Method, URL, request body (HTTP); statement, host, db name (DB) |
| `completed` | After the response/result arrives | All of the above + response body, status code, duration, error |

How it works:

1. `wrapModelCall`/`wrapToolCall`/`wrapMemoryOp` calls `registerActivity(activityId, ...)`, associating that async context with an activity.
2. The patched `fetch`/`http`/`https`/DB-driver method fires during the handler → the SDK sends a `started` evaluation with request data.
3. If the verdict is `block`/`halt` → the request is aborted before it leaves the process.
4. If the verdict is `require_approval` → the SDK polls HITL before letting the request through; once approved, further hook evaluations for that activity are skipped.
5. After the response/result arrives → the SDK sends a `completed` evaluation with the full request + response data.
6. `unregisterActivity` tears down the association once the wrapped call resolves.

Duplicate HTTP spans (same activity, stage, method, URL, status within
1 second) are suppressed so a single retried request doesn't double-report.

## Architecture

High-level flow:

```
beforeAgent → wrapModelCall/wrapToolCall/wrapMemoryOp → afterAgent
                          │
                          ▼
                 GovernanceClient (axios)
                          │
                          ▼
               OpenBox Core: /api/v1/governance/evaluate
                          │
                          ▼
                    Returns a verdict
                          │
                          ▼
        (allow, monitor, constrain, require_approval, block, halt)

Hook-level (per HTTP request / DB query made inside a wrapped call):
patched fetch/http/https/db-driver → evaluateActivitySpan (started) → allow/block
                                    → evaluateActivitySpan (completed)
```

Module responsibilities:

- `middleware.ts` — public `OpenBoxLangChainMiddleware` class; thin shell that delegates to `hook_handlers`/`tool_hook`
- `hook_handlers.ts` — `beforeAgent` / `afterAgent` / `wrapModelCall` / `wrapMemoryOp` implementations
- `tool_hook.ts` — `wrapToolCall` implementation
- `hooks.ts` — shared helpers: event field building, prompt extraction, PII redaction, response-metadata extraction
- `client.ts` — `GovernanceClient`: HTTP transport to OpenBox Core, event-type translation, HITL polling
- `verdict.ts` — verdict parsing and enforcement, the SDK's error classes
- `hitl.ts` — human-in-the-loop approval poll loop
- `span_processor.ts` — activity-context registry, `fetch`/`node:http`/`node:https` patching, hook-level span evaluation
- `node_instrumentation.ts` — `fs` and DB-driver (`pg`/`mysql2`/`mongodb`/`redis`/`ioredis`) patching
- `signing.ts` — Ed25519 signed-header construction for the AIP protocol
- `config.ts` — option merging/defaults
- `types.ts` — shared types and serialization helpers

## Testing

Unit tests cover the pure logic in `verdict.ts` and `hooks.ts` (verdict
parsing/enforcement, message extraction, PII redaction, response-metadata
extraction) — nothing that needs a network call:

```bash
npm run test          # vitest run --coverage
npm run ci:check       # lint + typecheck + typecheck:examples + test
```

`test-smoke.js` is separate and makes a real network call to OpenBox Core
and OpenRouter, needing live `OPENBOX_API_KEY` / `OPENROUTER_API_KEY`
values in `.env`, so it's run manually rather than in CI:

```bash
npm run build
node test-smoke.js
```

See [`.github/workflows/`](.github/workflows/) for the CI workflows that
run automatically on every push/PR to `main` (lint, typecheck, test,
build, security scanning) and the full release gate on tagged releases.

## License

MIT — see [LICENSE](LICENSE).

## Support

Issues: [GitHub Issues](https://github.com/OpenBox-AI/openbox-langchain-sdk-ts/issues)
