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
- Config-dependent CLI smokes without touching the real `~/.pr-review`: run the bundle with `USERPROFILE=<tmp-home> HOME=<tmp-home>` (Node's `homedir()` follows USERPROFILE on Windows) and a `.pr-review/config.yaml` written under it; `env -u GITHUB_TOKEN -u GH_TOKEN …` makes the auth outcome deterministic. Before/after against the pre-change bundle: `git show origin/main:dist/cli.cjs > <tmp>/cli-main.cjs` — the committed bundle is fresh by CI contract, so no worktree build is needed.

## Docs / README changes
- Anchors: `gh api "repos/guimatheus92/pr-review/readme?ref=<branch>" -H "Accept: application/vnd.github.html" | grep -o 'id="user-content-[^"]*"'` lists the ids GitHub actually generates; diff against `grep -o '](#[^)]*)' README.md`.
- Badges: `curl -s https://img.shields.io/<path> | grep -o '<title>[^<]*</title>'` — the title is the rendered text (`CI: passing`, `release: v0.10.0`).
- Render: Playwright MCP on `https://github.com/<owner>/<repo>/blob/<branch>/README.md` (add `#<anchor>` to land on a section). It blocks `file:` URLs — serve local previews with a one-line node http server. Screenshots may only be written under `<repo>/.playwright-mcp/`; move them to the scratchpad and `rm -rf .playwright-mcp` before committing. GitHub serves a cached blob for a minute after a push — load `blob/<sha>/README.md` to see the new commit.
- Mermaid: GitHub strips HTML entities in labels; write `#lt;`/`#gt;` for angle brackets.

## Gotchas
- Provider tests are pure-logic; nothing in tests/ hits the network.
- Pre-fix regression worktrees need node_modules — junction the repo's own, but use PowerShell `New-Item -ItemType Junction -Path <wt>/node_modules -Target C:/.../pr-review/node_modules` (forward slashes: a backslash before `n` gets expanded into a newline by shell heredocs). `cmd /c mklink /j` from the Bash tool silently no-ops here; the symptom is `ERR_MODULE_NOT_FOUND: @octokit/rest`. Remove with `(Get-Item <wt>/node_modules).Delete()` before `git worktree remove`, or the junction takes the real node_modules with it.
- Tamper checks: edit the worktree copy with a node one-liner that fails when the target string is not unique; keep the replacement on ONE line (`} else if (x) {` → `} if (x) {`) — a replacement carrying a literal backslash-n (or a real newline, which is what a shell-expanded backslash-n becomes) compiles into a syntax error and a whole-file TAP failure that proves nothing.
- Exit codes: pipe the CLI to `head` and you capture `head`'s status, not the CLI's. Run it bare with `>/dev/null 2>&1; echo $?` when the code is the evidence.
- Posting behaviour is best proven with a small `tsx` script driving `runPost` against a stateful fake provider that records writes AND throws — a test that only asserts counts cannot show duplication. Copy it into a base worktree to get the before/after comment counts.

Last verified: 2026-09-04 (feat/review-workflow-diagram, d0d60cb; the final fix commit on PR #22 re-ran build, suite and smokes before push)
