# pr-review — invariants

What this tool always does and never does. Every entry here is load-bearing: each
one exists because breaking it produced a real failure, or because breaking it
would make a review silently wrong rather than loudly broken.

**This document is the charter, not a summary of the code.** If the code stops
honouring an entry, that is a defect in the code — not a doc that needs
updating. Changing what the product guarantees means changing this file *first*,
in its own commit, with the reasoning.

## How to read an entry

Every invariant has a stable ID and five fields:

| Field | Meaning |
|---|---|
| `**Always:**` | The guarantee, in full. Universal unless the sentence itself scopes it. |
| `**Why:**` | The incident or the reasoning. Never "because it's cleaner". |
| `**Enforced:**` | Where the code makes it true (`src/…`). |
| `**Verified:**` | What would fail if it broke (`tests/…`, or the runtime check). |
| `**Check:**` | Exactly one of `run`, `run+pr`, `tests-only`, `human` — see below. |

`**Check:**` classes:

- **`run`** — `pr-review verify` proves it from a finished run's artifacts alone.
- **`run+pr`** — `pr-review verify` proves it by also reading the PR back through
  the provider API.
- **`tests-only`** — not observable from a run (an absence, a build property, or
  internal control flow). The suite is the guard; `verify` prints it as SKIP
  naming the test.
- **`human`** — a judgment call no check can make. Printed as SKIP too.

`verify` renders **one row per ID, always the full list**. A check that throws
renders FAIL, never a missing row. It exits `0` when every row passed or
skipped, `1` when the audit itself could not be completed (an unresolvable run,
or a live read-back failure that was not asked for with `--offline`), and `2`
when an invariant FAILed. An audit that could not read the PR is incomplete,
never clean — the same "unknown is not empty" rule INV-POST-04 lives by.

## The ID rule

**IDs are append-only and immutable.** Never rename one, never reuse a number.
An invariant that is genuinely retired keeps its ID and its block, with
`**Status:** retired in <version>` and a line saying what replaced it.

The ID is the join key between this file, the check registry in
`src/commands/verify.ts`, the `--json` output CI consumes, and CHANGELOG
entries. `tests/invariants-doc.test.ts` asserts the doc and the registry hold
exactly the same ID set, so a rename fails the suite immediately.

---

## POST — what reaches the pull request

### INV-POST-01 — Every eligible finding lands as a resolvable inline thread

**Always:** On a publish run every publication-eligible finding is posted as a resolvable
inline review thread — GitHub review comments, Azure DevOps threads, GitLab
discussions. Never a top-level comment. Lines outside the diff are snapped to
the nearest valid diff line. On GitHub and GitLab a finding that cannot anchor
where it points (file outside the diff, or no location at all) is re-anchored to
the first valid diff line with the original `file:line` kept in the body; on
Azure DevOps threads post at the reported `file:line` as-is, and a finding with
no location becomes a resolvable PR-level thread. `skipped` exists only for
`--dry-run`.

`--publish-min-severity` is an inclusive, case-insensitive, CLI-only publication
threshold: CRITICAL, HIGH, MEDIUM, LOW, or NIT. Omitted means NIT (publish all).
It applies only after complete delivery, verifier execution and deduplication.
Every final finding remains in the local artifacts before publication; findings
below the threshold are suppressed from publication, never attempted or called
skipped. The same explicit flag on `post` filters its input without rewriting it.

**Why:** A thread can be linked, replied to and resolved by the person who fixes
it. A comment cannot. Everything the tool produces is meant to be actionable at
a line, so anything that cannot be resolved is not a finding — it is noise the
next run has no way to reconcile against. Publication volume is an operator
decision, not permission to reduce review coverage or discard research evidence.

**Enforced:** `src/commands/post.ts` (`runPost`, `reanchor`),
`src/commands/review.ts`, `src/cli.ts`,
`src/dispatch/line-snap.ts`, `src/providers/github.ts`,
`src/providers/azuredevops.ts`, `src/providers/gitlab.ts`

**Verified:** `tests/post.test.ts`, `tests/line-snap.test.ts`,
`tests/providers/github.test.ts`

**Check:** run+pr

### INV-POST-02 — Never a top-level or summary comment

