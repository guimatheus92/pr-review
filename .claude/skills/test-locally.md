---
description: How to test pr-review changes locally — unit tests, end-to-end runs, and plugin installation verification.
---

# Testing Locally

## Unit tests

```bash
npm run test
```

59 tests covering: glob matching, output parsers (JSON, bracketed-markdown, section-header), dedupe (Jaccard similarity, strict/loose/off), diff filtering, frontmatter parsing, config merge.

## End-to-end (against a real PR)

```bash
# Build first
npm run build

# Dry run (no posting)
node ./dist/cli.js review <pr-url> --dry-run

# With specific options
node ./dist/cli.js review <pr-url> --skip verifier --no-companions --dry-run
node ./dist/cli.js review <pr-url> --dedupe-mode off --dry-run   # see all raw findings
```

## Testing gather only

```bash
node ./dist/cli.js gather <pr-url>
# Output goes to ~/.pr-review/runs/<id>/pr-review-gather.json
```

## Testing post only

```bash
# Use findings from a previous run
node ./dist/cli.js post <pr-url> --findings ~/.pr-review/runs/<id>/pr-review-findings.json --dry-run
node ./dist/cli.js post <pr-url> --findings <path> --publish   # actually post
```

## Plugin installation test

```bash
# From inside a copilot session, with cwd at the repo root:
/plugin marketplace add .
/plugin install pr-review@pr-review
/pr-review --help
```

## Verifying what would run

```bash
node ./dist/cli.js plugins list           # shows all loaded reviewers + skills
node ./dist/cli.js plugins doctor         # companion plugin install state
node ./dist/cli.js config show            # effective config + source of each setting
```
