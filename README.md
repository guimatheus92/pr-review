# pr-review

A generic, plugin-based PR review tool for GitHub, Azure DevOps, and GitLab, packaged as a plugin for [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating) **or** Claude Code. Orchestrates parallel review passes — each one a skill drawn from synced skill packs or your own repo — in a single agent session (companion plugins optional) and posts **every** finding back to the PR as a resolvable inline review comment — never a top-level comment, nothing dropped. When the `codex` CLI is installed, a Codex second-opinion reviewer runs alongside automatically.

```
/pr-review https://github.com/org/repo/pull/123
/pr-review https://dev.azure.com/org/proj/_git/repo/pullrequest/456 --dry-run
```

### Accepted URL shapes

```
https://github.com/<owner>/<repo>/pull/<number>
https://<ghes-host>/<owner>/<repo>/pull/<number>                                     # GitHub Enterprise Server
https://dev.azure.com/<org>[/<project>]/_git/<repo>/pullrequest/<id>
https://<org>.visualstudio.com/[<collection>/][<project>/]_git/<repo>/pullrequest/<id>   # legacy ADO
https://<server>/<collection>/<project>/_git/<repo>/pullrequest/<id>                 # Azure DevOps Server (best-effort)
https://gitlab.com/<group>[/<subgroup>]/<project>/-/merge_requests/<iid>
https://<gitlab-host>/<group>/<project>/-/merge_requests/<iid>                       # self-managed GitLab
```

Trailing paths, query strings, and fragments are ignored (`…/pull/42/files?diff=split` works). Self-hosted hosts must be mapped explicitly in config — a credential is only ever sent to a host you named (the unrecognized-URL error prints the exact yaml to add):

```yaml
# ~/.pr-review/config.yaml or .pr-review.yaml
hosts:
  github.mycorp.com: github
  tfs.corp.com: azuredevops
  git.mycorp.com: gitlab
```

## Why a CLI, not just a skill

LLMs are unreliable at gathering metadata, deduplicating findings, and posting comments. A thin Node CLI handles those deterministic tasks; review passes only do the actual reviewing. See [architecture](skills/help/reference/architecture.md) for the full execution model.

## Install

Inside a `copilot` session:

```
/plugin marketplace add guimatheus92/pr-review
/plugin install pr-review@pr-review
```

Or inside a `claude` (Claude Code) session:

```
/plugin marketplace add guimatheus92/pr-review
/plugin install pr-review@pr-review
```

