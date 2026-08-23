# Contributing

## Setup

```bash
git clone <repo> && cd pr-review
npm install
npm run build          # tsc + esbuild → dist/cli.cjs
npm run test           # node scripts/test.mjs → node --test over tests/**/*.test.ts
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

Tests in `tests/` mirror `src/` structure (`tests/**/*.test.ts`). Pure-logic tests (parsers, globs, dedupe, diff filter, line-snap, session-context, loader) are unit tests. Provider tests require real auth env vars and a real PR.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs build, tests, and a bundle-freshness check on ubuntu and windows.

## Release

1. `node scripts/release.mjs <patch|minor|major|x.y.z>` — bumps the version in every manifest (`package.json`, `package-lock.json`, `plugin.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`), verifies no stale version string survives, rolls the CHANGELOG, rebuilds the bundle, commits, and tags.
2. `git push --follow-tags`.
3. Users update via `/plugin install pr-review@pr-review` (inside `copilot` or `claude`).

No npm publish — distribution is via the Copilot CLI / Claude Code plugin marketplaces only.
