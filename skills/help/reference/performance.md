---
description: "pr-review performance optimizations: diff exclusion, file pre-filtering, single-session dispatch, caching, prefix stability, early-exit gates, and size limits. Use when asked about performance, speed, cost, token usage, or why large PRs are rejected."
---

# Performance

## Built-in optimizations

| # | Optimization | Impact |
|---|---|---|
| 1 | **Diff exclusion** — lockfiles, generated code, vendor dirs stripped before any pass sees them | Highest — big PRs are often 80% noise |
| 2 | **Pass selection** — evidence-tiered matching against the detected stack (specific glob > manifest dependency > language-consistent weak glob > tag) picks at most 6 stack passes; everything else goes to the on-demand index instead of a prompt. Baseline pointers are contractual and ride on top of that ceiling, so the real total is typically ~13 | High — smaller prompts = faster + cheaper |
| 3 | **Single-session dispatch** — one runtime process (copilot or claude) dispatches all passes via `task()` / `Task()` | High — avoids N cold starts (~42% faster) |
| 4 | **Parallel dispatch** — all passes run concurrently within the session; the optional Codex second-opinion reviewer runs as a sibling process in parallel with the whole session (adds no wall-clock when it's not the slowest) | High — wall-clock = slowest pass, not sum |
| 5 | **Docs-only triage** — deterministic Node-side triage runs only glob/forced passes (never baseline) when all in-scope files are docs (`**/*.md`, `**/*.txt`, `docs/**`, etc.) | High on docs PRs — skips the baseline passes |
| 6 | **Conditional verifier** — dispatched only when Phase 1 has ≥1 CRITICAL/HIGH finding | Saves one agent on clean PRs |
| 7 | **Parallel gather** — metadata + comments fetched concurrently; comments not fetched twice on cache miss; GitHub linked issues fetched in parallel; review + issue comment pagination runs concurrently; no provider fetches a whole-PR text diff (the per-file patches are the diff), so GitHub PRs of 300–500 files no longer die on the API's 406 and Azure DevOps spends no `getCommitDiffs` call | Medium — faster gather phase |
| 8 | **Concurrent ADO diff synthesis** — per-file diffs synthesized with p-limit(5); LCS trims common prefix/suffix lines before the DP matrix | Medium on large ADO PRs |
| 9 | **Deduped prompt boilerplate** — the output contract lives only in the dispatch prompt, not repeated per agent | Medium — smaller prompts |
| 10 | **Prefix-stable prompts** — pass-invariant prompt prefix enables provider-side prompt cache hits | Medium — can reduce token cost ~75% |
| 11 | **Batched GitHub posting** — inline comments go as one review (`POST /pulls/:n/reviews`); head SHA comes from gather metadata (no per-finding `pulls.get`) | Medium — fewer API calls, fewer rate-limit hits |
| 12 | **Early-exit gate** — malformed/oversized PRs abort before spending tokens | Saves big when it fires |
| 13 | **Gather cache** — re-runs skip API calls if PR hasn't changed | ~5-10s saved per cache hit |

One-time cost worth knowing: the first review on a machine clones the configured skill packs (~1-2 min, needs git + network) and downloads the Linguist `languages.yml` stack-detection cache; both are reused afterwards and refreshed by `pr-review packs sync`.

## Limits

| Guard | Default | Effect |
|---|---|---|
| Max files | 500 | PRs with >500 changed files abort with "split into smaller PRs" |
| Max patch size | 2 MB | Total diff bytes across all in-scope files |
| Provider file-list caps | GitHub 3000 (`pulls/:n/files`), GitLab `"N+"` overflow, Azure DevOps paged 2000/page to completion | A list of any other length than the provider's own count, or one the provider declares truncated, is completed from the local checkout (`git diff-tree` from the single merge base — the checkout must be the PR's repository with base and head already present; pr-review never fetches). When that is impossible the run fails before anything is cached, naming the counts and the `git fetch` to run |

## Diff exclusion defaults

Lockfiles (`package-lock.json`, `yarn.lock`, etc.), generated code (`*.designer.cs`, `*.g.cs`), vendor directories, and binary files are stripped automatically. Add custom patterns via `diff_excludes` in `.pr-review.yaml`.

## Triage today, and what's deferred

Implemented: deterministic triage in Node — docs-only PRs run only glob/forced passes, never baseline (skipped passes are logged), and the verifier runs only when Phase 1 produced a CRITICAL/HIGH finding.

Deferred: hotspot two-phase triage (a cheap broad pass identifies hotspot files, then expensive deep-dive passes only run on those). Waiting for production data showing large-PR runs are slow despite the above optimizations.
