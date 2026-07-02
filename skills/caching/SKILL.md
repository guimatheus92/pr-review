---
description: "pr-review caching: gather cache, response cache, invalidation, bypass flags, and management commands. Use when asked about caching behavior, stale data, cache clearing, or why a re-run is fast."
---

# Caching

## What's cached

| Layer | Location | Key | Invalidation |
|---|---|---|---|
| PR metadata (gather) | `~/.pr-review/cache/<provider>/<owner__repo>/<n>/` | `<headSha>-<lastCommentId>.json` | New commit or new comment |
| Per-reviewer LLM responses | `~/.pr-review/cache/responses/` | `<reviewer>-<prompt-sha>.json` | Different prompt (new diff, new skill content) |

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
| `--no-response-cache` | Skip per-reviewer response cache (always re-run reviewers) |

## Design notes

- Gather cache hits save ~5-10s per run (skips API calls).
- Response cache is keyed by prompt SHA, not PR URL. A new commit changes the diff which changes the prompt which auto-busts the cache.
- Run artifacts (orchestrator prompt, raw outputs, findings JSON, summary) go to `~/.pr-review/runs/<id>/` — these are not cached, just persisted for debugging.
