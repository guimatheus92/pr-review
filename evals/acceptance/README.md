# Acceptance estate

The acceptance matrix runs `pr-review` against **real pull requests on all three
providers, posting for real**, on both agent runtimes. It is the only thing in
this repository that exercises Azure DevOps and GitLab at all — every provider
test is stubbed — and the only thing that runs the Copilot runtime end to end.

```
                 github        azuredevops     gitlab
  claude         local         local           local
  copilot        local + CI    local + CI      local + CI
```

CI runs only the copilot cells, because there is deliberately no Anthropic
credential in CI. The claude cells are reported as `SKIP` there, never omitted.

## What lives here

| Path | What it is |
|---|---|
| `repo/` | The fixture repo's `main` branch. Manifest filenames carry a leading `_` here and the seeder strips it — under their real names they would be *this* repo's manifests, and every review of pr-review would detect the fixture's stack. |
| `defects/` | Files copied over `main` to make the PR branch. |
| `expected.yaml` | Assertions, shared by all six cells. |
| `matrix.yaml` | Clone URLs and PR URLs. Public identifiers only — never a secret. |

Two trees rather than a `.patch` on purpose: a unified diff needs exact context
lines and hunk counts, and goes stale the moment either side is edited. Two
trees cannot disagree with themselves.

**The PR must never touch `.claude/`.** A rule file the PR itself changed is
untrusted input and gets dropped from the review (INV-TRUST-01) — so a PR that
edited its own skill would silently disarm the strongest assertion in the suite.
That is why `defects/` contains no `.claude/` path.

**The defect files must never describe their own defects.** No comment may say
"planted defect", name the vulnerability, or mention `ACC-LOG-002`. A reviewer
that can read the answer out of the diff satisfies `must_find` without applying
any knowledge at all, and the suite goes green while proving nothing. The
defects are ordinary-looking code; what they are is documented *here* instead.

**The control must be genuinely correct, not merely intended to be.** Three live
cells found three real problems with it, in order: a doc comment reading "greet
a user by name" over a body that greets by email; `q<User>` typing the row of a
query that selects only `email`; and no error handling around the awaited query.
Every one of those was the reviewer being right and the fixture being wrong. So
when a `must_not_find` fires, read the finding before touching the regex — the
assertion catching a real defect in the control is the assertion working.

**But "the reviewer says nothing about this function" is the wrong assertion.**
That was the first shape, and it is unachievable: with 17 reviewers and ~88 raw
findings on a six-file PR, *something* true can be said about any code. Written
that way, the check asserts the reviewer is not thorough — the opposite of the
property worth having. What must hold is narrower: the control is not flagged
**for either planted defect**, which is what keeps `must_find` causal.

**And it is asserted on `file:line`, not on wording.** Four regex shapes were
tried in `expected.yaml` and all four failed on *correct* reviews:

| Shape | Failed on |
|---|---|
| `greetHandler` anywhere | a correct finding about the broken handler that named the good one while contrasting them |
| the same, anchored to the title | `"getUserHandler does not audit-log, but greetHandler does"` |
| title anchor + defect class | the same finding — its title names both |
| names greetHandler but not getUserHandler | SQL-injection findings whose body cited greetHandler as the positive contrast and identified the broken code by snippet, never by name |

Which function a finding *mentions* says nothing about which one it is *about*.
Where it is anchored says exactly that. `controlFalsePositives` in
`scripts/acceptance.mjs` reads `greetHandler`'s line range out of the fixture
source — so editing the fixture cannot silently retarget the check — and fails
the cell on any finding anchored inside that range citing SQLi or the audit
rule. A missing control handler fails too, rather than passing an assertion that
has quietly stopped existing.

## One-time setup

Only the account and repo creation is manual. Everything after is one command.

1. **Azure DevOps** — create an organisation at <https://dev.azure.com>.
   The free tier is unchanged (5 Basic users, unlimited private repos), but
   creating a *new* organisation now requires an active Azure subscription;
   within the free tier the cost is still $0. Create a project `acceptance` and
   an empty repo `pr-review-acceptance`.

   If "Continue" does nothing on the creation form, the answer is almost
   certainly **Switch directory** — the picker has to be on the Entra tenant
   that owns the subscription, and it silently defaults to another one you
   belong to. Owner on the subscription, the spending limit, and the quota id
   are all red herrings here; they were each diagnosed confidently and each was
   wrong. `az account show --query '{sub:id, tenant:tenantId}'` tells you which
   tenant the subscription actually lives in.

   An organisation policy may forbid public projects, in which case make it
   private — the runner clones with a credential, so nothing depends on the
   fixtures being public.
   PAT (User settings → Personal access tokens) with:
   - **Code** → Read & write
   - **Pull Request Threads** → Read & write

