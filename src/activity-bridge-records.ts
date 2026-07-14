// Record types for `ActivityBridge`, split out to keep the bridge module small.
// Internal bookkeeping; `ActivityRecord` + `EventType` are re-exported from the
// package root for the callback surface and any future embedding layer.

import type { EvaluationResult } from "@openbox-ai/openbox-sdk-ts";

/**
 * Per-event-type sent-flag keys. Ownership is keyed on these, NEVER on record
 * existence — a record may be prepared by an embedding seam without the
 * callback ever sending, and that path must report "not owned".
 */
export type EventType = "tool_start" | "tool_complete" | "llm_start" | "llm_complete";

/** All event types, in a stable order (used to initialize the sent-flag map). */
export const EVENT_TYPES: readonly EventType[] = [
  "tool_start",
  "tool_complete",
  "llm_start",
  "llm_complete"
];

/** Optional tool metadata captured at prepare time (not on the activity context). */
export interface ToolRecordMetadata {
  toolName?: string | null;
  toolType?: string | null;
  toolCallId?: string | null;
  langgraphNode?: string | null;
  langgraphStep?: number | null;
}

/** Bridge-side bookkeeping for one activity (a tool call or an LLM call). */
export interface ActivityRecord {
  readonly activityId: string;
  /** The ownership pivot: has each event type been SENT for this activity? */
  readonly sentFlags: Record<EventType, boolean>;
  /** Start verdict, stashed so a cross-dispatched sibling enforces from one gate call. */
  startResult: EvaluationResult | null;
  /**
   * Completion verdict. Completion sends are telemetry-only (never enforced
   * inline), so this is the sole channel by which an embedding layer learns a
   * completion verdict.
   */
  completionResult: EvaluationResult | null;
  toolName: string | null;
  toolType: string | null;
  toolCallId: string | null;
  langgraphNode: string | null;
  langgraphStep: number | null;
  /** Set by an embedding layer when it force-aborts an in-flight activity. */
  abortMarked: boolean;
}

/** Per-workflow storage: activity records plus the LLM run-id alias index. */
export interface WorkflowRecords {
  readonly byActivityId: Map<string, ActivityRecord>;
  /**
   * Maps a callback's own run id to the activity id actually used, for when the
   * first LLM call's id diverges from the run id (e.g. a `"{runId}-pre"`
   * pre-screen row). Lets completion resolve without emitting an orphan id.
   */
  readonly eventRunIdAlias: Map<string, string>;
}

/** Build a fresh activity record with all sent-flags false and no stashed verdicts. */
export function createActivityRecord(
  activityId: string,
  metadata: ToolRecordMetadata = {}
): ActivityRecord {
  return {
    activityId,
    sentFlags: {
      tool_start: false,
      tool_complete: false,
      llm_start: false,
      llm_complete: false
    },
    startResult: null,
    completionResult: null,
    toolName: metadata.toolName ?? null,
    toolType: metadata.toolType ?? null,
    toolCallId: metadata.toolCallId ?? null,
    langgraphNode: metadata.langgraphNode ?? null,
    langgraphStep: metadata.langgraphStep ?? null,
    abortMarked: false
  };
}

/** Build empty per-workflow storage. */
export function createWorkflowRecords(): WorkflowRecords {
  return { byActivityId: new Map(), eventRunIdAlias: new Map() };
}
