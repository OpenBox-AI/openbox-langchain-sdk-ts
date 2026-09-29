# Release status

**Versioned 3.0.0.** Publishable only after base 2.0.0 is on npm and this package's
base range is raised (see below), and with explicit approval.

## Resolved: base SDK now a published npm semver

`@openbox-ai/openbox-sdk-ts@1.0.0` is published on npm with the
adapter-facing API this package targets (`./config`, `./runtime`,
`./adapters`, `./context`, `./instrumentation`, `./conformance`, `./client`).

- Root `package.json` depends on `"@openbox-ai/openbox-sdk-ts": "^1.0.0"`;
  `package-lock.json` resolves it from `registry.npmjs.org` (integrity-pinned
  tarball, no symlink).
- `examples/content-builder-agent` declares the same `^1.0.0` directly (its
  smoke script imports base SDK subpaths), plus the in-repo
  `file:../..` link to this adapter — expected for an in-repo example, not
  shipped in the tarball.
- No `file:` / `link:` / `../` references to the base SDK remain in any
  manifest or lockfile.

## Verified against the published artifact

- Full gate green with the registry tarball installed: `lint`, `typecheck`,
  `test` (with coverage), `build`, `import:check` (root stays import-light).
- Example typechecks and the offline smoke agent
  (`npm run example:smoke`) completes end-to-end with zero network calls.
- Tarball (`npm pack --dry-run`) ships only `dist/`, `README.md`, `LICENSE`
  (87 files, ~55.8 kB packed).
- `X-OpenBox-SDK-Version` brands as `openbox-langchain-typescript-v<pkg>`
  (identity test).
- ESM-only, Node `>=24.10.0`, exports for `.` and `./middleware`.

## Version: 3.0.0

`@openbox-ai/openbox-langchain-governance@2.0.0` is published on npm. This tree
breaks its API (the `validate` option is removed) and needs the base 2.x major for
IAM v3, so it is versioned **3.0.0**.

Publishing is gated on explicit approval; do not publish as part of
implementation.

## Breaking in 3.0.0: `validate` option removed

`createOpenBoxLangChainMiddleware` no longer accepts `validate`. It always checks
the API key (and, for v3, the workload identity) against Core before returning,
and config is always validated. Tests and offline runs use a fake Core that
answers `/auth/validate` (the base `FakeCore` does) or inject a `runtime` whose
client does. One consequence: the middleware cannot be created while Core is
unreachable, whatever `onApiError` says.

## Pending: IAM v3 base dependency floor

The Keycloak workload identity (`keycloak_workload`) support depends on base SDK
features that are not yet published (`OpenBoxClient.fromConfig`,
`workloadPrivateKey`, `OpenBoxWorkloadAuthError`, the `AgentIdentityMethod` root
type). Local development resolves the sibling checkout via
`node_modules/@openbox-ai/openbox-sdk-ts -> ../openbox-sdk-ts`. The base is already
bumped to `2.0.0` on its PR. Release order: publish base `2.0.0` first, then raise
this package's `@openbox-ai/openbox-sdk-ts` range to `^2.0.0`, regenerate
`package-lock.json` from the registry, update the example's range, and publish this
package as `3.0.0`. Until then `^1.0.0` does NOT guarantee the required base
features — do not publish.

