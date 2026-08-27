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
  1. detectProvider(url)        → GitHub, ADO, or GitLab
  2. resolveRuntime()           → copilot | claude | auto (probe PATH: copilot first, then claude)
  3. ensurePacks() + loadLinguist() → clone missing skill packs, load the Linguist language index (fail-soft, in parallel with gather)
  4. detectCompanions()         → check installed companion plugins (per runtime)
  5. runGather()                → fetch metadata + comments in parallel, diff (cached)
  6. earlyExitGate()            → abort if PR is malformed/too large (exit 2 + error.txt)
  7. loadAll({ skillsOnly })    → repo skills + pack skills + installed-plugin skills; rules the PR itself changed are dropped as untrusted
  8. detectStack()              → canonical Linguist languages + categorized ecosystem/dependency/token evidence from root and changed-file manifests
  9. selectPasses()             → project skills = context in every pass; passes ranked by evidence tier (glob > dependency > weak glob > tag, cap 6) + every baseline (on top of the cap); overflow/unmatched/index-mode → skills-index.md
 10. prepareSessionContext()    → pr-context.md + pass-<name>.md per pass + skills-all.md + skills-index.md + verifier.md + passes.json + stack.json + companions.json (+ capabilities.json / .mcp.json)
 11. runSingleSession()         → one runtime session, one generic agent per pass via task()/Task(); verifier only if Phase 1 has CRITICAL/HIGH
     └─ runCodex()              → optional Codex second-opinion reviewer as a parallel sibling process
 12. dedupe                     → intra-batch + against existing comments
 13. runPost() / renderSummary  → every finding posts inline (snap + re-anchor; GitHub batched review, ADO threads) or print summary
 14. exit code                  → 0 pipeline completed (findings may still be retained — see below), 1 findings ≥ --fail-on,
                                  2 pipeline OR operational failure (no parseable findings, zero passes on a code PR,
                                  failed prerequisite, missing/duplicate reviewer or companion output, failed/unverified post)
```

A single agent session (Copilot CLI or Claude Code, selected by `--runtime` / `runtime:` / `PR_REVIEW_RUNTIME`, default `auto`) dispatches every review pass and companion plugin via the `task` tool (copilot: `task(agent_type="general-purpose")`) or `Task` tool (claude: `Task(subagent_type="general-purpose")`) — the orchestrator prompt adapts its tool vocabulary to the runtime. There are no built-in reviewer agents: each pass is ONE skill (from a synced skill pack or the repo's own skill dirs) applied by a generic agent that reads its `pass-<name>.md`. Pack passes are named `<pack>/<skill>` (e.g. `awesome-copilot/go`); repo skills keep their plain name. Docs-only PRs run only glob/forced passes (never baseline). The orchestrator prompt instructs the session to launch the passes in parallel, collect their JSON arrays, then write a consolidated findings file — and NOT to read `pr-context.md` itself, keeping the orchestrator's context lean. Existing PR comments inside `pr-context.md` are wrapped in an untrusted-content fence. The verifier survives as a pipeline step: its brief is the `VERIFIER_BRIEF` constant, written to `verifier.md` and dispatched as another generic agent — only when Phase 1 produced at least one CRITICAL/HIGH finding — reading `phase1-findings.json` from the run dir rather than inline-spliced JSON. The Node CLI reads the findings file and handles dedupe + posting; if the orchestrator produced no parseable findings the run exits 2 (never a silent 0).

**Delivery is verified, not assumed.** Every dispatched pass and companion is instructed to write its own `raw-<reviewer>.json` *before returning*, so the run does not depend on the orchestrator surviving long enough to consolidate: if its turn ends after the tasks finish, the CLI recovers from the **complete** set of sidecars, and a partial set still fails closed. Planned companion dispatch names come from `companionReviewerNames()` and are reconciled against what was delivered — a missing or duplicated output, a failed or unverified post, or a failed review prerequisite is an *operational failure*: exit 2 with `error.txt`, named in the summary's Degraded block, and reported by detached `status` as failed rather than done. Findings that did parse still get a diagnostic summary. Conversely, exit 0 without `--fail-on` means the pipeline completed, not that nothing was found — the CLI prints how many findings were retained.

**Untrusted input.** Anything the branch under review authored cannot instruct its own review: a rule file the PR added or modified is dropped from both the authoritative context and the on-demand index (and named as degraded coverage), a changed `.pr-review.yaml` is ignored in favour of the trusted config, and changed repository MCP configuration is refused. `--force-skill` is the explicit per-file override; directory-level forced sources (`--skills-dir`, `extra_skills_dirs`, `PR_REVIEW_SKILLS_DIR`) bypass it too.

When the `codex` CLI is installed, a Codex second-opinion reviewer runs in parallel with the orchestrator session as a sibling process (`codex exec -s read-only --skip-git-repo-check -C <runDir> -o codex-output.txt`) with an adversarial-review prompt reading the same `pr-context.md` plus `skills-all.md` (the union of the pass skill bodies, also read by companion agents and the verifier). Its findings merge into the normal dedupe/post pipeline under reviewer name `codex`. A failed Codex run writes `codex-failure.log` (argv, exit code, full stdout + stderr) to the run dir — `codex-output.txt` is absent on an early exit, so the failure log is the artifact to read. Rationale: a different model family catches what the primary model misses. Opt out with `--no-codex`, `invoke_codex: false`, `PR_REVIEW_NO_CODEX=1`, or `--skip codex`; when codex isn't installed it's silently skipped (with a stderr note).

`prepareSessionContext` is exported so `pr-review review <url> --context-only` can prepare the context files and print the detected stack (`## Stack`) and the pass-routing table (`## Passes`: pass, matched by, matched on, source) plus the on-demand index count without spawning the runtime — exiting 2 when zero passes match a code PR.

