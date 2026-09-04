import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface InitOptions {
  cwd?: string;
  force?: boolean;
  withConfig?: boolean;
}

// No stack detection here: the pack system owns stack knowledge at review time
// (Linguist + manifests). A starter template guessing globs from a marker file
// would be exactly the hand-written stack table this tool no longer carries.
const STARTER_SKILL_TEMPLATE = `---
description: Team-specific rules for code review. Fill this in with your team's conventions, business rules, and architectural constraints.
applies_to: []   # e.g. ["**/*.cs"] — leave empty to run on every PR
---

# Team Rules

This is a starter template. Replace this content with your team's rules. Examples of what to include:

- **Authorization invariants**: e.g. "All endpoints must call \`IAuthorizationService\` before any DB write."
- **Naming conventions**: e.g. "Repository classes end with \`Repository\`; their methods return \`Task<Result<T>>\`."
- **Forbidden patterns**: e.g. "Direct \`HttpClient\` instantiation is banned; use \`IHttpClientFactory\`."
- **Required test patterns**: e.g. "Every controller action must have at least one integration test."

Each matching skill runs as its own review pass (\`applies_to\` scopes it to files; empty = every PR). Preview the passes with:

    pr-review review <pr-url> --context-only
`;

const CONFIG_TEMPLATE = `# .pr-review.yaml — per-repo config (committed; shared with the team)
# All keys are optional. Delete what you don't need.

# Default model for review passes.
# default_model: claude-opus-4.8

# External skill packs (git repos) supplying the review passes. REPLACES the
# built-in default list entirely — 'skill_packs: []' disables packs.
# skill_packs:
#   - github/awesome-copilot
#   - OWASP/CheatSheetSeries

# Extra directories to load skills from. Selected like repo skill dirs
# (targeting + relevance apply); files the PR changed are ignored. Nothing in
# yaml forces a skill — that is --force-skill <dir>, per run.
# extra_skills_dirs:
#   - ./docs/conventions

# Single files to include.
# extra_skills:
#   - ./ARCHITECTURE.md

# Language for finding titles/bodies (default: en).
# language: pt-BR

# Precedence: defaults < ~/.pr-review/config.yaml < this file < env vars < CLI flags.
`;

export interface InitResult {
  createdDirs: string[];
  createdFiles: string[];
  skippedFiles: string[];
}

export function runInit(opts: InitOptions = {}): InitResult {
  const cwd = opts.cwd ?? process.cwd();
  const result: InitResult = {
    createdDirs: [],
    createdFiles: [],
    skippedFiles: [],
  };

  // Scaffold into a dir the review path actually discovers (.claude/skills is the
  // common one; .copilot/.github/.agents work identically). No .pr-review/skills.
  const skillsDir = join(cwd, '.claude', 'skills');
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
    result.createdDirs.push(skillsDir);
  }

  const starterPath = join(skillsDir, 'team-rules.md');
  if (existsSync(starterPath) && !opts.force) {
    result.skippedFiles.push(starterPath);
  } else {
    writeFileSync(starterPath, STARTER_SKILL_TEMPLATE, 'utf8');
    result.createdFiles.push(starterPath);
  }

  if (opts.withConfig) {
    const cfgPath = join(cwd, '.pr-review.yaml');
    if (existsSync(cfgPath) && !opts.force) {
      result.skippedFiles.push(cfgPath);
    } else {
      writeFileSync(cfgPath, CONFIG_TEMPLATE, 'utf8');
      result.createdFiles.push(cfgPath);
    }
  }

  return result;
}
