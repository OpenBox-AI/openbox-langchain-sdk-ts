/**
 * OpenBox LangChain SDK — RunBufferManager
 *
 * Tracks per-run state across the LangChain callback lifecycle.
 * Maps child run_ids back to their root chain run_id (= workflow_id).
 */

import { Verdict } from "./types.js";

export type RunType = "chain" | "llm" | "tool" | "agent" | "retriever";

export interface RunBuffer {
  rootRunId: string;
  runId: string;
  parentRunId?: string;
  runType: RunType;
  name: string;
  startTime: number;
  endTime?: number;
  status?: "completed" | "failed";
  pendingApproval: boolean;
  verdict?: Verdict;
  verdictReason?: string;
  /** Attempt number — incremented each time the same runId is re-registered (retries) */
  attempt: number;
  /** Redacted input from guardrails — available via getRedactedInput() */
  redactedInput?: unknown;
  /** Redacted output from guardrails — available via getRedactedOutput() */
  redactedOutput?: unknown;
  metadata?: Record<string, unknown>;
  /** Set by hook governance when a per-request verdict blocks execution */
  aborted?: boolean;
  abortReason?: string;
  /** Set when hook verdict is HALT — triggers abortController.abort() in finally */
  haltRequested?: boolean;
  haltReason?: string;
}

export class RunBufferManager {
  /** run_id → RunBuffer */
  private readonly buffers = new Map<string, RunBuffer>();
  /** run_id → root run_id */
  private readonly runToRoot = new Map<string, string>();

  /**
   * Register a new run. Call on every handleChainStart / handleToolStart / handleLLMStart.
   * If parentRunId is undefined, this run IS the root.
   * If the runId is already registered (stale buffer from a previous session), it is reset.
   */
  registerRun(
    runId: string,
    runType: RunType,
    name: string,
    parentRunId?: string
  ): void {
    const rootRunId = parentRunId
      ? (this.runToRoot.get(parentRunId) ?? parentRunId)
      : runId;

    // Detect stale buffer: same runId registered again — increment attempt counter
    const existing = this.buffers.get(runId);
    const attempt = existing ? existing.attempt + 1 : 1;

    this.runToRoot.set(runId, rootRunId);

    this.buffers.set(runId, {
      rootRunId,
      runId,
      parentRunId,
      runType,
      name,
      startTime: Date.now(),
      pendingApproval: existing?.pendingApproval ?? false,
      verdict: existing?.verdict,
      verdictReason: existing?.verdictReason,
      attempt,
    });
  }

  /**
   * Get the root run_id for any run in the hierarchy.
   * Returns runId itself if not found (defensive).
   */
  getRootRunId(runId: string): string {
    return this.runToRoot.get(runId) ?? runId;
  }

  getBuffer(runId: string): RunBuffer | undefined {
    return this.buffers.get(runId);
  }

  markCompleted(runId: string): void {
    const buf = this.buffers.get(runId);
    if (buf) {
      buf.endTime = Date.now();
      buf.status = "completed";
    }
  }

  markFailed(runId: string): void {
    const buf = this.buffers.get(runId);
    if (buf) {
      buf.endTime = Date.now();
      buf.status = "failed";
    }
  }

  setVerdictForRun(runId: string, verdict: Verdict, reason?: string): void {
    const buf = this.buffers.get(runId);
    if (buf) {
      buf.verdict = verdict;
      buf.verdictReason = reason;
    }
  }

  setPendingApproval(runId: string, pending: boolean): void {
    const buf = this.buffers.get(runId);
    if (buf) {
      buf.pendingApproval = pending;
    }
  }

  isPendingApproval(runId: string): boolean {
    return this.buffers.get(runId)?.pendingApproval ?? false;
  }

  setAborted(runId: string, reason: string): void {
    const buf = this.buffers.get(runId);
    if (buf) {
      buf.aborted = true;
      buf.abortReason = reason;
    }
  }

  isAborted(runId: string): boolean {
    return this.buffers.get(runId)?.aborted ?? false;
  }

  getAbortReason(runId: string): string | undefined {
    return this.buffers.get(runId)?.abortReason;
  }

  setHaltRequested(runId: string, reason: string): void {
    const buf = this.buffers.get(runId);
    if (buf) {
      buf.haltRequested = true;
      buf.haltReason = reason;
      buf.aborted = true;
      buf.abortReason = reason;
    }
  }

  isHaltRequested(runId: string): boolean {
    return this.buffers.get(runId)?.haltRequested ?? false;
  }

  setRedactedInput(runId: string, value: unknown): void {
    const buf = this.buffers.get(runId);
    if (buf) buf.redactedInput = value;
  }

  getRedactedInput(runId: string): unknown {
    return this.buffers.get(runId)?.redactedInput;
  }

  setRedactedOutput(runId: string, value: unknown): void {
    const buf = this.buffers.get(runId);
    if (buf) buf.redactedOutput = value;
  }

  getRedactedOutput(runId: string): unknown {
    return this.buffers.get(runId)?.redactedOutput;
  }

  getAttempt(runId: string): number {
    return this.buffers.get(runId)?.attempt ?? 1;
  }

  /**
   * Remove all buffers associated with a root run (cleanup after chain ends).
   */
  cleanup(rootRunId: string): void {
    const toDelete: string[] = [];
    for (const [runId, rootId] of this.runToRoot.entries()) {
      if (rootId === rootRunId) {
        toDelete.push(runId);
      }
    }
    for (const runId of toDelete) {
      this.buffers.delete(runId);
      this.runToRoot.delete(runId);
    }
  }

  /** Total number of tracked runs (useful for debugging). */
  get size(): number {
    return this.buffers.size;
  }
}
