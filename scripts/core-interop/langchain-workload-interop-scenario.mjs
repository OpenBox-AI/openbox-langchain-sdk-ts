// IAM v3 interop scenario for @openbox-ai/openbox-langchain-governance, run by
// openbox-sdk-ts's Go gate against Core's real v3 authentication and a
// controlled Keycloak issuer. Deterministic model/tool stubs — no LLM.
// Prints one `INTEROP_RESULT` JSON line for the Go test to assert.

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createAgent, tool } from "langchain";
import { z } from "zod";

import { createOpenBoxLangChainMiddleware } from "@openbox-ai/openbox-langchain-governance/middleware";

const env = process.env;
const steps = [];
const recorded = [];
const recordingFetch = (input, init) => {
  recorded.push({ url: typeof input === "string" ? input : input.url, init });
  return fetch(input, init);
};

class ScriptedModel extends BaseChatModel {
  constructor(script) {
    super({});
    this.script = script;
    this.calls = 0;
  }
  _llmType() {
    return "interop-scripted";
  }
  bindTools() {
    return this;
  }
  async _generate() {
    const message = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls += 1;
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

const toolCall = (name) =>
  new AIMessage({ content: "", tool_calls: [{ name, args: {}, id: `call-${name}`, type: "tool_call" }] });

async function step(name, fn) {
  try {
    const detail = await fn();
    steps.push({ step: name, ok: true, detail: String(detail ?? "") });
  } catch (error) {
    steps.push({ step: name, ok: false, detail: `${error?.name}: ${error?.message}` });
  }
}

const runs = { safe: 0, danger: 0 };
const safeTool = tool(() => {
  runs.safe += 1;
  return "ok";
}, { name: "safe", description: "allowed by policy", schema: z.object({}) });
const dangerTool = tool(() => {
  runs.danger += 1;
  return "should never run";
}, { name: "danger", description: "blocked by policy", schema: z.object({}) });

const openbox = await createOpenBoxLangChainMiddleware({
  apiUrl: env.INTEROP_CORE_URL,
  apiKey: env.INTEROP_API_KEY,
  identityMethod: "keycloak_workload",
  workloadPrivateKey: env.INTEROP_WORKLOAD_PRIVATE_KEY,
  fetchImpl: recordingFetch,
  installInstrumentation: false,
  agentName: "langchain-interop-agent"
});

function agentWith(model, tools) {
  return createAgent({ model, tools, middleware: [openbox.middleware] });
}

await step("allowed-tool-runs-once", async () => {
  const model = new ScriptedModel([toolCall("safe"), new AIMessage({ content: "done" })]);
  await agentWith(model, [safeTool]).invoke({ messages: [new HumanMessage("use the safe tool")] });
  if (runs.safe !== 1 || model.calls !== 2) throw new Error(`safe=${runs.safe} modelCalls=${model.calls}`);
  return "tool ran once, model twice";
});

await step("blocked-tool-runs-zero-times", async () => {
  const model = new ScriptedModel([toolCall("danger"), new AIMessage({ content: "done" })]);
  let rejected = false;
  try {
    await agentWith(model, [dangerTool]).invoke({ messages: [new HumanMessage("use the dangerous tool")] });
  } catch {
    rejected = true;
  }
  if (!rejected || runs.danger !== 0) throw new Error(`rejected=${rejected} danger=${runs.danger}`);
  return "blocked before the tool body";
});

await step("one-branded-v3-client", () => {
  const core = recorded.filter((r) => r.url.startsWith(env.INTEROP_CORE_URL));
  const legacy = core.filter((r) => /\/api\/v[12]\//.test(new URL(r.url).pathname));
  const governed = core.filter((r) => new URL(r.url).pathname !== "/api/v3/auth/bootstrap");
  const branded = governed.every((r) => /^openbox-langchain-typescript-v/.test(new Headers(r.init?.headers).get("x-openbox-sdk-version") ?? ""));
  const tokens = new Set(governed.map((r) => new Headers(r.init?.headers).get("x-openbox-workload-token")));
  const exchanges = recorded.filter((r) => r.url === env.INTEROP_TOKEN_ENDPOINT).length;
  if (legacy.length || !branded || tokens.size !== 1 || tokens.has(null) || exchanges !== 1) {
    throw new Error(`legacy=${legacy.length} branded=${branded} tokens=${tokens.size} exchanges=${exchanges}`);
  }
  return `${governed.length} governed requests on one token`;
});

await step("revoked-api-key-stops-execution", async () => {
  const response = await fetch(`${env.INTEROP_CONTROL_URL}?action=revoke-api-key`, { method: "POST" });
  if (!response.ok) throw new Error("control failed");
  const model = new ScriptedModel([toolCall("safe"), new AIMessage({ content: "done" })]);
  const before = runs.safe;
  let rejected = false;
  try {
    await agentWith(model, [safeTool]).invoke({ messages: [new HumanMessage("after revocation")] });
  } catch {
    rejected = true;
  }
  if (!rejected || model.calls !== 0 || runs.safe !== before) {
    throw new Error(`rejected=${rejected} modelCalls=${model.calls} safeRuns=${runs.safe - before}`);
  }
  return "model and tool executed zero times";
});

await openbox.close();
console.log(`INTEROP_RESULT ${JSON.stringify(steps)}`);
