import type { ChangedFile, ExistingComment, Finding, PrMetadata, PrRef } from '../types.js';

export interface BatchComment {
  path: string;
  line: number;
  body: string;
}

export interface PrProvider {
  readonly name: 'github' | 'azuredevops';
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
