# Contributing

## Setup

```bash
git clone <repo> && cd pr-review
npm install
npm run build          # tsc + esbuild → dist/cli.cjs
npm run test           # node scripts/test.mjs → node --test over tests/**/*.test.ts
npm run test:mod       # claude plugin test mods/live → the live mod's kit tests (needs Claude Code >= 2.1.287)
```

Iterative dev: `npm run build:watch` (tsc only; re-run `npm run bundle` for the esbuild output).

The CLI binary is `./bin/pr-review` → `./dist/cli.js`. Run directly during dev:

```bash
node ./dist/cli.js --help
node ./dist/cli.js review <pr-url> --dry-run
```

## Architecture

See [skills/help/reference/architecture.md](skills/help/reference/architecture.md) for the full source map and execution model.

The two-layer pattern: slash command (`commands/pr-review.md`) → Node CLI (`src/`) → single agent session (Copilot CLI or Claude Code, per `--runtime`) dispatching review passes — one generic agent applying one skill each — via `task()` / `Task()`.

## Adding or curating a skill pack

Review knowledge comes from skill packs — git repos cloned to `~/.pr-review/packs/<name>/`. The defaults live in `DEFAULT_PACKS` in [src/config.ts](src/config.ts); users override them with `skill_packs:` in yaml (replace semantics).

1. Add an entry to `DEFAULT_PACKS`: `name` (pack dir + pass-name prefix), `git` (`owner/repo` or a git URL), `include`/`exclude` globs selecting which files load as skills, `mode` (`auto`, or `index` for packs that only feed the on-demand skills index and never run as a pass), and `baseline` — skill names inside the pack that run as a pass on every PR.
2. Baselines are **pointers, not content**: `pr-review packs sync` pulls the upstream repo, and a renamed upstream file surfaces as a `missingBaseline` warning on review — fix the pointer, never vendor the content.
3. Curate with `exclude` globs (matched against the pack-relative path **and** the normalized skill name) instead of forking upstream — see the `anthropic-cybersecurity` entry for the pattern.
4. Rebuild: `npm run build`. Verify: `node ./dist/cli.js packs sync` then `node ./dist/cli.js packs list`.
5. Update [README.md](README.md) and [skills/help/reference/reviewers-vs-skills.md](skills/help/reference/reviewers-vs-skills.md).

## Authoring a plugin (for distribution)

Most users just drop `.md` files in a standard tool skill dir (`.claude/skills/`, `.copilot/skills/`, `.github/skills/`, `.agents/skills/`). Only package as a plugin when distributing to other teams.

```
my-shared-pack/
├── plugin.yaml
└── skills/
    └── dotnet-style.md
```

```yaml
# plugin.yaml
name: csharp-conventions
version: 1.0.0
description: C# coding conventions
applies_to: ["**/*.cs"]
skills:
  - id: dotnet-style
    path: ./skills/dotnet-style.md
```

Consume via `--plugin-dir ./my-shared-pack` or in `.pr-review.yaml`. Each matched skill runs as its own review pass; standalone reviewers (`reviewers:`) still parse but are never dispatched. Skill frontmatter supports `applies_to` (globs against changed files), `name`, and `tags`; `inject_into` is deprecated — it prints a warning and is ignored. Preview routing with `pr-review review <url> --context-only`.

## Adding a PR provider

1. Create `src/providers/<name>.ts` implementing `PrProvider` from [src/providers/types.ts](src/providers/types.ts).
2. Wire in `src/providers/index.ts` `detectProvider()`.
3. Add auth env var handling.
4. Smoke test against a real PR.

## Testing

```bash
npm run test
```

Tests in `tests/` mirror `src/` structure (`tests/**/*.test.ts`). Every one of them is hermetic — provider tests inject a stub client or `fetch`, and none needs a credential or the network. That is also their limit: nothing in `npm run test` proves a real Azure DevOps or GitLab API call works.

The live mod (`mods/live/`) is tested with the Claude Code mod kit instead: `npm run test:mod` runs `claude plugin test mods/live` (offline, no sign-in) and `npm run validate:mod` prints the module's `hooks:`/`calls:` lines. Keep its tests under `mods/live/tests/` — the kit runs every `*.test.ts` under the mod's folder, and `claude-code/testing` does not load under node:test. `tests/mod-surface.test.ts` pins the module to read-only calls from the node suite, on every platform.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs build, tests, and a bundle-freshness check on ubuntu and windows, and a separate `live-mod` job on ubuntu that installs the pinned Claude Code CLI from npm and runs the mod's validate and kit tests (no node_modules, no credential).

## The demo video

