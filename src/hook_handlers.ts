/**
 * Hook handler functions — TypeScript port of middleware_hook_handlers.py.
 *
 * handle_before_agent / handle_after_agent / handle_wrap_model_call /
 * handle_wrap_memory_op.
 *
 * STANDALONE CHANGE (vs n8n version):
 *   - Removed getOpenBoxCredentials(mw._client.executeFunctions) call — the
 *     openboxUrl is already in mw._config, so addIgnoredPrefix is called
 *     directly from the middleware constructor with no n8n dependency.
 *   - registerActivity takes GovernanceConfig instead of IExecuteFunctions.
 */

import {
  applyPiiRedaction,
  baseEventFields,
  evaluate,
  extractGovernanceBlocked,
  extractLastUserMessage,
  extractPromptFromMessages,
  extractResponseMetadata,
} from './hooks';
import { pollApprovalOrHalt } from './hitl';
import {
  clearActivityAbort,
  isActivityApproved,
  markActivityApproved,
  registerActivity,
  runWithActivity,
  unregisterActivity,
  unregisterWorkflow,
} from './span_processor';
import type { OpenBoxLangChainMiddleware } from './middleware';
import {
  GovernanceVerdictResponse,
  LangChainGovernanceEvent,
  hexId,
  safeSerialize,
} from './types';
import { enforceVerdict } from './verdict';

export interface AgentState {
  messages: unknown[];
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════
// handle_before_agent → SignalReceived + WorkflowStarted + pre-screen
// ═══════════════════════════════════════════════════════════════════

export async function handleBeforeAgent(
  mw: OpenBoxLangChainMiddleware,
  state: AgentState,
  threadId: string = 'langchain',
): Promise<void> {
  const turn = hexId(32);
  mw._workflowId = `${threadId}-${turn.slice(0, 8)}`;
  mw._runId = `${threadId}-run-${turn.slice(8, 16)}`;
  mw._client.updateTraceId(mw._workflowId);

  const messages = state.messages ?? [];
  const userPrompt = extractLastUserMessage(messages);

  // SignalReceived — user prompt as trigger
  if (userPrompt) {
    await evaluate(mw, {
      ...baseEventFields(mw),
      event_type: 'SignalReceived',
      activity_id: `${mw._runId}-sig`,
      activity_type: 'user_prompt',
      signal_name: 'user_prompt',
      signal_args: [userPrompt],
    } as LangChainGovernanceEvent);
  }

  // WorkflowStarted
  if (mw._config.sendChainStartEvent) {
    await evaluate(mw, {
      ...baseEventFields(mw),
      event_type: 'WorkflowStarted',
      activity_id: `${mw._runId}-wf`,
      activity_type: mw._workflowType,
      activity_input: [safeSerialize(state)],
    } as LangChainGovernanceEvent);
  }
}

// ═══════════════════════════════════════════════════════════════════
// handle_after_agent → WorkflowCompleted
// ═══════════════════════════════════════════════════════════════════

export async function handleAfterAgent(
  mw: OpenBoxLangChainMiddleware,
  state: AgentState,
  failedWith?: Error,
): Promise<GovernanceVerdictResponse | null> {
  if (!mw._config.sendChainEndEvent) return null;

  const messages = state.messages ?? [];
  let lastContent: unknown = null;
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1] as Record<string, unknown>;
    lastContent = lastMsg?.content ?? null;
  }

  const verdict = await evaluate(mw, {
    ...baseEventFields(mw),
    event_type: 'WorkflowCompleted',
    activity_id: `${mw._runId}-wf`,
    activity_type: mw._workflowType,
    workflow_output: safeSerialize({ result: lastContent }),
    status: failedWith ? 'failed' : 'completed',
    ...(failedWith ? { error: failedWith.message } : {}),
  } as LangChainGovernanceEvent);

  unregisterWorkflow(mw._workflowId);
  return verdict;
}

// ═══════════════════════════════════════════════════════════════════
// handle_wrap_model_call → LLMStarted → PII redact → Model → LLMCompleted
// ═══════════════════════════════════════════════════════════════════

