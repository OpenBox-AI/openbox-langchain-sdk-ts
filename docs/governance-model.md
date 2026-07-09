# Governance model

How `@openbox-ai/openbox-langchain-sdk` applies OpenBox governance to LangChain
JS/TS agents.

## Two surfaces, one enforcement path

| Surface | Import | Enforces? |
|---|---|---|
| Create-agent middleware | `@openbox-ai/openbox-langchain-sdk/middleware` | **Yes** — the sole enforcement surface |
| Core callback handler | `@openbox-ai/openbox-langchain-sdk` (root) | **No** — observability only |

Only the **middleware** blocks execution. It wraps model and tool calls
(`wrapModelCall` / `wrapToolCall`) and throws **before** the wrapped call runs
when a governance verdict is BLOCK/HALT or an approval is rejected/expired —
LangChain's continuation model makes this a reliable fail-closed gate.

The **callback handler** produces lifecycle telemetry and a best-effort
span-correlation seam, and never blocks. LangChain JS logs and swallows a
throwing callback rather than aborting the run, so a callback cannot be a
governance gate. Do not present it as one.

## Enforce vs telemetry matrix

| Event | Surface / path | Mode |
|---|---|---|
| `WorkflowStarted` (beforeAgent, first) | middleware / telemetry evaluator | telemetry-only (creates the session) |
| `SignalReceived` (beforeAgent) | middleware / `runtime.evaluateLifecycle` | **enforce** (block on non-allow) |
| pre-screen `ActivityStarted` (beforeAgent) | middleware / `runtime.evaluateLifecycle` | **enforce** |
| `wrapModelCall` start | middleware / `runtime.evaluateLifecycle` (first call reuses the pre-screen) | **enforce** |
| `wrapToolCall` start | middleware / `runtime.evaluateLifecycle` | **enforce** |
| `WorkflowCompleted` (afterAgent) | middleware / telemetry evaluator | telemetry-only |
| All completions (model/tool) | middleware / telemetry evaluator | telemetry-only |
| All callback sends | callback / telemetry evaluator | observability-only |

Every enforcing gate that blocks sends `workflowFailed` and marks the turn
closed **before** throwing, so workflow-closure telemetry is never lost on a
blocked run (the success-path `afterAgent` hook does not run after a throw).

## Single active runtime (instrumentation)

Base instrumentation patches process-global HTTP/DB/file hooks and allows only
**one** active runtime per process. File hooks cover `fs.promises.readFile`/
`writeFile` (async, preflight-blockable) and `readFileSync`/`writeFileSync`/
`mkdirSync` (sync, completed-hook telemetry only — a synchronous Node API cannot
await Core before the op runs, so it is audited but never pre-blocked;
`fileEnabled: false` disables both). The factory installs instrumentation
default-ON but is **collision-safe**: a second middleware built on a different
runtime in the same process catches the collision, logs a loud diagnostic, and
continues with `instrumentation: null`. Governance is still enforced for that
agent; only its low-level hook spans are not captured. The returned `close()` is
always valid and idempotent: it awaits `instrumentation?.flush()` (draining the
fire-and-forget sync-fs completed telemetry) before `instrumentation?.shutdown()`
then `runtime.close()`.

## Fail-open vs fail-closed

`onApiError` defaults to **`fail_open`** (matching the base SDK fleet default):
a network/connectivity failure to Core yields a fallback ALLOW so a Core outage
does not take down the agent. Auth/signing failures (401/403) always throw
regardless of this setting.

For destructive agents, set `onApiError: "fail_closed"` so a Core outage blocks
rather than allows.

## Redaction

When a governed model-start verdict carries guardrails `redactedInput`, the
middleware substitutes that redacted string into the user message and passes the
**modified** request to the model — the raw prompt never reaches the provider.
Redaction applies only to the pre-call (input) stage; output-stage redaction
never rewrites the outbound prompt.

## Span correlation

Model and tool bodies run inside an OpenBox activity scope (AsyncLocalStorage)
plus a trace-map fallback, so base-instrumentation spans for HTTP/DB/file work
resolve to the enclosing LLM/tool activity. The middleware is the primary,
supported correlation path; the callback surface offers a best-effort seam only.
