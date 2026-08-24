---
description: "pr-review quickstart: install, authenticate, daily usage, common flags. Use when asked how to review a PR, how to install pr-review, what the slash command does, or for a getting-started walkthrough."
---

# Using pr-review

## Install (once)

Copilot CLI:

```bash
copilot plugin marketplace add guimatheus92/pr-review     # if installing from GitHub
# OR
copilot plugin marketplace add /path/to/pr-review     # if installing from local
copilot plugin install pr-review@pr-review
```

Claude Code (slash commands inside a `claude` session):

```
/plugin marketplace add guimatheus92/pr-review
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
/pr-review https://dev.azure.com/<org>[/<proj>]/_git/<repo>/pullrequest/<id>
/pr-review https://gitlab.com/<group>/<project>/-/merge_requests/<iid>
```

Also accepted: legacy `https://<org>.visualstudio.com/[<collection>/][<proj>/]_git/<repo>/pullrequest/<id>`, GitHub Enterprise Server hosts, on-prem Azure DevOps Server (`https://<server>/<collection>/<proj>/_git/…`), and self-managed GitLab. Trailing paths/query strings are ignored. Self-hosted hosts must be mapped in config with `hosts: {<hostname>: github|azuredevops|gitlab}` — credentials only go to hosts you named. GHES auth uses `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` or `gh auth login --hostname <host>` (github.com tokens are never sent to enterprise hosts).

Under Claude Code the plugin command is `/pr-review:pr-review <url>`; since the plugin no longer ships agents, current Claude Code should register the bare `/pr-review` alias as well (a personal command remains the fallback — see the README install section).

Posting line comments back to the PR is the default. Add `--dry-run` to preview findings without posting.

## What it does

1. Detects the provider from the URL (GitHub, Azure DevOps, or GitLab)
2. Gathers PR metadata, diff, linked work items, existing comments — metadata and comments fetched in parallel, cached for re-runs. On the first review on a machine, missing skill packs are cloned to `~/.pr-review/packs/` (needs git + network, ~1-2 min, one-time; failures warn rather than abort)
3. Detects the stack (Linguist language tags per changed file + dependency/ecosystem tags from manifests) and selects review passes: each pass is ONE skill — from a skill pack (named `<pack>/<skill>`, e.g. `awesome-copilot/go`) or from the repo — your own matched skills inject into every pass as authoritative context, and the passes are pack glob/tag hits (cap 6; extension-only pack globs count only for stack-consistent skills) plus every baseline. Docs-only PRs run only glob/forced passes
4. Prepares the run dir: `pr-context.md` (with a `## Stack` section and a pointer to the on-demand index) plus one `pass-<name>.md` per pass, `skills-all.md`, and `skills-index.md` — overflow, unmatched, and index-mode pack skills go to the index, where passes can read them on demand
5. Spawns one agent session (Copilot CLI or Claude Code, per `--runtime`; default `auto` picks whichever is on PATH, copilot first) that dispatches all passes in parallel as generic agents via `task()` / `Task()`; the verifier is dispatched only if Phase 1 produced a CRITICAL/HIGH finding. If the `codex` CLI is installed, a Codex second-opinion reviewer runs in parallel as a sibling process (opt out with `--no-codex`)
6. De-duplicates findings against existing comments
7. Posts **every** finding as a resolvable inline review comment (default) — lines are snapped to the diff, GitHub comments go as one batched review, and findings that can't anchor where they point are re-anchored to the first valid diff line with the original `file:line` in the body. Never a top-level comment, nothing dropped. `--dry-run` prints the summary instead

The run also reports which skills it used: a progress brief at dispatch (`N pass(es) · K on-demand`, on stderr / `detached.log` and the live `status` feed) and a `## Skills` section in the final summary — a totals line (`**Passes:** N · **On-demand (index):** K`) plus a `| Pass | Matched by |` table. Index (on-demand) skills are counted, not listed by name.

Exit codes: `0` clean (a docs-only PR with zero passes also exits 0, with an explanatory summary), `1` findings at/above the `--fail-on` threshold survived dedupe, `2` pipeline error (no parseable findings, or no skills matched a code PR — run `pr-review packs suggest <url>`).

## Add or remove review content

Drop `.md` files in a standard tool skill dir (`.claude/skills/`, `.copilot/skills/`, `.github/skills/`, `.agents/skills/`). The tool picks them up automatically; each skill that matches the PR becomes its own review pass (the rest land in the on-demand `skills-index.md`, which passes can read when relevant). `applies_to` frontmatter pins the routing to file globs; `inject_into` is deprecated — it only prints a warning and is ignored. Standalone reviewer files are **not** loaded by the single-session review path — author skills instead. To skip a pass, use `--skip <names>` per-invocation or `skip_reviewers:` in config, with pass names — full (`awesome-copilot/go`) or bare suffix (`go`); `verifier` and `codex` are also accepted. To see which passes a PR would get, run with `--context-only`.

Most review knowledge comes from skill packs (git repos under `~/.pr-review/packs/`): `pr-review packs list` shows the configured packs, `pr-review packs sync` clones/pulls them all (run it now and then — >30 days without a sync warns on every review), `pr-review packs add <owner/repo|url>` installs another, and `pr-review packs suggest <tags…|pr-url>` searches the skills.sh directory for candidates (suggestion only — it never installs). Full lifecycle (list, add, remove) in the `adding-your-own-md` skill; skill packs and configuration in [README.md](../../README.md).

## Common flags

| Flag | Meaning |
|---|---|
| `--dry-run` | Preview findings without posting (posting is the default) |
| `--publish` | Deprecated no-op — posting is already the default |
| `--context-only` | Prepare `pr-context.md` + the pass files and print the detected stack + passes table, without spawning the runtime (exits 2 if a code PR gets zero passes) |
| `--runtime <name>` | `copilot`\|`claude`\|`auto` — which agent CLI hosts the session (default `auto`) |
| `--no-codex` | Skip the Codex second-opinion reviewer |
| `--lang <code>` | Language for finding titles/bodies (default `en`) |
| `--fail-on <severity>` | Exit 1 if findings at/above this severity survive dedupe (`critical`\|`high`\|`medium`\|`low`\|`nit`) |
| `--skip <names>` | Comma-separated pass names to skip — full (`awesome-copilot/go`) or bare suffix (`go`); also `verifier`, `codex` |
| `--no-cache` | Bypass the gather cache |
| `--skill <file>` | Include a specific .md file as a skill |
| `--skills-dir <path>` | Include a directory of .md skills |
| `--plugin-dir <path>` | Include a packaged plugin (has its own plugin.yaml) |
| `--no-autodiscover` | Disable scanning the standard skill dirs (`.claude/.copilot/.github/.agents` under `skills/`, repo + home) |

## Configure once

```bash
pr-review configure ~/my-review-skills   # one-line: appends to extra_skills_dirs globally (each skill there runs as a forced pass)
# OR
pr-review configure                      # interactive prompts
```

Both write `~/.pr-review/config.yaml`. Repo-level config goes in `.pr-review.yaml` (committed).

## Diagnose the environment

```bash
pr-review doctor   # runtimes on PATH, resolved runtime/model, skill packs (git, per-pack state, Linguist cache), codex + companions, GitHub/ADO auth, config sources
```

Run it first when a review fails to start — it answers "which runtime would be used and what's missing" without spawning anything.
