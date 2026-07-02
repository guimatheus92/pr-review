# pr-review

Generic, plugin-based PR review tool for GitHub and Azure DevOps, packaged as a Copilot CLI plugin. Orchestrates parallel reviewer agents in a single Copilot session via the `task` tool.

## Build & test

```bash
npm run build          # tsc + esbuild → dist/cli.cjs
npm run test           # node --test (59 tests, ~500ms)
npm run build:watch    # tsc watch (re-run `npm run bundle` for esbuild)
```

The bundle at `dist/cli.cjs` is the single-file distribution artifact. The slash command (`commands/pr-review.md`) finds it under `~/.copilot/installed-plugins/` and runs `node "$CLI" review $ARGUMENTS`.

## Architecture

**Two-layer model:** slash command → Node CLI → single Copilot session dispatching reviewer agents via `task()`.

- `src/cli.ts` — commander entry, subcommand routing
- `src/commands/review.ts` — main pipeline: gather → early-exit → single-session dispatch → dedupe → post
- `src/dispatch/single-session.ts` — writes PR context file, builds orchestrator prompt, spawns one `copilot` process
- `src/providers/github.ts` / `azuredevops.ts` — PR data fetchers + comment posters
- `src/dispatch/parsers.ts` — JSON / bracketed-markdown / section-header output parsers
- `src/dedupe.ts` — Jaccard token similarity, strict/loose/off modes
- `src/config.ts` — 5-level config merge (flags > repo yaml > global yaml > env > defaults)
- `src/plugins/loader.ts` — discovers skills from standard paths (.claude/skills, .copilot/skills, .agents/skills, etc.)
- `src/plugins/companions.ts` — detects installed companion plugins (pr-review-toolkit, code-review)
- `agents/*.md` — 7 built-in reviewer agents registered as `pr-review:<name>`

## Key conventions

- **No repo pollution.** All run artifacts go to `~/.pr-review/runs/<id>/`. Never write files to the user's working directory.
- **Clean output.** Posted comments contain only the finding body — no severity prefix, no bot chrome. Summary findings also render body-only, separated by `---`.
- **Skills, not reviewers.** User-authored content goes in `.pr-review/skills/` (injected as context into built-in reviewers). Standalone reviewers are the exception, not the default.
- **Single session.** All reviewers dispatch in one `copilot` process via `task()`. Never spawn N separate sessions.
- **Stack-agnostic built-ins.** The 7 agents in `agents/*.md` must never reference specific frameworks. Stack-specific rules belong in user skills.
- **esbuild bundle.** `dist/cli.cjs` is a single-file zero-dependency bundle. No `npm install` needed at the plugin install site.

## Testing

Tests use `node:test` + `node:assert`. Run with `npm run test`. Tests are in `tests/` mirroring `src/` structure. Provider tests require real auth env vars; pure-logic tests have no external deps.

## Common tasks

- **Add a built-in reviewer:** Create `agents/<name>.md`, add to `BUILTIN_AGENTS` array in `src/dispatch/single-session.ts`, rebuild.
- **Add a provider:** Implement `PrProvider` from `src/providers/types.ts`, wire in `src/providers/index.ts`.
- **Change config defaults:** Edit `src/config.ts` `DEFAULTS` object.
- **Change auto-discovery paths:** Edit `autodiscoveryPaths()` in `src/config.ts`.
- **Change dedupe behavior:** Edit `src/dedupe.ts`. Threshold constants are at the top.
- **Change diff exclusions:** Edit `DEFAULT_EXCLUDES` in `src/dispatch/diff-filter.ts`.
