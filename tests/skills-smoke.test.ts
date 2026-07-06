import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { loadAll } from '../src/plugins/loader.js';
import { prepareSessionContext } from '../src/dispatch/single-session.js';
import type { GatherOutput } from '../src/types.js';

// End-to-end smoke test for the "skills as context" core value: a project-specific
// business rule — deliberately UNRELATED to any stack — authored in .pr-review/skills/
// must be discovered from disk, routed by its frontmatter, and injected verbatim into
// exactly the targeted reviewers' context files. This chains loadAll (discovery) →
// prepareSessionContext (routing/injection), the two halves the other tests cover only
// in isolation. It is fully deterministic: no network, no runtime, no LLM.

// A rule with zero connection to this repo's TypeScript/Node stack — so any injection
// of its text PROVES the skill pipeline is stack-agnostic and content-driven.
const RULE_BODY = `---
name: db-access-layer
description: Mandatory data-access architecture rule for this repo
applies_to:
  - "src/**/*.ts"
inject_into: [architecture, security]
---
# Database access rule (MANDATORY — project-specific)

All database access MUST go through \`AccountRepository\` in \`src/db/accountRepository.ts\`.
No module outside \`src/db/\` may import \`pg\` or call \`pool.query(...)\` directly.
Cite this rule by name (db-access-layer) when you flag a violation.
`;

function fixtureGather(paths: string[]): GatherOutput {
  return {
    pr: { provider: 'github', url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
    metadata: {
      title: 'Test PR',
      description: 'A test PR with enough description.',
      author: 'tester',
      headSha: 'abcdef1234567890',
      baseSha: '1234567890abcdef',
      baseBranch: 'main',
      headBranch: 'feature',
      labels: [],
      linkedItems: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      isDraft: false,
      state: 'open',
    },
    changedFiles: paths.map((p) => ({
      path: p,
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
      patch: '@@ -1,1 +1,2 @@\n context\n+added',
    })),
    fullDiff: '',
    existingComments: [],
    gatheredAt: '2026-01-01T00:00:00Z',
  };
}

test('skills smoke — a stack-agnostic business rule flows disk → discovery → injection into the targeted reviewers only', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-smoke-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-smoke-home-')); // empty → no global skills leak
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-smoke-out-'));
  try {
    const skillsDir = join(cwd, '.pr-review', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'db-access-layer.md'), RULE_BODY);

    // Discovery: autodiscover picks up .pr-review/skills; homeOverride keeps the dev's
    // real ~/.claude/skills out of the test.
    const { config } = loadConfig({ cwd, homeOverride: home });
    const { skills } = loadAll({ cwd, config, skillsOnly: true, home });

    const rule = skills.find((s) => s.name === 'db-access-layer');
    assert.ok(rule, 'the rule must be discovered from .pr-review/skills');
    assert.deepEqual(rule!.injectInto, ['architecture', 'security']);
    assert.deepEqual(rule!.appliesTo, ['src/**/*.ts']);

    // Injection: feed the DISCOVERED skills straight into prepareSessionContext (the
    // real integration — a shape drift between loader and dispatch would break here).
    const ctx = prepareSessionContext({
      prUrl: 'https://github.com/o/r/pull/1',
      gather: fixtureGather(['src/orders/service.ts']), // matches applies_to → all reviewers dispatched
      skills,
      installedCompanions: [],
      skipReviewers: [],
      outDir,
      invokeCompanions: false,
    });

    const bodyOf = (reviewer: string) => {
      const f = join(outDir, `skills-${reviewer}.md`);
      return existsSync(f) ? readFileSync(f, 'utf8') : '';
    };
    const CITE = 'AccountRepository'; // distinctive, stack-agnostic phrase from the rule

    // Reaches exactly the targeted reviewers + the verifier union.
    assert.ok(bodyOf('architecture').includes(CITE), 'inject_into architecture');
    assert.ok(bodyOf('security').includes(CITE), 'inject_into security');
    assert.ok(bodyOf('verifier').includes(CITE), 'verifier gets the union');

    // Never leaks to reviewers outside inject_into.
    assert.ok(!bodyOf('quality').includes(CITE), 'inject_into filter keeps it out of quality');
    assert.ok(!bodyOf('performance').includes(CITE), 'inject_into filter keeps it out of performance');

    // Routing table reflects the same targeting.
    const route = ctx.skillRouting.find((r) => r.skill === 'db-access-layer');
    assert.ok(route, 'routing table lists the rule');
    assert.deepEqual(route!.targets.filter((t) => t !== 'verifier').sort(), ['architecture', 'security']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
