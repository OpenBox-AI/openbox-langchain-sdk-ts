// Shared test fakes: a LangChain-compatible fake chat model + tool builders.
//
// The fake model MUST be able to emit tool calls — otherwise `wrapToolCall`,
// tool governance, and the span-correlation tests are never exercised.
// Extended in later phases with FakeCore verdict scripting.

import { createAgent, tool } from "langchain";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  type BaseChatModelParams
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import {
  AUTH_VALIDATE_PATH,
  EVALUATE_PATH,
  OpenBoxClient
} from "@openbox-ai/openbox-sdk-ts/client";
import { OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";
import { FakeAdapter, FakeCore } from "@openbox-ai/openbox-sdk-ts/conformance";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";
import { z } from "zod";

import { SDK_ENGINE, SDK_LANGUAGE, SDK_PACKAGE_VERSION } from "../src/index.js";
import {
  createOpenBoxLangChainMiddleware,
  type OpenBoxLangChainMiddlewareBundle,
  type OpenBoxLangChainMiddlewareOptions
} from "../src/middleware/index.js";

/** A scripted response: either a fixed message or a factory (fresh each call). */
export type FakeResponse = AIMessage | (() => AIMessage);

export interface FakeChatModelFields extends BaseChatModelParams {
  /** Ordered responses; the last entry is reused if the model is called more times. */
  script?: FakeResponse[];
  /** Observation hook invoked at the top of every `_generate` (used by the ALS spike). */
  onGenerate?: (messages: BaseMessage[]) => void | Promise<void>;
}

/**
 * Minimal `BaseChatModel` for deterministic, network-free agent tests. Ignores
 * bound tools (returns `this`) and replays a scripted sequence of AI messages.
 */
export class FakeChatModel extends BaseChatModel {
  private readonly script: FakeResponse[];
  private readonly onGenerate?: (messages: BaseMessage[]) => void | Promise<void>;
  callCount = 0;

  constructor(fields: FakeChatModelFields = {}) {
    super(fields);
    this.script = fields.script ?? [new AIMessage({ content: "ok" })];
    if (fields.onGenerate) this.onGenerate = fields.onGenerate;
  }

  _llmType(): string {
    return "fake-openbox";
  }

  // `createAgent` binds tools onto the model; the fake ignores them.
  override bindTools(): this {
    return this;
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    if (this.onGenerate) await this.onGenerate(messages);
    const index = Math.min(this.callCount, this.script.length - 1);
    this.callCount += 1;
    const item = this.script[index] ?? new AIMessage({ content: "ok" });
    const message = typeof item === "function" ? item() : item;
    const text = typeof message.content === "string" ? message.content : "";
    return { generations: [{ text, message }] };
  }
}

/** Build an AI message that requests a single tool call. */
export function aiToolCall(
  name: string,
  args: Record<string, unknown>,
  id = "call_1"
): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ name, args, id, type: "tool_call" }]
  });
}

/** Build a terminal AI message (no tool calls → ends the agent loop). */
export function aiFinal(text: string): AIMessage {
  return new AIMessage({ content: text });
}

/** A trivial echo tool used to exercise the `wrapToolCall` governance path. */
export function makeEchoTool(onCall?: (text: string) => void) {
  return tool(
    ({ text }: { text: string }) => {
      onCall?.(text);
      return `echo:${text}`;
    },
    {
      name: "echo",
      description: "Echo the provided text.",
      schema: z.object({ text: z.string() })
    }
  );
}

// ── FakeCore-backed runtime (no network) ─────────────────────────────────────

export interface FakeRuntimeBundle {
  runtime: OpenBoxRuntime;
  core: FakeCore;
  adapter: FakeAdapter;
}

/**
 * Build an `OpenBoxRuntime` wired to a `FakeCore` fetch impl (zero network) and
 * a `FakeAdapter` (records every enforcement delegation). The injected client
 * sets identity options explicitly, since an injected client does not inherit
 * them from config.
 */
export function makeFakeCoreRuntime(
  configure?: (core: FakeCore) => void
): FakeRuntimeBundle {
  const core = new FakeCore();
  configure?.(core);
  const config = OpenBoxConfig.resolve({
    apiUrl: "https://core.test",
    apiKey: "obx_test_key",
    sdkEngine: SDK_ENGINE,
    sdkLanguage: SDK_LANGUAGE,
    sdkVersion: SDK_PACKAGE_VERSION
  });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl: core.fetchImpl,
    timeoutSeconds: config.timeoutSeconds,
    onApiError: config.onApiError,
    sdkEngine: SDK_ENGINE,
    sdkLanguage: SDK_LANGUAGE,
    sdkVersion: SDK_PACKAGE_VERSION
  });
  const adapter = new FakeAdapter();
  const runtime = new OpenBoxRuntime(config, { client, adapter });
  return { runtime, core, adapter };
}

