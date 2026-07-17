---
description: "pr-review reviewer/skill lifecycle: adding, removing, overriding, and listing reviewers and skills. Use when asked how to add/remove/override/disable a reviewer, where .md files go, how to see what's loaded, what the built-in reviewers are, or anything about managing the reviewer set."
---

# Managing Your Reviewers and Skills

You don't write code to manage review content. You drop `.md` files in conventional folders, and the loader picks them up. To remove, you delete a file or skip a reviewer by name.

**Important:** the single-session review path loads **skills only** (`loadAll` runs with `skillsOnly`). User-authored reviewer `.md` files are not dispatched during `pr-review review` — skills injected into the seven built-in reviewers are the extension mechanism.

## What's loaded right now

```bash
pr-review plugins list
```

Output groups reviewers (active passes that produce findings) and skills (passive context injected into matching reviewers). Each line shows the source file path so you know exactly where it came from — built-in, repo, personal, or plugin.

## Where files are auto-discovered

Skills are standard `SKILL.md` reference docs, so they load from every conventional skill path that Copilot CLI / Claude Code / GitHub already use.

| Path | Type | Scope |
|---|---|---|
| `<repo>/.pr-review/skills/*.md` | Skills | Per-repo |
| `<repo>/.claude/skills/*.md` | Skills | Per-repo (Claude Code convention) |
| `<repo>/.copilot/skills/*.md` | Skills | Per-repo (Copilot CLI convention) |
| `<repo>/.github/skills/*.md` | Skills | Per-repo (GitHub convention) |
| `<repo>/.agents/skills/*.md` | Skills | Per-repo (AGENTS.md universal convention) |
| `~/.pr-review/skills/*.md`, `~/.claude/skills/*.md`, `~/.copilot/skills/*.md`, `~/.agents/skills/*.md` | Skills | Personal, cross-repo |

**Skills in `.pr-review/skills/` (repo or home) are always injected** — the location itself declares review intent. Skills in the shared dirs (`.claude/`, `.copilot/`, `.github/`, `.agents/`) are handled by where they live and whether they carry targeting:

- **Targeted** (`applies_to` and/or `inject_into`) → injected as a rule, same as a `.pr-review/skills/` skill.
- **Untargeted, in a repo dir** → listed in an on-demand **catalog** (name + description + path) in the review context. Reviewers read the entries relevant to the changed files themselves; catalog skills are advisory background, not authoritative rules. This means a repo full of general-purpose agent skills is surfaced, not injected wholesale — so it never floods every reviewer's context.
- **Untargeted, in a home dir** (`~/.claude/skills/` etc.) → skipped (with a stderr note); these are personal general-purpose helpers.

The standard `SKILL.md` frontmatter is what we read:

- `applies_to` (globs) → which in-scope changed files trigger the skill (default: all files)
- `inject_into` (reviewer short names: `security`, `quality`, `architecture`, `performance`, `test-coverage`, `silent-failure`, `verifier`) → which reviewers see the context (default: all reviewers). Companion agents receive only skills WITHOUT `inject_into`; the verifier receives the union of all injected skills.
- Any other field (`name`, `allowed-tools`, etc.) is preserved but ignored
- Malformed frontmatter YAML prints a stderr warning naming the file

Routed skills are written per reviewer to `skills-<reviewer>.md` in the run dir (`~/.pr-review/runs/<id>/`). Skill bodies are capped at 16 KB each and each per-reviewer file at 64 KB — truncation warns on stderr. The catalog lives in `pr-context.md` under a separate 24 KB budget (one line per skill, description capped at 200 chars), so it never competes with the injected-skill caps.

Use `.pr-review/skills/` when the content is review-specific (it loads unconditionally and stays out of regular agent sessions); add `applies_to`/`inject_into` to a skill in a shared dir when you want one file to serve both your normal agent sessions and pr-review.

## Other ways to add content

