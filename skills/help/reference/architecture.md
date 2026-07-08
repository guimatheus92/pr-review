---
description: "pr-review architecture: execution model, source map, and design decisions. Use when asked how pr-review works internally, what the single-session dispatch does, where code lives, or why it's structured as a CLI instead of pure skills."
---

# Architecture

## Execution model

```
User: /pr-review <pr-url>
       │
       ▼  commands/pr-review.md
Host CLI (Copilot CLI or Claude Code) runs: node "$CLI" review <pr-url>
       │
       ▼  src/cli.ts → src/commands/review.ts
Node CLI (deterministic plumbing)
  1. detectProvider(url)        → GitHub or ADO
  2. resolveRuntime()           → copilot | claude | auto (probe PATH: copilot first, then claude)
  3. detectCompanions()         → check installed companion plugins (per runtime)
  4. runGather()                → fetch metadata + comments in parallel, diff (cached)
  5. earlyExitGate()            → abort if PR is malformed/too large
  6. loadAll({ skillsOnly })    → discover skills from standard paths (user reviewer .md files are not loaded)
  7. triage                     → docs-only PRs dispatch only the quality reviewer; skipped reviewers logged
  8. prepareSessionContext()    → pr-context.md + one skills-<reviewer>.md per reviewer in the run dir
  9. runSingleSession()         → one runtime session, reviewers via task()/Task(); verifier only if Phase 1 has CRITICAL/HIGH
     └─ runCodex()              → optional Codex second-opinion reviewer as a parallel sibling process
 10. dedupe                     → intra-batch + against existing comments
 11. runPost() / renderSummary  → every finding posts inline (snap + re-anchor; GitHub batched review, ADO threads) or print summary
 12. exit code                  → 0 clean, 1 findings ≥ --fail-on, 2 no parseable findings
```

A single agent session (Copilot CLI or Claude Code, selected by `--runtime` / `runtime:` / `PR_REVIEW_RUNTIME`, default `auto`) dispatches all reviewers (built-in agents + companion plugins) via the `task` tool (copilot: `task(agent_type=...)`) or `Task` tool (claude: `Task(subagent_type=...)`) — the orchestrator prompt adapts its tool vocabulary to the runtime. The orchestrator prompt instructs the session to launch the triaged reviewers in parallel, collect their JSON arrays, then write a consolidated findings file — and NOT to read `pr-context.md` itself, keeping the orchestrator's context lean. Existing PR comments inside `pr-context.md` are wrapped in an untrusted-content fence. The verifier is conditional: it is dispatched only when Phase 1 produced at least one CRITICAL/HIGH finding, and it reads `phase1-findings.json` from the run dir rather than inline-spliced JSON. The Node CLI reads the findings file and handles dedupe + posting; if the orchestrator produced no parseable findings the run exits 2 (never a silent 0).

When the `codex` CLI is installed, a Codex second-opinion reviewer runs in parallel with the orchestrator session as a sibling process (`codex exec -s read-only --skip-git-repo-check -C <runDir> -o codex-output.txt`) with an adversarial-review prompt reading the same `pr-context.md`. Its findings merge into the normal dedupe/post pipeline under reviewer name `codex`. Rationale: a different model family catches what the primary model misses. Opt out with `--no-codex`, `invoke_codex: false`, `PR_REVIEW_NO_CODEX=1`, or `--skip codex`; when codex isn't installed it's silently skipped (with a stderr note).

`prepareSessionContext` is exported so `pr-review review <url> --context-only` can prepare the context files and print the skill→reviewer routing table without spawning the runtime.

## Source map

