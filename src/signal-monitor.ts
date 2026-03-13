/**
 * OpenBox LangChain SDK — Signal Monitor
 *
 * LangChain's equivalent of Temporal's SignalReceived event.
 *
 * In Temporal, a Signal is an external message sent to a running workflow
 * that can carry a HALT/BLOCK verdict mid-execution. LangChain has no native
 * signal concept, but we can replicate it using:
 *
 *   1. A background polling loop that checks OpenBox Core for a stop verdict
 *      on the current session (workflow_id = root chain run_id).
 *   2. An AbortController whose signal is passed to LangChain's RunnableConfig.
 *   3. When a HALT/BLOCK verdict arrives, we abort the controller — LangChain
 *      propagates an AbortError and stops the agent cleanly between steps.
 *
 * Usage:
 *   const monitor = new OpenBoxSignalMonitor(client, { pollIntervalMs: 3000 });
 *   const abortController = new AbortController();
 *
 *   monitor.start(workflowId, abortController);
 *
 *   await executor.invoke(input, {
 *     signal: abortController.signal,
 *     callbacks: [handler],
 *   });
 *
 *   monitor.stop();
 */

import { GovernanceClient } from "./client.js";
import { GovernanceHaltError, GovernanceBlockedError } from "./errors.js";
import { Verdict, verdictShouldStop } from "./types.js";

export interface SignalMonitorConfig {
  /** How often to poll OpenBox Core for a stop verdict (ms). Default: 3000 */
  pollIntervalMs?: number;
  /** Stop polling after this many ms regardless (safety ceiling). Default: 3_600_000 (1hr) */
  maxDurationMs?: number;
  /** If true, throw a GovernanceHaltError/GovernanceBlockedError after aborting. Default: true */
  throwOnAbort?: boolean;
}

export interface SignalMonitorStatus {
  running: boolean;
  workflowId: string | null;
  pollCount: number;
  aborted: boolean;
  abortReason?: string;
  abortVerdict?: Verdict;
}

/**
 * Background signal monitor — polls OpenBox Core for a stop verdict on the
 * current session and aborts the LangChain executor's AbortController on HALT/BLOCK.
 *
 * This mirrors Temporal's SignalReceived interceptor where a governance signal
 * stores a verdict that blocks the next activity.
 */
export class OpenBoxSignalMonitor {
  private readonly client: GovernanceClient;
  private readonly config: Required<SignalMonitorConfig>;

  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _running = false;
  private _workflowId: string | null = null;
  private _controller: AbortController | null = null;
  private _pollCount = 0;
  private _aborted = false;
  private _abortReason?: string;
  private _abortVerdict?: Verdict;
  private _startedAt = 0;

  constructor(client: GovernanceClient, config: SignalMonitorConfig = {}) {
    this.client = client;
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 3_000,
      maxDurationMs: config.maxDurationMs ?? 3_600_000,
      throwOnAbort: config.throwOnAbort ?? true,
    };
  }

  /**
   * Start background polling for the given workflow session.
   *
   * @param workflowId  Root chain run_id (= workflow_id sent to OpenBox)
   * @param controller  AbortController whose .signal is passed to the LangChain executor
   */
  start(workflowId: string, controller: AbortController): void {
    if (this._running) {
      this.stop();
    }

    this._workflowId = workflowId;
    this._controller = controller;
    this._running = true;
    this._aborted = false;
    this._pollCount = 0;
    this._startedAt = Date.now();

    this._scheduleNext();
  }

  /**
   * Stop the background poller. Safe to call multiple times.
   */
  stop(): void {
    this._running = false;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._workflowId = null;
    this._controller = null;
  }

  get status(): SignalMonitorStatus {
    return {
      running: this._running,
      workflowId: this._workflowId,
      pollCount: this._pollCount,
      aborted: this._aborted,
      abortReason: this._abortReason,
      abortVerdict: this._abortVerdict,
    };
  }

  private _scheduleNext(): void {
    if (!this._running) return;

    this._timer = setTimeout(() => {
      this._poll().catch(() => {
        // Polling errors are non-fatal — schedule next poll anyway
        if (this._running) this._scheduleNext();
      });
    }, this.config.pollIntervalMs);
  }

  private async _poll(): Promise<void> {
    if (!this._running || !this._workflowId || !this._controller) return;

    // Safety ceiling: stop if max duration exceeded
    if (Date.now() - this._startedAt > this.config.maxDurationMs) {
      this.stop();
      return;
    }

    this._pollCount++;

    // Send a SignalReceived event — the server evaluates current session policy
    // and returns a verdict. HALT/BLOCK means "stop this agent now".
    const signalEvent = {
      source: "workflow-telemetry" as const,
      event_type: "AgentAction" as const, // maps to ActivityStarted on server
      workflow_id: this._workflowId,
      run_id: this._workflowId,
      workflow_type: "SignalCheck",
      task_queue: "langchain",
      timestamp: new Date().toISOString(),
      activity_id: `signal-${this._pollCount}-${this._workflowId}`,
      activity_type: "SignalReceived",
      activity_input: [{ signal: "openbox-poll", poll_count: this._pollCount }],
    };

    const response = await this.client.evaluateEvent(signalEvent);
    if (!response) {
      // API unreachable — fail-open, keep polling
      if (this._running) this._scheduleNext();
      return;
    }

    const { verdict, reason } = response;

    if (verdictShouldStop(verdict)) {
      // Store for status reporting
      this._aborted = true;
      this._abortReason = reason ?? (verdict === Verdict.HALT
        ? "Agent halted by governance policy"
        : "Agent blocked by governance policy");
      this._abortVerdict = verdict;

      // Abort the LangChain executor — this propagates an AbortError between steps
      this._controller.abort(
        verdict === Verdict.HALT
          ? new GovernanceHaltError(this._abortReason)
          : new GovernanceBlockedError(this._abortReason)
      );

      this.stop();
      return;
    }

    // ALLOW / CONSTRAIN — schedule next poll
    if (this._running) this._scheduleNext();
  }
}
