import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadSkillFile, printable } from './builtin.js';
import type { SkillDefinition } from '../types.js';

interface InstalledPluginManifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  skills?: unknown;
  mcpServers?: unknown;
}

export interface InstalledPlugin {
  id: string;
  version?: string;
  description?: string;
  root: string;
  skills: SkillDefinition[];
  mcpServers: string[];
}

export interface McpCapability {
  name: string;
  source: 'repo' | 'user' | `plugin:${string}`;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (error) {
    process.stderr.write(`[plugins] warning: could not parse ${printable(path)} (${printable((error as Error).message.split('\n')[0] ?? '')})\n`);
    return null;
  }
}

function serverNames(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

function skillFiles(root: string, manifest: InstalledPluginManifest): string[] {
  const resolvedRoot = resolve(root);
  const realRoot = realpathSync(resolvedRoot);
  const insideRoot = (path: string, boundary: string): boolean => {
    const rel = relative(boundary, path);
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel));
  };
  const declared = Array.isArray(manifest.skills) ? manifest.skills.filter((entry): entry is string => typeof entry === 'string') : [];
  const candidates = declared.length > 0
    ? declared.map((entry) => resolve(resolvedRoot, entry))
    : [join(resolvedRoot, 'skills')];
  const files: string[] = [];
  const visit = (candidate: string): void => {
    if (!existsSync(candidate)) return;
    let entries;
    try {
      entries = readdirSync(candidate, { withFileTypes: true });
    } catch {
      if (candidate.toLowerCase().endsWith('.md')) files.push(candidate);
      return;
    }
    const direct = join(candidate, 'SKILL.md');
    if (existsSync(direct)) {
      files.push(direct);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      visit(join(candidate, entry.name));
    }
  };
  for (const candidate of candidates) {
    if (!insideRoot(candidate, resolvedRoot) || !existsSync(candidate)) continue;
    let realCandidate: string;
    try {
      realCandidate = realpathSync(candidate);
    } catch {
      continue;
    }
    if (insideRoot(realCandidate, realRoot)) visit(candidate);
  }
  return [...new Set(files.map((file) => {
    try {
      return realpathSync(file);
    } catch {
      return resolve(file);
    }
  }).filter((file) => insideRoot(file, realRoot)))].sort();
}

function pluginRoots(base: string): string[] {
  if (!existsSync(base)) return [];
  const roots: string[] = [];
  for (const marketplace of readdirSync(base, { withFileTypes: true })) {
    if (!marketplace.isDirectory()) continue;
    const marketplaceDir = join(base, marketplace.name);
    for (const plugin of readdirSync(marketplaceDir, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      const root = join(marketplaceDir, plugin.name);
      if (existsSync(join(root, '.claude-plugin', 'plugin.json'))) roots.push(root);
    }
  }
  return roots.sort();
}

export function discoverInstalledPlugins(home = homedir()): InstalledPlugin[] {
  const plugins = new Map<string, InstalledPlugin>();
  for (const root of pluginRoots(join(home, '.copilot', 'installed-plugins'))) {
    const manifestPath = join(root, '.claude-plugin', 'plugin.json');
    const raw = readJson(manifestPath) as InstalledPluginManifest | null;
    if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) continue;
    const id = raw.name.trim();
    if (id === 'pr-review') continue;
    const pluginMcp = new Set(serverNames(raw.mcpServers));
    const mcpPath = join(root, '.mcp.json');
    const mcpFile = existsSync(mcpPath) ? readJson(mcpPath) : null;
    for (const name of serverNames(mcpFile?.mcpServers)) pluginMcp.add(name);
    const mcpServers = [...pluginMcp].sort();
    const skills = skillFiles(root, raw).map((file) => {
      const skill = loadSkillFile(file);
      return {
        ...skill,
        name: `${id}/${skill.name}`,
        origin: 'plugin' as const,
        plugin: id,
        mcpServers,
      };
    });
    const discovered: InstalledPlugin = {
      id,
      version: typeof raw.version === 'string' ? raw.version : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      root,
      skills,
      mcpServers,
    };
    const existing = plugins.get(id);
    if (!existing) {
      plugins.set(id, discovered);
      continue;
    }
    const mergedSkills = new Map(existing.skills.map((skill) => [skill.name, skill]));
    for (const skill of discovered.skills) if (!mergedSkills.has(skill.name)) mergedSkills.set(skill.name, skill);
    plugins.set(id, {
      ...existing,
      skills: [...mergedSkills.values()].sort((left, right) => left.name.localeCompare(right.name)),
      mcpServers: [...new Set([...existing.mcpServers, ...discovered.mcpServers])].sort(),
    });
  }
  return [...plugins.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function readMcpFile(path: string, source: McpCapability['source']): McpCapability[] {
  return Object.keys(readMcpServers(path)).map((name) => ({ name, source }));
}

function readMcpServers(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = readJson(path);
  const legacy = parsed?.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers)
    ? parsed.servers as Record<string, unknown>
    : {};
  const canonical = parsed?.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
    ? parsed.mcpServers as Record<string, unknown>
    : {};
  return { ...legacy, ...canonical };
}

export function discoverMcpCapabilities(opts: {
  repoRoot?: string;
  home?: string;
  plugins: InstalledPlugin[];
  changedPaths?: string[];
}): { servers: McpCapability[]; trustedRepoConfig?: { mcpServers: Record<string, unknown> }; warnings: string[] } {
  const home = opts.home ?? homedir();
  const warnings: string[] = [];
  const changed = new Set((opts.changedPaths ?? []).map((path) => path.replace(/\\/g, '/').toLowerCase()));
  const repoMcpChanged = changed.has('.mcp.json') || changed.has('.vscode/mcp.json');
  const servers: McpCapability[] = [];
  let trustedRepoConfig: { mcpServers: Record<string, unknown> } | undefined;
  if (opts.repoRoot && repoMcpChanged) {
    warnings.push('repository MCP configuration changed by this PR — ignored as untrusted');
  } else if (opts.repoRoot) {
    const repoConfig = join(opts.repoRoot, '.mcp.json');
    const vscodeConfig = join(opts.repoRoot, '.vscode', 'mcp.json');
    const rootServers = readMcpServers(repoConfig);
    const vscodeServers = readMcpServers(vscodeConfig);
    const mergedServers = { ...vscodeServers, ...rootServers };
    servers.push(...Object.keys(mergedServers).map((name) => ({ name, source: 'repo' as const })));
    if (Object.keys(mergedServers).length > 0) trustedRepoConfig = { mcpServers: mergedServers };
  }
  servers.push(...readMcpFile(join(home, '.copilot', 'mcp-config.json'), 'user'));
  for (const plugin of opts.plugins) {
    for (const name of plugin.mcpServers) servers.push({ name, source: `plugin:${plugin.id}` });
  }
  const deduped = new Map<string, McpCapability>();
  for (const server of servers) {
    const key = `${server.source}:${server.name}`;
    if (!deduped.has(key)) deduped.set(key, server);
  }
  return { servers: [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source)), trustedRepoConfig, warnings };
}
