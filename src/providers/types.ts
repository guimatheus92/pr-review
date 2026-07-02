import type { ChangedFile, ExistingComment, Finding, PrMetadata, PrRef } from '../types.js';

export interface PrProvider {
  readonly name: 'github' | 'azuredevops';
  parseUrl(url: string): PrRef | null;
  fetchMetadata(ref: PrRef): Promise<PrMetadata>;
  fetchChangedFiles(ref: PrRef): Promise<ChangedFile[]>;
  fetchFullDiff(ref: PrRef): Promise<string>;
  fetchExistingComments(ref: PrRef): Promise<ExistingComment[]>;
  postLineComment(ref: PrRef, finding: Finding): Promise<{ id: string } | null>;
}
