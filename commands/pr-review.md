---
description: Review a GitHub or Azure DevOps pull request using parallel reviewer agents in a single agent session (Copilot CLI or Claude Code) with auto-discovered local skills.
argument-hint: "<pr-url> [--dry-run | --publish | --context-only] [--skip <name,...>] [--fail-on <severity>] [--lang <code>] [--runtime <copilot|claude>] [--no-companions] [--no-codex] [--skill <file>] [--skills-dir <path>]"
allowed-tools: ["Bash"]
---

You are running the `pr-review` CLI. You are NOT reviewing the PR yourself. The CLI does the gathering, dispatch, de-duplication, and posting.

Locate the bundled CLI inside this plugin's install directory and run it. Under Claude Code the plugin root is exported as `$CLAUDE_PLUGIN_ROOT`; under Copilot CLI the plugin lives beneath `~/.copilot/installed-plugins/`:

```bash
if [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -f "$CLAUDE_PLUGIN_ROOT/dist/cli.cjs" ]; then
  CLI="$CLAUDE_PLUGIN_ROOT/dist/cli.cjs"
else
  CLI=$(find ~/.copilot/installed-plugins -name cli.cjs -path '*/pr-review/dist/*' 2>/dev/null | head -1)
fi
if [ -z "$CLI" ]; then
  echo "pr-review bundle not found (checked \$CLAUDE_PLUGIN_ROOT and ~/.copilot/installed-plugins/). Is the plugin installed?" >&2
  exit 1
fi
node "$CLI" review $ARGUMENTS
```

Print the command's stdout verbatim — that is the review summary. Exit code 1 with `--fail-on` means findings at/above that severity were reported, not a tool failure; exit code 2 is a pipeline error. Do not editorialize, summarize, or skip sections. The CLI also writes all run artifacts (gather data, orchestrator prompt, raw subagent outputs, findings JSON, summary) under `~/.pr-review/runs/<run-id>/` for debugging; you do not need to read them.

Your only job is plumbing. Do not call `gh pr view`, `gh pr diff`, `az repos pr show`, `git log`, or read any PR file. The CLI handles all of that.
