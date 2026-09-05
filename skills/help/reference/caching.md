---
description: "pr-review caching: gather cache, invalidation, bypass flags, and management commands. Use when asked about caching behavior, stale data, cache clearing, or why a re-run is fast."
---

# Caching

## What's cached

| Layer | Location | Key | Invalidation |
|---|---|---|---|
| PR metadata (gather) | `~/.pr-review/cache/<provider>/<scope>/<n>/` | `<headSha>-<lastCommentId>.json` | New commit or new comment |
| Linguist languages.yml | `~/.pr-review/cache/linguist-languages.yml` | — (auto-downloaded on first review) | Refreshed by `pr-review packs sync` |
| Skill pack clones | `~/.pr-review/packs/<name>/` | pack name | `pr-review packs sync` pulls; >30 days without a sync warns on every review |
| Per-reviewer LLM responses | `~/.pr-review/cache/responses/` | `<reviewer>-<prompt-sha>.json` | **Unused by the single-session review path** — passes run as `task()` agents inside one session, so there is no per-pass response to cache |

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
- A gather whose file list could not be verified complete is never cached: gather completes it from the local checkout or throws before the cache write. Entries carry `changedFilesComplete`; an entry without it was written before 0.11 (an Azure DevOps entry may hold only the first 100 files of a larger PR) and is refetched once, then rewritten in place — no `cache clear` needed.
- GitHub/GitLab cache scope is `<owner__repo>`. Azure DevOps scope is `<organization__project__repo>`; an unresolved ADO project bypasses the cache rather than sharing data across same-name repositories.
- Clearing a project-omitted ADO URL removes every project-scoped entry whose cached PR identity matches that organization, repository, and PR number.
- The per-reviewer response cache was removed; only stale files may remain under `responses/` until `pr-review cache clear`.
- Run artifacts (`pr-context.md`, pass files, plan/state mirrors, `reviewer-attempts/`, canonical raw outputs, Phase 1/final findings, `reviewer-progress.ndjson`, summary) go to `~/.pr-review/runs/<id>/`. Recovery and posting authority is HMAC-authenticated separately under `~/.pr-review/control/`; neither surface is the gather cache.