**Always:** pr-review never creates a top-level PR/issue comment. No review
body, no end-of-review summary post, no verdict, no status banner — on any
provider, in any mode, at any point in the run, including from a dispatched
agent. There is no `issues.createComment` fallback and none may be reintroduced.

**Why:** A top-level comment cannot be resolved, cannot be linked to a line, and
is invisible to the next run's dedupe — so it accumulates forever. The official
`code-review` companion's command allowed `gh pr comment` and instructed posting
a top-level "### Code review" verdict; a live run posted one on
Preco-Pratico/PrecoPratico-Backend#586 before `NO_POSTING_DIRECTIVE` existed.

**Enforced:** `src/providers/types.ts` (the interface has no top-level-comment
method), `src/providers/github.ts` (`postBatchComments` sends a body-less
review), `src/commands/post.ts` (reconciliation skips comments with no file),
`src/dispatch/single-session.ts` (`NO_POSTING_DIRECTIVE`)

**Verified:** `tests/providers/github.test.ts`, `tests/session-context.test.ts`

**Check:** run+pr

### INV-POST-03 — Clean output

**Always:** A posted comment body is the finding body and nothing else — no
severity prefix, no title, no bot chrome, no separator, no footer, no attribution
line. Publication counts belong in the local summary's aggregate metadata,
never in individual finding bodies.

**Why:** The comment competes for attention with human review on the same line.
Anything that is not the finding is a tax paid by every reader of every thread.

**Enforced:** `src/commands/post.ts`

**Verified:** `tests/post.test.ts`

**Check:** run+pr

### INV-POST-04 — A failed write is not proof that nothing was written

**Always:** Posting a comment is not idempotent, so a 5xx or timeout means
*unknown*, never *empty*. Providers make ONE attempt and throw. `runPost` owns
retry, because only `runPost` can reconcile first: it reads the PR back before a
retry, before the per-comment fallback, and before reporting a count. A failed
read-back returns `null`, and `null` is never treated as "nothing landed".
Comment identity is `file:line:body`, never body alone. Reconciliation is
one-way — an error may be promoted to posted, never the reverse. Every publish
attempt writes authenticated posting state plus the `posted.marker` mirror,
carrying `verified`.

**Why:** A 504 arriving after the server committed turned 56 findings into 112
live comments while the run reported `posted 0 / errors 56`. Every clause above
is one of the inferences that produced it.

**Enforced:** `src/commands/post.ts`, `src/util/posted-marker.ts`,
`src/util/retry.ts`

**Verified:** `tests/post.test.ts`, `tests/posted-marker.test.ts`

**Check:** tests-only

### INV-POST-05 — No duplicate comment from one run

**Always:** A run never leaves two comments at the same `file:line` with the
same body.

**Why:** This is the observable form of INV-POST-04 failing. It is asserted
after every reconciliation path in the suite because it is the damage the user
actually sees.

**Enforced:** `src/commands/post.ts`, `src/dedupe.ts`

**Verified:** `tests/post.test.ts`

**Check:** run+pr

### INV-POST-06 — The CLI is the only writer

**Always:** Dispatched agents never write to the pull request or the repository.
Every dispatch prompt — review passes, companion agents, companion slash
commands, the verifier, and the orchestrator itself — carries
`NO_POSTING_DIRECTIVE`. Any new dispatch path must thread it through.

**Why:** Same incident as INV-POST-02. An agent given a PR URL and shell access
will post, because posting looks like completing the task. The directive is the
only thing standing between a review pass and a comment nobody planned.

**Enforced:** `src/dispatch/single-session.ts`, `src/dispatch/runtime.ts`
(the spawn deny-list)

**Verified:** `tests/session-context.test.ts`, `tests/runtime.test.ts`

**Check:** run+pr

### INV-POST-07 — Nothing is dropped

**Always:** Every publication-eligible finding is either posted or reported as
an error. A finding is never silently discarded, and on a publishing run
`posted + errors === attempted === eligibleCount`. Suppressed findings remain
in `finalFindings`; `eligibleCount + suppressedCount === finalFindings.length`.
Zero eligible findings complete with zero attempted posts and full local evidence.

New runs bind the publication threshold into a schema-v2 authenticated dispatch
plan. Resume, including promotion of a complete dry run, honors that original
threshold; an explicitly conflicting threshold fails closed. Schema-v1 runs
retain publish-all behavior. `--force-post` bypasses posting idempotency only,
never the threshold or delivery/authentication gates. Partial publishing resume
reconciles and retries only eligible findings; confirmed publication progress is
cumulative and never removes findings from the retained review evidence.

