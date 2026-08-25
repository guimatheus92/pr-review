---
description: "pr-review skill lifecycle: adding, removing, and listing the skills that become review passes. Use when asked how to add/remove/disable a review pass, where .md files go, how to see what's loaded, where skill packs live, or anything about managing the skill set."
---

# Managing Your Skills

You don't write code to manage review content. You drop `.md` files in conventional folders (or configure skill packs), and the loader picks them up. Every skill that matches a PR runs as its own review pass; to remove one, you delete the file or skip the pass by name.

## What's loaded right now

```bash
pr-review plugins list
```

Output groups repo/personal skills (with the source file path for each) and per-pack skill counts. There is no reviewers section any more — skills ARE the review passes.

## Where files are auto-discovered

Skills are standard `SKILL.md` reference docs, so they load from every conventional skill path that Copilot CLI / Claude Code / GitHub already use — plus the skill packs root.

| Path | Scope |
|---|---|
| `<repo>/.claude/skills/*.md` | Per-repo (Claude Code convention) |
| `<repo>/.copilot/skills/*.md` | Per-repo (Copilot CLI convention) |
| `<repo>/.github/skills/*.md` | Per-repo (GitHub convention) |
| `<repo>/.agents/skills/*.md` | Per-repo (AGENTS.md universal convention) |
| `~/.claude/skills/*.md`, `~/.copilot/skills/*.md`, `~/.agents/skills/*.md` | Personal, cross-repo |
| `~/.pr-review/packs/<name>/` | Skill packs — git repos configured via `skill_packs` / `pr-review packs add` |

How each skill routes (see [`reviewers-vs-skills`](reviewers-vs-skills.md) for the full tier list):

- **Targeted** (`applies_to` globs match a changed file) → becomes its own **pass**, authoritatively.
- **Untargeted repo skill** → run through the relevance heuristic matching its `name` + `description` against the changed file paths and the diff (accent-insensitive, stem/prefix matching, so Portuguese "planos/créditos" matches English `plans`/`Credits`). A **match** injects it into EVERY pass as authoritative project context (`skills-project.md`) — every match, no numeric cap, body inlined whole; **no match** lists it in `skills-index.md`, the on-demand index passes read from when an entry is relevant — surfaced, never dropped.
- **Pack skills** → glob/tag/baseline tiers; index-mode packs go straight to the index.
- **Untargeted, in a home dir** (`~/.claude/skills/` etc.) → skipped (with a stderr note); these are personal general-purpose helpers, not review content.

At most 10 passes dispatch per review; overflow joins the index.

One `.md` in a skill dir serves both your normal agent sessions and pr-review; add `applies_to` when you want to pin exactly which files trigger it instead of leaning on the relevance heuristic. To force an entire directory in regardless of relevance, point `extra_skills_dirs` / `--skills-dir` / `PR_REVIEW_SKILLS_DIR` at it.

## Adding

### Adding a per-repo skill (zero ceremony, team-shared)

```bash
mkdir -p .claude/skills          # or .copilot/, .github/, .agents/
cp docs/our-auth-conventions.md  .claude/skills/          # runs as a pass when relevant to the PR
git add .claude && git commit -m "add review rules"
```

The next `/pr-review <url>` picks it up automatically. No flags. No config. If the skill's `applies_to`/`name`/`description` matches the changed files it runs as its own pass; otherwise it lands in the on-demand index.

### Adding a personal skill (cross-repo, just you)

Untargeted skills in a home dir are skipped (they're treated as general-purpose helpers), so give a personal *review* skill explicit targeting:

```bash
mkdir -p ~/.claude/skills
cp ~/notes/personal-checklist.md  ~/.claude/skills/       # add applies_to frontmatter
```

With `applies_to` frontmatter it runs on every `pr-review` run from any repo. Or force a whole directory in with `--skills-dir ~/notes/review` (or `PR_REVIEW_SKILLS_DIR`). Use for cross-team review habits you carry with you.

### Adding a skill pack (whole repos of review knowledge)

```bash
pr-review packs add <owner/repo>       # appends to the global config and clones
pr-review packs suggest <pr-url>       # suggests packs for the PR's stack — never installs
pr-review packs sync                   # clone/pull all configured packs
```

Or edit `skill_packs:` in `.pr-review.yaml` / `~/.pr-review/config.yaml`. Note `skill_packs` REPLACES the whole list (unlike other list keys): `skill_packs: []` disables packs entirely.

### Adding an ad-hoc file for one run

```bash
pr-review review <pr-url> --skill ./extra-context.md
pr-review review <pr-url> --skills-dir ./other/path
```

## Adding depth to a review

There is no reviewer prompt to edit — depth comes from more (or sharper) skills. To make reviews of, say, your C# controllers apply stricter security rules, write a skill targeted at those files:

```markdown
---
description: Team security rules for controllers
applies_to: ["**/*Controller.cs"]
---
# Our stricter security rules
...
```

Drop it in a repo skill dir (`.claude/skills/` etc.) for the team, or a home dir for personal use. When a PR touches a matching file, the skill runs as its own dedicated pass alongside the pack passes. For a whole domain of depth (security, performance, a language), add a skill pack instead of writing everything yourself.

## Removing

### Skip a pass for a single run

```bash
pr-review review <pr-url> --skip go                            # bare skill suffix
pr-review review <pr-url> --skip awesome-copilot/go,verifier   # full name; verifier/codex too
```

### Always skip in this repo

`<repo>/.pr-review.yaml`:

```yaml
skip_reviewers:
  - awesome-copilot/self-explanatory-code-commenting
  - codex
```

Committed alongside the rest of the repo's review config. The team shares the skip list.

### Always skip personally (across all repos)

`~/.pr-review/config.yaml`:

```yaml
skip_reviewers:
  - verifier
```

### Removing a per-repo or personal skill entirely

Just delete the file:

```bash
rm .claude/skills/my-old-skill.md
```

### Removing a pack

Set `skill_packs:` in config to the list you want (it replaces, so listing everything except the unwanted pack removes it; `[]` removes them all), then optionally delete its clone under `~/.pr-review/packs/`.

## Verifying changes took effect

```bash
pr-review plugins list                    # shows the resolved skills + pack counts with file paths
pr-review review <pr-url> --context-only  # prints ## Stack + the ## Passes table (no runtime spawn)
pr-review config show                     # shows effective config + which file each setting came from
```

`--context-only` also writes `pr-context.md`, the `pass-*.md` files, and `skills-index.md` to the run dir so you can inspect exactly what each pass would receive. Use these before running a real review so you don't burn tokens to discover a misconfig.

## File format (any scope)

A `.md` file is the minimum. Frontmatter is optional and only needed when you want to scope routing:

```markdown
---
description: C# style and team conventions
applies_to:
  - "**/*.cs"
  - "**/*.csproj"
tags: [csharp, dotnet]
---

# C# Style Guide
...
```

Recognized keys: `description`, `applies_to` (globs matched against in-scope changed files; alias `applyTo`, which may be a comma-separated string), `name` (wins over the filename), `tags` (exact-matched against the PR's stack tags). `inject_into` is deprecated — parsed only to print a stderr warning, then ignored.

Files with no frontmatter at all still work: the description falls back to the first `#` heading, and filename suffixes are folded (`go.instructions.md` → `go`, `Input_Validation_Cheat_Sheet.md` → `input-validation`). Anything else in frontmatter (the standard `SKILL.md` spec's `allowed-tools`, etc.) is preserved but ignored, so a SKILL.md you already wrote for Copilot CLI or Claude Code works as a pr-review skill without edits. If the frontmatter YAML is malformed, a stderr warning names the file.
