# pr-review

Generic, plugin-based PR review tool for GitHub and Azure DevOps, packaged as a plugin for Copilot CLI or Claude Code. Orchestrates parallel reviewer agents in a single agent session via the `task` tool (Copilot) / `Task` tool (Claude Code), and posts **every** finding back to the PR as a resolvable inline review thread.

## Build & test

```bash
npm run build          # tsc + esbuild → dist/cli.cjs
npm run test           # node scripts/test.mjs → node --test over tests/*.test.ts (110 tests, ~600ms)
npm run build:watch    # tsc watch (re-run `npm run bundle` for esbuild)
```

The bundle at `dist/cli.cjs` is the single-file distribution artifact. The slash command (`commands/pr-review.md`) finds it via `$CLAUDE_PLUGIN_ROOT/dist/cli.cjs` under Claude Code (falling back to `~/.copilot/installed-plugins/`) and runs `node "$CLI" review $ARGUMENTS`.

## Architecture

**Two-layer model:** slash command → Node CLI → single agent session (Copilot CLI or Claude Code) dispatching reviewer agents via `task()` / `Task()`.

- `src/cli.ts` — commander entry, subcommand routing
- `src/commands/review.ts` — main pipeline: gather → early-exit → single-session dispatch → dedupe → post. `--resume <id>` skips dispatch and replays the on-disk reviewer outputs through the shared `finalizeReview` tail; `finalizeReview` also writes the `posted.marker` idempotency guard
- `src/commands/status.ts` / `src/commands/detach.ts` — `status <run-id>` (live progress / summary / resume hint) and `review --detach` (spawn a detached background run) — the slash command starts detached and polls `status` so a slow run survives the host's ~10-min Bash timeout
- `src/dispatch/single-session.ts` — writes PR context file + per-reviewer `skills-<reviewer>.md` files, builds orchestrator prompt (single source of the reviewer output contract), spawns one runtime process. `parseFindingsFile` + `REVIEWER_OUTPUT_FILES` (reused by `--resume`) and the 60s heartbeat that feeds `progress.ndjson` live here
- `src/dispatch/runtime.ts` — runtime selection (resolveRuntime, runtimeSpawnArgs, taskCall, normalizeModel); `--runtime copilot|claude|auto` (default auto: probes PATH, copilot first)
- `src/util/progress.ts` / `src/util/posted-marker.ts` — the `progress.ndjson` phase/heartbeat live feed and the `posted.marker` re-post guard (refuses re-post only on a fully-completed prior post; fail-closed on a corrupt marker)
- `src/dispatch/codex.ts` — optional Codex second-opinion reviewer; runs as a sibling process in parallel with the orchestrator session when the `codex` CLI is installed (opt out: `--no-codex`)
- `src/dispatch/line-snap.ts` — snaps finding line numbers to the nearest valid diff line before posting
- `src/providers/github.ts` / `azuredevops.ts` — PR data fetchers + comment posters (GitHub inline comments go out as one review batch, with per-comment fallback)
- `src/dispatch/parsers.ts` — JSON / bracketed-markdown / section-header output parsers
- `src/dedupe.ts` — Jaccard token similarity, strict/loose/off modes
- `src/config.ts` — 5-level config merge (flags > env > repo yaml > global yaml > defaults)
- `src/util/retry.ts` — retry/backoff helper for transient posting errors
- `src/plugins/loader.ts` — discovers skills from standard paths (.claude/skills, .copilot/skills, .agents/skills, etc.)
- `src/plugins/companions.ts` — detects installed companion plugins (pr-review-toolkit, code-review); copilot via `copilot plugin list`, claude via `~/.claude/plugins/installed_plugins.json`
- `agents/*.md` — 7 built-in reviewer agents registered as `pr-review:<name>`; no `model:` in frontmatter — they inherit the session model (required for cross-runtime operation)

## Key conventions

- **No repo pollution.** All run artifacts go to `~/.pr-review/runs/<id>/`. Never write files to the user's working directory.
- **Clean output.** Posted comments contain only the finding body — no severity prefix, no bot chrome. Summary findings also render body-only, separated by `---`.
- **Inline-only posting, nothing dropped.** On a publish run every finding lands as a resolvable inline review thread (GitHub review comments, ADO threads) — never a top-level issue comment. Lines outside the diff are snapped to the nearest valid diff line; findings that can't anchor where they point (file outside the diff, or no location) are re-anchored to the first valid diff line with the original `file:line` kept in the body. `skipped` exists only for `--dry-run`. Never reintroduce an `issues.createComment` fallback.
- **Skills, not reviewers.** User-authored content goes in `.pr-review/skills/` (injected as context into built-in reviewers). Standalone reviewers are the exception, not the default.
- **Single session.** All reviewers dispatch in one runtime process (copilot or claude) via `task()` / `Task()`. Never spawn N separate sessions. The only sibling process is the optional Codex second-opinion reviewer.
- **Stack-agnostic built-ins.** The 7 agents in `agents/*.md` must never reference specific frameworks. Stack-specific rules belong in user skills.
- **esbuild bundle.** `dist/cli.cjs` is a single-file zero-dependency bundle. No `npm install` needed at the plugin install site.

## Testing

Tests use `node:test` + `node:assert`. Run with `npm run test`. Tests are in `tests/` mirroring `src/` structure. Provider tests require real auth env vars; pure-logic tests have no external deps.

## Common tasks

- **Add a built-in reviewer:** Create `agents/<name>.md`, add to `BUILTIN_AGENTS` array in `src/dispatch/single-session.ts`, rebuild.
- **Add a provider:** Implement `PrProvider` from `src/providers/types.ts`, wire in `src/providers/index.ts`.
- **Change config defaults:** Edit `src/config.ts` `DEFAULTS` object.
- **Change auto-discovery paths:** Edit `autodiscoveryPaths()` in `src/config.ts`.
- **Change dedupe behavior:** Edit `src/dedupe.ts`. Threshold constants are at the top.
- **Change diff exclusions:** Edit `DEFAULT_EXCLUDES` in `src/dispatch/diff-filter.ts`.
- **Change runtime spawn args or model mapping:** Edit `src/dispatch/runtime.ts`.
- **Change Codex reviewer behavior:** Edit `src/dispatch/codex.ts`.
- **Preview reviewer context:** `pr-review review <url> --context-only` — writes pr-context.md + per-reviewer skills files, prints the skill→reviewer routing table, exits without spawning the runtime.
- **Resume a killed run:** `pr-review review <url> --resume <run-id>` — replays the on-disk reviewer outputs through dedupe + post (skips the expensive dispatch). The `posted.marker` makes a repeat resume refuse to re-post (`--force-post` overrides).
- **Run in the background / check a run:** `pr-review review <url> --detach` returns a run-id immediately; `pr-review status <run-id>` shows the live progress feed, or the summary once done. This is how the slash command avoids the host's ~10-min Bash timeout.
- **Check the environment:** `pr-review doctor` — runtimes on PATH, resolved runtime/model, codex + companions, provider auth, config sources.
- **Cut a release:** `node scripts/release.mjs <patch|minor|major|x.y.z>` — bumps every manifest, verifies no stale version string, rolls CHANGELOG, rebuilds, commits and tags (push left to you).
