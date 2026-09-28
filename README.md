# openbox-langchain-governance

OpenBox governance + observability for [LangChain](https://www.langchain.com/) JS/TS
agents. A thin adapter over the base SDK
[`@openbox-ai/openbox-sdk-ts`](https://www.npmjs.com/package/@openbox-ai/openbox-sdk-ts),
mirroring the architecture and wire behavior of `openbox-langchain-sdk-python`.

> **Status:** active development; APIs may still change.

## Two governance surfaces

This package exposes **two independent** integration points. They are not
interchangeable:

| Surface | Import | Role |
|---|---|---|
| **Create-agent middleware** | `openbox-langchain-governance/middleware` | **Enforcement** — blocks model/tool calls that fail governance (fail-closed, throws before the wrapped call). This is the only surface that enforces. |
| **Core callback handler** | `openbox-langchain-governance` | **Observability only** — emits lifecycle telemetry and correlates spans. It **never** blocks execution and must not be relied on as a governance gate. |

The split is deliberate: LangChain JS callback rejection does not reliably abort
execution, so only the middleware can guarantee enforcement.

## Install

```bash
npm install openbox-langchain-governance @openbox-ai/openbox-sdk-ts @langchain/core
# For the enforcing middleware surface you also need the agent framework:
npm install langchain
```

`langchain` is an optional peer dependency — the root/callback surface only needs
`@langchain/core`; the `/middleware` subpath needs the full `langchain` package.

## Quickstart (enforcing middleware)

```ts
import { createAgent } from "langchain";
import { createOpenBoxLangChainMiddleware } from "openbox-langchain-governance/middleware";

const openbox = await createOpenBoxLangChainMiddleware({
  apiUrl: process.env.OPENBOX_API_URL,
  apiKey: process.env.OPENBOX_API_KEY,
  agentName: "content-builder"
});

const agent = createAgent({
  model,
  tools,
  middleware: [openbox.middleware]
});

try {
  const result = await agent.invoke({ messages: [/* ... */] });
} finally {
  // Drains in-flight sync-fs completed-hook telemetry (flush()), then shuts
  // down instrumentation + runtime. Always await it.
  await openbox.close();
}
```

## Observability-only callback

```ts
import { OpenBoxLangChainCoreCallbackHandler } from "openbox-langchain-governance";

const handler = new OpenBoxLangChainCoreCallbackHandler({ runtime, /* ... */ });
await agent.invoke(input, { callbacks: [handler] });
```

> The callback surface produces telemetry and span correlation only. To enforce
> governance you must use the middleware.

## Span correlation

The middleware runs each model and tool call inside an OpenBox activity scope
(AsyncLocalStorage) with a trace-map fallback, so HTTP/DB/file spans captured by
base instrumentation resolve to the enclosing LLM/tool activity. This is the
primary, supported correlation path. The callback surface offers a best-effort
correlation seam only.

File instrumentation covers `fs.promises.readFile`/`writeFile` (async,
preflight-blockable) and `readFileSync`/`writeFileSync`/`mkdirSync` (sync,
completed-hook telemetry only — a sync API cannot block before the op runs).
`instrumentation.fileEnabled: false` disables both. Because the sync wrapper
fires its telemetry after returning, `await openbox.close()` (which drains via
`flush()`) so the last fs event is durable.

## Runnable example

A fully offline smoke example (fake model, fake tool, fake Core — no network, no
secrets) lives in [`examples/content-builder-agent`](examples/content-builder-agent/run-smoke-agent.ts):

```bash
npm run build && npm run example:smoke
```

## Configuration

Environment prefix `OPENBOX_LANGCHAIN_*` layered over global `OPENBOX_*`. See the
base SDK for the full config surface. On-API-error posture defaults to
`fail_open`; set `onApiError: "fail_closed"` for destructive agents.

### Agent identity verification (OpenBox DID, Okta AI Agent, or Keycloak workload)

`createOpenBoxLangChainMiddleware`/`buildMiddlewareRuntime` forward the tagged
identity configuration straight to the base SDK's `OpenBoxClient.fromConfig` —
this package never mints a signature, assertion, or token itself. One runtime and
one client (one token cache) serve startup validation, every gate, approval
polling, HTTP/DB/file hooks, and completion telemetry.

**Keycloak workload identity (IAM v3, `keycloak_workload`):**

```ts
const openbox = await createOpenBoxLangChainMiddleware({
  apiUrl: process.env.OPENBOX_API_URL,
  apiKey: process.env.OPENBOX_API_KEY,
  identityMethod: "keycloak_workload", // recommended: a missing key is then an error
  workloadPrivateKey: process.env.OPENBOX_WORKLOAD_PRIVATE_KEY, // PKCS8 PEM RSA, keep in a secret store
  onApiError: "fail_closed"
});
// Supply openbox.middleware to createAgent; at shutdown:
await openbox.close();
```

The key may also come from `OPENBOX_LANGCHAIN_WORKLOAD_PRIVATE_KEY` (wins) or
`OPENBOX_WORKLOAD_PRIVATE_KEY`, and the method from
`OPENBOX_LANGCHAIN_AGENT_IDENTITY_METHOD` / `OPENBOX_AGENT_IDENTITY_METHOD`. A blank
env var (empty or whitespace-only) counts as unset, so an empty
`OPENBOX_LANGCHAIN_WORKLOAD_PRIVATE_KEY=` falls through to the global key instead of
shadowing it. Core supplies every other workload value. The base SDK fixes the client to `/api/v3/*`
before its first request, renews the short-lived workload token itself, and never
falls back to v1/v2 or API-key-only requests: an authentication or token-acquisition
failure at an enforcing gate throws before the model/tool handler runs — even under
`fail_open`. Best-effort completion/callback telemetry may log a sanitized send
failure but never reopens a gate. An Okta-sourced agent moved to workload
authentication may keep `oktaAgentPrivateKey` as the key only together with
`identityMethod: "keycloak_workload"`. Candidate proofs go through
`openbox.runtime.client.proveWorkloadIdentityTransition(...)`.

**OpenBox DID (v1, default):**

```ts
const openbox = await createOpenBoxLangChainMiddleware({
  apiUrl: process.env.OPENBOX_API_URL,
  apiKey: process.env.OPENBOX_API_KEY,
  agentDid: process.env.OPENBOX_AGENT_DID,
  agentPrivateKey: process.env.OPENBOX_AGENT_PRIVATE_KEY
});
```

**Okta AI Agent (v2):**

```ts
const openbox = await createOpenBoxLangChainMiddleware({
  apiUrl: process.env.OPENBOX_API_URL,
  apiKey: process.env.OPENBOX_API_KEY,
  agentId: process.env.OPENBOX_AGENT_ID,
  organizationId: process.env.OPENBOX_ORGANIZATION_ID,
  deploymentId: process.env.OPENBOX_DEPLOYMENT_ID,
  agentProofAudience: process.env.OPENBOX_AGENT_PROOF_AUDIENCE,
  oktaAgentId: process.env.OPENBOX_OKTA_AGENT_ID,
  oktaAgentKeyId: process.env.OPENBOX_OKTA_AGENT_KEY_ID,
  oktaAgentPrivateKey: process.env.OPENBOX_OKTA_AGENT_PRIVATE_KEY, // PKCS8 PEM, keep in a secret store
  oktaAgentAlgorithm: "RS256"
});
```

Every field above may also be set via the corresponding `OPENBOX_LANGCHAIN_*` or
global `OPENBOX_*` environment variable (framework-prefixed wins), matching the
existing config-layering precedence. `agentDid`/`agentPrivateKey`, the Okta
fields, and `workloadPrivateKey` are mutually exclusive — the base SDK rejects
combining them before any request. An agent using `okta_ai_agent`
automatically calls Core's `/api/v2/*` routes (a key-only configuration uses Core's
v2 identity bootstrap); the SDK never retries a v2 auth failure against v1.

**Injected runtime.** When you pass `runtime`, it wins: the identity/config options
are ignored (no second client is built and no credentials are merged into it), and
`close()` closes that runtime and its client — coordinate shutdown if you share it.

## License

MIT
