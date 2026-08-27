import type { PrRef, Provider } from '../types.js';

function parseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function decodedSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function normalizedHost(provider: Provider, host: string): string {
  const lower = host.toLowerCase();
  if (provider === 'github' && lower === 'www.github.com') return 'github.com';
  if (provider === 'gitlab' && lower === 'www.gitlab.com') return 'gitlab.com';
  return lower;
}

function normalizedServerPath(segments: string[]): string {
  return segments.map((segment) => segment.toLowerCase()).join('/');
}

export function canonicalPrAuthority(ref: Pick<PrRef, 'provider' | 'url' | 'baseUrl' | 'owner' | 'organization' | 'project'>): string | null {
  const parsed = parseUrl(ref.url);
  if (ref.provider === 'github' || ref.provider === 'gitlab') {
    if (!parsed) return null;
    return `${ref.provider}:${normalizedHost(ref.provider, parsed.host)}`;
  }

  const host = parsed?.hostname.toLowerCase();
  if (host === 'dev.azure.com' || host?.endsWith('.visualstudio.com')) {
    return `azuredevops:cloud:${(ref.organization ?? ref.owner).toLowerCase()}`;
  }

  const base = parseUrl(ref.baseUrl) ?? parsed;
  if (!base) return null;
  let pathSegments = decodedSegments(base.pathname);
  if (!ref.baseUrl) {
    const gitIndex = pathSegments.findIndex((segment) => segment.toLowerCase() === '_git');
    if (gitIndex >= 1) pathSegments = pathSegments.slice(0, gitIndex - 1);
  }
  return `azuredevops:server:${base.host.toLowerCase()}/${normalizedServerPath(pathSegments)}`.replace(/\/$/, '');
}

export function canonicalRemoteAuthority(remoteUrl: string, provider: Provider): string | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  let host: string;
  let segments: string[];
  try {
    const parsed = new URL(cleaned);
    host = parsed.host.toLowerCase();
    segments = decodedSegments(parsed.pathname);
  } catch {
    const scp = cleaned.match(/^[^@]+@([^:]+):(.+)$/);
    if (!scp) return null;
    host = scp[1]!.toLowerCase();
    segments = decodedSegments(scp[2]!);
  }

  if (provider === 'github' || provider === 'gitlab') {
    return `${provider}:${normalizedHost(provider, host)}`;
  }

  const hostname = host.replace(/:\d+$/, '');
  if (hostname === 'ssh.dev.azure.com' && segments[0]?.toLowerCase() === 'v3' && segments[1]) {
    return `azuredevops:cloud:${segments[1].toLowerCase()}`;
  }
  if (hostname === 'dev.azure.com' && segments[0]) {
    return `azuredevops:cloud:${segments[0].toLowerCase()}`;
  }
  if (hostname.endsWith('.visualstudio.com')) {
    return `azuredevops:cloud:${hostname.slice(0, -'.visualstudio.com'.length)}`;
  }
  const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === '_git');
  if (gitIndex < 1) return null;
  const collectionSegments = segments.slice(0, gitIndex - 1);
  return `azuredevops:server:${host}/${normalizedServerPath(collectionSegments)}`.replace(/\/$/, '');
}

export function authorityCacheSegment(ref: PrRef): string | null {
  const authority = canonicalPrAuthority(ref);
  if (!authority) return null;
  const defaultAuthority =
    ref.provider === 'github'
      ? 'github:github.com'
      : ref.provider === 'gitlab'
        ? 'gitlab:gitlab.com'
        : `azuredevops:cloud:${ref.owner.toLowerCase()}`;
  return authority === defaultAuthority ? null : encodeURIComponent(authority);
}
