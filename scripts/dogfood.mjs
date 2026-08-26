import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherFromPatch } from './gather-from-patch.mjs';
import { buildBundle } from './bundle.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli.cjs');
const REVIEWABLE_UNTRACKED_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.diff', '.fs', '.go', '.graphql', '.h', '.hpp',
  '.html', '.java', '.js', '.json', '.jsx', '.kt', '.kts', '.m', '.md', '.mjs', '.mts',
  '.patch', '.php', '.ps1', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.swift', '.toml', '.ts',
  '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);
const CONFIG_LIKE_EXTENSIONS = new Set(['.json', '.toml', '.xml', '.yaml', '.yml']);
const SENSITIVE_KEY = /(?:password|passwd|pwd|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|account[_-]?key|shared[_-]?access[_-]?key|connection[_-]?string|credential)/i;
const HIGH_CONFIDENCE_SECRET_PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI token', /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{24,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['Azure DevOps PAT', /\b[A-Za-z0-9]{75}AZDO[A-Za-z0-9]{5}\b/],
];
const LEGACY_AZURE_DEVOPS_PAT = /\b[A-Za-z0-9]{52}\b/;

function fileExtension(path) {
  const suffix = path.split('.').at(-1) ?? '';
  return path.includes('.') ? `.${suffix.toLowerCase()}` : '';
}

function binaryNewFilePatch(path) {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    `Binary files /dev/null and b/${path} differ`,
  ].join('\n');
}

export function safeDiagnosticValue(value) {
  return JSON.stringify(String(value ?? ''));
}

function hasMaterialSecret(value) {
  if (typeof value !== 'string') return value !== null && value !== undefined && value !== false;
  const normalized = value.trim().replace(/^['"]|['"]$/g, '').trim();
  if (!normalized) return false;
  return !/^(?:null|none|redacted|placeholder|changeme|change-me|example|sample|dummy|test|todo|\*+|x+|your[ _-].*|<[^>]+>|\$\{[^}]+\}|%[^%]+%|process\.env\..*|@Microsoft\.KeyVault\(.*\))$/i.test(normalized);
}

function sensitiveJsonValue(value, path = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = sensitiveJsonValue(value[index], [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && hasMaterialSecret(child)) return [...path, key].join('.');
    const found = sensitiveJsonValue(child, [...path, key]);
    if (found) return found;
  }
  return null;
}

export function sensitiveUntrackedContent(path, content) {
  for (const [label, pattern] of HIGH_CONFIDENCE_SECRET_PATTERNS) {
    if (pattern.test(content)) return label;
  }

  for (const line of content.split(/\r?\n/)) {
    if (/\b(?:azure\s*devops|azdo|ado)?\s*(?:pat|personal[_ -]?access[_ -]?token)\b/i.test(line) && LEGACY_AZURE_DEVOPS_PAT.test(line)) {
      return 'legacy Azure DevOps PAT';
    }
  }

  const extension = fileExtension(path);
  if (extension === '.json') {
    try {
      const key = sensitiveJsonValue(JSON.parse(content));
      if (key) return `sensitive setting ${key}`;
    } catch {
      // Invalid or commented JSON still receives the line-oriented checks below.
    }
  }

  const connectionSecret = content.match(/(?:^|;)\s*(Password|Pwd|AccountKey|SharedAccessKey|ClientSecret)\s*=\s*([^;\r\n]+)/im);
  if (connectionSecret && hasMaterialSecret(connectionSecret[2])) return `connection-string ${connectionSecret[1]}`;

  for (const line of content.split(/\r?\n/)) {
    const declaration = line.match(
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$.-]*)(?:\s*:\s*[^=]+)?\s*=\s*(.+?)\s*;?\s*$/,
    );
    if (declaration && SENSITIVE_KEY.test(declaration[1]) && hasMaterialSecret(declaration[2])) {
      return `sensitive setting ${declaration[1]}`;
    }
    const setting = line.match(/^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*(.+?)\s*[,;]?\s*$/);
    if (setting && SENSITIVE_KEY.test(setting[1]) && hasMaterialSecret(setting[2])) {
      return `sensitive setting ${setting[1]}`;
    }
    if (!CONFIG_LIKE_EXTENSIONS.has(extension)) continue;
    const xml = line.match(/<([A-Za-z0-9_.-]+)>\s*([^<]+)\s*<\/\1>/);
    if (xml && SENSITIVE_KEY.test(xml[1]) && hasMaterialSecret(xml[2])) return `sensitive setting ${xml[1]}`;
  }
  return null;
}

