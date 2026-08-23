import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PASSES, prepareSessionContext } from '../src/dispatch/single-session.js';
import type { IndexEntry, ReviewPass } from '../src/dispatch/pass-select.js';
import type { GatherOutput } from '../src/types.js';

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

function pass(name: string, over: Partial<ReviewPass> = {}): ReviewPass {
  return {
    name,
    source: `/packs/${name}.md`,
    body: `BODY_OF_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
    description: `about ${name}`,
    matchedBy: 'baseline',
    matchedOn: [],
    ...over,
  };
}

function baseOpts(outDir: string, paths: string[], passes: ReviewPass[], indexEntries: IndexEntry[] = []) {
  return {
    prUrl: 'https://github.com/o/r/pull/1',
    gather: fixtureGather(paths),
    passes,
    indexEntries,
    stackTags: ['typescript'],
    installedCompanions: [],
    skipReviewers: [],
    outDir,
    invokeCompanions: false,
  };
}

test('passes — one pass-*.md per pass (rules + ONE body), union has all, prompt records pass names', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const passes = [
      pass('awesome-copilot/go', { matchedBy: 'glob', matchedOn: ['**/*.go'] }),
      pass('owasp/error-handling'),
    ];
    const ctx = prepareSessionContext(baseOpts(outDir, ['src/main.go'], passes));

    const goFile = join(outDir, 'pass-awesome-copilot_go.md');
    assert.ok(existsSync(goFile), 'pass file exists with sanitized name');
    const goBody = readFileSync(goFile, 'utf8');
    assert.ok(goBody.includes('# Review pass: awesome-copilot/go'));
    assert.ok(goBody.includes('Severity scale'), 'pipeline rules present');
    assert.ok(goBody.includes('BODY_OF_awesome_copilot_go'));
    assert.ok(!goBody.includes('BODY_OF_owasp_error_handling'), 'exactly one skill per pass file');

    const union = readFileSync(ctx.skillsFiles['all']!, 'utf8');
    assert.ok(union.includes('BODY_OF_awesome_copilot_go') && union.includes('BODY_OF_owasp_error_handling'));

    assert.ok(ctx.orchestratorPrompt.includes('record as reviewer name `awesome-copilot/go`'));
    assert.ok(ctx.orchestratorPrompt.includes('record as reviewer name `owasp/error-handling`'));
    assert.ok(ctx.orchestratorPrompt.includes('phase1-findings.json'));
    assert.ok(ctx.orchestratorPrompt.includes('CRITICAL or HIGH'), 'verifier dispatch is conditional');

    const contextBody = readFileSync(ctx.contextPath, 'utf8');
    assert.ok(!contextBody.includes('BODY_OF_'), 'skill bodies never live in the shared context file');
    assert.ok(contextBody.includes('UNTRUSTED-COMMENTS'), 'existing comments are fenced');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// Field incident (Preco-Pratico/PrecoPratico-Backend#586): the official
// `code-review` companion's slash command allows `gh pr comment` and its own
// instructions post a top-level "### Code review / No issues found" verdict —
// so the dispatched subagent posted it, bypassing the CLI's inline-only,
// deduped, idempotent posting. Every dispatch line (passes, companion agents,
// companion slash commands, verifier, and the orchestrator itself) must carry
// the no-posting directive. This test is the tripwire: if a new dispatch path
// forgets the directive, it fails.
test('no-posting directive — reaches the orchestrator and EVERY dispatch line, exact count', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const passes = [pass('p/one'), pass('p/two')];
    const ctx = prepareSessionContext({
      ...baseOpts(outDir, ['src/app.ts'], passes),
      invokeCompanions: true,
      installedCompanions: ['pr-review-toolkit', 'code-review'],
    });
    const prompt = ctx.orchestratorPrompt;
    const directive = 'do NOT post, comment, review, approve, or write ANYTHING to the pull request';
    const dispatchLines = prompt.split('\n').filter((l) => /^- .*(task|Task)\(/.test(l));
    // 2 passes + 6 companion agents + 1 companion slash + 1 verifier — a lost line is a failure too.
    assert.equal(dispatchLines.length, 10, `expected exactly 10 dispatch lines, got ${dispatchLines.length}`);
    // Every task-call in the prompt must BE one of those bullet lines — a dispatch
    // added as prose or a multi-line prompt would escape the per-line assertions.
    const totalCalls = (prompt.match(/task\(agent_type=|Task\(subagent_type=/g) ?? []).length;
    assert.equal(totalCalls, dispatchLines.length, 'a task call exists outside the audited dispatch bullets');
    for (const line of dispatchLines) {
      assert.ok(line.includes(directive), `dispatch line missing the no-posting directive: ${line.slice(0, 120)}…`);
    }
    const slashLine = dispatchLines.find((l) => l.includes('/code-review:code-review'));
    assert.ok(slashLine, 'code-review companion slash line present');
    assert.ok(slashLine.includes('analysis-only'), 'slash companions run analysis-only');
    assert.ok(slashLine.includes('SKIP that step'), 'posting steps in the command are explicitly skipped');
    assert.ok(prompt.includes(`${directive}`) && prompt.includes('This binds you AND every subagent'), 'orchestrator-level rule present');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('triage — docs-only PR dispatches only file-scoped (glob/forced) passes, never baseline', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const passes = [
      pass('p/markdown', { matchedBy: 'glob', matchedOn: ['**/*.md'] }),
      pass('p/tagged', { matchedBy: 'tag', matchedOn: ['typescript'] }),
      pass('p/generic', { matchedBy: 'baseline' }),
      pass('repo/forced-one', { matchedBy: 'forced' }),
    ];
    const ctx = prepareSessionContext(baseOpts(outDir, ['README.md', 'docs/guide.md'], passes));
    assert.deepEqual(ctx.passes.map((p) => p.name), ['p/markdown', 'repo/forced-one']);
    assert.deepEqual(ctx.triageSkipped, ['p/tagged', 'p/generic']);
    assert.ok(!ctx.orchestratorPrompt.includes('record as reviewer name `p/generic`'));
    assert.ok(ctx.orchestratorPrompt.includes('only touches documentation files'));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('triage — mixed PR dispatches everything', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const passes = [pass('p/generic'), pass('p/tagged', { matchedBy: 'tag' })];
    const ctx = prepareSessionContext(baseOpts(outDir, ['README.md', 'src/app.ts'], passes));
    assert.equal(ctx.triageSkipped.length, 0);
    assert.equal(ctx.passes.length, 2);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('triage — docs-only PR with no file-scoped pass yields zero passes (review layer decides the exit)', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const ctx = prepareSessionContext(baseOpts(outDir, ['README.md'], [pass('p/generic')]));
    assert.equal(ctx.passes.length, 0);
    assert.deepEqual(ctx.triageSkipped, ['p/generic']);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('pass body cap — oversized skill is truncated with a marker', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const ctx = prepareSessionContext(
      baseOpts(outDir, ['src/app.ts'], [pass('p/huge', { body: 'x'.repeat(60_000) })]),
    );
    const file = readFileSync(ctx.skillsFiles['p/huge']!, 'utf8');
    assert.ok(file.includes('[truncated: skill body exceeded 48000 bytes]'));
    assert.ok(file.length < 60_000);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('language directive lands in the context file when not en', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const ctx = prepareSessionContext({ ...baseOpts(outDir, ['src/app.ts'], [pass('p/one')]), language: 'pt-BR' });
    const body = readFileSync(ctx.contextPath, 'utf8');
    assert.ok(body.includes('pt-BR'));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('runtime — claude uses Task(subagent_type="general-purpose"), copilot task(agent_type=...); no registered agents', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const passes = [pass('p/one')];
    const claude = prepareSessionContext({ ...baseOpts(outDir, ['src/app.ts'], passes), runtime: 'claude' as const });
    assert.ok(claude.orchestratorPrompt.includes('Task(subagent_type="general-purpose"'));
    assert.ok(claude.orchestratorPrompt.includes('Use the `Task` tool'));
    assert.ok(!claude.orchestratorPrompt.includes('pr-review:'), 'no registered reviewer agents remain');
    const copilot = prepareSessionContext({ ...baseOpts(outDir, ['src/app.ts'], passes), runtime: 'copilot' as const });
    assert.ok(copilot.orchestratorPrompt.includes('task(agent_type="general-purpose"'));
    assert.ok(!copilot.orchestratorPrompt.includes('subagent_type'));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('codex + companions — both read the union file skills-all.md', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const passes = [pass('p/one'), pass('p/two')];
    const ctx = prepareSessionContext({
      ...baseOpts(outDir, ['src/app.ts'], passes),
      includeCodex: true,
      invokeCompanions: true,
      installedCompanions: ['pr-review-toolkit'],
    });
    assert.ok(ctx.skillsFiles['all']!.endsWith('skills-all.md'));
    const union = readFileSync(ctx.skillsFiles['all']!, 'utf8');
    assert.ok(union.includes('BODY_OF_p_one') && union.includes('BODY_OF_p_two'));
    const companionLine = ctx.orchestratorPrompt
      .split('\n')
      .find((l) => l.includes('pr-review-toolkit:code-reviewer'));
    assert.ok(companionLine, 'companion agents dispatched');
    assert.ok(companionLine.includes('skills-all.md'), 'companions read the union');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('verifier — pipeline step: verifier.md written, generic-agent line in a conditional phase; --skip verifier removes both', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const ctx = prepareSessionContext(baseOpts(outDir, ['src/app.ts'], [pass('p/one')]));
    assert.ok(ctx.verifierPath && existsSync(ctx.verifierPath));
    assert.ok(readFileSync(ctx.verifierPath!, 'utf8').includes('Cross-cutting issues'));
    assert.ok(ctx.orchestratorPrompt.includes('verifier.md'));
    assert.ok(ctx.orchestratorPrompt.includes('record as reviewer name `verifier`'));

    const outDir2 = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
    try {
      const skipped = prepareSessionContext({
        ...baseOpts(outDir2, ['src/app.ts'], [pass('p/one')]),
        skipReviewers: ['verifier'],
      });
      assert.equal(skipped.verifierPath, undefined);
      assert.ok(!skipped.orchestratorPrompt.includes('record as reviewer name `verifier`'));
    } finally {
      rmSync(outDir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('--skip — full pack/skill name and bare suffix both remove the pass; routing says skipped', () => {
  for (const skipAs of ['awesome-copilot/go', 'go']) {
    const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
    try {
      const passes = [pass('awesome-copilot/go', { matchedBy: 'glob' }), pass('p/other')];
      const ctx = prepareSessionContext({ ...baseOpts(outDir, ['src/app.ts'], passes), skipReviewers: [skipAs] });
      assert.deepEqual(ctx.passes.map((p) => p.name), ['p/other'], `--skip ${skipAs}`);
      assert.equal(ctx.routing.find((r) => r.name === 'awesome-copilot/go')?.matchedBy, 'skipped');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
});

test('cap — more passes than MAX_PASSES: overflow goes to the index file and routes as index', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const passes = Array.from({ length: MAX_PASSES + 2 }, (_, i) => pass(`p/pass-${String(i).padStart(2, '0')}`));
    const ctx = prepareSessionContext(baseOpts(outDir, ['src/app.ts'], passes));
    assert.equal(ctx.passes.length, MAX_PASSES);
    const overflowNames = [`p/pass-${MAX_PASSES}`, `p/pass-${MAX_PASSES + 1}`];
    const index = readFileSync(join(outDir, 'skills-index.md'), 'utf8');
    for (const n of overflowNames) {
      assert.ok(index.includes(`**${n}**`), `${n} listed in the index`);
      assert.equal(ctx.routing.find((r) => r.name === n)?.matchedBy, 'index');
      assert.ok(!existsSync(join(outDir, `pass-${n.replace('/', '_')}.md`)), `${n} has no pass file`);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('stack + index — pr-context carries ## Stack and points at skills-index.md; both absent when empty', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const indexEntries: IndexEntry[] = [
      { name: 'anthropic-cybersecurity/detecting-x', description: 'detects x', source: '/packs/a/x.md', tags: ['x'] },
    ];
    const ctx = prepareSessionContext({
      ...baseOpts(outDir, ['src/app.ts'], [pass('p/one')], indexEntries),
      stackTags: ['typescript', 'react'],
    });
    const contextBody = readFileSync(ctx.contextPath, 'utf8');
    assert.ok(contextBody.includes('## Stack'));
    assert.ok(contextBody.includes('typescript, react'));
    assert.ok(contextBody.includes('## More skills (on-demand)'));
    assert.ok(contextBody.includes('skills-index.md'));
    const index = readFileSync(join(outDir, 'skills-index.md'), 'utf8');
    assert.ok(index.includes('**anthropic-cybersecurity/detecting-x** — detects x'));
    // Index bodies never leak into pass files.
    for (const f of readdirSync(outDir).filter((n) => n.startsWith('pass-'))) {
      assert.ok(!readFileSync(join(outDir, f), 'utf8').includes('detecting-x'));
    }

    const outDir2 = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
    try {
      const empty = prepareSessionContext({ ...baseOpts(outDir2, ['src/app.ts'], [pass('p/one')]), stackTags: [] });
      const body2 = readFileSync(empty.contextPath, 'utf8');
      assert.ok(body2.includes('(none detected)'));
      assert.ok(!body2.includes('## More skills'));
      assert.ok(!existsSync(join(outDir2, 'skills-index.md')));
    } finally {
      rmSync(outDir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('passes.json — persisted at dispatch time, equal to ctx.routing (for --resume)', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const indexEntries: IndexEntry[] = [{ name: 'p/indexed', description: '', source: '/x.md', tags: [] }];
    const ctx = prepareSessionContext(baseOpts(outDir, ['src/app.ts'], [pass('p/one', { matchedBy: 'glob' })], indexEntries));
    const persisted = JSON.parse(readFileSync(join(outDir, 'passes.json'), 'utf8'));
    assert.deepEqual(persisted, ctx.routing);
    assert.deepEqual(
      ctx.routing.map((r) => `${r.name}:${r.matchedBy}`),
      ['p/one:glob', 'p/indexed:index'],
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
