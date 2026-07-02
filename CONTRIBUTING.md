# Contributing

## Setup

```bash
git clone <repo> && cd pr-review
npm install
npm run build          # tsc + esbuild → dist/cli.cjs
npm run test           # node --test runner
```

Iterative dev: `npm run build:watch` (tsc only; re-run `npm run bundle` for the esbuild output).

The CLI binary is `./bin/pr-review` → `./dist/cli.js`. Run directly during dev:

```bash
node ./dist/cli.js --help
node ./dist/cli.js review <pr-url> --dry-run
```

## Architecture

See [skills/architecture/SKILL.md](skills/architecture/SKILL.md) for the full source map and execution model.

The two-layer pattern: slash command (`commands/pr-review.md`) → Node CLI (`src/`) → single Copilot session dispatching reviewer agents via `task()`.

## Adding a built-in reviewer

Built-in reviewers are `.md` files at `agents/<name>.md`. The loader walks that directory — no registration code.

1. Create `agents/<name>.md` mirroring an existing one (e.g. `security.md`). Required frontmatter: `name`, `description`, `model`.
2. Keep it **stack-agnostic**. Framework-specific content belongs in user plugins/skills.
3. Add the agent name to `BUILTIN_AGENTS` in [src/dispatch/single-session.ts](src/dispatch/single-session.ts).
4. Rebuild: `npm run build`. Verify: `node ./dist/cli.js plugins list`.
5. Update [README.md](README.md) and [skills/reviewers-vs-skills/SKILL.md](skills/reviewers-vs-skills/SKILL.md).

## Authoring a plugin (for distribution)

Most users just drop `.md` files in `.pr-review/skills/`. Only package as a plugin when distributing to other teams.

```
my-shared-pack/
├── plugin.yaml
├── prompts/
│   └── csharp-review.md
└── skills/
    └── dotnet-style.md
```

```yaml
# plugin.yaml
name: csharp-conventions
version: 1.0.0
description: C# coding conventions
applies_to: ["**/*.cs"]
reviewers:
  - id: csharp-review
    prompt: ./prompts/csharp-review.md
    model: claude-opus-4.8
    output_format: json
skills:
  - id: dotnet-style
    path: ./skills/dotnet-style.md
    inject_into: [csharp-review, security]
```

Consume via `--plugin-dir ./my-shared-pack` or in `.pr-review.yaml`.

## Adding a PR provider

1. Create `src/providers/<name>.ts` implementing `PrProvider` from [src/providers/types.ts](src/providers/types.ts).
2. Wire in `src/providers/index.ts` `detectProvider()`.
3. Add auth env var handling.
4. Smoke test against a real PR.

## Testing

```bash
npm run test
```

Tests in `tests/` mirror `src/` structure. Pure-logic tests (parsers, globs, dedupe, diff filter) are unit tests. Provider tests require real auth env vars and a real PR.

## Release

1. Bump version in `package.json` and `plugin.json`.
2. `npm run build && npm run test`.
3. `git tag v0.X.Y && git push --tags`.
4. Users update via `copilot plugin install pr-review@pr-review`.

No npm publish — distribution is via Copilot CLI marketplace only.
