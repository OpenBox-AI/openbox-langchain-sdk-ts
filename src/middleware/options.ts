// Options for `createOpenBoxLangChainMiddleware` and their resolved form.

import type { Logger } from "../lifecycle-telemetry.js";
import type { OnApiError } from "@openbox-ai/openbox-sdk/config";
import type { DatabaseDriverName } from "@openbox-ai/openbox-sdk/instrumentation";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk/runtime";

/**
 * Finite client-side approval wait used when neither the option nor
 * `config.hitl.maxWaitMs` sets one. Comfortably above the typical server-side
 * approval expiry (~30 min) so a server halt normally wins, but bounded so a
 * never-approved request cannot hang `invoke()` forever. Pass `null` explicitly
 * (option or config) to opt back into indefinite polling.
 */
export const DEFAULT_APPROVAL_MAX_WAIT_MS = 60 * 60 * 1000;

export interface OpenBoxLangChainMiddlewareOptions {
  // ── identity / config ──
  apiUrl?: string;
  apiKey?: string;
  agentName?: string;
  agentDid?: string;
  agentPrivateKey?: string;
  onApiError?: OnApiError;
  timeoutSeconds?: number;
  /** Env-var prefix layered over the global `OPENBOX_*` set. */
  envPrefix?: string;

  // ── event/wire options (NOT config inputs) ──
  sessionId?: string;
  taskQueue?: string;

  // ── send flags (each also gates its enforcement + redaction) ──
  sendChainStartEvent?: boolean;
  sendChainEndEvent?: boolean;
  sendLlmStartEvent?: boolean;
  sendLlmEndEvent?: boolean;
  sendToolStartEvent?: boolean;
  sendToolEndEvent?: boolean;

  // ── tool handling ──
  // NB: tool-type classification for the observability callback surface is set
  // via that handler's `toolTypeResolver`. The enforcing middleware tool hook
  // does not enrich tool input, so there is no tool-type map option here.
  skipToolTypes?: Iterable<string>;

  // ── HITL approval polling (default from config.hitl unless set) ──
  approvalPollIntervalMs?: number;
  /** `undefined` → finite default; explicit `null` → poll indefinitely. */
  approvalMaxWaitMs?: number | null;

  // ── instrumentation ──
  installInstrumentation?: boolean;
  instrumentationStrict?: boolean;
  databases?: readonly DatabaseDriverName[];

  // ── misc ──
  validate?: boolean;
  /** Inject a pre-built runtime (owns its own adapter/approval semantics). */
  runtime?: OpenBoxRuntime;
  logger?: Logger;
}

/** Options with all send flags + defaults applied (used inside the hooks). */
export interface ResolvedMiddlewareOptions {
  sessionId: string | null;
  agentName: string | null;
  taskQueue: string;
  sendChainStartEvent: boolean;
  sendChainEndEvent: boolean;
  sendLlmStartEvent: boolean;
  sendLlmEndEvent: boolean;
  sendToolStartEvent: boolean;
  sendToolEndEvent: boolean;
  skipToolTypes: Set<string>;
  logger: Logger | undefined;
}

/** Apply defaults to the event/behavior options (config-layer options handled separately). */
export function resolveMiddlewareOptions(
  options: OpenBoxLangChainMiddlewareOptions
): ResolvedMiddlewareOptions {
  return {
    sessionId: options.sessionId ?? null,
    agentName: options.agentName ?? null,
    taskQueue: options.taskQueue ?? "langchain",
    sendChainStartEvent: options.sendChainStartEvent ?? true,
    sendChainEndEvent: options.sendChainEndEvent ?? true,
    sendLlmStartEvent: options.sendLlmStartEvent ?? true,
    sendLlmEndEvent: options.sendLlmEndEvent ?? true,
    sendToolStartEvent: options.sendToolStartEvent ?? true,
    sendToolEndEvent: options.sendToolEndEvent ?? true,
    skipToolTypes: new Set(options.skipToolTypes ?? []),
    logger: options.logger
  };
}
