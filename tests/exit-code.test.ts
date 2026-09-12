import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideExitCode } from '../src/commands/review.js';
import { parseSeverity, partitionFindingsForPublication } from '../src/util/severity.js';
import type { Finding } from '../src/types.js';

function f(severity: Finding['severity']): Finding {
  return { severity, title: 't', body: 'b' };
}

test('decideExitCode — 2 wins over everything: no parseable findings is never a clean PR', () => {
  assert.equal(decideExitCode(true, [f('CRITICAL')], 'HIGH'), 2);
  assert.equal(decideExitCode(true, [], undefined), 2);
});

test('decideExitCode — 1 when findings at/above --fail-on survive', () => {
  assert.equal(decideExitCode(false, [f('CRITICAL')], 'HIGH'), 1);
  assert.equal(decideExitCode(false, [f('HIGH')], 'HIGH'), 1);
});

test('decideExitCode — 0 when below threshold or no threshold given', () => {
  assert.equal(decideExitCode(false, [f('MEDIUM')], 'HIGH'), 0);
  assert.equal(decideExitCode(false, [f('CRITICAL')], undefined), 0);
  assert.equal(decideExitCode(false, [], 'NIT'), 0);
});

test('publication severity is inclusive at every threshold and does not mutate findings', () => {
  const findings = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NIT'].map((severity) => f(severity as Finding['severity']));
  const before = JSON.stringify(findings);
  const cases: Array<[Finding['severity'], Finding['severity'][]]> = [
    ['CRITICAL', ['CRITICAL']],
    ['HIGH', ['CRITICAL', 'HIGH']],
    ['MEDIUM', ['CRITICAL', 'HIGH', 'MEDIUM']],
    ['LOW', ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']],
    ['NIT', ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NIT']],
  ];
  for (const [threshold, expected] of cases) {
    const result = partitionFindingsForPublication(findings, threshold);
    assert.deepEqual(result.publicationEligibleFindings.map((finding) => finding.severity), expected);
    assert.equal(result.suppressedByPublicationFilter.length, 5 - expected.length);
    assert.deepEqual(result.publication, {
      minimumSeverity: threshold, eligibleCount: expected.length, suppressedCount: 5 - expected.length,
    });
    assert.equal(JSON.stringify(findings), before);
  }
  assert.deepEqual(partitionFindingsForPublication(findings).publicationEligibleFindings, findings);
});

test('severity flags normalize case and reject invalid or empty values clearly', () => {
  for (const flag of ['--publish-min-severity', '--fail-on']) {
    assert.equal(parseSeverity('hIgH', flag), 'HIGH');
    assert.equal(parseSeverity(undefined, flag), undefined);
    for (const invalid of ['', 'urgent', 'high+', ' high']) {
      assert.throws(() => parseSeverity(invalid, flag), {
        message: `${flag} must be one of: critical, high, medium, low, nit`,
      });
    }
  }
  assert.throws(() => partitionFindingsForPublication([f('invalid' as Finding['severity'])]), /invalid finding severity/);
});

test('publication suppression and fail-on are independent even with zero eligible findings', () => {
  const finalFindings = [f('MEDIUM'), f('LOW'), f('NIT')];
  assert.equal(partitionFindingsForPublication(finalFindings, 'HIGH').publicationEligibleFindings.length, 0);
  assert.equal(decideExitCode(false, finalFindings, 'MEDIUM'), 1);
  assert.equal(decideExitCode(false, finalFindings), 0);
  assert.equal(decideExitCode(true, finalFindings, 'MEDIUM'), 2);
});

test('publication CLI flags reject invalid values before URL, findings-file, or detach side effects', () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  for (const command of ['review', 'post']) {
    const args = command === 'review' ? ['--detach'] : ['--findings', 'nonexistent-findings.json'];
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', cli, command, 'invalid-url', ...args, '--publish-min-severity', 'urgent',
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--publish-min-severity must be one of: critical, high, medium, low, nit/);
    assert.doesNotMatch(result.stdout + result.stderr, /run-id:|ENOENT|unsupported.*URL|authentication/i);
    const help = spawnSync(process.execPath, ['--import', 'tsx', cli, command, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--publish-min-severity <severity>/);
  }
});

test('bundled publication fixture retains every severity through dispatch, verifier, dedupe and offline audit', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-publication-cli-'));
  const home = join(root, 'home');
  const runId = 'publication-offline';
  const runDir = join(home, '.pr-review', 'runs', runId);
  const cli = fileURLToPath(new URL('../dist/cli.cjs', import.meta.url));
  const script = fileURLToPath(new URL('../evals/acceptance/publication-runtime.mjs', import.meta.url));
  try {
    mkdirSync(join(home, '.pr-review', 'cache'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(home, '.pr-review', 'config.yaml'), 'skill_packs: []\n');
    writeFileSync(join(home, '.pr-review', 'cache', 'linguist-languages.yml'), 'TypeScript:\n  extensions: [.ts]\n');
    const binary = join(root, process.platform === 'win32' ? 'fixture.cmd' : 'fixture');
    writeFileSync(binary, process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    if (process.platform !== 'win32') chmodSync(binary, 0o755);
    const rule = join(root, 'rule.md');
    writeFileSync(rule, '---\nname: publication-fixture\ndescription: Review every change.\n---\nAnalyze all supplied code.\n');
    const prUrl = 'https://github.com/pr-review/eval/pull/1';
    const gather = {
      pr: { provider: 'github', url: prUrl, owner: 'pr-review', repo: 'eval', number: 1 },
      metadata: {
        title: 'Publication fixture', description: 'A complete mixed-severity publication fixture.', author: 'fixture',
        headSha: 'abcdef1234567890', baseSha: '1234567890abcdef', headBranch: 'feature', baseBranch: 'main',
        state: 'open', isDraft: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        linkedItems: [], labels: [], changedFileCount: 1,
      },
      changedFiles: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1,
        patch: '@@ -1,5 +1,5 @@\n first\n second\n-old\n+replacement\n fourth\n fifth' }],
      existingComments: [], changedFilesComplete: true, gatheredAt: new Date().toISOString(),
    };
    const gatherPath = join(root, 'gather.json');
    writeFileSync(gatherPath, JSON.stringify(gather));
    const env = { ...process.env, USERPROFILE: home, HOME: home, PR_REVIEW_PUBLICATION_SCENARIO: 'mixed' };
    const reviewed = spawnSync(process.execPath, [
      cli, 'review', prUrl, '--from-gather', gatherPath, '--run-dir', runDir, '--dry-run', '--no-codex',
      '--no-companions', '--no-autodiscover', '--force-skill', rule, '--copilot', binary,
      '--default-model', 'publication-fixture', '--publish-min-severity', 'hIgH', '--fail-on', 'medium',
    ], { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(reviewed.status, 1, reviewed.stderr);
    const artifact = JSON.parse(readFileSync(join(runDir, 'pr-review-findings.json'), 'utf8'));
    assert.deepEqual(artifact.finalFindings.map((finding: Finding) => finding.severity), ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NIT']);
    assert.equal(artifact.droppedCount, 1);
    assert.deepEqual(artifact.publication, { minimumSeverity: 'HIGH', eligibleCount: 2, suppressedCount: 3 });
    assert.equal(JSON.parse(readFileSync(join(runDir, 'delivery-state.json'), 'utf8')).verifier.state, 'valid');
    assert.equal(existsSync(join(runDir, 'posted.marker')), false);
    for (const finding of artifact.finalFindings) assert.ok(reviewed.stdout.includes(finding.body));
    const verified = spawnSync(process.execPath, [cli, 'verify', runId, '--home', home, '--offline', '--json'], {
      cwd: root, env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    const rows = JSON.parse(verified.stdout).rows;
    assert.equal(rows.find((entry: { id: string }) => entry.id === 'INV-OUT-02').status, 'pass');
    assert.equal(rows.find((entry: { id: string }) => entry.id === 'INV-POST-01').status, 'skip', 'offline proof cannot claim actual posting');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bundled post filters all supported input shapes without changing their bytes or posting decorated bodies', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-publication-post-cli-'));
  const cli = fileURLToPath(new URL('../dist/cli.cjs', import.meta.url));
  try {
    const capture = join(root, 'writes.json');
    const preload = join(root, 'http-fixture.mjs');
    const patch = '@@ -1,5 +1,5 @@\n first\n second\n-old\n+replacement\n fourth\n fifth';
    writeFileSync(preload, [
      "import { writeFileSync } from 'node:fs';",
      'const writes = [];',
      'globalThis.fetch = async (input, options = {}) => {',
      '  const url = new URL(typeof input === "string" ? input : input.url);',
      '  const method = options.method ?? "GET";',
      '  let payload;',
      '  if (method === "POST" && url.pathname.endsWith("/reviews")) {',
      '    const request = JSON.parse(options.body);',
      '    writes.push(...request.comments);',
      `    writeFileSync(${JSON.stringify(capture)}, JSON.stringify(writes));`,
      '    payload = { id: 1 };',
      '  } else if (method === "GET" && url.pathname.endsWith("/pulls/1")) {',
      '    payload = { title: "Fixture", body: "Publication fixture with complete context.", user: { login: "fixture" }, head: { sha: "h", ref: "f" }, base: { sha: "b", ref: "main" }, labels: [], state: "open", changed_files: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };',
      '  } else if (method === "GET" && url.pathname.endsWith("/files")) {',
      `    payload = [{ filename: "a.ts", status: "modified", additions: 1, deletions: 1, patch: ${JSON.stringify(patch)} }];`,
      '  } else if (method === "GET" && url.pathname.endsWith("/comments")) { payload = []; }',
      '  else { throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`); }',
      '  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });',
      '};',
    ].join('\n'));
    const findings = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NIT'].map((severity, index) => ({
      severity, title: `Private title ${index}`, body: `Finding body ${index}.`, file: 'a.ts', line: index + 1,
    }));
    const inputs = [
      { finalFindings: findings, publication: { minimumSeverity: 'CRITICAL', eligibleCount: 1, suppressedCount: 4 } },
      { reviewers: [{ reviewer: 'fixture', model: 'fixture', findings }] },
      [{ reviewer: 'fixture', model: 'fixture', findings }],
    ];
    for (const input of inputs) {
      for (const threshold of [undefined, 'hIgH']) {
        const path = join(root, 'findings.json');
        const bytes = JSON.stringify(input);
        writeFileSync(path, bytes);
        writeFileSync(capture, '[]');
        const result = spawnSync(process.execPath, [
          '--import', pathToFileURL(preload).href, cli, 'post', 'https://github.com/fixture/review/pull/1', '--findings', path,
          ...(threshold ? ['--publish-min-severity', threshold] : []),
        ], {
          cwd: root, encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, USERPROFILE: root, HOME: root, GITHUB_TOKEN: 'test-token' },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')).map((comment: { body: string }) => comment.body),
          findings.slice(0, threshold ? 2 : 5).map((finding) => finding.body));
        assert.equal(readFileSync(path, 'utf8'), bytes);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