// ── Content-routing fake Core (verdict decided per request body) ─────────────

export interface CapturedEvaluate {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface RoutingRuntimeBundle {
  runtime: OpenBoxRuntime;
  adapter: FakeAdapter;
  /** Every captured evaluate request, in order. */
  evaluates: CapturedEvaluate[];
}

/**
 * Build a runtime whose Core verdict is chosen by inspecting each evaluate
 * body — so a test can block a specific gate (by `event_type`/`activity_type`)
 * regardless of send order. `route` returns the response body (e.g.
 * `{ verdict: "block", reason: "..." }`); default is allow.
 */
export function makeRoutingCoreRuntime(
  route: (body: Record<string, unknown>) => Record<string, unknown>,
  adapterOptions?: ConstructorParameters<typeof FakeAdapter>[0]
): RoutingRuntimeBundle {
  const evaluates: CapturedEvaluate[] = [];
  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" }
    });
  const readBodyText = (body: unknown): string => {
    if (body === null || body === undefined) return "";
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return Buffer.from(body).toString("utf-8");
    return "";
  };

  const fetchImpl = ((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const bodyText = readBodyText(init?.body);
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    if (url.includes(AUTH_VALIDATE_PATH)) return Promise.resolve(json({ valid: true }));
    if (url.includes(EVALUATE_PATH)) {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      evaluates.push({ headers, body });
      return Promise.resolve(json(route(body)));
    }
    // Approval polling is simulated by FakeAdapter, so this is unused here.
    return Promise.resolve(json({ action: "allow" }));
  }) as typeof fetch;

  const config = OpenBoxConfig.resolve({
    apiUrl: "https://core.test",
    apiKey: "obx_test_key",
    sdkEngine: SDK_ENGINE,
    sdkLanguage: SDK_LANGUAGE,
    sdkVersion: SDK_PACKAGE_VERSION
  });
  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    fetchImpl,
    timeoutSeconds: config.timeoutSeconds,
    onApiError: config.onApiError,
    sdkEngine: SDK_ENGINE,
    sdkLanguage: SDK_LANGUAGE,
    sdkVersion: SDK_PACKAGE_VERSION
  });
  const adapter = new FakeAdapter(adapterOptions);
  const runtime = new OpenBoxRuntime(config, { client, adapter });
  return { runtime, adapter, evaluates };
}

// ── Governed-agent harness (routing Core + middleware + createAgent) ─────────

type CreateAgentParams = Parameters<typeof createAgent>[0];

export interface GovernedAgentHarness {
  agent: ReturnType<typeof createAgent>;
  evaluates: CapturedEvaluate[];
  adapter: FakeAdapter;
  runtime: OpenBoxRuntime;
  openbox: OpenBoxLangChainMiddlewareBundle;
}

/** Wire a routing Core runtime through the enforcing middleware into a real agent. */
export async function buildGovernedAgent(config: {
  model: FakeChatModel;
  tools?: CreateAgentParams["tools"];
  route?: (body: Record<string, unknown>) => Record<string, unknown>;
  adapterOptions?: ConstructorParameters<typeof FakeAdapter>[0];
  mwOptions?: Partial<OpenBoxLangChainMiddlewareOptions>;
}): Promise<GovernedAgentHarness> {
  const { runtime, adapter, evaluates } = makeRoutingCoreRuntime(
    config.route ?? (() => ({ verdict: "allow" })),
    config.adapterOptions
  );
  const openbox = await createOpenBoxLangChainMiddleware({
    runtime,
    validate: false,
    installInstrumentation: false,
    agentName: "test-agent",
    ...config.mwOptions
  });
  const agent = createAgent({
    model: config.model,
    tools: config.tools ?? [],
    middleware: [openbox.middleware]
  });
  return { agent, evaluates, adapter, runtime, openbox };
}

/** A single-human-turn agent input. */
export function humanTurn(text: string): { messages: HumanMessage[] } {
  return { messages: [new HumanMessage(text)] };
}
