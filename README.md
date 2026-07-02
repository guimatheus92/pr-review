# pr-review

A generic, plugin-based PR review tool for GitHub and Azure DevOps, packaged as a plugin for [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating) **or** Claude Code. Orchestrates parallel reviewer agents in a single agent session (companion plugins optional) and posts line-snapped comments back to the PR. When the `codex` CLI is installed, a Codex second-opinion reviewer runs alongside automatically.

```
/pr-review https://github.com/org/repo/pull/123
/pr-review https://dev.azure.com/org/proj/_git/repo/pullrequest/456 --dry-run
```

## Why a CLI, not just a skill

LLMs are unreliable at gathering metadata, deduplicating findings, and posting comments. A thin Node CLI handles those deterministic tasks; reviewer agents only do the actual reviewing. See [architecture](skills/architecture/SKILL.md) for the full execution model.

## Install

Inside a `copilot` session:

```
/plugin marketplace add gmatheus_microsoft/pr-review
/plugin install pr-review@pr-review
```

Or inside a `claude` (Claude Code) session:

```
/plugin marketplace add gmatheus_microsoft/pr-review
/plugin install pr-review@pr-review
```

No `npm install` needed. The plugin ships a pre-bundled `dist/cli.cjs`; the slash command finds it via `$CLAUDE_PLUGIN_ROOT` under Claude Code (falling back to `~/.copilot/installed-plugins/`) and runs it with `node`. The plugin layout (`commands/`, `agents/`, `skills/` + `plugin.json`) loads in both hosts.

For local development:

```bash
git clone https://github.com/gmatheus_microsoft/pr-review && cd pr-review
npm install && npm run build
# inside copilot:
/plugin marketplace add .
/plugin install pr-review@pr-review
```

## Authentication

| Provider | Env var | Fallback |
|---|---|---|
| GitHub | `GITHUB_TOKEN` / `GH_TOKEN` / `COPILOT_GITHUB_TOKEN` | `gh auth token` |
| Azure DevOps | `AZURE_DEVOPS_PAT` / `SYSTEM_ACCESSTOKEN` | none |

## Usage

```bash
/pr-review <pr-url>                    # review with auto-discovered skills; posts line comments (default)
/pr-review <pr-url> --dry-run          # preview findings without posting
/pr-review <pr-url> --skip security    # skip specific reviewers
/pr-review <pr-url> --context-only     # prepare context + skill routing table, don't run reviewers
/pr-review <pr-url> --lang pt-BR       # language for finding titles/bodies (default: en)
/pr-review <pr-url> --fail-on high     # exit 1 if any high/critical finding survives dedupe
/pr-review <pr-url> --runtime claude   # host the session in Claude Code instead of Copilot CLI
/pr-review <pr-url> --no-codex         # skip the Codex second-opinion reviewer
```

Exit codes: `0` clean, `1` findings at/above `--fail-on`, `2` pipeline error (including an orchestrator run that produced no parseable findings).

## Adding your own rules

Drop `.md` files in standard skill paths — no flags, no config:

```
your-repo/
└── .pr-review/
    └── skills/
        ├── our-auth-conventions.md    # injected as context into matching reviewers
        └── team-style-guide.md
```

Optional frontmatter targets a skill: `applies_to` (globs — the skill is injected only when an in-scope changed file matches) and `inject_into` (reviewer names — omit to reach all reviewers). Preview the routing with `--context-only`, which prints a skill→reviewer table and exits without running reviewers.

Skills from the shared dirs (`.claude/skills/`, `.copilot/skills/`, `.github/skills/`, `.agents/skills/`) are also picked up, but only when they declare review targeting (`applies_to` and/or `inject_into`) — those dirs hold general-purpose agent skills too, and untargeted ones would flood every reviewer's context. Anything in `.pr-review/skills/` is included unconditionally. See [reviewers vs skills](skills/reviewers-vs-skills/SKILL.md) for the full authoring guide.

## Built-in reviewers

| Agent | Focus |
|---|---|
| `security` | Credential leaks, injection, auth gaps, input validation |
| `quality` | Naming, dead code, complexity, DRY |
| `architecture` | Layering, coupling, abstraction leaks |
| `performance` | Hot-path issues, memory leaks, scale-with-data |
| `test-coverage` | Missing/inadequate tests, mock divergence |
| `silent-failure` | Swallowed errors, masked failures |
| `verifier` | Cross-reviewer reconciliation (runs last) |

Skip with `--skip <name>`, override by placing a same-named `.md` in `.pr-review/skills/`.

When the `codex` CLI is installed, an optional `codex` second-opinion reviewer also runs — as a sibling process in parallel with the agent session, reading the same PR context. A different model family catches what the primary model misses. Its findings merge into the normal dedupe/post pipeline. Opt out with `--no-codex`, `invoke_codex: false`, `PR_REVIEW_NO_CODEX=1`, or `--skip codex`.

## CLI reference

```bash
pr-review review <pr-url> [flags]            # full pipeline
#   --context-only          prepare pr-context.md + per-reviewer skills files,
#                           print the skill→reviewer routing table, exit
#   --lang <code>           output language for findings (yaml: language, env: PR_REVIEW_LANG)
#   --fail-on <severity>    critical|high|medium|low|nit → exit 1 on surviving findings
#   --runtime <name>        copilot|claude|auto — which agent CLI hosts the session
#                           (yaml: runtime, env: PR_REVIEW_RUNTIME; default auto)
#   --no-codex              skip the Codex second-opinion reviewer
#   --copilot <path>        path to the runtime CLI binary (kept for back-compat)
pr-review gather <pr-url> [--out <path>]     # fetch + cache metadata only
pr-review post <pr-url> --findings <path>    # post pre-computed findings
pr-review init [--with-config] [--force]     # scaffold .pr-review/skills/
pr-review configure [path] [--force]         # write ~/.pr-review/config.yaml
pr-review plugins list                       # list loaded reviewers + skills
pr-review plugins doctor                     # check companion plugin status
pr-review config show                        # print merged config + sources
pr-review cache info | clear                 # manage local cache
```

## Further reading

All documentation lives as agent skills under `skills/` (loaded by Copilot CLI and Claude Code alike) — any agent can discover and use them via frontmatter.

| Topic | Skill |
|---|---|
| Architecture & source map | [skills/architecture/SKILL.md](skills/architecture/SKILL.md) |
| Configuration (5-level merge, YAML, env vars) | [skills/configuration/SKILL.md](skills/configuration/SKILL.md) |
| Reviewers vs skills (authoring, overrides) | [skills/reviewers-vs-skills/SKILL.md](skills/reviewers-vs-skills/SKILL.md) |
| Managing reviewers (add, remove, override) | [skills/adding-your-own-md/SKILL.md](skills/adding-your-own-md/SKILL.md) |
| Companion plugins (pr-review-toolkit, code-review) | [skills/companion-plugins/SKILL.md](skills/companion-plugins/SKILL.md) |
| CI/CD (GitHub Actions, ADO Pipelines) | [skills/ci-integration/SKILL.md](skills/ci-integration/SKILL.md) |
| Caching | [skills/caching/SKILL.md](skills/caching/SKILL.md) |
| Performance optimizations | [skills/performance/SKILL.md](skills/performance/SKILL.md) |
| Quickstart | [skills/pr-review-usage/SKILL.md](skills/pr-review-usage/SKILL.md) |
| Contributing & plugin authoring | [CONTRIBUTING.md](CONTRIBUTING.md) |

## License

MIT — see [LICENSE](LICENSE).
