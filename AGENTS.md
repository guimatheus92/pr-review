# pr-review

Generic, plugin-based PR review tool for GitHub, Azure DevOps, and GitLab, packaged as a plugin for Copilot CLI or Claude Code. Orchestrates parallel review passes — each one a skill applied by a generic agent — in a single agent session via the `task` tool (Copilot) / `Task` tool (Claude Code), and posts **every** finding back to the PR as a resolvable inline review thread.

## Build & test

```bash
npm run build          # tsc + esbuild → dist/cli.cjs
npm run test           # node scripts/test.mjs → node --test over tests/**/*.test.ts (325 tests, ~5s)
npm run build:watch    # tsc watch (re-run `npm run bundle` for esbuild)
```

The bundle at `dist/cli.cjs` is the single-file distribution artifact. The slash command (`commands/pr-review.md`) finds it via `$CLAUDE_PLUGIN_ROOT/dist/cli.cjs` under Claude Code (falling back to `~/.copilot/installed-plugins/`) and runs `node "$CLI" review $ARGUMENTS`.

## Architecture

**Two-layer model:** slash command → Node CLI → single agent session (Copilot CLI or Claude Code) dispatching review passes as generic agents (`subagent_type`/`agent_type` `general-purpose`) via `task()` / `Task()`.

