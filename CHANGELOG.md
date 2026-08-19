# Changelog

Notable changes, [keep-a-changelog](https://keepachangelog.com/en/1.1.0/) format. Rolled by `scripts/release.mjs` — put notes under Unreleased as you go.

## [Unreleased]

### Fixed
- **A lost response is no longer reported as a failed post — and `--resume` no longer duplicates a whole review.** In the field a 56-comment batch got a **504 after GitHub had already created the review**: the retry then hit the secondary rate limit *because* the write had succeeded, the batch read as failed, the per-comment fallback re-posted all 56 (422 each), and the run reported `posted 0 / attempted 56; errors 56` while every comment was live. Trusting that number, `--resume` posted a second copy — 112 comments, cleaned up by hand. Root cause: the poster treated an *unknown* outcome (5xx/timeout on a non-idempotent POST) as a *known* failure, an assumption written into a code comment claiming "a failed batch posted nothing". `createReview` is atomic on the server, but a gateway timeout loses the response, not the write. Now: `postBatchComments` makes **one** attempt and throws (retrying blind is what tripped the rate limit); `runPost` reads the PR back via the existing `fetchExistingComments` before it retries or falls back, and re-issues only what genuinely is not there; the final `posted`/`errors` is reconciled against the PR, so the number the user acts on reflects reality. Reconciliation is deliberately one-way — errors may be promoted to posted, never the reverse — because demoting on a stale read would mark a live comment un-posted and send the next resume out to write it again. With the count truthful, `posted.marker` gets written again and the resume idempotency guard works as designed. `--resume` also **re-reads the PR's comments** before deduping instead of trusting the pre-post gather snapshot, which is what made the already-published comments invisible. New `isTransientError?` on `PrProvider` exposes each provider's existing predicate so the poster can tell a retriable batch from a hopeless one. The regression tests use a fake with **server state** that can throw *having written* — the old fake decided ground truth by throwing, which is why no test could see this.
- **A failed Codex sibling now leaves something to debug.** `codex exec exited 1` with 0 findings was a dead end: stdout was discarded outright, stderr clipped to 300 chars and never persisted, and `codex-output.txt` — the file the debug skill points at — is exactly what an early exit never writes. stdout is now captured and any error path writes a full `codex-failure.log` (argv, exit, timing, complete stdout + stderr), mirroring the orchestrator's `orchestrator-failure.log`. The codex promise also gained a `.catch()`: `spawnCli` validates argv synchronously, so a run dir outside `SAFE_ARG_RE` (a non-ASCII Windows profile path) threw *inside* the promise executor — an unhandled rejection that killed the whole review instead of costing one reviewer.
- **Dispatched agents can no longer post to the PR on their own.** The official `code-review` companion's slash command allows `gh pr comment` and its instructions post a top-level "### Code review / No issues found" verdict — so the subagent invoking it posted a summary comment straight to the PR (observed live on a Backend PR), bypassing the CLI's inline-only, deduped, idempotent posting. Every dispatch prompt now carries a hard `NO_POSTING_DIRECTIVE` (built-in reviewers, companion agents, companion slash commands — which now run in explicit analysis-only mode with "skip the posting step" — the verifier, and the orchestrator itself), and a session-context test fails if any dispatch line ever loses it. The Codex sibling was already read-only sandboxed.

## [0.6.0] — 2026-08-12

### Added
- **Every real-world PR URL shape now parses.** URL parsing moved from per-shape regexes to `new URL()` + path-segment walking, anchored on `_git` for Azure DevOps: legacy `https://<org>.visualstudio.com/[<collection>/][<project>/]_git/…` (with or without `DefaultCollection` — the exact shape that failed in the field), the project-omitted `dev.azure.com/<org>/_git/<repo>/…` form, and trailing paths/query strings/fragments on both providers (`…/pull/42/files?diff=split`). The duplicated ADO host regexes (`URL_RES` vs `orgHost()`) collapsed into one parser that computes the org/collection URL once.
- **GitHub Enterprise Server and Azure DevOps Server (on-prem) URLs.** `PrRef` gained an optional `baseUrl` set by `parseUrl` (GHES: `https://<host>/api/v3`, fed to Octokit; ADO Server: `https://<host>/<virtualdir>/<collection>`, fed to the ADO connection); refs lacking it (older serialized caches) re-derive it from `ref.url`. Self-hosted hosts resolve **only** through the new `hosts:` config map (`<hostname>: github | azuredevops | gitlab`) — an explicit allowlist, never path-shape guessing, so a credential is only ever sent to a host the user named; the unrecognized-URL error prints the exact yaml to add. GHES auth is host-scoped: `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` or `gh auth token --hostname <host>` — github.com env tokens are deliberately never sent to an enterprise host. Cloud cache keys and run-dir names are byte-identical to before (guarded by a test).
- **GitLab provider.** Merge-request URLs (`https://gitlab.com/<group>[/<subgroup>]/<project>/-/merge_requests/<iid>`, legacy no-`/-/` form, and self-managed hosts via the `hosts:` map) now review end to end: MR metadata + linked closes-issues, per-file diffs (paginated `/diffs`), existing notes for dedupe, and inline posting as resolvable discussions. Implemented with plain `fetch` against REST v4 — zero new dependencies. Auth: `GITLAB_TOKEN` / `GITLAB_ACCESS_TOKEN`, with `glab config get token -h <host>` as the CLI fallback (sent as `Authorization: Bearer`, which accepts both PATs and glab OAuth tokens). Discussion positions carry `old_line` for context lines via dual-cursor hunk math (`positionForLine`) — the main cause of GitLab's 400 "position is invalid" — and unanchorable findings re-anchor like GitHub's instead of dropping. GitLab has no batch endpoint, so posting is per-discussion with the existing retry/backoff.

### Fixed
- **A bad PR URL now fails `--detach` immediately in the foreground** — with the accepted shapes listed and, for legacy `visualstudio.com` URLs, the canonical `dev.azure.com` tip — instead of handing back a run-id whose detached child dies minutes later with `status` exit 22 (the field incident). URL validation runs before the auth pre-flight and before the run dir is minted; the silent `adhoc__` run-dir fallback for unparsable URLs is gone (new `resolvePr()` choke point used by review, gather, post, cache, and detach).
- **Slashed owners (GitLab nested namespaces) no longer nest run dirs and cache paths.** `owner` keeps its namespace slashes in `PrRef` (the API needs the full path), but run-dir ids and cache paths flatten it via a shared `safeOwner` helper — without this, `ensureRunDir` minted a *nested* directory, `--detach` returned `basename()` of it as the run-id, and `status <run-id>` looked in the wrong place (every detached GitLab run would read as missing). GitHub/ADO names are unchanged.
- **`scripts/test.mjs` now discovers tests recursively** — `tests/providers/*.test.ts` was silently ignored by the flat `readdirSync`, despite `add-provider.md` promising the nested layout.
- **`ci-integration.md`'s ADO pipeline example built a doubled URL** (`https://dev.azure.com/` prefixed onto `System.TeamFoundationCollectionUri`, which already expands to that) — it now uses the variable directly.

## [0.4.2] — 2026-08-07

### Fixed
- **A pipeline failure is no longer reported as a clean review.** When the orchestrator produced no parseable findings (exit code 2), `finalizeReview` still wrote a normal zero-finding `pr-review-summary.md` and a `done` progress event — and `status` treats the summary's existence as "done, exit 0", so a detached run that failed presented as a clean PR. On `findingsUnavailable` the run now writes the failure to `error.txt` instead of minting the summary, emits an `error` progress event, and `status` reports `failed` (exit 22) with the message inline. Codex second-opinion findings collected before the failure are still posted, and the exit code stays 2.
- **Stdout salvage now recovers findings from a narrated orchestrator transcript.** The JSON parser extracted exactly one value — the first fenced block or the earliest `[`/`{`, which a prose bracket like `[security]` could win, defeating the whole parse. `parseJsonFindings` now merges findings from every JSON block in the blob (all fenced blocks, then every balanced value) and also understands the orchestrator's own `{"reviewers":[{"name":…,"findings":[…]}]}` file payload printed to stdout instead of written.
- **`orchestrator-failure.log` now keeps the orchestrator's full stdout/stderr** (was: last 8 KB tails). When the contract fails, stdout may hold the only copy of the reviewer findings, and a tail made even manual salvage impossible.

## [0.4.1] — 2026-08-06

### Fixed
- **`--detach` no longer dies in the background with a generic "No auth token available" when the credential CLI fallback (`gh` keyring / `az`) flakes in the detached child.** The parent now resolves the provider credential in the foreground *before* spawning — via a new provider `authEnv()` pre-flight — and injects it into the child env (`GITHUB_TOKEN`; `AZURE_DEVOPS_PAT`, or the new `AZURE_DEVOPS_BEARER` round-trip var so a bearer token isn't misread as a PAT). A missing credential now fails the launch immediately instead of killing the background run ~25s later.
- **Token-resolution failures are no longer swallowed.** Both providers now pipe the fallback CLI's stderr and include its exit code/stderr detail in the thrown message (`` `gh auth token` failed: … `` / `` `az account get-access-token` failed: … ``), so a future occurrence is diagnosable from `detached.log`.
- **A detached run that dies before producing findings now persists the fatal error** to `<run-dir>/error.txt`, and `status` surfaces it inline on a `failed` run instead of only pointing at `detached.log`.
- **The slash command's final summary no longer arrives truncated when the agent polls via a background watcher.** The prescribed poll loop (`sleep 25; status`) is blocked by current Claude Code, which pushed agents onto background/monitor notifications — a channel that caps long content and truncated the ~15 KB summary mid-paragraph. `commands/pr-review.md` now instructs the harness-compatible wait (background watcher such as Monitor; no chained foreground sleeps) and, on completion, tells the agent to read `<run-dir>/pr-review-summary.md` (or re-run `status` once in the foreground) instead of ever reproducing notification text. `status` with exit 0 also prints `summary file: <path>` on stderr, keeping stdout the verbatim summary while pointing agents at the file as source of truth.

## [0.4.0] — 2026-07-20

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