2. **GitLab** — create an account at <https://gitlab.com> and an empty
   project `pr-review-acceptance`.
   PAT (User settings → Access tokens) with scope **`api`** — there is no
   narrower write scope for `POST /merge_requests/:iid/discussions` — and at
   least the **Developer** role on the project.
   Use a *personal* access token: project access tokens require Premium on
   gitlab.com.

   If the token form shows no `api` checkbox, you are on the newer **granular**
   PAT screen, which lists resources (Merge requests, Repository, …) instead of
   the classic scopes. Either switch it back to the standard scope list, or
   grant **Merge requests: read+write** plus **Repository: read** — the same
   reach under a different name.

3. **GitHub** — create an empty repo `pr-review-acceptance`.
   A fine-grained PAT scoped to that repo with **Pull requests: read and
   write** and **Contents: read and write** — write, because
   `acceptance-seed.mjs` pushes `main` and the defect branches with this
   token; read-only cannot seed the estate.

   Public or private, either works: the runner clones with a credential
   resolved at run time (see below), so nothing depends on anonymous access.

4. Put the three clone/web URLs into `matrix.yaml` (replace every `CHANGE-ME`).

5. Seed the estate:

   ```bash
   node scripts/acceptance-seed.mjs          # all three providers
   node scripts/acceptance-seed.mjs --dry-run # build the trees, push nothing
   ```

   It pushes `main`, force-pushes one defect branch per runtime, opens the pull
   requests, and writes their URLs back into `matrix.yaml`. Idempotent — re-run
   it whenever the fixture content changes or a PR gets closed by accident.

   **Idempotent means it clones the existing history, never recreates it.** The
   first version ran `git init` and force-pushed a fresh `main`; every open PR
   pointed at commits that no longer had a merge base, so GitHub closed all of
   them the moment it ran a second time. The defect *branches* are force-pushed
   (they are derived content), `main` never is. Anything that rewrites the base
   branch is not a re-seed, it is a new estate — and it takes the pull requests
   with it.

## Running it

```bash
npm run build                      # the matrix drives dist/cli.cjs, not src/
pr-review packs sync               # passes come from packs
npm run acceptance                 # all six cells + the file-list gate
npm run acceptance -- --provider gitlab --runtime copilot
npm run acceptance -- --dry-run    # no posting; the posting rows report SKIP
npm run acceptance -- --reset-only # clean the fixture PRs and stop
```

## Where the credentials live

Three places, in this precedence order:

1. **An environment variable** — `GITHUB_TOKEN`, `AZURE_DEVOPS_PAT`,
   `GITLAB_TOKEN`. Always wins. This is what CI uses: the workflow maps its
   environment secrets onto these names, so CI and a local run take the same
   code path.
2. **`.env` at the repo root** — `cp .env.example .env` and fill it in.
   `KEY=value` per line, `#` for comments.
3. **`~/.pr-review/acceptance.env`** — same format, for anyone who would rather
   keep credentials outside the checkout entirely.
4. **The provider CLIs' own logins** — `gh auth token`,
   `az account get-access-token`, `glab config get token`. An existing login is
   enough and nothing extra is stored.

A credential file inside the repository is the one arrangement where a stray
`git add -A` could publish a token, so three independent things stop it:
`.gitignore` lists `.env`, only `.env.example` is committed and it holds no
values, and the dogfood gate refuses any untracked path matching `^.env`
before it writes an artifact.

The product itself never reads that file — `src/providers/*` read only
`process.env`. The runner loads it and injects the values into the CLI it
spawns, which keeps a test-only convenience out of the shipped tool.

`matrix.yaml` holds plain, credential-free URLs and nothing else. The credential
is added at the moment of use (`credentialedGitUrl`) and the remote is rewritten
back immediately, so it is never written to `.git/config` or to a committed
file — which is why the fixture repositories do not have to be public. That was
a constraint of the first cut, not of the design.

In CI: `gh workflow run acceptance.yml`. Secrets live in the `acceptance`
GitHub environment, not in repository secrets, and no `pull_request` trigger
exists — so a fork PR can never reach them.

## Why each fixture file is there

