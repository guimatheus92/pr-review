---
description: "pr-review performance optimizations: diff exclusion, file pre-filtering, single-session dispatch, caching, prefix stability, early-exit gates, and size limits. Use when asked about performance, speed, cost, token usage, or why large PRs are rejected."
---

# Performance

## Built-in optimizations

| # | Optimization | Impact |
|---|---|---|
| 1 | **Diff exclusion** — lockfiles, generated code, vendor dirs stripped before any reviewer sees them | Highest — big PRs are often 80% noise |
| 2 | **Per-reviewer file pre-filtering** — `applies_to` globs scope what each reviewer sees | High — smaller prompts = faster + cheaper |
| 3 | **Single-session dispatch** — one `copilot` process dispatches all reviewers via `task()` | High — avoids N cold starts (~42% faster) |
| 4 | **Parallel dispatch** — all reviewers run concurrently within the session | High — wall-clock = slowest reviewer, not sum |
| 5 | **Response cache** — same prompt reuses cached output | High for dev iteration |
| 6 | **Prefix-stable prompts** — reviewer-invariant prompt prefix enables provider-side prompt cache hits | Medium — can reduce token cost ~75% |
| 7 | **Early-exit gate** — malformed/oversized PRs abort before spending tokens | Saves big when it fires |
| 8 | **Gather cache** — re-runs skip API calls if PR hasn't changed | ~5-10s saved per cache hit |

## Limits

| Guard | Default | Effect |
|---|---|---|
| Max files | 500 | PRs with >500 changed files abort with "split into smaller PRs" |
| Max patch size | 2 MB | Total diff bytes across all in-scope files |

## Diff exclusion defaults

Lockfiles (`package-lock.json`, `yarn.lock`, etc.), generated code (`*.designer.cs`, `*.g.cs`), vendor directories, and binary files are stripped automatically. Add custom patterns via `diff_excludes` in `.pr-review.yaml`.

## Deferred: two-phase triage

A cheap broad pass identifies hotspot files, then expensive deep-dive reviewers only run on those. Not implemented — waiting for production data showing large-PR runs are slow despite the above optimizations.
