// Release helper: bump the version everywhere it lives, prove no stale
// version string survived, roll CHANGELOG's Unreleased section, rebuild the
// bundle, commit and tag. Push is left to the human on purpose.
//
// Usage: node scripts/release.mjs <patch|minor|major|x.y.z>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const VERSIONED_FILES = ['package.json', 'package-lock.json', 'plugin.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];

function run(cmd, args) {
  // npm is a .cmd shim on Windows and needs a shell — but shell:true with an
  // args ARRAY concatenates unescaped (git commit -m "Release X" would split).
  // git.exe is a real binary: run it without a shell so args stay intact.
  if (cmd === 'npm' && process.platform === 'win32') {
    return execFileSync(['npm', ...args].join(' '), { encoding: 'utf8', shell: true });
  }
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node scripts/release.mjs <patch|minor|major|x.y.z>');
  process.exit(2);
}

const status = run('git', ['status', '--porcelain']).trim();
if (status) {
  console.error('working tree not clean — commit or stash first:\n' + status);
  process.exit(2);
}

const oldVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const newVersion = /^\d+\.\d+\.\d+$/.test(arg)
  ? arg
  : (() => {
      const [ma, mi, pa] = oldVersion.split('.').map(Number);
      if (arg === 'major') return `${ma + 1}.0.0`;
      if (arg === 'minor') return `${ma}.${mi + 1}.0`;
      if (arg === 'patch') return `${ma}.${mi}.${pa + 1}`;
      console.error(`unrecognized bump "${arg}"`);
      process.exit(2);
    })();

console.log(`bumping ${oldVersion} → ${newVersion}`);

// npm version updates package.json + package-lock.json consistently
run('npm', ['version', '--no-git-tag-version', newVersion]);
for (const file of ['plugin.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
  const next = readFileSync(file, 'utf8').replaceAll(`"version": "${oldVersion}"`, `"version": "${newVersion}"`);
  writeFileSync(file, next);
}

// Prove the bump is complete: no tracked file may still carry the old manifest version.
const stale = VERSIONED_FILES.filter((f) => readFileSync(f, 'utf8').includes(`"version": "${oldVersion}"`));
if (stale.length > 0) {
  console.error(`stale version "${oldVersion}" still present in: ${stale.join(', ')}`);
  process.exit(1);
}

// Roll CHANGELOG: Unreleased → the new version, dated; fresh Unreleased on top.
const today = new Date().toISOString().slice(0, 10);
const changelog = readFileSync('CHANGELOG.md', 'utf8');
if (!changelog.includes('## [Unreleased]')) {
  console.error('CHANGELOG.md has no "## [Unreleased]" section — add your notes there first');
  process.exit(1);
}
writeFileSync(
  'CHANGELOG.md',
  changelog.replace('## [Unreleased]', `## [Unreleased]\n\n## [${newVersion}] — ${today}`),
);

console.log(run('npm', ['run', 'build']).split('\n').slice(-2).join('\n'));

run('git', ['add', '-A']);
run('git', ['commit', '-m', `Release ${newVersion}`]);
// annotated, so `git push --follow-tags` actually pushes it
run('git', ['tag', '-a', `v${newVersion}`, '-m', `Release ${newVersion}`]);
console.log(`\nreleased ${newVersion} locally. Next steps:`);
console.log(`  git push --follow-tags`);
console.log(`  gh release create v${newVersion} --title "v${newVersion}" --notes-from-tag`);
