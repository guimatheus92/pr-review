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

4. **Test** — smoke test against a real PR on the new provider. Add a test file at `tests/providers/<name>.test.ts`.

## Reference implementations

- GitHub: `src/providers/github.ts` — uses `@octokit/rest`, `gh auth token` fallback
- Azure DevOps: `src/providers/azuredevops.ts` — uses `azure-devops-node-api`, LCS diff synthesis
