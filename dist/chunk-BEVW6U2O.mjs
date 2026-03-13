import {
  parseApprovalResponse,
  parseGovernanceResponse,
  toServerEventType
} from "./chunk-2LY2CEP6.mjs";
import {
  OpenBoxNetworkError
} from "./chunk-AF6ADJEG.mjs";

// src/client.ts
var GovernanceClient = class {
  constructor(config) {
    this.apiUrl = config.apiUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 3e4;
    this.onApiError = config.onApiError ?? "fail_open";
  }
  async validateApiKey() {
    const { OpenBoxAuthError } = await import("./errors-WWAXJZ2Y.mjs");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(`${this.apiUrl}/api/v1/auth/validate`, {
        method: "GET",
        headers: this._headers(),
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) {
        throw new OpenBoxAuthError(
          "Invalid API key. Check your API key at dashboard.openbox.ai"
        );
      }
      if (!response.ok) {
        throw new OpenBoxNetworkError(
          `Cannot reach OpenBox Core at ${this.apiUrl}: HTTP ${response.status}`
        );
      }
    } catch (err) {
      if (err instanceof OpenBoxNetworkError || err.name === "OpenBoxAuthError") {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new OpenBoxNetworkError(
        `Cannot reach OpenBox Core at ${this.apiUrl}: ${message}`
      );
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * Send a governance event to OpenBox Core.
   * Returns null on network failure if fail_open.
   * Throws OpenBoxNetworkError on network failure if fail_closed.
   */
  async evaluateEvent(event) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const serverPayload = {
        ...event,
        event_type: toServerEventType(event.event_type),
        task_queue: event.task_queue ?? "langchain",
        source: "workflow-telemetry"
      };
      if (process.env["OPENBOX_DEBUG"] === "1") {
        console.log("[OpenBox Debug] governance request:", JSON.stringify(serverPayload, null, 2));
      }
      const response = await fetch(
        `${this.apiUrl}/api/v1/governance/evaluate`,
        {
          method: "POST",
          headers: this._headers(),
          body: JSON.stringify(serverPayload),
          signal: controller.signal
        }
      );
      if (!response.ok) {
        const msg = `HTTP ${response.status}`;
        if (this.onApiError === "fail_closed") {
          throw new OpenBoxNetworkError(
            `Governance API error: ${msg}`
          );
        }
        return null;
      }
      const data = await response.json();
      if (process.env["OPENBOX_DEBUG"] === "1") {
        console.log("[OpenBox Debug] governance response:", JSON.stringify(data, null, 2));
      }
      return parseGovernanceResponse(data);
    } catch (err) {
      if (err instanceof OpenBoxNetworkError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (this.onApiError === "fail_closed") {
        throw new OpenBoxNetworkError(
          `Governance API unreachable: ${message}`
        );
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * Poll for HITL approval status.
   * Returns null on network failure (caller handles retry logic).
   */
  async pollApproval(params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(
        `${this.apiUrl}/api/v1/governance/approval`,
        {
          method: "POST",
          headers: this._headers(),
          body: JSON.stringify({
            workflow_id: params.workflowId,
            run_id: params.runId,
            activity_id: params.activityId
          }),
          signal: controller.signal
        }
      );
      if (!response.ok) {
        return null;
      }
      const data = await response.json();
      const parsed = parseApprovalResponse(data);
      if (parsed.approval_expiration_time && !parsed.expired) {
        const expiry = new Date(parsed.approval_expiration_time).getTime();
        if (expiry < Date.now()) {
          parsed.expired = true;
        }
      }
      return parsed;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * Send a pre-built payload to the governance evaluate endpoint.
   * Used by hook-level governance where the payload is already fully assembled
   * (no event_type translation needed — caller sets event_type directly).
   *
   * Returns the raw parsed JSON response, or null on failure (fail_open).
   * Throws OpenBoxNetworkError on failure if fail_closed.
   */
  async evaluateRaw(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(
        `${this.apiUrl}/api/v1/governance/evaluate`,
        {
          method: "POST",
          headers: this._headers(),
          body: JSON.stringify(payload),
          signal: controller.signal
        }
      );
      if (!response.ok) {
        if (this.onApiError === "fail_closed") {
          throw new OpenBoxNetworkError(`Governance API error: HTTP ${response.status}`);
        }
        return null;
      }
      return await response.json();
    } catch (err) {
      if (err instanceof OpenBoxNetworkError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (this.onApiError === "fail_closed") {
        throw new OpenBoxNetworkError(`Governance API unreachable: ${message}`);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * Build a fail-closed HALT response for when the API is unreachable and
   * onApiError = "fail_closed".
   */
  static haltResponse(reason) {
    return {
      verdict: "halt" /* HALT */,
      reason
    };
  }
  _headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "OpenBox-LangChain-SDK/0.1.0"
    };
  }
};

export {
  GovernanceClient
};
