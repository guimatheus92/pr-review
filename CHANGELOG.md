# Changelog

Notable changes, [keep-a-changelog](https://keepachangelog.com/en/1.1.0/) format. Rolled by `scripts/release.mjs` — put notes under Unreleased as you go.

## [Unreleased]

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