export function sensitiveTrackedPatch(patch) {
  if (!patch) return null;
  const gather = gatherFromPatch(patch);
  for (const file of gather.changedFiles) {
    for (const path of [file.previousPath, file.path]) {
      if (path && sensitiveUntrackedPath(path)) return { path, reason: 'secret-bearing path' };
    }
    if (file.path === 'dist/cli.cjs') continue;
    let inHunk = false;
    const persistedLines = [];
    for (const line of (file.patch ?? '').split('\n')) {
      if (line.startsWith('@@')) {
        inHunk = true;
        continue;
      }
      if (!inHunk || line === '\\ No newline at end of file') continue;
      if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) persistedLines.push(line.slice(1));
    }
    const reason = sensitiveUntrackedContent(file.path, persistedLines.join('\n'));
    if (reason) return { path: file.path, reason };
  }
  return null;
}

function git(args, cwd = ROOT, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', ...options }).trim();
}

export function ensureBundleFresh(root = ROOT) {
  const bundle = join(root, 'dist', 'cli.cjs');
  if (!existsSync(bundle)) {
    throw new Error('dist/cli.cjs is missing; run `npm run build` before dogfood');
  }
  const temp = mkdtempSync(join(tmpdir(), 'pr-review-bundle-check-'));
  try {
    const expected = buildBundle(root, join(temp, 'cli.cjs'), 'silent');
    if (!readFileSync(bundle).equals(readFileSync(expected))) {
      throw new Error('dist/cli.cjs does not match the current source; run `npm run build` before dogfood');
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function newFilePatch(root, path) {
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('untracked path contains control characters and cannot be dogfooded');
  }
  const absolute = resolve(root, path);
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`untracked non-regular file cannot be dogfooded: ${path}`);
  const realRoot = realpathSync(root);
  const realFile = realpathSync(absolute);
  const rel = relative(realRoot, realFile);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
    throw new Error(`untracked file resolves outside the repository: ${path}`);
  }
  const content = readFileSync(absolute);
  const suffix = path.split('.').at(-1) ?? '';
  const extension = path.includes('.') ? `.${suffix.toLowerCase()}` : '';
  let normalized;
  try {
    normalized = new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/\r\n/g, '\n');
  } catch {
    return binaryNewFilePatch(path);
  }
  const sensitiveContent = sensitiveUntrackedContent(path, normalized);
  if (sensitiveContent) {
    throw new Error(`refusing secret-bearing untracked content (${sensitiveContent}; path redacted)`);
  }
  if (!REVIEWABLE_UNTRACKED_EXTENSIONS.has(extension) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(normalized)) {
    return binaryNewFilePatch(path);
  }
  if (content.length === 0) {
    return [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${path}`,
    ].join('\n');
  }
  const hasFinalNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (hasFinalNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    ...(!hasFinalNewline && lines.length > 0 ? ['\\ No newline at end of file'] : []),
  ].join('\n');
}

function sensitiveUntrackedPath(path) {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.split('/').at(-1) ?? '';
  return (
    /^\.env(?:\.|$)/i.test(base) ||
    /^\.(?:npmrc|pypirc|netrc)$/i.test(base) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|kubeconfig)$/i.test(base) ||
    /\.(?:pem|key|pfx|p12|jks|keystore)$/i.test(base) ||
    /(?:^|[/_.-])(?:credentials?|secrets?|tokens?|passwords?|private[-_]?keys?)(?:[/_.-]|$)/i.test(normalized)
  );
}

export function collectBranchDiff(baseRef = 'origin/main', cwd = ROOT, includeUntracked = false) {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  const branch = git(['branch', '--show-current'], root);
  if (!branch || branch === 'main' || branch === 'master') {
    throw new Error('dogfood requires a feature branch; refusing to review the default branch');
  }
  const baseSha = git(['merge-base', 'HEAD', baseRef], root);
  const headSha = git(['rev-parse', 'HEAD'], root);
  const tracked = execFileSync('git', ['diff', '--binary', '--no-ext-diff', baseSha, '--'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }).trimEnd();
  const trackedSecret = sensitiveTrackedPatch(tracked);
  if (trackedSecret) {
    throw new Error(`refusing secret-bearing tracked diff (${trackedSecret.reason}; path redacted)`);
  }
  const untracked = includeUntracked
    ? execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean)
        .map((path) => relative(root, resolve(root, path)).replace(/\\/g, '/'))
    : [];
  const sensitive = untracked.filter(sensitiveUntrackedPath);
  if (sensitive.length > 0) {
    throw new Error(`refusing ${sensitive.length} secret-bearing untracked file(s); paths redacted`);
  }
  const patches = [tracked, ...untracked.map((path) => newFilePatch(root, path))].filter(Boolean);
  if (patches.length === 0) throw new Error(`no changes found between ${baseRef} and the working tree`);
  return { baseRef, baseSha, branch, headSha, patchText: patches.join('\n') + '\n' };
}

export function parseDogfoodArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true, baseRef: 'origin/main', includeUntracked: false, extra: [] };
  }
  const forbidden = ['--detach', '--resume', '--run-dir', '--from-gather', '--force-post'];
  const blocked = argv.find((arg) => forbidden.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
  if (blocked) throw new Error(`${blocked} is controlled by dogfood and cannot be overridden`);
  const baseIndex = argv.indexOf('--base');
  const includeUntracked = argv.includes('--include-untracked');
  const baseRef = baseIndex >= 0 ? argv[baseIndex + 1] : 'origin/main';
  if (!baseRef || baseRef.startsWith('--')) throw new Error('--base requires a git ref');
  const extra = argv.filter(
    (arg, index) =>
      arg !== '--include-untracked' &&
      (baseIndex < 0 || (index !== baseIndex && index !== baseIndex + 1)),
  );
  return { help: false, baseRef, includeUntracked, extra };
}

export function githubRepoFromRemote(remote) {
  const cleaned = remote.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  let host;
  let path;
  try {
    const parsed = new URL(cleaned);
    host = parsed.hostname;
    path = parsed.pathname;
  } catch {
    const scp = cleaned.match(/^[^@]+@([^:]+):(.+)$/);
    if (!scp) throw new Error('unsupported git remote format (expected github.com HTTPS or SSH)');
    host = scp[1];
    path = scp[2];
  }
  const segments = path.split('/').filter(Boolean);
  if (host.toLowerCase() !== 'github.com') {
    throw new Error(`dogfood currently supports github.com origins only (got ${host})`);
  }
  if (segments.length < 2) throw new Error('git remote does not identify an owner/repository');
  const repo = segments.at(-1);
  const owner = segments.slice(0, -1).join('/');
  return {
    provider: 'github',
    owner,
    repo,
    number: 1,
    url: `https://${host}/${owner}/${repo}/pull/1`,
  };
}

