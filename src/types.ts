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

/**
 * What a caller of `fetchChangedFiles` already knows about which files can
 * still reach a review pass (INV-FETCH-04). Both fields are advisory and
 * concern **content only** — a provider must list every path either way, since
 * the path list is what the trust gates read.
 *
 * Providers whose listing endpoint already carries the patch (GitHub, GitLab)
 * ignore this: there is nothing to save. Azure DevOps synthesizes its patch
 * from two whole-file `getItem` calls, so this is the difference between ~6000
 * requests and none on a PR that is about to be refused for being too large.
 */
export interface ChangedFilesOptions {
  /** Trusted diff-exclusion globs. A matching path is listed without a patch — `applyDiffExclusions` would discard it moments later anyway. */
  excludes?: string[];
  /**
   * Globs that may shrink the in-scope COUNT but may never suppress an
   * individual file's content. This asymmetry is the whole reason the field
   * exists separately: these come from the checkout's own `.pr-review.yaml`,
   * which the branch under review can write.
   *
   * Counting with them is safe in one direction only — extra excludes can just
   * make the run *less* likely to be refused, i.e. more likely to fetch — so a
   * PR cannot use them to get itself skipped past the guard. Letting them
   * suppress a file would be the opposite: `diff_excludes: ['**\/*']` in a
   * branch-authored config would deliver a review with no diff at all.
   */
  countOnlyExcludes?: string[];
  /** The too-many-files guard. Once more than this many paths are in scope the run is refused, so no file's content is worth fetching. */
  maxPatchedFiles?: number;
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
  /**
   * Set when gather skipped content fetches because the in-scope count already
   * exceeded the too-many-files guard (INV-FETCH-04). The path list is still
   * complete; the in-scope rows simply carry no patch.
   *
   * `earlyExitGate` reads this BEFORE applying exclusions — with no patches the
   * byte-size clause sums to zero and would wave the run through — and gather
   * never caches such an output: a path-only list restored under a wider
   * exclusion set would come back looking like a whole diff.
   */
  patchesOmitted?: true;
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
