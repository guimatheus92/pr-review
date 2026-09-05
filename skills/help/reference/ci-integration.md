---
description: "pr-review CI/CD integration: GitHub Actions and Azure DevOps Pipelines examples, exit codes, --fail-on gating, official documentation links. Use when asked about CI/CD, automation, gating merges on findings, running pr-review on every PR automatically, or setting up pr-review in a pipeline."
---

# Running pr-review in CI/CD

The tool runs in CI the same way it runs locally: install an agent runtime (Copilot CLI or Claude Code — the examples below use Copilot; pass `--runtime claude` to host the session on Claude Code) + this plugin, then call `pr-review review <pr-url>` with auth env vars.

## Exit codes and gating

| Exit code | Meaning |
|---|---|
| `0` | Clean — no findings at/above the threshold |
| `1` | Findings at/above the `--fail-on` severity survived dedupe |
| `2` | Incomplete reviewer/verifier/Codex delivery or another operational failure; partial findings were not posted |

To gate a pipeline on serious findings, add `--fail-on <severity>` (`critical`\|`high`\|`medium`\|`low`\|`nit`):

```bash
pr-review review "$PR_URL" --fail-on high
```

The step fails (exit 1) when any CRITICAL or HIGH finding survives dedupe.

**Always configure `--fail-on` when the exit code gates a merge.** Without it, exit 0 means the pipeline completed — findings may still have been retained and posted, and the CLI says how many. Only `--fail-on` turns a finding into a non-zero status.

Treat exit 2 as an infrastructure failure, not a review verdict. It covers a pipeline failure (no parseable findings; "nothing to review with" — no skills matched the PR and no baseline is configured, so run `pr-review packs suggest` or check `skill_packs`), incomplete planned reviewer/verifier/Codex delivery, **and** an operational failure of an otherwise parseable review: a failed review prerequisite, a planned pass or companion that delivered no output or two, or a post that failed or could not be verified. The summary's Degraded block names which one, and `error.txt` in the run dir carries the detail. A detached schema-v1 run may expose status exit 21; its printed resume command preserves the original dry-run/publish mode and retries only incomplete coverage.

## GitHub Actions (official path)

GitHub publishes an official Marketplace action: [`actions/setup-copilot@v0`](https://github.com/marketplace/actions/setup-copilot-cli). It installs the Copilot CLI binary on the runner.

Reference docs:
- [Automating tasks with Copilot CLI and GitHub Actions](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/automate-with-actions) — the canonical guide
- [Copilot CLI programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference) — env vars, flags

Example workflow (`.github/workflows/pr-review.yml`):

```yaml
name: PR Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - uses: actions/setup-copilot@v0
        with:
          version: latest
          github-token: ${{ secrets.GITHUB_TOKEN }}
      - name: Install pr-review plugin
        run: |
          copilot plugin marketplace add guimatheus92/pr-review
          copilot plugin install pr-review@pr-review
          # Build the bundled Node CLI:
          cd "$(copilot plugin path pr-review)"
          npm install --omit=dev && npm run build
      - name: Review the PR
        env:
          COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_PR_REVIEW_TOKEN }}   # token belonging to an identity with a Copilot seat
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          pr-review review ${{ github.event.pull_request.html_url }}
```

**Notes:**
- `actions/setup-copilot@v0` is pre-1.0; its API may evolve.
- `COPILOT_GITHUB_TOKEN` must belong to an identity with an active Copilot seat. `GITHUB_TOKEN` alone can post comments but cannot drive Copilot CLI.

## Azure DevOps Pipelines

**No first-party Microsoft task exists for `@github/copilot` as of writing.** You install via a generic Bash/PowerShell step. The closest related Microsoft doc — [CI/CD Integration with Modernize CLI](https://learn.microsoft.com/en-us/azure/developer/github-copilot-app-modernization/modernization-agent/cicd-integration) — covers a different Microsoft CLI, but the auth pattern transfers.

Example pipeline (`azure-pipelines.yml`):

```yaml
trigger: none
pr:
  - main

pool:
  vmImage: ubuntu-latest

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '20.x'

  - bash: |
      curl -fsSL https://github.com/github/copilot-cli/releases/latest/download/copilot-linux-x64.tar.gz | tar -xz -C "$HOME/.local/bin"
      copilot --version
    displayName: 'Install Copilot CLI'
    env:
      COPILOT_GITHUB_TOKEN: $(COPILOT_GITHUB_TOKEN)

  - bash: |
      copilot plugin marketplace add guimatheus92/pr-review
      copilot plugin install pr-review@pr-review
      cd "$(copilot plugin path pr-review)"
      npm install --omit=dev && npm run build
    displayName: 'Install pr-review plugin'

  - bash: |
      # System.TeamFoundationCollectionUri already expands to https://dev.azure.com/<org>/
      PR_URL="$(System.TeamFoundationCollectionUri)$(System.TeamProject)/_git/$(Build.Repository.Name)/pullrequest/$(System.PullRequest.PullRequestId)"
      pr-review review "$PR_URL"
    displayName: 'Review the PR'
    env:
      AZURE_DEVOPS_PAT: $(System.AccessToken)
      COPILOT_GITHUB_TOKEN: $(COPILOT_GITHUB_TOKEN)
```

**Notes:**
- Enable "Allow scripts to access the OAuth token" in the pipeline settings so `$(System.AccessToken)` works.
- The pipeline's build service identity needs **Contribute to pull requests** permission on the repo.
- The `COPILOT_GITHUB_TOKEN` is still required (Copilot CLI authenticates to GitHub regardless of repo host).

## Auth env vars (both platforms)

Precedence per [Copilot CLI programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference):

1. `COPILOT_GITHUB_TOKEN` (highest; tool-specific)
2. `GH_TOKEN`
3. `GITHUB_TOKEN`

The token must come from an identity holding an active Copilot Business / Enterprise / Pro seat.

## Auditing a run in CI

`pr-review verify --json` grades a finished run against every guarantee in
`INVARIANTS.md` and exits **2** on any violation. It is read-only — it never
posts, deletes or rewrites anything — so it is safe to add as a step after the
review:

```yaml
- run: pr-review review "$PR_URL"
- run: pr-review verify --pr "$PR_URL" --json
  if: always()
```

Exit 0 means every invariant passed or was explicitly skipped with a reason;
exit 2 means the run broke a guarantee (a top-level comment appeared, a finding
never landed, the file list was never proved complete, a planned pass delivered
nothing). Add `--offline` to grade from the run artifacts alone when you do not
want the extra provider read.

## What about `pr-review init`?

`pr-review init` deliberately does NOT generate these YAML files. CI configurations are better hand-authored by the team owning the pipeline; we provide the templates above for reference, not as a generator output.
