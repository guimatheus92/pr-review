export type Provider = 'github' | 'azuredevops';

export interface PrRef {
  provider: Provider;
  url: string;
  owner: string;
  repo: string;
  number: number;
  organization?: string;
  project?: string;
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
  injectInto?: string[];
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
