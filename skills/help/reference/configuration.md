---
description: "pr-review configuration: 5-level config merge, YAML examples, environment variables, skill packs, auto-discovery paths. Use when asked how to configure pr-review, change defaults, set models, manage skill packs, add extra skill paths, or understand config precedence."
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
pr-review configure ~/my-skills     # quick: appends to extra_skills_dirs in ~/.pr-review/config.yaml (selected like a repo skill dir)
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
skip_reviewers: [verifier]       # pass names (full `pack/skill` or bare suffix), plus `verifier` / `codex`
invoke_companions: true
invoke_codex: true               # Codex second-opinion reviewer (auto-skipped if codex not installed)
companion_warn: true
dedupe:
  mode: strict                   # strict | loose | off
hosts:                           # self-hosted hostname → provider (github | azuredevops | gitlab)
  github.mycorp.com: github
  tfs.corp.com: azuredevops
```

Runtime `auto` (the default) probes PATH: copilot first, then claude; it errors if neither is found. Model note: the copilot-style default `claude-opus-4.8` is mapped to `opus` for the claude runtime; models you set explicitly pass through as-is.

## Skill packs (`skill_packs`)

Review passes come from skill packs — git repos cloned to `~/.pr-review/packs/<name>/`. Three packs are pre-configured (`awesome-copilot`, `owasp`, and the index-only `anthropic-cybersecurity`); override with `skill_packs:` in either YAML file:

```yaml
skill_packs:                        # REPLACES the whole list — this key does NOT merge
  - github/awesome-copilot          # 'owner/repo' shorthand
  - git: OWASP/CheatSheetSeries     # full entry form
    name: owasp
    ref: v2.0.0                     # pin for reproducibility (packs are third-party prompt content)
    include: ["cheatsheets/*.md"]
    exclude: []
    mode: auto                      # auto | index — index packs are on-demand only, never a pass
    baseline: [error-handling, logging]
```

Unlike every other list key (which pushes onto the merged list), `skill_packs` **replaces**: `skill_packs: []` disables packs entirely, and a repo `.pr-review.yaml` list overrides the global list completely. `pr-review packs add <owner/repo|url>` materializes the defaults into `~/.pr-review/config.yaml` first, then appends.

## Repo config (`<repo>/.pr-review.yaml`)

```yaml
default_model: claude-opus-4.8
language: pt-BR
extra_skills_dirs:
  - ./docs/conventions
extra_skills:
  - ./ARCHITECTURE.md
skip_reviewers:
  - awesome-copilot/go     # full pass name…
  - logging                # …or bare skill suffix
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
| `PR_REVIEW_SKILLS_DIR` | extra skills dir, selected like repo skill dirs (also `--skills-dir`, yaml `extra_skills_dirs`); `--force-skill <dir>` is the per-run bypass, CLI only |
| `PR_REVIEW_NO_COMPANION_WARN` | `companion_warn: false` |
| `PR_REVIEW_NO_CODEX` | `invoke_codex: false` (also `--no-codex`) |
| `GITHUB_TOKEN` / `GH_TOKEN` / `COPILOT_GITHUB_TOKEN` | GitHub auth |
| `AZURE_DEVOPS_PAT` / `SYSTEM_ACCESSTOKEN` / `AZURE_DEVOPS_EXT_PAT` | ADO auth (PAT) |
| `AZURE_DEVOPS_BEARER` | ADO auth (bearer token; also set by the `--detach` pre-flight) |

## Auto-discovery and on-disk paths

Repo skills are auto-discovered from standard locations — no config needed — and packs/caches live under `~/.pr-review/`:

| Path | Scope |
|---|---|
| `<repo>/.claude/skills/*.md` | Claude Code convention |
| `<repo>/.claude/rules/*.md` | Claude Code rules (`paths` frontmatter) |
| `<repo>/.copilot/skills/*.md` | Copilot CLI convention |
| `<repo>/.github/skills/*.md` | GitHub convention |
| `<repo>/.github/instructions/*.md` | GitHub instructions (`applyTo` frontmatter) |
| `<repo>/.agents/skills/*.md` | AGENTS.md convention |
| `~/.claude/skills/`, `~/.copilot/skills/`, `~/.agents/skills/` | Personal |
| `~/.pr-review/packs/<name>/` | Skill pack clones (managed by `pr-review packs sync`) |
| `~/.pr-review/cache/linguist-languages.yml` | GitHub Linguist cache for stack detection (auto-downloaded; refreshed on `packs sync`) |

Existing skills from Claude Code or Copilot CLI work as-is — no copying needed. Under a `skills` root a subdirectory is a skill only through `<dir>/SKILL.md` — a subdirectory without one is skipped (a stderr warning names it when it holds `.md` files), flat `.md` files at the root still load, a `README.md` entry is never a skill, and `rules/` / `instructions/` roots recurse as before. `applies_to`, `applyTo`, and `paths` are equivalent scopes; semantically identical mirrors of the same rule dedupe silently, while divergent same-name rules still warn. Per PR, skills matching the changed files become review passes and the rest land in the on-demand `skills-index.md`. A directory you configure (`extra_skills_dirs`, `--skills-dir`, `PR_REVIEW_SKILLS_DIR` — e.g. `extra_skills_dirs: [~/my-team-rules]`) is selected the same way: targeted files become scoped rules, untargeted ones go through the name/description relevance heuristic, and the unmatched land in the index. To inject every file in a directory into every pass regardless, use `--force-skill <dir>`. Untargeted skills in a home dir are skipped unless pulled in one of these ways.

> **Do not point `--force-skill` at rules the PR under review can edit.** A forced file or directory bypasses the rule-trust check below, so `--force-skill .claude/skills` would re-admit in-repo rules that the branch itself authored — the exact input the check exists to reject. `extra_skills_dirs` no longer has that hole: a configured directory inside the checkout is trust-checked like any repo dir, and a file the PR changed there is skipped even when the `.pr-review.yaml` naming the dir is unchanged. Forcing is per run and CLI only — there is deliberately no yaml or env key for it, so a committed config can never pre-authorize branch-authored content.

**Scope vs. force.** `--skill <file>` / `extra_skills:` include one file but KEEP its declared `applies_to` / `applyTo` / `paths` scope, so it only applies where it says it does. Directory-level sources (`extra_skills_dirs`, `--skills-dir`, `PR_REVIEW_SKILLS_DIR`) are selected like repo skill dirs — scope, relevance heuristic and trust all apply. `--force-skill <file|dir>` is the only bypass: every `.md` under a forced directory is injected whole into every pass, no scope, no trust check.

**Rules the PR itself changed are ignored.** A rule file added or modified by the PR under review is untrusted input: it is dropped from both the authoritative context and the on-demand index, and the summary names the lost coverage. That includes in-repo files passed via `--skill` and files inside a configured directory. Linked skill directories (symlinks, NTFS junctions) are followed one hop, in every discovery and configured dir, unless the PR added or changed the link itself or any directory above it — such a link is refused before anything behind it is read, and a link met inside a linked directory is never followed. What a link reaches is trusted by authorship rather than location: a file outside the checkout counts only when it is committed and clean in its home git repository (a `SKILL.md` needs its whole directory clean — on Windows a checkout writes through a junction, so a planted file would otherwise become a trusted rule for every sibling repo), while a directory under no repository at all is trusted as your local configuration, with a stderr note. `--force-skill <file|dir>` is the explicit override — use it knowing what it means.
