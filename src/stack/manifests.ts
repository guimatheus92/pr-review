import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realpathCanonical } from '../util/realpath.js';

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

export function safeManifestDiagnostic(value: unknown): string {
  return JSON.stringify(String(value ?? ''));
}

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

const JSON_DEPENDENCY_SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

function braceDelta(text: string): number {
  return (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
}

/** Dependency names added inside a visible package.json dependency section in a unified diff. */
export function parseJsonDependencyPatch(patch: string): string[] {
  const dependencies = new Set<string>();
  const metadataKeys = new Set(['name', 'version', 'type', 'packageManager', 'description', 'license', 'main', 'module']);
  const dependencySpec = /^(?:[~^<>=*]?\d|workspace:|file:|link:|npm:|github:|git\+|https?:\/\/)/i;
  let sectionDepth = 0;
  let inDependencySection = false;
  for (const rawLine of patch.split('\n')) {
    if (/^(diff --git|index |@@|--- |\+\+\+ )/.test(rawLine) || rawLine.startsWith('-')) continue;
    const prefix = rawLine[0];
    const text = prefix === '+' || prefix === ' ' ? rawLine.slice(1) : rawLine;
    const section = text.match(/^\s*"([^"]+)"\s*:\s*\{/);
    if (section && JSON_DEPENDENCY_SECTIONS.has(section[1]!)) {
      inDependencySection = true;
      sectionDepth = braceDelta(text);
    }
    if (inDependencySection && prefix === '+') {
      for (const match of text.matchAll(/"(@?[a-z0-9][\w./-]*)"\s*:\s*"/gi)) {
        if (!JSON_DEPENDENCY_SECTIONS.has(match[1]!)) dependencies.add(match[1]!.toLowerCase());
      }
    } else if (!inDependencySection && prefix === '+') {
      const entry = text.match(/^\s*"(@?[a-z0-9][\w./-]*)"\s*:\s*"([^"]+)"\s*,?\s*$/i);
      if (entry && !metadataKeys.has(entry[1]!) && dependencySpec.test(entry[2]!)) {
        dependencies.add(entry[1]!.toLowerCase());
      }
    }
    if (inDependencySection && !section) sectionDepth += braceDelta(text);
    if (inDependencySection && sectionDepth <= 0) inDependencySection = false;
  }
  return [...dependencies];
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

function parseManifestNames(basename: string, text: string): string[] {
  const b = basename.toLowerCase();
  let names: string[] = [];
  if (b === 'package.json') {
    names = jsonDeps(text, [...JSON_DEPENDENCY_SECTIONS]);
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
    names = jsonDeps(text, ['require', 'require-dev']).filter((n) => n.toLowerCase() !== 'php' && !n.toLowerCase().startsWith('ext-'));
  }
  return names.map((name) => name.trim()).filter(Boolean);
}

/** Dependency names (lowercased, deduped) from one manifest's text. */
export function parseManifest(basename: string, text: string): string[] {
  const names = parseManifestNames(basename, text);
  return [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
}

export interface DependencyGroup {
  dependency: string;
  tokens: string[];
}

export function parseManifestDependencyGroups(basename: string, text: string): DependencyGroup[] {
  const groups = new Map<string, Set<string>>();
  for (const originalName of parseManifestNames(basename, text)) {
    const dependency = originalName.toLowerCase();
    const tokens = groups.get(dependency) ?? new Set<string>();
    for (const token of dependencyNameTokens(originalName)) tokens.add(token);
    groups.set(dependency, tokens);
  }
  return [...groups.entries()].map(([dependency, tokens]) => ({ dependency, tokens: [...tokens].sort() }));
}

/** Search tokens from a package name, preserving raw segments, CamelCase words, and useful initialisms. */
export function dependencyNameTokens(name: string): string[] {
  const raw = name.trim();
  if (!raw) return [];
  const rawSegments = raw.toLowerCase().split(/[^a-z0-9#+]+/).filter((token) => token.length >= 2);
  const expanded = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const words = expanded.toLowerCase().split(/[^a-z0-9#+]+/).filter((token) => token.length >= 2);
  const tokens = new Set([raw.toLowerCase(), ...rawSegments, ...words]);
  if (tokens.has('modelcontextprotocol')) tokens.add('mcp');
  return [...tokens];
}

export function parseManifestTokens(basename: string, text: string): string[] {
  return [...new Set(parseManifestNames(basename, text).flatMap(dependencyNameTokens))].sort();
}

/** Manifest files under cwd (root + maxDepth levels), skipping build/dependency dirs. */
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

export function findManifests(cwd: string, maxDepth = 2, warnings: string[] = []): string[] {
  let root: string;
  try {
    root = realpathCanonical(resolve(cwd));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') warnings.push(`could not resolve manifest root: ${safeManifestDiagnostic((error as Error).message)}`);
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let realDir: string;
    try {
      realDir = realpathCanonical(dir);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        warnings.push(`could not resolve manifest directory ${safeManifestDiagnostic(dir)}: ${safeManifestDiagnostic((error as Error).message)}`);
      }
      return;
    }
    if (!isWithin(root, realDir)) return;
    let entries: { name: string; isDir: boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        warnings.push(`could not read manifest directory ${safeManifestDiagnostic(realDir)}: ${safeManifestDiagnostic((error as Error).message)}`);
      }
      return;
    }
    for (const e of entries) {
      if (e.isDir) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) {
          walk(join(dir, e.name), depth + 1);
        }
      } else if (isManifest(e.name)) {
        const safe = safeManifestPath(root, join(realDir, e.name));
        if (safe) out.push(safe);
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeManifestPath(root: string, candidate: string): string | null {
  try {
    const lexical = resolve(candidate);
    if (!isWithin(root, lexical)) return null;
    const stats = lstatSync(lexical);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    const real = realpathCanonical(lexical);
    return isWithin(root, real) ? real : null;
  } catch {
    return null;
  }
}

/** Manifests that own changed files, even when they live below the shallow monorepo scan. */
export function findChangedFileManifests(cwd: string, changedPaths: string[], warnings: string[] = []): string[] {
  let root: string;
  try {
    root = realpathCanonical(resolve(cwd));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') warnings.push(`could not resolve manifest root: ${safeManifestDiagnostic((error as Error).message)}`);
    return [];
  }
  const manifests = new Set<string>();
  const visitedDirs = new Set<string>();

  for (const changedPath of changedPaths) {
    const full = resolve(root, changedPath);
    if (!isWithin(root, full)) continue;
    if (isManifest(basename(full)) && existsSync(full)) {
      const safe = safeManifestPath(root, full);
      if (safe) manifests.add(safe);
    }

    let dir = dirname(full);
    while (isWithin(root, dir)) {
      let realDir: string;
      try {
        realDir = realpathCanonical(dir);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          warnings.push(
            `could not resolve changed-file directory ${safeManifestDiagnostic(dir)}: ${safeManifestDiagnostic((error as Error).message)}`,
          );
        }
        if (dir === root) break;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
        continue;
      }
      if (!isWithin(root, realDir)) break;
      if (!visitedDirs.has(realDir)) {
        visitedDirs.add(realDir);
        try {
          for (const entry of readdirSync(realDir, { withFileTypes: true })) {
            if (!entry.isFile() || !isManifest(entry.name)) continue;
            const safe = safeManifestPath(root, join(realDir, entry.name));
            if (safe) manifests.add(safe);
          }
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') {
            warnings.push(
              `could not read changed-file directory ${safeManifestDiagnostic(realDir)}: ${safeManifestDiagnostic((error as Error).message)}`,
            );
          }
        }
      }
      if (dir === root) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return [...manifests].sort();
}

export interface DependencyTags {
  dependencies: string[];
  tokens: string[];
  ecosystems: string[];
  manifests: string[];
  warnings: string[];
  groups: DependencyGroup[];
}

export function readDependencyTags(cwd: string, changedPaths: string[] = []): DependencyTags {
  const dependencies = new Set<string>();
  const tokens = new Set<string>();
  const ecosystems = new Set<string>();
  const warnings: string[] = [];
  const groups = new Map<string, Set<string>>();
  let root: string;
  try {
    root = realpathCanonical(resolve(cwd));
  } catch {
    return { dependencies: [], tokens: [], ecosystems: [], manifests: [], warnings: ['could not resolve manifest root'], groups: [] };
  }
  const candidates = [...new Set([...findManifests(root, 2, warnings), ...findChangedFileManifests(root, changedPaths, warnings)])].sort();
  const manifests: string[] = [];
  for (const file of candidates) {
    const safeFile = safeManifestPath(root, file);
    if (!safeFile) continue;
    manifests.push(safeFile);
    const base = safeFile.replace(/\\/g, '/').split('/').pop()!;
    for (const t of ecosystemTags(base)) ecosystems.add(t);
    try {
      const text = readFileSync(safeFile, 'utf8');
      for (const dep of parseManifest(base, text)) dependencies.add(dep);
      for (const token of parseManifestTokens(base, text)) tokens.add(token);
      for (const group of parseManifestDependencyGroups(base, text)) {
        const existing = groups.get(group.dependency) ?? new Set<string>();
        for (const token of group.tokens) existing.add(token);
        groups.set(group.dependency, existing);
      }
    } catch (error) {
      warnings.push(
        `could not read manifest ${safeManifestDiagnostic(relative(root, safeFile))}: ${safeManifestDiagnostic((error as Error).message)}`,
      );
    }
  }
  return {
    dependencies: [...dependencies].sort(),
    tokens: [...tokens].sort(),
    ecosystems: [...ecosystems].sort(),
    manifests,
    warnings,
    groups: [...groups.entries()].map(([dependency, groupTokens]) => ({
      dependency,
      tokens: [...groupTokens].sort(),
    })),
  };
}
