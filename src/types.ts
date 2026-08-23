export const PROVIDERS = ['github', 'azuredevops', 'gitlab'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface PrRef {
  provider: Provider;
  url: string;
  owner: string;
  repo: string;
  number: number;
  organization?: string;
  project?: string;
  /**
   * API base URL, set by parseUrl. GitHub: https://api.github.com or
   * https://<host>/api/v3 (GHES). Azure DevOps: the org/collection URL
   * (https://dev.azure.com/<org>, https://<org>.visualstudio.com, or
   * https://<host>/<collection-path> on-prem). Optional for back-compat with
   * old serialized refs; NEVER used in cache keys or run-dir names.
   */
  baseUrl?: string;
}

export interface PrMetadata {
  title: string;
  description: string;
  author: string;
  headSha: string;
  baseSha: string;
  baseBranch: string;
  headBranch: string;
  labels: string[];
  linkedItems: LinkedItem[];
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  state: 'open' | 'closed' | 'merged';
}

export interface LinkedItem {
  type: 'issue' | 'workitem' | 'bug';
  id: string;
  url: string;
  title?: string;
  state?: string;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string;
  additions: number;
  deletions: number;
  patch?: string;
  excluded?: boolean;
  excludedReason?: string;
}

export interface ExistingComment {
  id: string;
  author: string;
  body: string;
  file?: string;
  line?: number;
  createdAt: string;
  source: 'human' | 'copilot' | 'bot' | 'unknown';
}

export interface GatherOutput {
  pr: PrRef;
  metadata: PrMetadata;
  changedFiles: ChangedFile[];
  fullDiff: string;
  existingComments: ExistingComment[];
  gatheredAt: string;
}

export interface ReviewerDefinition {
  name: string;
  description?: string;
  source: string;
  promptBody: string;
  appliesTo: string[];
  model: string;
  outputFormat: 'json' | 'markdown';
  skipWhenNoMatch: boolean;
  isBuiltIn: boolean;
  rawPrompt?: boolean;
  timeoutMs?: number;
}

export interface SkillDefinition {
  name: string;
  description?: string;
  source: string;
  body: string;
  appliesTo: string[];
  /** Frontmatter `tags` — matched against the PR's stack tags for pack skills. */
  tags?: string[];
  /** Pack name when loaded from a skill pack (name is then `<pack>/<skill>`). */
  pack?: string;
  /** Where the skill was discovered; undefined ⇒ 'repo' (back-compat). */
  origin?: 'repo' | 'home' | 'plugin' | 'forced' | 'pack';
  /** Pack mode: 'index' skills are never dispatched as passes, only listed on-demand. */
  mode?: 'auto' | 'index';
}

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NIT';

export interface Finding {
  severity: Severity;
  title: string;
  body: string;
  file?: string;
  line?: number;
  endLine?: number;
}

export interface ReviewerOutput {
  reviewerName: string;
  model: string;
  findings: Finding[];
  rawOutput: string;
  durationMs: number;
  exitCode: number;
  error?: string;
}
