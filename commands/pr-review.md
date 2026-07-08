---
description: Review a GitHub or Azure DevOps pull request using parallel reviewer agents in a single agent session (Copilot CLI or Claude Code) with auto-discovered local skills.
argument-hint: "<pr-url> [--dry-run | --context-only] [--resume <run-id>] [--skip <name,...>] [--fail-on <severity>] [--lang <code>] [--runtime <copilot|claude>] [--no-companions] [--no-codex] [--skill <file>] [--skills-dir <path>]"
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

Poll the run about every 25 seconds, each as a SEPARATE short command (never one long-running call). Show the user each progress snapshot as it arrives:

```bash
sleep 25; node "$CLI" status <run-id>
```

React to the exit code:

- **0** — done: `status` printed the final summary. Print that summary verbatim and stop.
- **20** — still running: show the snapshot, then poll again.
- **21** — reviewers finished but posting was interrupted. Finish it (fast, no re-review): `node "$CLI" review <pr-url> --resume <run-id>`, then print its summary verbatim.
- **1** — run not found: report the error and stop.

Print the review summary verbatim — do not editorialize, summarize, or skip sections. `review --fail-on` exiting 1 means findings at/above that severity were reported, not a tool failure; exit 2 is a pipeline error. All run artifacts (gather data, prompts, raw outputs, findings JSON, the `progress.ndjson` feed, summary) live under `~/.pr-review/runs/<run-id>/`.

Your only job is plumbing. Do not call `gh pr view`, `gh pr diff`, `az repos pr show`, `git log`, or read any PR file. The CLI handles all of that.
