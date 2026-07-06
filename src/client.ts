/**
 * GovernanceClient — standalone version.
 *
 * Replaces n8n's IExecuteFunctions transport with plain axios.
 * Mirrors openbox_langgraph/client.py.
 */

import axios from 'axios';
import { GovernanceConfig } from './config';
import { GovernanceVerdictResponse, LangChainGovernanceEvent } from './types';
import { buildSignedHeaders, serializeBody } from './signing';

export class SoftGovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoftGovernanceError';
  }
}

export interface ApprovalPollResponse {
  id?: string;
  arm?: string;
  verdict?: string;
  action?: string;
  reason?: string;
  approval_expiration_time?: string;
  approvalExpirationTime?: string;
  expired?: boolean;
  [key: string]: unknown;
}

/**
 * Mirrors openbox_langgraph.types.to_server_event_type().
 *
 * The OpenBox Core API only accepts Temporal SDK canonical event types
 * (ActivityStarted, ActivityCompleted, WorkflowStarted…).
 * LangChain-specific names are SDK-internal and must be translated before
 * the request hits the wire. The original name is preserved in metadata.sdk_event_type.
 */
function toServerEventType(event: LangChainGovernanceEvent): LangChainGovernanceEvent {
  const SDK_TO_SERVER: Record<string, string> = {
    LLMStarted: 'ActivityStarted',
    LLMCompleted: 'ActivityCompleted',
    ToolStarted: 'ActivityStarted',
    ToolCompleted: 'ActivityCompleted',
  };

  const serverType = SDK_TO_SERVER[event.event_type];
  if (!serverType) return event;

  return {
    ...event,
    event_type: serverType,
    metadata: {
      ...(event.metadata as Record<string, unknown> | undefined ?? {}),
      sdk_event_type: event.event_type,
    },
  };
}

export class GovernanceClient {
  private traceId: string;
  private config: GovernanceConfig;

  constructor(config: GovernanceConfig, traceId: string = '') {
    this.config = config;
    this.traceId = traceId;
  }

  updateTraceId(traceId: string): void {
    this.traceId = traceId;
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const bodyBytes = serializeBody(payload);
    const headers = buildSignedHeaders(
      'POST',
      path,
      bodyBytes,
      this.config.apiKey,
      this.config.agentDid,
      this.config.agentPrivateKey,
    );
    if (this.traceId) {
      headers['X-OpenBox-Trace-Id'] = this.traceId;
    }
    const res = await axios.post<T>(
      `${this.config.openboxUrl}${path}`,
      bodyBytes,
      { headers, timeout: this.config.governanceTimeout },
    );
    return res.data;
  }

  /**
   * evaluate_event() — POST a governance event and return the verdict.
   * Returns null on soft failures (fail_open policy).
   */
  async evaluateEvent(
    event: LangChainGovernanceEvent,
  ): Promise<GovernanceVerdictResponse | null> {
    try {
      const payload = toServerEventType(event) as Record<string, unknown>;
      if (this.traceId) {
        payload['x_trace_id'] = this.traceId;
      }
      return await this.post<GovernanceVerdictResponse>('/api/v1/governance/evaluate', payload);
    } catch (err) {
      if (this.config.onApiError === 'fail_open') {
        console.warn('[OpenBox] governance evaluate failed (fail_open):', err);
        return null;
      }
      throw new SoftGovernanceError(`Governance API error: ${String(err)}`);
    }
  }

  /**
   * poll_approval() — POST HITL poll payload to Core.
   * Mirrors openbox_langgraph.client.GovernanceClient.poll_approval().
   */
  async pollApproval(
    workflowId: string,
    runId: string,
    activityId: string,
    approvalId?: string,
  ): Promise<ApprovalPollResponse | null> {
    const pollKey = approvalId ?? activityId;
    const reqBody = approvalId
      ? { workflow_id: pollKey, run_id: pollKey, activity_id: pollKey }
      : { workflow_id: workflowId, run_id: runId, activity_id: activityId };

    console.log('[OpenBox HITL] polling approval:', JSON.stringify(reqBody));
    try {
      const data = await this.post<ApprovalPollResponse>('/api/v1/governance/approval', reqBody);
      console.log('[OpenBox HITL] raw poll response:', JSON.stringify(data));

      const expiration = data.approval_expiration_time ?? data.approvalExpirationTime;
      if (typeof expiration === 'string' && expiration.trim()) {
        const expiresAt = Date.parse(expiration);
        if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
          console.log('[OpenBox HITL] approval expired at', expiration);
          return { ...data, expired: true };
        }
      }
      return data;
    } catch (err) {
      if (this.config.onApiError === 'fail_open') return null;
      throw new SoftGovernanceError(`Governance approval poll error: ${String(err)}`);
    }
  }
}
