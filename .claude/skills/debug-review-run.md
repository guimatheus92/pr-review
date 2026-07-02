---
description: How to debug a pr-review run that produced unexpected results (missing findings, parse errors, empty output, companion failures).
---

# Debugging a Review Run

## Run artifacts

Every `pr-review review` writes artifacts to `~/.pr-review/runs/<provider>__<owner>__<repo>__<pr>__<timestamp>/`:

| File | Contains |
|---|---|
| `pr-review-gather.json` | Raw PR metadata, diff, comments |
| `pr-context.md` | The context file sent to the orchestrator |
| `orchestrator-prompt.md` | The full orchestrator prompt with task() dispatch instructions |
| `single-session-findings.json` | Raw consolidated findings from the orchestrator |
| `raw-<reviewer>.json` | Per-reviewer parsed findings |
| `pr-review-findings.json` | Final findings after dedupe |
| `pr-review-summary.md` | The rendered summary |

## Common issues

**No findings produced:**
1. Check `single-session-findings.json` — was it created? If not, the copilot session failed.
2. Check stderr output for `[single-session]` messages.
3. Read `orchestrator-prompt.md` to verify the dispatch instructions look correct.

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

**Cache serving stale data:**
1. `pr-review cache info` shows what's cached.
2. `pr-review cache clear --pr <url>` clears for one PR.
3. `--no-cache --no-response-cache` bypasses everything.
