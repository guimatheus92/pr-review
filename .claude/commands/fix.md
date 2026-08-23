---
description: 'Fix PR review comments — drive the deterministic /fix CLI (gather → classify → visual gate → fix → post+verify). The CLI does all gh/GraphQL plumbing; you do only the judgment.'
argument-hint: '<PR number | PR URL | discussion URL for focused mode>'
allowed-tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash
  - TodoWrite
  - AskUserQuestion
---

# Fix PR Review Comments Skill

You are driving a **CLI**, not doing gh/GraphQL plumbing by hand. The CLI (`tools/cli/dist/fix.js`) fetches every review thread in one call, posts every reply UTF-8-safe by construction, resolves FIXED threads, and re-verifies the end state. None of that costs LLM tokens or can be forgotten. Your ONLY job is the judgment: classify each comment, decide fix vs skip, apply the code changes, and author the reply prose.

## Forbidden

- Running `gh api`, `gh api graphql`, or `gh pr view` by hand for anything the CLI covers (threads, replies, resolves, verification).
- Writing reply bodies into bash heredocs or `-f body="..."` — replies go in the **decisions JSON** written via the Write tool; the CLI passes them to `gh` as argv. The old "Windows heredoc mangles `ç`/`—` to `?`" bug (PR #944) cannot happen here.
- Depending on a standalone `jq` binary (the PR #407/#887 silent-resolve failure). The CLI never uses it.
- Posting any PR-level "Conversation" comment (`gh pr comment`, issues/comments roll-ups, "Round N summary"). `/fix` communicates ONLY via per-thread replies (handled by the CLI) and the chat reply to the invoking user. There is no third audience.
- Editing `tools/cli/src/*` to rescue a failing run. If the CLI is broken, stop and tell the user.
- Claiming success without quoting the `post` verification output.

## Scope contract

**Full PR mode** (`/fix <PR_URL>` or `/fix <NUMBER>`): the user has authorized processing **every** review comment. Do NOT stop midway to ask "continue with the remaining N?", do NOT present a go/no-go plan (TodoWrite is your working memory; stream progress as status updates), do NOT decline architectural refactors on scope grounds. If a fix is genuinely too large for this PR (multi-repo refactor, missing infrastructure), file a follow-up issue, set the decision to `DEFERRED` with a reply linking the issue, and leave the thread unresolved — that counts as addressed.

**Focused mode** (URL contains `#discussion_r<ID>` or `#pullrequestreview-<ID>`): gather auto-detects it and returns only the targeted thread(s). Process only those — do not expand scope. Set `onlyThreads` in the decisions file to the returned thread ids. Skip lesson extraction and the full summary; present the brief focused result instead.

The ONLY mid-flow pauses allowed:

1. A destructive operation **outside the comment's scope** affecting remote/external state (force-push, drop a DB table, rotate secrets, delete a remote branch). Local-only changes the reviewer requested — even large deletions/refactors — do NOT count (`git restore` recovers them).
2. A comment that explicitly asks the user to choose "A or B" — quote the choice and ask.
3. **The Visual/UX gate (Step 3)** — the one structured checkpoint this skill runs by design.

## Language rules

- **In-thread replies** (the `reply` fields in the decisions JSON): match the language of the specific reviewer comment. Copilot in English → English; human in Portuguese → Portuguese.
- **Status updates / questions to the invoking user**: match the user's conversation language.

These are independent — one run can post English replies while reporting status in Portuguese.

## Step 0: Bootstrap the CLI

```bash
ROOT="$(pwd | grep -o '.*PrecoPratico')"
CLI_DIR="$ROOT/PrecoPratico-Docs/tools/cli"
CLI="$CLI_DIR/dist/fix.js"
TMP="$HOME/.claude/tmp"
mkdir -p "$TMP"
test -f "$CLI" || (cd "$CLI_DIR" && npm install --silent && npm run build)
# Rebuild when any source file is newer than the bundle (stale-dist gate)
[ -n "$(find "$CLI_DIR/src" -name '*.ts' -newer "$CLI" 2>/dev/null | head -1)" ] && (cd "$CLI_DIR" && npm run build)
```

## Step 1: Gather

Derive `REPO_DIR` from the PR URL's repo name (`$ROOT/<repo-name>`). If `$ARGUMENTS` is a bare number, ask which repository (Backend, Frontend, or Types) — the one routine question of the happy path.

```bash
node "$CLI" gather --pr "<raw argument>" --repo "$REPO_DIR" > "$TMP/fix-gather.json"
```

Then `Read: $TMP/fix-gather.json`. One call gives you: PR meta + body, **linked issues** (`linkedIssues[]` — the original bug context for Step 5's regression check), top-level Conversation comments (with `id` — reply targets via `conversationReplies`, see 4.5), and every unresolved review thread with `threadId`, `replyToId`, `path:line`, `diffHunk`, full comment chain, `authorKind` (`human`/`ai-bot` — CI bots are already dropped and counted in `skipped`), `viewerCanResolve`, and `alreadyRepliedByMe`. Resolved threads are omitted (count in `skipped.resolvedThreads`); pass `--include-resolved` only if you need them.

Self-review findings from a locally-run `/pr-review` are authored by YOUR account with a single comment — the CLI correctly treats those as actionable (`alreadyRepliedByMe` only turns true once the thread has your reply on top of the original comment). Process them like human comments.

- `checkout.ok: false` → the branch could not be checked out (fork PR or dirty tree). Stop before editing any code and ask the user how to proceed.
- `pr.state` is `MERGED`/`CLOSED` → warn the user that fixes land on the current branch, not the PR.
- Threads with `alreadyRepliedByMe: true` were handled by a previous run — they are not actionable (the CLI's completeness check ignores them too). Re-process one only if a reviewer replied after you.

Now read `$REPO_DIR/AGENTS.md` — CRITICAL for knowing what a correct fix looks like in that repo.

## Step 2: Classify every thread

Build a TodoWrite list — **one todo per thread** (`<short title> — <path>:<line>`). Replies are no longer sibling todos: the CLI's completeness check makes a forgotten reply structurally impossible (Step 6 hard-errors listing any actionable thread without a decision).

Classify each thread into a track:

| Track                  | Criteria                                                                                              | Examples                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Simple Fix**         | Obvious from the comment itself. One file, <3 lines, no new logic.                                    | Missing decorator, typo, dead code, hardcoded value → parameter                                     |
| **Development Task**   | New logic, new files, data-model understanding, or coordinated multi-file changes.                    | Service-layer validation, count enforcement, custom validators, new test files, cross-repo changes  |
| **Visual/UX Decision** | Requires Figma reference, visual comparison, or UX knowledge that cannot be resolved from code alone. | Default slider values, font sizes, colors, spacing, proportions, preview behavior, component sizing |

Heuristics: needs a new file or tracing data flow → Dev Task; references screenshots/Figma/"should be X px" without a code-traceable source, or a Loom showing wrong visual behavior → Visual/UX. AI-bot threads (Copilot, CodeRabbit, self-comments from a previous `/pr-review` run) are classified and processed with the SAME criteria as human comments.

Process order: Simple first, Dev Tasks second, Visual/UX last.

## Step 3: Visual-impact gate (AskUserQuestion — BEFORE any fix is applied)

**Any thread — regardless of track — whose fix would change what the end user sees or perceives must be approved by the invoking user first.** This includes changes whose correct value IS code-traceable. It encodes the team rule: review fixes that create new visible behavior need business sign-off before shipping (learned in Frontend PR #1034, three rework rounds).

Visual-impact means the fix touches any of: JSX/markup structure, CSS/Tailwind classes, user-facing text or i18n values, layout/spacing/colors/sizes, or visible behavior (toasts, modals, redirects, navigation flow, loading states).

1. After classification, collect ALL visual-impact threads (from every track).
2. Batch them into **one AskUserQuestion call with up to 4 questions** (chunk sequentially if more). Per question: header `Visual N`; question text = "@reviewer em `path:line`: '<comment summary>' — a correção vai <concrete visible change, e.g. 'mudar o tab desabilitado de 75/25 para 50/50'>. Aplicar?"; options:
   - **Aplicar** — proceed with the fix as the reviewer asked.
   - **Pular** — decision becomes `SKIPPED`, reply tells the reviewer the author deferred this for product review (in the reviewer's language), thread stays open.
   - **Ajustar** — the user supplies the value/direction via "Other"/notes; fix with their input.
3. Value precedence when applying: Figma link in the PR/issue (extract exact values) → exact values the reviewer gave → values the user gave in the gate. **NEVER guess visual values** — wrong defaults/colors/sizes are worse than an open thread.
4. Threads with no visual impact skip this gate entirely — do not ask about backend logic, types, or test-only changes.

## Step 4: Fix loop (judgment core)

Process each thread ONE BY ONE in the todo order. When N threads converge on the same underlying fix, apply the code edit ONCE, but write one decision per thread, each reply customized to what THAT reviewer raised.

### 4.1 Read the code

Read the file at `path:line` with enough context to understand the full picture. **Never fix blindly from the comment alone.**

### 4.2 Deep analysis before deciding

**Never trust a review comment at face value — especially from AI bots.** They do not understand custom decorators, internal pipelines, or project patterns. Treat their suggestions with MORE skepticism than human reviews.

Risk-classify the change:

| Risk       | Description                                                                                                                    | Required analysis                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| **Low**    | Validation decorators, typos, imports, dead code                                                                               | Read the file, verify correctness                |
| **Medium** | Logic flow, error handling, return values, data structures                                                                     | Read the file + trace how callers use the result |
| **High**   | NestJS decorators (`@Body`, `@UseInterceptors`, `@UseGuards`), request data flow, interceptor/middleware, auth, event handlers | **Trace the full pipeline** (below)              |

**Pipeline trace (MANDATORY for High risk):** read the source of every composed decorator/interceptor on the method; map what sets/transforms/validates `request.body` and in what order; check for double processing; when a comment says "do it like controller X", verify X has the SAME decorator composition.

Known incompatibilities in this project:

- `@Body()` + `@FilesPipeline` = **BROKEN** — `FilesPipelineHandler` merges audit fields into `request.body` via `plainToInstance()`; the global `ValidationPipe` (`forbidNonWhitelisted`) then rejects them. Correct pattern: `request.body as DtoType`.
- `useId()` + CSS attribute selectors = **BROKEN unescaped** — React ids contain `:` (e.g. `:r3:`), which breaks `[attr=":r3:"]` selectors silently (`closest()` returns null). Use `CSS.escape()` or prefer `ref.current.contains(target)`. Found in Frontend PR #871 (popover "blink and close" regression).

**AI-bot code-suggestion blocks need a runtime-value trace:** identify every variable in the suggested code that comes from `useId()`/refs/props/context/external data, write down what each value literally looks like at runtime (real strings, not types), and walk the suggestion through with those values. Adopting a verbatim suggestion without this trace is the most common source of "review fix introduced a regression".

**Address it if:** real bug/security/correctness issue; violates AGENTS.md patterns; genuine performance gain; missing validation/error handling/edge case; naming violation; unsafe casts; dead code; clearly better readability; **DRY violation** (identical structure differing only by a parameter → extract a shared util — never dismiss as "over-engineering"); extraction to its own file when sibling files follow that pattern; AND (if High risk) the pipeline trace confirms it's safe.

**Skip it if:** purely stylistic with no AGENTS.md backing; a question, not a request; already addressed in a later commit; praise; factually wrong about the code; would add genuine unnecessary complexity (premature generalization, obscuring abstractions — but NEVER use this against DRY fixes); contradicts project patterns; conflicts with a custom decorator/pipeline the reviewer can't see (include the trace in your reply).

### 4.3 Apply the fix — surgical precision

Edit ONLY what the comment targets. If a code block contains multiple independent changes and the comment addresses one, fix ONLY that one — do not touch adjacent lines (e.g. reverting `shallow: true` must not also revert a nearby debounce value). Frontend colors: use Tailwind config names (`text-blue-dark-ultra`), never raw hex when a config equivalent exists (exception: SVG props need raw hex).

### 4.4 Dev Task extras (for `[Dev Task]` and applied `[Visual/UX]`)

**Think before you code** (skip for `[Simple]`): reason explicitly about (1) an existing pattern/hook/util to reuse — grep for it, do not build a parallel implementation; (2) blast radius — sibling files needing the same change, tests locking old behavior, types propagating cross-repo; list touched files BEFORE editing; (3) regression risk vs the original PR fix (Step 5). If a `[Simple]` comment reveals dev-task surface mid-edit, STOP, re-classify, run this gate.

Read `.claude/skills/dev-workflow/dev-checklist.md` and the relevant creation guide (e.g. `backend-guide/create-services.md`). Apply all checklist rules — especially: sanitize user-facing content, `Promise.all` for independent async, English-only code, reuse before create, named exports, no `as any`, no dead code/TODOs.

New testable logic gets tests: Backend colocated `.spec.ts`; Frontend in `src/tests/`; stories in `src/stories/Components/<Category>/` (never next to the component). Skip tests for trivial decorator additions already covered.

Self-review after ALL Dev Tasks: every frontend rule has server-side enforcement; count limits server-side; `@StripHtml()` + `@MaxLength()` on user-input text; i18n `{variable}` interpolation and keys actually referenced; sibling-pattern consistency; all conditional branches tested.

### 4.5 Record the decision (IMMEDIATELY after each thread)

Append the thread's decision to `$TMP/fix-decisions.json` (create on first use via Write, then Edit per thread — this file is the crash-safe progress record; a dead session resumes by re-running gather + post, both idempotent):

```json
{
  "pr": "https://github.com/<owner>/<repo>/pull/<N>",
  "onlyThreads": ["<threadId>"],
  "decisions": [
    {
      "threadId": "PRRT_...",
      "replyToId": 123456789,
      "status": "FIXED | SKIPPED | DEFERRED",
      "reply": "<in the reviewer's language — what changed and why, or the specific skip reason>"
    }
  ],
  "conversationReplies": [
    { "commentId": 987654321, "reply": "<answer to a top-level Conversation comment>" }
  ]
}
```

(`onlyThreads` only in focused mode.) `conversationReplies` is for top-level Conversation-tab comments (human/ai-bot) that ask something actionable — the CLI posts each as a comment quoting the original (a targeted reply, which is allowed; roll-up summaries remain forbidden). Comments that need no answer stay untouched. Reply quality: `Fixed — see commit` teaches nothing; `Fixed — collapsed N round-trips into one $in query per your #8 suggestion` earns the resolve. For SKIPPED, give the real reason (for High-risk skips, the pipeline trace). For DEFERRED, link the follow-up issue. Statuses: `FIXED` → CLI resolves the thread; `SKIPPED`/`DEFERRED` → thread stays open for the reviewer.

Mark the todo completed and give the user a one-line status update.

## Step 5: Regression check vs the original bug (MANDATORY)

Re-read `pr.body` and `linkedIssues` from the gather JSON. If any review fix touches the **same code path** as the original fix, write a **narrative prose trace** — one numbered step per line, with the literal runtime values that flow through (real ids, strings, DOM targets — not types). A bullet like "✅ original fix preserved" is a hypothesis, not a trace. Hard rule: **no event-handling change ships without a written trace** (`onClick`, `onInteractOutside`, focus/blur, `pointer-events`, click-outside), even when the change "looks like a safe narrowing" — narrowing is the single most common regression source. If the trace reveals the bug can return, fix it before Step 6. For UI bugs you haven't browser-tested, label the check a hypothesis and tell the user which flow to verify.

Why: review suggestions are evaluated in isolation and may break the original fix when composed — e.g. the `isPlaceholderData` guard that regressed the "prevent search flash" fix, and PR #871's `aria-controls="${listId}"` selector that silently reintroduced the popover blink.

## Step 6: Project checks

```bash
cd "$REPO_DIR" && npm run emit && npm run lint && npm run format && npm run test   # Backend & Frontend
cd "$REPO_DIR" && npm run build && npm run lint && npm run format                  # Types
```

Fix failures before proceeding. If a fix introduces cascading errors, fix them or revert it.

## Step 7: Post + verify (the CLI does everything)

```bash
node "$CLI" post --decisions "$TMP/fix-decisions.json" > "$TMP/fix-verify.json"
```

The CLI: re-fetches fresh thread state → **completeness check** (every actionable thread must have a decision — on failure it exits 1 listing the missing `threadId path:line`; write those decisions and re-run, it's idempotent) → posts each reply (skips threads already answered by you; retries transient 422 bursts) → resolves ONLY `FIXED` threads with `viewerCanResolve` → **verification sweep** re-asserting for every decision: reply landed as the last comment, body matches your draft, `FIXED` → `isResolved: true`.

Read `$TMP/fix-verify.json`. `verified: true` → done. Any `failures[]` → report them honestly to the user with the notes; re-run `post` after addressing (a locked thread that can't be resolved comes back as a warning-pass with `viewerCanResolve=false` noted). On huge PRs you may checkpoint mid-run with `--partial` (posts what exists so reviewers see progress), but the final run must be a full `post`.

**Do not commit automatically** (unchanged rule): present the summary and let the user decide — suggest `/pr` or commit only when asked. If the user asked you to commit/push during the run, do it BEFORE `post` so replies can cite the real SHA.

## Step 8: Extract lessons & update documentation (full mode only)

Every FIXED comment is a knowledge gap. For each, find the root cause: convention in review docs but missing from creation guides → add it there; pattern visible in code but undocumented → document it; one-off typo / already documented / too specific → skip. Add rules in the target file's "Common Mistakes"-style section using the ✅/❌ dev-checklist format, one code-example pair, ending with "Found in PR #N."

Targets (all under `PrecoPratico-Docs/.claude/skills/`): DTO/validation → `backend-guide/create-database.md`; controllers/services/tests → matching `backend-guide/create-*.md`; components/hooks/forms/state/API services/tests → matching `frontend-guide/create-*.md`; naming → `conventions/*.md`; security/performance/general quality → `dev-workflow/dev-checklist.md`; poster domain → relevant `pp-*/SKILL.md` (+ `pp-core-erros-comuns`); render → `render-guide/SKILL.md`; types → `types-guide/SKILL.md`; cross-repo → `workspace-workflow/SKILL.md`.

If no lessons are extractable, state why explicitly.

## Step 9: Final summary + regression-risk triage

Present to the user (chat only — NEVER on the PR):

```markdown
## Fix Summary — PR #<N>

| Metric                                          | Count               |
| ----------------------------------------------- | ------------------- |
| Threads processed / FIXED / SKIPPED / DEFERRED  | <N>/<N>/<N>/<N>     |
| Visual gate: approved / skipped by user         | <N>/<N>             |
| Files modified / created · tests · docs updated | <N>/<N> · <N> · <N> |

### Decisions

<one table row per thread: reviewer, path:line, decision, what was done / why skipped>

### Verification (from fix-verify.json — cite it, do not paraphrase from memory)

<verified: true/false, posted/resolved counts, any failures>

### Build/Lint/Test status

<real command results>

### Regression-risk triage (PULA / POSSÍVEL / TESTAR)

<classify the applied fixes using the /audit-fixes Phase 2.5 heuristic (read
`.claude/commands/audit-fixes.md` §Phase 2.5 when unsure): PULA = covered by
Jest/cosmetic/type-only; POSSÍVEL = logic with limited scope AND a concrete
hypothesis; TESTAR = browser side effects, @media print, timing/races,
FE↔BE integration, lifecycle, big correlated batches.>

**If any TESTAR:** recomendo rodar `/audit-fixes <PR_URL>` antes do merge — cenários sugeridos: <one line each>.
**If none:** nenhuma mudança de classe TESTAR — validação manual de rotina é suficiente.

### Next steps

<commit via /pr, /audit-fixes if TESTAR, etc.>
```

Focused mode replaces all of Step 8–9 with the brief block: file, reviewer, decision, changes, verification line.

## Important rules (carry-overs that still bind)

1. **Thread awareness** — if the reply chain shows the reviewer already agreed it's not needed, SKIP with that context.
2. **Cross-repo awareness** — a comment requiring changes in another repo becomes a summary action item, never a silent edit there.
3. **Honest reporting** — failed checks are reported with output; skipped steps are named; "verified" only with the sweep JSON as evidence.
4. **Self-comments from `/pr-review` are first-class** — process them like human comments; replying to your own prior findings is normal.
5. **Dev Tasks follow dev rules** — originating from a review comment does not exempt new logic from `dev-checklist.md` standards.
