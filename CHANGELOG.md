# Changelog

Notable changes, [keep-a-changelog](https://keepachangelog.com/en/1.1.0/) format. Rolled by `scripts/release.mjs` — put notes under Unreleased as you go.

## [Unreleased]

### Added
- **Background reviews with a live progress feed.** The slash command now starts the review detached (`review --detach`) and polls a new `status <run-id>` subcommand, so a slow run (routinely 6–10 min) no longer dies on the host's ~10-min Bash timeout, and the user sees a moving snapshot instead of one silent call. On the claude runtime, per-reviewer completions stream live (parsed from `--output-format stream-json`; opt out with `PR_REVIEW_STREAM=0`); every runtime gets phase-level checkpoints written to `progress.ndjson` in the run dir.
- **`review --resume <run-id>`.** Reuse a prior run's on-disk reviewer outputs (`single-session-findings.json` / `phase1-findings.json`) and jump straight to dedupe + post — turning a run killed after the expensive reviewer phase into a ~1-minute finish instead of a full re-spend.
- **Idempotent posting.** A successful publish writes a `posted.marker`; `--resume` refuses to re-post while it exists (use `--force-post` to override), closing the duplicate-comment hazard on retry.

### Changed
- **Claude Code: the bare `/pr-review` now resolves** (previously only `/pr-review:pr-review`). The plugin manifest now also ships at `.claude-plugin/plugin.json` — Claude Code's canonical location, which registers the bare command alias — while the root `plugin.json` stays for Copilot CLI. `scripts/release.mjs` keeps both in sync.
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
