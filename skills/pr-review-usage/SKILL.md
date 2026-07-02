---
description: "pr-review quickstart: install, authenticate, daily usage, common flags. Use when asked how to review a PR, how to install pr-review, what the slash command does, or for a getting-started walkthrough."
---

# Using pr-review

## Install (once)

```bash
copilot plugin marketplace add gmatheus/pr-review     # if installing from GitHub
# OR
copilot plugin marketplace add /path/to/pr-review     # if installing from local
copilot plugin install pr-review@pr-review
```

## Authenticate

For GitHub PRs:
- Set `GITHUB_TOKEN` env var, OR run `gh auth login`. The CLI uses `gh auth token` as a fallback.

For Azure DevOps PRs:
- Set `AZURE_DEVOPS_PAT` env var to a Personal Access Token with **Code: read & write** scope.
- In ADO Pipelines, `SYSTEM_ACCESSTOKEN` is auto-used if available.

## Daily flow

From inside a `copilot` session in any repo:

```
/pr-review https://github.com/<org>/<repo>/pull/<n>
/pr-review https://dev.azure.com/<org>/<proj>/_git/<repo>/pullrequest/<id>
```

Add `--dry-run` to see findings without posting; `--publish` to post line comments back to the PR.

## What it does

1. Detects the provider from the URL (GitHub or ADO)
2. Gathers PR metadata, diff, linked work items, existing comments (cached for re-runs)
3. Picks reviewers: built-in (security, quality, architecture, performance, test-coverage, silent-failure, verifier) + auto-discovered from `.pr-review/reviewers/` + any plugins
4. Materializes per-reviewer prompts with the diff, metadata, existing comments to skip, and matching skills as context
5. Spawns parallel `copilot` subprocesses (one per reviewer, mixed Opus + GPT possible)
6. De-duplicates findings against existing comments
7. Posts line-snapped comments (with `--publish`) or prints a summary

## Add, remove, or override reviewers

Drop `.md` files in `.pr-review/skills/` (for reference content augmenting built-in reviewers) or `.pr-review/reviewers/` (for standalone review passes). The tool picks them up automatically. To remove a built-in, use `--skip <name>` per-invocation or `skip_reviewers:` in config. To override a built-in with your team's stricter version, place a file with the same name (e.g. `security.md`) in `.pr-review/reviewers/` and it wins.

Full lifecycle (list, add, remove, override) in the `adding-your-own-md` skill. The seven built-in reviewers and how to manage them are in [README.md](../../README.md#managing-reviewers).

## Common flags

| Flag | Meaning |
|---|---|
| `--dry-run` | Don't post comments |
| `--publish` | Post line comments back to the PR |
| `--skip <names>` | Skip reviewers by comma-separated name |
| `--no-cache` | Bypass the gather cache |
| `--no-response-cache` | Bypass the per-reviewer response cache |
| `--reviewer <file>` | Include a specific .md file as a reviewer |
| `--reviewers-dir <path>` | Include a directory of .md reviewers |
| `--skill <file>` | Include a specific .md file as a skill |
| `--skills-dir <path>` | Include a directory of .md skills |
| `--plugin-dir <path>` | Include a packaged plugin (has its own plugin.yaml) |
| `--no-autodiscover` | Disable scanning `.pr-review/` conventional paths |

## Configure once

```bash
pr-review configure ~/my-personal-reviewers   # one-line: sets primary path globally
# OR
pr-review configure                            # interactive prompts
```

Both write `~/.pr-review/config.yaml`. Repo-level config goes in `.pr-review.yaml` (committed).
