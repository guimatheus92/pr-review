---
description: "pr-review quickstart: install, authenticate, daily usage, common flags. Use when asked how to review a PR, how to install pr-review, what the slash command does, or for a getting-started walkthrough."
---

# Using pr-review

## Install (once)

Copilot CLI:

```bash
copilot plugin marketplace add gmatheus/pr-review     # if installing from GitHub
# OR
copilot plugin marketplace add /path/to/pr-review     # if installing from local
copilot plugin install pr-review@pr-review
```

Claude Code (slash commands inside a `claude` session):

```
/plugin marketplace add gmatheus/pr-review
/plugin install pr-review@pr-review
```

## Authenticate

For GitHub PRs:
- Set `GITHUB_TOKEN` env var, OR run `gh auth login`. The CLI uses `gh auth token` as a fallback.

For Azure DevOps PRs:
- Set `AZURE_DEVOPS_PAT` env var to a Personal Access Token with **Code: read & write** scope.
- In ADO Pipelines, `SYSTEM_ACCESSTOKEN` is auto-used if available.

## Daily flow

From inside a `copilot` or `claude` session in any repo:

```
/pr-review https://github.com/<org>/<repo>/pull/<n>
/pr-review https://dev.azure.com/<org>/<proj>/_git/<repo>/pullrequest/<id>
```

Posting line comments back to the PR is the default. Add `--dry-run` to preview findings without posting.

## What it does

1. Detects the provider from the URL (GitHub or ADO)
2. Gathers PR metadata, diff, linked work items, existing comments — metadata and comments fetched in parallel, cached for re-runs
3. Triages deterministically: docs-only PRs (all in-scope files are docs) dispatch only the `quality` reviewer; skipped reviewers are logged
4. Prepares the run dir: `pr-context.md` plus one `skills-<reviewer>.md` per reviewer containing the skills routed to it (`inject_into` + `applies_to` matching)
5. Spawns one agent session (Copilot CLI or Claude Code, per `--runtime`; default `auto` picks whichever is on PATH, copilot first) that dispatches all reviewers in parallel via `task()` / `Task()`; the verifier is dispatched only if Phase 1 produced a CRITICAL/HIGH finding. If the `codex` CLI is installed, a Codex second-opinion reviewer runs in parallel as a sibling process (opt out with `--no-codex`)
6. De-duplicates findings against existing comments
7. Posts line-snapped comments (default; GitHub inline comments go as one batched review) — or just prints the summary with `--dry-run`

Exit codes: `0` clean, `1` findings at/above the `--fail-on` threshold survived dedupe, `2` pipeline error (the orchestrator produced no parseable findings).

## Add or remove review content

Drop `.md` files in `.pr-review/skills/` (reference content injected into the built-in reviewers). The tool picks them up automatically. Standalone reviewer files in `.pr-review/reviewers/` are **not** loaded by the single-session review path — author skills instead. To remove a built-in reviewer, use `--skip <name>` per-invocation or `skip_reviewers:` in config. To test where a skill routes, run with `--context-only`.

Full lifecycle (list, add, remove) in the `adding-your-own-md` skill. The seven built-in reviewers and how to manage them are in [README.md](../../README.md#managing-reviewers).

## Common flags

| Flag | Meaning |
|---|---|
| `--dry-run` | Preview findings without posting (posting is the default) |
| `--publish` | Deprecated no-op — posting is already the default |
| `--context-only` | Prepare `pr-context.md` + skills files and print the skill→reviewer routing table, without spawning the runtime |
| `--runtime <name>` | `copilot`\|`claude`\|`auto` — which agent CLI hosts the session (default `auto`) |
| `--no-codex` | Skip the Codex second-opinion reviewer |
| `--lang <code>` | Language for finding titles/bodies (default `en`) |
| `--fail-on <severity>` | Exit 1 if findings at/above this severity survive dedupe (`critical`\|`high`\|`medium`\|`low`\|`nit`) |
| `--skip <names>` | Skip reviewers by comma-separated name |
| `--no-cache` | Bypass the gather cache |
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
