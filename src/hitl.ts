/**
 * OpenBox LangChain SDK — Human-in-the-Loop (HITL) Approval Polling
 *
 * LangChain has no built-in retry mechanism (unlike Temporal).
 * When governance returns REQUIRE_APPROVAL, we block inside the async
 * callback handler by polling until a decision is made or timeout occurs.
 */

import {
  ApprovalExpiredError,
  ApprovalRejectedError,
  ApprovalTimeoutError,
  GovernanceBlockedError,
} from "./errors.js";
import { GovernanceClient } from "./client.js";
import { HITLConfig, Verdict, verdictShouldStop } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HITLPollParams {
  workflowId: string;   // root chain run_id
  runId: string;        // root chain run_id
  activityId: string;   // tool/LLM run_id
  activityType: string; // tool name or LLM type (for error messages)
}

/**
 * Block until governance approves, rejects, or times out.
 *
 * Resolves successfully when approval is granted (ALLOW verdict).
 * Throws on rejection, expiry, timeout, or HALT/BLOCK verdict.
 */
export async function pollUntilDecision(
  client: GovernanceClient,
  params: HITLPollParams,
  config: HITLConfig
): Promise<void> {
  const deadline = Date.now() + config.maxWaitMs;

  while (true) {
    // Check deadline before each poll
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ApprovalTimeoutError(config.maxWaitMs);
    }

    // Wait before polling (give humans time to review)
    await sleep(Math.min(config.pollIntervalMs, remaining));

    // Check deadline again after sleep
    if (Date.now() >= deadline) {
      throw new ApprovalTimeoutError(config.maxWaitMs);
    }

    const response = await client.pollApproval({
      workflowId: params.workflowId,
      runId: params.runId,
      activityId: params.activityId,
    });

    if (!response) {
      // API unreachable — keep polling (fail-open behaviour for HITL)
      continue;
    }

    // Expired
    if (response.expired) {
      throw new ApprovalExpiredError(
        `Approval expired for ${params.activityType} (activity_id=${params.activityId})`
      );
    }

    const { verdict, reason } = response;

    // Approved — proceed
    if (verdict === Verdict.ALLOW) {
      return;
    }

    // Rejected / halted
    if (verdictShouldStop(verdict)) {
      throw new ApprovalRejectedError(
        reason ?? `Approval rejected for ${params.activityType}`
      );
    }

    // BLOCK specifically
    if (verdict === Verdict.BLOCK) {
      throw new GovernanceBlockedError(
        reason ?? `Approval rejected for ${params.activityType}`
      );
    }

    // Still pending (REQUIRE_APPROVAL / CONSTRAIN) — keep polling
  }
}
