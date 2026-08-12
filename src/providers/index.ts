import { GitHubProvider } from './github.js';
import { AzureDevOpsProvider } from './azuredevops.js';
import { loadConfig } from '../config.js';
import type { Provider, PrRef } from '../types.js';
import type { PrProvider } from './types.js';

const URL_SHAPES: Record<Provider, string[]> = {
  github: [
    'https://github.com/<owner>/<repo>/pull/<number>',
    'https://<ghes-host>/<owner>/<repo>/pull/<number>',
  ],
  azuredevops: [
    'https://dev.azure.com/<org>[/<project>]/_git/<repo>/pullrequest/<id>',
    'https://<org>.visualstudio.com/[<collection>/][<project>/]_git/<repo>/pullrequest/<id>',
    'https://<server>/<collection>/<project>/_git/<repo>/pullrequest/<id>  (Azure DevOps Server)',
  ],
};

function shapesHelp(names: Provider[] = Object.keys(URL_SHAPES) as Provider[]): string {
  return names.flatMap((n) => URL_SHAPES[n]).map((s) => `  ${s}`).join('\n');
}

function hostsTip(hostname: string): string {
  return [
    'For a self-hosted server, map the host in ~/.pr-review/config.yaml or .pr-review.yaml:',
    '  hosts:',
    `    ${hostname}: github   # or: azuredevops`,
  ].join('\n');
}

function makeProvider(name: Provider): PrProvider {
  return name === 'github' ? new GitHubProvider() : new AzureDevOpsProvider();
}

/**
 * Three detection tiers: known cloud hostnames, then the user's `hosts:`
 * config map, then a path-shape heuristic for self-hosted servers (the PR
 * path shapes are disjoint across providers). `hosts` is a test seam;
 * production reads the config.
 */
export function detectProvider(url: string, hosts?: Record<string, Provider>): PrProvider {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}\nExpected one of:\n${shapesHelp()}`);
  }
  const host = u.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') return makeProvider('github');
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) return makeProvider('azuredevops');
  const mapped = (hosts ?? loadConfig().config.hosts)[host];
  if (mapped) return makeProvider(mapped);
  const seg = u.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
  const gi = seg.indexOf('_git');
  if (gi >= 0 && seg[gi + 2] === 'pullrequest') return makeProvider('azuredevops');
  if (seg[2] === 'pull' && /^\d+$/.test(seg[3] ?? '')) return makeProvider('github');
  throw new Error(`Unrecognized PR URL: ${url}\nExpected one of:\n${shapesHelp()}\n${hostsTip(host)}`);
}

export function unparsablePrUrlMessage(name: Provider, url: string): string {
  let msg = `Failed to parse PR URL: ${url}\nExpected one of:\n${shapesHelp([name])}`;
  if (name === 'azuredevops' && url.toLowerCase().includes('visualstudio.com')) {
    msg += '\nTip: legacy URLs usually map to https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>';
  }
  return msg;
}

/**
 * Detect + parse in one step. Throws (never returns null) so a bad URL fails
 * where it is typed — in the foreground, before --detach spawns anything.
 */
export function resolvePr(url: string, hosts?: Record<string, Provider>): { provider: PrProvider; ref: PrRef } {
  const provider = detectProvider(url, hosts);
  const ref = provider.parseUrl(url);
  if (!ref) throw new Error(unparsablePrUrlMessage(provider.name, url));
  return { provider, ref };
}

export type { PrProvider } from './types.js';
