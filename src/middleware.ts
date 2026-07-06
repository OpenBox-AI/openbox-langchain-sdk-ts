/**
 * OpenBoxLangChainMiddleware — standalone version.
 *
 * Mirrors the original n8n middleware.ts structure exactly:
 * thin shell that delegates to hook_handlers and tool_hook.
 *
 * STANDALONE CHANGE (vs n8n version):
 *   - Removed IExecuteFunctions — GovernanceClient uses axios + signing.ts.
 *   - Constructor takes OpenBoxLangChainMiddlewareOptions directly (no n8n credential lookup).
 */

import { GovernanceClient } from './client';
import { GovernanceConfig, OpenBoxLangChainMiddlewareOptions, mergeConfig } from './config';
import { AgentState, handleAfterAgent, handleBeforeAgent, handleWrapMemoryOp, handleWrapModelCall } from './hook_handlers';
import { addIgnoredPrefix, setupSpanProcessorInstrumentation } from './span_processor';
import { setupNodeHookInstrumentation } from './node_instrumentation';
import { handleWrapToolCall } from './tool_hook';
import { GovernanceVerdictResponse } from './types';

export { AgentState };

export class OpenBoxLangChainMiddleware {
  // Per-invocation state — reset by beforeAgent() on every call
  _workflowId: string = '';
  _runId: string = '';
  _workflowType: string;

  readonly _config: GovernanceConfig;
  readonly _client: GovernanceClient;

  constructor(options: OpenBoxLangChainMiddlewareOptions) {
    this._config = mergeConfig(options);
    this._workflowType = options.agentName ?? 'LangChainRun';
    this._client = new GovernanceClient(this._config, '');

    // Ensure fetch/http spans to the OpenBox API itself are never captured
    // to avoid infinite loops (mirrors `ignored_urls` in Python SDK setup).
    addIgnoredPrefix(this._config.openboxUrl);
    setupSpanProcessorInstrumentation({ http: this._config.instrumentHttp });
    setupNodeHookInstrumentation({
      fileIo: this._config.instrumentFileIo,
      databases: this._config.instrumentDatabases,
    });
  }

  // ── Lifecycle hooks ────────────────────────────────────────────────────────

  async beforeAgent(state: AgentState, threadId?: string): Promise<void> {
    return handleBeforeAgent(this, state, threadId);
  }

  async afterAgent(state: AgentState, failedWith?: Error): Promise<GovernanceVerdictResponse | null> {
    return handleAfterAgent(this, state, failedWith);
  }

  async wrapModelCall(
    messages: unknown[],
    handler: () => Promise<unknown>,
  ): Promise<unknown> {
    return handleWrapModelCall(this, messages, handler);
  }

  async wrapToolCall(
    toolName: string,
    toolArgs: unknown,
    handler: () => Promise<unknown>,
  ): Promise<unknown> {
    return handleWrapToolCall(this, toolName, toolArgs, handler);
  }

  async wrapMemoryOp<T>(opType: 'loadMemoryVariables' | 'saveContext', fn: () => Promise<T>): Promise<T> {
    return handleWrapMemoryOp(this, opType, fn);
  }
}
