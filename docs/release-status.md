# Release status

**Not yet publishable.** One hard blocker remains.

## Blocker: base SDK is a local `file:` dependency

`package.json` depends on the base SDK as `"@openbox-ai/openbox-sdk":
"file:../openbox-sdk-ts"`, not an npm semver. This is required because the
**published** `@openbox-ai/openbox-sdk` on npm (all of `0.1.0`, `0.1.1`,
`0.1.2-beta.*`) is a **different package generation** than the local source this
adapter is built against:

- Published: a CLI / governed-session / copilotkit surface (`Core`,
  `OpenBoxCoreClient`, `govern`, `BaseGovernedSession`, subpaths `./governance`,
  `./session`, `./copilotkit`, …).
- Local `/Users/tino/code/openbox-sdk-ts`: the framework-adapter base SDK this
  package uses (`OpenBoxConfig`, `OpenBoxRuntime`, `CoreAdapter`,
  `ApprovalPoller`, `ContextStore`, event factories, `initOpenBoxInstrumentation`,
  subpaths `./config`, `./runtime`, `./adapters`, `./context`,
  `./instrumentation`, `./conformance`).

The adapter-facing API this package imports simply does not exist in the
published package, so a semver dependency is not yet possible.

### To unblock

1. Publish the base SDK at `/Users/tino/code/openbox-sdk-ts` (its adapter-facing
   API) to npm under a resolvable semver.
2. Re-verify the imported symbols against the installed published artifact in
   `node_modules` (not the local source tree).
3. Swap `file:../openbox-sdk-ts` → that semver in `package.json` and refresh
   `package-lock.json`; confirm no `file:` / `link:` / `workspace:` / `../` refs
   remain.
4. Re-run the full gate and `npm pack --dry-run`.

## Verified now

- Tarball (`npm pack --dry-run`) ships only `dist/`, `README.md`, `LICENSE` — no
  source, tests, examples, or plans.
- `X-OpenBox-SDK-Version` brands as `openbox-langchain-typescript-v<pkg>`
  (identity test).
- Full local gate green: `lint`, `typecheck`, `test` (with coverage), `build`,
  `import:check` (root stays import-light).
- ESM-only, Node `>=24.10.0`, exports for `.` and `./middleware`.

Publishing is gated on explicit approval; do not publish as part of
implementation.
