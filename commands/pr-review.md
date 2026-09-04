---
description: Review a GitHub, Azure DevOps, or GitLab pull request using parallel review passes in a single agent session (Copilot CLI or Claude Code) with auto-discovered local skills.
argument-hint: "<pr-url> [--dry-run | --context-only] [--resume <run-id>] [--skip <pass,...>] [--fail-on <severity>] [--lang <code>] [--runtime <copilot|claude>] [--no-companions] [--no-codex] [--skill <file>] [--force-skill <file|dir>] [--skills-dir <path>]"
allowed-tools: ["Bash"]
---

You are running the `pr-review` CLI. You are NOT reviewing the PR yourself — the CLI gathers, dispatches, de-duplicates, and posts. A full review takes ~6–10 minutes, so it runs in the **background** and you poll it; never block one long-running call on it.

## Step 1 — start the review (background)

Locate the bundled CLI, move into the checkout the PR belongs to, and start a detached run. Under Claude Code `${CLAUDE_PLUGIN_ROOT}` expands to the plugin root at load time (with a plugin-cache search as fallback); under Copilot CLI the plugin lives beneath `~/.copilot/installed-plugins/`.

The CLI reads project rules from **its own working directory only** — it has no `--repo` flag. Run from a checkout whose `origin` matches the PR, or it applies no project skills and skips stack detection. The block below finds that checkout for you: the repository containing the current directory, then the current directory's subdirectories, then its siblings, comparing each origin's path against the PR URL (provider-agnostic). A primary worktree is preferred over a linked one, because linked worktrees usually lack a workspace's shared skill links. Because the CLI is started from that checkout, a relative path in the arguments (`--skill ./x.md`) resolves from the checkout, not from where the command was typed.

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

# Find the checkout this PR belongs to: the repo containing cwd, then cwd's subdirectories, then its siblings.
PR_URL=
for a in $ARGUMENTS; do
  case "$a" in http://*|https://*) PR_URL=$(printf %s "$a" | tr 'A-Z' 'a-z'); break ;; esac
done
REPO_DIR=; FALLBACK=
if [ -n "$PR_URL" ]; then
  for d in "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" */ ../*/; do
    [ -e "$d/.git" ] || continue
    o=$(git -C "$d" remote get-url origin 2>/dev/null) || continue
    # origin URL → "owner/repo" path: drop scheme, user@, host (and the ':' of scp-style), and .git
    o=$(printf '%s' "$o" | sed -e 's#^[a-z+]*://##' -e 's#^[^@]*@##' -e 's#^[^/:]*[:/]##' -e 's#\.git$##' | tr 'A-Z' 'a-z')
    [ -n "$o" ] || continue
    case "$PR_URL" in *"/$o/"*) ;; *) continue ;; esac
    if [ "$(git -C "$d" rev-parse --git-dir 2>/dev/null)" = "$(git -C "$d" rev-parse --git-common-dir 2>/dev/null)" ]; then
      REPO_DIR=$(cd "$d" && pwd); break
    fi
    [ -n "$FALLBACK" ] || FALLBACK=$(cd "$d" && pwd)
  done
fi
[ -n "$REPO_DIR" ] || REPO_DIR=$FALLBACK

if [ -n "$REPO_DIR" ]; then
  echo "repo: $REPO_DIR"
  cd "$REPO_DIR" || exit 1
  # Approximates the loader's rule — <dir>/SKILL.md plus flat .md files (README excluded) in the standard dirs; the CLI's own count is authoritative.
  n=$( { ls -d .claude/skills/*/SKILL.md .copilot/skills/*/SKILL.md .github/skills/*/SKILL.md .agents/skills/*/SKILL.md 2>/dev/null; ls .claude/skills/*.md .copilot/skills/*.md .github/skills/*.md .agents/skills/*.md .claude/rules/*.md .github/instructions/*.md 2>/dev/null | grep -vi '/readme\.md$'; } | wc -l)
  if [ "$n" -gt 0 ]; then
    echo "project skills discoverable: $n (the CLI reports the exact count it loads)"
  else
    echo "WARNING: no project skills under $REPO_DIR — review will use pack rules only." >&2
  fi
else
  echo "WARNING: no local checkout matches $PR_URL — running from $(pwd)." >&2
  echo "WARNING: the CLI will apply no project skills and skip stack detection." >&2
fi

node "$CLI" review $ARGUMENTS --detach
```

- If the output contains `run-id:`, the review is running in the background — note the run-id and go to **Step 2**.
- Otherwise it already finished in the foreground (e.g. `--resume`, `--context-only`, or an early exit) and the output IS the result — print it verbatim and stop.

Report the `repo:` line (or the warning) to the user before polling — it is the difference between a review that knows the project's rules and one that does not.

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
