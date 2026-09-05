---
description: How to add a new PR hosting provider (e.g. GitLab, Bitbucket) to pr-review.
---

# Adding a PR Provider

## Steps

1. **Create provider file** at `src/providers/<name>.ts` implementing the `PrProvider` interface from `src/providers/types.ts`:
   - `parseUrl(url)` — extract owner, repo, PR number from the URL
   - `fetchMetadata(ref)` — title, author, description, labels, linked items; set `changedFileCount` whenever the API offers an exact count and `changedFileListTruncated` when it signals a cap (GitLab `"N+"`) — gather refuses a list of any other length and completes it from git
   - `fetchChangedFiles(ref)` — file paths, status, additions, deletions, patches. MUST paginate to completion (ADO `$top=2000` + `nextSkip`, GitHub `paginate.iterator`, GitLab `x-next-page`) and never return a first page as the list: an incomplete list is unknown, never empty, because it feeds the rule-trust and MCP gates
   - `fetchFullDiff(ref)` — may return `''`; nothing in the pipeline reads it (GitHub returns `''`: the diff media type 406s above 300 files)
   - `fetchExistingComments(ref)` — existing inline comments (for dedupe)
   - `postLineComment(ref, finding)` — post ONE inline comment at file:line. Makes a single attempt and throws; see step 4.
   - `isTransientError(err)` — required. Is this error worth another attempt? Delegate to your provider's own predicate (`isTransientGitHubError` etc.). `runPost` uses it to decide whether to re-issue a write after reconciling.

2. **Wire in detectProvider** — `src/providers/index.ts` detects in two tiers: known cloud hostnames, then the user's `hosts:` config map. There is deliberately NO path-shape guessing for unknown hosts — detection decides where the caller's credential is sent, so auto-trusting a PR-shaped path on an unknown host would let a crafted URL exfiltrate the token. Add the new provider's cloud hostname branch, its entry in `URL_SHAPES`, and widen `PROVIDERS` in `src/types.ts`.

3. **Teach `src/providers/identity.ts` the provider's remote forms.** `canonicalPrAuthority()` normalizes every URL shape a provider accepts — HTTPS, SSH, legacy hosts, encoded paths — onto ONE authority string. Two things depend on it: `cwdMatchesPr` (does this checkout belong to the PR? if not, its manifests and project rules are discarded) and the gather cache scope in `src/cache/keys.ts`. Miss a shape and a legitimate checkout silently loses its rules; make the authority too coarse and a same-name repo elsewhere supplies them. Include whatever sub-namespace the provider uses to disambiguate same-name repos (for Azure DevOps that is the project).

4. **Add auth** — document env var(s) in the provider file and in `README.md` Authentication table.

5. **Handle transient failures — do NOT retry writes inside the provider.** Posting a comment is not idempotent: a 5xx or timeout can arrive *after* the server committed it, so a blind retry duplicates the comment (or, in the field, trips the secondary rate limit precisely because the write succeeded). `postLineComment` and `postBatchComments` make **ONE attempt and throw**; `runPost` reads the PR back with `fetchExistingComments` and re-issues only what is genuinely missing. `withRetry` from `src/util/retry.ts` (schedule 2s/5s/15s) is for **reads and other idempotent calls** — the metadata/diff/comment fetches — not for writes. Finding lines are snapped to valid diff lines before posting via `src/dispatch/line-snap.ts` (`buildValidLinesMap` + `snapLineToDiff`); take the head SHA from gather metadata rather than re-fetching per finding.

6. **Test** — smoke test against a real PR on the new provider. Add a test file at `tests/providers/<name>.test.ts` (picked up by the `tests/**/*.test.ts` glob), and cover every accepted URL shape in `tests/parse-url.test.ts` — including the identity normalization, since that is where a wrong answer is silent rather than loud.

## Reference implementations

- GitHub: `src/providers/github.ts` — uses `@octokit/rest`, `gh auth token` fallback; posts inline comments as one batched review (`POST /pulls/:n/reviews`, event COMMENT), ONE attempt, with a per-comment fallback that `runPost` enters only after reconciling against the PR. `fetchExistingComments` forwards `since` to both list endpoints so a read-back is one page, not the PR's whole history; `fetchMetadata` carries `changed_files` as `changedFileCount` (`pulls/:n/files` stops at 3000 entries silently) and `fetchFullDiff` returns `''` (the diff media type 406s above 300 files)
- Azure DevOps: `src/providers/azuredevops.ts` — uses `azure-devops-node-api`, concurrent LCS diff synthesis; `createThread` makes one attempt (retry lives in `runPost`), and the PR object + git API are cached per run; iteration changes are paged to completion (`$top=2000`, `nextSkip`; a cursor that does not advance throws) and folder entries are dropped before any content fetch
- GitLab: `src/providers/gitlab.ts` — plain `fetch` against REST v4 (no client lib, no batch endpoint); `positionForLine` supplies `old_line` for context-line discussion positions (skipping it 400s); owner keeps namespace slashes, flattened by `safeOwner` for run-dir/cache names; `changes_count` is parsed — a numeric string is `changedFileCount`, `"N+"` sets `changedFileListTruncated` because `/diffs` serves exactly the capped set