**Why:** A count that does not balance hides losses in the gap. Silently
dropping the findings that were hardest to place means the tool is quietest
exactly where it is least reliable.

**Enforced:** `src/commands/post.ts`, `src/commands/review.ts`,
`src/dispatch/delivery.ts`, `src/util/posted-marker.ts`

**Verified:** `tests/post.test.ts`, `tests/resume.test.ts`, `tests/verify.test.ts`

**Check:** run+pr

---

## FETCH — completeness of context

### INV-FETCH-01 — An incomplete file list is unknown, never empty

**Always:** The provider's changed-file list is checked against the provider's
own count and its truncation flag. On any mismatch the list is completed from
the reviewer's checkout when that checkout is provably the PR's repository, and
otherwise the run fails **before** anything is cached. `changedFilesComplete` is
stamped only once the gate passed; a cache entry without it is refetched.

**Why:** `gather.changedFiles` feeds the rule-trust gate, `.pr-review.yaml`
trust, the MCP-config gate and manifest reading — and a path missing from it
reads as "unchanged", i.e. *trusted*. Azure DevOps reviewed every >100-file PR
on its first 100 files, from 0.6 through 0.10, because `$top` defaults to 100.

**Enforced:** `src/commands/gather.ts`, `src/providers/github.ts`,
`src/providers/azuredevops.ts`, `src/providers/gitlab.ts`

**Verified:** `tests/gather-cache.test.ts`, `tests/providers/github.test.ts`,
`tests/providers/azuredevops.test.ts`, `tests/providers/gitlab.test.ts`

**Check:** run+pr

### INV-FETCH-02 — All PR content and metadata is fetched once, into one artifact

**Always:** `pr-review-gather.json` carries the PR's title, description, author,
state, draft flag, base and head SHA and branch, linked work items, every
changed file — with its patch wherever one can exist and the run needs it, see
INV-FETCH-04 — and the existing comment thread. Every pass reads that artifact;
nothing in the pipeline re-fetches per pass.

The patch is absent in exactly three cases, none of which is a pass reviewing
blind: a file that has no diff anywhere (binary, pure rename, mode-only), a path
the diff exclusions drop, and a run already refused as too large, which fetches
no content at all and is marked `patchesOmitted`.

**Why:** A reviewer missing the description or the existing discussion re-raises
what was already answered, and per-pass fetching multiplies rate-limit exposure
by the pass count while letting two passes disagree about what the PR even is.

**Enforced:** `src/commands/gather.ts`, `src/dispatch/single-session.ts`

**Verified:** `tests/gather-cache.test.ts`, `tests/session-context.test.ts`

**Check:** run

### INV-FETCH-03 — No repo pollution

**Always:** Every run artifact goes under `~/.pr-review/`. pr-review never
writes to the reviewer's working directory — and that includes the checkout's
`.git`: it never runs `git fetch` or `git checkout` and never writes a ref.

**Why:** Git credentials are not the API token, a fetch inside a detached child
can take minutes, and fetching would import branch-authored objects into the
reviewer's repository. The truncated-list completion reads only objects already
present and otherwise fails with the exact command for the user to run.

**Enforced:** `src/util/tmp.ts`, `src/commands/gather.ts`, `src/util/git.ts`

**Verified:** `tests/gather-cache.test.ts`, `tests/tmp.test.ts`

**Check:** run

### INV-FETCH-04 — No content is fetched for a file that will not be reviewed

**Always:** File **content** is fetched only for files that can still reach a
review pass. A file the diff exclusions will discard gets no content fetch, and
once the in-scope count passes the too-many-files guard nothing is fetched for
any file: the list is completed with path-only rows and the run is refused. The
**path** list is unaffected — it is always complete (INV-FETCH-01), because it,
not the content, is what every trust gate reads.

**Why:** The guard runs after gather, so an oversized Azure DevOps PR paid for
every file before being refused: one `getItem` per added file and two per
modified one, each downloading a whole file body. Measured live on a 501-file
PR of additions: 501 requests and 5.1 s, then "PR is too large". Measured
hermetically on 501 modified files: 1002 requests. Both are now 0. The same
shape hit exclusions at any size: a `package-lock.json` was fetched and its
patch discarded on the next line by `applyDiffExclusions`. Work that cannot
reach a pass is work no PR should pay for.

