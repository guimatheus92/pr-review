# Changelog

Notable changes, [keep-a-changelog](https://keepachangelog.com/en/1.1.0/) format. Rolled by `scripts/release.mjs` — put notes under Unreleased as you go.

## [Unreleased]

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
