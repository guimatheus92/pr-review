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
- **Full pipeline with no LLM — a stub runtime.** `--copilot <path>` overrides the binary *and* pins the copilot runtime, so a stub does the whole real run: `node dist/cli.cjs review <url> --from-gather <gather.json> --dry-run --no-codex --no-companions --copilot <stub.cmd>`. On win32 the stub is a `.cmd` doing `node "%~dp0stub.mjs" %*`; the stub reads `--add-dir` from argv to find the run dir, parses `dispatch-plan.json`, and writes `attempt-<n>.json` under each `reviewer.attemptsDir` (plus `reviewer.capabilityPath` for installed-plugin passes). Batches arrive as separate invocations — count them in a file under the run dir, since the CLI numbers attempts itself. Withhold one reviewer's attempt file to force the automatic-recovery batch. The child's stderr is captured, not passed through, so assert on run artifacts rather than on the stub's own output. This is the only way to exercise dispatch, recovery and the audit paths offline; pair it with `git show origin/main:dist/cli.cjs > <tmp>/cli-main.cjs` for a same-scenario before/after.
- Side-effect-free smokes: `node dist/cli.cjs cache clear --pr <url>` (proves URL parse end to end), a bad URL with `--detach` (must fail foreground, exit 2, no new dir under ~/.pr-review/runs), `node dist/cli.cjs packs sync` / `packs list` / `doctor` (packs clone + freshness + Linguist cache, no PR needed).
- Offline pass-selection smoke: in a temp repo with `.pr-review.yaml` containing `skill_packs: []`, run `node dist/cli.cjs review <url> --context-only` — must exit 2 (zero passes on a code PR) while still rendering the `## Stack` section.
- Live smokes (gated on credentials — gh/az): `--context-only` against 1 real GitHub PR and 1 real ADO PR — must exit 0, `## Stack` plausible for the diff, `## Passes` non-empty with the expected glob hits.
- File-list completeness smoke (gh only, read-only, ~30 API calls): from a directory that is NOT a checkout, `node dist/cli.cjs gather https://github.com/OpenAPITools/openapi-generator/pull/24767 --no-cache` must exit 1 with `github listed 3000 of 9782 changed files — file list truncated … run git fetch origin master refs/pull/24767/head there and retry` and leave nothing under `~/.pr-review/cache/github/OpenAPITools__openapi-generator/`.
- Completion-path live proof (not run here — needs a clone of a >3000-file PR): clone `OpenAPITools/openapi-generator`, `git fetch origin master refs/pull/24767/head`, then the same `gather` command from the clone — PASS when stderr says `completed 6782 file(s) from git at <root>` and the JSON holds 9782 entries. Until someone runs it, the completion path's live evidence is the temp-git-repo tests in `tests/gather-cache.test.ts`.
- Cache-marker smoke: after a cached gather of a real PR, delete `changedFilesComplete` from the entry under `~/.pr-review/cache/<provider>/<scope>/<n>/`, run `gather <url>` again — stderr must say `cache entry predates the file-list completeness check — refetching`, the entry is rewritten with the marker, and a third run is a `cache hit`.
- `pr-review-gather.json` after a GitHub gather **with `--no-cache`**: `metadata.changedFileCount` equals `changedFiles.length`, `changedFilesComplete` is `true`, and there is no `fullDiff` key (retired in #26). Only on a fresh gather — a cache hit returns the stored payload verbatim, so an entry written by <= 0.11 still yields a `fullDiff`, which is expected and harmless.
- Real (dispatching) reviews need provider auth AND a runtime on PATH — treat as not locally verifiable unless both exist. Run them from a COPY of the bundle (`cp dist/cli.cjs $TEMP/cli-x.cjs`) so a later rebuild cannot abort the run.
- Config-dependent CLI smokes without touching the real `~/.pr-review`: run the bundle with `USERPROFILE=<tmp-home> HOME=<tmp-home>` (Node's `homedir()` follows USERPROFILE on Windows) and a `.pr-review/config.yaml` written under it; `env -u GITHUB_TOKEN -u GH_TOKEN …` makes the auth outcome deterministic. Before/after against the pre-change bundle: `git show origin/main:dist/cli.cjs > <tmp>/cli-main.cjs` — the committed bundle is fresh by CI contract, so no worktree build is needed.

## Docs / README changes
- Anchors: `gh api "repos/guimatheus92/pr-review/readme?ref=<branch>" -H "Accept: application/vnd.github.html" | grep -o 'id="user-content-[^"]*"'` lists the ids GitHub actually generates; diff against `grep -o '](#[^)]*)' README.md`.
- Badges: `curl -s https://img.shields.io/<path> | grep -o '<title>[^<]*</title>'` — the title is the rendered text (`CI: passing`, `release: v0.10.0`).
- Render: Playwright MCP on `https://github.com/<owner>/<repo>/blob/<branch>/README.md` (add `#<anchor>` to land on a section). It blocks `file:` URLs — serve local previews with a one-line node http server. Screenshots may only be written under `<repo>/.playwright-mcp/`; move them to the scratchpad and `rm -rf .playwright-mcp` before committing. GitHub serves a cached blob for a minute after a push — load `blob/<sha>/README.md` to see the new commit.
- Mermaid: GitHub strips HTML entities in labels; write `#lt;`/`#gt;` for angle brackets.

## Gotchas
- Never rebuild `dist/cli.cjs` while a detached review is in flight: the CLI hashes its own bundle into the authenticated run state and aborts finalization with `CLI artifact changed` (exit 21) — the reviewers' work is written but never accepted. Build first, then launch; or launch from a copy of the bundle.
- `tsconfig.json` excludes `tests/`, so `npm run build` typechecks `src/` ONLY and the suite runs under tsx (types stripped, never checked). Removing a method from an interface therefore flags nothing test-side: stale stub properties compile forever, and a claim like "nothing writes this field any more" has no compiler proof. Back that kind of change with a runtime assertion plus a tamper check, not with a green build (#26).
- Provider tests are pure-logic; nothing in tests/ hits the network. The git-completion tests in `tests/gather-cache.test.ts` create real temp git repos (need `git` on PATH, ~0.5 s each).
- Pre-fix regression worktrees need node_modules — junction the repo's own, but use PowerShell `New-Item -ItemType Junction -Path <wt>/node_modules -Target C:/.../pr-review/node_modules` (forward slashes: a backslash before `n` gets expanded into a newline by shell heredocs). `cmd /c mklink /j` from the Bash tool silently no-ops here; the symptom is `ERR_MODULE_NOT_FOUND: @octokit/rest`. Remove with `(Get-Item <wt>/node_modules).Delete()` before `git worktree remove`, or the junction takes the real node_modules with it.
- Tamper checks: edit the worktree copy with a node one-liner that fails when the target string is not unique; keep the replacement on ONE line (`} else if (x) {` → `} if (x) {`) — a replacement carrying a literal backslash-n (or a real newline, which is what a shell-expanded backslash-n becomes) compiles into a syntax error and a whole-file TAP failure that proves nothing.
- Claude Code's Bash tool on this Windows host (Git Bash + the RTK command hook): heredocs are not literal even with a quoted delimiter — a doubled backslash collapses to one (a `\\d` regex written through a JS string arrives as `d`), and a body containing shell-looking `git …` lines can be rewritten by the command hook and break the quoting. Write test/source blocks that contain either with the Write tool to the scratchpad, then `cat >>` them from Bash; build unavoidable backslashes with `String.fromCharCode(92)`.
- Exit codes: pipe the CLI to `head` and you capture `head`'s status, not the CLI's. Run it bare with `>/dev/null 2>&1; echo $?` when the code is the evidence.
- Posting behaviour is best proven with a small `tsx` script driving `runPost` against a stateful fake provider that records writes AND throws — a test that only asserts counts cannot show duplication. Copy it into a base worktree to get the before/after comment counts.

Last verified: 2026-09-05 (branch feat/validate-capability-evidence)