**A patch-less row is never silently reviewed.** A gather that omitted patches
is marked, is never cached (a cached path-only list would come back as a whole
diff under a wider exclusion set), and the guard reads that mark *before*
exclusions — otherwise the byte-size gate sees 0 bytes and passes.

**Enforced:** `src/providers/azuredevops.ts`, `src/commands/gather.ts`,
`src/commands/review.ts`, `src/dispatch/diff-filter.ts`

**Verified:** `tests/providers/azuredevops.test.ts`, `tests/gather-cache.test.ts`,
`tests/zero-passes.test.ts`

**Check:** tests-only

---

## CTX — the run always knows what it is reviewing with

### INV-CTX-01 — The stack is always detected and recorded

**Always:** GitHub Linguist `languages.yml` tags the changed files by language,
and dependency and ecosystem evidence is read from manifests, kept categorized
rather than collapsed into one tag bag. `stack.json` exists on every run.
Empty evidence is a valid result but must carry a `note` saying why.

**Why:** Pass selection is stack-driven; a run that silently detected nothing
routes a generic review and looks identical to a run that correctly found
nothing to specialize on. The note is what separates the two.

**Enforced:** `src/stack/detect.ts`, `src/stack/linguist.ts`,
`src/stack/manifests.ts`

**Verified:** `tests/stack-detect.test.ts`, `tests/linguist.test.ts`,
`tests/manifests.test.ts`

**Check:** run

### INV-CTX-02 — Skills, plugins and MCP servers are always discovered and recorded

**Always:** Every run records what it found: `capabilities.json` (the resolved
runtime, the model string handed to the CLI, installed plugins with their MCP
servers, the discovered server inventory, warnings) and `passes.json` (every
known skill and where it was routed — dispatched, context, index, or skipped).
Finding nothing is a valid result. Not recording is not.

Ceiling, declared rather than implied: `model` is what pr-review *asked for*
after `normalizeModel`, not necessarily what served the session. `auto` is a
delegation. When Copilot reports one valid pre-dispatch Auto route, the runtime
attempt records it separately from the requested model; it is root-session
routing evidence, not per-reviewer served-model evidence. Selective reviewer
redispatch from `auto` reuses that authenticated root route from the initial
attempt; if it was not captured, the run cannot complete or redispatch rather
than inventing a model. A run needing a specific model requested must still pin
`--default-model`.

**Why:** "Why didn't it apply my rule?" is unanswerable without the routing
table, and an unrecorded capability inventory means a run cannot be audited
after the fact for what it could have reached. The runtime is part of that:
under `--runtime auto` no caller can tell from its own arguments which agent CLI
hosted the session, so without the record nothing on disk can prove it.

**Enforced:** `src/commands/review.ts`, `src/plugins/loader.ts`,
`src/plugins/installed.ts`, `src/dispatch/pass-select.ts`,
`src/dispatch/single-session.ts`

**Verified:** `tests/installed-plugins.test.ts`, `tests/pass-select.test.ts`,
`tests/skills-smoke.test.ts`, `tests/single-session-retry.test.ts`,
`tests/verify.test.ts`

**Check:** run

### INV-CTX-03 — Zero passes on a code PR is an error

**Always:** A code PR that matches no review pass exits 2 and writes
`error.txt`. It never renders a done-state summary. An empty review is never
reported as a clean PR.

**Why:** Exit 0 with no findings reads as "reviewed, nothing found". A routing
failure that produced no reviewer at all must not be able to impersonate that.

**Enforced:** `src/commands/review.ts`

**Verified:** `tests/zero-passes.test.ts`

**Check:** run

### INV-CTX-04 — Passes, not reviewers

**Always:** Every review pass is one skill applied by a generic agent; no
reviewer `.md` is ever dispatched. Matched project skills are injected as shared
CONTEXT into every pass and never consume a pass slot.

**Why:** A repo with 47 project skills starved every baseline and stack pass out
of the cap when project skills competed for slots. Business rules apply to all
passes anyway — they are context, not a lens.

**Enforced:** `src/dispatch/pass-select.ts`, `src/dispatch/single-session.ts`

**Verified:** `tests/pass-select.test.ts`, `tests/session-context.test.ts`

