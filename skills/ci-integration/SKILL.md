---
description: "pr-review CI/CD integration: GitHub Actions and Azure DevOps Pipelines examples with official documentation links. Use when asked about CI/CD, automation, running pr-review on every PR automatically, or setting up pr-review in a pipeline."
---

# Running pr-review in CI/CD

The tool runs in CI the same way it runs locally: install Copilot CLI + this plugin, then call `pr-review review <pr-url> --publish` with auth env vars.

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
          copilot plugin marketplace add gmatheus/pr-review
          copilot plugin install pr-review@pr-review
          # Build the bundled Node CLI:
          cd "$(copilot plugin path pr-review)"
          npm install --omit=dev && npm run build
      - name: Review the PR
        env:
          COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_PR_REVIEW_TOKEN }}   # token belonging to an identity with a Copilot seat
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          pr-review review ${{ github.event.pull_request.html_url }} --publish
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
      copilot plugin marketplace add gmatheus/pr-review
      copilot plugin install pr-review@pr-review
      cd "$(copilot plugin path pr-review)"
      npm install --omit=dev && npm run build
    displayName: 'Install pr-review plugin'

  - bash: |
      PR_URL="https://dev.azure.com/$(System.TeamFoundationCollectionUri)$(System.TeamProject)/_git/$(Build.Repository.Name)/pullrequest/$(System.PullRequest.PullRequestId)"
      pr-review review "$PR_URL" --publish
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

## What about `pr-review init`?

`pr-review init` deliberately does NOT generate these YAML files. CI configurations are better hand-authored by the team owning the pipeline; we provide the templates above for reference, not as a generator output.
