import { describe, expect, it } from 'vitest';
import {
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
  enforceVerdict,
  verdictFromString,
} from '../src/verdict';

describe('verdictFromString', () => {
  it('maps legacy v1.0 strings to their current arms', () => {
    expect(verdictFromString('continue')).toBe('allow');
    expect(verdictFromString('stop')).toBe('halt');
    expect(verdictFromString('request_approval')).toBe('require_approval');
  });

  it('normalizes case and hyphens', () => {
    expect(verdictFromString('ALLOW')).toBe('allow');
    expect(verdictFromString('require-approval')).toBe('require_approval');
  });

  it('passes through known arms unchanged', () => {
    for (const arm of ['allow', 'monitor', 'constrain', 'block', 'halt', 'require_approval']) {
      expect(verdictFromString(arm)).toBe(arm);
    }
  });

  it('defaults unknown or non-string values to allow', () => {
    expect(verdictFromString('something_else')).toBe('allow');
    expect(verdictFromString(undefined)).toBe('allow');
    expect(verdictFromString(42)).toBe('allow');
  });
});

describe('enforceVerdict', () => {
  it('throws GovernanceHaltError on halt', () => {
    expect(() => enforceVerdict({ arm: 'halt', reason: 'policy' }, 'llm_start')).toThrow(
      GovernanceHaltError,
    );
  });

  it('throws GovernanceBlockedError on block', () => {
    try {
      enforceVerdict({ arm: 'block', reason: 'policy' }, 'tool_start');
      expect.unreachable('enforceVerdict should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GovernanceBlockedError);
      expect((err as GovernanceBlockedError).verdict).toBe('block');
    }
  });

  it('falls back to the verdict field when arm is absent', () => {
    expect(() => enforceVerdict({ verdict: 'stop' }, 'llm_end')).toThrow(GovernanceHaltError);
  });

  it('throws GuardrailsValidationError when guardrails fail, even on an allow verdict', () => {
    try {
      enforceVerdict(
        {
          arm: 'allow',
          guardrails_result: {
            validation_passed: false,
            reasons: [{ type: 'pii', reason: 'Contains PII' }],
          },
        },
        'llm_start',
      );
      expect.unreachable('enforceVerdict should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GuardrailsValidationError);
      expect((err as GuardrailsValidationError).reasons).toEqual(['Contains PII']);
    }
  });

  it('returns requiresHitl with the approval id on require_approval', () => {
    const result = enforceVerdict({ arm: 'require_approval', approval_id: 'appr-1' }, 'tool_end');
    expect(result).toEqual({ requiresHitl: true, approvalId: 'appr-1' });
  });

  it('returns requiresHitl:false for allow/monitor/constrain', () => {
    for (const arm of ['allow', 'monitor', 'constrain']) {
      expect(enforceVerdict({ arm }, 'llm_start')).toEqual({ requiresHitl: false });
    }
  });
});
