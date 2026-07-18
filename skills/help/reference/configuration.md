---
description: "pr-review configuration: 5-level config merge, YAML examples, environment variables, auto-discovery paths. Use when asked how to configure pr-review, change defaults, set models, add extra skill/reviewer paths, or understand config precedence."
---

# Configuration

## Precedence (highest wins)

1. **CLI flags** — per-invocation overrides
2. **Environment variables** — `PR_REVIEW_DEFAULT_MODEL`, `PR_REVIEW_LANG`, etc.
3. **`<repo>/.pr-review.yaml`** — per-repo, committed (team shares)
4. **`~/.pr-review/config.yaml`** — global / personal defaults
5. **Built-in defaults**

Note: env vars override YAML config (this changed — previously env was the weakest layer above defaults).

Use `pr-review config show` to see the effective merged config and where each setting came from.

## Setup commands

```bash
pr-review configure ~/my-reviews    # quick: sets primary path in ~/.pr-review/config.yaml
pr-review configure                 # interactive: prompts for model, paths, etc.
pr-review init                      # scaffold a starter team-rules skill in current repo
pr-review init --with-config        # also writes .pr-review.yaml
```

## Global config (`~/.pr-review/config.yaml`)

```yaml
runtime: auto                    # copilot | claude | auto — which agent CLI hosts the session
default_model: claude-opus-4.8
language: en                     # finding titles/bodies language (default en)
extra_skills_dirs:
  - ~/work/team-conventions
skip_reviewers: [verifier]
invoke_companions: true
invoke_codex: true               # Codex second-opinion reviewer (auto-skipped if codex not installed)
companion_warn: true
dedupe_mode: strict              # strict | loose | off
```

Runtime `auto` (the default) probes PATH: copilot first, then claude; it errors if neither is found. Model note: the copilot-style default `claude-opus-4.8` is mapped to `opus` for the claude runtime; models you set explicitly pass through as-is.

## Repo config (`<repo>/.pr-review.yaml`)

```yaml
default_model: claude-opus-4.8
language: pt-BR
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
| `PR_REVIEW_RUNTIME` | `runtime` (also `--runtime <copilot\|claude\|auto>`; default `auto`) |
| `PR_REVIEW_DEFAULT_MODEL` | `default_model` |
| `PR_REVIEW_LANG` | `language` (also settable via `--lang <code>`; default `en`) |
| `PR_REVIEW_SKILLS_DIR` | extra skills dir, injected unconditionally (also `--skills-dir`, yaml `extra_skills_dirs`) |
| `PR_REVIEW_NO_COMPANION_WARN` | `companion_warn: false` |
| `PR_REVIEW_NO_CODEX` | `invoke_codex: false` (also `--no-codex`) |
| `GITHUB_TOKEN` / `GH_TOKEN` / `COPILOT_GITHUB_TOKEN` | GitHub auth |
| `AZURE_DEVOPS_PAT` / `SYSTEM_ACCESSTOKEN` | ADO auth |

## Auto-discovery paths

Skills are auto-discovered from standard locations — no config needed:

| Path | Scope |
|---|---|
| `<repo>/.claude/skills/*.md` | Claude Code convention |
| `<repo>/.copilot/skills/*.md` | Copilot CLI convention |
| `<repo>/.github/skills/*.md` | GitHub convention |
| `<repo>/.agents/skills/*.md` | AGENTS.md convention |
| `~/.claude/skills/`, `~/.copilot/skills/`, `~/.agents/skills/` | Personal |

Existing skills from Claude Code or Copilot CLI work as-is — no copying needed. Per PR, repo skills relevant to the changed files are injected and the rest are catalogued (on-demand). To force every skill in a directory injected unconditionally, point `extra_skills_dirs` (or `--skills-dir` / `PR_REVIEW_SKILLS_DIR`) at it — e.g. `extra_skills_dirs: [.claude/skills]`. Untargeted skills in a home dir are skipped unless pulled in this way.
