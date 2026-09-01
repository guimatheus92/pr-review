---
description: Review a GitHub, Azure DevOps, or GitLab pull request using parallel review passes in a single agent session (Copilot CLI or Claude Code) with auto-discovered local skills.
argument-hint: "<pr-url> [--dry-run | --context-only] [--resume <run-id>] [--skip <pass,...>] [--fail-on <severity>] [--lang <code>] [--runtime <copilot|claude>] [--no-companions] [--no-codex] [--skill <file>] [--force-skill <file>] [--skills-dir <path>]"
allowed-tools: ["Bash"]
---

You are running the `pr-review` CLI. You are NOT reviewing the PR yourself — the CLI gathers, dispatches, de-duplicates, and posts. A full review takes ~6–10 minutes, so it runs in the **background** and you poll it; never block one long-running call on it.

## Step 1 — start the review (background)

Locate the bundled CLI and start a detached run. Under Claude Code `${CLAUDE_PLUGIN_ROOT}` expands to the plugin root at load time (with a plugin-cache search as fallback); under Copilot CLI the plugin lives beneath `~/.copilot/installed-plugins/`:

```bash
CLI="${CLAUDE_PLUGIN_ROOT}/dist/cli.cjs"
if [ ! -f "$CLI" ]; then
  CLI=$(find ~/.claude/plugins/cache -name cli.cjs -path '*/pr-review/*/dist/*' -not -path '*/node_modules/*' 2>/dev/null | sort | tail -1)
fi
if [ -z "$CLI" ] || [ ! -f "$CLI" ]; then
  CLI=$(find ~/.copilot/installed-plugins -name cli.cjs -path '*/pr-review/dist/*' 2>/dev/null | sort | tail -1)
fi
if [ -z "$CLI" ] || [ ! -f "$CLI" ]; then
  echo "pr-review bundle not found (checked \${CLAUDE_PLUGIN_ROOT}, ~/.claude/plugins/cache, ~/.copilot/installed-plugins). Is the plugin installed?" >&2
  exit 1
fi
node "$CLI" review $ARGUMENTS --detach
```

- If the output contains `run-id:`, the review is running in the background — note the run-id and go to **Step 2**.
- Otherwise it already finished in the foreground (e.g. `--resume`, `--context-only`, or an early exit) and the output IS the result — print it verbatim and stop.

## Step 2 — poll until done

Poll `node "$CLI" status <run-id>` about every 25 seconds and show the user each progress snapshot as it arrives. How you wait between polls depends on the harness:

- Under current Claude Code, chaining a foreground sleep (`sleep 25; node "$CLI" status <run-id>`) is **blocked**. Use the harness's background waiter instead — e.g. the Monitor tool with an until-loop that runs the status command every ~25s and surfaces each snapshot. Do not chain shorter sleeps to work around the block.
- Where foreground sleeps are allowed (e.g. Copilot CLI), `sleep 25; node "$CLI" status <run-id>` as separate short calls is fine — never one long-running blocking call.

React to the `status` exit code:

- **0** — done. The final summary can be 10–20 KB and **background/monitor notifications truncate long text — never reproduce the summary from a notification**. Read `~/.pr-review/runs/<run-id>/pr-review-summary.md` (on exit 0 `status` also prints `summary file: <path>` on stderr), or re-run `node "$CLI" status <run-id>` once in the foreground, and print that full content verbatim. Then stop.
- **20** — still running: show the snapshot, then poll again.
- **21** — authenticated delivery is incomplete or the parent stopped before finalization. Run the exact recovery command printed by `status` (it includes `--dry-run` when the run was a dry run); it reuses valid attempts and dispatches only incomplete coverage. Print the returned summary verbatim.
- **22** — terminal pipeline/operational failure. `status` surfaces the authenticated reason and recorded error; report it and point at `~/.pr-review/runs/<run-id>/detached.log`; stop.
- **1** — run not found: report the error and stop.

Print the review summary verbatim — do not editorialize, summarize, or skip sections. `review --fail-on` exiting 1 means findings at/above that severity were reported, not a tool failure. Exit 2 is a pipeline error (no parseable findings, zero passes on a code PR, or incomplete reviewer/verifier/Codex delivery) or an operational failure of an otherwise parseable review (failed prerequisite, a planned pass/companion that delivered no output, or a post that failed or could not be verified); partial findings are never posted. `error.txt` and the summary's Degraded block say which. Exit 0 means the pipeline completed, not that nothing was found: without `--fail-on`, retained findings still exit 0. Run artifacts live under `~/.pr-review/runs/<run-id>/`; HMAC-authenticated recovery/posting authority lives under `~/.pr-review/control/`.

Your only job is plumbing. Do not call `gh pr view`, `gh pr diff`, `az repos pr show`, `git log`, or read any PR file. The CLI handles all of that.
