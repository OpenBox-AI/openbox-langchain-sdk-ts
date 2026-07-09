# API reference

Two entry points. The root is import-light (`@langchain/core` only); the full
`langchain` framework loads only behind `./middleware`.

## `@openbox-ai/openbox-langchain-sdk` (root — observability + shared helpers)

### SDK identity
- `SDK_VERSION`, `SDK_PACKAGE_VERSION` — this package's version (the version
  component of the `X-OpenBox-SDK-Version` header).
- `SDK_ENGINE` (`"langchain"`), `SDK_LANGUAGE` (`"typescript"`).

### Observability callback
- `OpenBoxLangChainCoreCallbackHandler` — a `@langchain/core` `BaseCallbackHandler`
  that emits tool/LLM lifecycle telemetry and a span-correlation seam. Never
  blocks. Construct with `OpenBoxLangChainCoreCallbackOptions` (`runtime`,
  `bridge`, `workflowId`, `runId`, `workflowType`, optional send flags,
  `toolTypeResolver`, `preScreenResponse`/`preScreenActivityId`, `recordLessOk`,
  `registerTrace`/`unregisterTrace`, `logger`).

### ActivityBridge
- `ActivityBridge` — per-installation ownership tracking + verdict stashing +
  run-id aliasing for the callback surface. Types: `ActivityRecord`, `EventType`
  (`"tool_start" | "tool_complete" | "llm_start" | "llm_complete"`),
  `ToolRecordMetadata`.

### Lifecycle helpers (pure)
- Event builders: `buildActivityStarted`, `buildActivityCompleted`,
  `buildWorkflowStarted`, `buildWorkflowCompleted`, `buildWorkflowFailed`,
  `buildSignalReceived`, `mergeSessionExtra` — wrap the base factories and inject
  `session_id` / `agent_name` as snake_case wire keys.
- `enrichActivityInput`, `extractResponseMetadata`.
- `extractHumanTurnPrompt`, `coerceRedactedText`, `buildRedactedUserMessage`.
- `evaluateLifecycleTelemetryOnly(runtime, event, { logger? })` — the
  non-enforcing send used by every completion/observer event. Returns the
  `EvaluationResult`, or `null` on an evaluate-level failure. Never enforces.

## `@openbox-ai/openbox-langchain-sdk/middleware` (enforcement)

- `createOpenBoxLangChainMiddleware(options): Promise<OpenBoxLangChainMiddlewareBundle>`
  — builds the runtime, validates the API key, installs base instrumentation
  (collision-safe), and returns `{ middleware, runtime, instrumentation, close() }`.
  Pass `middleware` to `createAgent({ middleware: [...] })`; `await close()` when
  done.
- `OpenBoxLangChainMiddlewareOptions` — `apiUrl`, `apiKey`, `agentName`,
  `agentDid`, `agentPrivateKey`, `onApiError` (default `fail_open`),
  `timeoutSeconds`, `envPrefix` (default `OPENBOX_LANGCHAIN`), `sessionId`,
  `taskQueue` (default `langchain`), the `send*Event` flags (all default true —
  each also gates its enforcement + redaction), `skipToolTypes`,
  `approvalPollIntervalMs`, `approvalMaxWaitMs` (`undefined` → finite default;
  explicit `null` → poll indefinitely), `installInstrumentation` (default true),
  `instrumentationStrict`, `databases`, `validate` (default true), `runtime`
  (inject a pre-built one), `logger`.
- `DEFAULT_APPROVAL_MAX_WAIT_MS` — the finite client-side approval wait applied
  when neither option nor `config.hitl.maxWaitMs` sets one.
- `openBoxStateSchema` — the graph-state schema the middleware contributes;
  types `ObTurn`, `PreScreenSummary`.

See [governance-model.md](./governance-model.md) for the enforce-vs-telemetry
matrix, the single-active-runtime constraint, and fail-open/closed guidance.
