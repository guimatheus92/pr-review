---
description: "pr-review caching: gather cache, invalidation, bypass flags, and management commands. Use when asked about caching behavior, stale data, cache clearing, or why a re-run is fast."
---

# Caching

## What's cached

| Layer | Location | Key | Invalidation |
|---|---|---|---|
| PR metadata (gather) | `~/.pr-review/cache/<provider>/<owner__repo>/<n>/` | `<headSha>-<lastCommentId>.json` | New commit or new comment |
| Per-reviewer LLM responses | `~/.pr-review/cache/responses/` | `<reviewer>-<prompt-sha>.json` | **Unused by the single-session review path** — reviewers run as `task()` agents inside one session, so there is no per-reviewer response to cache |

On a gather cache miss, the existing comments fetched to compute the cache key are reused for the run — they are not fetched twice.

## Commands

```bash
pr-review cache info                 # show cache location and size
pr-review cache clear --pr <url>     # clear cache for one PR
pr-review cache clear --all          # clear everything
```

## Bypass flags

| Flag | Effect |
|---|---|
| `--no-cache` | Skip gather cache (always re-fetch metadata) |

## Design notes

- Gather cache hits save ~5-10s per run (skips API calls). The key is `headSha` + last comment id, so a new commit or comment auto-busts it.
- The per-reviewer response cache was removed; only stale files may remain under `responses/` until `pr-review cache clear`.
- Run artifacts (orchestrator prompt, `pr-context.md`, per-reviewer `skills-<reviewer>.md` files, `phase1-findings.json`, raw outputs, findings JSON, summary) go to `~/.pr-review/runs/<id>/` — these are not cached, just persisted for debugging.
