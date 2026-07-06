# `.github/workflows/`

| Workflow | Triggers | Purpose |
|---|---|---|
| `release.yml` | push of a tag matching `*.*.*`, or `workflow_dispatch` | Full release gate: governance file checks -> quality (`ci:check` + coverage + `npm pack` check) -> security (Trivy + Gitleaks) -> SonarQube (skips cleanly if unconfigured) -> publish to npm with provenance + create a GitHub release. All four gate jobs must pass before `publish` runs |
| `pr-quality.yml` | push/PR to `main`, or `workflow_dispatch` | Lint, typecheck, test (with coverage), build, optional SonarQube |
| `pr-security.yml` | push/PR to `main`, or `workflow_dispatch` | Trivy filesystem scan + Gitleaks secret scan, both uploaded as SARIF to the Security tab |
| `pr-governance.yml` | push/PR to `main`, or `workflow_dispatch` | On pull requests: enforces `<type>/<desc>` branch naming and Conventional Commits PR titles, and requires CODEOWNERS coverage for changes touching workflows/CODEOWNERS/SECURITY.md/.gitleaks.toml |
| `release-branch.yml` | `workflow_dispatch` only | Builds the SDK and creates a `release-v*` branch with committed `dist/` so consumers can `github:OpenBox-AI/openbox-langchain-sdk-ts#release-v*` install without running a build step. Independent of `release.yml` — no registry involved, no `NPM_TOKEN` needed. Tag-push trigger is commented out until a first tagged release ships |

**Tag format mismatch to be aware of:** `release.yml` validates tags against
`^[0-9]+\.[0-9]+\.[0-9]+$` — bare semver, e.g. `1.0.0`, no `v` prefix. The
`v1.0.0` tag already pushed for `release-branch.yml` does **not** match this
pattern and will not trigger `release.yml`'s `release-governance` job
correctly. Use bare tags (`git tag 1.0.0`) to cut an npm release; the two
tagging schemes are independent since `release-branch.yml` takes its tag as
a manual `workflow_dispatch` input rather than reading `github.ref_name`
from a push.

## Required repo secrets

| Secret | Used by | Notes |
|---|---|---|
| `NPM_TOKEN` | `release.yml` (`publish` job) | npm automation token with publish rights to the `@openbox` scope. Create at npmjs.com -> Access Tokens -> Generate New Token -> Automation, then `gh secret set NPM_TOKEN --repo OpenBox-AI/openbox-langchain-sdk-ts` |
| `SONAR_TOKEN`, `SONAR_HOST_URL` | `release.yml`, `pr-quality.yml` | Optional. SonarQube/SonarCloud steps skip cleanly (no failure) when either is unset. `sonar-project.properties` ships with a placeholder `projectKey` — update it to your real project key once you have one |
| `CODECOV_TOKEN` | `pr-quality.yml` | Optional. Codecov upload step only runs when this is set and coverage was produced |

`release.yml`'s `publish` job also runs under a `release` GitHub
Environment — configure required reviewers there (Settings -> Environments
-> release) if you want a manual approval gate before npm publish.

## Required GitHub variable

`pr-governance.yml`'s commit-message check only runs when the repo variable
`ENFORCE_COMMIT_CONVENTION` is set to `true` (Settings -> Secrets and
variables -> Actions -> Variables). Unset by default.

Not present: this repo has no TypeSpec/OpenAPI spec system or upstream
service to drift-check, so there's no `codegen.yml` or `spec-drift.yml`
equivalent — those only make sense for spec-driven SDKs.

`test-smoke.js` makes a real network call to OpenBox Core + OpenRouter and
needs live `OPENBOX_API_KEY` / `OPENROUTER_API_KEY` secrets, so it's
intentionally excluded from CI and run manually instead. Unit tests live in
`tests/` and run via `npm run test` / `npm run ci:check`.

## How to run a dispatch-only or manually-triggerable workflow

GitHub UI: Actions tab, pick the workflow, "Run workflow", choose a
branch.

Via `gh`:

```bash
gh workflow run release.yml          --ref main
gh workflow run pr-quality.yml       --ref main
gh workflow run pr-security.yml      --ref main
gh workflow run pr-governance.yml    --ref main
gh workflow run release-branch.yml   --ref main -f tag=v1.0.0
```

To cut a real npm release, push a bare-semver tag instead of dispatching manually:

```bash
git tag 1.0.0
git push origin 1.0.0
```
