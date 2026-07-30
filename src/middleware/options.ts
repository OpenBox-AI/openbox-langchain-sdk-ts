// Options for `createOpenBoxLangChainMiddleware` and their resolved form.

import type { Logger } from "../lifecycle-telemetry.js";
import type { OnApiError } from "@openbox-ai/openbox-sdk-ts/config";
import type { DatabaseDriverName } from "@openbox-ai/openbox-sdk-ts/instrumentation";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

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
  /**
   * Explicit verification method override. Never `"legacy_unsigned"` — that
   * remains an inferred-only compatibility classification the base SDK
   * selects when neither DID nor Okta fields are configured (contract §1).
   */
  identityMethod?: "openbox_did" | "okta_ai_agent";
  // ── v2 (okta_ai_agent) identity — mutually exclusive with agentDid/agentPrivateKey.
  // Forwarded to the base SDK unchanged; this package never mints, validates,
  // or inspects the assertion itself (proposal §13.2/§13.7).
  /** OpenBox agent UUID (also signed as `obx_agent_id`). */
  agentId?: string;
  /** OpenBox organization UUID (also signed as `obx_organization_id`). */
  organizationId?: string;
  /** Stable deployment identifier (also signed as `obx_deployment_id`). */
  deploymentId?: string;
  /** Deployment-scoped audience `urn:openbox:<deployment-id>:core`. */
  agentProofAudience?: string;
  /** The linked Okta AI Agent's external ID (signed as `iss`/`sub`). */
  oktaAgentId?: string;
  /** The selected public credential's `kid`. */
  oktaAgentKeyId?: string;
  /** PKCS8 PEM RSA private key (>= 2048-bit). Never logged. */
  oktaAgentPrivateKey?: string;
  /** Allowlisted at `"RS256"` only for this release. */
  oktaAgentAlgorithm?: string;
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
  /** Injectable fetch for tests (e.g. a fixture-backed Core stub); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
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
