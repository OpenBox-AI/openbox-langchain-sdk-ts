import {
  verdictShouldStop
} from "./chunk-2LY2CEP6.mjs";
import {
  GovernanceBlockedError,
  GovernanceHaltError
} from "./chunk-AF6ADJEG.mjs";

// src/signal-monitor.ts
var OpenBoxSignalMonitor = class {
  constructor(client, config = {}) {
    this._timer = null;
    this._running = false;
    this._workflowId = null;
    this._controller = null;
    this._pollCount = 0;
    this._aborted = false;
    this._startedAt = 0;
    this.client = client;
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 3e3,
      maxDurationMs: config.maxDurationMs ?? 36e5,
      throwOnAbort: config.throwOnAbort ?? true
    };
  }
  /**
   * Start background polling for the given workflow session.
   *
   * @param workflowId  Root chain run_id (= workflow_id sent to OpenBox)
   * @param controller  AbortController whose .signal is passed to the LangChain executor
   */
  start(workflowId, controller) {
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
  stop() {
    this._running = false;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._workflowId = null;
    this._controller = null;
  }
  get status() {
    return {
      running: this._running,
      workflowId: this._workflowId,
      pollCount: this._pollCount,
      aborted: this._aborted,
      abortReason: this._abortReason,
      abortVerdict: this._abortVerdict
    };
  }
  _scheduleNext() {
    if (!this._running) return;
    this._timer = setTimeout(() => {
      this._poll().catch(() => {
        if (this._running) this._scheduleNext();
      });
    }, this.config.pollIntervalMs);
  }
  async _poll() {
    if (!this._running || !this._workflowId || !this._controller) return;
    if (Date.now() - this._startedAt > this.config.maxDurationMs) {
      this.stop();
      return;
    }
    this._pollCount++;
    const signalEvent = {
      source: "workflow-telemetry",
      event_type: "AgentAction",
      // maps to ActivityStarted on server
      workflow_id: this._workflowId,
      run_id: this._workflowId,
      workflow_type: "SignalCheck",
      task_queue: "langchain",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      activity_id: `signal-${this._pollCount}-${this._workflowId}`,
      activity_type: "SignalReceived",
      activity_input: [{ signal: "openbox-poll", poll_count: this._pollCount }]
    };
    const response = await this.client.evaluateEvent(signalEvent);
    if (!response) {
      if (this._running) this._scheduleNext();
      return;
    }
    const { verdict, reason } = response;
    if (verdictShouldStop(verdict)) {
      this._aborted = true;
      this._abortReason = reason ?? (verdict === "halt" /* HALT */ ? "Agent halted by governance policy" : "Agent blocked by governance policy");
      this._abortVerdict = verdict;
      this._controller.abort(
        verdict === "halt" /* HALT */ ? new GovernanceHaltError(this._abortReason) : new GovernanceBlockedError(this._abortReason)
      );
      this.stop();
      return;
    }
    if (this._running) this._scheduleNext();
  }
};

export {
  OpenBoxSignalMonitor
};
