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

Authored as: a `.md` file in `.pr-review/skills/` (per-repo) or `~/.pr-review/skills/` (personal, cross-repo).

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

`prepareSessionContext` (in `src/dispatch/single-session.ts`) routes each skill. A skill reaches a reviewer only if:

1. `inject_into` is empty, or contains the reviewer's short name, AND
2. `applies_to` globs are empty, or match at least one in-scope changed file.

Matching skills are written to one `skills-<reviewer>.md` file per reviewer in the run dir (`~/.pr-review/runs/<id>/`) — the shared `pr-context.md` no longer embeds skills. The reviewer evaluates the diff against its own criteria PLUS the injected skill content.

Special cases:
- The **verifier** receives the union of all injected skills (including skills routed to `codex`).
- **Companion agents** receive only skills WITHOUT `inject_into`.
- **codex** is a routing target like any reviewer: `inject_into: [codex]` works, and its skills are written to `skills-codex.md` in the run dir.

Limits: skill bodies are capped at 16 KB each, and each `skills-<reviewer>.md` file at 64 KB; truncation warns on stderr. Malformed frontmatter YAML warns on stderr naming the file.

## Previewing routing

```bash
pr-review review <pr-url> --context-only
```

Prepares `pr-context.md` + the per-reviewer skills files and prints a skill→reviewer routing table — without spawning the runtime. The reviewers line shows "+ codex (sibling process)" when the Codex reviewer would run. This is the recommended way to test a skill.

## Common confusion to avoid

- **"My docs are skills, not reviewers"** — yes, that's the default. Drop them in `.pr-review/skills/` and they'll be injected automatically.
- **"Will the built-in `performance` reviewer see my team's performance rules?"** — yes, if you put them in a skill whose `applies_to` globs match at least one in-scope changed file (and whose `inject_into`, if set, includes `performance`). Verify with `--context-only`.
- **"Do I need a `plugin.yaml`?"** — no. That's only for packaging a reviewer/skill pack to distribute to other teams.
