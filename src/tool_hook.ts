/**
 * Tool governance hook — TypeScript port of middleware_tool_hook.py.
 *
 * handle_wrap_tool_call: ToolStarted → execute tool → ToolCompleted.
 *
 * STANDALONE CHANGE (vs n8n version):
 *   - registerActivity takes GovernanceConfig instead of IExecuteFunctions.
 */

import { baseEventFields, evaluate, extractGovernanceBlocked } from './hooks';
import {
  clearActivityAbort,
  hasActivityAbort,
  isActivityApproved,
  markActivityApproved,
  registerActivity,
  runWithActivity,
  unregisterActivity,
} from './span_processor';
import { pollApprovalOrHalt } from './hitl';
import type { OpenBoxLangChainMiddleware } from './middleware';
import { LangChainGovernanceEvent, hexId, safeSerialize } from './types';
import { GovernanceBlockedError, enforceVerdict } from './verdict';

export async function handleWrapToolCall(
  mw: OpenBoxLangChainMiddleware,
  toolName: string,
  toolArgs: unknown,
  handler: () => Promise<unknown>,
): Promise<unknown> {
  if (mw._config.skipToolTypes.has(toolName)) {
    return handler();
  }

  const activityId = hexId(32);
  const toolType = mw._config.toolTypeMap[toolName];
  const startMs = Date.now();
  const b = baseEventFields(mw);

  // ── ToolStarted ──────────────────────────────────────────────────────────────
  // registerActivity is called AFTER this evaluate (mirrors handleWrapModelCall).
  if (mw._config.sendToolStartEvent) {
    const response = await evaluate(mw, {
      ...b,
      event_type: 'ToolStarted',
      activity_id: activityId,
      activity_type: toolName,
      activity_input: [safeSerialize(toolArgs)],
      tool_name: toolName,
      tool_type: toolType,
    } as LangChainGovernanceEvent);

    if (response != null) {
      const result = enforceVerdict(response, 'tool_start');
      if (result.requiresHitl) {
        await pollApprovalOrHalt(mw, activityId, toolName, result.approvalId);
        markActivityApproved(activityId);
        clearActivityAbort(activityId);
      }
    }
  }

  registerActivity(
    activityId,
    {
      ...b,
      event_type: 'ActivityStarted',
      activity_id: activityId,
      activity_type: toolName,
    },
    mw._config,
    mw._workflowId,
  );

  // ── Execute tool ─────────────────────────────────────────────────────────────
  let toolResult: unknown;
  let wasApproved = false;
  try {
    while (true) {
      try {
        toolResult = await runWithActivity(activityId, handler);
        // Some LangChain tools (e.g. Wikipedia) catch HTTP errors internally and
        // return them as strings rather than throwing. The hook still set the abort
        // flag before throwing — check it here so approval is triggered even when
        // the GovernanceBlockedError never propagated to this catch block.
        if (hasActivityAbort(activityId)) {
          await pollApprovalOrHalt(mw, activityId, toolName);
          markActivityApproved(activityId);
          clearActivityAbort(activityId);
          continue;
        }
        break;
      } catch (err) {
        const hookErr =
          err instanceof GovernanceBlockedError ? err : extractGovernanceBlocked(err);
        if (hookErr?.verdict === 'require_approval') {
          await pollApprovalOrHalt(mw, activityId, toolName);
          markActivityApproved(activityId);
          clearActivityAbort(activityId);
          continue;
        }

        const failEndMs = Date.now();
        if (mw._config.sendToolEndEvent && !isActivityApproved(activityId)) {
          await evaluate(mw, {
            ...baseEventFields(mw),
            event_type: 'ToolCompleted',
            activity_id: `${activityId}-c`,
            activity_type: toolName,
            activity_output: safeSerialize({ error: String(err) }),
            tool_name: toolName,
            tool_type: toolType,
            status: 'failed',
            duration_ms: failEndMs - startMs,
            error: String(err),
          } as LangChainGovernanceEvent);
        }
        throw err;
      }
    }
    // Capture BEFORE finally runs — unregisterActivity clears _approvedActivities.
    wasApproved = isActivityApproved(activityId);
  } finally {
    unregisterActivity(activityId);
  }

  const duration_ms = Date.now() - startMs;

  // ── ToolCompleted ─────────────────────────────────────────────────────────────
  if (mw._config.sendToolEndEvent) {
    const serializedOutput =
      typeof toolResult === 'string'
        ? safeSerialize({ result: toolResult })
        : safeSerialize(toolResult);

    if (!wasApproved) {
      const resp = await evaluate(mw, {
        ...baseEventFields(mw),
        event_type: 'ToolCompleted',
        activity_id: `${activityId}-c`,
        activity_type: toolName,
        activity_output: serializedOutput,
        tool_name: toolName,
        tool_type: toolType,
        status: 'completed',
        duration_ms,
      } as LangChainGovernanceEvent);

      if (resp != null) {
        const result = enforceVerdict(resp, 'tool_end');
        if (result.requiresHitl) {
          await pollApprovalOrHalt(mw, `${activityId}-c`, toolName, result.approvalId);
        }
      }
    }
  }

  return toolResult;
}
