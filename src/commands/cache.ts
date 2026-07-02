import { cacheInfo, clearCache } from '../cache/store.js';
import { detectProvider } from '../providers/index.js';

export function showCacheInfo(): void {
  const info = cacheInfo();
  const mb = (info.totalBytes / (1024 * 1024)).toFixed(2);
  console.log(`Cache root: ${info.root}`);
  console.log(`Total files: ${info.totalFiles} (${mb} MB)`);
  console.log(`Gather entries: ${info.gatherEntries}`);
  console.log(`Response entries: ${info.responseEntries}`);
}

export function clearCacheCommand(opts: { prUrl?: string; all?: boolean }): void {
  if (opts.all) {
    const r = clearCache({ clearAll: true });
    console.log(`Removed ${r.removedFiles} file(s) from entire cache.`);
    return;
  }
  if (opts.prUrl) {
    const provider = detectProvider(opts.prUrl);
    const ref = provider.parseUrl(opts.prUrl);
    if (!ref) throw new Error(`Failed to parse PR URL: ${opts.prUrl}`);
    const r = clearCache({ prRef: ref });
    console.log(`Removed ${r.removedFiles} cache file(s) for ${opts.prUrl}`);
    return;
  }
  throw new Error('Pass either --all or --pr <url>');
}
