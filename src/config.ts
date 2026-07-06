/**
 * Governance configuration — standalone version.
 * Mirrors OpenBoxLangChainMiddlewareOptions + GovernanceConfig from the n8n SDK.
 */

export interface OpenBoxLangChainMiddlewareOptions {
  /** OpenBox Core API URL. Defaults to https://core.openbox.ai */
  openboxUrl?: string;
  /** OpenBox API key */
  apiKey: string;
  /** Displayed as workflow_type in governance events. */
  agentName?: string;
  sessionId?: string;
  /** task_queue field on all events. Defaults to "langchain". */
  taskQueue?: string;
  onApiError?: 'fail_open' | 'fail_closed';
  governanceTimeout?: number;
  toolTypeMap?: Record<string, string>;
  skipToolTypes?: Set<string>;
  sendChainStartEvent?: boolean;
  sendChainEndEvent?: boolean;
  sendLlmStartEvent?: boolean;
  sendLlmEndEvent?: boolean;
  sendToolStartEvent?: boolean;
  sendToolEndEvent?: boolean;
  hitl?: Partial<HITLConfig>;
  agentDid?: string;
  agentPrivateKey?: string;
  instrumentHttp?: boolean;
  instrumentFileIo?: boolean;
  instrumentDatabases?: boolean;
}

export interface HITLConfig {
  enabled: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface GovernanceConfig {
  openboxUrl: string;
  apiKey: string;
  taskQueue: string;
  onApiError: 'fail_open' | 'fail_closed';
  governanceTimeout: number;
  toolTypeMap: Record<string, string>;
  skipToolTypes: Set<string>;
  sessionId?: string;
  agentName?: string;
  sendChainStartEvent: boolean;
  sendChainEndEvent: boolean;
  sendLlmStartEvent: boolean;
  sendLlmEndEvent: boolean;
  sendToolStartEvent: boolean;
  sendToolEndEvent: boolean;
  hitl: HITLConfig;
  instrumentHttp: boolean;
  instrumentFileIo: boolean;
  instrumentDatabases: boolean;
  agentDid?: string;
  agentPrivateKey?: string;
}

export function mergeConfig(opts: OpenBoxLangChainMiddlewareOptions): GovernanceConfig {
  return {
    openboxUrl: (opts.openboxUrl ?? 'https://core.openbox.ai').replace(/\/+$/, ''),
    apiKey: opts.apiKey,
    taskQueue: opts.taskQueue ?? 'langchain',
    onApiError: opts.onApiError ?? 'fail_open',
    governanceTimeout: opts.governanceTimeout ?? 30000,
    toolTypeMap: opts.toolTypeMap ?? {},
    skipToolTypes: opts.skipToolTypes ?? new Set(),
    sessionId: opts.sessionId,
    agentName: opts.agentName,
    sendChainStartEvent: opts.sendChainStartEvent ?? true,
    sendChainEndEvent: opts.sendChainEndEvent ?? true,
    sendLlmStartEvent: opts.sendLlmStartEvent ?? true,
    sendLlmEndEvent: opts.sendLlmEndEvent ?? true,
    sendToolStartEvent: opts.sendToolStartEvent ?? true,
    sendToolEndEvent: opts.sendToolEndEvent ?? true,
    hitl: {
      enabled: opts.hitl?.enabled ?? true,
      pollIntervalMs: opts.hitl?.pollIntervalMs ?? 5000,
      timeoutMs: opts.hitl?.timeoutMs ?? 300000,
    },
    agentDid: opts.agentDid,
    agentPrivateKey: opts.agentPrivateKey,
    instrumentHttp: opts.instrumentHttp ?? true,
    instrumentFileIo: opts.instrumentFileIo ?? false,
    instrumentDatabases: opts.instrumentDatabases ?? true,
  };
}
