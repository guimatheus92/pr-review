---
description: "pr-review companion plugins: pr-review-toolkit and code-review install, auto-invocation, output parsing, timeouts, opting out. Use when asked about companion plugins, the missing-companion warning, enhancing reviews with additional agents, or installing Claude Code plugins into Copilot CLI."
---

# Companion Plugins

`pr-review` is fully functional on its own. It also **uses the review criteria from** two Anthropic-authored Claude-Code plugins when they are installed — no flag needed. Both come from the Claude-Code marketplace and install cleanly into Copilot CLI and Claude Code.

## The two companions

| Plugin | Criteria used by pr-review | Planned rows |
|---|---|---|
| [`pr-review-toolkit`](https://claude.com/plugins/pr-review-toolkit) | The bodies of `code-reviewer`, `code-simplifier`, `comment-analyzer`, `pr-test-analyzer`, `silent-failure-hunter`, and `type-design-analyzer`, with runtime frontmatter removed | Six: `companion:pr-review-toolkit/<agent>` |
| [`code-review`](https://claude.com/plugins/code-review) | Its high-signal and false-positive filtering criteria, adapted to the already-materialized PR diff | One: `companion:code-review` |

## Install — the command differs per runtime

The two CLIs do not share a command surface, and **each runtime has its own plugin registry**: installing under Claude Code does not install under Copilot. The marketplace and the plugin ids are the same; only the verb changes.

**Claude Code** — slash commands, typed inside an interactive session:

```
/plugin marketplace add anthropics/claude-code
/plugin install pr-review-toolkit@claude-code-plugins
/plugin install code-review@claude-code-plugins
```

**Copilot CLI** — shell commands. It has no `/plugin`:

```bash
copilot plugin marketplace add anthropics/claude-code
copilot plugin install pr-review-toolkit@claude-code-plugins
copilot plugin install code-review@claude-code-plugins
```

Use `anthropics/claude-code`, not `anthropics/claude-plugins-official`. Both carry these two plugins and Claude Code accepts either, but the Copilot CLI validates `marketplace.json` against its own schema and rejects ~90 of that larger catalog's 292 entries (`plugins.N.source: Invalid input`). Direct repo installs (`copilot plugin install anthropics/claude-plugins-official:plugins/pr-review-toolkit`) do work, but Copilot prints a deprecation warning and says only `plugin@marketplace` will be supported later — so prefer the marketplace form.

Verify with `claude plugin list --json` or `copilot plugin list` from the shell; `pr-review doctor` is the end-to-end check and prints `6 dispatch(es)` + `1 dispatch(es)` once both resolve. A directory under either runtime's plugin cache is not proof of active installation unless it appears enabled in that runtime's list output. If an entry lingers in `copilot plugin list` after an uninstall fails, `~/.copilot/config.json` still holds it — an entry whose `cache_path` no longer exists is stale.

## How auto-invocation works

Detection depends on the runtime: for the copilot runtime, `pr-review` queries `copilot plugin list` and resolves enabled JSONC registry entries; for the claude runtime it queries cwd-aware `claude plugin list --json`. Claude's effective output already applies user, project, local, and managed enablement, and supplies the exact active `installPath`; disabled and other-project installs are not dispatched. Missing or mismatched roots fail materialization; duplicate active definitions must agree, and every definition path is constrained to its plugin root.

Before dispatch, each accepted definition is copied without runtime frontmatter into `companion-brief-*.md` under the run directory and hash-bound into the authenticated dispatch plan. Every planned companion identity, up to seven when both known plugins are active, runs through a `general-purpose` task inside the same Phase 1 session. Each reads its own brief, `pr-context.md`, and the authoritative shared file selected after pass routing: `skills-project.md` when project rules remain, or the budgeted `skills-all.md` union as fallback.

pr-review does **not invoke** the companion's native agents or `/pr-review-toolkit:review-pr` / `/code-review:code-review` commands. This matters for `code-review`: its upstream command assumes `gh pr view` / `gh pr diff`, launches model-specific subagents, and may post comments. pr-review already owns acquisition, dispatch accounting, and posting, so its adapter keeps only the high-signal review criteria and applies them to the materialized diff. Every companion prompt also carries the no-posting directive; the CLI remains the only PR writer.

Copilot review sessions set `COPILOT_PLUGIN_DIR_ONLY=true`, so automatic discovery cannot load unrelated installed plugins, hooks, agents, or instructions. The exact value matters: Copilot CLI 1.0.84-3 ignores `1`. Installed state remains discovery input outside that confined runtime. No equivalent Claude plugin-loading isolation is asserted; the deterministic guarantee there is that pr-review dispatches only generic tasks over the copied briefs and never invokes native companion identities or commands.

pr-review-toolkit's six criteria each get their own summary row; `code-review` gets one. `companions.json` records all installed plugins, recognized companion plugins, missing companions, planned dispatches, and completed output rows. A context-only preview has planned dispatches but zero completed dispatches:

```
| Reviewer                    | Findings | Status |
|-----------------------------|----------|--------|
| awesome-copilot/security-and-owasp |  2 | ✓      |
| companion:pr-review-toolkit/code-reviewer | 11 | ✓ |
| companion:code-review       |        4 | ✓      |
```

## Why companions add work

pr-review-toolkit contributes six generic review tasks and `code-review` contributes one. Their wall-clock work overlaps with the selected review passes, but any companion can become the slowest task in the shared session.

There is no per-pass timeout: everything dispatched inside one session shares its 30-minute process timeout. Node independently accounts for each companion attempt; absent/invalid companions are selectively retried and never interpreted as clean empty output.

## Cost note

Enabling both companion plugins adds seven planned Phase 1 dispatches. Codex is a separate optional sibling and the verifier is conditional; the total review cost depends on the selected stack/plugin passes and every configured baseline. If that additional coverage is not worth the cost, opt out:

```bash
pr-review review <url> --no-companions
```

Or in `~/.pr-review/config.yaml`:

```yaml
invoke_companions: false
```

## Output format

Every companion must write exact top-level `Finding[]` JSON to its attempt path. Prose or malformed arrays remain under `reviewer-attempts/` for diagnosis, count as invalid delivery, and trigger bounded selective recovery. Under Copilot, one uniquely named successful top-level structured task result may fill an absent attempt file with the same exact array; it never overwrites an existing file. Only Node-promoted canonical output participates in Phase 1.

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