export async function handleWrapModelCall(
  mw: OpenBoxLangChainMiddleware,
  messages: unknown[],
  handler: () => Promise<unknown>,
): Promise<unknown> {
  const promptText = extractLastUserMessage(messages) ?? extractPromptFromMessages(messages);
  if (!promptText.trim()) return handler();

  const b = baseEventFields(mw);
  const activityId = hexId(32);
  let startResponse: GovernanceVerdictResponse | null;
  const startMs = Date.now();

  if (mw._config.sendLlmStartEvent) {
    startResponse = await evaluate(mw, {
      ...b,
      event_type: 'LLMStarted',
      activity_id: activityId,
      activity_type: 'llm_call',
      activity_input: [{ prompt: promptText }],
      prompt: promptText,
    } as LangChainGovernanceEvent);
  } else {
    startResponse = null;
  }

  // PII redaction — only apply when the returned text is ≤ the prompt we sent.
  const guardrails = startResponse?.guardrails_result ?? startResponse?.guardrailsResult;
  if (guardrails) {
    const gr = guardrails;
    if (gr.input_type === 'activity_input' && gr.redacted_input != null) {
      const ri = gr.redacted_input;
      const redactedStr: string | null =
        typeof ri === 'string' ? ri
        : Array.isArray(ri) && ri.length > 0
          ? (typeof ri[0] === 'string'
              ? ri[0]
              : (typeof ri[0] === 'object' && ri[0] !== null
                  ? ((ri[0] as Record<string, string>).prompt ?? null)
                  : null))
          : null;
      if (redactedStr == null || redactedStr.length <= promptText.length + 64) {
        applyPiiRedaction(messages, gr.redacted_input);
      }
    }
  }

  if (startResponse != null) {
    const result = enforceVerdict(startResponse, 'llm_start');
    if (result.requiresHitl) {
      await pollApprovalOrHalt(mw, activityId, 'llm_call', result.approvalId);
      markActivityApproved(activityId);
    }
  }

  const activityCtxBase = baseEventFields(mw);
  registerActivity(
    activityId,
    {
      ...activityCtxBase,
      event_type: 'ActivityStarted',
      activity_id: activityId,
      activity_type: 'llm_call',
    },
    mw._config,
    mw._workflowId,
  );

  let modelResponse: unknown;
  let llmWasApproved = false;
  try {
    while (true) {
      try {
        modelResponse = await runWithActivity(activityId, handler);
        break;
      } catch (err) {
        const hookErr = extractGovernanceBlocked(err);
        if (hookErr?.verdict === 'require_approval') {
          await pollApprovalOrHalt(mw, activityId, 'llm_call');
          markActivityApproved(activityId);
          clearActivityAbort(activityId);
          continue;
        }
        throw err;
      }
    }
    llmWasApproved = isActivityApproved(activityId);
  } finally {
    unregisterActivity(activityId);
  }
  const duration_ms = Date.now() - startMs;

  if (mw._config.sendLlmEndEvent && !llmWasApproved) {
    const meta = extractResponseMetadata(modelResponse);
    const resp = await evaluate(mw, {
      ...baseEventFields(mw),
      event_type: 'LLMCompleted',
      activity_id: `${activityId}-c`,
      activity_type: 'llm_call',
      status: 'completed',
      duration_ms,
      llm_model: meta.llm_model,
      input_tokens: meta.input_tokens,
      output_tokens: meta.output_tokens,
      total_tokens: meta.total_tokens,
      has_tool_calls: meta.has_tool_calls,
      completion: meta.completion,
    } as LangChainGovernanceEvent);

    if (resp != null) {
      const endResult = enforceVerdict(resp, 'llm_end');
      if (endResult.requiresHitl) {
        await pollApprovalOrHalt(mw, `${activityId}-c`, 'llm_call', endResult.approvalId);
      }
    }
  }

  return modelResponse;
}

// ═══════════════════════════════════════════════════════════════════
// handle_wrap_memory_op → scopes memory load/save so pg queries
// inside the memory node generate db_query spans on the dashboard.
// ═══════════════════════════════════════════════════════════════════

export async function handleWrapMemoryOp<T>(
  mw: OpenBoxLangChainMiddleware,
  opType: 'loadMemoryVariables' | 'saveContext',
  fn: () => Promise<T>,
): Promise<T> {
  const activityId = hexId(32);
  const startMs = Date.now();
  const b = baseEventFields(mw);

  try {
    await evaluate(mw, {
      ...b,
      event_type: 'ActivityStarted',
      activity_id: activityId,
      activity_type: opType,
    } as LangChainGovernanceEvent);
  } catch { /* non-fatal */ }

  registerActivity(
    activityId,
    {
      ...b,
      event_type: 'ActivityStarted',
      activity_id: activityId,
      activity_type: opType,
    },
    mw._config,
    mw._workflowId,
  );

  let status: 'completed' | 'failed' = 'completed';
  let errorMsg: string | undefined;
  try {
    return await runWithActivity(activityId, fn);
  } catch (err) {
    status = 'failed';
    errorMsg = String(err);
    throw err;
  } finally {
    unregisterActivity(activityId);
    const completedEvent: LangChainGovernanceEvent = {
      ...baseEventFields(mw),
      event_type: 'ActivityCompleted',
      activity_id: `${activityId}-c`,
      activity_type: opType,
      status,
      duration_ms: Date.now() - startMs,
    };
    if (errorMsg) completedEvent.error = errorMsg;
    try {
      await evaluate(mw, completedEvent);
    } catch { /* non-fatal */ }
  }
}
