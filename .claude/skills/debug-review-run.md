---
description: How to debug a pr-review run that produced unexpected results (missing findings, parse errors, empty output, companion failures).
---

# Debugging a Review Run

## Run artifacts

Every `pr-review review` writes artifacts to `~/.pr-review/runs/<provider>__<owner>__<repo>__<pr>__<timestamp>/`:

| File | Contains |
|---|---|
| `pr-review-gather.json` | Raw PR metadata, diff, comments |
| `pr-context.md` | The shared context file read by the reviewer agents (not by the orchestrator itself) |
| `skills-<reviewer>.md` | Per-reviewer skill context (one file per reviewer that had skills routed to it) |
| `skills-codex.md` | Skill context routed to the Codex second-opinion reviewer (when it runs) |
| `orchestrator-prompt.md` | The full orchestrator prompt with task()/Task() dispatch instructions |
| `codex-output.txt` | Raw output of the Codex second-opinion reviewer (sibling `codex exec` process) |
| `phase1-findings.json` | Phase 1 findings; the verifier reads this when it's dispatched (only on CRITICAL/HIGH) |
| `single-session-findings.json` | Raw consolidated findings from the orchestrator |
| `raw-<reviewer>.json` | Per-reviewer parsed findings |
| `pr-review-findings.json` | Final findings after dedupe |
| `pr-review-summary.md` | The rendered summary |

## Common issues

**Exit code 2 / no findings produced:**
1. Exit code 2 means the orchestrator produced no parseable findings — this is no longer a silent exit 0. Stdout salvage is attempted automatically before giving up.
2. Check `single-session-findings.json` — was it created? If not, check the tail of the orchestrator's stdout.
3. Check stderr output for `[single-session]` messages.
4. Read `orchestrator-prompt.md` to verify the dispatch instructions look correct.
5. With `--runtime auto` (the default), the CLI probes PATH for `copilot` then `claude` and errors if neither is found — pass `--runtime <name>` or set `PR_REVIEW_RUNTIME` to pin one.
6. Remember the triage rules: docs-only PRs dispatch only the `quality` reviewer, and the verifier runs only when Phase 1 has a CRITICAL/HIGH finding — a "missing" reviewer may have been deliberately skipped (it's logged).

**Parse errors:**
1. Check `raw-<reviewer>.json` for the specific reviewer.
2. The parsers in `src/dispatch/parsers.ts` try JSON first, then bracketed-markdown, then section-headers.
3. Run `npm run test` — the parser tests cover all three formats.

**Companion failures:**
1. Look for `companion:` entries with `✗` status in the summary.
2. Companions timeout at 20 minutes. If they consistently time out, try `--no-companions`.
3. Verify companion is installed: `pr-review plugins doctor`.

**Dedupe dropping valid findings:**
1. Compare `pr-review-findings.json` (after dedupe) vs `single-session-findings.json` (before).
2. Try `--dedupe-mode off` to see all raw findings.
3. The Jaccard threshold is 0.6 for strict mode — edit `src/dedupe.ts` if needed.

**Codex reviewer missing or empty:**
1. Codex runs only when the `codex` CLI is installed (detected via `codex --version`); if not installed it's silently skipped with a stderr note.
2. Check it wasn't opted out: `--no-codex`, `invoke_codex: false`, `PR_REVIEW_NO_CODEX=1`, or `--skip codex`.
3. Inspect `codex-output.txt` in the run dir for the raw output; its findings appear under reviewer name `codex`.

**Skills not reaching a reviewer:**
1. Run `pr-review review <url> --context-only` — prints the skill→reviewer routing table without spawning the runtime (the reviewers line shows "+ codex (sibling process)" when codex would run).
2. Check `skills-<reviewer>.md` in the run dir; watch stderr for truncation warnings (16 KB per skill body, 64 KB per file) or malformed-frontmatter warnings naming the file.

**Cache serving stale data:**
1. `pr-review cache info` shows what's cached.
2. `pr-review cache clear --pr <url>` clears for one PR.
3. `--no-cache` bypasses the gather cache.
