import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partitionTrustedProjectSkills, skillDirPrefix, skillsAllowedForCheckout } from '../src/plugins/trust.js';
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

test('partitionTrustedProjectSkills — a SKILL.md is untrusted when the PR changed a file beside it', () => {
  // Live regression (Preco-Pratico/PrecoPratico-Docs#269): the PR changed
  // `.claude/skills/backend-guide/create-database.md` and left SKILL.md alone.
  // The skill directory is the trust unit: changing branch-authored content
  // beside SKILL.md makes that owning skill untrusted even though only SKILL.md loads.
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-trust-dir-'));
  try {
    const guide = join(cwd, '.claude', 'skills', 'backend-guide');
    const untouched = join(cwd, '.claude', 'skills', 'frontend-guide');
    mkdirSync(guide, { recursive: true });
    mkdirSync(untouched, { recursive: true });
    mkdirSync(join(cwd, '.claude', 'rules'), { recursive: true });
    const owning = skill('backend-guide', join(guide, 'SKILL.md'));
    const sibling = skill('frontend-guide', join(untouched, 'SKILL.md'));
    // A flat rule shares its directory with unrelated rules — the file stays the unit.
    const flatChanged = skill('flat-changed', join(cwd, '.claude', 'rules', 'flat-changed.md'));
    const flatUntouched = skill('flat-untouched', join(cwd, '.claude', 'rules', 'flat-untouched.md'));
    for (const entry of [owning, sibling, flatChanged, flatUntouched]) writeFileSync(entry.source, entry.body);
    writeFileSync(join(guide, 'create-database.md'), 'branch-authored reference');

    const result = partitionTrustedProjectSkills(
      [owning, sibling, flatChanged, flatUntouched],
      cwd,
      ['.claude/skills/backend-guide/create-database.md', '.claude/rules/flat-changed.md'],
    );
    assert.deepEqual(result.skipped.map((entry) => entry.name), ['backend-guide', 'flat-changed']);
    assert.deepEqual(result.trusted.map((entry) => entry.name), ['frontend-guide', 'flat-untouched']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('skillDirPrefix — recognizes SKILL.md in the casing every non-Windows host preserves', () => {
  // normalizedRelative() lowercases only on win32, so a case-SENSITIVE test here matched
  // nothing on Linux/macOS and silently turned the directory trust gate into dead code.
  // Asserting both casings directly keeps that regression detectable on any platform.
  assert.equal(skillDirPrefix('.claude/skills/backend-guide/SKILL.md'), '.claude/skills/backend-guide/');
  assert.equal(skillDirPrefix('.claude/skills/backend-guide/skill.md'), '.claude/skills/backend-guide/');
  assert.equal(skillDirPrefix('.claude/rules/flat.md'), null, 'a flat rule does not own its directory');
  assert.equal(skillDirPrefix('SKILL.md'), null, 'a repo-root SKILL.md would own the whole checkout');
  assert.equal(skillDirPrefix(null), null);
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