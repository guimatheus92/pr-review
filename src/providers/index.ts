import { GitHubProvider } from './github.js';
import { AzureDevOpsProvider } from './azuredevops.js';
import { ensureRunDir } from '../util/tmp.js';
import type { PrProvider } from './types.js';

/** Single source for minting a run dir from a PR URL (used by review and --detach). */
export function newRunDirForUrl(url: string): string {
  const ref = detectProvider(url).parseUrl(url);
  return ensureRunDir(ref ?? undefined);
}

export function detectProvider(url: string): PrProvider {
  const lower = url.toLowerCase();
  if (lower.includes('github.com')) return new GitHubProvider();
  if (lower.includes('dev.azure.com') || lower.includes('visualstudio.com')) {
    return new AzureDevOpsProvider();
  }
  throw new Error(
    `Unrecognized PR URL: ${url}. Expected github.com/<owner>/<repo>/pull/<n> or dev.azure.com/<org>/<proj>/_git/<repo>/pullrequest/<id>.`,
  );
}

export type { PrProvider } from './types.js';
