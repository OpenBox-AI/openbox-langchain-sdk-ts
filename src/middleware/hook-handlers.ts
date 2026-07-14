// beforeAgent / afterAgent hook implementations.
//
// beforeAgent emission order (load-bearing): WorkflowStarted (telemetry, creates
// the session) -> SignalReceived (ENFORCE) -> pre-screen ActivityStarted
// (ENFORCE). An empty or multimodal human turn is still governed (it is NOT
// silently skipped). afterAgent sends WorkflowCompleted only when no gate has
// already closed the workflow.

import {
  buildActivityStarted,
  buildSignalReceived,
  buildWorkflowCompleted,
  buildWorkflowStarted
} from "../lifecycle-events.js";
import { coerceRedactedText, extractHumanTurnPrompt } from "../lifecycle-events-redaction.js";
import { readProp } from "../property-access.js";
import { toJsonSafe } from "../serialization.js";
import {
  enforceGate,
  identityFor,
  sendTelemetry,
  type MiddlewareContext
} from "./context.js";
import { hasHumanTurn } from "./message-extraction.js";
import { mintTurnIdentity, type ObTurn } from "./turn-state.js";

function stateMessages(state: unknown): unknown {
  return readProp(state, "messages") ?? [];
}

function lastMessageContent(messages: unknown): unknown {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  return readProp(messages[messages.length - 1], "content") ?? null;
}

/** before_agent: WorkflowStarted -> SignalReceived (enforce) -> pre-screen (enforce). */
export async function handleBeforeAgent(
  ctx: MiddlewareContext,
  state: unknown
): Promise<{ obTurn: ObTurn }> {
  const messages = stateMessages(state);
  const { workflowId, runId } = mintTurnIdentity(ctx.options.taskQueue);
  const turn: ObTurn = { workflowId, runId, preScreen: null, workflowClosed: false };

  const promptText = extractHumanTurnPrompt(messages);
  const governTurn = hasHumanTurn(messages);

  if (ctx.options.sendChainStartEvent) {
    await sendTelemetry(ctx, buildWorkflowStarted({ ...identityFor(ctx, turn) }));
  }

  if (governTurn) {
    await enforceGate(
      ctx,
      turn,
      buildSignalReceived({
        ...identityFor(ctx, turn),
        signalName: "user_prompt",
        extra: { signal_args: [promptText] }
      })
    );
  }

  if (ctx.options.sendLlmStartEvent && governTurn) {
    const preScreenId = `${runId}-pre`;
    const result = await enforceGate(
      ctx,
      turn,
      buildActivityStarted({
        ...identityFor(ctx, turn),
        activityId: preScreenId,
        activityType: "llm_call",
        activityInput: [{ prompt: promptText }]
      })
    );
    // Store ONLY a serializable summary — not the live EvaluationResult.
    turn.preScreen = {
      verdict: result.verdict,
      activityId: preScreenId,
      redactedInput: coerceRedactedText(result.guardrails?.redactedInput)
    };
  }

  return { obTurn: turn };
}

/** after_agent: WorkflowCompleted (telemetry), skipped if a gate already closed the workflow. */
export async function handleAfterAgent(
  ctx: MiddlewareContext,
  state: unknown,
  turn: ObTurn | undefined
): Promise<void> {
  if (turn === undefined) return;
  if (turn.workflowClosed) return;
  if (!ctx.options.sendChainEndEvent) return;
  const lastContent = lastMessageContent(stateMessages(state));
  await sendTelemetry(
    ctx,
    buildWorkflowCompleted({
      ...identityFor(ctx, turn),
      extra: {
        status: "completed",
        workflow_output: toJsonSafe({ result: lastContent })
      }
    })
  );
}
