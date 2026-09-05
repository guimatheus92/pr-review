---
description: How to debug a pr-review run that produced unexpected results (missing findings, parse errors, empty output, companion failures, "file list truncated" / provider count mismatch, stale cache entries).
---

# Debugging a Review Run

## Run artifacts

Every `pr-review review` writes artifacts to `~/.pr-review/runs/<provider>__<owner>__<repo>__<pr>__<timestamp>/`:

| File | Contains |
|---|---|
| `pr-review-gather.json` | Raw PR metadata, per-file patches, comments (`fullDiff` is empty on GitHub — nothing reads it); `changedFilesComplete` marks a verified file list |
| `pr-context.md` | The shared context file read by the review passes (not by the orchestrator itself) — includes the `## Stack` tags and a `## More skills (on-demand)` pointer to the index |
| `pass-<name>.md` | One file per dispatched pass: the pipeline rules header + ONE skill body + a `Source:` line retained for provenance. Referenced sibling files are not materialized automatically |
| `skills-project.md` | Post-selection shared project context, injected whole into every pass and also read by Codex, direct companion agents, and the verifier. In the no-pack fallback, only project skills beyond the 10-pass cap remain here |
| `skills-all.md` | Budgeted fallback union of selected pass bodies, written for Codex, direct companion agents, and the verifier only when no shared project context remains. The `code-review` slash companion receives neither file |
| `skills-index.md` | On-demand skill list: overflow past the pass cap, unmatched skills, and index-mode packs. Passes read relevant entries — indexed ≠ ignored |
| `verifier.md` | The verifier's role brief, written whenever the verifier is enabled; the direct verifier session runs only for HIGH/CRITICAL Phase 1 findings |
| `orchestrator-prompt.md` | The full orchestrator prompt with task()/Task() dispatch instructions |
| `reviewer-attempts/<reviewer>/attempt-N.json` | Exact `Finding[]` written by each Phase 1 task or direct verifier attempt. Missing/invalid attempts are the selective-recovery input |
| `raw-<name>.json` | Write-once canonical `Finding[]` promoted by Node from a valid attempt; tasks never write canonical sidecars directly |
| `codex-attempts/attempt-N.json` | Exact output file for each reserved Codex sibling attempt |
| `codex-failure.log` | Bounded stdout/stderr, argv, exit code, and timing when the Codex sibling errors |
| `phase1-findings.json` | Node-assembled complete Phase 1 inventory; the direct verifier reads it when HIGH/CRITICAL findings require verification |
| `single-session-findings.json` | Node-assembled Phase 1 plus verifier output. Codex remains a separate reviewer output merged later for dedupe/post |
| `dispatch-plan.json` / `delivery-state.json` | Diagnostic mirrors of the immutable plan and reviewer/Codex/verifier state; authenticated recovery authority lives under `~/.pr-review/control/` |
| `stack.json` | The detected stack as selection saw it: languages, ecosystems, dependencies, dependency tokens/groups, notes |
| `companions.json` | Every installed plugin, the ones pr-review recognizes, planned vs completed dispatches, and any missing/duplicate reviewer names. Written even on an early exit, so "planned 7 / completed 0" is visible |
| `capabilities.json` / `capability-<pass>.json` | MCP server inventory (repo / user / plugin) and, per installed-plugin pass, which servers were available, attempted, and actually used |
| `.mcp.json` | Trusted repository MCP definitions normalized for the isolated run (absent when the repo declares none, or when the PR changed them). **Provenance for the run**: claude ignores it (`--strict-mcp-config`, no `--mcp-config`); under copilot the same servers are denied by name via `--disable-mcp-server`, built from this inventory — so the file is not loaded as config, but the `disabledMcpServers` plumbing that mirrors it is load-bearing, not dead weight |
| `error.txt` | Written for handled failures after run-directory setup, including failed prerequisites, incomplete delivery, and post-delivery operational failures. Command-level exceptions may leave it absent; stderr is authoritative then |
| `posted.marker` | Written on every publish attempt, carrying `verified`; the guard that stops `--resume` re-posting |
| `passes.json` | One row per known skill — `[{name, source, matchedBy}]` where `matchedBy` is `glob`, `dependency`, `tag`, `plugin`, `repo`, `forced`, `baseline`, `context`, `index`, or `skipped` — persisted at dispatch so `--resume` can still render the summary's Skills section |
| `pr-review-findings.json` | Final findings after dedupe |
| `pr-review-summary.md` | The rendered summary — a `## Skills` section (pass table + on-demand index count) and the findings |

