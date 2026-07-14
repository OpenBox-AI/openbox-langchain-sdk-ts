// Builds the governance runtime for one middleware instance, resolving the
// circular approval dependency: the ApprovalPoller needs a client, the
// CoreAdapter needs the poller, and the runtime needs the adapter — so the
// client is built and injected explicitly.
//
// GOTCHA: an INJECTED client does not inherit identity from config (only the
// default client does), so every identity option is set on the client here to
// preserve the `openbox-langchain-typescript-v<pkg>` header branding.

import { SDK_ENGINE, SDK_LANGUAGE, SDK_PACKAGE_VERSION } from "../sdk-metadata.js";
import { DEFAULT_APPROVAL_MAX_WAIT_MS, type OpenBoxLangChainMiddlewareOptions } from "./options.js";
import { ApprovalPoller } from "@openbox-ai/openbox-sdk-ts/approvals";
import { CoreAdapter } from "@openbox-ai/openbox-sdk-ts/adapters";
import { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import { OpenBoxConfig, type ResolveOptions } from "@openbox-ai/openbox-sdk-ts/config";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

/** Resolve the finite approval wait: option wins, then config, then the finite default. */
export function resolveApprovalMaxWait(
  options: OpenBoxLangChainMiddlewareOptions,
  hitlMaxWaitMs: number | null
): number | null {
  if (options.approvalMaxWaitMs !== undefined) return options.approvalMaxWaitMs;
  if (hitlMaxWaitMs !== null) return hitlMaxWaitMs;
  return DEFAULT_APPROVAL_MAX_WAIT_MS;
}

export function buildMiddlewareRuntime(
  options: OpenBoxLangChainMiddlewareOptions
): OpenBoxRuntime {
  const resolveInput: ResolveOptions = {
    envPrefix: options.envPrefix ?? "OPENBOX_LANGCHAIN",
    agentName: options.agentName ?? null,
    agentDid: options.agentDid ?? null,
    agentPrivateKey: options.agentPrivateKey ?? null,
    sdkVersion: SDK_PACKAGE_VERSION,
    sdkEngine: SDK_ENGINE,
    sdkLanguage: SDK_LANGUAGE,
    validate: options.validate ?? true
  };
  // Only assign fields that were provided (exactOptionalPropertyTypes forbids
  // passing `undefined` for these string/number/enum fields).
  if (options.apiUrl !== undefined) resolveInput.apiUrl = options.apiUrl;
  if (options.apiKey !== undefined) resolveInput.apiKey = options.apiKey;
  if (options.onApiError !== undefined) resolveInput.onApiError = options.onApiError;
  if (options.timeoutSeconds !== undefined) resolveInput.timeoutSeconds = options.timeoutSeconds;

  const config = OpenBoxConfig.resolve(resolveInput);

  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    sdkVersion: SDK_PACKAGE_VERSION,
    sdkEngine: SDK_ENGINE,
    sdkLanguage: SDK_LANGUAGE,
    identity: config.loadIdentity(),
    timeoutSeconds: config.timeoutSeconds,
    onApiError: config.onApiError
  });

  // Gate on config.hitl.enabled directly (defaults true, never nullish).
  const approvalPoller = config.hitl.enabled
    ? new ApprovalPoller(client, {
        pollIntervalMs: options.approvalPollIntervalMs ?? config.hitl.pollIntervalMs,
        maxWaitMs: resolveApprovalMaxWait(options, config.hitl.maxWaitMs)
      })
    : null;

  const adapter = new CoreAdapter({ approvalPoller });
  return new OpenBoxRuntime(config, { client, adapter });
}
