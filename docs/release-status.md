# Release status

**Versioned 3.0.0.** Base SDK 2.0.0 is published on npm, and this package and its
example now require `^2.0.0`. Local checks against that published base pass;
publishing this adapter still requires explicit approval.

## Resolved: base SDK now a published npm semver

`@openbox-ai/openbox-sdk-ts@2.0.0` is published on npm with the
adapter-facing API this package targets (`./config`, `./runtime`,
`./adapters`, `./context`, `./instrumentation`, `./conformance`, `./client`).

- Root `package.json` depends on `"@openbox-ai/openbox-sdk-ts": "^2.0.0"`;
  `package-lock.json` resolves it from `registry.npmjs.org` (integrity-pinned
  tarball, no symlink).
- `examples/content-builder-agent` declares the same `^2.0.0` directly (its
  smoke script imports base SDK subpaths), plus the in-repo
  `file:../..` link to this adapter — expected for an in-repo example, not
  shipped in the tarball.
- No `file:` / `link:` / `../` references to the base SDK remain in any
  manifest or lockfile.

## Verified locally against published base 2.0.0

- Fresh `npm ci` installs in the root and example both resolve base 2.0.0 from
  the registry tarball, with no sibling-checkout symlink.
- Full gate green: `lint`, `typecheck`, `test` (140 tests across 20 files, with
  coverage), `build`, `import:check` (root stays import-light).
- Example typechecks and the offline smoke agent
  (`npm run smoke` in the example directory) completes end-to-end with zero
  network calls.
- Tarball (`npm pack --dry-run`) ships `dist/`, `README.md`, `LICENSE`, and
  `package.json` (87 files, ~59.6 kB packed).
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

## Resolved: IAM v3 base dependency floor

The `^2.0.0` dependency floor supplies the published IAM v3 APIs:
`OpenBoxClient.fromConfig`, `workloadPrivateKey`, `OpenBoxWorkloadAuthError`, and
the `AgentIdentityMethod` root type. Both lockfiles resolve base 2.0.0 from npm.
The local checks above verify SDK compatibility and offline behavior; they do
not establish deployed Core/Keycloak integration status.
