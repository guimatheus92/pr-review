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
  /**
   * The provider's own count of changed files, when its API offers one (GitHub
   * `changed_files`, GitLab `changes_count`). Absent = unknown, which never
   * blocks; present, gather refuses a list of any other length.
   */
  changedFileCount?: number;
  /**
   * The provider declares its stored diff truncated (GitLab `"N+"`). No length
   * comparison can detect that case — the list served IS the capped set — so
   * gather completes it from git or fails, whatever the count says.
   */
  changedFileListTruncated?: boolean;
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
  /**
   * @deprecated Written until 0.11, never read (#26). Declared only to document
   * the shape older artifacts still have and to keep the fixtures that construct
   * one type-checking — NOT a compatibility requirement: both readers are
   * unchecked JSON casts, so an undeclared key round-trips either way. Safe to
   * delete once no fixture sets it. The per-file patches in `changedFiles` are
   * the diff.
   */
  fullDiff?: string;
  existingComments: ExistingComment[];
  gatheredAt: string;
  /**
   * Set by gather only once the provider's file list passed the completeness
   * gate: paginated to completion, count matched, or completed from git and —
   * when an exact count exists — re-checked against it (a provider-declared
   * truncation has no count to reach; an absent count never blocks). Absent on
   * entries cached
   * before 0.11 — which may hold a truncated list — so a hit without it is
   * refetched once.
   */
  changedFilesComplete?: true;
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
  /**
   * Where the skill was discovered; undefined ⇒ 'repo' (back-compat). 'configured' =
   * a directory named via --skills-dir / extra_skills_dirs / PR_REVIEW_SKILLS_DIR:
   * selected and trust-checked like a repo dir, admitted from a foreign cwd like forced.
   */
  origin?: 'repo' | 'home' | 'plugin' | 'explicit' | 'forced' | 'configured' | 'pack';
  /** Pack mode: 'index' skills are never dispatched as passes, only listed on-demand. */
  mode?: 'auto' | 'index';
  /** Why the rule was left out of this review (set on skippedProjectSkills entries only). */
  skipReason?: string;
  /** Installed plugin that supplied this skill, when applicable. */
  plugin?: string;
  /** MCP server names declared by that installed plugin. */
  mcpServers?: string[];
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
