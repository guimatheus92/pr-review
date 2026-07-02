---
description: "pr-review architecture: execution model, source map, and design decisions. Use when asked how pr-review works internally, what the single-session dispatch does, where code lives, or why it's structured as a CLI instead of pure skills."
---

# Architecture

## Execution model

```
User: /pr-review <pr-url>
       │
       ▼  commands/pr-review.md
Copilot CLI runs: node "$CLI" review <pr-url>
       │
       ▼  src/cli.ts → src/commands/review.ts
Node CLI (deterministic plumbing)
  1. detectProvider(url)        → GitHub or ADO
  2. detectCompanions()         → check installed companion plugins
  3. runGather()                → fetch metadata, diff, comments (cached)
  4. earlyExitGate()            → abort if PR is malformed/too large
  5. loadAll()                  → discover skills from standard paths
  6. runSingleSession()         → one copilot session, all reviewers via task()
  7. dedupe                     → intra-batch + against existing comments
  8. runPost() / renderSummary  → post comments or print summary
```

A single `copilot` session dispatches all reviewers (built-in agents + companion plugins) via the `task` tool. The orchestrator prompt instructs the session to launch all reviewers in parallel, collect their JSON arrays, then write a consolidated findings file. The Node CLI reads that file and handles dedupe + posting.

## Source map

```
src/
├── cli.ts                   # commander entry; subcommand routing
├── config.ts                # 5-level config merge (flags > repo yaml > global yaml > env > defaults)
├── dedupe.ts                # Jaccard token similarity, strict/loose/off modes
├── types.ts                 # shared types (Finding, ReviewerOutput, GatherOutput, etc.)
├── commands/
│   ├── review.ts            # full pipeline orchestration
│   ├── gather.ts            # fetch PR metadata → cache → JSON
│   ├── post.ts              # post line-snapped comments to GitHub/ADO
│   ├── init.ts              # scaffold .pr-review/skills/ in a repo
│   ├── configure.ts         # write ~/.pr-review/config.yaml
│   ├── plugins.ts           # `plugins list` / `plugins doctor`
│   ├── cache.ts             # `cache info` / `cache clear`
│   └── config.ts            # `config show`
├── providers/
│   ├── types.ts             # PrProvider interface
│   ├── github.ts            # @octokit/rest, inline PR comments
│   ├── azuredevops.ts       # azure-devops-node-api, LCS diff synthesis
│   └── index.ts             # detectProvider(url) switch
├── dispatch/
│   ├── single-session.ts    # writes PR context, builds orchestrator prompt, runs copilot
│   ├── copilot.ts           # copilot subprocess spawning
│   ├── parallel.ts          # p-limit parallel dispatch
│   ├── materialize.ts       # render per-reviewer prompts
│   ├── parsers.ts           # JSON / bracketed-markdown / section-header parsers
│   └── diff-filter.ts       # strip lockfiles, generated code, vendor dirs
├── plugins/
│   ├── loader.ts            # resolve reviewers/skills from all sources
│   ├── builtin.ts           # ship agents/*.md as built-in reviewers
│   ├── companions.ts        # detect pr-review-toolkit / code-review installs
│   └── types.ts             # PluginManifest, ReviewerDef, SkillRef
├── cache/
│   ├── store.ts             # disk cache at ~/.pr-review/cache/
│   └── keys.ts              # key = provider+repo+pr+headSha+lastCommentId
└── util/
    ├── globs.ts             # minimatch wrapper
    └── tmp.ts               # ensureRunDir() → ~/.pr-review/runs/<id>/
```

## Plugin manifest layout

```
pr-review/                   # Copilot CLI plugin root
├── plugin.json              # name, commands, agents, skills paths
├── commands/pr-review.md    # /pr-review slash command
├── agents/*.md              # 7 built-in review agents (pr-review:<name>)
├── skills/*/SKILL.md        # documentation skills (loaded by Copilot CLI)
├── dist/cli.cjs             # esbuild single-file bundle
└── src/                     # TypeScript source
```

## Key design decisions

**Why a CLI, not just skills?** LLMs are unreliable at API calls, deduplication, and posting comments. The CLI handles deterministic plumbing; LLMs only do reviewing.

**Why single-session?** One `copilot` process dispatches all reviewers via `task()` calls. Avoids N cold-start sessions and reduces wall-clock time ~42% vs the multi-process approach.

**Why esbuild bundle?** `dist/cli.cjs` is a zero-dependency single file. No `npm install` needed after plugin install — the slash command just runs `node "$CLI"`.

**Why Jaccard dedupe?** Simple token overlap catches semantic duplicates across reviewers without an LLM call. Strict mode (default) uses 0.6 threshold + same file:line proximity.
