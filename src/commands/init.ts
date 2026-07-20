import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface InitOptions {
  cwd?: string;
  force?: boolean;
  withConfig?: boolean;
}

interface StackProfile {
  name: string;
  globs: string[];
  marker: string;
}

const STACK_PROFILES: StackProfile[] = [
  { name: 'csharp', marker: '*.csproj', globs: ['**/*.cs', '**/*.csproj'] },
  { name: 'typescript', marker: 'tsconfig.json', globs: ['**/*.ts', '**/*.tsx'] },
  { name: 'javascript', marker: 'package.json', globs: ['**/*.js', '**/*.jsx', '**/*.mjs'] },
  { name: 'python', marker: 'pyproject.toml', globs: ['**/*.py'] },
  { name: 'python-req', marker: 'requirements.txt', globs: ['**/*.py'] },
  { name: 'rust', marker: 'Cargo.toml', globs: ['**/*.rs'] },
  { name: 'go', marker: 'go.mod', globs: ['**/*.go'] },
];

function detectStack(cwd: string): StackProfile | null {
  for (const profile of STACK_PROFILES) {
    const direct = join(cwd, profile.marker);
    try {
      if (statSync(direct).isFile()) return profile;
    } catch {
      // not a direct match
    }
  }
  return null;
}

const STARTER_SKILL_TEMPLATE = (stack: StackProfile | null): string => {
  const globsLine = stack
    ? `applies_to:\n${stack.globs.map((g) => `  - "${g}"`).join('\n')}`
    : `applies_to: []   # leave empty to apply to all files`;
  return `---
description: Team-specific rules for code review. Fill this in with your team's conventions, business rules, and architectural constraints.
${globsLine}
# inject_into: [security, architecture]   # optional — restrict to specific reviewers; omit to reach all
---

# Team Rules

This is a starter template. Replace this content with your team's rules. Examples of what to include:

- **Authorization invariants**: e.g. "All endpoints must call \`IAuthorizationService\` before any DB write."
- **Naming conventions**: e.g. "Repository classes end with \`Repository\`; their methods return \`Task<Result<T>>\`."
- **Forbidden patterns**: e.g. "Direct \`HttpClient\` instantiation is banned; use \`IHttpClientFactory\`."
- **Required test patterns**: e.g. "Every controller action must have at least one integration test."

pr-review injects this file into each reviewer whose name matches \`inject_into\` (all reviewers when omitted), whenever a changed file matches \`applies_to\` (all PRs when empty). Preview exactly which reviewers receive it with:

    pr-review review <pr-url> --context-only
`;
};

const CONFIG_TEMPLATE = `# .pr-review.yaml — per-repo config (committed; shared with the team)
# All keys are optional. Delete what you don't need.

# Default model for reviewers that don't specify their own.
# default_model: claude-opus-4.8

# Extra directories to load skills/reviewers from (beyond the auto-discovered skill dirs).
# extra_skills_dirs:
#   - ./docs/conventions
# extra_reviewers_dirs:
#   - ./docs/code-review

# Single files to include.
# extra_reviewers:
#   - ./SECURITY-CHECKLIST.md
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
  detectedStack: string | null;
}

export function runInit(opts: InitOptions = {}): InitResult {
  const cwd = opts.cwd ?? process.cwd();
  const result: InitResult = {
    createdDirs: [],
    createdFiles: [],
    skippedFiles: [],
    detectedStack: null,
  };

  // Scaffold into a dir the review path actually discovers (.claude/skills is the
  // common one; .copilot/.github/.agents work identically). No .pr-review/skills.
  const skillsDir = join(cwd, '.claude', 'skills');
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
    result.createdDirs.push(skillsDir);
  }

  const stack = detectStack(cwd);
  result.detectedStack = stack?.name ?? null;

  const starterPath = join(skillsDir, 'team-rules.md');
  if (existsSync(starterPath) && !opts.force) {
    result.skippedFiles.push(starterPath);
  } else {
    writeFileSync(starterPath, STARTER_SKILL_TEMPLATE(stack), 'utf8');
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
