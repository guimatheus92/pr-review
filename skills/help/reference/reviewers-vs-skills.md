---
description: "pr-review reviewers vs skills: the two file types, when to author which, frontmatter reference, and injection rules. Use when asked how to add rules, business logic, conventions, stack guides, or when confused about the difference between reviewers and skills."
---

# Reviewers vs. Skills in `pr-review`

The `pr-review` tool consumes two distinct kinds of `.md` files. Knowing which to author for which job avoids confusion and duplicated work.

## Reviewer

A complete review prompt with criteria. All reviewers are dispatched as agents via `task()` / `Task()` inside one agent session (Copilot CLI or Claude Code); each produces its own list of findings.

Example: the built-in `architecture` reviewer — instructs the model to look at the diff for layering violations and produce JSON findings. Dispatched as its own agent in the session. Findings posted/printed independently.

**Note:** the single-session review path loads skills only — user-authored reviewer `.md` files in `.pr-review/reviewers/` are not loaded. Skills are the extension mechanism; the built-in reviewers (security, quality, architecture, performance, test-coverage, silent-failure, verifier) are the review passes.

## Skill

Passive reference material. The tool injects matching skills into other reviewers' prompts as context. Skills do not run as their own subprocess and do not produce their own findings.

Example: `our-auth-conventions.md` skill with `applies_to: ["**/*Controller.cs"]` — when the built-in `security` reviewer runs against a PR touching `*Controller.cs`, this skill's content is **written into the security reviewer's skills file** (`skills-security.md` in the run dir) and injected as context. The security reviewer evaluates the diff against BOTH generic security criteria AND your team's auth rules, producing one integrated set of findings.

Authored as: a `.md` file in a standard skill dir — `.claude/skills/`, `.copilot/skills/`, `.github/skills/`, or `.agents/skills/` (per-repo), or the same under `~/` (personal, cross-repo).

## Which type to author

Default: **skill** — and in the single-session review path, effectively always: user reviewer files are not loaded there. All user content is reference material that augments the built-in reviewers.

Author a skill when:
- You have a style guide, business rule, team convention, or "how we do X" document.
- You want the rule to apply to multiple reviewers (security, architecture, performance) without writing three versions.
- Your content is reference material, not a self-contained reviewer prompt.

## Frontmatter quick reference

Skill:
```yaml
---
description: short description
applies_to: ["**/*Controller.cs"]
inject_into: [security, architecture]   # optional — defaults to all reviewers
---
```

Valid `inject_into` names are the reviewer short names: `security`, `quality`, `architecture`, `performance`, `test-coverage`, `silent-failure`, `verifier` — plus `codex` for the optional Codex second-opinion reviewer.

## The injection rule

`prepareSessionContext` (in `src/dispatch/single-session.ts`) routes each repo skill one of two ways:

- **Explicitly targeted** — the skill declares `applies_to` and/or `inject_into`. It is **injected** authoritatively, bypassing the relevance heuristic: it reaches a reviewer when `inject_into` is empty or names that reviewer, AND `applies_to` is empty or matches at least one in-scope changed file.
- **Untargeted** — no `applies_to`/`inject_into`. The tool runs a relevance heuristic, matching the skill's `name` + `description` against the changed file paths and the diff (accent-insensitive, stem/prefix matching, so Portuguese "planos/créditos" matches English `plans`/`Credits`). A **match** injects the full body into every reviewer; **no match** lists the skill in the on-demand **catalog** instead. Either way the skill is used — injected when relevant, catalogued otherwise.

Injected skills are written to one `skills-<reviewer>.md` file per reviewer in the run dir (`~/.pr-review/runs/<id>/`) — the shared `pr-context.md` no longer embeds skills. The reviewer evaluates the diff against its own criteria PLUS the injected skill content.

Special cases:
- The **verifier** receives the union of all injected skills (including skills routed to `codex`).
- **Companion agents** receive only skills WITHOUT `inject_into`.
- **codex** is a routing target like any reviewer: `inject_into: [codex]` works, and its skills are written to `skills-codex.md` in the run dir.
- **Catalog:** a section of `pr-context.md` (name + description + path) holding every untargeted skill that didn't match the relevance heuristic. Every reviewer sees the catalog and reads the entries relevant to the changed files on demand, treating them as **advisory** background (they do not override reviewer criteria or injected rules). In `--context-only`, catalog entries show up as `(catalog — on-demand)`.
- **Untargeted home skills** (`~/.claude/skills/` etc.) are skipped entirely (with a stderr note) — personal general-purpose helpers, not review content.
- **Force a whole dir:** `extra_skills_dirs`, `--skills-dir`, or `PR_REVIEW_SKILLS_DIR` inject every skill in a directory unconditionally, bypassing the heuristic.

Limits: injected skill bodies are capped at 16 KB each, and each `skills-<reviewer>.md` file at 64 KB; the catalog section has its own 24 KB budget in `pr-context.md` (one line per skill, description capped at 200 chars). Truncation warns on stderr. Malformed frontmatter YAML warns on stderr naming the file.

## Previewing routing

```bash
pr-review review <pr-url> --context-only
```

Prepares `pr-context.md` + the per-reviewer skills files and prints a skill→reviewer routing table — without spawning the runtime. The reviewers line shows "+ codex (sibling process)" when the Codex reviewer would run. This is the recommended way to test a skill.

## Skills in the run summary

A live run reports which skills it used, so you don't have to preview separately:
- **At the start** (dispatch) it prints a `## Skills` block to stderr (foreground console / `detached.log`) and folds a count into the progress feed (`N skill(s) → M reviewer(s) · K catalog`), which `pr-review status` surfaces.
- **At the end** the `pr-review-summary.md` carries the same `## Skills` section: a totals line (`Injected: N (into M reviewers) · Catalog (on-demand): K`) plus a table of the injected skills and which reviewers each reached (`verifier` omitted — it always gets the union). Catalog skills are counted, not listed by name. A `--resume` reproduces the section from the `skill-routing.json` the live run persisted (absent → section omitted).

## Common confusion to avoid

- **"My docs are skills, not reviewers"** — yes, that's the default. Drop them in a skill dir (`.claude/skills/` etc.); the ones relevant to a PR are injected automatically, the rest are catalogued.
- **"Will the built-in `performance` reviewer see my team's performance rules?"** — yes, if you put them in a skill whose `applies_to` globs match at least one in-scope changed file (and whose `inject_into`, if set, includes `performance`). Verify with `--context-only`.
- **"Do I need a `plugin.yaml`?"** — no. That's only for packaging a reviewer/skill pack to distribute to other teams.
