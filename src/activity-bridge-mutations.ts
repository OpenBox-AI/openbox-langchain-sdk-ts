// Pure record-level mutations for `ActivityBridge`, split out to keep the bridge
// module small. These operate on a single `ActivityRecord` and never touch the
// workflow map — the bridge class owns lookup and calls these.

import type { ActivityRecord, EventType } from "./activity-bridge-records.js";
import type { EvaluationResult } from "@openbox-ai/openbox-sdk-ts";

/**
 * Flip one sent-flag. Callers mark the flag IMMEDIATELY after the envelope is
 * sent and BEFORE any enforcement raise — a blocked start still counts as
 * "started sent", so the orphan-close guard and dedup both work on the block
 * path.
 */
export function markRecordSent(record: ActivityRecord, eventType: EventType): void {
  record.sentFlags[eventType] = true;
}

/** Stash the start verdict (enables evaluate-once / enforce-from-stash). */
export function stashRecordStartResult(
  record: ActivityRecord,
  result: EvaluationResult
): void {
  record.startResult = result;
}

/** Stash the completion verdict for an embedding layer to read. */
export function stashRecordCompletionResult(
  record: ActivityRecord,
  result: EvaluationResult
): void {
  record.completionResult = result;
}

/** True iff this record has SENT the given event type (record may be undefined). */
export function recordOwns(
  record: ActivityRecord | undefined,
  eventType: EventType
): boolean {
  return record?.sentFlags[eventType] ?? false;
}
