import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partitionTrustedProjectSkills, skillsAllowedForCheckout } from '../src/plugins/trust.js';
import type { SkillDefinition } from '../src/types.js';

function skill(name: string, source: string, origin: SkillDefinition['origin'] = 'repo'): SkillDefinition {
  return { name, source, origin, description: name, body: name, appliesTo: ['src/**'] };
}

test('partitionTrustedProjectSkills — changed in-repo explicit rules are skipped unless forced', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-trust-'));
  try {
    mkdirSync(join(cwd, '.github', 'instructions'), { recursive: true });
    const unchanged = skill('unchanged', join(cwd, '.github', 'instructions', 'unchanged.instructions.md'));
    const changed = skill('changed', join(cwd, '.github', 'instructions', 'changed.instructions.md'));
    const explicit = skill('explicit', join(cwd, '.github', 'instructions', 'explicit.md'), 'explicit');
    const forced = skill('forced', join(cwd, '.github', 'instructions', 'forced.md'), 'forced');
    for (const entry of [unchanged, changed, explicit, forced]) writeFileSync(entry.source, entry.body);
    const result = partitionTrustedProjectSkills(
      [unchanged, changed, explicit, forced],
      cwd,
      ['.github/instructions/changed.instructions.md', '.github/instructions/explicit.md', '.github/instructions/forced.md'],
    );
    assert.deepEqual(result.trusted.map((entry) => entry.name), ['unchanged', 'forced']);
    assert.deepEqual(result.skipped.map((entry) => entry.name), ['changed', 'explicit']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('partitionTrustedProjectSkills — a repo rule resolving outside the checkout is skipped', (context) => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-trust-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'pr-review-trust-outside-'));
  try {
    mkdirSync(join(cwd, '.github', 'instructions'), { recursive: true });
    const target = join(outside, 'outside.md');
    const linkedDir = join(cwd, '.github', 'instructions', 'linked');
    const linked = join(linkedDir, 'outside.md');
    writeFileSync(target, 'outside');
    try {
      symlinkSync(outside, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
        context.skip(`file links unavailable: ${code}`);
        return;
      }
      throw error;
    }
    const result = partitionTrustedProjectSkills([skill('linked', linked)], cwd, []);
    assert.deepEqual(result.trusted, []);
    assert.deepEqual(result.skipped.map((entry) => entry.name), ['linked']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('skillsAllowedForCheckout — unrelated checkouts admit only explicit force overrides', () => {
  const skills = [
    skill('repo', 'repo.md', 'repo'),
    skill('explicit', 'explicit.md', 'explicit'),
    skill('configured', 'configured.md', 'plugin'),
    skill('forced', 'forced.md', 'forced'),
  ];
  assert.deepEqual(skillsAllowedForCheckout(skills, false).map((entry) => entry.name), ['forced']);
  assert.deepEqual(skillsAllowedForCheckout(skills, true), skills);
});