No `npm install` needed. The plugin ships a pre-bundled `dist/cli.cjs`; the slash command finds it via `$CLAUDE_PLUGIN_ROOT` under Claude Code (falling back to `~/.copilot/installed-plugins/`) and runs it with `node`. The plugin layout (`commands/`, `skills/`) loads in both hosts; the manifest lives in two places on purpose — `.claude-plugin/plugin.json` (Claude Code's canonical location) and a root `plugin.json` (which Copilot CLI requires).

**Command name per host:** Copilot CLI exposes the command as `/pr-review`. Claude Code namespaces plugin commands as `/pr-review:pr-review`; since the plugin no longer ships agents, current Claude Code should also register the bare `/pr-review` alias. If your host doesn't, drop a personal command at `~/.claude/commands/pr-review.md` as a fallback (personal commands have no namespace, so `/pr-review` resolves):

```markdown
---
description: Bare alias for the pr-review plugin command.
argument-hint: "<pr-url> [flags]"
allowed-tools: ["Bash"]
---
Run the pr-review CLI in the background and poll it (you are plumbing, not the reviewer):
​```bash
CLI=$(find ~/.claude/plugins/cache -name cli.cjs -path '*/pr-review/*/dist/*' -not -path '*/node_modules/*' 2>/dev/null | sort | tail -1)
node "$CLI" review $ARGUMENTS --detach
​```
If the output has a `run-id:`, poll `node "$CLI" status <run-id>` (~25s apart) until it prints the summary; otherwise print the output verbatim.
```

For local development:

```bash
git clone https://github.com/guimatheus92/pr-review && cd pr-review
npm install && npm run build
# inside copilot (or claude — same slash commands; claude also accepts `claude plugin marketplace add ./` from the shell):
/plugin marketplace add .
/plugin install pr-review@pr-review
```

`npm run dogfood -- --base origin/main --include-untracked` refuses secret-bearing tracked and opted-in untracked content before writing run artifacts. For renames it validates both the old and new path; the generated `dist/cli.cjs` content is excluded only after both names pass that check.

## Authentication

| Provider | Env var | Fallback |
|---|---|---|
| GitHub | `GITHUB_TOKEN` / `GH_TOKEN` / `COPILOT_GITHUB_TOKEN` | `gh auth token` |
| GitHub Enterprise Server | `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` (github.com tokens are never sent to a GHES host) | `gh auth token --hostname <host>` |
| Azure DevOps | `AZURE_DEVOPS_PAT` / `SYSTEM_ACCESSTOKEN` / `AZURE_DEVOPS_EXT_PAT` (PAT), `AZURE_DEVOPS_BEARER` (bearer) | `az account get-access-token` |
| GitLab | `GITLAB_TOKEN` / `GITLAB_ACCESS_TOKEN` | `glab config get token -h <host>` |

`--detach` resolves the credential in the foreground and injects it into the background child's env, so the CLI/keyring fallbacks never have to run detached — a missing credential fails the launch immediately.

## Usage

```bash
/pr-review <pr-url>                    # review with auto-discovered skills; posts line comments (default)
/pr-review <pr-url> --dry-run          # preview findings without posting
/pr-review <pr-url> --skip owasp/logging   # skip passes (full pack/skill or bare name; also: verifier, codex)
/pr-review <pr-url> --context-only     # prepare context + the pass files, print stack + pass table, don't dispatch
/pr-review <pr-url> --lang pt-BR       # language for finding titles/bodies (default: en)
/pr-review <pr-url> --fail-on high     # exit 1 if any high/critical finding survives dedupe
/pr-review <pr-url> --runtime claude   # host the session in Claude Code instead of Copilot CLI
/pr-review <pr-url> --no-codex         # skip the Codex second-opinion reviewer
```

Exit codes: `0` clean, `1` findings at/above `--fail-on`, `2` pipeline error (including an orchestrator run that produced no parseable findings).

## Posting guarantees

On a publish run (the default), every finding lands as a resolvable **inline** review thread — so each one can be discussed and resolved in place:

- **Never top-level.** GitHub findings post as review comments (one batched review, per-comment retry on batch failure); ADO findings post as threads. There is no top-level issue-comment fallback.
- **Nothing dropped.** Lines outside the diff are snapped to the nearest valid diff line. Findings that can't anchor where they point (file outside the diff, or no location) are re-anchored to the first valid diff line, keeping the original `file:line` in the comment body.
- **Skipping only in `--dry-run`.** Transient posting errors are retried with backoff; anything that still fails is reported as an error in the summary, never silently dropped.

## Adding your own rules

Review rules live where your agent tools already keep skills — no separate folder, no duplication, no flags:

```
your-repo/
└── .claude/                           # or .copilot/, .github/, .agents/
    └── skills/
        ├── our-auth-conventions.md    # injected into every pass when relevant
        └── team-style-guide.md
```

Every matched repo skill is injected into **every review pass** as an authoritative project rule (`skills-project.md` — it overrides generic judgement), keeping its plain name (`our-auth-conventions`). Rules are discovered from `.claude/skills`, `.claude/rules`, `.copilot/skills`, `.github/skills`, `.github/instructions`, and `.agents/skills`; `applies_to`/`applyTo` and Claude's `paths` are equivalent scopes. A targeted skill matches exactly when an in-scope changed file matches; a skill without targeting goes through the `name` + `description` relevance heuristic against the changed file paths and the diff. **Every** match injects — there is no numeric cap — and skill bodies are inlined whole, never truncated. Skills that don't match land in `skills-index.md`, an on-demand **index** every pass can read when relevant. (With `skill_packs: []`, your skills run as the passes themselves — up to 10 as passes, with overflow still injected whole as context.)

Rule files added or modified by the PR under review are untrusted input: they are excluded before same-name dedupe from authoritative context and the on-demand index, and the summary names the skipped coverage. This includes in-repo files supplied through `--skill`; `--force-skill` is the explicit trust override. Linked rule sources that resolve outside the checkout fail closed. Unchanged rules from the checkout remain authoritative.

`inject_into` is **deprecated**: it is parsed only to print a warning, then ignored. Untargeted **home** skills stay skipped. `--skill <file>` includes one file while preserving its scope; use `--force-skill <file>` only when bypassing that scope is intentional. Whole directories configured through `extra_skills_dirs`, `--skills-dir`, or `PR_REVIEW_SKILLS_DIR` remain forced.

Preview the selection with `--context-only`, which prints a `## Stack` block (languages, dependencies) and a `## Passes` table (`| Pass | Matched by | Matched on | Source |`, plus the index count) and exits without dispatching. A live run reports the same in the final summary's `## Skills` section (`**Passes:** N · **Project rules (in every pass):** M · **On-demand (index):** K` + a pass table and the project rules by name). See [review passes vs skills](skills/help/reference/reviewers-vs-skills.md) for the full authoring guide.

## Review passes & skill packs

There are no built-in reviewer agents. Every review pass is **one skill applied by a generic agent** inside the single orchestrator session, and the skills come from **skill packs** — git repos cloned to `~/.pr-review/packs/<name>/`. Pass names are `<pack>/<skill>` (e.g. `awesome-copilot/go`, `owasp/nodejs-security`); repo skills keep their plain name.

Three packs are pre-configured:

| Pack | Source | Content | Baseline passes (run when nothing better matches) |
|---|---|---|---|
| `awesome-copilot` | `github/awesome-copilot` | `instructions/*.instructions.md`, `skills/*/SKILL.md` | `code-review-generic`, `security-and-owasp`, `performance-optimization`, `qa-engineering-best-practices`, `self-explanatory-code-commenting` |
| `owasp` | `OWASP/CheatSheetSeries` | `cheatsheets/*.md` | `error-handling`, `logging` |
| `anthropic-cybersecurity` | `mukul975/Anthropic-Cybersecurity-Skills` | defensive-review skills (operational/offensive ones excluded) | none — `mode: index`, on-demand only, never a pass |

Your own skills are CONTEXT, not lenses: every matched repo/explicit/forced skill is injected into EVERY pass as authoritative project rules. Pack passes are selected from evidence tiers: specific path glob, dependency/framework token, language-consistent type/manifest glob, then generic tag; at most six stack passes run, plus EVERY baseline pointer. A product guide cannot qualify merely because the PR touches its language or a generic manifest. Stack detection emits canonical Linguist names (aliases are lookup metadata), reads shallow root manifests plus manifests owning changed files, and separates language, ecosystem, dependency name, and dependency-token evidence. Legacy and canonical Azure DevOps remotes normalize to the same checkout identity. Docs-only PRs run only glob/forced passes; a code PR that matches zero passes exits with a `packs suggest` hint.

Installed plugins — from Copilot CLI or Claude Code alike — provide an additional generic capability source. The CLI reads their manifests, namespaces their skills as `<plugin>/<skill>`, and can select up to two review-oriented plugin passes from exact repository identity, plugin/path identity, or direct `appliesTo` evidence. It also inventories MCP server names from trusted repository config, user config, and plugin manifests in `capabilities.json`. Installed-plugin passes record which servers were available, attempted, and successfully used; repository MCP config is ignored when it changed in the PR, when the checkout is not the PR repository, or when a server would launch code from the reviewed checkout itself (an untouched `.mcp.json` pointing at a script the PR rewrote would otherwise execute branch-authored code); servers that launch external tooling still load. Declared skill paths and symlinks cannot escape an installed plugin's root.

Each dispatched pass and companion writes an independent `raw-<reviewer>.json` result. The orchestrator still produces the normal consolidated file, but if its turn ends after all tasks return, the CLI can recover from the complete set of sidecars. Missing or invalid sidecars remain an operational failure rather than being interpreted as a clean review.

Manage packs from the CLI:

```bash
pr-review packs list                      # on-disk state, skill counts, commit, freshness
pr-review packs sync                      # clone/pull every pack + refresh the Linguist cache
pr-review packs add <owner/repo|url>      # add a pack to the global config and clone it
pr-review packs suggest <tags...|pr-url>  # search skills.sh by stack tags — suggest-only, never installs
```

The first review on a machine clones any missing packs automatically (needs `git` and network; failures are warnings, not errors; expect ~1–2 minutes once). Packs more than 30 days out of sync trigger a warning on every review — run `packs sync`.

Configure packs with the `skill_packs:` yaml key. Unlike every other list key (which appends across config levels), `skill_packs` **replaces** the whole list: `skill_packs: []` disables packs entirely, and a list in a repo `.pr-review.yaml` overrides the global list. Entries are `owner/repo` shorthand or `{git, name?, ref?, include?, exclude?, mode?, baseline?}` (`mode: index` = on-demand only).

**Security note:** packs are third-party prompt content read by agents with tool access. Pin `ref:` for reproducibility, and know the only install paths are `packs add` and editing `skill_packs` — `packs suggest` never installs anything.

Skip any pass with `--skip <names>` (full `awesome-copilot/go` or bare `go`; also `verifier`, `codex`). The **verifier** remains a pipeline step: dispatched as a generic agent to reconcile across passes when phase 1 produces a CRITICAL/HIGH finding.

When the `codex` CLI is installed, an optional `codex` second-opinion reviewer also runs — as a sibling process in parallel with the agent session, reading the same PR context and the union of pass skills (`skills-all.md`). A different model family catches what the primary model misses. Its findings merge into the normal dedupe/post pipeline. Opt out with `--no-codex`, `invoke_codex: false`, `PR_REVIEW_NO_CODEX=1`, or `--skip codex`.

## CLI reference

```bash
pr-review review <pr-url> [flags]            # full pipeline
#   --context-only          prepare pr-context.md + the pass files,
#                           print the stack + pass table, exit
#   --skip <names>          comma-separated pass names to skip (full pack/skill
#                           or bare skill name; also: verifier, codex)
#   --lang <code>           output language for findings (yaml: language, env: PR_REVIEW_LANG)
#   --fail-on <severity>    critical|high|medium|low|nit → exit 1 on surviving findings
#   --runtime <name>        copilot|claude|auto — which agent CLI hosts the session
#                           (yaml: runtime, env: PR_REVIEW_RUNTIME; default auto)
#   --no-codex              skip the Codex second-opinion reviewer
#   --skill <file...>       include files while respecting applyTo/paths
#   --force-skill <file...> include files regardless of applyTo/paths
#   --copilot <path>        path to the copilot binary (implies --runtime copilot unless --runtime given)
#   --from-gather <path>    (eval harness) read the gather JSON from a file
#                           instead of the provider APIs; requires --dry-run
pr-review gather <pr-url> [--out <path>]     # fetch + cache metadata only
pr-review post <pr-url> --findings <path>    # post pre-computed findings
pr-review packs list|sync|add <source>|suggest <tags...|pr-url>   # manage skill packs
pr-review init [--with-config] [--force]     # scaffold a starter team-rules skill + optional .pr-review.yaml
pr-review configure [path] [--force]         # write ~/.pr-review/config.yaml
pr-review doctor                             # environment preflight: runtimes, codex, companions, auth, skill packs
pr-review plugins list                       # list repo skills + pack skill counts
pr-review plugins doctor                     # check companion plugin status
pr-review config show                        # print merged config + sources
pr-review cache info | clear                 # manage local cache
```

Without `--fail-on`, retained findings do not change the process status: exit 0 means the pipeline completed, not that the finding count is zero. Configure `--fail-on` when the exit code must gate CI.

### Dogfood a local branch

Maintainers can review the current branch without opening a remote PR:

```bash
npm run build
npm run dogfood -- --base origin/main --include-untracked  # include new, non-ignored files
```

The command supports `github.com` origins, derives the current fork identity from `origin`, and gathers committed, staged, and unstaged changes. Untracked files require `--include-untracked`; even with opt-in, secret-bearing names and high-confidence credential content are refused before any gather or prompt artifact is written. Tracked diff hunks, including persisted context lines, are checked for high-confidence credentials too. Artifacts live only under `~/.pr-review/runs/`, and the CLI always receives `--dry-run`. It refuses a missing/stale bundle, so run `npm run build` first. Add `--context-only` while tuning routing. Companion plugins are disabled because URL-based companion commands cannot consume a synthetic local PR safely; exercise them against a real PR dry-run. Generated and binary artifacts remain recorded but are excluded from LLM context with an explicit reason.

## Further reading

All documentation lives under the single `help` skill (`skills/help/`), loaded by Copilot CLI and Claude Code alike — one `/pr-review:help` palette entry whose `SKILL.md` indexes the per-topic reference files. Ask any pr-review question and the `help` skill surfaces the right one.

| Topic | Doc |
|---|---|
| Architecture & source map | [skills/help/reference/architecture.md](skills/help/reference/architecture.md) |
| Configuration (5-level merge, YAML, env vars) | [skills/help/reference/configuration.md](skills/help/reference/configuration.md) |
| Review passes vs skills (authoring, routing) | [skills/help/reference/reviewers-vs-skills.md](skills/help/reference/reviewers-vs-skills.md) |
| Adding your own skills & packs | [skills/help/reference/adding-your-own-md.md](skills/help/reference/adding-your-own-md.md) |
| Companion plugins (pr-review-toolkit, code-review) | [skills/help/reference/companion-plugins.md](skills/help/reference/companion-plugins.md) |
| CI/CD (GitHub Actions, ADO Pipelines) | [skills/help/reference/ci-integration.md](skills/help/reference/ci-integration.md) |
| Caching | [skills/help/reference/caching.md](skills/help/reference/caching.md) |
| Performance optimizations | [skills/help/reference/performance.md](skills/help/reference/performance.md) |
| Quickstart | [skills/help/reference/pr-review-usage.md](skills/help/reference/pr-review-usage.md) |
| Contributing & plugin authoring | [CONTRIBUTING.md](CONTRIBUTING.md) |

## License

MIT — see [LICENSE](LICENSE).
