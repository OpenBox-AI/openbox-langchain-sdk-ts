# Release status

**Publishable pending a version bump + explicit approval.** The former hard
blocker (local `file:` base SDK dependency) is resolved.

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

## Remaining gate: version

`openbox-langchain-governance@1.0.1` is already published on npm (the
pre-rewrite architecture from the upstream repo history). The local tree is a
breaking re-architecture (`feat!`: callback + middleware surfaces), so the
next publish must bump the version — semver says **2.0.0**.

Publishing is gated on explicit approval; do not publish as part of
implementation.
