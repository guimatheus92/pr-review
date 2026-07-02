---
description: How to add a new PR hosting provider (e.g. GitLab, Bitbucket) to pr-review.
---

# Adding a PR Provider

## Steps

1. **Create provider file** at `src/providers/<name>.ts` implementing the `PrProvider` interface from `src/providers/types.ts`:
   - `parseUrl(url)` — extract owner, repo, PR number from the URL
   - `fetchMetadata(ref)` — title, author, description, labels, linked items
   - `fetchChangedFiles(ref)` — file paths, status, additions, deletions, patches
   - `fetchExistingComments(ref)` — existing inline comments (for dedupe)
   - `postLineComment(ref, finding)` — post an inline comment at file:line

2. **Wire in detectProvider** — add URL pattern matching in `src/providers/index.ts`.

3. **Add auth** — document env var(s) in the provider file and in `README.md` Authentication table.

4. **Handle transient failures** — wrap posting calls with the retry/backoff helper in `src/util/retry.ts` (schedule 2s/5s/15s) for transient rate-limit/5xx errors. Finding lines are snapped to valid diff lines before posting via `src/dispatch/line-snap.ts` (`buildValidLinesMap` + `snapLineToDiff`); take the head SHA from gather metadata rather than re-fetching per finding.

5. **Test** — smoke test against a real PR on the new provider. Add a test file at `tests/providers/<name>.test.ts` (picked up by the `tests/**/*.test.ts` glob).

## Reference implementations

- GitHub: `src/providers/github.ts` — uses `@octokit/rest`, `gh auth token` fallback; posts inline comments as one batched review (`POST /pulls/:n/reviews`, event COMMENT) with per-comment retry/backoff fallback on transient 422/403/5xx
- Azure DevOps: `src/providers/azuredevops.ts` — uses `azure-devops-node-api`, concurrent LCS diff synthesis; `createThread` has retry/backoff, and the PR object + git API are cached per run