```
src/
├── cli.ts                   # commander entry; subcommand routing
├── config.ts                # 5-level config merge (flags > env > repo yaml > global yaml > defaults)
├── dedupe.ts                # Jaccard token similarity, strict/loose/off modes
├── types.ts                 # shared types (Finding, ReviewerOutput, GatherOutput, etc.)
├── commands/
│   ├── review.ts            # full pipeline; runReview (+ --resume fast path, finalizeReview tail); exit code (0/1/2)
│   ├── gather.ts            # fetch PR metadata + comments in parallel → cache → JSON
│   ├── post.ts              # snapFindingsToDiff (snap + re-anchor: every finding lands inline) + batched posting with retry/backoff
│   ├── status.ts            # `status <run-id>`: live progress snapshot / summary / resume hint (--detach poll target)
│   ├── detach.ts            # `review --detach`: spawn a detached background run, return its run-id
│   ├── init.ts              # scaffold .pr-review/skills/ in a repo
│   ├── configure.ts         # write ~/.pr-review/config.yaml
│   ├── plugins.ts           # `plugins list` / `plugins doctor`
│   ├── cache.ts             # `cache info` / `cache clear`
│   └── config.ts            # `config show`
├── providers/
│   ├── types.ts             # PrProvider interface
│   ├── github.ts            # @octokit/rest, batched review posting + per-comment retry (inline only — no issue-comment fallback)
│   ├── azuredevops.ts       # azure-devops-node-api, LCS diff synthesis (per-run PR/git API cache)
│   └── index.ts             # detectProvider(url) switch
├── dispatch/
│   ├── single-session.ts    # prepareSessionContext (pr-context.md + skills-<reviewer>.md), orchestrator prompt, runs the runtime (parseFindingsFile is reused by --resume)
│   ├── runtime.ts           # resolveRuntime, runtimeSpawnArgs, taskCall, normalizeModel (copilot | claude | auto)
│   ├── codex.ts             # optional Codex second-opinion reviewer (sibling process, codex exec)
│   ├── line-snap.ts         # buildValidLinesMap + snapLineToDiff (snap findings to valid diff lines)
│   ├── parsers.ts           # JSON / bracketed-markdown / section-header parsers
│   └── diff-filter.ts       # strip lockfiles, generated code, vendor dirs
├── plugins/
│   ├── loader.ts            # resolve skills from all sources (loadAll has a skillsOnly option, used by review)
│   ├── builtin.ts           # ship agents/*.md as built-in reviewers
│   ├── companions.ts        # detect pr-review-toolkit / code-review installs (copilot plugin list | installed_plugins.json)
│   └── types.ts             # PluginManifest, ReviewerDef, SkillRef
├── cache/
│   ├── store.ts             # disk cache at ~/.pr-review/cache/
│   └── keys.ts              # key = provider+repo+pr+headSha+lastCommentId
└── util/
    ├── globs.ts             # minimatch wrapper
    ├── retry.ts             # retry/backoff helper (2s/5s/15s) for transient API errors
    ├── progress.ts          # progress.ndjson feed: appendProgress / readProgress / renderProgressSnapshot
    ├── posted-marker.ts     # posted.marker: idempotency guard for --resume re-posts
    └── tmp.ts               # ensureRunDir() + RUNS_ROOT → ~/.pr-review/runs/<id>/
```

## Plugin manifest layout

```
pr-review/                        # plugin root (loads in Copilot CLI and Claude Code)
├── .claude-plugin/plugin.json    # Claude Code manifest (canonical location; enables the bare /pr-review)
├── plugin.json                   # root manifest — Copilot CLI requires it here; kept in sync by scripts/release.mjs
├── .claude-plugin/marketplace.json  # single-plugin marketplace entry
├── commands/pr-review.md         # /pr-review slash command
├── agents/*.md                   # 7 built-in review agents (pr-review:<name>); no model: pin — they inherit the session model
├── skills/help/SKILL.md          # single documentation skill → one /pr-review:help palette entry
│   └── reference/*.md            #   per-topic docs the help skill points to (not SKILL.md → not separate skills)
├── dist/cli.cjs                  # esbuild single-file bundle
└── src/                          # TypeScript source
```

The slash command finds the bundle via `$CLAUDE_PLUGIN_ROOT/dist/cli.cjs` under Claude Code, falling back to `~/.copilot/installed-plugins/`.

## Key design decisions

**Why a CLI, not just skills?** LLMs are unreliable at API calls, deduplication, and posting comments. The CLI handles deterministic plumbing; LLMs only do reviewing.

**Why single-session?** One runtime process (copilot or claude) dispatches all reviewers via `task()` / `Task()` calls. Avoids N cold-start sessions and reduces wall-clock time ~42% vs the multi-process approach. The Codex second-opinion reviewer is the deliberate exception: it's a different CLI entirely, so it runs as one parallel sibling process.

**Why runtime-generic?** `src/dispatch/runtime.ts` isolates everything host-specific: spawn args (copilot: `--model X --allow-all-tools --no-ask-user --add-dir D -s`; claude: `-p --model X --dangerously-skip-permissions --add-dir D`), the task-tool vocabulary in the orchestrator prompt, and model normalization (the copilot-style default `claude-opus-4.8` maps to `opus` for the claude runtime; user-specified models pass through as-is).

**Why esbuild bundle?** `dist/cli.cjs` is a zero-dependency single file. No `npm install` needed after plugin install — the slash command just runs `node "$CLI"`.

**Why Jaccard dedupe?** Simple token overlap catches semantic duplicates across reviewers without an LLM call. Strict mode (default) uses 0.6 threshold + same file:line proximity.
