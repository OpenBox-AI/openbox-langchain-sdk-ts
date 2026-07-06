# `.github/workflows/`

| Workflow | Triggers | Purpose |
|---|---|---|
| `test.yml` | `workflow_dispatch` only | `tsc --noEmit` on `src/` and `examples/`, plus a full `npm run build`. Push and PR triggers are commented out until the workflow has run clean a few times |
| `release-branch.yml` | `workflow_dispatch` only | Builds the SDK and creates a `release-v*` branch with committed `dist/` so consumers can `github:sap1110/Langchain-SDK#release-v*` install without running a build step. Tag-push trigger is commented out until a first tagged release ships |

Not present: this repo has no TypeSpec/OpenAPI spec system or upstream
service to drift-check, so there's no `codegen.yml` or `spec-drift.yml`
equivalent — those only make sense for spec-driven SDKs.

No automated test suite exists yet. `test-smoke.js` makes a real network
call to OpenBox Core + OpenRouter and needs live `OPENBOX_API_KEY` /
`OPENROUTER_API_KEY` secrets, so it's intentionally excluded from CI and
run manually instead.

## How to run a dispatch-only workflow

GitHub UI: Actions tab, pick the workflow, "Run workflow", choose a
branch.

Via `gh`:

```bash
gh workflow run test.yml            --ref master
gh workflow run release-branch.yml  --ref master -f tag=v1.0.0
```

## How to enable a dispatch-only workflow on push/PR

Replace the `on:` block in the workflow YAML, e.g. for `test.yml`:

```yaml
on:
  push:
    branches: [master]
  pull_request:
    branches: [master]
```
