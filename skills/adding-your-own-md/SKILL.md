---
description: "pr-review reviewer/skill lifecycle: adding, removing, overriding, and listing reviewers and skills. Use when asked how to add/remove/override/disable a reviewer, where .md files go, how to see what's loaded, what the built-in reviewers are, or anything about managing the reviewer set."
---

# Managing Your Reviewers and Skills

You don't write code to manage reviewers. You drop `.md` files in conventional folders, and the loader picks them up. To remove or override, you delete a file or shadow it by name.

## What's loaded right now

```bash
pr-review plugins list
```

Output groups reviewers (active passes that produce findings) and skills (passive context injected into matching reviewers). Each line shows the source file path so you know exactly where it came from — built-in, repo, personal, or plugin.

## Where files are auto-discovered

Reviewers are pr-review-specific (active prompts with output contracts), so they load only from `.pr-review/reviewers/`. Skills are standard `SKILL.md` reference docs, so they load from every conventional skill path that Copilot CLI / Claude Code / GitHub already use.

| Path | Type | Scope |
|---|---|---|
| `<repo>/.pr-review/reviewers/*.md` | Reviewers | Per-repo (committed; team shares) |
| `~/.pr-review/reviewers/*.md` | Reviewers | Personal, cross-repo |
| `<repo>/.pr-review/skills/*.md` | Skills | Per-repo |
| `<repo>/.claude/skills/*.md` | Skills | Per-repo (Claude Code convention) |
| `<repo>/.copilot/skills/*.md` | Skills | Per-repo (Copilot CLI convention) |
| `<repo>/.github/skills/*.md` | Skills | Per-repo (GitHub convention) |
| `<repo>/.agents/skills/*.md` | Skills | Per-repo (AGENTS.md universal convention) |
| `~/.pr-review/skills/*.md`, `~/.claude/skills/*.md`, `~/.copilot/skills/*.md`, `~/.agents/skills/*.md` | Skills | Personal, cross-repo |

**If you already have skills authored for Claude Code or Copilot CLI in any of those standard locations, they work as-is** — pr-review picks them up without copying. The standard `SKILL.md` frontmatter is what we read:

- `applies_to` (globs) → which changed files trigger the skill (default: all files)
- `inject_into` (reviewer names) → which reviewers see the context (default: all matching reviewers)
- Any other field (`name`, `allowed-tools`, etc.) is preserved but ignored

The only reason to use `.pr-review/skills/` specifically is when you want a skill that's exclusive to pr-review — e.g. a review-only checklist you don't want surfacing in regular Claude Code sessions.

## Other ways to add content

| Scope | Path | Visibility | Tracked in git? |
|---|---|---|---|
| **Built-in** | `skills/reviewers/<name>/SKILL.md` inside the plugin install | All users of pr-review globally | Yes — in the plugin source |
| **Plugin** | A `plugin.yaml`-wrapped directory passed via `--plugin-dir` | Whoever opts in via flag or yaml | Depends on where it's published |

## Adding

### Adding a per-repo reviewer or skill (zero ceremony, team-shared)

```bash
mkdir -p .pr-review/skills .pr-review/reviewers
cp docs/our-auth-conventions.md  .pr-review/skills/       # context injected into reviewers
cp docs/special-review-pass.md   .pr-review/reviewers/    # standalone reviewer
git add .pr-review && git commit -m "add review rules"
```

The next `/pr-review <url>` picks them up automatically. No flags. No config.

### Adding a personal reviewer or skill (cross-repo, just you)

Same idea, but in your home directory:

```bash
mkdir -p ~/.pr-review/skills ~/.pr-review/reviewers
cp ~/notes/personal-checklist.md  ~/.pr-review/reviewers/
```

Loaded automatically on every `pr-review` run from any repo. Use for cross-team review habits you carry with you.

### Adding an ad-hoc file for one run

```bash
pr-review review <pr-url> --reviewer ./AD-HOC.md
pr-review review <pr-url> --skill ./extra-context.md
pr-review review <pr-url> --reviewers-dir ./other/path
```

### Reviewer vs skill (quick decision)

- **Skill** — reference material that should augment existing reviewers (most common). Goes in `skills/`. No own findings; content is injected into matching reviewers as context.
- **Reviewer** — complete review prompt with "look for X, output JSON" instructions. Goes in `reviewers/`. Spawns its own subprocess and produces its own findings.

When in doubt: skill. See [`reviewers-vs-skills`](../reviewers-vs-skills/SKILL.md) for the full distinction.

## Removing

### Skip for a single run

```bash
pr-review review <pr-url> --skip security
pr-review review <pr-url> --skip security,tests,verifier   # multiple
```

### Always skip in this repo

`<repo>/.pr-review.yaml`:

```yaml
skip_reviewers:
  - security
  - test-coverage
```

Committed alongside the rest of the repo's review config. The team shares the skip list.

### Always skip personally (across all repos)

`~/.pr-review/config.yaml`:

```yaml
skip_reviewers:
  - verifier
```

### Removing a per-repo or personal reviewer entirely

Just delete the file:

```bash
rm .pr-review/reviewers/my-old-reviewer.md
```

### Removing a built-in from the plugin source

```bash
cd "$(copilot plugin path pr-review)"
rm -r skills/reviewers/security
npm run build
```

Most people don't need this — `--skip` or `skip_reviewers` are reversible and don't fork the plugin. Only remove from source if you're maintaining a custom fork.

## Overriding a built-in

If you want, say, the `security` reviewer to use your team's stricter rules instead of the built-in defaults, place a file with the same name in a higher-priority scope. **Same name wins from a user location**:

```bash
# Per-repo override (whole team gets your security reviewer)
cp our-team-security-rules.md .pr-review/reviewers/security.md

# Personal override (just you)
cp my-security-checklist.md ~/.pr-review/reviewers/security.md
```

When `pr-review plugins list` runs, you'll see your file's path next to `security` instead of the built-in path — confirming the override took effect.

Override resolution order (highest priority wins by name):

1. CLI flags: `--reviewer`, `--reviewers-dir`
2. Repo `.pr-review/reviewers/`
3. Repo `.pr-review.yaml` `extra_reviewers` entries
4. Personal `~/.pr-review/reviewers/`
5. Personal `~/.pr-review/config.yaml` `extra_reviewers` entries
6. Packaged plugins (`--plugin-dir`, `--plugin`)
7. Built-ins (lowest priority — easiest to shadow)

The CLI prints a warning if two non-built-in reviewers collide on the same name (so accidental shadowing across plugins is visible).

## Verifying changes took effect

```bash
pr-review plugins list                # shows the resolved set with file paths
pr-review plugins list --reviewers-dir ./tmp   # preview with extra paths added
pr-review config show                 # shows effective config + which file each setting came from
```

Use these before running a real review so you don't burn tokens to discover a misconfig.

## File format (any scope)

A `.md` file is the minimum. Frontmatter is optional and only needed when you want to scope, change defaults, or pick a model:

```markdown
---
description: C# style and team conventions
applies_to:
  - "**/*.cs"
  - "**/*.csproj"
model: claude-opus-4.8
output_format: json
skip_when_no_match: true
---

# C# Style Guide
...
```

Recognized keys: `description`, `applies_to`, `model`, `output_format` (`json` | `markdown`), `skip_when_no_match`. For skills you additionally have `inject_into: [reviewer-name, ...]` to scope which reviewers receive the context.

Anything else in frontmatter (including the Copilot CLI `SKILL.md` spec's `name`, `allowed-tools`, etc.) is preserved but ignored — so a SKILL.md you already wrote for Copilot CLI works as a pr-review reviewer/skill without edits.
