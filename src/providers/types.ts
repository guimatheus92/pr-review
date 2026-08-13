import type { ChangedFile, ExistingComment, Finding, PrMetadata, PrRef, Provider } from '../types.js';

export interface BatchComment {
  path: string;
  line: number;
  body: string;
}

export interface PrProvider {
  readonly name: Provider;
  /**
   * Resolve auth in this (foreground) process and return env var(s) that let a
   * child process skip the CLI/keyring fallbacks (used by the --detach
   * pre-flight). Throws when no credential is available. `ref` is required so
   * auth is host-scoped by construction — an optional ref would let a caller
   * silently resolve a github.com token for an enterprise host.
   */
  authEnv(ref: PrRef): Record<string, string>;
  parseUrl(url: string): PrRef | null;
  fetchMetadata(ref: PrRef): Promise<PrMetadata>;
  fetchChangedFiles(ref: PrRef): Promise<ChangedFile[]>;
  fetchFullDiff(ref: PrRef): Promise<string>;
  fetchExistingComments(ref: PrRef): Promise<ExistingComment[]>;
  /** headSha avoids a per-finding PR re-fetch; providers fall back to fetching it once when absent. */
  postLineComment(ref: PrRef, finding: Finding, headSha?: string): Promise<{ id: string } | null>;
  /**
   * Post many inline comments in one API call (one review). Optional —
   * providers without a batch endpoint omit it and the poster falls back to
   * per-comment posting. Throws on batch failure; caller falls back.
   */
  postBatchComments?(ref: PrRef, headSha: string, comments: BatchComment[]): Promise<{ posted: number }>;
}
