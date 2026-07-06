# @openbox/langchain-governance

Standalone OpenBox governance middleware for **LangChain JS/TS**.  
Extracted from the [n8n-sdk-openbox](../n8n/n8n-sdk-openbox) custom node — **no n8n dependency**.

## Install

```bash
npm install
npm run build
```

## Quick Start

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { OpenBoxLangChainMiddleware } from "./dist";

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

## Wrapping Tool Calls

```typescript
const toolResult = await mw.wrapToolCall(
  "wikipedia_search",          // tool name
  { query: "AI governance" },  // tool args
  () => myWikipediaTool.invoke("AI governance"),
);
```

## Configuration

| Option | Default | Description |
|---|---|---|
| `apiKey` | required | OpenBox API key |
| `openboxUrl` | `https://core.openbox.ai` | OpenBox Core API URL |
| `agentName` | `LangChainRun` | Workflow type label on the dashboard |
| `sessionId` | — | Groups multiple runs under one session |
| `taskQueue` | `langchain` | Queue tag on all events |
| `onApiError` | `fail_open` | `fail_open` = continue on API error; `fail_closed` = throw |
| `hitl.enabled` | `true` | Enable human-in-the-loop approval polling |
| `hitl.pollIntervalMs` | `5000` | How often to poll for approval |
| `hitl.timeoutMs` | `300000` | Max wait time for approval (5 min) |
| `skipToolTypes` | `new Set()` | Tool names to skip governance for |
| `toolTypeMap` | `{}` | Map tool name → tool_type tag |

## Governance Verdicts

The middleware handles all verdict arms automatically:

| Verdict | Behaviour |
|---|---|
| `allow` / `monitor` / `constrain` | Execution continues |
| `require_approval` | Polls HITL until approved/rejected/timed out |
| `block` | Throws `GovernanceBlockedError` |
| `halt` | Throws `GovernanceHaltError` |

Guardrail violations throw `GuardrailsValidationError` with a `reasons` array.

## Environment Variables

```
OPENBOX_API_KEY=obx_live_...
OPENBOX_API_URL=https://core.openbox.ai   # optional override
```
