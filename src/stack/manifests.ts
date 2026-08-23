import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Dependency-manifest filenames we can read. Formats are stable; the knowledge inside them is the repo's. */
const NAME_RE = /^(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|go\.mod|gemfile|pom\.xml|composer\.json|cargo\.toml)$/i;
const EXT_RE = /\.(csproj|fsproj)$/i;

export function isManifest(basename: string): boolean {
  return NAME_RE.test(basename) || EXT_RE.test(basename);
}

// NOTE: no 'packages' here — JS monorepos keep first-party workspace manifests
// under packages/, and losing those loses every framework tag.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'bin', 'obj', 'vendor', 'dist', 'build', 'out',
  '.venv', 'venv', 'target', '__pycache__',
]);

// ponytail: ecosystem tags per manifest KIND — format knowledge (stable), not review
// knowledge. Needed so OWASP 'Nodejs'/'DotNet' sheets can tag-match: Linguist only
// yields 'node'/'csharp' from file extensions. Delete this and those sheets fall to
// the on-demand index instead of running as passes.
export function ecosystemTags(basename: string): string[] {
  const b = basename.toLowerCase();
  if (b === 'package.json') return ['node', 'nodejs', 'npm'];
  if (b.startsWith('requirements') || b === 'pyproject.toml') return ['python', 'pip'];
  if (b === 'go.mod') return ['go', 'golang'];
  if (EXT_RE.test(b)) return ['dotnet', 'nuget', 'csharp'];
  if (b === 'cargo.toml') return ['rust', 'cargo'];
  if (b === 'gemfile') return ['ruby', 'bundler'];
  if (b === 'pom.xml') return ['java', 'maven'];
  if (b === 'composer.json') return ['php', 'composer'];
  return [];
}

function jsonDeps(text: string, keys: string[]): string[] {
  const out: string[] = [];
  try {
    const doc = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>;
    for (const key of keys) {
      for (const dep of Object.keys(doc[key] ?? {})) {
        out.push(dep);
        // '@angular/core' → 'angular', composer 'laravel/framework' → 'laravel':
        // the vendor/scope half is the framework name.
        if (dep.includes('/')) out.push(dep.replace(/^@/, '').split('/')[0]!);
      }
    }
  } catch {
    // unparseable manifest → no tags from it
  }
  return out;
}

function matchAll(text: string, re: RegExp, group = 1): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) out.push(m[group]!);
  return out;
}

/** Keys of `[section]` blocks in a minimal TOML reading (Cargo, poetry). */
function tomlSectionKeys(text: string, sections: string[]): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  let inWanted = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inWanted = sections.includes(header[1]!.trim());
      continue;
    }
    if (!inWanted) continue;
    const kv = line.match(/^\s*([A-Za-z0-9_."'-]+)\s*=/);
    if (kv) out.push(kv[1]!.replace(/["']/g, ''));
  }
  return out;
}

/** Dependency names (lowercased, deduped) from one manifest's text. */
export function parseManifest(basename: string, text: string): string[] {
  const b = basename.toLowerCase();
  let names: string[] = [];
  if (b === 'package.json') {
    names = jsonDeps(text, ['dependencies', 'devDependencies']);
  } else if (b.startsWith('requirements')) {
    names = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'))
      .map((l) => l.match(/^([A-Za-z0-9_.-]+)/)?.[1] ?? '')
      .filter(Boolean);
  } else if (b === 'pyproject.toml') {
    const listDeps = matchAll(text, /^\s*dependencies\s*=\s*\[([^\]]*)\]/gms).flatMap((block) =>
      matchAll(block, /["']([A-Za-z0-9_.-]+)/g),
    );
    const poetry = tomlSectionKeys(text, ['tool.poetry.dependencies', 'tool.poetry.dev-dependencies']);
    names = [...listDeps, ...poetry].filter((n) => n.toLowerCase() !== 'python');
  } else if (b === 'go.mod') {
    const paths = matchAll(text, /^\s*([\w.~/-]+)\s+v[\w.+-]+/gm).filter((p) => p !== 'go' && p !== 'module');
    names = paths.flatMap((p) => [p, p.split('/').pop()!]);
  } else if (EXT_RE.test(b)) {
    names = matchAll(text, /<PackageReference\s+[^>]*Include\s*=\s*"([^"]+)"/gi);
  } else if (b === 'cargo.toml') {
    names = tomlSectionKeys(text, ['dependencies', 'dev-dependencies', 'build-dependencies']);
  } else if (b === 'gemfile') {
    names = matchAll(text, /^\s*gem\s+['"]([^'"]+)/gm);
  } else if (b === 'pom.xml') {
    names = matchAll(text, /<artifactId>([^<]+)<\/artifactId>/g);
  } else if (b === 'composer.json') {
    names = jsonDeps(text, ['require', 'require-dev']).filter((n) => n !== 'php' && !n.startsWith('ext-'));
  }
  return [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
}

/** Manifest files under cwd (root + maxDepth levels), skipping build/dependency dirs. */
export function findManifests(cwd: string, maxDepth = 2): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: { name: string; isDir: boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDir) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) {
          walk(join(dir, e.name), depth + 1);
        }
      } else if (isManifest(e.name)) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(cwd, 0);
  return out.sort();
}

export interface DependencyTags {
  dependencies: string[];
  ecosystems: string[];
  manifests: string[];
}

export function readDependencyTags(cwd: string): DependencyTags {
  const dependencies = new Set<string>();
  const ecosystems = new Set<string>();
  const manifests = findManifests(cwd);
  for (const file of manifests) {
    const base = file.replace(/\\/g, '/').split('/').pop()!;
    for (const t of ecosystemTags(base)) ecosystems.add(t);
    try {
      for (const dep of parseManifest(base, readFileSync(file, 'utf8'))) dependencies.add(dep);
    } catch {
      // unreadable manifest → skip
    }
  }
  return { dependencies: [...dependencies].sort(), ecosystems: [...ecosystems].sort(), manifests };
}
