---
description: Review a GitHub or Azure DevOps pull request using parallel Copilot CLI reviewers (Opus + GPT) with auto-discovered local skills.
argument-hint: "<pr-url> [--dry-run | --publish] [--skip <name,...>] [--no-companions] [--skill <file>] [--skills-dir <path>]"
allowed-tools: ["Bash"]
---

You are running the `pr-review` CLI. You are NOT reviewing the PR yourself. The CLI does the gathering, dispatch, de-duplication, and posting.

Locate the bundled CLI inside this plugin's install directory and run it:

```bash
CLI=$(find ~/.copilot/installed-plugins -name cli.cjs -path '*/pr-review/dist/*' 2>/dev/null | head -1)
if [ -z "$CLI" ]; then
  echo "pr-review bundle not found under ~/.copilot/installed-plugins/. Is the plugin installed?" >&2
  exit 1
fi
node "$CLI" review $ARGUMENTS
```

Print the command's stdout verbatim — that is the review summary. Do not editorialize, summarize, or skip sections. The CLI also writes all run artifacts (gather data, orchestrator prompt, raw subagent outputs, findings JSON, summary) under `~/.pr-review/runs/<run-id>/` for debugging; you do not need to read them.

Your only job is plumbing. Do not call `gh pr view`, `gh pr diff`, `az repos pr show`, `git log`, or read any PR file. The CLI handles all of that.
