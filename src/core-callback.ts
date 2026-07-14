// OpenBoxLangChainCoreCallbackHandler — the OBSERVABILITY-ONLY governance
// surface. It extends `@langchain/core`'s BaseCallbackHandler, emits tool + LLM
// lifecycle telemetry with ownership dedup, and correlates spans. It NEVER
// blocks execution (constructed WITHOUT raiseError so a handler error can never
// break the host app) and is NOT a governance gate — enforcement lives in the
// create-agent middleware.
//
// Python collapses two handlers (sync + async) into one here: that split existed
// only because Python's sync callback manager swallows async raises, which is
// irrelevant to a handler that never raises to block.

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";

import {
  handleChatModelStartTelemetry,
  handleLlmCompletionTelemetry
} from "./core-callback-llm.js";
import { toErrorInfo } from "./error-info.js";
import type {
  CoreCallbackState,
  OpenBoxLangChainCoreCallbackOptions
} from "./core-callback-options.js";
import {
  handleToolCompletionTelemetry,
  handleToolStartTelemetry
} from "./core-callback-tool.js";

export class OpenBoxLangChainCoreCallbackHandler extends BaseCallbackHandler {
  override name = "OpenBoxLangChainCoreCallbackHandler";
  private readonly state: CoreCallbackState;

  constructor(options: OpenBoxLangChainCoreCallbackOptions) {
    // No raiseError: observability must never abort the host app.
    super({});
    const { runtime } = options;
    this.state = {
      runtime,
      bridge: options.bridge,
      workflowId: options.workflowId,
      runId: options.runId,
      workflowType: options.workflowType,
      taskQueue: options.taskQueue ?? null,
      sessionId: options.sessionId ?? null,
      agentName: options.agentName ?? null,
      sendToolStartEvent: options.sendToolStartEvent ?? true,
      sendToolEndEvent: options.sendToolEndEvent ?? true,
      sendLlmStartEvent: options.sendLlmStartEvent ?? true,
      sendLlmEndEvent: options.sendLlmEndEvent ?? true,
      toolTypeResolver: options.toolTypeResolver ?? null,
      recordLessOk: options.recordLessOk ?? true,
      logger: options.logger,
      preScreen:
        options.preScreenResponse != null && options.preScreenActivityId != null
          ? { response: options.preScreenResponse, activityId: options.preScreenActivityId }
          : null,
      registerTrace:
        options.registerTrace ??
        ((traceId, ctx) => {
          runtime.contextStore.registerTrace(traceId, ctx);
        }),
      unregisterTrace:
        options.unregisterTrace ??
        ((traceId) => {
          runtime.contextStore.unregisterTrace(traceId);
        }),
      traceHandles: new Map()
    };
  }

  override async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    toolCallId?: string
  ): Promise<void> {
    await handleToolStartTelemetry(this.state, tool, input, runId, metadata, toolCallId);
  }

  override async handleToolEnd(output: unknown, runId: string): Promise<void> {
    await handleToolCompletionTelemetry(this.state, runId, { result: output });
  }

  override async handleToolError(err: Error, runId: string): Promise<void> {
    await handleToolCompletionTelemetry(this.state, runId, { error: toErrorInfo(err) });
  }

  override async handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string
  ): Promise<void> {
    await handleChatModelStartTelemetry(this.state, llm, messages, runId);
  }

  override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    await handleLlmCompletionTelemetry(this.state, runId, { response: output });
  }

  override async handleLLMError(err: Error, runId: string): Promise<void> {
    await handleLlmCompletionTelemetry(this.state, runId, { error: toErrorInfo(err) });
  }
}
