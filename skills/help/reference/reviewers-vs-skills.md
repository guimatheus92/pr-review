---
description: "pr-review skills vs passes: how a .md skill becomes a review pass, the selection tiers, frontmatter reference, the pass cap and on-demand index. Use when asked how to add rules, business logic, conventions, stack guides, or when confused about the difference between skills and passes."
---

# Skills and Passes in `pr-review`

There are no built-in reviewers any more. The `pr-review` tool works with two concepts:

## Skill

Any `.md` file of review knowledge — a cheat sheet, a style guide, a team convention, an instructions file. Skills come from:

- **Skill packs** — git repos cloned to `~/.pr-review/packs/<name>/` (defaults: `awesome-copilot`, `owasp`, plus the index-only `anthropic-cybersecurity`). Pack skill names are `<pack>/<skill>`, e.g. `awesome-copilot/go`, `owasp/nodejs-security`.
- **Repo/personal skill dirs** — `.claude/skills/`, `.claude/rules/`, `.copilot/skills/`, `.github/skills/`, `.github/instructions/`, `.agents/skills/` (per-repo), or conventional skill dirs under `~/`. These keep their plain name.
- **Explicit sources** — `--skill` and `--skills-dir` / `extra_skills_dirs` / `PR_REVIEW_SKILLS_DIR` preserve `applies_to`/`applyTo`/`paths` and are trust-checked; `--force-skill <file|dir>` bypasses scope, relevance and trust.

## Pass

One skill + the shared pipeline rules, run by a **generic agent** (`Task(subagent_type="general-purpose")` on Claude Code, `task(agent_type="general-purpose")` on Copilot CLI) inside the single orchestrator session. Selected pack and installed-plugin skills become passes. Matched project skills normally become authoritative shared context; when there are no pack, plugin, or baseline passes, up to ten project skills become the passes themselves and only overflow remains shared context.

Each pass gets a `pass-<name>.md` file in the run dir (`~/.pr-review/runs/<id>/`): the pipeline rules header (severity scale CRITICAL → NIT, only what the PR changes, no duplicates of existing comments, exact `file:line`) plus that ONE skill body and a `Source:` line retained for provenance. Referenced sibling files are not automatically materialized into the confined runtime.

## How passes are selected

Selection separates LENSES from CONTEXT. Your own skills (repo dirs, configured dirs, forced files/dirs) are CONTEXT: every matched one is injected into EVERY pass as authoritative project rules (`skills-project.md`) - they override generic judgement and never consume pass slots. There is no numeric cap on matched project skills and their bodies are inlined whole (no byte truncation) - the review pays the token cost by design rather than silently losing a business rule. The PASSES are pack skills: stack hits (glob/tag, capped at `MAX_STACK_PASSES = 6`) plus EVERY baseline pointer (the generic lenses always run on a code PR). With no pack passes at all (`skill_packs: []`), your skills become the passes themselves — up to 10 as passes (bodies never truncated; only third-party pack bodies cap), overflow injected whole as context.

Pass selection within the packs:

1. **glob** - a specific filename/directory glob matches a changed file.
2. **dependency** - every product-specific identity token is backed by a manifest dependency; this outranks language-only routing.
3. **language/tag** - type-only and generic-manifest globs count only for language-generic skills; exact identity tags are the final stack tier.
4. **baseline** - each pack's baseline pointer list; ALWAYS dispatched on a code PR, on top of the stack cap.

Linguist contributes canonical language names, not aliases as independent technologies. Generic files such as `package.json` or `*.csproj` prove an ecosystem, not Azure Functions, MCP, Copilot SDK, or another product by themselves.

**Caps:** selection admits at most `MAX_STACK_PASSES = 6` stack passes, up to `MAX_PLUGIN_PASSES = 2` installed-plugin passes, and every configured baseline. Materialization then applies a normal 16-pass total ceiling, moving excess non-baseline passes to `skills-index.md`; baselines remain contractual and still dispatch when their count alone exceeds that ceiling. Other overflow, unmatched skills, and index-mode packs also land in the on-demand index. Indexed skills are surfaced, not ignored.

Docs-only triage retains only glob/forced passes (never baseline). When candidate passes existed but triage removes them all, the docs-only PR exits cleanly with an explanatory summary. An initially empty selection is exit 2 for docs-only and code PRs alike, with a `packs suggest` hint.

## Skipping passes

```bash
pr-review review <pr-url> --skip go                        # bare skill suffix
pr-review review <pr-url> --skip awesome-copilot/go,codex  # full name; verifier/codex too
```

Valid `--skip` / `skip_reviewers` names are **pass names** — the full `<pack>/<skill>` form or the bare suffix — plus `verifier` and `codex`.

## The rest of the pipeline

- **Verifier** — still a pipeline step, not a skill. Its brief (`VERIFIER_BRIEF` in `src/dispatch/single-session.ts`) is written to `verifier.md` and dispatched as a generic agent when phase 1 produced a CRITICAL/HIGH finding.
- **Codex** — the optional second-opinion sibling process, unchanged; it reads `skills-project.md` when pass selection leaves shared project context, or the budgeted `skills-all.md` union as fallback.
- **Companion plugins** — pr-review-toolkit's direct agents receive the same shared file as Codex and the verifier. The `code-review` slash companion receives the PR URL through its command, not a shared skills file.

## Frontmatter quick reference

```yaml
---
description: short description
applies_to: ["**/*Controller.cs"]   # aliases: applyTo and Claude rules' paths
name: our-auth-conventions          # optional — wins over the filename
tags: [csharp, dotnet]              # optional — exact-matched against stack tags
---
```

- `applies_to` (alias `applyTo`, which may be a comma-separated string) routes by changed files.
- `name` overrides the filename; `tags` feed the tag tier.
- Files with no frontmatter (e.g. OWASP cheat sheets) get their description from the first `#` heading; filename suffixes are folded (`go.instructions.md` → `go`, `Input_Validation_Cheat_Sheet.md` → `input-validation`).
- `inject_into` is **deprecated** — it is parsed only to print a stderr warning, then ignored. `applies_to` still scopes the skill before the project-context/pass selection described above.

## Previewing routing

```bash
pr-review review <pr-url> --context-only
```

Prints a `## Stack` section (languages, dependencies, notes) and a `## Passes` table (`| Pass | Matched by | Matched on | Source |`) plus the index count — without spawning the runtime. Exits 2 when zero passes would run on a code PR. This is the recommended way to test a skill.

## Skills in the run summary

The `pr-review-summary.md` carries a `## Skills` section: `**Passes:** N · **Project rules (in every pass):** M · **On-demand (index):** K` (the project-rules segment appears when at least one matched; `· **Skipped:** S` is appended when any pass was skipped) plus a `| Pass | Matched by |` table. The progress feed shows the same brief (`N pass(es) · M project rule(s) · K on-demand`), surfaced by `pr-review status`. A `--resume` reproduces the section from the `passes.json` the live run persisted (old runs without it: section omitted, findings still replay).

## Common confusion to avoid

- **"Where did the `security`/`quality`/... reviewers go?"** — deleted. Their job is done by pack skills (e.g. `awesome-copilot/security-and-owasp` in the baseline) and authoritative project context from your own skills.
- **"Will my team's performance rules be seen?"** — yes: put them in a project skill whose `applies_to` globs match a changed file (or whose name/description matches the change). It becomes authoritative context in every pass, or one of the passes in the no-pack fallback. Verify with `--context-only`.
- **"My skill didn't run"** — check the `## Passes` table; it may be in the index (cap overflow or no match). Tighten `applies_to` or `tags` to lift it into a higher tier.