## Common issues

**Exit code 2 / no findings produced:**
1. Exit code 2 has four surfaces:
   - **Command-level exception:** gather/auth/config/runtime/finalization threw; stderr is authoritative and run artifacts, including `error.txt`, are not guaranteed.
   - **Prerequisite/no-pass failure:** `runReview` writes `error.txt` before reviewer delivery and may have no `delivery-state.json` or summary.
   - **Incomplete delivery:** a planned pass, companion, required verifier, or enabled Codex did not produce valid attempt-scoped `Finding[]` within its bounded attempts; inspect `delivery-state.json` and attempt files.
   - **Post-delivery operational failure:** complete reviewer output exists, but posting failed or could not be verified; inspect `error.txt` and the summary's Degraded block.
2. For incomplete delivery, check `delivery-state.json`, then the named reviewer's latest `reviewer-attempts/.../attempt-N.json`. `single-session-findings.json` exists only after Node completes primary consolidation.
3. Check stderr output for `[single-session]` messages.
4. Read `orchestrator-prompt.md` to verify the dispatch instructions look correct.
5. With `--runtime auto` (the default), the CLI probes PATH for `copilot` then `claude` and errors if neither is found — pass `--runtime <name>` or set `PR_REVIEW_RUNTIME` to pin one.
6. Remember the triage rules: docs-only PRs run only glob/forced passes (never baseline), and the verifier runs only when Phase 1 has a CRITICAL/HIGH finding — a "missing" pass may have been deliberately skipped (it's logged, and `passes.json` records it as `skipped`).
7. No candidate passes at selection is exit 2 for any PR, with `error.txt` and the "nothing to review with — no skills matched" message. A docs-only PR exits 0 only when candidate passes existed and docs-only triage removed all of them. Check `packs list` (are the packs cloned/synced?) and `pr-review packs suggest <url>`.
8. The early-exit gate (no title, oversized PR) now exits **2** with `error.txt`, not 0 with a summary — a failed prerequisite is not a clean review.
9. Exit **0** does not mean zero findings. Without `--fail-on`, retained findings do not change the status; stderr says how many were retained and why the code is 0.

**`file list truncated` (exit 2; `error.txt` in detached mode):**
1. The provider listed fewer (or more) files than the PR has — GitHub's `pulls/:n/files` stops at 3000 silently, GitLab reports `changes_count: "N+"` when its stored diff overflowed — and the run could not complete the list from git. The message names the counts and the exact fix.
2. Completion needs the current directory to be a checkout of the PR's repository (remote `origin`, same project on ADO) with both `baseSha` and `headSha` present. Run the `git fetch` the message prints (`git fetch origin <base> refs/pull/N/head`, `refs/merge-requests/N/head`, or the ADO branches) in that checkout and re-run; pr-review never fetches for you.
3. Also refused, by design: a history with two merge bases (criss-cross — git and the provider may diff against different ancestors) and a shallow clone. Nothing is cached until the list is complete; a successful completion logs `[gather] … completed K file(s) from git at <root>`.
4. A cache entry written before 0.11 has no `changedFilesComplete` marker and is refetched once (`[gather] cache entry predates the file-list completeness check`); that is expected after upgrading, not a fault.

**Parse errors:**
1. Check the specific reviewer's latest `reviewer-attempts/.../attempt-N.json`; invalid attempts are not promoted to `raw-<name>.json`.
2. Planned reviewer delivery requires an exact top-level `Finding[]` JSON array.
3. The legacy consolidated-output parsers in `src/dispatch/parsers.ts` still cover JSON, bracketed Markdown, and section headers for replay compatibility.

**Companion failures:**
1. Read `companions.json` first — it separates *installed*, *recognized*, *planned*, and *completed*. `plannedDispatches: 7` (six `pr-review-toolkit` agents + one `code-review` slash command) with fewer completed rows is the signal; `missingReviewers` / `duplicateReviewers` name exactly which.
2. A planned companion that delivered nothing is incomplete delivery (exit 2), not a quiet gap. A companion that is simply *not installed* is recorded as degraded coverage instead.
3. `detectionWarning` in `companions.json` means installation state is **unknown** (the probe failed) — that is deliberately not the same as "none installed".
4. Look for `companion:` entries with `✗` status in the summary.
5. Companion tasks share the orchestrator session's 30-minute process timeout. If they consistently time out, try `--no-companions`.
6. Verify companion is installed: `pr-review doctor`.

**Dedupe dropping valid findings:**
1. Compare `pr-review-findings.json` (after dedupe) with `single-session-findings.json`, the canonical `raw-*.json` files, and any valid Codex attempt (before dedupe).
2. Try `--dedupe-mode off` to see all raw findings.
3. The Jaccard threshold is 0.6 for strict mode — edit `src/dedupe.ts` if needed.

**Codex reviewer missing or empty:**
1. Codex runs only when the `codex` CLI is installed (detected via `codex --version`); if not installed it's silently skipped with a stderr note.
2. Check it wasn't opted out: `--no-codex`, `invoke_codex: false`, `PR_REVIEW_NO_CODEX=1`, or `--skip codex`.
3. Read `codex-failure.log` first — it carries the argv, exit code, and bounded stdout/stderr. If the run produced output, inspect the reserved `codex-attempts/attempt-N.json`; accepted findings appear under reviewer name `codex` in `pr-review-findings.json`.
4. `codex exec` exiting **0** with no output is reported as an errored reviewer, not as "found nothing" — it is contracted to print `[]` when it finds nothing, so an empty result means the output file was never written.

**A skill not running as a pass:**
1. Run `pr-review review <url> --context-only` — prints the `## Stack` (languages, dependencies) and the `## Passes` table (`| Pass | Matched by | Matched on | Source |`) without spawning the runtime (the passes line shows "+ codex (sibling process)" when codex would run).
2. Check `pass-<name>.md` in the run dir; watch stderr for malformed-frontmatter warnings naming the file. `inject_into` is deprecated — it only prints a warning and is ignored (`applies_to` still routes).
3. A skill missing from the pass table may be in `skills-index.md` instead (overflow past the stack-pass cap, no stack match, or an index-mode pack) — passes still read it on demand. `passes.json` records every known skill with its `matchedBy`. Baseline passes are exempt from the cap: they always dispatch on a code PR.
4. **A repo rule the PR itself changed is dropped on purpose.** Branch-authored instructions cannot tell reviewers how to judge their own change, so the rule is excluded from both `skills-project.md` and `skills-index.md`, stderr says `skipped N project rule(s) — changed by this PR, reached through a link it changed, or not committed in their home repository`, and the summary's Degraded block names the lost coverage. The same goes for a link (symlink or junction) the PR added or changed: it is refused before anything behind it is read — stderr says `skipped link <path>: added or changed by this PR — not followed` and the Degraded block names it. Configured dirs (`--skills-dir`, `extra_skills_dirs`, `PR_REVIEW_SKILLS_DIR`) are selected like repo skill dirs and go through the same trust check; `--force-skill <file|dir>` is the only bypass (per run, CLI only — no yaml or env key), and `--skill <file>` does not bypass it (it preserves the file's declared scope and stays subject to trust).
5. A product-specific pack skill that no longer fires may be correct: selection is evidence-tiered, so a guide cannot qualify from a bare language (`**/*.cs`) or a generic manifest (`package.json`, `*.csproj`) alone — it needs a matching dependency, and product identity tokens must co-occur in ONE dependency group. Check `stack.json` for what evidence was actually found.
6. Pack skills need the pack on disk: `pr-review packs list` shows clone state and freshness; `pr-review packs sync` clones/pulls and refreshes the Linguist cache (stack tags come from it — a missing cache weakens tag matching).
7. A `.md` under a `skills/` subdirectory with no `SKILL.md` is not a skill — stderr says `<dir> has no SKILL.md — its .md files are not loaded as skills`. Add a `SKILL.md` to that directory, or keep loose rule files under `rules/` or `instructions/` (those roots still recurse). A `README.md` directory entry is never a skill either (an explicit `--skill README.md` path still loads).
8. A skill reached through a link outside the checkout is used only when it is committed and clean in its home git repository (a `SKILL.md` needs its whole directory clean) — stderr says `skipped <name>: untracked in its home repository — commit it to use it` (or `dirty`). A link met inside a linked directory is not followed (`one hop only`), and a directory under no repository at all is trusted as local configuration with a one-line `not under version control` note.

**Cache serving stale data:**
1. `pr-review cache info` shows what's cached.
2. `pr-review cache clear --pr <url>` clears for one PR.
3. `--no-cache` bypasses the gather cache.