| Scope | Path | Visibility | Tracked in git? |
|---|---|---|---|
| **Built-in** | `agents/<name>.md` inside the plugin install | All users of pr-review globally | Yes — in the plugin source |
| **Plugin** | A `plugin.yaml`-wrapped directory passed via `--plugin-dir` | Whoever opts in via flag or yaml | Depends on where it's published |

## Adding

### Adding a per-repo skill (zero ceremony, team-shared)

```bash
mkdir -p .pr-review/skills
cp docs/our-auth-conventions.md  .pr-review/skills/       # context injected into reviewers
git add .pr-review && git commit -m "add review rules"
```

The next `/pr-review <url>` picks it up automatically. No flags. No config.

### Adding a personal skill (cross-repo, just you)

Same idea, but in your home directory:

```bash
mkdir -p ~/.pr-review/skills
cp ~/notes/personal-checklist.md  ~/.pr-review/skills/
```

Loaded automatically on every `pr-review` run from any repo. Use for cross-team review habits you carry with you.

### Adding an ad-hoc file for one run

```bash
pr-review review <pr-url> --skill ./extra-context.md
pr-review review <pr-url> --skills-dir ./other/path
```

### Reviewer vs skill (quick decision)

- **Skill** — reference material that augments the built-in reviewers. Goes in `skills/`. No own findings; content is injected into matching reviewers as context.
- **Reviewer** — the seven built-in review passes dispatched via `task()` in the single session. User reviewer `.md` files are not loaded by the review path.

Author skills. See [`reviewers-vs-skills`](../reviewers-vs-skills/SKILL.md) for the full distinction.

## Removing

### Skip for a single run

```bash
pr-review review <pr-url> --skip security
pr-review review <pr-url> --skip security,test-coverage,verifier   # multiple
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

### Removing a per-repo or personal skill entirely

Just delete the file:

```bash
rm .pr-review/skills/my-old-skill.md
```

### Removing a built-in from the plugin source

```bash
cd "$(copilot plugin path pr-review)"
rm agents/security.md
npm run build
```

Most people don't need this — `--skip` or `skip_reviewers` are reversible and don't fork the plugin. Only remove from source if you're maintaining a custom fork.

## Tightening a built-in

Reviewer files can't be shadowed in the single-session path (user reviewer `.md` files aren't loaded). To make, say, the `security` reviewer apply your team's stricter rules, author a **skill** targeted at it:

```markdown
---
description: Team security rules
inject_into: [security]
applies_to: ["**/*.cs"]
---
# Our stricter security rules
...
```

Drop it in `.pr-review/skills/` (team) or `~/.pr-review/skills/` (personal). The security reviewer then evaluates the diff against its built-in criteria plus yours.

## Verifying changes took effect

```bash
pr-review plugins list                    # shows the resolved set with file paths
pr-review review <pr-url> --context-only  # prints the skill→reviewer routing table (no runtime spawn)
pr-review config show                     # shows effective config + which file each setting came from
```

`--context-only` also writes `pr-context.md` and the `skills-<reviewer>.md` files to the run dir so you can inspect exactly what each reviewer would receive. Use these before running a real review so you don't burn tokens to discover a misconfig.

## File format (any scope)

A `.md` file is the minimum. Frontmatter is optional and only needed when you want to scope routing:

```markdown
---
description: C# style and team conventions
applies_to:
  - "**/*.cs"
  - "**/*.csproj"
inject_into: [security, quality]
---

# C# Style Guide
...
```

Recognized keys: `description`, `applies_to` (globs matched against in-scope changed files; empty = all), `inject_into` (reviewer short names; empty = all reviewers).

Anything else in frontmatter (including the standard `SKILL.md` spec's `name`, `allowed-tools`, etc. — the convention shared by Copilot CLI and Claude Code) is preserved but ignored, so a SKILL.md you already wrote for either host works as a pr-review skill without edits. If the frontmatter YAML is malformed, a stderr warning names the file.