## Source map

```
src/
├── cli.ts                   # commander entry; subcommand routing
├── config.ts                # 5-level config merge (flags > env > repo yaml > global yaml > defaults)
├── dedupe.ts                # Jaccard token similarity, strict/loose/off modes
├── types.ts                 # shared types (Finding, ReviewerOutput, GatherOutput, etc.)
├── commands/
│   ├── review.ts            # full pipeline; runReview (+ --resume fast path, finalizeReview tail); exit code (0/1/2) incl. operationalFailures
│   ├── gather.ts            # fetch PR metadata + comments in parallel → cache → JSON
│   ├── post.ts              # snapFindingsToDiff (snap + re-anchor: every finding lands inline) + batched posting, reconciled against the PR before any retry/fallback
│   ├── status.ts            # `status <run-id>`: live progress snapshot / summary / resume hint (--detach poll target)
│   ├── detach.ts            # `review --detach`: spawn a detached background run, return its run-id
│   ├── init.ts              # scaffold a starter team-rules skill in a repo
│   ├── configure.ts         # write ~/.pr-review/config.yaml
│   ├── packs.ts             # `packs list` / `packs sync` / `packs add` / `packs suggest`
│   ├── doctor.ts            # `doctor`: runtimes, skill packs, codex + companions, provider auth
│   ├── plugins.ts           # `plugins list` / `plugins doctor`
│   ├── cache.ts             # `cache info` / `cache clear`
│   └── config.ts            # `config show`
├── providers/
│   ├── types.ts             # PrProvider interface
│   ├── github.ts            # @octokit/rest, batched review posting + per-comment retry (inline only — no issue-comment fallback)
│   ├── azuredevops.ts       # azure-devops-node-api, LCS diff synthesis (per-run PR/git API cache)
│   ├── gitlab.ts            # plain fetch, per-discussion posting
│   ├── identity.ts          # canonicalPrAuthority: legacy visualstudio.com / encoded HTTPS / ssh.dev.azure.com remotes → one authority (incl. ADO project)
│   └── index.ts             # detectProvider(url) switch
├── packs/
│   ├── sync.ts              # ensurePacks (review-time clone-if-missing), `packs sync` clone/pull, staleness tracking
│   └── load.ts              # enumerate + parse skill files from synced packs (include/exclude globs)
├── stack/
│   ├── linguist.ts          # download/cache GitHub Linguist languages.yml → language tags per changed file
│   ├── manifests.ts         # dependency names + groups from root manifests AND manifests owning changed files; ecosystem tags per manifest kind
│   └── detect.ts            # detectStack: categorized language / ecosystem / dependency / token evidence + cwdMatchesPr
├── dispatch/
│   ├── single-session.ts    # prepareSessionContext (pr-context.md + pass-*.md + skills-all.md + skills-index.md + verifier.md + passes.json), PASS_RULES + VERIFIER_BRIEF, orchestrator prompt, runs the runtime; raw-<reviewer>.json sidecar contract + overlayReviewerFiles recovery (parseFindingsFile is reused by --resume)
│   ├── pass-select.ts       # selectPasses: project skills → context; evidence-tiered pack passes (MAX_STACK_PASSES cap) + baselines on top of the cap; index overflow
│   ├── skill-match.ts       # name/description relevance heuristic for untargeted repo skills
│   ├── runtime.ts           # resolveRuntime, runtimeSpawnArgs, taskCall, normalizeModel (copilot | claude | auto)
│   ├── codex.ts             # optional Codex second-opinion reviewer (sibling process, codex exec)
│   ├── line-snap.ts         # buildValidLinesMap + snapLineToDiff (snap findings to valid diff lines)
│   ├── parsers.ts           # JSON / bracketed-markdown / section-header parsers
│   └── diff-filter.ts       # strip lockfiles, generated code, vendor dirs
├── plugins/
│   ├── loader.ts            # resolve skills from all sources (loadAll has a skillsOnly option, used by review)
│   ├── builtin.ts           # parse skill .md files: frontmatter + body, name normalization
│   ├── trust.ts             # rule files the PR changed are untrusted; only --force-skill overrides
│   ├── installed.ts         # host-agnostic plugin discovery (Copilot CLI + Claude Code) + the MCP capability inventory
│   ├── companions.ts        # detect pr-review-toolkit / code-review installs (copilot plugin list | installed_plugins.json); companionReviewerNames = the planned dispatch list
│   └── types.ts             # PluginManifest, PluginReviewerEntry, PluginSkillEntry
├── cache/
│   ├── store.ts             # disk cache at ~/.pr-review/cache/
│   └── keys.ts              # key = provider+scope+pr+headSha+lastCommentId (ADO scope includes the project)
└── util/
    ├── globs.ts             # minimatch wrapper
    ├── retry.ts             # retry/backoff helper (2s/5s/15s) for transient API errors
    ├── progress.ts          # progress.ndjson feed: appendProgress / readProgress / renderProgressSnapshot
    ├── git.ts               # gitTopLevel(): resolve the checkout root once, so a run from a subdirectory still finds repo config/rules
    ├── posted-marker.ts     # posted.marker: idempotency guard for --resume re-posts
    └── tmp.ts               # ensureRunDir() + RUNS_ROOT → ~/.pr-review/runs/<id>/
```

