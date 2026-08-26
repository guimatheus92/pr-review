import { execFileSync } from 'node:child_process';
import { binaryOnPath, normalizeModel, resolveRuntime, type Runtime } from '../dispatch/runtime.js';
import { detectCodex } from '../dispatch/codex.js';
import { companionDispatchCount, detectCompanions, KNOWN_COMPANIONS } from '../plugins/companions.js';
import { loadConfig } from '../config.js';

function ok(label: string, detail = ''): void {
  process.stdout.write(`  ✓ ${label}${detail ? ` — ${detail}` : ''}\n`);
}
function bad(label: string, hint = ''): void {
  process.stdout.write(`  ✗ ${label}${hint ? ` — ${hint}` : ''}\n`);
}

function ghAuthOk(): boolean {
  try {
    // No shell: gh ships as gh.exe on Windows (not a .cmd shim), and
    // shell+args-array trips DEP0190 — same shape as resolveToken in github.ts.
    execFileSync('gh', ['auth', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/** Environment preflight: what a review run would resolve, and what's missing. Exit 1 only when no runtime exists. */
export async function runDoctor(): Promise<number> {
  const { config, sources } = loadConfig();

  process.stdout.write('Runtimes\n');
  const copilot = binaryOnPath('copilot');
  const claude = binaryOnPath('claude');
  (copilot ? ok : bad)('copilot on PATH', copilot ? '' : 'install: https://docs.github.com/copilot/copilot-cli');
  (claude ? ok : bad)('claude on PATH', claude ? '' : 'install: https://claude.com/claude-code');
  let runtime: Runtime | null = null;
  try {
    runtime = resolveRuntime(config.runtime);
    ok(`resolved runtime: ${runtime}`, `config runtime=${config.runtime}; model=${normalizeModel(runtime, config.defaultModel)}`);
  } catch (err) {
    bad('no usable runtime', (err as Error).message.split('\n')[0]);
  }

  process.stdout.write('Reviewers\n');
  const codex = await detectCodex();
  (codex ? ok : bad)(
    'codex CLI (optional second opinion)',
    codex ? (config.invokeCodex ? 'will run' : 'installed but disabled (invoke_codex: false)') : 'not installed — skipped automatically',
  );
  if (runtime) {
    const companions = await detectCompanions('copilot', runtime);
    if (companions.detectionError) {
      bad('companion detection', companions.detectionError);
    } else {
      for (const c of KNOWN_COMPANIONS) {
        const installed = companions.installed.includes(c.id);
        (installed ? ok : bad)(
          `companion ${c.id}`,
          installed ? `${companionDispatchCount([c.id])} dispatch(es)` : c.installSlash,
        );
      }
    }
  }

  process.stdout.write('Provider auth\n');
  const ghEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.COPILOT_GITHUB_TOKEN;
  const gh = Boolean(ghEnv) || ghAuthOk();
  (gh ? ok : bad)('GitHub', gh ? (ghEnv ? 'token env var' : 'gh auth token') : 'set GITHUB_TOKEN or run `gh auth login`');
  const adoPat = process.env.AZURE_DEVOPS_PAT ?? process.env.SYSTEM_ACCESSTOKEN ?? process.env.AZURE_DEVOPS_EXT_PAT;
  const az = binaryOnPath('az');
  (adoPat || az ? ok : bad)(
    'Azure DevOps',
    adoPat ? 'PAT env var' : az ? 'az CLI available for bearer token' : 'set AZURE_DEVOPS_PAT or install az (only needed for ADO PRs)',
  );

  process.stdout.write('Skill packs\n');
  const { existsSync } = await import('node:fs');
  const { gitAvailable, packStatus, STALE_DAYS } = await import('../packs/sync.js');
  const { listPackFiles } = await import('../packs/load.js');
  const { linguistCachePath } = await import('../stack/linguist.js');
  const { maskUrl } = await import('../stack/detect.js');
  (gitAvailable() ? ok : bad)('git on PATH', gitAvailable() ? '' : 'install git — packs cannot clone/sync without it');
  if (config.skillPacks.length === 0) {
    ok('skill_packs: [] — packs disabled (review passes come from repo skills only)');
  }
  for (const pack of config.skillPacks) {
    const st = packStatus(pack);
    if (!st.exists) {
      bad(`pack ${pack.name}`, `not cloned (${maskUrl(pack.git)}) — clones on the next review, or run \`pr-review packs sync\``);
      continue;
    }
    const n = listPackFiles(st.dir, pack.include, pack.exclude).length;
    const age = st.ageDays === null ? 'never synced' : `synced ${Math.floor(st.ageDays)}d ago`;
    const stale = st.ageDays === null || st.ageDays > STALE_DAYS;
    (stale ? bad : ok)(
      `pack ${pack.name}${pack.mode === 'index' ? ' (index-only)' : ''}`,
      `${n} skill(s), ${st.meta?.commit?.slice(0, 7) ?? '?'}, ${age}${stale ? ' — run `pr-review packs sync`' : ''}`,
    );
  }
  (existsSync(linguistCachePath()) ? ok : bad)(
    'Linguist languages.yml cache',
    existsSync(linguistCachePath()) ? '' : 'downloads on first review or `pr-review packs sync`',
  );

  process.stdout.write('Config\n');
  ok(`language=${config.language}, dedupe=${config.dedupeMode}, autodiscover=${config.autodiscover}`);
  for (const [k, v] of Object.entries(sources)) {
    if (k === 'defaults' || k === 'env') continue;
    ok(`config source: ${k}`, String(v));
  }

  return runtime ? 0 : 1;
}
