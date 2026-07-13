// createOpenBoxLangChainMiddleware — the SOLE enforcement surface entry point.
//
// Builds one runtime (client -> ApprovalPoller -> CoreAdapter -> OpenBoxRuntime),
// validates the API key, installs base instrumentation (default-ON, collision-
// safe), and assembles a create-agent middleware whose wrap hooks fail closed by
// throwing before the wrapped call. This is the only module that imports
// `langchain`.

import { createMiddleware, type AnyAgentMiddleware } from "langchain";
import {
  initOpenBoxInstrumentation,
  OpenBoxInstrumentationError,
  type InitOpenBoxInstrumentationOptions,
  type OpenBoxInstrumentationController
} from "@openbox-ai/openbox-sdk-ts/instrumentation";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

import { readProp } from "../property-access.js";
import type { MiddlewareContext } from "./context.js";
import { handleAfterAgent, handleBeforeAgent } from "./hook-handlers.js";
import { handleWrapModelCall } from "./model-call.js";
import {
  resolveMiddlewareOptions,
  type OpenBoxLangChainMiddlewareOptions
} from "./options.js";
import { buildMiddlewareRuntime } from "./runtime-builder.js";
import { handleWrapToolCall } from "./tool-call.js";
import { openBoxStateSchema, type ObTurn } from "./turn-state.js";

/** What the factory returns: the middleware plus its runtime and a cleanup handle. */
export interface OpenBoxLangChainMiddlewareBundle {
  middleware: AnyAgentMiddleware;
  runtime: OpenBoxRuntime;
  instrumentation: OpenBoxInstrumentationController | null;
  /**
   * Idempotent: drains in-flight sync-fs completed telemetry (`flush()`), then
   * shuts down instrumentation (if any), then closes the runtime. Awaiting this
   * makes the last synchronous `readFileSync`/`writeFileSync`/`mkdirSync` event
   * durable before teardown.
   */
  close(): Promise<void>;
}

function readTurn(state: unknown): ObTurn | undefined {
  return readProp(state, "obTurn") as ObTurn | undefined;
}

export async function createOpenBoxLangChainMiddleware(
  options: OpenBoxLangChainMiddlewareOptions
): Promise<OpenBoxLangChainMiddlewareBundle> {
  const runtime = options.runtime ?? buildMiddlewareRuntime(options);

  if (options.validate !== false) {
    // Fast-fail on a bad key/signing before building the middleware.
    await runtime.client.validateApiKey();
  }

  const instrumentation = installInstrumentation(runtime, options);

  const ctx: MiddlewareContext = {
    runtime,
    options: resolveMiddlewareOptions(options),
    workflowType: options.agentName ?? "LangChainRun"
  };

  const middleware = createMiddleware({
    name: "openbox-governance",
    stateSchema: openBoxStateSchema,
    beforeAgent: (state: unknown) => handleBeforeAgent(ctx, state),
    afterAgent: async (state: unknown) => {
      await handleAfterAgent(ctx, state, readTurn(state));
    },
    wrapModelCall: (request, handler) => {
      const turn = readTurn(request.state);
      return turn ? handleWrapModelCall(ctx, turn, request, handler) : handler(request);
    },
    wrapToolCall: (request, handler) => {
      const turn = readTurn(request.state);
      return turn ? handleWrapToolCall(ctx, turn, request, handler) : handler(request);
    }
  }) as AnyAgentMiddleware;

  return {
    middleware,
    runtime,
    instrumentation,
    async close(): Promise<void> {
      // Drain sync-fs completed telemetry BEFORE tearing down: the sync fs
      // wrapper returns before its `runtime.completed(...)` promise settles, so
      // flushing here keeps the last fs event durable. shutdown()/close() are
      // synchronous and idempotent; flush() resolves immediately when sync fs
      // (or all instrumentation) was never installed.
      await instrumentation?.flush();
      instrumentation?.shutdown();
      runtime.close();
    }
  };
}

/** Install base instrumentation, tolerating a second active runtime in the process. */
function installInstrumentation(
  runtime: OpenBoxRuntime,
  options: OpenBoxLangChainMiddlewareOptions
): OpenBoxInstrumentationController | null {
  if (options.installInstrumentation === false) return null;
  const strict = options.instrumentationStrict ?? false;
  const initOptions: InitOpenBoxInstrumentationOptions = options.databases
    ? { runtime, strict, databases: options.databases }
    : { runtime, strict };
  try {
    return initOpenBoxInstrumentation(initOptions);
  } catch (error) {
    if (error instanceof OpenBoxInstrumentationError) {
      options.logger?.warn(
        "another OpenBox runtime already instruments this process; continuing " +
          "WITHOUT instrumentation for this agent — governance is still enforced, " +
          "but HTTP/DB/file hook spans for this agent are not captured"
      );
      return null;
    }
    throw error;
  }
}