## Plugin manifest layout

```
pr-review/                        # plugin root (loads in Copilot CLI and Claude Code)
├── .claude-plugin/plugin.json    # Claude Code manifest (its canonical location). NOTE: the plugin no longer ships agents/, so current Claude Code should mint the bare /pr-review alias; if it doesn't, use /pr-review:pr-review or a personal ~/.claude/commands/pr-review.md as a fallback
├── plugin.json                   # root manifest — Copilot CLI requires it here; kept in sync by scripts/release.mjs
├── .claude-plugin/marketplace.json  # single-plugin marketplace entry
├── commands/pr-review.md         # /pr-review slash command
├── skills/help/SKILL.md          # single documentation skill → one /pr-review:help palette entry
│   └── reference/*.md            #   per-topic docs the help skill points to (not SKILL.md → not separate skills)
├── dist/cli.cjs                  # esbuild single-file bundle
└── src/                          # TypeScript source
```

The slash command finds the bundle via `$CLAUDE_PLUGIN_ROOT/dist/cli.cjs` under Claude Code, falling back to `~/.copilot/installed-plugins/`.

## Key design decisions

**Why a CLI, not just skills?** LLMs are unreliable at API calls, deduplication, and posting comments. The CLI handles deterministic plumbing; LLMs only do reviewing.

**Why passes instead of built-in reviewers?** Review knowledge is content, not code: every pass is one skill applied by a `general-purpose` agent, so expertise lives in versioned git repos (skill packs) and the repo's own skill dirs instead of prompts baked into the plugin. Pass selection is deterministic (Linguist language tags + globs + dependency tags — no hand-written language table), and the only review-shaped text this repo still owns is the pipeline rules (`PASS_RULES`) and the verifier brief (`VERIFIER_BRIEF`).

**Why single-session?** One runtime process (copilot or claude) dispatches all review passes via `task()` / `Task()` calls. Avoids N cold-start sessions and reduces wall-clock time ~42% vs the multi-process approach. The Codex second-opinion reviewer is the deliberate exception: it's a different CLI entirely, so it runs as one parallel sibling process.

**Why runtime-generic?** `src/dispatch/runtime.ts` isolates everything host-specific: spawn args (copilot: `--model X --allow-all-tools --no-ask-user --add-dir D -s`; claude: `-p --model X --dangerously-skip-permissions --add-dir D`), the task-tool vocabulary in the orchestrator prompt, and model normalization (the copilot-style default `claude-opus-4.8` maps to `opus` for the claude runtime; user-specified models pass through as-is).

**Why esbuild bundle?** `dist/cli.cjs` is a zero-dependency single file. No `npm install` needed after plugin install — the slash command just runs `node "$CLI"`.

**Why Jaccard dedupe?** Simple token overlap catches semantic duplicates across passes without an LLM call. Strict mode (default) uses 0.6 threshold + same file:line proximity.
