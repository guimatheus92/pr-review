---
description: How to debug a pr-review run that produced unexpected results (missing findings, parse errors, empty output, companion failures).
---

# Debugging a Review Run

## Run artifacts

Every `pr-review review` writes artifacts to `~/.pr-review/runs/<provider>__<owner>__<repo>__<pr>__<timestamp>/`:

| File | Contains |
|---|---|
| `pr-review-gather.json` | Raw PR metadata, diff, comments |
| `pr-context.md` | The shared context file read by the review passes (not by the orchestrator itself) — includes the `## Stack` tags and a `## More skills (on-demand)` pointer to the index |
| `pass-<name>.md` | One file per dispatched pass: the pipeline rules header + ONE skill body + a `Source:` line (so relative `references/` resolve) |
| `skills-all.md` | Union of all pass bodies — read by the Codex sibling, companion agents, and the verifier |
| `skills-index.md` | On-demand skill list: overflow past the pass cap, unmatched skills, and index-mode packs. Passes read relevant entries — indexed ≠ ignored |
| `verifier.md` | The verifier's role brief (written when the verifier will be dispatched) |
| `orchestrator-prompt.md` | The full orchestrator prompt with task()/Task() dispatch instructions |
| `codex-output.txt` | Raw output of the Codex second-opinion reviewer (sibling `codex exec` process) |
| `codex-failure.log` | argv, exit code, timing, and full stdout + stderr when the Codex sibling errored (mirrors `orchestrator-failure.log`). This is the one that exists when `codex-output.txt` does not — an early exit never writes the output file |
| `phase1-findings.json` | Phase 1 findings; the verifier reads this when it's dispatched (only on CRITICAL/HIGH) |
| `single-session-findings.json` | Raw consolidated findings from the orchestrator |
| `raw-<name>.json` | **The sidecar contract.** Every dispatched pass and companion writes its own findings array here *before returning*, so a run survives an orchestrator whose turn ends after the tasks finish. The CLI recovers only from a COMPLETE set; a missing or invalid one is an operational failure, never a clean empty review |
| `stack.json` | The detected stack as selection saw it: languages, ecosystems, dependencies, dependency tokens/groups, notes |
| `companions.json` | Every installed plugin, the ones pr-review recognizes, planned vs completed dispatches, and any missing/duplicate reviewer names. Written even on an early exit, so "planned 7 / completed 0" is visible |
| `capabilities.json` / `capability-<pass>.json` | MCP server inventory (repo / user / plugin) and, per installed-plugin pass, which servers were available, attempted, and actually used |
| `.mcp.json` | Trusted repository MCP definitions normalized for the isolated run (absent when the repo declares none, or when the PR changed them) |
| `error.txt` | Written on any failure — a failed prerequisite, an unparseable review, or an operational failure. Its presence is what makes `status` report failed instead of done |
| `posted.marker` | Written on every publish attempt, carrying `verified`; the guard that stops `--resume` re-posting |
| `passes.json` | One row per known skill — `[{name, source, matchedBy}]` where `matchedBy` ∈ glob\|tag\|repo\|forced\|baseline\|index\|skipped — persisted at dispatch so `--resume` can still render the summary's Skills section |
| `pr-review-findings.json` | Final findings after dedupe |
| `pr-review-summary.md` | The rendered summary — a `## Skills` section (pass table + on-demand index count) and the findings |

## Common issues

