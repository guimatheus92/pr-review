import { loadAll } from '../plugins/loader.js';
import { loadConfig } from '../config.js';
import { detectCompanions, formatWarning, KNOWN_COMPANIONS } from '../plugins/companions.js';

export async function pluginsList(opts: { reviewersDir?: string[]; skillsDir?: string[] } = {}): Promise<void> {
  const { config } = loadConfig({
    cliOverrides: { reviewersDirs: opts.reviewersDir, skillsDirs: opts.skillsDir },
  });
  const set = loadAll({ cwd: process.cwd(), config });
  console.log(`Reviewers (${set.reviewers.length}):`);
  for (const r of set.reviewers) {
    console.log(`  - ${r.name}${r.isBuiltIn ? ' (built-in)' : ''}  model=${r.model}  source=${r.source}`);
  }
  console.log(`\nSkills (${set.skills.length}):`);
  for (const s of set.skills) {
    const inject = s.injectInto?.length ? ` inject_into=${s.injectInto.join(',')}` : '';
    console.log(`  - ${s.name}  applies_to=${JSON.stringify(s.appliesTo)}${inject}  source=${s.source}`);
  }
}

export async function pluginsDoctor(copilotBinary = 'copilot'): Promise<void> {
  console.log('Checking companion plugins…');
  const state = await detectCompanions(copilotBinary);
  console.log(`\nInstalled plugins (from \`${copilotBinary} plugin list\`):`);
  if (state.installed.length === 0) {
    console.log('  (none detected)');
  } else {
    for (const p of state.installed) console.log(`  - ${p}`);
  }
  console.log('\nCompanion plugins:');
  for (const c of KNOWN_COMPANIONS) {
    const ok = state.installed.includes(c.id);
    console.log(`  ${ok ? '✓' : '✗'} ${c.id} — ${c.description}`);
  }
  if (state.missing.length > 0) {
    console.log('\nTo install missing companions:');
    console.log(formatWarning(state.missing));
  }
}
