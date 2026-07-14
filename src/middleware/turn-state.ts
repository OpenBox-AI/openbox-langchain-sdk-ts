// Per-invocation turn identity carried in LangGraph graph state.
//
// This is the isolation mechanism (proven safe under >=10 concurrent invokes):
// `beforeAgent` returns an `obTurn` update; the wrap hooks read
// `request.state.obTurn`. It holds ONLY serializable values — a verdict SUMMARY,
// never a live EvaluationResult — because LangGraph may serialize state channels
// for checkpointing. Turn identity is NEVER stored on the middleware instance.

import { z } from "zod";

/** Serializable summary of the before-agent pre-screen verdict, reused by the first model call. */
export const preScreenSchema = z.object({
  verdict: z.string(),
  activityId: z.string(),
  /** The coerced redacted-input string to splice into the first model request, or null. */
  redactedInput: z.string().nullable()
});

/** The `obTurn` graph-state channel. */
export const obTurnSchema = z.object({
  workflowId: z.string(),
  runId: z.string(),
  preScreen: preScreenSchema.nullable(),
  /** Set true by whichever enforcing gate closed the workflow, so afterAgent does not double-close. */
  workflowClosed: z.boolean()
});

/** State schema contributed by this middleware (one `obTurn` channel). */
export const openBoxStateSchema = z.object({
  obTurn: obTurnSchema.optional()
});

export type PreScreenSummary = z.infer<typeof preScreenSchema>;
export type ObTurn = z.infer<typeof obTurnSchema>;

/**
 * Mint a fresh workflow/run identity for one invocation. The random suffix
 * guarantees uniqueness; the prefix is readability-only.
 */
export function mintTurnIdentity(prefix: string): { workflowId: string; runId: string } {
  const turn = globalThis.crypto.randomUUID().replaceAll("-", "");
  return {
    workflowId: `${prefix}-${turn.slice(0, 16)}`,
    runId: `${prefix}-run-${turn.slice(16, 32)}`
  };
}
