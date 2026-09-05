---
name: acceptance
description: Test a PR review end to end and prove it honoured every guarantee in INVARIANTS.md. Use when asked to test/validate a review of a pull request, to check a finished run, or to run the 3-provider x 2-runtime acceptance matrix. Drives `pr-review verify` and `scripts/acceptance.mjs` — never hand-checks the guarantees.
---

# Testing a PR review

The checklist is a program, not prose. `pr-review verify` renders one row per
invariant in `INVARIANTS.md`, always the full list, and exits 2 on any FAIL —
so there is no version of this task where an item gets skipped by accident.
Your job is the judgment: read the FAIL rows, find out why, report honestly.

**Do not hand-check the guarantees.** If you find yourself reading a PR in the
browser to see whether a comment is inline, you have left the deterministic
path. Fix the check instead.

## Steps

Run these in order. Do not skip a step because the previous one looked fine.

1. **Build.** `npm run build`
   `verify` and the matrix drive `dist/cli.cjs`, not `src/`. A stale bundle
   audits code that is not the code under test.

2. **Review the PR.**
   ```bash
   node dist/cli.cjs review <pr-url>            # posts
   node dist/cli.cjs review <pr-url> --dry-run  # previews
   ```
   Long runs: add `--detach` and poll `node dist/cli.cjs status <run-id>`.

3. **Audit it.**
   ```bash
   node dist/cli.cjs verify --pr <pr-url>
   ```
   Exit 0 = every invariant PASS or SKIP. **Exit 1 = the audit could not be
   completed** (the PR read-back failed) — report that as "not verified", never
   as "clean". Exit 2 = at least one FAIL, and a FAIL is a product defect until
   proven otherwise. `--offline` skips the live PR read on purpose (every row
   that needs it reports SKIP, and the exit stays 0); `--json` for machine use.

4. **The matrix, only when asked for cross-provider or cross-runtime coverage.**
   ```bash
   npm run acceptance                                       # all six cells
   npm run acceptance -- --provider gitlab --runtime copilot
   ```
   See `evals/acceptance/README.md` — it posts to real fixture PRs and needs the
   estate seeded first.

5. **Report.** Give the `verify` table **verbatim**. Every FAIL with its
   evidence, every SKIP with its reason. Never summarise the table into a
   sentence and never drop a row — a missing row reads as "fine", which is the
   exact failure this whole mechanism exists to prevent.

## Reading the result

| Row | Means |
|---|---|
| `PASS` | Checked against evidence and held. |
| `FAIL` | Violated, or a check threw. Either way, investigate — never explain it away. |
| `SKIP` | Not checkable **and it says why**: a dry run, `--offline`, a PR that moved on, or an invariant only the test suite can guard. |

A run with many SKIPs is not a clean run. If `INV-POST-*` are all SKIP, nothing
was posted and nothing about posting was proven.

## Gotchas

- **`verify` never posts, deletes or edits anything.** If a step is about to
  change the PR, that step is not `verify`.
- **A `--dry-run` review cannot prove the posting invariants.** They report SKIP
  by design. Asking "does it post correctly?" needs a real publish run.
- **The acceptance matrix posts for real.** It resets the fixture PR before each
  cell — never after, because that is the step a cancelled run skips.
- **The claude cells do not run in CI** (no Anthropic credential there, by
  choice). They run locally. The CI report marks them skipped rather than
  omitting them; do not read a green CI run as "both runtimes covered".
- **A `verify` FAIL on a PR that advanced since the run** should already be a
  SKIP with the SHAs named. If it is a FAIL instead, that is a bug in the check.
