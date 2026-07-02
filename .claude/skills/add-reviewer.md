---
description: How to add a new built-in reviewer agent to pr-review. Use when creating a new review focus area (e.g. accessibility, API design, error handling).
---

# Adding a Built-in Reviewer

## Steps

1. **Create the agent file** at `agents/<name>.md` with frontmatter:
   ```yaml
   ---
   name: <name>
   description: One-line description of what this reviewer checks.
   model: claude-opus-4.8
   ---
   ```
   Body: review instructions only — the JSON output contract lives in the dispatch prompt, so don't duplicate it in the agent file. Mirror an existing agent (e.g. `agents/security.md`).

2. **Register in dispatch** — add `'pr-review:<name>'` to the `BUILTIN_AGENTS` array in `src/dispatch/single-session.ts`.

3. **Build and verify:**
   ```bash
   npm run build
   node ./dist/cli.js plugins list   # should show the new agent
   ```

4. **Update docs** — add a row to the built-in reviewers table in `README.md` and `docs/reviewers-and-skills.md`.

## Rules

- Keep it **stack-agnostic**. No TypeScript, React, .NET, etc. references. Framework-specific review content belongs in user skills/plugins.
- The agent name is the public API — `--skip <name>`, `skip_reviewers: [<name>]`, and skill `inject_into: [<name>]` targeting use it. Don't rename without deprecation. A new reviewer also becomes a valid `inject_into` target, and `prepareSessionContext` will write a `skills-<name>.md` for it.
- The verifier agent is conditional: it's dispatched only when Phase 1 produced at least one CRITICAL/HIGH finding, and it reads `phase1-findings.json` from the run dir. Don't create agents that depend on other agents' output unless they follow the verifier pattern.
- Docs-only PRs are triaged to dispatch only the `quality` reviewer — a new reviewer won't run on them.