export function applyDogfoodExclusions(gather) {
  for (const file of gather.changedFiles) {
    if (file.path === 'dist/cli.cjs') {
      file.excluded = true;
      file.excludedReason = 'generated bundle; source reviewed and bundle validated by npm run build';
    } else if (
      !/^@@/m.test(file.patch ?? '') &&
      (/^GIT binary patch$/m.test(file.patch ?? '') || /^Binary files .* differ$/m.test(file.patch ?? ''))
    ) {
      file.excluded = true;
      file.excludedReason = 'binary file has no reviewable text diff';
    }
  }
  return gather;
}

function printHelp() {
  process.stdout.write(
    'Usage: npm run dogfood -- [--base <git-ref>] [review flags]\n' +
    'Add --include-untracked to review non-ignored untracked files (secret-bearing names and contents are refused).\n' +
    'Reviews the current feature branch locally with --from-gather --dry-run --no-companions.\n',
  );
}

function main() {
  const { help, baseRef, includeUntracked, extra } = parseDogfoodArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }
  ensureBundleFresh();
  const branchDiff = collectBranchDiff(baseRef, ROOT, includeUntracked);
  const repoRef = githubRepoFromRemote(git(['remote', 'get-url', 'origin']));
  const runsRoot = join(homedir(), '.pr-review', 'runs');
  mkdirSync(runsRoot, { recursive: true });
  const safeBranch = branchDiff.branch.replace(/[^a-z0-9._-]+/gi, '_');
  const safeOwner = repoRef.owner.replace(/[^a-z0-9._-]+/gi, '_');
  const safeRepo = repoRef.repo.replace(/[^a-z0-9._-]+/gi, '_');
  const runDir = mkdtempSync(join(runsRoot, `local__${safeOwner}__${safeRepo}__${safeBranch}__`));
  const gatherPath = join(runDir, 'dogfood-gather.json');
  const gather = applyDogfoodExclusions(gatherFromPatch(branchDiff.patchText, {
    pr: repoRef,
    title: `Dogfood ${branchDiff.branch}`,
    description: `Local dry-run review of ${branchDiff.branch} against ${branchDiff.baseRef}.`,
    author: 'local-dogfood',
    headSha: branchDiff.headSha,
    baseSha: branchDiff.baseSha,
    baseBranch: basename(branchDiff.baseRef),
    headBranch: branchDiff.branch,
  }));
  writeFileSync(gatherPath, JSON.stringify(gather, null, 2), 'utf8');
  process.stdout.write(`dogfood run dir: ${runDir}\n`);
  try {
    execFileSync(
      process.execPath,
      [
        CLI,
        'review',
        repoRef.url,
        '--from-gather',
        gatherPath,
        '--dry-run',
        '--no-cache',
        '--no-companions',
        '--run-dir',
        runDir,
        ...extra,
      ],
      { cwd: ROOT, stdio: 'inherit' },
    );
  } catch (error) {
    process.exitCode = typeof error.status === 'number' ? error.status : 1;
  }
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`dogfood: ${safeDiagnosticValue(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
  }
}