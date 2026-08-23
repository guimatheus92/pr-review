---
description: How to add or curate a skill pack for pr-review. Use when wiring in a new source of review knowledge (a git repo of skills/instructions/cheat sheets) or tuning what an existing pack contributes.
---

# Adding a Skill Pack

Review knowledge comes from **skill packs**: git repos cloned to `~/.pr-review/packs/<name>/`. Every review pass is one skill (from a pack or from the repo's own skill dirs) applied by a generic agent; pass names are `<pack>/<skill>` (e.g. `awesome-copilot/go`).

## Steps

1. **Pick the install path** — there are exactly two:
   - `pr-review packs add <owner/repo|url>` — appends to the global config and clones. Because `skill_packs` REPLACES the list (so `[]` can disable packs), an absent key is first materialized with the defaults — adding one pack never drops the built-in three.
   - Edit `skill_packs:` in `~/.pr-review/config.yaml` or a repo `.pr-review.yaml`. **Unlike every other list key, this one replaces the whole list**: a repo yaml list overrides the global list entirely, and `skill_packs: []` disables packs.

   `pr-review packs suggest <tag...>` queries the skills.sh directory (top 5 per tag by installs, fail-soft) but NEVER installs — suggestion only.

2. **Shape the entry.** `'owner/repo'` shorthand, or the full object:
   ```yaml
   skill_packs:
     - git: OWASP/CheatSheetSeries    # owner/repo shorthand or a full git URL
       name: owasp                    # default: repo name; pack dir + pass-name prefix
       ref: <branch-or-tag>           # pin for reproducibility (recommended)
       include: ['cheatsheets/*.md']  # globs selecting which files load as skills
       exclude: []                    # globs against pack-relative path AND normalized skill name
       mode: auto                     # auto (skills can become passes) | index (on-demand only, never a pass)
       baseline: [error-handling, logging]  # skills from THIS pack that run as a pass on every PR
   ```
   Changing the shipped defaults means editing `DEFAULT_PACKS` in `src/config.ts`.

3. **Curate `include`/`exclude`.** Files with no frontmatter (e.g. OWASP cheat sheets) get their `description` from the first `#` heading; filename suffixes are folded (`go.instructions.md` → `go`, `Input_Validation_Cheat_Sheet.md` → `input-validation`). Use `exclude` to strip skills never useful in a diff review — see the `anthropic-cybersecurity` entry in `DEFAULT_PACKS` for the pattern (operational verbs: `hunting-*`, `exploiting-*`, `*forensic*`, …).

4. **Choose `baseline` pointers deliberately.** Baseline skills dispatch when no glob/tag/repo/forced match fires. They are pointers, not content — a renamed upstream file surfaces as a visible missing-baseline warning, not a silent drop.

5. **Use `mode: index` for reference material.** Index-only packs never become passes; their skills are listed in `skills-index.md` and read on demand by the passes that do run.

6. **Sync and verify:**
   ```bash
   pr-review packs sync                        # clone/pull all packs + refresh the Linguist cache
   pr-review packs list                        # on-disk state, skill counts, commit, freshness
   pr-review review <pr-url> --context-only    # ## Stack + ## Passes table — verify the pack's skills route
   ```

## Rules

- **Packs are third-party prompt content** read by agents with tool access. Review a repo before adding it and pin `ref:` for reproducibility. `packs add` / `skill_packs` edits are the only install path; `suggest` never installs.
- First review on a machine clones missing packs (needs git + network; fail-soft warnings; ~1-2 min). More than 30 days without `packs sync` → a stale warning on every review.
- Pass selection (`src/dispatch/pass-select.ts`): forced > repo (your own skills) > pack glob (a bare extension wildcard needs stack-consistent name/tags) > pack tag > baseline, capped at `MAX_PASSES` (10). Overflow, unmatched skills, and index-mode packs land in `skills-index.md` — on-demand, not ignored.
- Skill frontmatter: `name` (wins over filename), `tags`, `applies_to`, `applyTo` (awesome-copilot alias; may be a CSV string; `'**'` alone never counts as a glob match). `inject_into` is deprecated — parsed only to print a stderr warning, then ignored.
- The pass name is the public API — `--skip <name>` and `skip_reviewers:` accept the full `<pack>/<skill>` name or the bare suffix (plus `verifier` and `codex`).