**Check:** run

### INV-CTX-05 — MCP is denied at the process level

**Always:** MCP is denied at the PROCESS level in both runtimes, not merely at
the tool level, and every runtime must declare its own denial switch. Each
installed-plugin pass records what MCP it observed.

**Why:** Denying the `mcp__*` tools alone still lets every server boot — on
win32 a `cmd.exe` + `conhost` + `npx` + `node` each, every console window
leaking — only to be unreachable. The two runtimes are not symmetric, so the
per-runtime switch is a compile-time requirement: a new runtime must not
silently inherit another's.

**Enforced:** `src/dispatch/runtime.ts` (`MCP_PROCESS_DENIAL`),
`src/dispatch/single-session.ts`

**Verified:** `tests/runtime.test.ts`, `tests/session-context.test.ts`

**Check:** run

### INV-CTX-06 — Companion execution uses materialized review inputs

**Always:** Companion plugins are discovered before dispatch, and only plugins
reported enabled for the selected runtime and current project are eligible. Their
review criteria are copied into the run directory and hash-bound into the
authenticated dispatch plan. Every companion then runs as a generic analysis task over the
same materialized PR context and authoritative project rules as other passes; a
companion command that assumes shell, network, checkout instructions, or direct
PR posting is never invoked inside the confined review session. Copilot review
sessions disable automatic plugin discovery, so unrelated installed plugin
hooks and instructions cannot enter the run.

Companions are OPTIONAL coverage layered on the skill passes, so one that cannot
be materialized is dropped and named as degraded coverage — never fatal, and never
left in the planned roster, because a planned reviewer that is not dispatched reads
as missing output under INV-DEL-01. Eligibility is scoped by pr-review, not assumed
from the runtime: `claude plugin list --json` reports every project-scoped install
on the machine regardless of the invocation directory.

**Why:** A live review loaded an unrelated AVD plugin into every reviewer and
ran 35 `userPromptSubmitted` hooks, each timing out after 45 seconds. The
`code-review` companion simultaneously received only a PR URL even though its
upstream command requires `gh pr view` / `gh pr diff`, while the review runtime
correctly denied shell and posting. Installed plugin state is useful discovery
input; it is not a deterministic execution environment.

**Enforced:** `src/plugins/installed.ts`, `src/plugins/companions.ts`,
`src/commands/review.ts`, `src/dispatch/single-session.ts`,
`src/dispatch/runtime.ts`

**Verified:** `tests/installed-plugins.test.ts`, `tests/session-context.test.ts`,
`tests/loader.test.ts`, `tests/runtime.test.ts`

**Check:** run

---

## TRUST — what the branch under review may not do

### INV-TRUST-01 — Untrusted input is anything the branch under review authored

**Always:** A rule file, `.pr-review.yaml`, or repository MCP configuration
added or modified by the PR — or reached through a directory link the PR added
or changed — cannot instruct that PR's own review. It is dropped from BOTH the
authoritative context and the on-demand index, and named in the summary as
degraded coverage.

**Why:** Otherwise a PR can ship the instructions for its own review. Silent
exclusion would be nearly as bad: the reviewer must know coverage was reduced.

**Enforced:** `src/plugins/trust.ts`, `src/plugins/loader.ts`,
`src/plugins/installed.ts`, `src/config.ts`

**Verified:** `tests/project-rule-trust.test.ts`, `tests/linked-skills.test.ts`,
`tests/zero-passes.test.ts`

**Check:** run

### INV-TRUST-02 — `--force-skill` is the only bypass, and it is CLI-only

**Always:** The only way to inject content past scope and past the trust gate is
`--force-skill`, per run, on the command line. There is deliberately no YAML key
and no environment variable that forces a skill or a skills directory.

**Why:** A committed `.pr-review.yaml` must never be able to pre-authorize
branch-authored content — that would reintroduce INV-TRUST-01 through the front
door. `--skills-dir` and its config equivalents are selected and trust-checked
like repo skill dirs; they are not a bypass.

**Enforced:** `src/config.ts`, `src/plugins/loader.ts`

**Verified:** `tests/config.test.ts`, `tests/linked-skills.test.ts`

**Check:** tests-only

### INV-TRUST-03 — Directory links are followed one hop, and trust is by authorship

