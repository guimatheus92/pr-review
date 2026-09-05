---
description: "pr-review architecture: execution model, source map, and design decisions. Use when asked how pr-review works internally, what the single-session dispatch does, where code lives, or why it's structured as a CLI instead of pure skills."
---

# Architecture

## Execution model

The ordered pipeline, as the Node CLI runs it (the README's [How it works](../../../README.md#how-it-works) diagram is this same sequence, drawn):

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
 10. prepareSessionContext()    → materialized inputs (including indexed skill bodies) + HMAC-authenticated dispatch plan
 11. runSingleSession()         → dispatch-only runtime; Node validates/promotes attempt files
     ├─ selective recovery     → one automatic session for unresolved reviewers only
     └─ runCodex()             → optional attempt-scoped read-only sibling
 12. assemble Phase 1           → only after every planned reviewer is valid
 13. direct verifier            → separate session only for CRITICAL/HIGH Phase 1 findings
 14. dedupe                     → complete delivery only; intra-batch + existing comments
 15. runPost() / renderSummary  → inline comments or complete dry-run summary
 16. exit code                  → 0 complete, 1 findings ≥ --fail-on, 2 incomplete/operational failure
```

The sections below define its delivery, trust, and recovery guarantees.

A single agent session (Copilot CLI or Claude Code, selected by `--runtime` / `runtime:` / `PR_REVIEW_RUNTIME`, default `auto`) dispatches every Phase 1 pass and companion through `task` / `Task`. Every call has a deterministic `description` and an attempt-scoped output path. The orchestrator is dispatch-only: it cannot create Phase 1, decide the verifier, or write consolidated findings. Node validates exact `Finding[]`, promotes write-once canonical sidecars, preserves valid work, and dispatches only the unresolved delta in one automatic recovery session. A schema-v1 `--resume` gets the bounded final targeted attempt under one per-run lease that remains held through finalization.

Every pass reads its own `pass-<name>.md`. When pass selection leaves shared project context, `skills-project.md` carries it to every pass, Codex, direct companion agent, and the verifier. This is normally every matched project rule; in the no-pack fallback, up to ten project rules become the passes and only overflow remains shared context. When no shared project context remains, `skills-all.md` is a budgeted union of selected pass bodies used as the Codex/direct-companion/verifier fallback. The `code-review` slash companion receives the PR URL through its command instead of either shared skills file. The on-demand index remains available separately to each pass.

**Untrusted input.** Anything the branch under review authored cannot instruct its own review: a rule file the PR added or modified is dropped from both the authoritative context and the on-demand index (and named as degraded coverage), a changed `.pr-review.yaml` is ignored in favour of the trusted config, and changed repository MCP configuration is refused. Configured skill dirs (`--skills-dir`, `extra_skills_dirs`, `PR_REVIEW_SKILLS_DIR`) are selected like repo skill dirs and go through the same trust check; `--force-skill <file|dir>` is the only bypass — per run, CLI only, with deliberately no yaml or env equivalent, so a committed config can never pre-authorize branch-authored content. Linked skill directories (symlinks, NTFS junctions) are followed one hop: a link the PR added or changed is refused before anything behind it is read and named as degraded coverage, and content outside the checkout is trusted by authorship, not location — it must be committed and clean in its home git repository (a directory under no repository at all is trusted as the reviewer's local configuration).

Node assembles Phase 1 in plan order only at complete Phase 1 delivery. HIGH/CRITICAL findings trigger a separate direct verifier runtime that reads the digest-bound Phase 1 file; otherwise state records `skipped-no-severe`. Node then assembles `single-session-findings.json` from Phase 1 plus any verifier output. Codex remains a separate reviewer output; only after the primary consolidation and enabled Codex coverage are valid does `runReview` call dedupe/post. Runtime exit 0 alone is never completion, and partial findings never post.

`dispatch-plan.json` and `delivery-state.json` in the run dir are diagnostic mirrors. Recovery authority lives under `~/.pr-review/control/<run-id>-<path-hash>/` in HMAC-authenticated envelopes; its key never enters prompts or runtime directories. State binds PR identity/head/base/branches, redacted effective config, bundle/input hashes, execution mode, attempts, canonical reviewer digests, verifier/Codex state, and posting outcome. Planned reviewer and verifier sessions are spawned with only the materialized run directory as `--add-dir` — `tests/single-session-retry.test.ts` pins that the checkout root is not added; large on-demand catalogs split into digest-bound index shards, with every body materialized locally and original-source provenance retained. Shell, web posting, ambient/built-in MCP tools, and checkout instructions are unavailable to those sessions, and a skill's sibling files are not materialized. Read-only access to the materialized context and diff is deliberately kept. Only a complete schema-v1 dry run may be promoted to publishing on resume; an incomplete one is refused, as is any publish-to-dry-run demotion. Previews and no-dispatch runs do not mint recovery authority.

When the `codex` CLI is installed, its read-only sibling runs in parallel and writes `codex-attempts/attempt-N.json`. Only exact top-level `Finding[]` JSON is valid. The attempt is reserved in authenticated state before launch, so a crash consumes the slot and a completed attempt can be adopted without rerunning. A failed attempt writes `codex-failure.log` and keeps delivery incomplete rather than disappearing from recovery.

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
│   ├── github.ts            # @octokit/rest, single-attempt inline review writes (post.ts owns reconciliation/retry; no issue-comment fallback)
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
│   ├── single-session.ts    # materialization, dispatch-only sessions, selective recovery, direct verifier, Node aggregation
│   ├── delivery.ts          # plan/state schemas, strict sidecars, promotion, digests, attempt ceilings
│   ├── reviewer-progress.ts # reviewer-progress.ndjson attempt/promotion events
│   ├── pass-select.ts       # project skills → context; evidence-tiered pack passes (MAX_STACK_PASSES cap) + baselines; sharded index overflow
│   ├── skill-match.ts       # name/description relevance heuristic for untargeted repo skills
│   ├── runtime.ts           # resolveRuntime, runtimeSpawnArgs, taskCall, normalizeModel (copilot | claude | auto)
│   ├── codex.ts             # optional Codex second-opinion reviewer (sibling process, codex exec)
│   ├── line-snap.ts         # buildValidLinesMap + snapLineToDiff (snap findings to valid diff lines)
│   ├── parsers.ts           # JSON / bracketed-markdown / section-header parsers
│   └── diff-filter.ts       # strip lockfiles, generated code, vendor dirs
├── plugins/
│   ├── loader.ts            # resolve skills from all sources (loadAll has a skillsOnly option, used by review); follows linked dirs one hop; skills roots are SKILL.md-owned
│   ├── builtin.ts           # parse skill .md files: frontmatter + body, name normalization
│   ├── trust.ts             # rule files the PR changed are untrusted; linked dirs trusted by authorship + commit-and-clean gate; only --force-skill overrides
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
    ├── atomic-json.ts       # durable JSON replace, non-mutating backup reads, writer-owned Windows recovery, SHA-256
    ├── control-auth.ts      # HMAC-authenticated recovery/posting authority
    ├── finalization-lease.ts # one crash-recoverable finalizer/poster per run
    ├── posted-marker.ts     # authenticated posting authority + diagnostic mirror
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

**Why single-session?** One runtime process dispatches all Phase 1 passes via `task()` / `Task()`. Node opens another dispatch session only for an unresolved delta, and a direct verifier session only when severe findings require it. The Codex second-opinion reviewer remains the deliberate parallel sibling.

**Why runtime-generic?** `src/dispatch/runtime.ts` isolates task syntax, model normalization, and permission flags. Both runtimes run with the materialized run directory as cwd, plus the checkout root as a second readable directory (`--add-dir`, `repoArg`) — read access to the checkout is deliberate. `--add-dir` grants access, not read-only access: what keeps a pass from writing there is the tool allowlist, not the flag. MCP is denied at the process level, not only the tool level, via `MCP_PROCESS_DENIAL` per runtime; the two differ in reach. claude's `--strict-mcp-config` is categorical: every MCP config source is ignored, and since no `--mcp-config` is passed, the run-dir `.mcp.json` is inventory/provenance only — no runtime loads it. copilot's `--disable-builtin-mcps` covers built-ins and is completed per name by `--disable-mcp-server`, so anything `discoverMcpCapabilities` fails to enumerate is outside its reach. Copilot also denies shell and checkout instructions; claude uses `dontAsk` plus an explicit Read/Write/Edit/Glob/Grep/Task/Agent allowlist and denies shell, web, and MCP tools. Task strings are JSON-escaped and carry mandatory descriptions.

**Why esbuild bundle?** `dist/cli.cjs` is a zero-dependency single file. No `npm install` needed after plugin install — the slash command just runs `node "$CLI"`.

**Why Jaccard dedupe?** Simple token overlap catches semantic duplicates across passes without an LLM call. Strict mode (default) uses 0.6 threshold + same file:line proximity.