`assets/live-demo.gif` (the README's clip) and `assets/live-demo.mp4` (the full video it links) are cut from ONE recording of a real review by `scripts/demo-video.mjs`, so they can be remade for a new version without an editor:

```bash
node scripts/demo-video.mjs all --work <scratch dir> --pr <pr-url> --checkout <that PR's checkout> --plugin-dir <this checkout> --out assets/live-demo.gif
```

- `record` opens a Windows Terminal window of its own (title `pr-review live demo`), starts Claude Code there with `/pr-review:pr-review <url> --dry-run --no-codex --runtime claude` as the initial prompt, captures that window with ffmpeg (on PATH) and stops once the session's transcript settles on the findings answer after the run's `done` (that moment is where the findings segment starts). Nothing is posted. ffmpeg reads the desktop, not the window, so **leave the machine alone for the ~12 minutes**: every ten seconds `record` checks what is on top of the capture region and warns, and `compose` refuses a covered recording (one take shipped an editor with the author's notes to the QA frames before this check existed).
- what `compose` decides is pure and tested (`recordCues`, `storyboard`, `buildProject` in `tests/demo-video.test.ts`, on the kit fixture): the cues come from the run directory's own clock (`progress.ndjson`, `reviewer-progress.ndjson`, `delivery-state.json`, `dispatch-plan.json`) mapped onto the recording's; from them come four segments of the recording (intro at 1×, the middle squeezed into 20 s, the finish, the findings) and the Recordly project (`demo.recordly`: seven zooms, six captions in English) for the clip those segments make. A caption lives in the recording's own space and zooms with it, so each one is placed inside the view of its zoom.
- `cut` re-times and joins the segments with ffmpeg into `cut.mp4` (~55 s). The project never cuts: Recordly 1.4.0's clips carry no source in-point, so a project cannot jump within its source — and a clip whose time is the timeline keeps every zoom and caption where the storyboard put it.
- `export` runs [Recordly](https://github.com/webadderallorg/Recordly) (installed per user, 1.4.0 at the time) in its own headless smoke-export mode — environment variables, no clicks — launched through PowerShell's `Start-Process` right after a one-shot Node-mode run of the same binary, the only launch shape that started the app from a script on Windows 11 (2026-10-06). `gif` converts the MP4 with ffmpeg under 10 MB (1024 px, 6 fps and 3 fps across the sped-up middle, no dithering — every frame of that middle is a new screenful of text, and that is where the bytes go; then 960 px, then 880 px), and `frames` writes one PNG per cue to look at before committing.
- Both are committed: copy `<work>\live-demo.mp4` to `assets/live-demo.mp4` beside the GIF (GitHub plays an MP4 blob in the browser; ~30 MB, so a remake replaces the file in the same PR rather than iterating on it). A remake for a new version also bumps the version in the README's caption.

### Auditing a run

`pr-review verify [run-id]` (or `--pr <url>`) grades a finished run against every guarantee in [INVARIANTS.md](INVARIANTS.md): one PASS/FAIL/SKIP row per invariant, read-only, exit 2 on any FAIL. If you change posting, gather, stack detection, skill discovery or delivery accounting, run it against a real review before opening the PR.

`tests/invariants-doc.test.ts` keeps `INVARIANTS.md` and the check registry in `src/commands/verify.ts` in lockstep. Adding an invariant means adding both: a documented block and either a check or a `TEST_ONLY` entry naming its guard. IDs are append-only — retire one, never rename or reuse it.

### The acceptance matrix

```bash
npm run acceptance                 # 3 providers x 2 runtimes, real PRs, real posting
npm run acceptance -- --dry-run    # same routing, no posting
```

This is the only thing that exercises Azure DevOps and GitLab for real, and the only thing that runs the Copilot runtime end to end. It needs the fixture estate seeded once — see [evals/acceptance/README.md](evals/acceptance/README.md) — plus `npm run build` and `pr-review packs sync`. Run it before a release; `gh workflow run acceptance.yml` runs the copilot cells in CI.

## Release

1. `node scripts/release.mjs <patch|minor|major|x.y.z>` — bumps the version in every manifest (`package.json`, `package-lock.json`, `plugin.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`), verifies no stale version string survives, rolls the CHANGELOG, rebuilds the bundle, commits, and tags.
2. `git push --follow-tags`.
3. **Create the GitHub Release** — `release.mjs` stops at the tag, and a pushed tag does **not** appear on the `/releases` page. Every version since v0.4.0 has one, named `vX.Y.Z` with the CHANGELOG section as its body:

   ```bash
   # extract this version's CHANGELOG section, then:
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <file> --verify-tag
   ```

   `--verify-tag` makes the command fail rather than invent a tag if step 2 was skipped.
4. Users update via `/plugin install pr-review@pr-review` (inside `copilot` or `claude`).

No npm publish — distribution is via the Copilot CLI / Claude Code plugin marketplaces only.
