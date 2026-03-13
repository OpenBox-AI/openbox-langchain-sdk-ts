/**
 * OpenBox LangChain SDK — Governance HTTP Client
 */

import { OpenBoxNetworkError } from "./errors.js";
import {
  ApprovalResponse,
  GovernanceVerdictResponse,
  LangChainGovernanceEvent,
  parseApprovalResponse,
  parseGovernanceResponse,
  toServerEventType,
  Verdict,
} from "./types.js";

export interface GovernanceClientConfig {
  apiUrl: string;
  apiKey: string;
  timeout?: number;
  onApiError?: "fail_open" | "fail_closed";
}

export interface ApprovalPollParams {
  workflowId: string;
  runId: string;
  activityId: string;
}

export class GovernanceClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly onApiError: "fail_open" | "fail_closed";

  constructor(config: GovernanceClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 30_000;
    this.onApiError = config.onApiError ?? "fail_open";
  }

  async validateApiKey(): Promise<void> {
    const { OpenBoxAuthError } = await import("./errors.js");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.apiUrl}/api/v1/auth/validate`, {
        method: "GET",
        headers: this._headers(),
        signal: controller.signal,
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
      if (
        err instanceof OpenBoxNetworkError ||
        (err as Error).name === "OpenBoxAuthError"
      ) {
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
  async evaluateEvent(
    event: LangChainGovernanceEvent
  ): Promise<GovernanceVerdictResponse | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      // Translate SDK-internal event_type to the server-accepted Temporal equivalent
      const serverPayload = {
        ...event,
        event_type: toServerEventType(event.event_type),
        task_queue: event.task_queue ?? "langchain",
        source: "workflow-telemetry",
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
          signal: controller.signal,
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

      const data = (await response.json()) as Record<string, unknown>;
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
  async pollApproval(
    params: ApprovalPollParams
  ): Promise<ApprovalResponse | null> {
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
            activity_id: params.activityId,
          }),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as Record<string, unknown>;

      // SDK-side expiration check: if approval_expiration_time is in the past, mark expired
      const parsed = parseApprovalResponse(data);
      if (
        parsed.approval_expiration_time &&
        !parsed.expired
      ) {
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
  async evaluateRaw(
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(
        `${this.apiUrl}/api/v1/governance/evaluate`,
        {
          method: "POST",
          headers: this._headers(),
          body: JSON.stringify(payload),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        if (this.onApiError === "fail_closed") {
          throw new OpenBoxNetworkError(`Governance API error: HTTP ${response.status}`);
        }
        return null;
      }

      return (await response.json()) as Record<string, unknown>;
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
  static haltResponse(reason: string): GovernanceVerdictResponse {
    return {
      verdict: Verdict.HALT,
      reason,
    };
  }

  private _headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "OpenBox-LangChain-SDK/0.1.0",
    };
  }
}
