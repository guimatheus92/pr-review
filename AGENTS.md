# pr-review

Generic, plugin-based PR review tool for GitHub, Azure DevOps, and GitLab, packaged as a plugin for Copilot CLI or Claude Code. Orchestrates parallel reviewer agents in a single agent session via the `task` tool (Copilot) / `Task` tool (Claude Code), and posts **every** finding back to the PR as a resolvable inline review thread.

## Build & test

```bash
npm run build          # tsc + esbuild → dist/cli.cjs
npm run test           # node scripts/test.mjs → node --test over tests/**/*.test.ts (270 tests, ~5s)
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
- `src/providers/github.ts` / `azuredevops.ts` / `gitlab.ts` — PR data fetchers + comment posters (GitHub inline comments go out as one review batch — ONE attempt, `runPost` owns retry because only it can reconcile — with per-comment fallback; GitLab posts per-discussion via plain fetch)
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
- **A failed write is not proof that nothing was written.** POSTing a comment is not idempotent, so a 5xx/timeout means *unknown*: the server can commit and lose the response. The rules that follow from that, all in `src/commands/post.ts`:
  - **Providers make ONE attempt and throw** — `postLineComment` and `postBatchComments`, on all three providers. `withRetry` is for **reads** and other idempotent calls only. Retry lives in `runPost`, because only `runPost` can reconcile first.
  - **Read the PR back before deciding anything** — before a retry, before the per-comment fallback, and before reporting a count (`readLanded`/`claim`).
  - **Unknown ≠ empty.** `readLanded` returns `null` when the read fails, and a `null` must never be treated as "nothing landed": the outage that 504s a write is the one that fails the read. On `null` the run reports and stops rather than re-issuing — re-issuing is how 3 findings became 15 live comments in one reviewed scenario.
  - **Identity is `file:line:body`, not body.** Two findings can legitimately carry the same body (`dedupeWithinBatch` only folds same-file, ±3 lines), and a body-only match promotes a finding that was never posted — which then fills `posted.marker` and locks `--resume` out of recovering it. Comments with no file are never ours (inline-only invariant).
  - **Reconciliation is one-way** — errors may be promoted to posted, never the reverse. Demoting on a stale read would mark a live comment un-posted and make the next `--resume` write it twice.
  - **Every publish attempt writes `posted.marker`**, carrying `verified`. An unverified run fails closed on resume like a corrupt marker. Gating the write on `posted > 0` is what left the incident run with no guard at all.
  - **`--resume` re-reads the PR before deduping** (on `--dry-run` too), unions rather than overwrites, and adopts only comments matching a finding it would post — so a bystander's comment can never suppress a finding. A failed re-read aborts a *publishing* resume.
  - Every reconciliation test asserts `assertNoDuplicateComments`: no path may leave two comments at the same location with the same text.
  This is not theoretical: a 504-after-commit turned 56 findings into 112 comments while the run reported `posted 0 / errors 56`.
- **The CLI is the ONLY writer — dispatched agents never post.** Every dispatch prompt (built-in reviewers, companion agents, companion slash commands, verifier, and the orchestrator itself) carries `NO_POSTING_DIRECTIVE` from `src/dispatch/single-session.ts`, and a session-context test fails if any dispatch line loses it. This is not theoretical: the official `code-review` companion's command allows `gh pr comment` and instructs posting a top-level "### Code review" verdict — a live run posted one (Preco-Pratico/PrecoPratico-Backend#586) before the directive existed. When adding ANY new dispatch path, thread the directive through it.
- **Skills, not reviewers.** User-authored review content lives in the standard tool skill dirs (`.claude/`, `.copilot/`, `.github/`, `.agents/`, each under `skills/`); per PR the tool auto-injects the ones relevant to the changed files (matched on `name` + `description`) and catalogs the rest. `applies_to`/`inject_into` frontmatter is optional refinement, not a requirement. Standalone reviewers are the exception, not the default.
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

## Maintaining the built-in reviewers

The 7 `agents/*.md` are the generic review criteria shared by every project. Keeping them healthy over time:

- **Project- or stack-specific rules never go in `agents/`.** They belong in a skill (in a tool skill dir — `.claude/skills/` etc. — injected when relevant to the PR, optionally pinned with `applies_to`/`inject_into`). The built-ins stay stack-agnostic *by construction* — the standalone-reviewer load path is disabled on the review path, so the only way project context enters a review is via skills. A framework name hardcoded into an agent would still slip through, though: **nothing greps for it yet** (see issue #5), so it's on human review.
- **When you do edit an agent, preserve the shared skeleton:** `## What to look for`, `## What NOT to flag`, `## Severity guidelines` (CRITICAL → HIGH → MEDIUM → LOW → NIT), and the closing "state the rule and the concrete fix" line. The files have drifted (`quality.md` uses "What to flag"; `security.md` has no finding-format trailer) — don't add new drift.
- **There is no freshness/versioning mechanism.** Agents carry only `name` + `description` (no `model:`, no `version`, no `last-updated`), and `scripts/release.mjs` never touches `agents/`. Freshness is git history + review discipline. If a real production review *misses* something a built-in should have caught, note it; when misses accumulate, distill them into an eval fixture rather than blindly expanding a prompt. The eval harness + content-structure tests + stack-agnostic grep are deferred work tracked in issue #5.
