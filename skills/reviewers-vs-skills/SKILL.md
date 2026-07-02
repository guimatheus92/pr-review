---
description: "pr-review reviewers vs skills: the two file types, when to author which, frontmatter reference, and injection rules. Use when asked how to add rules, business logic, conventions, stack guides, or when confused about the difference between reviewers and skills."
---

# Reviewers vs. Skills in `pr-review`

The `pr-review` tool consumes two distinct kinds of `.md` files. Knowing which to author for which job avoids confusion and duplicated work.

## Reviewer

A complete review prompt with criteria and an output contract. The tool spawns a `copilot` subprocess per reviewer; each produces its own list of findings.

Example: `architecture.md` reviewer — instructs the model to look at the diff for layering violations and produce JSON findings. Sent to its own subprocess. Findings posted/printed independently.

Authored as: a `.md` file in `.pr-review/reviewers/` (per-repo) or `~/.pr-review/reviewers/` (personal, cross-repo).

## Skill

Passive reference material. The tool injects matching skills into other reviewers' prompts as context. Skills do not run as their own subprocess and do not produce their own findings.

Example: `our-auth-conventions.md` skill with `applies_to: ["**/*Controller.cs"]` — when the built-in `security` reviewer runs against a PR touching `*Controller.cs`, this skill's content is **prepended to the security reviewer's prompt**. The security reviewer evaluates the diff against BOTH generic security criteria AND your team's auth rules, producing one integrated set of findings.

Authored as: a `.md` file in `.pr-review/skills/` (per-repo) or `~/.pr-review/skills/` (personal, cross-repo).

## Which type to author

Default: **skill**. Most user content is reference material that should augment existing reviewers, not run as its own pass.

Author a reviewer when:
- You want a dedicated category in the summary output (e.g. a separate "team-rules-violations" section).
- Your content is a complete review prompt with explicit "look for X, output JSON" instructions, not just reference material.

Author a skill when:
- You have a style guide, business rule, team convention, or "how we do X" document.
- You want the rule to apply to multiple reviewers (security, architecture, performance) without writing three versions.
- Your content is reference material, not a self-contained reviewer prompt.

## Frontmatter quick reference

Reviewer:
```yaml
---
description: short description
applies_to: ["**/*.cs"]
model: claude-opus-4.8
output_format: json
skip_when_no_match: true
---
```

Skill:
```yaml
---
description: short description
applies_to: ["**/*Controller.cs"]
inject_into: [security, architecture]   # optional — defaults to all matching reviewers
---
```

## The injection rule

When a reviewer runs, the tool determines which skills are applicable:

1. Skill's `applies_to` globs match at least one changed file in the diff, AND
2. If skill has `inject_into`, the reviewer's name is in that list (otherwise: all reviewers are eligible).

Applicable skills are inserted into the reviewer's prompt under a "Project-Specific Context" section, marked as authoritative requirements. The reviewer then evaluates the diff against its own criteria PLUS the injected skill content.

## Common confusion to avoid

- **"My docs are skills, not reviewers"** — yes, that's the default. Drop them in `.pr-review/skills/` and they'll be injected automatically.
- **"Will the built-in `performance` reviewer see my team's performance rules?"** — yes, if you put them in a skill with `applies_to` globs that match the changed files.
- **"Do I need a `plugin.yaml`?"** — no. That's only for packaging a reviewer/skill pack to distribute to other teams.
