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

## One-time setup

Only the account and repo creation is manual. Everything after is one command.

1. **Azure DevOps** — create an organisation at <https://dev.azure.com>.
   The free tier is unchanged (5 Basic users, unlimited private repos), but
   creating a *new* organisation now requires an active Azure subscription;
   within the free tier the cost is still $0. Create a **public** project
   `acceptance` and an empty repo `pr-review-acceptance`.
   PAT (User settings → Personal access tokens) with:
   - **Code** → Read & write
   - **Pull Request Threads** → Read & write

2. **GitLab** — create an account at <https://gitlab.com> and an empty **public**
   project `pr-review-acceptance`.
   PAT (User settings → Access tokens) with scope **`api`** — there is no
   narrower write scope for `POST /merge_requests/:iid/discussions` — and at
   least the **Developer** role on the project.
   Use a *personal* access token: project access tokens require Premium on
   gitlab.com.

3. **GitHub** — create an empty **public** repo `pr-review-acceptance`.
   For CI only, a fine-grained PAT scoped to that repo with **Pull requests:
   read and write** and **Contents: read**.

   Public repos, because the runner clones the fixture with no credential.

4. Put the three clone/web URLs into `matrix.yaml` (replace every `CHANGE-ME`).

5. Seed the estate:

   ```bash
   node scripts/acceptance-seed.mjs          # all three providers
   node scripts/acceptance-seed.mjs --dry-run # build the trees, push nothing
   ```

   It pushes `main`, force-pushes one defect branch per runtime, opens the pull
   requests, and writes their URLs back into `matrix.yaml`. Idempotent — re-run
   it whenever the fixture content changes or a PR gets closed by accident.

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

`matrix.yaml` holds public URLs and nothing else, which is also why the fixture
repositories are public: a private one would need a credentialed clone URL in a
committed file.

In CI: `gh workflow run acceptance.yml`. Secrets live in the `acceptance`
GitHub environment, not in repository secrets, and no `pull_request` trigger
exists — so a fork PR can never reach them.

## Why each fixture file is there

| File | What it proves |
|---|---|
| `.claude/skills/team-rules.md` | `ACC-LOG-002` is a rule id no generic reviewer can invent. A finding containing that string is proof the repo's own skill reached the session as project context — and, because the gate is `cwdIsPrRepo`, proof the cell ran inside the clone. |
| `defects/src/api/users.ts` | SQL built by concatenation **and** a handler with no `audit.log` — one generic defect, one repo-rule defect, in one file. Also the TypeScript language tag. |
| `defects/src/api/users.ts` → `greetHandler` | The control. Correct on both counts; `must_not_find: greetHandler` fails if the reviewer flags it, so a fixture broken enough to flag everything cannot pass. |
| `defects/scripts/report.py` | `shell=True` with interpolated input. Python tag, and a second unmistakable defect so the assertion set is not single-file. |
| `defects/_requirements.txt` | Adds `django` — exercises dependency detection from the **PR's own manifest diff**, a different code path from the checkout scan that yields `express`/`pg`. |
| `defects/db/schema.sql` | SQL language tag with zero defect signal. |
| `defects/docs/notes.md` | Noise, and it must not say so: a fixture that states its own expected outcome is telling the reviewer the answer. |
| `defects/_package-lock.json` | Must be dropped by `applyDiffExclusions`. |
| `acc/wide` (GitLab only) | 101 files, so GitLab reports `changes_count: "100+"` and the truncated-file-list gate actually fires. GitHub needs 3000+ files and Azure DevOps reports no count at all, so the gate is only reachable here. |

## Resetting

Reset runs **before** each cell, never after — an after-reset is exactly the step
a cancelled run skips, which is how a fixture PR stays dirty for the next one.
The runner deletes every non-system comment and then re-reads to prove zero
remain; if any survive it fails the cell **before** the review runs. A leftover
comment would silently drop expected findings through dedupe-against-existing,
and you would spend the afternoon debugging the model instead of the harness.
