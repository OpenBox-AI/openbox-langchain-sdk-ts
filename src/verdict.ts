/**
 * Verdict enforcement — port of openbox_langgraph/verdict_handler.py.
 */

import { GovernanceVerdictResponse, VerdictArm } from './types';

export class GovernanceHaltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceHaltError';
  }
}

export class GovernanceBlockedError extends Error {
  verdict: VerdictArm;
  constructor(verdict: VerdictArm, message: string) {
    super(message);
    this.name = 'GovernanceBlockedError';
    this.verdict = verdict;
  }
}

export class GuardrailsValidationError extends Error {
  reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.length > 0 ? reasons.join('; ') : 'Guardrails validation failed');
    this.name = 'GuardrailsValidationError';
    this.reasons = reasons;
  }
}

export interface VerdictResult {
  requiresHitl: boolean;
  approvalId?: string;
}

export function enforceVerdict(
  response: GovernanceVerdictResponse,
  phase: string,
): VerdictResult {
  const arm = verdictFromString(response.arm ?? response.verdict);

  if (arm === 'halt') {
    throw new GovernanceHaltError(
      `OpenBox governance halt at ${phase}: ${response.reason ?? 'halted by policy'}`,
    );
  }
  if (arm === 'block') {
    throw new GovernanceBlockedError(
      'block',
      `OpenBox governance block at ${phase}: ${response.reason ?? 'blocked by policy'}`,
    );
  }

  const guardrails = response.guardrails_result ?? response.guardrailsResult;
  if (guardrails && guardrails.validation_passed === false) {
    const reasons = Array.isArray(guardrails.reasons)
      ? guardrails.reasons
        .map((r) => r.reason)
        .filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [];
    throw new GuardrailsValidationError(reasons);
  }

  if (arm === 'require_approval') {
    const approvalId = response.approval_id ?? response.approvalId ?? response.id;
    return { requiresHitl: true, approvalId };
  }

  return { requiresHitl: false };
}

export function verdictFromString(value: unknown): VerdictArm {
  if (typeof value !== 'string') return 'allow';
  const normalized = value.toLowerCase().replace(/-/g, '_');
  if (normalized === 'continue') return 'allow';
  if (normalized === 'stop') return 'halt';
  if (normalized === 'request_approval') return 'require_approval';
  if (
    normalized === 'allow' ||
    normalized === 'monitor' ||
    normalized === 'constrain' ||
    normalized === 'block' ||
    normalized === 'halt' ||
    normalized === 'require_approval'
  ) {
    return normalized;
  }
  return 'allow';
}
