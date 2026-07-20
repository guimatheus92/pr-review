# Changelog

Notable changes, [keep-a-changelog](https://keepachangelog.com/en/1.1.0/) format. Rolled by `scripts/release.mjs` — put notes under Unreleased as you go.

## [Unreleased]

### Changed
- **Skills are now used from where the agent tools keep them, and the relevant ones are injected automatically per PR.** Skills live in `.claude/skills`, `.copilot/skills`, `.github/skills`, `.agents/skills` (repo and home) — no moving, no duplicating. For each PR the review matches every repo skill's name + description against the changed files and diff (accent-folded, stem-matched, so pt "planos/créditos" hits en `plans`/`Credits`); a match is **injected** (full body, force-fed into every reviewer — shows as `Injected: N`), the rest stay in the **on-demand catalog**. `applies_to`/`inject_into` frontmatter is now purely an **optional** override for explicit, authoritative routing — no longer required for a skill to be used. The summary explains that catalog skills are read on demand, not ignored.
- **Removed the `.pr-review/skills/` special directory.** Review skills no longer need a dedicated folder or duplication — they're read from the tool dirs above. Explicit `extra_skills_dirs` / `--skills-dir` / `PR_REVIEW_SKILLS_DIR` still force-inject a whole directory when you want that.

### Fixed
- **Skill discovery no longer double-counts a symlinked mirror dir.** `loadFromPaths` dedupes by real (symlink-followed) path, so a workspace where e.g. `.agents/skills` symlinks to another repo's `.claude/skills` reports the true skill count instead of 2× (the `84 → 42` confusion).
- **A malformed `skill-routing.json` no longer kills a `--resume` after it has already posted.** The resume read validated only JSON syntax, so a file that parsed to the wrong shape (`{}`, `null`, an entry without `targets`) reached the summary renderer and threw — after `runPost` published the comments — leaving the run with no `pr-review-summary.md` and stuck at the `post` phase. The shape is now validated, the failure is logged instead of silently swallowed, and the Skills section simply degrades away. Writing the artifact is also best-effort now: a display-only file can no longer take down a run that would otherwise review and post.
- **Summary skill labels are consistent with `--context-only`.** A skill that reached no dispatched reviewer now reads `(nobody — no matching files/reviewers)` in both places (the old summary-only `— (no matching files)` mis-stated the cause: `inject_into` naming a skipped or triaged-away reviewer produces the same empty routing).

## [0.3.0] — 2026-07-18

### Added
- **The review now reports which skills it used — at the start and in the final summary.** With skill discovery easier (the catalog), a run surfaces its skills instead of leaving you to guess. At dispatch it prints a `## Skills` block to stderr (foreground console / `detached.log`) and folds a count into the progress feed (`N skill(s) → M reviewer(s) · K catalog`) that `status` shows live. The `pr-review-summary.md` gains a matching `## Skills` section: a totals line (`Injected: N (into M reviewers) · Catalog (on-demand): K`) plus a table of the injected skills and which reviewers each reached (`verifier` omitted — it always gets the union; a skill matching no changed files shows `— (no matching files)`). Catalog skills are counted, not listed by name. The live run persists `skill-routing.json` so a `--resume` reproduces the section (absent → section omitted, degrades cleanly).

## [0.2.0] — 2026-07-17

### Added
- **Untargeted repo skills are now surfaced as an on-demand catalog instead of being dropped.** A skill in a shared dir (`.claude/`, `.copilot/`, `.github/`, `.agents/`) without `applies_to`/`inject_into` used to be skipped entirely — a workspace full of them reviewed blind (`loaded 0 skill(s)`). Such **repo** skills are now listed in a `## Workspace Skills Catalog` section of `pr-context.md` (name + description + path); every reviewer sees the list and reads the entries relevant to the changed files on demand, treating them as advisory background (they do not override reviewer criteria or injected rules). Injected skills (`.pr-review/skills/` and targeted shared-dir skills) are unchanged and stay authoritative. Untargeted **home** skills (`~/.claude/skills/` etc.) stay skipped as personal noise. The catalog has its own 24 KB budget in `pr-context.md` (one line per skill, description capped at 200 chars), so it never competes with the injected-skill caps; `--context-only` shows catalog entries as `(catalog — on-demand)`.

### Fixed
- **Single-session summary no longer marks successful reviewers as `✗ exit -1`.** In single-session mode every reviewer inherited the orchestrator's one process exit code, which is `-1` when the CLI is signal-killed after already writing its findings — so a fully-successful run (findings posted, exit 0) rendered all session reviewers `✗ exit -1` while only the sibling `codex` showed `✓`. A reviewer present in the structured output has, by definition, delivered its payload, so `parseFindingsFile` now stamps `exitCode: 0` on parsed reviewers and no longer propagates the orchestrator's process code. `codex` keeps its own real per-process exit code (it can genuinely fail independently).

### Changed
- **Docs: added a "Maintaining the built-in reviewers" guide** (`AGENTS.md`) and corrected drift in the `add-reviewer` skill (removed a bogus `model:` frontmatter field and a reference to a nonexistent doc). Deferred guardrails (content-structure tests, stack-agnostic grep, eval harness) are tracked in issue #5.

## [0.1.9] — 2026-07-16

### Changed
- **Intra-batch dedupe is now dedupe-mode-aware.** `dedupeWithinBatch` folds same-file near-line duplicates and treats a missing line on either side as co-located (a common cause of the same issue surviving twice); `loose` additionally merges the same finding reported at different lines when its title AND body agree strongly. `strict` still keeps two same-title findings on genuinely different lines (usually one rule flagged at two real locations).

### Fixed
- **The consolidated findings file is written up front, not only at the end.** The orchestrator prompt now writes `single-session-findings.json` alongside `phase1-findings.json` in Phase 2 — before the conditional verifier — so a run whose agent turn ends early still leaves the file the CLI actually consumes, instead of forcing a fallback. The CLI salvage path stops logging a scary `ENOENT` when the file is merely absent (that log is now reserved for a file that exists but is corrupt), and warns when CRITICAL/HIGH findings survived with no verifier reconciliation pass (cross-reviewer duplicates may remain — re-run or loosen `--dedupe-mode`). The verifier stays conditional (CRITICAL/HIGH only).
- **Azure DevOps renamed files now diff correctly.** `changeType` is read as the `VersionControlChangeType` bitmask it is — an edit OR'd with rename (e.g. `10`) no longer misreads as a plain modify — and a rename's base content is fetched from its OLD path (`sourceServerItem`) instead of 404-ing at the new path and synthesizing the whole file as added. A null `getItem` result now returns null cleanly rather than throwing a misleading "Cannot read properties of null (reading 'content')" that surfaced as a bogus "diff for this file may be wrong".
- **ADO diff synthesis no longer OOMs on very large files.** `lcsLineDiff`'s O(m·n) DP matrix is now capped (`MAX_LCS_CELLS`); above it, a huge modified/renamed file whose changed core shares no prefix/suffix falls back to a coarse whole-region replace instead of allocating a multi-GB matrix and crashing gather with "JavaScript heap out of memory" (observed on a `cultures/en-US.tmdl` at +24k/−27k lines). The fallback stays a valid diff whose NEW-side line numbers remain exact for line-snapping.
- **Corrected the 0.1.8 bare-command claim.** 0.1.8 said moving the manifest to `.claude-plugin/plugin.json` made the bare `/pr-review` resolve under Claude Code — that was wrong. Empirically, Claude Code does **not** mint a bare `/<plugin>` alias for a plugin that also ships agents (verified: the agent-shipping `pr-review` and `pr-review-toolkit` both lack the bare form; the commands-only `code-review` has it). It is not configurable in the plugin. Use `/pr-review:pr-review`, or add a personal `~/.claude/commands/pr-review.md` for a bare `/pr-review` (see README → "Command name per host"). The `.claude-plugin/plugin.json` relocation is harmless and kept (canonical location, dual-synced with the root `plugin.json` Copilot needs).

## [0.1.8] — 2026-07-08

### Added
- **Background reviews with a live progress feed.** The slash command now starts the review detached (`review --detach`) and polls a new `status <run-id>` subcommand, so a slow run (routinely 6–10 min, sometimes 20+) no longer dies on the host's ~10-min Bash timeout, and the user sees a moving snapshot (current phase + a heartbeat elapsed clock, written to `progress.ndjson`) instead of one silent call. `status` uses a `run.pid` liveness check to tell a slow-but-healthy run from a dead one, so an intermediate artifact never reads as "interrupted".
- **`review --resume <run-id>`.** Reuse a prior run's on-disk reviewer outputs (`single-session-findings.json` / `phase1-findings.json`) and jump straight to dedupe + post — turning a run killed after the expensive reviewer phase into a ~1-minute finish instead of a full re-spend.
- **Idempotent posting.** A publish writes a `posted.marker`; `--resume` refuses to re-post only when the marker shows a *fully-completed* prior post (and fails closed on a corrupt marker), so a duplicate-comment hazard is avoided without stranding the un-posted findings of a partial post. `--force-post` overrides.

### Changed
- **Plugin manifest also ships at `.claude-plugin/plugin.json`** (Claude Code's canonical location) alongside the root `plugin.json` (which Copilot CLI requires); `scripts/release.mjs` keeps both in sync. _(0.1.8 claimed this made the bare `/pr-review` resolve under Claude Code — it does not; see the Unreleased "Fixed" note.)_
- **Documentation collapsed into one `help` skill.** The nine per-topic doc-skills (each a separate `/pr-review:*` palette entry) are now one `/pr-review:help` skill whose `SKILL.md` indexes `skills/help/reference/*.md`, decluttering the slash palette without losing model-invocable help.

## [0.1.7] — 2026-07-06

### Fixed
- The orchestrator spawn now retries once when it dies before writing any findings and its output carries a transient signature — a rate limit / overload (429 / 529) or a dropped connection mid-response (observed live: `API Error: Connection closed mid-response`, `ECONNRESET`, `socket hang up`) — instead of losing the whole review to a momentary flake and falling back to a Codex-only exit 2. Deterministic errors and timeouts are not retried. On a pipeline failure, the orchestrator's stdout/stderr tail is persisted to `orchestrator-failure.log` in the run dir so the failure is diagnosable (previously it was console-only).

## [0.1.6] — 2026-07-02

### Fixed
- No spawn site triggers Node DEP0190 anymore (args array + `shell: true` concatenates unescaped). The orchestrator and codex spawns share a new `spawnCli` helper that, on win32 only, builds the command line from SAFE_ARG_RE-validated, individually double-quoted parts; other platforms spawn the binary directly without a shell. `doctor`'s gh probe drops `shell` entirely (gh ships as gh.exe), and the ADO `az` token fetch uses a prebuilt static command string on win32.

## [0.1.5] — 2026-07-02

### Fixed
- GitHub batch review no longer posts a review body ("Automated review findings.") — the body rendered as an extra "left a comment" box in the PR timeline on top of the inline comments. Findings must only ever appear inline; with a populated `comments[]`, GitHub accepts the body-less `event: COMMENT` review (the web UI submits body-less reviews the same way).

## [0.1.4] — 2026-07-02

### Added
- `pr-review doctor`: environment preflight — runtimes on PATH, resolved runtime/model, codex and companion availability, provider auth, effective config sources.
- `scripts/release.mjs`: single-command version bump across all manifests with stale-version verification, CHANGELOG roll, rebuild, commit and tag.

## [0.1.3] — 2026-07-02

### Added
- Skill targeting enforced per reviewer (`applies_to`/`inject_into` → `skills-<reviewer>.md`); `review --context-only` routing preview; 16/64 KB caps.
- Dual runtime: `--runtime copilot|claude|auto`; per-runtime spawn, prompt vocabulary and companion detection.
- Codex second-opinion reviewer (auto-detected, `--no-codex`/`invoke_codex`/`PR_REVIEW_NO_CODEX` opt-outs).
- Inline-only posting: line snapping, re-anchoring, batched GitHub review with retry/backoff; nothing posts top-level, nothing dropped.
- `--fail-on <severity>` with 0/1/2 exit contract; `--lang`/`language`; posting by default (`--dry-run` opt-out).

### Changed
- Config precedence: env now overrides yaml. Untargeted skills in shared dirs (.claude/.copilot/.github/.agents) are skipped.

### Removed
- Dead multi-session dispatch path; response cache; concurrency config.

## [0.1.0] — 2026-06

Initial version: GitHub + Azure DevOps providers, single-session orchestration of 7 built-in reviewer agents, Jaccard dedupe, gather cache, skills autodiscovery.
