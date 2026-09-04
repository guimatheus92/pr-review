import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The slash command's Step 1 block locates the checkout whose origin matches
// the PR URL before starting the CLI. This runs that exact block (with the
// final `node "$CLI" review` swapped for an echo) inside a throwaway workspace.

function bashOnPath(): string | null {
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim() === 'ok' ? 'bash' : null;
}

function step1Script(): string {
  const doc = readFileSync(join(process.cwd(), 'commands', 'pr-review.md'), 'utf8');
  const block = doc.match(/```bash\r?\n([\s\S]*?)```/)?.[1];
  assert.ok(block, 'commands/pr-review.md carries a bash block');
  return block
    .replace(/^node "\$CLI" review \$ARGUMENTS --detach$/m, 'echo "WOULD RUN from $(pwd)"')
    // the CLI locator is not under test: point it at any existing file
    .replace(/^CLI="\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.cjs"$/m, 'CLI="$PR_REVIEW_TEST_CLI"');
}

function repo(dir: string, origin: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir, stdio: 'ignore' });
}

function run(cwd: string, script: string, args: string, cli: string): { out: string; status: number | null } {
  const res = spawnSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ARGUMENTS: args, PR_REVIEW_TEST_CLI: cli },
  });
  return { out: res.stdout + res.stderr, status: res.status };
}

test('slash command — finds the matching checkout among siblings, GitHub / ADO https / ADO ssh / scp-style origins', (context) => {
  if (!bashOnPath()) {
    context.skip('bash not on PATH');
    return;
  }
  const ws = mkdtempSync(join(tmpdir(), 'pr-review-finder-'));
  try {
    const cli = join(ws, 'cli.cjs');
    writeFileSync(cli, '// stub\n');
    repo(join(ws, 'gh-repo'), 'git@github.com:Owner/Repo.git');
    repo(join(ws, 'ado-https'), 'https://org@dev.azure.com/org/proj/_git/svc');
    repo(join(ws, 'ado-ssh'), 'git@ssh.dev.azure.com:v3/org/proj/other');
    repo(join(ws, 'unrelated'), 'https://github.com/someone/else.git');
    mkdirSync(join(ws, 'gh-repo', '.claude', 'skills', 'owned'), { recursive: true });
    writeFileSync(join(ws, 'gh-repo', '.claude', 'skills', 'owned', 'SKILL.md'), '# owned\n');
    writeFileSync(join(ws, 'gh-repo', '.claude', 'skills', 'flat.md'), '# flat\n');
    writeFileSync(join(ws, 'gh-repo', '.claude', 'skills', 'README.md'), '# index\n');
    const script = step1Script();

    const gh = run(ws, script, 'https://github.com/Owner/Repo/pull/7 --dry-run', cli);
    assert.match(gh.out, /repo: .*gh-repo/, gh.out);
    assert.match(gh.out, /project skills discoverable: 2\b/, 'SKILL.md dir + flat .md, README excluded');
    assert.match(gh.out, /WOULD RUN from .*gh-repo/);

    const adoHttps = run(ws, script, 'https://dev.azure.com/org/proj/_git/svc/pullrequest/12', cli);
    assert.match(adoHttps.out, /repo: .*ado-https/, adoHttps.out);

    const adoSsh = run(ws, script, 'https://dev.azure.com/org/proj/_git/other/pullrequest/13', cli);
    assert.match(adoSsh.out, /repo: .*ado-ssh/, adoSsh.out);

    const fromInside = run(join(ws, 'gh-repo', '.claude'), script, 'https://github.com/owner/repo/pull/7', cli);
    assert.match(fromInside.out, /repo: .*gh-repo/, 'the repository containing cwd is found first');

    const none = run(ws, script, 'https://github.com/nobody/nothing/pull/1', cli);
    assert.match(none.out, /WARNING: no local checkout matches/);
    assert.match(none.out, /WOULD RUN from /);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
