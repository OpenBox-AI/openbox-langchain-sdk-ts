# openbox-langchain-governance

OpenBox governance + observability for [LangChain](https://www.langchain.com/) JS/TS
agents. A thin adapter over the base SDK
[`@openbox-ai/openbox-sdk`](https://www.npmjs.com/package/@openbox-ai/openbox-sdk),
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
npm install openbox-langchain-governance @openbox-ai/openbox-sdk @langchain/core
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
  await openbox.close(); // shut down instrumentation + runtime
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

## License

MIT
