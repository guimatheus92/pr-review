---
description: "pr-review configuration: 5-level config merge, YAML examples, environment variables, auto-discovery paths. Use when asked how to configure pr-review, change defaults, set models, add extra skill/reviewer paths, or understand config precedence."
---

# Configuration

## Precedence (highest wins)

1. **CLI flags** — per-invocation overrides
2. **`<repo>/.pr-review.yaml`** — per-repo, committed (team shares)
3. **`~/.pr-review/config.yaml`** — global / personal defaults
4. **Environment variables** — `PR_REVIEW_DEFAULT_MODEL`, etc.
5. **Built-in defaults**

Use `pr-review config show` to see the effective merged config and where each setting came from.

## Setup commands

```bash
pr-review configure ~/my-reviews    # quick: sets primary path in ~/.pr-review/config.yaml
pr-review configure                 # interactive: prompts for model, paths, etc.
pr-review init                      # scaffold .pr-review/skills/ in current repo
pr-review init --with-config        # also writes .pr-review.yaml
```

## Global config (`~/.pr-review/config.yaml`)

```yaml
default_model: claude-opus-4.8
extra_skills_dirs:
  - ~/work/team-conventions
extra_reviewers_dirs:
  - ~/work/my-personal-reviewers
skip_reviewers: [verifier]
invoke_companions: true
companion_warn: true
dedupe_mode: strict              # strict | loose | off
```

## Repo config (`<repo>/.pr-review.yaml`)

```yaml
default_model: claude-opus-4.8
extra_skills_dirs:
  - ./docs/conventions
extra_skills:
  - ./ARCHITECTURE.md
skip_reviewers:
  - test-coverage
diff_excludes:
  - "**/generated/**"
  - "**/*.designer.cs"
```

## Environment variables

| Variable | Maps to |
|---|---|
| `PR_REVIEW_DEFAULT_MODEL` | `default_model` |
| `PR_REVIEW_NO_COMPANION_WARN` | `companion_warn: false` |
| `GITHUB_TOKEN` / `GH_TOKEN` / `COPILOT_GITHUB_TOKEN` | GitHub auth |
| `AZURE_DEVOPS_PAT` / `SYSTEM_ACCESSTOKEN` | ADO auth |

## Auto-discovery paths

Skills are auto-discovered from standard locations — no config needed:

| Path | Scope |
|---|---|
| `<repo>/.pr-review/skills/*.md` | Per-repo |
| `<repo>/.claude/skills/*.md` | Claude Code convention |
| `<repo>/.copilot/skills/*.md` | Copilot CLI convention |
| `<repo>/.github/skills/*.md` | GitHub convention |
| `<repo>/.agents/skills/*.md` | AGENTS.md convention |
| `~/.pr-review/skills/`, `~/.claude/skills/`, `~/.copilot/skills/`, `~/.agents/skills/` | Personal |

Existing skills from Claude Code or Copilot CLI work as-is — no copying needed.
