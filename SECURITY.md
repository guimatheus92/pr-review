# Security Policy

## Supported versions

Only the latest release on `main` is supported.

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities. Report them
privately via [GitHub security advisories](../../security/advisories/new).

You can expect an initial response within a week. Please include reproduction
steps and the impact you believe the issue has.

## Scope notes

- pr-review handles PR data (diffs, comments, tokens) from GitHub and Azure
  DevOps. Anything that could leak auth tokens, execute untrusted PR content,
  or post to unintended targets is in scope.
- Existing PR comments are injected into reviewer context deliberately fenced
  as untrusted content; bypasses of that fence are in scope.
