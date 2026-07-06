/**
 * Hook helper functions — port of middleware_hooks.py.
 */

import type { OpenBoxLangChainMiddleware } from './middleware';
import { GovernanceVerdictResponse, LangChainGovernanceEvent, rfc3339Now } from './types';
import { GovernanceBlockedError } from './verdict';

export function baseEventFields(mw: OpenBoxLangChainMiddleware): {
  source: 'workflow-telemetry';
  workflow_id: string;
  run_id: string;
  workflow_type: string;
  task_queue: string;
  timestamp: string;
  session_id: string | undefined;
} {
  return {
    source: 'workflow-telemetry',
    workflow_id: mw._workflowId,
    run_id: mw._runId,
    workflow_type: mw._workflowType,
    task_queue: mw._config.taskQueue,
    timestamp: rfc3339Now(),
    session_id: mw._config.sessionId,
  };
}

export async function evaluate(
  mw: OpenBoxLangChainMiddleware,
  event: LangChainGovernanceEvent,
): Promise<GovernanceVerdictResponse | null> {
  return mw._client.evaluateEvent(event);
}

export function extractGovernanceBlocked(err: unknown): GovernanceBlockedError | null {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof GovernanceBlockedError) return current;
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      current = record.cause ?? record.context;
    } else {
      current = null;
    }
  }
  return null;
}

export function extractLastUserMessage(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (Array.isArray(msg) && msg.length === 2) {
      if (msg[0] === 'user' || msg[0] === 'human') {
        return typeof msg[1] === 'string' ? msg[1] : null;
      }
    } else if (msg !== null && typeof msg === 'object') {
      const m = msg as Record<string, unknown>;
      const role = m.type ?? m.role;
      if (role === 'human' || role === 'user') {
        const content = m.content;
        return typeof content === 'string' ? content : null;
      }
    }
  }
  return null;
}

export function extractPromptFromMessages(messages: unknown[]): string {
  if (!Array.isArray(messages)) return '';
  const parts: string[] = [];
  for (const msg of messages) {
    appendHumanContent(msg, parts);
  }
  return parts.join('\n');
}

function appendHumanContent(msg: unknown, parts: string[]): void {
  let role: unknown = null;
  let content: unknown = null;

  if (Array.isArray(msg) && msg.length === 2) {
    role = msg[0];
    content = msg[1];
  } else if (msg !== null && typeof msg === 'object') {
    const m = msg as Record<string, unknown>;
    role = m.type ?? m.role;
    content = m.content;
  }

  if (role !== 'human' && role !== 'user' && role !== 'generic') return;

  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (
        typeof part === 'object' && part !== null &&
        (part as Record<string, unknown>).type === 'text'
      ) {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
}

export function applyPiiRedaction(messages: unknown[], redactedInput: unknown): void {
  let redactedText: string | null = null;

  if (Array.isArray(redactedInput) && redactedInput.length > 0) {
    const first = redactedInput[0];
    if (typeof first === 'object' && first !== null) {
      redactedText = (first as Record<string, string>).prompt ?? null;
    } else if (typeof first === 'string') {
      redactedText = first;
    }
  } else if (typeof redactedInput === 'string') {
    redactedText = redactedInput;
  }

  if (!redactedText) return;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (Array.isArray(msg) && msg.length === 2 && (msg[0] === 'human' || msg[0] === 'user')) {
      messages[i] = [msg[0], redactedText];
      return;
    }
    if (msg !== null && typeof msg === 'object') {
      const m = msg as Record<string, unknown>;
      const role = m.type ?? m.role;
      if ((role === 'human' || role === 'user' || role === 'generic') && 'content' in m) {
        m.content = redactedText;
        return;
      }
    }
  }
}

export interface ResponseMetadata {
  llm_model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  has_tool_calls?: boolean;
  completion?: string;
}

export function extractResponseMetadata(response: unknown): ResponseMetadata {
  const result: ResponseMetadata = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let aiMsg: any = response;
  if (aiMsg?.message != null) aiMsg = aiMsg.message;

  if (aiMsg?.response_metadata) {
    const meta = aiMsg.response_metadata as Record<string, unknown>;
    const model = meta.model_name ?? meta.model;
    if (typeof model === 'string') result.llm_model = model;
  }

  const usage = (aiMsg?.usage_metadata ?? {}) as Record<string, unknown>;
  const inp = (usage.input_tokens ?? usage.prompt_tokens) as number | undefined;
  const out = (usage.output_tokens ?? usage.completion_tokens) as number | undefined;
  result.input_tokens = inp;
  result.output_tokens = out;
  result.total_tokens = inp != null || out != null ? (inp ?? 0) + (out ?? 0) : undefined;

  const content = aiMsg?.content;
  if (typeof content === 'string') {
    result.completion = content || undefined;
  } else if (Array.isArray(content)) {
    const parts = (content as unknown[])
      .filter(
        (p): p is Record<string, unknown> =>
          typeof p === 'object' && p !== null &&
          (p as Record<string, unknown>).type === 'text',
      )
      .map((p) => String(p.text ?? ''));
    const joined = parts.join(' ');
    result.completion = joined || undefined;
  }

  result.has_tool_calls = Boolean(aiMsg?.tool_calls?.length);
  return result;
}
