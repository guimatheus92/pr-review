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

test('partitionTrustedProjectSkills — a SKILL.md is untrusted when the PR changed a file beside it', () => {
  // Live regression (Preco-Pratico/PrecoPratico-Docs#269): the PR changed
  // `.claude/skills/backend-guide/create-database.md` and left SKILL.md alone.
  // Only SKILL.md loads as a skill, but every pass is handed a `Source:` line
  // saying relative references resolve from its directory — so the branch-authored
  // sibling was reachable review input while the rule still injected as authoritative.
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