- `src/cli.ts` — commander entry, subcommand routing
- `src/commands/review.ts` — main pipeline: gather → early-exit → stack detection + pass selection → single-session dispatch → dedupe → post. `--resume <id>` skips dispatch and replays the on-disk pass outputs through the shared `finalizeReview` tail (reading `passes.json` for the summary's Skills section; old runs without it just omit the section); `finalizeReview` also writes the `posted.marker` idempotency guard
- `src/commands/status.ts` / `src/commands/detach.ts` — `status <run-id>` (live progress / summary / resume hint) and `review --detach` (spawn a detached background run) — the slash command starts detached and polls `status` so a slow run survives the host's ~10-min Bash timeout
- `src/dispatch/single-session.ts` — writes `pr-context.md`, one `pass-<name>.md` per dispatched pass (`PASS_RULES` header + one skill body + `Source:` line), `skills-all.md` (union read by codex/companions/verifier), `skills-index.md` (on-demand list), `verifier.md` (`VERIFIER_BRIEF`), and the `passes.json` routing record; builds the orchestrator prompt (single source of the pass output contract), spawns one runtime process. `parseFindingsFile` + `REVIEWER_OUTPUT_FILES` (reused by `--resume`) and the 60s heartbeat that feeds `progress.ndjson` live here
- `src/dispatch/runtime.ts` — runtime selection (resolveRuntime, runtimeSpawnArgs, taskCall, normalizeModel); `--runtime copilot|claude|auto` (default auto: probes PATH, copilot first)
- `src/util/progress.ts` / `src/util/posted-marker.ts` — the `progress.ndjson` phase/heartbeat live feed and the `posted.marker` re-post guard (refuses re-post only on a fully-completed prior post; fail-closed on a corrupt marker)
- `src/dispatch/codex.ts` — optional Codex second-opinion reviewer; runs as a sibling process in parallel with the orchestrator session when the `codex` CLI is installed (opt out: `--no-codex`)
- `src/dispatch/line-snap.ts` — snaps finding line numbers to the nearest valid diff line before posting
- `src/providers/github.ts` / `azuredevops.ts` / `gitlab.ts` — PR data fetchers + comment posters (GitHub inline comments go out as one review batch — ONE attempt, `runPost` owns retry because only it can reconcile — with per-comment fallback; GitLab posts per-discussion via plain fetch)
- `src/dispatch/parsers.ts` — JSON / bracketed-markdown / section-header output parsers
- `src/dedupe.ts` — Jaccard token similarity, strict/loose/off modes
- `src/config.ts` — 5-level config merge (flags > env > repo yaml > global yaml > defaults)
- `src/util/retry.ts` — retry/backoff helper for transient posting errors
- `src/packs/sync.ts` / `load.ts` — skill packs: clone/pull configured git repos into `~/.pr-review/packs/<name>/` (fail-soft; >30 days without `packs sync` warns on every review) and load their skill files per `include`/`exclude` globs
- `src/stack/linguist.ts` / `manifests.ts` / `detect.ts` — stack detection: GitHub Linguist `languages.yml` (auto-downloaded to `~/.pr-review/cache/`, refreshed on `packs sync`) tags changed files by language; dependency names parsed from manifests only when cwd's git origin is the PR's repo; plus manifest-kind ecosystem tags
- `src/dispatch/pass-select.ts` — pass selection ranked forced > repo (your own skills, targeted or heuristic) > pack glob > pack tag > baseline, `MAX_PASSES=10` cap; extension-only pack globs (`**/*.ts`) count only for stack-consistent skills; overflow + unmatched + index-mode packs go to `skills-index.md`
- `src/commands/packs.ts` — `packs list` / `packs sync` / `packs add` / `packs suggest` subcommands
- `src/plugins/loader.ts` — discovers skills from standard paths (.claude/skills, .copilot/skills, .agents/skills, etc.)
- `src/plugins/companions.ts` — detects installed companion plugins (pr-review-toolkit, code-review); copilot via `copilot plugin list`, claude via `~/.claude/plugins/installed_plugins.json`

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
- **The CLI is the ONLY writer — dispatched agents never post.** Every dispatch prompt (review passes, companion agents, companion slash commands, verifier, and the orchestrator itself) carries `NO_POSTING_DIRECTIVE` from `src/dispatch/single-session.ts`, and a session-context test fails if any dispatch line loses it. This is not theoretical: the official `code-review` companion's command allows `gh pr comment` and instructs posting a top-level "### Code review" verdict — a live run posted one (Preco-Pratico/PrecoPratico-Backend#586) before the directive existed. When adding ANY new dispatch path, thread the directive through it.
- **Passes, not reviewers.** Every review pass is ONE skill applied by a generic agent — no reviewer `.md` is ever dispatched. Pass names are `<pack>/<skill>` (repo skills keep their plain name). Knowledge comes from skill packs (git repos cloned to `~/.pr-review/packs/<name>/`, configured via `skill_packs` — the one yaml key that REPLACES rather than pushes, so `[]` disables packs and a repo list overrides the global one entirely) plus the standard tool skill dirs (`.claude/`, `.copilot/`, `.github/`, `.agents/`, each under `skills/`). `src/dispatch/pass-select.ts` picks up to 10 passes (forced > repo (your own skills, targeted or heuristic) > pack glob > pack tag > baseline; a pack skill whose only glob is a bare extension wildcard must also carry stack identity in its name/tags — awesome-copilot framework guides all claim `**/*.ts`); everything else lands in `skills-index.md` for on-demand reading. `applies_to`/`applyTo` frontmatter routes; `inject_into` is deprecated (stderr warning, then ignored).
- **Single session.** All passes dispatch in one runtime process (copilot or claude) via `task()` / `Task()`. Never spawn N separate sessions. The only sibling process is the optional Codex second-opinion reviewer.
- **Stack-agnostic prompts.** The prompt text this repo still ships (`PASS_RULES`, `VERIFIER_BRIEF`, the codex prompt) must never reference specific frameworks — stack knowledge enters a review only through skills. Enforced by a denylist grep in `tests/zero-passes.test.ts`.
- **esbuild bundle.** `dist/cli.cjs` is a single-file zero-dependency bundle. No `npm install` needed at the plugin install site.

## Testing

Tests use `node:test` + `node:assert`. Run with `npm run test`. Tests are in `tests/` mirroring `src/` structure. Provider tests require real auth env vars; pure-logic tests have no external deps.

## Common tasks

- **Add/curate a skill pack:** Edit `DEFAULT_PACKS` in `src/config.ts` (entry: git source + `include`/`exclude` globs, optional `ref`/`mode`/`baseline`), or per-user via `skill_packs:` in yaml (remember: it replaces the whole list) / `pr-review packs add <owner/repo|url>` (materializes the defaults first, then appends and clones).
- **Sync packs:** `pr-review packs sync` — clones/pulls every configured pack and refreshes the Linguist cache. Needed once per machine before the eval harness; >30 days without it warns on every review.
- **Run the eval harness:** `node scripts/eval.mjs [case]` — needs `npm run build`, a real runtime on PATH, and synced packs; fixtures in `evals/fixtures/` (diff.patch + expected.yaml `must_find` regexes).
- **Add a provider:** Implement `PrProvider` from `src/providers/types.ts`, wire in `src/providers/index.ts`.
- **Change config defaults:** Edit `src/config.ts` `DEFAULTS` object.
- **Change auto-discovery paths:** Edit `autodiscoveryPaths()` in `src/config.ts`.
- **Change dedupe behavior:** Edit `src/dedupe.ts`. Threshold constants are at the top.
- **Change diff exclusions:** Edit `DEFAULT_EXCLUDES` in `src/dispatch/diff-filter.ts`.
- **Change runtime spawn args or model mapping:** Edit `src/dispatch/runtime.ts`.
- **Change Codex reviewer behavior:** Edit `src/dispatch/codex.ts`.
- **Preview pass selection:** `pr-review review <url> --context-only` — writes pr-context.md + per-pass files, prints the `## Stack` block (languages, dependencies, notes) and the `## Passes` table (Pass | Matched by | Matched on | Source) + index count, exits without spawning the runtime (exit 2 when zero passes on a code PR).
- **Resume a killed run:** `pr-review review <url> --resume <run-id>` — replays the on-disk pass outputs through dedupe + post (skips the expensive dispatch). The `posted.marker` makes a repeat resume refuse to re-post (`--force-post` overrides).
- **Run in the background / check a run:** `pr-review review <url> --detach` returns a run-id immediately; `pr-review status <run-id>` shows the live progress feed, or the summary once done. This is how the slash command avoids the host's ~10-min Bash timeout.
- **Check the environment:** `pr-review doctor` — runtimes on PATH, resolved runtime/model, codex + companions, provider auth, skill packs (git on PATH, per-pack state/freshness, Linguist cache), config sources.
- **Cut a release:** `node scripts/release.mjs <patch|minor|major|x.y.z>` — bumps every manifest, verifies no stale version string, rolls CHANGELOG, rebuilds, commits and tags (push left to you).

## Maintaining review quality

The review knowledge lives in skill packs, not in this repo. Keeping quality up over time:

- **Packs own the knowledge.** The defaults (`DEFAULT_PACKS` in `src/config.ts`) point at upstream repos; `pr-review packs sync` pulls them, and a pack unsynced for >30 days warns on every review. Baseline pointers (each pack's `baseline:` skill list) break loudly, not silently: a pointer that no longer resolves surfaces as a `missingBaseline` warning — fix the pointer when upstream renames or removes a file, don't let it rot.
- **A real production miss becomes an eval fixture.** If a review misses something it should have caught, distill the miss into `evals/fixtures/<case>/` (diff.patch + expected.yaml `must_find` regexes) rather than expanding prompt text, then prove the pipeline catches it with `node scripts/eval.mjs <case>` (needs `npm run build`, a real runtime, and synced packs).
- **The remaining prompt text stays stack-agnostic.** `PASS_RULES`, `VERIFIER_BRIEF`, and the codex prompt must never name a framework — `tests/zero-passes.test.ts` greps a denylist over them, so a hardcoded framework name fails the suite. Stack-specific rules belong in a pack or a repo skill.
