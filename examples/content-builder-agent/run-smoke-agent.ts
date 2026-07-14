// Runnable, fully-offline smoke example for the enforcing middleware.
//
//   npm run build && node examples/content-builder-agent/run-smoke-agent.ts
//
// It uses a fake chat model, a fake tool, and a fake OpenBox Core (injected
// runtime) so it runs with NO network, NO OpenAI/Core, and NO secrets. In a
// real app you would instead pass `{ apiUrl, apiKey }` and let the middleware
// build the runtime (instrumentation defaults ON).

import { createAgent, tool } from "langchain";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import { OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";
import { FakeCore } from "@openbox-ai/openbox-sdk-ts/conformance";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";
import { z } from "zod";

import { createOpenBoxLangChainMiddleware } from "openbox-langchain-governance/middleware";

// ── A minimal fake chat model that emits one tool call, then a final answer ──
class SmokeChatModel extends BaseChatModel {
  private calls = 0;
  _llmType(): string {
    return "smoke";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
    const message =
      this.calls === 1
        ? new AIMessage({
            content: "",
            tool_calls: [
              { name: "wordcount", args: { text: "hello openbox" }, id: "c1", type: "tool_call" }
            ]
          })
        : new AIMessage({ content: "Done: the phrase has 2 words." });
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

// ── The offline harness: a fake OpenBox Core wired into an injected runtime ──
function buildFakeRuntime(): OpenBoxRuntime {
  const core = new FakeCore(); // empty queue → every evaluate returns ALLOW
  const config = OpenBoxConfig.resolve({
    apiUrl: "https://core.example",
    apiKey: "obx_test_smoke_key",
    sdkEngine: "langchain",
    sdkLanguage: "typescript"
  });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: core.fetchImpl,
    timeoutSeconds: config.timeoutSeconds,
    onApiError: config.onApiError,
    sdkEngine: "langchain",
    sdkLanguage: "typescript"
  });
  return new OpenBoxRuntime(config, { client });
}

async function main(): Promise<void> {
  const wordCountTool = tool(({ text }: { text: string }) => String(text.split(/\s+/).length), {
    name: "wordcount",
    description: "Count the words in a string.",
    schema: z.object({ text: z.string() })
  });

  const openbox = await createOpenBoxLangChainMiddleware({
    runtime: buildFakeRuntime(), // offline; real apps pass { apiUrl, apiKey } instead
    validate: false,
    installInstrumentation: false,
    agentName: "content-builder"
  });

  const agent = createAgent({
    model: new SmokeChatModel({}),
    tools: [wordCountTool],
    middleware: [openbox.middleware]
  });

  try {
    const result = await agent.invoke({ messages: [new HumanMessage("How many words in 'hello openbox'?")] });
    const last = result.messages[result.messages.length - 1];
    console.log("Agent result:", last?.content);
    console.log("Governance ran end-to-end with zero network calls.");
  } finally {
    await openbox.close();
  }
}

await main();
