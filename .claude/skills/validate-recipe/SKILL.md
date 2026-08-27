---
name: validate-recipe
description: Verified build/test/run commands for pr-review. Used by /validate; also useful to any agent that needs to build, test, or launch this project.
---

# Validation recipe — pr-review

## Stack
TypeScript CLI (Node >= 20), esbuild single-file bundle at dist/cli.cjs; tests via node:test + tsx.

## Tier 1 — static
- `npm run build`            # tsc typecheck + esbuild bundle; no separate lint script exists

## Tier 2 — tests
- Full suite: `npm run test`                                   # scripts/test.mjs → node --test --import tsx, recursive over tests/**/*.test.ts
- One file:   `node --test --import tsx tests/<file>.test.ts`

## Tier 3 — runtime
- The surface is the bundled CLI: `node dist/cli.cjs <command>` (rebuild first).
- Offline full-pipeline dogfood (no PR, no network beyond packs): `npm run build` then `npm run dogfood -- --base origin/main` — converts the branch diff into a synthetic gather and drives the real bundle with `--from-gather --dry-run`. Add `--context-only` for routing only. Refuses a stale bundle, so build first. URL-based companions are off here by design.
- Side-effect-free smokes: `node dist/cli.cjs cache clear --pr <url>` (proves URL parse end to end), a bad URL with `--detach` (must fail foreground, exit 2, no new dir under ~/.pr-review/runs), `node dist/cli.cjs packs sync` / `packs list` / `doctor` (packs clone + freshness + Linguist cache, no PR needed).
- Offline pass-selection smoke: in a temp repo with `.pr-review.yaml` containing `skill_packs: []`, run `node dist/cli.cjs review <url> --context-only` — must exit 2 (zero passes on a code PR) while still rendering the `## Stack` section.
- Live smokes (gated on credentials — gh/az): `--context-only` against 1 real GitHub PR and 1 real ADO PR — must exit 0, `## Stack` plausible for the diff, `## Passes` non-empty with the expected glob hits.
- Real (dispatching) reviews need provider auth AND a runtime on PATH — treat as not locally verifiable unless both exist.

## Gotchas
- Provider tests are pure-logic; nothing in tests/ hits the network.
- Pre-fix regression worktrees need node_modules — junction the repo's own, but use PowerShell `New-Item -ItemType Junction -Path <wt>
ode_modules -Target C:\...\pr-review
ode_modules`. `cmd /c mklink /j` from the Bash tool silently no-ops here; the symptom is `ERR_MODULE_NOT_FOUND: @octokit/rest`. Remove with `(Get-Item <wt>
ode_modules).Delete()` before `git worktree remove`, or the junction takes the real node_modules with it.
- Exit codes: pipe the CLI to `head` and you capture `head`'s status, not the CLI's. Run it bare with `>/dev/null 2>&1; echo $?` when the code is the evidence.
- Posting behaviour is best proven with a small `tsx` script driving `runPost` against a stateful fake provider that records writes AND throws — a test that only asserts counts cannot show duplication. Copy it into a base worktree to get the before/after comment counts.

Last verified: 2026-08-26 (branch feat/routing-trust-and-delivery)
