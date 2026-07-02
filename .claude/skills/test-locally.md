---
description: How to test pr-review changes locally — unit tests, end-to-end runs, and plugin installation verification.
---

# Testing Locally

## Unit tests

```bash
npm run test
```

`scripts/test.mjs` enumerates `tests/*.test.ts` (node 20-safe) — 110 tests covering: glob matching, output parsers (JSON, bracketed-markdown, section-header), dedupe (Jaccard similarity, strict/loose/off), diff filtering, frontmatter parsing, config merge, line snapping (`tests/line-snap.test.ts`), session context / skills routing (`tests/session-context.test.ts`), and the loader (`tests/loader.test.ts`).

## Skills routing (fast, no runtime spawn)

```bash
node ./dist/cli.js review <pr-url> --context-only
```

Prepares `pr-context.md` + the per-reviewer `skills-<reviewer>.md` files in the run dir and prints the skill→reviewer routing table — without spawning the runtime. The reviewers line shows "+ codex (sibling process)" when the Codex second-opinion reviewer would run. This is the fastest way to verify a skill routes to the reviewers you expect.

## End-to-end (against a real PR)

```bash
# Build first
npm run build

# Dry run (no posting)
node ./dist/cli.js review <pr-url> --dry-run

# With specific options
node ./dist/cli.js review <pr-url> --skip verifier --no-companions --dry-run
node ./dist/cli.js review <pr-url> --dedupe-mode off --dry-run   # see all raw findings
node ./dist/cli.js review <pr-url> --runtime claude --dry-run    # force the Claude Code runtime
node ./dist/cli.js review <pr-url> --no-codex --dry-run          # skip the Codex second-opinion reviewer
```

Exit codes: `0` clean, `1` findings at/above the `--fail-on` threshold, `2` pipeline error (no parseable findings).

## Testing gather only

```bash
node ./dist/cli.js gather <pr-url>
# Output goes to ~/.pr-review/runs/<id>/pr-review-gather.json
```

## Testing post only

```bash
# Use findings from a previous run
node ./dist/cli.js post <pr-url> --findings ~/.pr-review/runs/<id>/pr-review-findings.json --dry-run
node ./dist/cli.js post <pr-url> --findings <path>            # actually post (default)
```

## Plugin installation test

```bash
# From inside a copilot OR claude session, with cwd at the repo root:
/plugin marketplace add .
/plugin install pr-review@pr-review
/pr-review --help
```

The plugin layout loads in both hosts; under Claude Code the slash command finds the bundle via `$CLAUDE_PLUGIN_ROOT/dist/cli.cjs`.

## Verifying what would run

```bash
node ./dist/cli.js plugins list           # shows all loaded reviewers + skills
node ./dist/cli.js plugins doctor         # companion plugin install state
node ./dist/cli.js config show            # effective config + source of each setting
```