**Always:** Directory links (symlinks and NTFS junctions) are followed exactly
ONE hop, in every discovery and configured directory. A link the PR added or
changed is refused BEFORE anything behind it is read. Content whose real path is
outside the checkout is trusted only when the PR did not author the link that
reaches it AND the file is committed and clean in its home git repository. Path
comparisons fold letter case and Unicode on every platform.

**Why:** On Windows `git checkout` of a PR branch writes THROUGH an NTFS
junction into the shared directory, so a planted file would otherwise become a
trusted rule for every sibling repo's review. A win32-only case fold let a PR
committing `.Agents/skills` bypass a macOS reviewer.

**Enforced:** `src/plugins/trust.ts`, `src/plugins/loader.ts`,
`src/util/realpath.ts`, `src/util/git.ts`

**Verified:** `tests/linked-skills.test.ts`, `tests/loader.test.ts`,
`tests/git-provenance.test.ts`

**Check:** tests-only

---

## DEL — delivery accounting

### INV-DEL-01 — A parseable review is not a completed review

**Always:** Every planned pass and every planned companion dispatch delivers
exactly one valid output, or the run exits 2 — even when findings parsed fine.
A missing output, a duplicate output, a missing or invalid `raw-<reviewer>.json`
sidecar, a post that failed or could not be verified, and a failed review
prerequisite are all operational failures. This holds on resumed runs too.

**Why:** Partial delivery rendered as a clean run is the most dangerous output
this tool can produce: it tells the reader the PR was reviewed from every angle
that was planned, when it was not.

**Enforced:** `src/commands/review.ts` (`finalizeReview`,
`resumedCompanionFailures`), `src/dispatch/delivery.ts`

**Verified:** `tests/finalize-failure.test.ts`, `tests/delivery.test.ts`,
`tests/resume.test.ts`

**Check:** run

### INV-DEL-02 — Single Phase-1 dispatch session, Node-owned completion

**Always:** All review passes dispatch in ONE runtime process. Node owns
accounting, bounded selective recovery, aggregation, verifier gating and the
posting gate. The direct verifier and the optional Codex sibling are separate
sessions by design.

**Why:** Runtime exit 0 is never completion. Letting the agent session own
accounting means the thing being audited writes its own audit.

**Enforced:** `src/dispatch/single-session.ts`, `src/dispatch/delivery.ts`

**Verified:** `tests/single-session-retry.test.ts`, `tests/delivery.test.ts`

**Check:** run

### INV-DEL-03 — Partial delivery is never posted

**Always:** When delivery is incomplete, nothing is posted — including Codex
second-opinion findings, which are retained locally instead.

**Why:** Posting the passes that happened to finish gives the PR author a
review that looks whole and is not, with no signal about what is missing.

**Enforced:** `src/commands/review.ts`, `src/dispatch/delivery.ts`

**Verified:** `tests/finalize-failure.test.ts`, `tests/resume.test.ts`

**Check:** run

### INV-DEL-04 — A runtime result can recover only its own missing sidecar

**Always:** On Copilot, a successful task result from the runtime's structured
JSON event stream may materialize an attempt sidecar only when the expected file
is absent, the task maps uniquely to one planned reviewer and attempt, and its
content is an exact valid `Finding[]`. The fallback uses create-only semantics
and then enters the same validation, digest, promotion, recovery, and posting
gates as an agent-written sidecar. It never replaces an existing invalid file,
adopts prose or malformed JSON, guesses between duplicate task identities, or
trusts a nested subagent event as top-level delivery. Runtime argv is validated
before an attempt is reserved, and a crash-surviving sidecar can be promoted
only when a matching non-rejected runtime attempt is authenticated in delivery
state. A failed fallback publication remains a bounded attempt diagnostic; it
does not reject the completed runtime launch, discard another valid sidecar, or
erase captured Auto-route provenance.

**Why:** In a live 18-reviewer run, six tasks successfully returned `[]` but did
not create their required sidecars because they chose PowerShell for the write
and shell was correctly denied. Node then discarded results it had received and
sent seven reviewers into recovery. The runtime already emits a structured,
task-identified result; losing it solely because the model chose the wrong write
tool adds failure without adding authority.

**Enforced:** `src/dispatch/runtime-events.ts`,
`src/dispatch/single-session.ts`, `src/dispatch/delivery.ts`

