---
description: "pr-review companion plugins: pr-review-toolkit and code-review install, auto-invocation, output parsing, timeouts, opting out. Use when asked about companion plugins, the missing-companion warning, enhancing reviews with additional agents, or installing Claude Code plugins into Copilot CLI."
---

# Companion Plugins

`pr-review` is fully functional on its own. It also **auto-invokes** two Anthropic-authored Claude-Code plugins when they're installed — no flag needed. Both come from the Claude-Code marketplace and install cleanly into Copilot CLI and Claude Code.

## The two companions

| Plugin | Entry slash command | What it does |
|---|---|---|
| [`pr-review-toolkit`](https://claude.com/plugins/pr-review-toolkit) | `/pr-review-toolkit:review-pr <pr-url>` | Dispatches six specialized review agents internally: `code-reviewer`, `code-simplifier`, `comment-analyzer`, `pr-test-analyzer`, `silent-failure-hunter`, `type-design-analyzer`. Returns a consolidated finding set. |
| [`code-review`](https://claude.com/plugins/code-review) | `/code-review:code-review <pr-url>` | Five-agent parallel fan-out with 0–100 confidence scoring; only ≥80 are surfaced. |

## Install (slash commands inside `copilot` or `claude`)

`/plugin marketplace add` and `/plugin install` are **slash commands inside an interactive session** (`copilot` or `claude`) — not `copilot plugin ...` bash subcommands. Start the session, then type at the prompt:

```
/plugin marketplace add anthropics/claude-code
/plugin install pr-review-toolkit@claude-code-plugins
/plugin install code-review@claude-code-plugins
```

Verify with `/plugin list` inside the session, or `copilot plugin list` from the shell. A directory under `~/.copilot/installed-plugins/<marketplace>/` can be marketplace cache only; it is not proof of installation unless the plugin appears in the registry/list output.

## How auto-invocation works

Detection depends on the runtime: for the copilot runtime, `pr-review` queries `copilot plugin list` at the start of every `review` run; for the claude runtime it reads `~/.claude/plugins/installed_plugins.json` (keys are `name@marketplace`) — no subprocess. For each installed companion in `KNOWN_COMPANIONS` with `invocable: true`, the CLI adds dispatch lines to the orchestrator prompt: pr-review-toolkit's six agents are dispatched directly (each recorded as `companion:pr-review-toolkit/<agent>`), while code-review is invoked through its entry slash command plus the PR URL (recorded as `companion:code-review`) — for example:

```
/code-review:code-review https://dev.azure.com/.../pullrequest/12345
```

Each companion reviewer is dispatched via `task()` / `Task()` inside the same single review session as the review passes. Every task must write an exact top-level `Finding[]` JSON array to its attempt path; malformed or prose output is invalid delivery. Valid findings flow through Node-owned aggregation, dedupe, and posting like any other reviewer.

**Companions run analysis-only.** Some companion commands are written to post their verdict straight to the PR (the official `code-review` command allows `gh pr comment` and posts a top-level "### Code review" summary on its own). pr-review's dispatch prompt explicitly forbids that: the subagent must skip any post-a-comment step in the companion's instructions and return the review as output instead — the CLI is the only thing that ever writes to the PR (inline-only, deduped, idempotent). If you ever see a top-level summary comment appear during a review, a dispatch path lost this directive — it's pinned by a session-context test.

Skill routing note: pr-review-toolkit's six direct agents receive the authoritative shared file selected after pass routing: `skills-project.md` when project context remains, or the budgeted `skills-all.md` pass union as fallback. The `code-review` slash companion receives the PR URL through its command and does not receive either shared skills file. The direct-agent prompt treats the shared file as authoritative.

pr-review-toolkit’s six agents each get their own summary row (`companion:pr-review-toolkit/<agent>`); the `code-review` slash companion is one row. `companions.json` records all installed plugins, recognized companion plugins, missing companions, planned dispatches, and completed output rows. A context-only preview has planned dispatches but zero completed dispatches:

```
| Reviewer                    | Findings | Status |
|-----------------------------|----------|--------|
| awesome-copilot/security-and-owasp |  2 | ✓      |
| companion:pr-review-toolkit/code-reviewer | 11 | ✓ |
| companion:code-review       |        4 | ✓      |
```

## Why companions are slow

pr-review-toolkit contributes six direct agent tasks to the main session. `code-review` contributes one slash-command task, whose command runs its own multi-agent review. Their wall-clock work overlaps with the selected review passes, but either companion can become the slowest task in the shared session.

There is no per-pass timeout: everything dispatched inside one session shares its 30-minute process timeout. Node independently accounts for each companion attempt; absent/invalid companions are selectively retried and never interpreted as clean empty output.

## Cost note

Enabling both companion plugins adds seven planned Phase 1 dispatches: six direct pr-review-toolkit agents and one `code-review` slash-command task. Codex is a separate optional sibling and the verifier is conditional; the total review cost depends on the selected stack/plugin passes and every configured baseline. If that additional coverage is not worth the cost, opt out:

```bash
pr-review review <url> --no-companions
```

Or in `~/.pr-review/config.yaml`:

```yaml
invoke_companions: false
```

## Output format

Every companion must write exact top-level `Finding[]` JSON to its attempt path. Prose or malformed arrays remain under `reviewer-attempts/` for diagnosis, count as invalid delivery, and trigger bounded selective recovery. Only Node-promoted canonical output participates in Phase 1.

## Warning behavior

If either companion is missing and `companion_warn` is true (default), `pr-review` prints an install hint. Missing companion coverage is also recorded in the summary's Degraded block; suppressing the console hint does not make the missing dispatches invisible.

If a companion **is** installed and `invokeCompanions` is on (default), no warning — it just runs.

## Verifying

```bash
pr-review doctor               # shows install state and dispatch count of each companion
pr-review review <url> --dry-run   # runs everything (including companions) but doesn't post
pr-review review <url> --no-companions --dry-run   # review passes only
```

## When a companion fails

If a companion task fails, peer tasks can still finish and valid outputs are preserved. Node retries unresolved planned companions with the rest of the incomplete Phase 1 delta; if any remain missing or invalid, the review exits 2 and posts nothing.

There is no per-companion skip (`--skip` takes pass names, plus `verifier` and `codex`); to turn companions off, use `--no-companions` or `invoke_companions: false`.