| File | What it proves |
|---|---|
| `.claude/skills/team-rules.md` | `ACC-LOG-002` is a rule id no generic reviewer can invent. A finding containing that string is proof the repo's own skill reached the session as project context — and, because the gate is `cwdIsPrRepo`, proof the cell ran inside the clone. |
| `defects/src/api/users.ts` | SQL built by concatenation **and** a handler with no `audit.log` — one generic defect, one repo-rule defect, in one file. Also the TypeScript language tag. |
| `defects/src/api/users.ts` → `greetHandler` | The control. Parameterised **and** audited, so `must_not_find` fails if either planted defect is reported against it — which is what makes `must_find` causal instead of vacuous. Scoped to those two classes on purpose: see below. |
| `defects/scripts/report.py` | `shell=True` with interpolated input. Python tag, and a second unmistakable defect so the assertion set is not single-file. |
| `defects/_requirements.txt` | Adds `django` — exercises dependency detection from the **PR's own manifest diff**, a different code path from the checkout scan that yields `express`/`pg`. |
| `defects/db/schema.sql` | SQL language tag with zero defect signal. |
| `defects/docs/notes.md` | Noise, and it must not say so: a fixture that states its own expected outcome is telling the reviewer the answer. |
| `defects/_package-lock.json` | Must be dropped by `applyDiffExclusions`. |
| `acc/wide` (GitLab only) | 101 files — one past GitLab's 100-per-page `/diffs` cap, so a complete list proves the provider **paginates to completion**. That is the bug class that had Azure DevOps reviewing every >100-file PR on its first 100 (`$top` default) from 0.6 through 0.10. Cheapest to reach on GitLab: GitHub's list stops at 3000 and Azure DevOps reports no count at all. |

## What the live matrix cannot prove

**The file-list refusal path.** INV-FETCH-01 says an incomplete list is unknown
rather than empty, and the run refuses when it cannot complete one. Refusing is
only *correct* when the list really is short, and no live provider will produce
that on demand: GitLab's `changes_count` was measured exact at 1200 files on
this estate ("1200", never "1200+"), so the truncation flag it keys on never
trips. The `filelist` cell therefore proves the half that is reachable — that a
101-file MR paginates to a complete list, from inside the checkout *and* from an
unrelated directory, both agreeing with the provider's own count — and leaves
the refusal to `tests/gather.test.ts`, which can stub a short list against a
high count.

The first version of that cell asserted the opposite: it demanded a refusal from
an unrelated directory, on a list that was complete and therefore safe to use.
It failed against correct behaviour, which is the only reason the wrong premise
("GitLab reports `100+` above 100 files") was ever measured. `gitlabChangesCount`
now fails the cell if GitLab starts truncating, because that would make the
refusal path live and this cell's ceiling obsolete.

## BLOCKED is not FAIL

A cell that could not run reports `🚧 blocked` and is counted apart from the
passes — never folded into them, never rendered as a failure.

Two checks, because the account can refuse in two different ways.

**Before the cell**, `runtimeBlockedReason` reads
`quota_snapshots.premium_interactions`. With zero remaining, the CLI refuses
every capable model, `--model auto` resolves to a small non-premium one, and
that model declares `DONE` two dispatches into a nine-pass orchestration.
`INV-DEL-01` then correctly refuses to post a partial review, and the cell
fails — on a product that behaved exactly as specified.

**After a failed review**, `runtimeRefusedToWork` reads the run's own
`orchestrator-failure.log` / `error.txt` for the vendor's refusal wording. A
rate limit ("You've hit your rate limit… reset in 5 hours") is not a counter
anything can query in advance; it is a 429 on the next request, and the session
exits in seconds with every pass unfulfilled. The pattern is deliberately
narrow and matched both ways in review: a genuine pipeline failure that merely
mentions a limit, or says something else "is not available", must stay a FAIL —
a blocked classification that swallows a real defect is worse than the FAIL it
replaces.

That distinction is the whole point. Reported as FAIL it reads as a pr-review
bug, and someone spends a day looking for it; it was reported that way once, in
those words, and the actual cause was a quota counter. The probe is a courtesy —
if it cannot answer (no `gh`, no network) the cell runs and the real assertions
speak. `--runtime claude` is never blocked by it.

BLOCKED is not FAIL, and it is also not fine: if **every** cell was blocked the
runner exits 1, because zero cells run is zero cells proven whatever the reason,
and exiting 0 there would put a green check mark on a matrix that never
executed. This matters most in CI, which today runs only the copilot cells.

## Resetting

Reset runs **before** each cell, never after — an after-reset is exactly the step
a cancelled run skips, which is how a fixture PR stays dirty for the next one.
The runner deletes every non-system comment and then re-reads to prove zero
remain; if any survive it fails the cell **before** the review runs. A leftover
comment would silently drop expected findings through dedupe-against-existing,
and you would spend the afternoon debugging the model instead of the harness.
