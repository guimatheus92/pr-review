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
- Full suite: `npm run test`                                   # scripts/test.mjs → node --test --import tsx tests/*.test.ts
- One file:   `node --test --import tsx tests/<file>.test.ts`

## Tier 3 — runtime
- The surface is the bundled CLI: `node dist/cli.cjs <command>` (rebuild first).
- Side-effect-free smokes: `node dist/cli.cjs cache clear --pr <url>` (proves URL parse end to end), a bad URL with `--detach` (must fail foreground, exit 2, no new dir under ~/.pr-review/runs).
- Real reviews need provider auth (gh/az) — treat as not locally verifiable unless credentials exist.

## Gotchas
- Provider tests are pure-logic; nothing in tests/ hits the network.
- Pre-fix regression worktrees need node_modules — junction the repo's own (`cmd /c mklink /j`), don't npm install.

Last verified: 2026-08-12 against 2ce10b6 (branch feat/robust-pr-urls)