**Exit code 2 / no findings produced:**
1. Exit code 2 has two distinct causes. **Pipeline failure:** the orchestrator produced no parseable findings (stdout salvage is attempted automatically before giving up). **Operational failure:** the review parsed fine but a delivery contract broke — a planned pass or companion produced no `raw-<reviewer>.json` (or two), a post failed or could not be verified, or a review prerequisite failed. Read `error.txt` and the summary's Degraded block: an operational failure still writes a diagnostic summary with the findings that did parse.
2. Check `single-session-findings.json` — was it created? If not, check the tail of the orchestrator's stdout.
3. Check stderr output for `[single-session]` messages.
4. Read `orchestrator-prompt.md` to verify the dispatch instructions look correct.
5. With `--runtime auto` (the default), the CLI probes PATH for `copilot` then `claude` and errors if neither is found — pass `--runtime <name>` or set `PR_REVIEW_RUNTIME` to pin one.
6. Remember the triage rules: docs-only PRs run only glob/forced passes (never baseline), and the verifier runs only when Phase 1 has a CRITICAL/HIGH finding — a "missing" pass may have been deliberately skipped (it's logged, and `passes.json` records it as `skipped`).
7. Zero passes at all: a docs-only PR exits 0 with an explanatory summary; a code PR exits 2 with `error.txt` and the "nothing to review with — no skills matched" message — check `packs list` (are the packs cloned/synced?) and `pr-review packs suggest <url>`.
8. The early-exit gate (no title, oversized PR) now exits **2** with `error.txt`, not 0 with a summary — a failed prerequisite is not a clean review.
9. Exit **0** does not mean zero findings. Without `--fail-on`, retained findings do not change the status; stderr says how many were retained and why the code is 0.

**Parse errors:**
1. Check `raw-<name>.json` for the specific pass.
2. The parsers in `src/dispatch/parsers.ts` try JSON first, then bracketed-markdown, then section-headers.
3. Run `npm run test` — the parser tests cover all three formats.

**Companion failures:**
1. Read `companions.json` first — it separates *installed*, *recognized*, *planned*, and *completed*. `plannedDispatches: 7` (six `pr-review-toolkit` agents + one `code-review` slash command) with fewer completed rows is the signal; `missingReviewers` / `duplicateReviewers` name exactly which.
2. A planned companion that delivered nothing is an operational failure (exit 2), not a quiet gap. A companion that is simply *not installed* is recorded as degraded coverage instead.
3. `detectionWarning` in `companions.json` means installation state is **unknown** (the probe failed) — that is deliberately not the same as "none installed".
4. Look for `companion:` entries with `✗` status in the summary.
5. Companions timeout at 20 minutes. If they consistently time out, try `--no-companions`.
6. Verify companion is installed: `pr-review doctor`.

**Dedupe dropping valid findings:**
1. Compare `pr-review-findings.json` (after dedupe) vs `single-session-findings.json` (before).
2. Try `--dedupe-mode off` to see all raw findings.
3. The Jaccard threshold is 0.6 for strict mode — edit `src/dedupe.ts` if needed.

**Codex reviewer missing or empty:**
1. Codex runs only when the `codex` CLI is installed (detected via `codex --version`); if not installed it's silently skipped with a stderr note.
2. Check it wasn't opted out: `--no-codex`, `invoke_codex: false`, `PR_REVIEW_NO_CODEX=1`, or `--skip codex`.
3. Read `codex-failure.log` first — on an early exit (a rejected flag, an unusable run dir) `codex-output.txt` was never written, and the failure log carries the argv, the exit code, and the full stdout/stderr. If the run got far enough to produce output, inspect `codex-output.txt`; its findings appear under reviewer name `codex`.
4. `codex exec` exiting **0** with no output is reported as an errored reviewer, not as "found nothing" — it is contracted to print `[]` when it finds nothing, so an empty result means the output file was never written.

**A skill not running as a pass:**
1. Run `pr-review review <url> --context-only` — prints the `## Stack` (languages, dependencies) and the `## Passes` table (`| Pass | Matched by | Matched on | Source |`) without spawning the runtime (the passes line shows "+ codex (sibling process)" when codex would run).
2. Check `pass-<name>.md` in the run dir; watch stderr for malformed-frontmatter warnings naming the file. `inject_into` is deprecated — it only prints a warning and is ignored (`applies_to` still routes).
3. A skill missing from the pass table may be in `skills-index.md` instead (overflow past the stack-pass cap, no stack match, or an index-mode pack) — passes still read it on demand. `passes.json` records every known skill with its `matchedBy`. Baseline passes are exempt from the cap: they always dispatch on a code PR.
4. **A repo rule the PR itself changed is dropped on purpose.** Branch-authored instructions cannot tell reviewers how to judge their own change, so the rule is excluded from both `skills-project.md` and `skills-index.md`, stderr says `skipped N project rule(s) changed by this PR`, and the summary's Degraded block names the lost coverage. `--force-skill <file>` is the deliberate override; `--skill <file>` is not (it preserves the file's declared scope).
5. A product-specific pack skill that no longer fires may be correct: selection is evidence-tiered, so a guide cannot qualify from a bare language (`**/*.cs`) or a generic manifest (`package.json`, `*.csproj`) alone — it needs a matching dependency, and product identity tokens must co-occur in ONE dependency group. Check `stack.json` for what evidence was actually found.
6. Pack skills need the pack on disk: `pr-review packs list` shows clone state and freshness; `pr-review packs sync` clones/pulls and refreshes the Linguist cache (stack tags come from it — a missing cache weakens tag matching).

**Cache serving stale data:**
1. `pr-review cache info` shows what's cached.
2. `pr-review cache clear --pr <url>` clears for one PR.
3. `--no-cache` bypasses the gather cache.