**Verified:** `tests/runtime-events.test.ts`, `tests/delivery.test.ts`,
`tests/single-session-retry.test.ts`

**Check:** run

---

## OUT — the run's own contract

### INV-OUT-01 — Exit codes mean one thing each

**Always:** `0` = the pipeline completed; without `--fail-on` it says nothing
about the finding count. `1` = a finding at or above the `--fail-on` threshold
survived deduplication, including findings suppressed from publication.
`--fail-on` evaluates all `finalFindings` independently of
`--publish-min-severity`; neither option changes what reviewers analyze.
`2` = an operational failure; `error.txt` names it. A run that reaches finalization always
leaves `error.txt` on exit 2 and clears it on exit 0.

**Why:** CI gates on these. An exit code that sometimes means "no findings" and
sometimes means "no review" cannot gate anything.

**Enforced:** `src/commands/review.ts`, `src/cli.ts`

**Verified:** `tests/exit-code.test.ts`, `tests/finalize-failure.test.ts`,
`tests/zero-passes.test.ts`

**Check:** run

### INV-OUT-02 — Run artifacts are a contract, not debug spill

**Always:** Every run writes the named artifact set under
`~/.pr-review/runs/<id>/`: `pr-review-gather.json`, `stack.json`, `passes.json`,
`companions.json`, `capabilities.json` (plus `capability-<pass>.json` per
installed-plugin pass), one `raw-<reviewer>.json` per pass and companion,
`pr-review-findings.json`, `pr-review-summary.md`, `progress.ndjson`,
`error.txt` on any failure, and `posted.marker` on any publish attempt.
Authenticated mirrors live under `~/.pr-review/control/`. A change that stops
writing one of these is a behaviour change.

After complete delivery, `pr-review-findings.json` retains every deduplicated
finding before any publication attempt, including suppressed findings. Its
`publication` metadata records the canonical threshold and eligible/suppressed
counts. The local summary retains every individual finding body and reports the
same aggregate publication counts, including on dry runs. Resume reconstructs
the retained set from authenticated review inputs and the original gather,
separately from publication progress; promotion is recorded without rewriting
the original plan. Legacy artifacts without publication metadata remain readable.

**Why:** `--resume`, `status`, the operational-failure checks, `verify` and the
eval harness all read them. They are the only record of what a run actually did.

**Enforced:** `src/commands/review.ts`, `src/dispatch/single-session.ts`,
`src/dispatch/delivery.ts`, `src/util/tmp.ts`

**Verified:** `tests/zero-passes.test.ts`, `tests/status.test.ts`,
`tests/delivery.test.ts`

**Check:** run

---

## HYG — repository hygiene

### INV-HYG-01 — Shipped prompt text stays stack-agnostic

**Always:** The prompt text this repository ships — `PASS_RULES`,
`VERIFIER_BRIEF`, the Codex prompt — never names a specific framework, library
or platform. Stack knowledge enters a review only through skills.

**Why:** A framework name in the prompt is review knowledge that cannot be
updated, disabled, or reviewed by anyone but this repo's maintainers. Packs own
the knowledge precisely so it can change without a release.

**Enforced:** `src/dispatch/single-session.ts`, `src/dispatch/codex.ts`

**Verified:** `tests/zero-passes.test.ts`

**Check:** tests-only

### INV-HYG-02 — The bundle is single-file and dependency-free

**Always:** `dist/cli.cjs` is a single-file, zero-dependency bundle. No
`npm install` is needed at the plugin install site, and the committed bundle
matches `src/`.

**Why:** The plugin is installed by copying a directory. A bundle that needs an
install step fails on exactly the machines that cannot run one.

**Enforced:** `scripts/bundle.mjs`

**Verified:** `tests/dogfood.test.ts`

**Check:** tests-only

### INV-HYG-03 — Review quality is guarded by causal eval pairs

**Always:** A production miss becomes an eval fixture as a defective/control
pair — the defective diff under `must_find`, the corrected diff under
`must_not_find` — never as expanded prompt text.

**Why:** A positive-only fixture passes on a fixture so broken that anything
would be flagged. The pair is what proves the finding tracks the defect rather
than the noise.

**Enforced:** `evals/`, `scripts/eval-assertions.mjs`

**Verified:** human judgment during review; `tests/eval-assertions.test.ts`
guards the assertion helpers themselves

**Check:** human
