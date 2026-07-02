# pr-review

A generic, plugin-based PR review tool for GitHub and Azure DevOps, packaged as a [Copilot CLI plugin](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating). Orchestrates parallel reviewers (Opus + GPT) in a single Copilot session and posts line-snapped comments back to the PR.

```
/pr-review https://github.com/org/repo/pull/123
/pr-review https://dev.azure.com/org/proj/_git/repo/pullrequest/456 --publish
```

## Why a CLI, not just a skill

LLMs are unreliable at gathering metadata, deduplicating findings, and posting comments. A thin Node CLI handles those deterministic tasks; reviewer agents only do the actual reviewing. See [architecture](skills/architecture/SKILL.md) for the full execution model.

## Install

Inside a `copilot` session:

```
/plugin marketplace add guimatheus92/pr-review
/plugin install pr-review@pr-review
```

No `npm install` needed. The plugin ships a pre-bundled `dist/cli.cjs`; the slash command finds it under `~/.copilot/installed-plugins/` and runs it with `node`.

For local development:

```bash
git clone https://github.com/guimatheus92/pr-review && cd pr-review
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
/pr-review <pr-url>                    # review with auto-discovered skills
/pr-review <pr-url> --publish          # post line comments to the PR
/pr-review <pr-url> --skip security    # skip specific reviewers
/pr-review <pr-url> --dry-run          # preview without posting
```

## Adding your own rules

Drop `.md` files in standard skill paths — no flags, no config:

```
your-repo/
└── .pr-review/
    └── skills/
        ├── our-auth-conventions.md    # injected as context into matching reviewers
        └── team-style-guide.md
```

Existing skills from `.claude/skills/`, `.copilot/skills/`, `.github/skills/`, or `.agents/skills/` work as-is. See [reviewers vs skills](skills/reviewers-vs-skills/SKILL.md) for the full authoring guide.

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

## CLI reference

```bash
pr-review review <pr-url> [flags]            # full pipeline
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

All documentation lives as Copilot CLI skills under `skills/` — any agent can discover and use them via frontmatter.

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

MIT.
