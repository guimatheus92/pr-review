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

Also accepted: legacy `https://<org>.visualstudio.com/[<collection>/][<proj>/]_git/<repo>/pullrequest/<id>`, GitHub Enterprise Server hosts, on-prem Azure DevOps Server (`https://<server>/<collection>/<proj>/_git/…`), and self-managed GitLab. Trailing paths/query strings are ignored. Self-hosted hosts must be mapped in the global config with `hosts: {<hostname>: github|azuredevops|gitlab}` — credentials only go to hosts you named, so a checkout-local `hosts:` map is ignored. GHES auth uses `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` or `gh auth login --hostname <host>` (github.com tokens are never sent to enterprise hosts).

Under Claude Code the plugin command is `/pr-review:pr-review <url>`; since the plugin no longer ships agents, current Claude Code should register the bare `/pr-review` alias as well (a personal command remains the fallback — see the README install section).

Posting line comments back to the PR is the default. Add `--dry-run` to preview findings without posting.

## What it does

1. Detects the provider from the URL (GitHub, Azure DevOps, or GitLab)
2. Gathers PR metadata, diff, linked work items, existing comments — metadata and comments fetched in parallel, cached for re-runs. On the first review on a machine, missing skill packs are cloned to `~/.pr-review/packs/` (needs git + network, ~1-2 min, one-time; failures warn rather than abort)
3. Detects canonical Linguist languages plus categorized dependency/ecosystem evidence from root and changed-file manifests. Passes are ranked by specific glob, dependency evidence, language-consistent weak glob, then tag (cap 6), plus every baseline; a generic language or manifest cannot prove an unrelated product
4. Prepares the run dir: `pr-context.md` (with a `## Stack` section and a pointer to the on-demand index) plus one `pass-<name>.md` per pass. When selection leaves shared project context, it is written whole to `skills-project.md`; otherwise a budgeted `skills-all.md` union provides fallback context to Codex, direct companion agents, and the verifier. In the no-pack fallback, up to ten project skills become passes and only overflow remains shared context. Overflow, unmatched, and index-mode pack skills are materialized in the run dir and listed in `skills-index.md`, so confined passes can read them on demand
5. Spawns one dispatch-only agent session. Reviewers write attempt-scoped exact JSON; Node validates/promotes outputs and, when needed, runs one automatic recovery for only missing/invalid reviewers
6. After complete Phase 1, Node conditionally runs a direct verifier for CRITICAL/HIGH findings and accounts for the optional parallel Codex sibling
7. Only complete delivery reaches dedupe and inline posting. Partial delivery exits 2 without posting; `--dry-run` prints the complete summary instead

The run also reports which skills it used: a progress brief at dispatch (`N pass(es) · M project rule(s) · K on-demand`, on stderr / `detached.log` and the live `status` feed) and a `## Skills` section in the final summary — a totals line (`**Passes:** N · **Project rules (in every pass):** M · **On-demand (index):** K`) plus a `| Pass | Matched by |` table and the project rules listed by name. Index (on-demand) skills are counted, not listed by name.

Exit codes: `0` pipeline completed with no finding at/above a configured threshold (without `--fail-on`, findings may still be retained), `1` findings at/above `--fail-on` survived dedupe, `2` incomplete delivery or another operational failure. `status` exit 21 means authenticated recovery is available; `--resume` retries only incomplete schema-v1 coverage; resuming a *complete* dry run without `--dry-run` posts what it previewed, while an incomplete one is refused. Legacy Phase 1 is dry-run diagnostic evidence only.

## Add or remove review content

Drop `.md` files in `.claude/skills`, `.claude/rules`, `.copilot/skills`, `.github/skills`, `.github/instructions`, or `.agents/skills`. `applies_to`, `applyTo`, and `paths` pin routing to file globs; unmatched rules go to the index. Standalone reviewer files are not loaded.

Most review knowledge comes from skill packs (git repos under `~/.pr-review/packs/`): `pr-review packs list` shows the configured packs, `pr-review packs sync` clones/pulls them all (run it now and then — >30 days without a sync warns on every review), `pr-review packs add <owner/repo|url>` installs another, and `pr-review packs suggest <tags…|pr-url>` searches the skills.sh directory for candidates (suggestion only — it never installs). Full lifecycle (list, add, remove) in the `adding-your-own-md` skill; skill packs and configuration in [README.md](../../../README.md).

## Common flags

| Flag | Meaning |
|---|---|
| `--dry-run` | Preview findings without posting (posting is the default) |
| `--publish` | Deprecated no-op — posting is already the default |
| `--context-only` | Prepare `pr-context.md` + the pass files and print the detected stack + passes table, without spawning the runtime (exits 2 if a code PR gets zero passes) |
| `--runtime <name>` | `copilot`\|`claude`\|`auto` — which agent CLI hosts the session (default `auto`) |
| `--no-codex` | Skip the Codex second-opinion reviewer |
| `--resume <run-id>` | Reuse authenticated complete output or make the final targeted attempt for incomplete schema-v1 coverage; drop `--dry-run` on a complete run to post what it previewed |
| `--lang <code>` | Language for finding titles/bodies (default `en`) |
| `--fail-on <severity>` | Exit 1 if findings at/above this severity survive dedupe (`critical`\|`high`\|`medium`\|`low`\|`nit`) |
| `--skip <names>` | Comma-separated pass names to skip — full (`awesome-copilot/go`) or bare suffix (`go`); also `verifier`, `codex` |
| `--no-cache` | Bypass the gather cache |
| `--skill <file>` | Include a specific .md file while preserving its `applyTo`/`paths` scope |
| `--force-skill <file>` | Include a specific .md file regardless of its declared scope |
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
