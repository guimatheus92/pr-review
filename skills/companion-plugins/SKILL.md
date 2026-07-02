---
description: "pr-review companion plugins: pr-review-toolkit and code-review install, auto-invocation, output parsing, timeouts, opting out. Use when asked about companion plugins, the missing-companion warning, enhancing reviews with additional agents, or installing Claude Code plugins into Copilot CLI."
---

# Companion Plugins

`pr-review` is fully functional on its own. It also **auto-invokes** two Anthropic-authored Claude-Code plugins when they're installed — no flag needed. Both come from the Claude-Code marketplace and install cleanly into Copilot CLI.

## The two companions

| Plugin | Entry slash command | What it does |
|---|---|---|
| [`pr-review-toolkit`](https://claude.com/plugins/pr-review-toolkit) | `/pr-review-toolkit:review-pr <pr-url>` | Dispatches six specialized review agents internally: `code-reviewer`, `code-simplifier`, `comment-analyzer`, `pr-test-analyzer`, `silent-failure-hunter`, `type-design-analyzer`. Returns a consolidated finding set. |
| [`code-review`](https://claude.com/plugins/code-review) | `/code-review:code-review <pr-url>` | Five-agent parallel fan-out with 0–100 confidence scoring; only ≥80 are surfaced. |

## Install (slash commands inside `copilot`)

`/plugin marketplace add` and `/plugin install` are **slash commands inside a `copilot` interactive session** — not `copilot plugin ...` bash subcommands. Start `copilot`, then type at the prompt:

```
/plugin marketplace add anthropics/claude-code
/plugin install pr-review-toolkit@claude-code-plugins
/plugin install code-review@claude-code-plugins
```

Verify with `/plugin list` inside the session, or `copilot plugin list` from bash (the read-only subcommand exists at the bash level).

## How auto-invocation works

`pr-review` queries `copilot plugin list` at the start of every `review` run. For each installed companion in `KNOWN_COMPANIONS` with `invocable: true`, the CLI registers a single reviewer named `companion:<plugin>` whose prompt body is the plugin's entry slash command plus the PR URL — for example:

```
/pr-review-toolkit:review-pr https://dev.azure.com/.../pullrequest/12345
```

That prompt is sent to a fresh `copilot --model <model> -p ...` subprocess via stdin. The companion plugin's own orchestrator handles PR fetching, internal sub-agent dispatch, and finding consolidation. Its stdout is captured and parsed by `pr-review`'s markdown-findings parser; the findings then flow through dedupe and posting like any other reviewer.

Each companion appears as one row in the summary:

```
| Reviewer                | Model              | Findings | Duration | Status |
|-------------------------|--------------------|----------|----------|--------|
| security                | claude-opus-4.8    |        2 |    14.2s | ✓      |
| companion:pr-review-toolkit | claude-opus-4.8 |       11 |   8m 32s | ✓      |
| companion:code-review   | claude-opus-4.8    |        4 |   6m 18s | ✓      |
```

## Why companions are slow

Each companion plugin's slash command kicks off the plugin's internal orchestrator, which dispatches its own sub-agents (Claude Code's `Task` primitive is available inside the `copilot -p` session). pr-review-toolkit runs six agents; code-review runs five. Wall-clock time per companion is typically 5–15 minutes.

The default per-reviewer timeout is 5 minutes, but companion reviewers get a 20-minute timeout automatically (`timeoutMs: 20 * 60 * 1000` in [src/plugins/companions.ts](../../src/plugins/companions.ts)).

## Cost note

Companion plugins roughly **2-3x review cost** because the entire orchestrator runs inside one of our subprocesses, spinning up Anthropic's internal agents on top. If review cost matters and the built-ins are sufficient, opt out:

```bash
pr-review review <url> --no-companions
```

Or in `~/.pr-review/config.yaml`:

```yaml
invoke_companions: false
```

## Output format

Both plugins return prose findings (markdown), not JSON. The markdown parser at [src/dispatch/parsers.ts](../../src/dispatch/parsers.ts) extracts findings via:

- `### [SEVERITY] Title` lines
- `File: path:line` references in the body

If a companion's format ever changes and findings stop being extracted, the raw output is still in the per-reviewer cache and the summary will show 0 findings with a clear note. Check `out/prompt-companion_<plugin>.md` to see what was sent and the response cache for the raw output.

## Warning behavior

If neither companion is installed and `companion_warn` is true (default), `pr-review` prints a one-line install hint to stderr on each run. The hint uses the correct slash-command install syntax. Suppress with `--no-companion-warning` or `PR_REVIEW_NO_COMPANION_WARN=1`.

If a companion **is** installed and `invokeCompanions` is on (default), no warning — it just runs.

## Verifying

```bash
pr-review plugins doctor       # shows install state of each companion
pr-review review <url> --dry-run   # runs everything (including companions) but doesn't post
pr-review review <url> --no-companions --dry-run   # built-ins only
```

## When a companion fails

If a companion plugin throws or times out, its row in the summary will show `✗ <error>`. The CLI continues with the built-in reviewers — companion failures don't abort the run.

To disable a specific companion without disabling all:

```bash
pr-review review <url> --skip companion:code-review
```

Note: companion names use the `companion:` prefix.
