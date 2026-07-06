/**
 * @openbox/langchain-governance
 *
 * Standalone OpenBox governance middleware for LangChain JS/TS.
 * No n8n dependency — works with any LangChain application.
 */

export { OpenBoxLangChainMiddleware, AgentState } from './middleware';
export { GovernanceClient, SoftGovernanceError, ApprovalPollResponse } from './client';
export { GovernanceConfig, OpenBoxLangChainMiddlewareOptions, HITLConfig, mergeConfig } from './config';
export {
  GovernanceHaltError,
  GovernanceBlockedError,
  GuardrailsValidationError,
  VerdictResult,
  enforceVerdict,
  verdictFromString,
} from './verdict';
export {
  GovernanceVerdictResponse,
  GuardrailsResult,
  LangChainGovernanceEvent,
  VerdictArm,
  hexId,
  rfc3339Now,
  safeSerialize,
} from './types';
export { pollApprovalOrHalt } from './hitl';
export { handleBeforeAgent, handleAfterAgent, handleWrapModelCall, handleWrapMemoryOp } from './hook_handlers';
export { handleWrapToolCall } from './tool_hook';
export { buildSignedHeaders, serializeBody, EMPTY_BODY_SHA256 } from './signing';
export {
  registerActivity,
  unregisterActivity,
  unregisterWorkflow,
  runWithActivity,
  getCurrentActivityId,
  markActivityApproved,
  isActivityApproved,
  clearActivityAbort,
  hasActivityAbort,
  evaluateActivitySpan,
  buildHttpSpanData,
  addIgnoredPrefix,
  shouldIgnore,
  setupSpanProcessorInstrumentation,
} from './span_processor';
