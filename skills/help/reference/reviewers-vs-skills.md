---
description: "pr-review skills vs passes: how a .md skill becomes a review pass, the selection tiers, frontmatter reference, the pass cap and on-demand index. Use when asked how to add rules, business logic, conventions, stack guides, or when confused about the difference between skills and passes."
---

# Skills and Passes in `pr-review`

There are no built-in reviewers any more. The `pr-review` tool works with two concepts:

## Skill

Any `.md` file of review knowledge — a cheat sheet, a style guide, a team convention, an instructions file. Skills come from:

- **Skill packs** — git repos cloned to `~/.pr-review/packs/<name>/` (defaults: `awesome-copilot`, `owasp`, plus the index-only `anthropic-cybersecurity`). Pack skill names are `<pack>/<skill>`, e.g. `awesome-copilot/go`, `owasp/nodejs-security`.
- **Repo/personal skill dirs** — `.claude/skills/`, `.copilot/skills/`, `.github/skills/`, `.agents/skills/` (per-repo), or the same under `~/` (personal). These keep their plain name.
- **Forced sources** — `extra_skills_dirs`, `--skills-dir`, `--skill`, `PR_REVIEW_SKILLS_DIR`.

## Pass

One skill + the shared pipeline rules, run by a **generic agent** (`Task(subagent_type="general-purpose")` on Claude Code, `task(agent_type="general-purpose")` on Copilot CLI) inside the single orchestrator session. When a skill matches the PR it becomes its own review pass and produces its own findings — skills are no longer injected into someone else's prompt.

Each pass gets a `pass-<name>.md` file in the run dir (`~/.pr-review/runs/<id>/`): the pipeline rules header (severity scale CRITICAL → NIT, only what the PR changes, no duplicates of existing comments, exact `file:line`) plus that ONE skill body and a `Source:` line so the skill's relative references resolve.

## How passes are selected

Selection is ranked (`src/dispatch/pass-select.ts`) — your own content always outranks pack content:

1. **forced** — everything from `extra_skills_dirs` / `--skills-dir` / `--skill` (the most explicit opt-in).
2. **repo** — your repo's own skills: `applies_to`-targeted ones (shown as `glob` in the table), and untargeted ones promoted by the `name` + `description` relevance heuristic against the changed files and diff.
3. **pack glob** — a pack skill whose `applies_to`/`applyTo` globs match a changed file. A bare `**` never counts, and a bare extension wildcard (`**/*.ts`) only counts when the skill's name/tags also overlap the stack — pack authors use those promiscuously (awesome-copilot's astro/nestjs/svelte guides all claim `**/*.ts`).
4. **pack tag** — EXACT token match between the skill's name/filename/frontmatter `tags` and the PR's stack tags (languages from the GitHub Linguist database, dependency names from manifests, ecosystem tags like `nodejs`/`dotnet`).
5. **baseline** — each pack's baseline pointer list (e.g. `awesome-copilot/code-review-generic`, `owasp/error-handling`); runs on every code PR when slots remain.

**Cap:** at most `MAX_PASSES = 10` passes dispatch. Overflow, unmatched skills, and index-mode packs land in `skills-index.md` — an on-demand list every pass can read from when an entry is relevant. Indexed skills are surfaced, not ignored.

Docs-only PRs run only glob/forced passes (never baseline). Zero passes on a code PR is exit 2 with a `packs suggest` hint; on a docs-only PR it's a clean exit 0.

## Skipping passes

```bash
pr-review review <pr-url> --skip go                        # bare skill suffix
pr-review review <pr-url> --skip awesome-copilot/go,codex  # full name; verifier/codex too
```

Valid `--skip` / `skip_reviewers` names are **pass names** — the full `<pack>/<skill>` form or the bare suffix — plus `verifier` and `codex`.

## The rest of the pipeline

- **Verifier** — still a pipeline step, not a skill. Its brief (`VERIFIER_BRIEF` in `src/dispatch/single-session.ts`) is written to `verifier.md` and dispatched as a generic agent when phase 1 produced a CRITICAL/HIGH finding.
- **Codex** — the optional second-opinion sibling process, unchanged; it reads `skills-all.md` (the union of all pass bodies).
- **Companion plugins** (pr-review-toolkit, code-review) — unchanged; they also read `skills-all.md`.

## Frontmatter quick reference

```yaml
---
description: short description
applies_to: ["**/*Controller.cs"]   # globs vs changed files; aliases: applyTo (CSV string OK)
name: our-auth-conventions          # optional — wins over the filename
tags: [csharp, dotnet]              # optional — exact-matched against stack tags
---
```

- `applies_to` (alias `applyTo`, which may be a comma-separated string) routes by changed files.
- `name` overrides the filename; `tags` feed the tag tier.
- Files with no frontmatter (e.g. OWASP cheat sheets) get their description from the first `#` heading; filename suffixes are folded (`go.instructions.md` → `go`, `Input_Validation_Cheat_Sheet.md` → `input-validation`).
- `inject_into` is **deprecated** — it is parsed only to print a stderr warning, then ignored. Every matched skill now runs as its own pass; `applies_to` still scopes it to files.

## Previewing routing

```bash
pr-review review <pr-url> --context-only
```

Prints a `## Stack` section (languages, dependencies, notes) and a `## Passes` table (`| Pass | Matched by | Matched on | Source |`) plus the index count — without spawning the runtime. Exits 2 when zero passes would run on a code PR. This is the recommended way to test a skill.

## Skills in the run summary

The `pr-review-summary.md` carries a `## Skills` section: `**Passes:** N · **On-demand (index):** K` plus a `| Pass | Matched by |` table. The progress feed shows the same brief (`N pass(es) · K on-demand`), surfaced by `pr-review status`. A `--resume` reproduces the section from the `passes.json` the live run persisted (old runs without it: section omitted, findings still replay).

## Common confusion to avoid

- **"Where did the `security`/`quality`/... reviewers go?"** — deleted. Their job is done by pack skills (e.g. `awesome-copilot/security-and-owasp` in the baseline) and your own skills, each running as its own pass.
- **"Will my team's performance rules be seen?"** — yes: put them in a skill whose `applies_to` globs match a changed file (or whose name/tags match the stack) and it becomes its own pass. Verify with `--context-only`.
- **"My skill didn't run"** — check the `## Passes` table; it may be in the index (cap overflow or no match). Tighten `applies_to` or `tags` to lift it into a higher tier.
