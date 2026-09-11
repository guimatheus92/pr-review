import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TOTAL_PASSES, prepareSessionContext } from '../src/dispatch/single-session.js';
import { readDispatchPlan, validateDispatchArtifacts } from '../src/dispatch/delivery.js';
import { selectPasses, type IndexEntry, type ReviewPass } from '../src/dispatch/pass-select.js';
import type { CompanionPluginSource } from '../src/plugins/companions.js';
import { materializeCompanionBriefs } from '../src/plugins/companions.js';
import type { GatherOutput, SkillDefinition } from '../src/types.js';

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

const TOOLKIT_AGENTS = [
  'code-reviewer',
  'code-simplifier',
  'comment-analyzer',
  'pr-test-analyzer',
  'silent-failure-hunter',
  'type-design-analyzer',
];

function seedCompanionSources(): { sources: CompanionPluginSource[]; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-companion-sources-'));
  const toolkit = join(root, 'pr-review-toolkit');
  const codeReview = join(root, 'code-review');
  for (const agent of TOOLKIT_AGENTS) {
    const path = join(toolkit, 'agents', `${agent}.md`);
    mkdirSync(join(toolkit, 'agents'), { recursive: true });
    writeFileSync(
      path,
      `---\nname: ${agent}\nmodel: opus\ntools: Bash,Read,Write\n---\n# ${agent}\n${agent === 'code-reviewer' ? 'By default, review unstaged changes from `git diff`. The user may specify different files or scope to review.\n' : ''}COMPANION_CRITERIA_${agent}\n`,
      'utf8',
    );
  }
  mkdirSync(join(toolkit, '.claude-plugin'), { recursive: true });
  writeFileSync(join(toolkit, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pr-review-toolkit', version: '1.0.0' }));

  mkdirSync(join(codeReview, 'commands'), { recursive: true });
  mkdirSync(join(codeReview, '.claude-plugin'), { recursive: true });
  writeFileSync(join(codeReview, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'code-review', version: '1.0.0' }));
  writeFileSync(
    join(codeReview, 'commands', 'code-review.md'),
    [
      '---',
      'allowed-tools: Bash(gh pr view:*), Bash(gh pr comment:*)',
      'model: opus',
      '---',
      'Provide a code review for the given pull request.',
      '1. Run `gh pr view` and `gh pr diff`.',
      '**CRITICAL: We only want HIGH SIGNAL issues.**',
      '- The code will fail to compile or parse.',
      '- The code will definitely produce wrong results.',
      'Do NOT flag:',
      '- Code style or quality concerns.',
      '5. For each issue found, launch validation agents.',
      'Use this list when evaluating issues in Steps 4 and 5 (these are false positives, do NOT flag):',
      '- Pre-existing issues',
      '- Pedantic nitpicks',
      'Notes:',
      '- Use gh CLI to interact with GitHub.',
      '9. Post inline comments using mcp__github_inline_comment__create_inline_comment.',
    ].join('\n'),
    'utf8',
  );
  return {
    sources: [
      { id: 'pr-review-toolkit', roots: [toolkit] },
      { id: 'code-review', roots: [codeReview] },
    ],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
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

    const goFile = ctx.skillsFiles['awesome-copilot/go']!;
    assert.ok(existsSync(goFile), 'pass file exists with sanitized name');
    const goBody = readFileSync(goFile, 'utf8');
    assert.ok(goBody.includes('# Review pass: awesome-copilot/go'));
    assert.ok(goBody.includes('Severity scale'), 'pipeline rules present');
    assert.ok(goBody.includes('provenance only; sibling files are not materialized'));
    assert.ok(goBody.includes('BODY_OF_awesome_copilot_go'));
    assert.ok(!goBody.includes('BODY_OF_owasp_error_handling'), 'exactly one skill per pass file');

    const union = readFileSync(ctx.skillsFiles['all']!, 'utf8');
    assert.ok(union.includes('BODY_OF_awesome_copilot_go') && union.includes('BODY_OF_owasp_error_handling'));

    assert.ok(ctx.orchestratorPrompt.includes('record as reviewer name `awesome-copilot/go`'));
    assert.ok(ctx.orchestratorPrompt.includes('record as reviewer name `owasp/error-handling`'));
    assert.ok(!ctx.orchestratorPrompt.includes('phase1-findings.json'), 'Node, not the orchestrator, assembles Phase 1');
    assert.ok(!ctx.orchestratorPrompt.includes('record as reviewer name `verifier`'), 'Node gates the verifier separately');
    assert.ok(ctx.dispatchPlanPath && existsSync(ctx.dispatchPlanPath));
    assert.deepEqual(ctx.dispatchPlan?.reviewers.map((reviewer) => reviewer.name), passes.map((reviewer) => reviewer.name));
    assert.deepEqual(readDispatchPlan(ctx.dispatchPlanPath!).reviewers.map((reviewer) => reviewer.name), passes.map((reviewer) => reviewer.name));
    assert.ok(ctx.dispatchPlan?.verifier.enabled);
    assert.ok(ctx.dispatchPlan?.verifier.promptTemplate?.includes('phase1-findings.json'));

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
  const companions = seedCompanionSources();
  try {
    const passes = [pass('p/one'), pass('p/two')];
    const ctx = prepareSessionContext({
      ...baseOpts(outDir, ['src/app.ts'], passes),
      invokeCompanions: true,
      installedCompanions: ['pr-review-toolkit', 'code-review'],
      companionSources: companions.sources,
    });
    const prompt = ctx.orchestratorPrompt;
    const directive = 'do NOT post, comment, review, approve, or write ANYTHING to the pull request';
    const dispatchLines = prompt.split('\n').filter((l) => /^- .*(task|Task)\(/.test(l));
    // 2 passes + 6 companion agents + 1 companion slash. The verifier runs in a separate Node-gated session.
    assert.equal(dispatchLines.length, 9, `expected exactly 9 Phase-1 dispatch lines, got ${dispatchLines.length}`);
    // Every task-call in the prompt must BE one of those bullet lines — a dispatch
    // added as prose or a multi-line prompt would escape the per-line assertions.
    const totalCalls = (prompt.match(/task\(agent_type=|Task\(subagent_type=/g) ?? []).length;
    assert.equal(totalCalls, dispatchLines.length, 'a task call exists outside the audited dispatch bullets');
    for (const line of dispatchLines) {
      assert.ok(line.includes(directive), `dispatch line missing the no-posting directive: ${line.slice(0, 120)}…`);
      assert.equal((line.match(/description=/g) ?? []).length, 1, 'every dispatch has exactly one description');
    }
    const codeReviewLine = dispatchLines.find((l) => l.includes('record as reviewer name `companion:code-review`'));
    assert.ok(codeReviewLine, 'code-review companion line present');
    assert.ok(codeReviewLine.includes('agent_type="general-purpose"'), 'code-review runs as a generic agent');
    assert.ok(codeReviewLine.includes('companion-brief-'), 'code-review reads its materialized brief');
    assert.ok(!codeReviewLine.includes('/code-review:code-review'), 'the runtime-native slash command is never invoked');
    assert.ok(prompt.includes(`${directive}`) && prompt.includes('This binds you AND every subagent'), 'orchestrator-level rule present');
    assert.ok(ctx.dispatchPlan?.verifier.promptTemplate?.includes(directive), 'direct verifier keeps the no-posting directive');
  } finally {
    companions.cleanup();
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
    assert.deepEqual(ctx.dispatchPlan?.reviewers.map((reviewer) => reviewer.name), ['p/markdown', 'repo/forced-one']);
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

test('pass body cap — oversized PACK skill is truncated with a marker', () => {
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

test('pass body cap — a PROJECT skill running as a pass (skill_packs: [] fallback) is never truncated', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const ctx = prepareSessionContext(
      baseOpts(outDir, ['src/app.ts'], [pass('my-rules', { body: 'r'.repeat(60_000) + 'RULE-END', matchedBy: 'repo', origin: 'repo' })]),
    );
    const file = readFileSync(ctx.skillsFiles['my-rules']!, 'utf8');
    assert.ok(file.includes('RULE-END'), 'body lands whole');
    assert.ok(!file.includes('[truncated:'), 'no truncation marker for project-origin passes');
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

test('shared context — Codex, materialized companions, and verifier use skills-all.md without shared project context', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  const companions = seedCompanionSources();
  try {
    const passes = [pass('p/one'), pass('p/two')];
    const ctx = prepareSessionContext({
      ...baseOpts(outDir, ['src/app.ts'], passes),
      includeCodex: true,
      invokeCompanions: true,
      installedCompanions: ['pr-review-toolkit'],
      companionSources: companions.sources,
    });
    assert.ok(ctx.skillsFiles['all']!.endsWith('skills-all.md'));
    const union = readFileSync(ctx.skillsFiles['all']!, 'utf8');
    assert.ok(union.includes('BODY_OF_p_one') && union.includes('BODY_OF_p_two'));
    const companionLine = ctx.orchestratorPrompt
      .split('\n')
      .find((l) => l.includes('record as reviewer name `companion:pr-review-toolkit/code-reviewer`'));
    assert.ok(companionLine, 'companion agents dispatched');
    assert.ok(companionLine.includes('agent_type="general-purpose"'), 'companion criteria run through a generic agent');
    assert.ok(companionLine.includes('companion-brief-'), 'companion reads its materialized brief');
    assert.ok(companionLine.includes('skills-all.md'), 'companions read the union');
    assert.ok(ctx.dispatchPlan?.verifier.promptTemplate?.includes('skills-all.md'), 'verifier reads the union');
    assert.ok(ctx.dispatchPlan?.codex.skillsPath?.endsWith('skills-all.md'), 'Codex reads the union');
    assert.ok(companionLine.includes('reviewer-attempts'));
    assert.ok(companionLine.includes('attempt-1.json'));
  } finally {
    companions.cleanup();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('companions — every brief is materialized, hash-bound, and safe for confined generic dispatch', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-companion-context-'));
  const companions = seedCompanionSources();
  try {
    const ctx = prepareSessionContext({
      ...baseOpts(outDir, ['src/app.ts'], [pass('p/one')]),
      invokeCompanions: true,
      installedCompanions: ['pr-review-toolkit', 'code-review'],
      companionSources: companions.sources,
    });
    const companionPlans = ctx.dispatchPlan!.reviewers.filter((reviewer) => reviewer.kind.startsWith('companion'));
    assert.equal(companionPlans.length, 7);
    assert.ok(companionPlans.every((reviewer) => reviewer.agentType === 'general-purpose'));
    for (const reviewer of companionPlans) {
      const match = reviewer.promptTemplate.match(/`([^`]*companion-brief-[^`]*)`/);
      assert.ok(match, `${reviewer.name} prompt names a materialized brief`);
      const briefPath = match[1]!;
      assert.ok(existsSync(briefPath));
      assert.ok(ctx.dispatchPlan!.artifacts.some((artifact) => artifact.path === briefPath));
      const brief = readFileSync(briefPath, 'utf8');
      if (reviewer.name.endsWith('/code-reviewer')) {
        assert.match(brief, /Review only the materialized PR context and diff/);
      }
      assert.doesNotMatch(
        brief,
        /git diff|gh pr|mcp__github|allowed-tools|^model\s*:|Task tool|launch.{0,40}(?:agent|subagent)|post.{0,40}(?:comment|review thread)/im,
        `${reviewer.name} brief must contain criteria only`,
      );
    }

    const codeReview = companionPlans.find((reviewer) => reviewer.name === 'companion:code-review')!;
    const briefPath = codeReview.promptTemplate.match(/`([^`]*companion-brief-[^`]*)`/)![1]!;
    const brief = readFileSync(briefPath, 'utf8');
    assert.match(brief, /HIGH SIGNAL/);
    assert.match(brief, /definitely produce wrong results/);
    assert.match(brief, /Pre-existing issues/);
    assert.doesNotMatch(brief, /gh pr|mcp__github|post inline|allowed-tools|model: opus/i);
    assert.ok(codeReview.promptTemplate.includes('pr-context.md'));

    writeFileSync(briefPath, brief + '\nchanged', 'utf8');
    assert.ok(validateDispatchArtifacts(ctx.dispatchPlan!).some((failure) => failure.includes('immutable artifact changed')));
  } finally {
    companions.cleanup();
    rmSync(outDir, { recursive: true, force: true });
  }
});

/**
 * Fail closed, without taking the review with it.
 *
 * These cases used to throw, which aborted a run that had nine healthy passes over
 * one unreadable plugin file. The security property is unchanged and asserted here:
 * the refused content produces NO brief at all, so it never reaches a dispatched
 * agent. What changed is the blast radius — the companion is dropped and named.
 */
function assertCompanionRefused(
  opts: Parameters<typeof materializeCompanionBriefs>[0],
  reason: RegExp,
  message?: string,
): void {
  const { briefs, failures } = materializeCompanionBriefs(opts);
  assert.deepEqual(briefs, [], message);
  assert.equal(failures.length, 1, message);
  assert.match(failures[0]!.reason, reason, message);
}

test('companions — malformed frontmatter is stripped instead of entering a generic brief', () => {
  const seeded = seedCompanionSources();
  try {
    const toolkit = seeded.sources[0]!.roots[0]!;
    writeFileSync(
      join(toolkit, 'agents', 'code-reviewer.md'),
      [
        '---',
        'name: [unterminated',
        'model: opus',
        '---',
        '# code-reviewer',
        'Review definite bugs in the materialized diff.',
      ].join('\n'),
      'utf8',
    );

    const { briefs } = materializeCompanionBriefs({
      installed: ['pr-review-toolkit'],
      sources: [seeded.sources[0]!],
    });
    const brief = briefs.find((entry) => entry.reviewerName.endsWith('/code-reviewer'))!;
    assert.match(brief.body, /Review definite bugs in the materialized diff/);
    assert.doesNotMatch(brief.body, /name: \[unterminated|model: opus|^---$/m);

    writeFileSync(join(toolkit, 'agents', 'code-reviewer.md'), '---\nname: broken\nno closing delimiter', 'utf8');
    assertCompanionRefused(
      { installed: ['pr-review-toolkit'], sources: [seeded.sources[0]!] },
      /unterminated frontmatter.*code-reviewer\.md/i,
    );
  } finally {
    seeded.cleanup();
  }
});

test('companions — shell, network, test, and checkout acquisition directives fail closed', () => {
  for (const directive of [
    'Use Bash to run npm test before reviewing.',
    'Call WebFetch on the pull request URL before reviewing.',
    'Run curl https://example.test/diff before reviewing.',
    'Execute the test suite before reviewing.',
    'Clone the repository before reviewing.',
    'Use\nWebFetch to acquire the pull request.',
    'Post the finding\nas a review comment.',
    'Launch a validation\nsubagent before returning.',
    'Use the Task\ntool to delegate this review.',
  ]) {
    const seeded = seedCompanionSources();
    try {
      const toolkit = seeded.sources[0]!.roots[0]!;
      writeFileSync(join(toolkit, 'agents', 'code-simplifier.md'), `# criteria\n${directive}\n`, 'utf8');
      assertCompanionRefused(
        { installed: ['pr-review-toolkit'], sources: [seeded.sources[0]!] },
        /runtime-native directive/i,
        directive,
      );
    } finally {
      seeded.cleanup();
    }
  }
});

test('companions — identical active definitions agree, divergent definitions fail closed', () => {
  const first = seedCompanionSources();
  const second = seedCompanionSources();
  try {
    const roots = [first.sources[0]!.roots[0]!, second.sources[0]!.roots[0]!];
    const agreed = materializeCompanionBriefs({
      installed: ['pr-review-toolkit'],
      sources: [{ id: 'pr-review-toolkit', roots }],
    });
    assert.equal(agreed.briefs.length, 6);

    writeFileSync(join(roots[1], 'agents', 'code-reviewer.md'), '# changed criteria', 'utf8');
    assertCompanionRefused(
      { installed: ['pr-review-toolkit'], sources: [{ id: 'pr-review-toolkit', roots }] },
      /divergent active definitions.*code-reviewer\.md/,
    );
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test('companions — every active root must provide every required definition', () => {
  const first = seedCompanionSources();
  const second = seedCompanionSources();
  try {
    const roots = [first.sources[0]!.roots[0]!, second.sources[0]!.roots[0]!];
    rmSync(join(roots[1], 'agents', 'code-reviewer.md'));

    assertCompanionRefused(
      { installed: ['pr-review-toolkit'], sources: [{ id: 'pr-review-toolkit', roots }] },
      /active runtime root has no readable.*code-reviewer\.md/i,
    );
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test('companions — duplicate source ids and definitions escaping a plugin root are refused', () => {
  const seeded = seedCompanionSources();
  const outside = mkdtempSync(join(tmpdir(), 'pr-review-companion-outside-'));
  try {
    assert.throws(
      () => materializeCompanionBriefs({
        installed: ['pr-review-toolkit'],
        sources: [seeded.sources[0]!, seeded.sources[0]!],
      }),
      /duplicate companion source id/i,
    );

    const toolkit = seeded.sources[0]!.roots[0]!;
    const outsideAgents = join(outside, 'agents');
    mkdirSync(outsideAgents, { recursive: true });
    writeFileSync(join(outsideAgents, 'code-reviewer.md'), '# escaped criteria', 'utf8');
    rmSync(join(toolkit, 'agents'), { recursive: true, force: true });
    symlinkSync(outsideAgents, join(toolkit, 'agents'), process.platform === 'win32' ? 'junction' : 'dir');
    assertCompanionRefused(
      { installed: ['pr-review-toolkit'], sources: [seeded.sources[0]!] },
      /no readable.*code-reviewer\.md/,
    );
  } finally {
    seeded.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('verifier — Node-owned plan carries a direct conditional verifier; --skip removes it', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const ctx = prepareSessionContext(baseOpts(outDir, ['src/app.ts'], [pass('p/one')]));
    assert.ok(ctx.verifierPath && existsSync(ctx.verifierPath));
    assert.ok(readFileSync(ctx.verifierPath!, 'utf8').includes('Cross-cutting issues'));
    assert.ok(!ctx.orchestratorPrompt.includes('verifier.md'));
    assert.ok(!ctx.orchestratorPrompt.includes('record as reviewer name `verifier`'));
    assert.equal(ctx.dispatchPlan?.verifier.enabled, true);
    assert.ok(ctx.dispatchPlan?.verifier.promptTemplate?.includes('verifier.md'));
    assert.ok(ctx.dispatchPlan?.verifier.promptTemplate?.includes('{{PR_REVIEW_OUTPUT_PATH}}'));
    assert.ok(ctx.dispatchPlan?.verifier.canonicalOutputPath?.endsWith('raw-verifier.json'));

    const outDir2 = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
    try {
      const skipped = prepareSessionContext({
        ...baseOpts(outDir2, ['src/app.ts'], [pass('p/one')]),
        skipReviewers: ['verifier'],
      });
      assert.equal(skipped.verifierPath, undefined);
      assert.ok(!skipped.orchestratorPrompt.includes('record as reviewer name `verifier`'));
      assert.equal(skipped.dispatchPlan?.verifier.enabled, false);
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

test('cap — more passes than MAX_TOTAL_PASSES: overflow goes to the index file and routes as index', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const passes = Array.from({ length: MAX_TOTAL_PASSES + 2 }, (_, i) =>
      pass(`p/pass-${String(i).padStart(2, '0')}`, { matchedBy: 'glob' }),
    );
    const ctx = prepareSessionContext(baseOpts(outDir, ['src/app.ts'], passes));
    assert.equal(ctx.passes.length, MAX_TOTAL_PASSES);
    const overflowNames = [`p/pass-${MAX_TOTAL_PASSES}`, `p/pass-${MAX_TOTAL_PASSES + 1}`];
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

test('cap — every configured baseline dispatches even above MAX_TOTAL_PASSES', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const passes = Array.from({ length: MAX_TOTAL_PASSES + 3 }, (_, index) => pass(`baseline/${index}`));
    const ctx = prepareSessionContext(baseOpts(outDir, ['src/app.ts'], passes));
    assert.deepEqual(ctx.passes.map((entry) => entry.name), passes.map((entry) => entry.name));
    assert.ok(ctx.passes.length > MAX_TOTAL_PASSES);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('cap — stack-matched configured baselines retain baseline membership end to end', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const packSkills: SkillDefinition[] = Array.from({ length: MAX_TOTAL_PASSES + 3 }, (_, index) => ({
      name: `pack/baseline-${index}`,
      source: `/pack/${index}.md`,
      body: `body-${index}`,
      description: `baseline ${index}`,
      appliesTo: ['src/**'],
      tags: ['typescript'],
      origin: 'pack',
      pack: 'pack',
      mode: 'auto',
    }));
    const selection = selectPasses({
      skills: [],
      catalog: [],
      packSkills,
      inScopeFiles: [{ path: 'src/app.ts' }],
      stackTags: ['typescript'],
      stackEvidence: { languages: ['typescript'], ecosystems: [], dependencies: [], dependencyTokens: [] },
      baseline: packSkills.map((skill) => skill.name),
    });
    assert.ok(selection.passes.some((entry) => entry.matchedBy === 'glob' && entry.baseline));
    const ctx = prepareSessionContext(baseOpts(outDir, ['src/app.ts'], selection.passes));
    assert.deepEqual(ctx.passes.map((entry) => entry.name).sort(), packSkills.map((entry) => entry.name).sort());
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('stack + index — pr-context carries ## Stack and points at skills-index.md; both absent when empty', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const indexEntries: IndexEntry[] = [
      { name: 'anthropic-cybersecurity/detecting-x', description: 'detects x', source: '/packs/a/x.md', body: 'DETECT-X-BODY', tags: ['x'] },
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
    const indexedSkill = readdirSync(outDir).find((name) => name.startsWith('indexed-skill-'));
    assert.ok(indexedSkill);
    assert.ok(index.includes(join(outDir, indexedSkill)));
    assert.ok(readFileSync(join(outDir, indexedSkill), 'utf8').includes('DETECT-X-BODY'));
    assert.ok(!index.includes('DETECT-X-BODY'), 'index points to the materialized body without inlining it');
    assert.ok(ctx.dispatchPlan?.artifacts.some((artifact) => artifact.path === join(outDir, 'skills-index.md')));
    assert.ok(ctx.dispatchPlan?.artifacts.some((artifact) => artifact.path === join(outDir, indexedSkill)));
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

test('index — shards every exposed entry and keeps duplicate names distinct', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const indexEntries: IndexEntry[] = [
      { name: 'duplicate', description: 'first', source: '/one.md', body: 'FIRST-BODY', tags: [] },
      { name: 'duplicate', description: 'second', source: '/two.md', body: 'SECOND-BODY', tags: [] },
      ...Array.from({ length: 1_000 }, (_, index) => ({
        name: `pack/skill-${index}`,
        description: `description-${index}-${'x'.repeat(180)}`,
        source: `/packs/skill-${index}.md`,
        body: `BODY-${index}`,
        tags: [],
      })),
    ];
    const ctx = prepareSessionContext(baseOpts(outDir, ['src/app.ts'], [pass('p/one')], indexEntries));
    const index = readFileSync(join(outDir, 'skills-index.md'), 'utf8');
    const materialized = readdirSync(outDir).filter((name) => name.startsWith('indexed-skill-'));
    const shards = readdirSync(outDir).filter((name) => /^skills-index-\d+\.md$/.test(name));
    assert.match(index, /split across \d+ index shards/);
    assert.ok(shards.length > 1);
    assert.equal(materialized.length, indexEntries.length, 'every counted entry has a readable body file');
    const shardBodies = shards.map((name) => readFileSync(join(outDir, name), 'utf8')).join('\n');
    assert.ok(indexEntries.every((entry) => shardBodies.includes(`**${entry.name}**`)));
    const duplicates = materialized.filter((name) => name.includes('duplicate'));
    assert.equal(duplicates.length, 2);
    assert.notEqual(duplicates[0], duplicates[1]);
    const duplicateBodies = duplicates.map((name) => readFileSync(join(outDir, name), 'utf8'));
    assert.ok(duplicateBodies.some((body) => body.includes('FIRST-BODY')));
    assert.ok(duplicateBodies.some((body) => body.includes('SECOND-BODY')));
    const artifactPaths = new Set(ctx.dispatchPlan?.artifacts.map((artifact) => artifact.path));
    assert.equal(
      [...artifactPaths].filter((path) => path.includes('indexed-skill-')).length,
      materialized.length,
      'every exposed body is digest-bound',
    );
    assert.ok(shards.every((name) => artifactPaths.has(join(outDir, name))), 'every index shard is digest-bound');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('MCP capabilities — context advertises no server, and only the trusted repo config is copied', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const trustedMcpConfig = { mcpServers: { modelInspector: { command: 'tool' } } };
    const ctx = prepareSessionContext({
      ...baseOpts(outDir, ['models/table.tmdl'], [pass('plugin/model-review', { origin: 'plugin', plugin: 'model-tools', mcpServers: ['modelInspector'] })]),
      repoRoot: 'C:/repo',
      mcpServers: [
        { name: 'modelInspector', source: 'plugin:model-tools' },
        { name: 'bicep', source: 'repo' },
      ],
      trustedMcpConfig,
    });
    const context = readFileSync(ctx.contextPath, 'utf8');
    assert.match(context, /Checkout root:\*\* C:\/repo/);
    // Both runtimes deny MCP tools at the process level, so the shared context must
    // not advertise servers a pass cannot call. It used to list them under
    // "## Available MCP Capabilities", which only bought a paragraph of the pass
    // explaining why the call it was told to make was impossible.
    assert.doesNotMatch(context, /Available MCP Capabilities/);
    assert.doesNotMatch(context, /modelInspector \(plugin:model-tools\)/);
    assert.doesNotMatch(context, /bicep \(repo\)/);
    assert.ok(existsSync(join(outDir, '.mcp.json')));
    assert.match(ctx.capabilityFiles['plugin/model-review'] ?? '', /capability-plugin_model-review--[0-9a-f]{12}\.json$/);
    assert.deepEqual(JSON.parse(readFileSync(join(outDir, '.mcp.json'), 'utf8')), trustedMcpConfig);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('MCP capabilities — the capability brief asks what the pass observed, never for a fixed answer', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const ctx = prepareSessionContext({
      ...baseOpts(outDir, ['models/table.tmdl'], [pass('plugin/model-review', { origin: 'plugin', plugin: 'model-tools', mcpServers: ['modelInspector'] })]),
      mcpServers: [{ name: 'modelInspector', source: 'plugin:model-tools' }],
    });
    assert.ok(ctx.orchestratorPrompt.includes('\\"available\\":[],\\"attempted\\":[],\\"used\\":[]'));
    assert.match(ctx.orchestratorPrompt, /arrays of server-name strings, never booleans/);
    assert.match(ctx.orchestratorPrompt, /modelInspector/);
    assert.match(ctx.orchestratorPrompt, /denies MCP at the process level/);
    // Not categorical: copilot's denial reaches only what discoverMcpCapabilities enumerated.
    assert.match(ctx.orchestratorPrompt, /categorically under claude/);
    // The escape hatch is the point — an artifact whose content is fixed by construction
    // cannot report the one condition it exists to detect (a denial that stopped working).
    assert.match(ctx.orchestratorPrompt, /denial leak worth reporting/);
    assert.doesNotMatch(ctx.orchestratorPrompt, /MUST ALL be empty arrays/);
    assert.doesNotMatch(ctx.orchestratorPrompt, /read-only MCP inspection\/validation tools/);
    // No double space where the brief joins the preceding segment.
    assert.doesNotMatch(ctx.orchestratorPrompt, /  This installed-plugin pass/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('MCP capabilities — dispatch plan denies every inventoried server, deduped and sorted', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    // `mcpServers` has ONE observable consumer left: the disabledMcpServers list that
    // becomes copilot's --disable-mcp-server argv. Without this, pruning `mcpServers` as
    // "now unused" un-denies every inventoried server under copilot with a green suite.
    const ctx = prepareSessionContext({
      ...baseOpts(outDir, ['models/table.tmdl'], [pass('plugin/model-review', { origin: 'plugin', plugin: 'model-tools', mcpServers: ['modelInspector'] })]),
      mcpServers: [
        { name: 'modelInspector', source: 'plugin:model-tools' },
        { name: 'bicep', source: 'repo' },
        { name: 'bicep', source: 'plugin:infra' },
      ],
    });
    assert.deepEqual(ctx.dispatchPlan?.disabledMcpServers, ['bicep', 'modelInspector']);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('project rules — skills-project.md reaches passes, Codex, every materialized companion, and verifier', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  const companions = seedCompanionSources();
  try {
    const projectSkills = [
      { name: 'pp-regras-plano', description: 'plan rules', source: '/repo/.agents/skills/pp-regras-plano/SKILL.md', body: 'PROJECT_RULE_MARKER', appliesTo: [] },
    ];
    const ctx = prepareSessionContext({
      ...baseOpts(outDir, ['src/app.ts'], [pass('p/one'), pass('p/two')]),
      projectSkills,
      includeCodex: true,
      invokeCompanions: true,
      installedCompanions: ['pr-review-toolkit', 'code-review'],
      companionSources: companions.sources,
    });
    const projectFile = ctx.skillsFiles['project']!;
    assert.ok(projectFile.endsWith('skills-project.md'));
    assert.equal(ctx.skillsFiles['all'], undefined, 'the pass union is not written when project rules matched');
    assert.equal(existsSync(join(outDir, 'skills-all.md')), false);
    const body = readFileSync(projectFile, 'utf8');
    assert.ok(body.includes('PROJECT_RULE_MARKER'));
    assert.ok(body.includes('authoritative and OVERRIDE'), 'project rules keep the authoritative wording');

    const prompt = ctx.orchestratorPrompt;
    const passLines = prompt.split('\n').filter((l) => l.includes('record as reviewer name `p/'));
    assert.equal(passLines.length, 2);
    for (const l of passLines) assert.ok(l.includes('skills-project.md'), 'every pass reads the project rules');
    const companionLines = prompt.split('\n').filter((line) => line.includes('record as reviewer name `companion:'));
    assert.equal(companionLines.length, 7);
    for (const line of companionLines) assert.ok(line.includes('skills-project.md'), 'every companion gets the authoritative rules');
    assert.ok(ctx.dispatchPlan?.verifier.promptTemplate?.includes('skills-project.md'), 'verifier gets the authoritative rules');
    assert.equal(ctx.dispatchPlan?.codex.skillsPath, projectFile, 'Codex gets the authoritative rules');

    assert.equal(ctx.routing.find((r) => r.name === 'pp-regras-plano')?.matchedBy, 'context');
    // --skip drops a project rule from the context file too.
    const outDir2 = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
    try {
      const skipped = prepareSessionContext({
        ...baseOpts(outDir2, ['src/app.ts'], [pass('p/one')]),
        projectSkills,
        skipReviewers: ['pp-regras-plano'],
      });
      assert.equal(skipped.skillsFiles['project'], undefined);
      assert.equal(skipped.routing.find((r) => r.name === 'pp-regras-plano')?.matchedBy, 'skipped');
    } finally {
      rmSync(outDir2, { recursive: true, force: true });
    }
  } finally {
    companions.cleanup();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('project rules — large skill bodies land WHOLE: no byte cap, no truncation markers', () => {
  // Regression: a 63KB skills-project.md used to deliver 3 of 10 selected skills,
  // two of them cut at 16KB (live runs BE#616/FE#1067). Business rules never truncate.
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const big = (name: string) => ({
      name,
      description: 'big rule',
      source: `/repo/.agents/skills/${name}/SKILL.md`,
      body: `${name}-START ` + 'x'.repeat(30_000) + ` ${name}-END`,
      appliesTo: [],
    });
    const projectSkills = [big('rule-a'), big('rule-b'), big('rule-c')]; // ~90KB total, each body > old 16KB cap
    const ctx = prepareSessionContext({ ...baseOpts(outDir, ['src/app.ts'], [pass('p/one')]), projectSkills });
    const body = readFileSync(ctx.skillsFiles['project']!, 'utf8');
    for (const s of projectSkills) {
      assert.ok(body.includes(`${s.name}-START`) && body.includes(`${s.name}-END`), `${s.name} body is complete`);
    }
    assert.ok(!body.includes('[truncated:'), 'no per-skill truncation');
    assert.ok(!body.includes('[omitted:'), 'no whole-skill omission');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('passes.json — persisted at dispatch time, equal to ctx.routing (for --resume)', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const indexEntries: IndexEntry[] = [{ name: 'p/indexed', description: '', source: '/x.md', body: 'indexed rules', tags: [] }];
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

test('pass body cap — a CONFIGURED-dir skill running as a pass is never truncated either', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const ctx = prepareSessionContext(
      baseOpts(outDir, ['src/app.ts'], [pass('my-rules', { body: 'r'.repeat(60_000) + 'RULE-END', matchedBy: 'glob', origin: 'configured' })]),
    );
    const file = readFileSync(ctx.skillsFiles['my-rules']!, 'utf8');
    assert.ok(file.includes('RULE-END'), 'body lands whole');
    assert.ok(!file.includes('[truncated:'), 'no truncation marker for project-origin passes');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// Section shape copied from the official pr-review-toolkit `code-reviewer.md`:
// invocation guidance addressed to the HOST, carrying a sentence ("Spawn this agent
// on the freshly written files") that the directive scan reads as fan-out. Scanning
// it refused the whole companion over prose describing its own call sites.
test('companions — host invocation guidance is removed, not scanned as criteria', () => {
  const seeded = seedCompanionSources();
  try {
    const toolkit = seeded.sources[0]!.roots[0]!;
    writeFileSync(
      join(toolkit, 'agents', 'code-reviewer.md'),
      [
        'You are an expert code reviewer.',
        '',
        '## When to invoke',
        '',
        '- **Proactive review.** Spawn this agent on the freshly written files.',
        '- **Pre-PR sanity check.** Run a review of the full diff first.',
        '',
        '## Review Scope',
        '',
        'COMPANION_CRITERIA_code-reviewer',
      ].join('\n'),
      'utf8',
    );

    const { briefs, failures } = materializeCompanionBriefs({
      installed: ['pr-review-toolkit'],
      sources: [seeded.sources[0]!],
    });

    assert.deepEqual(failures, []);
    const brief = briefs.find((entry) => entry.reviewerName.endsWith('/code-reviewer'))!;
    // The criteria survive; the host-facing section is gone entirely, so nothing
    // hidden inside it can instruct the dispatched agent either.
    assert.match(brief.body, /COMPANION_CRITERIA_code-reviewer/);
    assert.match(brief.body, /## Review Scope/);
    assert.doesNotMatch(brief.body, /When to invoke/i);
    assert.doesNotMatch(brief.body, /Spawn this agent/i);
    assert.doesNotMatch(brief.body, /Pre-PR sanity check/i);
  } finally {
    seeded.cleanup();
  }
});

test('companions — a real directive AFTER the invocation section still fails closed', () => {
  const seeded = seedCompanionSources();
  try {
    const toolkit = seeded.sources[0]!.roots[0]!;
    writeFileSync(
      join(toolkit, 'agents', 'code-reviewer.md'),
      [
        '## When to invoke',
        'Spawn this agent on the freshly written files.',
        '',
        '## Review Scope',
        'Use Bash to run npm test before reviewing.',
      ].join('\n'),
      'utf8',
    );

    assertCompanionRefused(
      { installed: ['pr-review-toolkit'], sources: [seeded.sources[0]!] },
      /runtime-native directive/i,
    );
  } finally {
    seeded.cleanup();
  }
});
