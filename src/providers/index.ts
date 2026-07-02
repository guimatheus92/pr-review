import { GitHubProvider } from './github.js';
import { AzureDevOpsProvider } from './azuredevops.js';
import type { PrProvider } from './types.js';

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
