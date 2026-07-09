// ActivityBridge — a minimal, framework-neutral ownership channel.
//
// NOT a context store (that is the base SDK's `ContextStore`) and NOT a source
// of truth for activity context. Its sole job is answering "has the callback
// already sent event X for this activity?" (ownership) and stashing the
// verdicts the callback evaluates, so a cross-dispatched sibling handler
// enforces from a single gate call instead of re-evaluating.
//
// Scope: this is a CALLBACK-SURFACE concept only. The enforcing middleware does
// NOT use the bridge — it carries turn identity in graph state and closes
// orphans with a linear try/finally. The bridge is kept framework-neutral so a
// future OpenBox LangGraph SDK can reuse it.
//
// Threading: the Python original locks because sync tool bodies run in executor
// threads; JS is single-threaded per tick, so no lock is needed. The
// get-or-create atomicity that matters is preserved by keeping every method
// synchronous (no `await` between a check and the corresponding insert).

import {
  markRecordSent,
  recordOwns,
  stashRecordCompletionResult,
  stashRecordStartResult
} from "./activity-bridge-mutations.js";
import {
  createActivityRecord,
  createWorkflowRecords,
  type ActivityRecord,
  type EventType,
  type ToolRecordMetadata,
  type WorkflowRecords
} from "./activity-bridge-records.js";
import type { EvaluationResult } from "@openbox-ai/openbox-sdk";

export type { ActivityRecord, EventType } from "./activity-bridge-records.js";

/**
 * Ownership channel for the observability callback surface. One instance per
 * handler installation — NEVER a module-level singleton, so concurrent agent
 * runs never share ownership state.
 */
export class ActivityBridge {
  private readonly workflows = new Map<string, WorkflowRecords>();

  // ── Record creation ──────────────────────────────────────────────────────

  /**
   * Get-or-create the record for a tool activity. Idempotent: a second call for
   * the same `(workflowId, activityId)` returns the SAME record and does not
   * reset sent-flags or stashed verdicts (required for evaluate-once).
   */
  prepareTool(
    workflowId: string,
    activityId: string,
    metadata: ToolRecordMetadata = {}
  ): ActivityRecord {
    const wf = this.workflowFor(workflowId);
    let record = wf.byActivityId.get(activityId);
    if (record === undefined) {
      record = createActivityRecord(activityId, metadata);
      wf.byActivityId.set(activityId, record);
    }
    return record;
  }

  /**
   * Get-or-create the record for an LLM activity. `eventRunId` registers the
   * alias from the callback's own run id to `activityId` — needed when the
   * first LLM call's id diverges from the run id (e.g. a pre-screen row).
   */
  prepareLlm(
    workflowId: string,
    activityId: string,
    options: { eventRunId?: string } = {}
  ): ActivityRecord {
    const wf = this.workflowFor(workflowId);
    let record = wf.byActivityId.get(activityId);
    if (record === undefined) {
      record = createActivityRecord(activityId);
      wf.byActivityId.set(activityId, record);
    }
    if (options.eventRunId !== undefined) {
      wf.eventRunIdAlias.set(options.eventRunId, activityId);
    }
    return record;
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────

  get(workflowId: string, activityId: string): ActivityRecord | undefined {
    return this.workflows.get(workflowId)?.byActivityId.get(activityId);
  }

  /**
   * Resolve a record via the run-id alias index, falling back to a direct
   * activity-id lookup so callers can pass either key uniformly.
   */
  getByEventRunId(workflowId: string, eventRunId: string): ActivityRecord | undefined {
    const wf = this.workflows.get(workflowId);
    if (wf === undefined) return undefined;
    return wf.byActivityId.get(this.resolveActivityId(workflowId, eventRunId));
  }

  /** Register a run-id → activity-id alias explicitly. */
  aliasRunId(workflowId: string, eventRunId: string, activityId: string): void {
    this.workflowFor(workflowId).eventRunIdAlias.set(eventRunId, activityId);
  }

  /** Resolve a run id to its aliased activity id, or the run id itself if unaliased. */
  resolveActivityId(workflowId: string, eventRunId: string): string {
    return this.workflows.get(workflowId)?.eventRunIdAlias.get(eventRunId) ?? eventRunId;
  }

  // ── Ownership query ──────────────────────────────────────────────────────

  /**
   * True iff the callback has SENT this specific event type. Record existence
   * is NEVER ownership — a prepared-but-unsent activity reports false so the
   * consumer does not skip an event nobody sent.
   */
  isCallbackOwned(workflowId: string, activityId: string, eventType: EventType): boolean {
    return recordOwns(this.get(workflowId, activityId), eventType);
  }

  // ── Mutations (lookup then delegate to pure record helpers) ────────────────

  /** Flip one sent-flag; no-op if the record does not exist. */
  markSent(workflowId: string, activityId: string, eventType: EventType): void {
    const record = this.get(workflowId, activityId);
    if (record !== undefined) markRecordSent(record, eventType);
  }

  /** Stash the start verdict; no-op if the record does not exist. */
  stashStartResult(workflowId: string, activityId: string, result: EvaluationResult): void {
    const record = this.get(workflowId, activityId);
    if (record !== undefined) stashRecordStartResult(record, result);
  }

  /** Stash the completion verdict; no-op if the record does not exist. */
  stashCompletionResult(
    workflowId: string,
    activityId: string,
    result: EvaluationResult
  ): void {
    const record = this.get(workflowId, activityId);
    if (record !== undefined) stashRecordCompletionResult(record, result);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  /**
   * Drop and return all records for a workflow (turn/run cleanup). An embedding
   * layer uses the returned records to sweep-close prepared-but-not-completed
   * activities.
   */
  sweepWorkflow(workflowId: string): ActivityRecord[] {
    const wf = this.workflows.get(workflowId);
    if (wf === undefined) return [];
    this.workflows.delete(workflowId);
    return [...wf.byActivityId.values()];
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private workflowFor(workflowId: string): WorkflowRecords {
    let wf = this.workflows.get(workflowId);
    if (wf === undefined) {
      wf = createWorkflowRecords();
      this.workflows.set(workflowId, wf);
    }
    return wf;
  }
}
