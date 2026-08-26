---
description: How to test pr-review changes locally — unit tests, end-to-end runs, and plugin installation verification.
---

# Testing Locally

## Unit tests

```bash
npm run test
```

`scripts/test.mjs` enumerates `tests/**/*.test.ts` recursively (node 20-safe), including `tests/providers/` — see AGENTS.md for the current count. Coverage: glob matching, output parsers (JSON, bracketed-markdown, section-header), dedupe (Jaccard similarity, strict/loose/off), diff filtering, frontmatter parsing, config merge, line snapping (`tests/line-snap.test.ts`), pass selection (`tests/pass-select.test.ts`), session context (`tests/session-context.test.ts`), stack detection, skill packs (`tests/packs-*.test.ts`), and the loader (`tests/loader.test.ts`).

## Pass routing (fast, no runtime spawn)

```bash
node ./dist/cli.js review <pr-url> --context-only
```

Prepares `pr-context.md` + the per-pass `pass-<name>.md` files in the run dir and prints the `## Stack` (languages, dependencies, notes) and the `## Passes` table (`| Pass | Matched by | Matched on | Source |`) plus the on-demand index count — without spawning the runtime. The passes line shows "+ codex (sibling process)" when the Codex second-opinion reviewer would run. Exits 2 when zero passes match a code PR. This is the fastest way to verify a skill runs as the pass you expect.

Pack-sourced passes need the packs on disk: run `pr-review packs sync` first (clones/pulls all configured packs + refreshes the Linguist cache that feeds tag matching).

## Dogfood the local branch (no PR needed)

```bash
npm run build                                          # dogfood refuses a stale bundle
npm run dogfood -- --base origin/main
npm run dogfood -- --base origin/main --include-untracked   # also review new, non-ignored files
npm run dogfood -- --base origin/main --context-only        # routing only, while tuning passes
```

Converts the whole branch/working-tree diff into a synthetic `GatherOutput` under `~/.pr-review/runs/` and drives the real bundled CLI with `--from-gather --dry-run`. This is the fastest honest end-to-end check: gather -> stack detection -> pass selection -> dispatch -> dedupe, with no remote PR and nothing written into the working directory.

Limits worth knowing: URL-based companions are disabled (a synthetic local PR has no URL for them to consume), so exercise companions on a real-PR dry-run instead. Untracked files need the explicit `--include-untracked`, and even then secret-bearing names and high-confidence credential content are refused before any artifact is written — including the old path of a tracked rename.

## End-to-end (against a real PR)

```bash
# Build first
npm run build

# Dry run (no posting)
node ./dist/cli.js review <pr-url> --dry-run

# With specific options — --skip takes pass names (full or bare suffix), plus verifier/codex
node ./dist/cli.js review <pr-url> --skip verifier --no-companions --dry-run
node ./dist/cli.js review <pr-url> --skip awesome-copilot/go --dry-run   # full pass name
node ./dist/cli.js review <pr-url> --skip go --dry-run                   # bare suffix, same pass
node ./dist/cli.js review <pr-url> --dedupe-mode off --dry-run   # see all raw findings
node ./dist/cli.js review <pr-url> --runtime claude --dry-run    # force the Claude Code runtime
node ./dist/cli.js review <pr-url> --no-codex --dry-run          # skip the Codex second-opinion reviewer
```

Exit codes: `0` the pipeline completed — **not** "no findings": without `--fail-on`, retained findings leave the status at 0 and stderr says how many. `1` findings at/above the `--fail-on` threshold. `2` a pipeline error (no parseable findings, zero passes on a code PR) **or** an operational failure of an otherwise parseable review (failed prerequisite, a planned pass/companion that delivered no `raw-<reviewer>.json` or delivered two, a post that failed or could not be verified) — read `error.txt` and the summary's Degraded block.

## Eval harness (real runtime, synthetic PRs)

```bash
node scripts/eval.mjs [case]   # omit the case to run all; cases are the dir names under evals/fixtures/
```

Builds a gather JSON from `evals/fixtures/<case>/diff.patch`, runs `dist/cli.cjs review` with `--from-gather --dry-run`, and evaluates `expected.yaml` through `scripts/eval-assertions.mjs`. Supported keys:

| Key | Asserts |
|---|---|
| `must_find` | each regex matches at least one finding |
| `must_not_find` | no finding matches — a case may be **negative-only** |
| `distinct_findings` | `must_find` regexes must be satisfied by *different* findings, so one generic finding cannot pass two expectations |
| `must_dispatch` / `must_not_dispatch` | pass routing actually selected (or refused) these skills |
| `stack.include` / `stack.exclude` | detected language/ecosystem tags |
| `dependencies.include` / `dependencies.exclude` | dependency names parsed from the fixture's manifests |

Fixtures come in causal pairs: `<case>` is the defective diff and `<case>-safe` is the corrected control carrying the same regexes under `must_not_find`. A positive-only fixture would still pass if the diff were so broken that anything got flagged; the pair is what proves the finding tracks the defect. Synthetic fixtures also disable URL-based companions. Requires `npm run build` + `pr-review packs sync` first.

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
node ./dist/cli.js plugins list           # repo skills + per-pack skill counts
node ./dist/cli.js doctor                 # runtimes, codex, companion install state + dispatch count, packs, auth
node ./dist/cli.js packs list             # pack clone state, skill counts, freshness
node ./dist/cli.js config show            # effective config + source of each setting
```
