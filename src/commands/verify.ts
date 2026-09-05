import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RUNS_ROOT } from '../util/tmp.js';
import { ERROR_FILE } from '../util/tmp.js';
import { readPostedMarker, type PostedMarker } from '../util/posted-marker.js';
import { readAuthoritativeControl } from './status.js';
import { readAuthoritativeFinalization, isPathInside, type DispatchPlan, type DeliveryState, type FinalizationRecord } from '../dispatch/delivery.js';
import { commentKey, snapFindingsToDiff, windowStart, CLOCK_SLACK_MS } from './post.js';
import { readCapabilityUsage, type CapabilityUsage } from './review.js';
import { resolvePr } from '../providers/index.js';
import { withRetry } from '../util/retry.js';
import { linguistCachePath } from '../stack/linguist.js';
import type { PrProvider } from '../providers/types.js';
import type { ExistingComment, Finding, GatherOutput, PrMetadata, PrRef } from '../types.js';

/**
 * Post-hoc audit of a finished run against INVARIANTS.md.
 *
 * Read-only by construction: it never posts, deletes, or rewrites anything in
 * the run directory or on the pull request. An audit that mutates what it
 * audits is not an audit.
 *
 * The registry below is the machine half of INVARIANTS.md. `CHECKS` and
 * `TEST_ONLY` together must hold exactly the ID set the document declares —
 * `tests/invariants-doc.test.ts` asserts that equality in both directions, so a
 * new invariant without a check (or a check without a documented invariant)
 * fails the suite rather than quietly reducing coverage.
 */

export type Status = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  status: Status;
  evidence: string;
}

export interface InvariantCheck {
  id: string;
  /** `run+pr` checks need the live read-back; they SKIP under --offline. */
  needs: 'run' | 'run+pr';
  run(ctx: VerifyContext): CheckResult;
}

export interface VerifyRow {
  id: string;
  status: Status;
  evidence: string;
}

interface PassRouteLike {
  name: string;
  matchedBy: string;
  source?: string;
}

interface CapabilitiesArtifact {
  runtime?: string;
  installedPlugins?: unknown;
  selectedPluginSkills?: unknown;
  mcpServers?: { name: string; source: string }[];
  warnings?: string[];
  usage?: CapabilityUsage[];
}

interface CompanionsArtifact {
  missingReviewers?: unknown;
  duplicateReviewers?: unknown;
  detectionWarning?: unknown;
  plannedReviewers?: unknown;
}

interface StackArtifact {
  languages?: string[];
  dependencies?: string[];
  dependencyTokens?: string[];
  ecosystems?: string[];
  tags?: string[];
  notes?: string[];
  cwdIsPrRepo?: boolean;
}

interface FindingsArtifact {
  finalFindings?: Finding[];
  droppedCount?: number;
}

export interface VerifyContext {
  runId: string;
  runDir: string;
  offline: boolean;
  gather: GatherOutput;
  plan: DispatchPlan | null;
  state: DeliveryState | null;
  finalization: FinalizationRecord | null;
  marker: PostedMarker | 'corrupt' | null;
  findings: FindingsArtifact | null;
  stack: StackArtifact | null;
  routes: PassRouteLike[] | null;
  capabilities: CapabilitiesArtifact | null;
  companions: CompanionsArtifact | null;
  errorTxt: string | null;
  capabilityUsage: { usage: CapabilityUsage[]; warnings: string[] } | null;
  home?: string;

  /** Findings in the shape the poster would have written them (snapped/re-anchored). */
  postingShape: Finding[];
  /** Multiset of `file:line:body` keys the run should have left on the PR. */
  expectedKeys: Map<string, number>;
  /** Live comments created inside this run's window, or null when unread. */
  liveWindow: ExistingComment[] | null;
  /** Every live comment the read returned, or null when unread. */
  liveAll: ExistingComment[] | null;
  liveMetadata: PrMetadata | null;
  /** Why the live read is unavailable, when it is. */
  liveUnavailable: string | null;
  /** Author of the comments this run provably wrote, when derivable. */
  selfAuthor: string | null;
}

const pass = (evidence: string): CheckResult => ({ status: 'pass', evidence });
const fail = (evidence: string): CheckResult => ({ status: 'fail', evidence });
const skip = (evidence: string): CheckResult => ({ status: 'skip', evidence });

/** First `limit` items, joined, with an honest tail marker. */
function sample(items: string[], limit = 5): string {
  const head = items.slice(0, limit).join(', ');
  return items.length > limit ? `${head}, +${items.length - limit} more` : head;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function keyCounts(findings: Finding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings) {
    if (!f.file || !f.line) continue;
    const key = commentKey(f.file, f.line, f.body);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** `file:line` for a key, for human-readable evidence. */
function describeKey(key: string): string {
  const [file, line] = key.split('\0');
  return `${file || '(no file)'}:${line || '?'}`;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Invariants no run artifact can witness. Each maps to what guards it instead.
 * These render as SKIP with the guard named — declared, never omitted, because
 * an invariant that silently disappears from the report is indistinguishable
 * from one that passed.
 */
export const TEST_ONLY: Record<string, string> = {
  'INV-POST-04': 'guarded by tests/post.test.ts and tests/posted-marker.test.ts — internal control flow leaves no run artifact',
  'INV-TRUST-02': 'guarded by tests/config.test.ts — "no yaml/env key exists" is an absence, not something a run can record',
  'INV-TRUST-03': 'guarded by tests/linked-skills.test.ts — a refused link leaves only a degraded note, and absence proves nothing',
  'INV-HYG-01': 'guarded by tests/zero-passes.test.ts — prompt text lives in the bundle, not in a run',
  'INV-HYG-02': 'guarded by tests/dogfood.test.ts and the CI bundle-freshness gate — a build property',
  'INV-HYG-03': 'human judgment; eval fixtures in evals/ are the standing guard',
};

export const CHECKS: InvariantCheck[] = [
  {
    id: 'INV-POST-01',
    needs: 'run+pr',
    run(ctx) {
      if (ctx.plan?.execution.dryRun) {
        return ctx.marker && ctx.marker !== 'corrupt' && ctx.marker.attempted > 0
          ? fail(`dry-run recorded a publish attempt (posted.marker: ${ctx.marker.posted}/${ctx.marker.attempted})`)
          : skip('dry-run: nothing was posted, so there is nothing on the PR to check');
      }
      if (ctx.expectedKeys.size === 0) return skip('the run retained no locatable findings');
      const remaining = new Map(ctx.expectedKeys);
      for (const c of ctx.liveWindow!) {
        if (!c.file) continue;
        const key = commentKey(c.file, c.line, c.body);
        const n = remaining.get(key) ?? 0;
        if (n > 0) remaining.set(key, n - 1);
      }
      const missing = [...remaining.entries()].filter(([, n]) => n > 0);
      const total = [...ctx.expectedKeys.values()].reduce((a, b) => a + b, 0);
      const short = missing.reduce((a, [, n]) => a + n, 0);
      return missing.length === 0
        ? pass(`${total}/${total} findings present as inline threads`)
        : fail(`${total - short}/${total} present; missing: ${sample(missing.map(([key]) => describeKey(key)))}`);
    },
  },
  {
    id: 'INV-POST-02',
    needs: 'run+pr',
    run(ctx) {
      const topLevel = ctx.liveWindow!.filter((c) => !c.file);
      if (ctx.selfAuthor) {
        const ours = topLevel.filter((c) => c.author === ctx.selfAuthor);
        return ours.length === 0
          ? pass(
              `0 top-level comments authored by ${ctx.selfAuthor} in the run window` +
                (topLevel.length > 0 ? ` (${topLevel.length} by others, ignored)` : ''),
            )
          : fail(
              `${ours.length} top-level comment(s) authored by ${ctx.selfAuthor}: ` +
                sample(ours.map((c) => `${c.id} ${JSON.stringify(c.body.slice(0, 60))}`), 3),
            );
      }
      // No confirmed write to derive our identity from (zero findings, or a
      // dry-run). Fall back to a shape tripwire that can only FAIL, never
      // PASS by accident: matching a finding body, or the literal shape of the
      // companion verdict incident, is ours whoever the API says wrote it.
      const bodies = new Set((ctx.findings?.finalFindings ?? []).map((f) => f.body.trim()));
      const suspects = topLevel.filter(
        (c) => bodies.has(c.body.trim()) || /^\s*(#\s*PR Review Summary|###\s*Code review)\b/i.test(c.body),
      );
      if (suspects.length > 0) {
        return fail(
          `${suspects.length} top-level comment(s) match this tool's output shape: ` +
            sample(suspects.map((c) => `${c.id} by ${c.author}`), 3),
        );
      }
      return skip(
        'no confirmed write from this run to derive the posting identity from; ' +
          `shape tripwire clean over ${topLevel.length} top-level comment(s) in the window`,
      );
    },
  },
  {
    id: 'INV-POST-03',
    needs: 'run+pr',
    run(ctx) {
      if (!ctx.selfAuthor) return skip('no comment from this run identified, so no body to compare');
      const ours = ctx.liveWindow!.filter((c) => c.author === ctx.selfAuthor && c.file);
      // The commentKey match in INV-POST-01 already compares bodies byte for
      // byte; this row exists to stay meaningful when that one failed, so it
      // scans independently for the decorations we promise never to add.
      const decorated = ours.filter(
        (c) => /^\s*(CRITICAL|HIGH|MEDIUM|LOW|NIT)\b\s*[:\]-]/i.test(c.body) || /_generated by |🤖/i.test(c.body),
      );
      return decorated.length === 0
        ? pass(`${ours.length}/${ours.length} bodies carry no severity prefix or bot chrome`)
        : fail(`${decorated.length} comment(s) carry a severity prefix or bot chrome: ${sample(decorated.map((c) => `${c.file}:${c.line}`))}`);
    },
  },
  {
    id: 'INV-POST-05',
    needs: 'run+pr',
    run(ctx) {
      const counts = new Map<string, number>();
      for (const c of ctx.liveWindow!) {
        if (!c.file) continue;
        const key = commentKey(c.file, c.line, c.body);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const dupes = [...counts.entries()].filter(([, n]) => n > 1);
      return dupes.length === 0
        ? pass(`no duplicate file:line:body among ${ctx.liveWindow!.length} comment(s) in the window`)
        : fail(`${dupes.length} duplicated location(s): ${sample(dupes.map(([key, n]) => `${describeKey(key)} x${n}`))}`);
    },
  },
  {
    id: 'INV-POST-06',
    needs: 'run+pr',
    run(ctx) {
      if (!ctx.selfAuthor) return skip('no comment from this run identified, so an unplanned write cannot be attributed');
      const unplanned = ctx.liveWindow!.filter((c) => {
        if (c.author !== ctx.selfAuthor || !c.file) return false;
        return !ctx.expectedKeys.has(commentKey(c.file, c.line, c.body));
      });
      return unplanned.length === 0
        ? pass(`every inline comment by ${ctx.selfAuthor} in the window matches a planned finding`)
        : fail(
            `${unplanned.length} inline comment(s) by ${ctx.selfAuthor} match no planned finding — a dispatched agent wrote to the PR: ` +
              sample(unplanned.map((c) => `${c.file}:${c.line}`)),
          );
    },
  },
  {
    id: 'INV-POST-07',
    needs: 'run+pr',
    run(ctx) {
      if (ctx.plan?.execution.dryRun) return skip('dry-run: nothing was attempted');
      if (!ctx.marker) return skip('no publish attempt was recorded for this run');
      if (ctx.marker === 'corrupt') return fail('posted.marker is corrupt — the outcome of the publish attempt is unknown');
      const retained = ctx.findings?.finalFindings?.length ?? 0;
      if (ctx.marker.attempted !== retained) {
        return fail(`${retained} finding(s) retained but ${ctx.marker.attempted} attempted — the difference was neither posted nor reported`);
      }
      if (ctx.marker.verified === false) return fail('the publish outcome could not be verified');
      return pass(`${ctx.marker.attempted} attempted = ${ctx.marker.posted} posted + ${ctx.marker.attempted - ctx.marker.posted} reported error(s)`);
    },
  },
  {
    id: 'INV-FETCH-01',
    needs: 'run+pr',
    run(ctx) {
      if (ctx.gather.changedFilesComplete !== true) {
        return fail('pr-review-gather.json has no changedFilesComplete marker — the run reviewed a file list it never proved complete');
      }
      const listed = ctx.gather.changedFiles.length;
      const live = ctx.liveMetadata?.changedFileCount;
      if (ctx.liveMetadata && ctx.plan && ctx.liveMetadata.headSha !== ctx.plan.metadata.headSha) {
        return pass(
          `changedFilesComplete=true over ${listed} file(s); live count not compared — the PR advanced since the run ` +
            `(${ctx.plan.metadata.headSha.slice(0, 7)} → ${ctx.liveMetadata.headSha.slice(0, 7)})`,
        );
      }
      if (live === undefined) return pass(`changedFilesComplete=true over ${listed} file(s); the provider reports no count to compare`);
      // gather stamps the marker on the RAW list; exclusions run after, so the
      // stored list is a subset by design and only a longer one is a conflict.
      return listed <= live
        ? pass(`changedFilesComplete=true; ${listed} file(s) retained of ${live} reported by the provider`)
        : fail(`${listed} file(s) stored but the provider reports ${live} — the list disagrees with its own source`);
    },
  },
  {
    id: 'INV-FETCH-02',
    needs: 'run+pr',
    run(ctx) {
      const m = ctx.gather.metadata;
      const missing = (['title', 'author', 'headSha', 'state'] as const).filter((k) => !m[k]);
      if (missing.length > 0) return fail(`pr-review-gather.json is missing ${missing.join(', ')}`);
      if (ctx.gather.changedFiles.length === 0) return fail('pr-review-gather.json holds no changed files');
      const withPatch = ctx.gather.changedFiles.filter((f) => !f.excluded && f.status !== 'deleted' && f.patch).length;
      if (withPatch === 0) return fail('no in-scope changed file carries a patch — passes would review paths without content');
      if (!Array.isArray(ctx.gather.existingComments)) return fail('pr-review-gather.json holds no existing-comment list');
      // The real "reviewers lost context" failure: a comment that predates the
      // gather and is absent from it was never shown to any pass.
      const gatheredAt = Date.parse(ctx.gather.gatheredAt);
      let missedPrior = 0;
      if (ctx.liveAll && Number.isFinite(gatheredAt)) {
        const known = new Set(ctx.gather.existingComments.map((c) => c.id));
        missedPrior = ctx.liveAll.filter((c) => {
          const at = Date.parse(c.createdAt);
          return Number.isFinite(at) && at < gatheredAt && !known.has(c.id);
        }).length;
      }
      if (missedPrior > 0) {
        return fail(`${missedPrior} comment(s) older than the gather are absent from it — passes reviewed without that context`);
      }
      return pass(
        `title, author, base/head, state, ${withPatch} patch(es), ${ctx.gather.existingComments.length} prior comment(s)`,
      );
    },
  },
  {
    id: 'INV-FETCH-03',
    needs: 'run',
    run(ctx) {
      if (!ctx.plan) return skip('no authenticated dispatch plan — artifact paths cannot be checked against the run root');
      const stateRoot = join(ctx.home ?? homedir(), '.pr-review');
      if (!isPathInside(stateRoot, ctx.plan.runDir)) {
        return fail(`the run wrote to ${ctx.plan.runDir}, which is outside ${stateRoot}`);
      }
      const stray = ctx.plan.artifacts.map((a) => a.path).filter((p) => !isPathInside(ctx.plan!.runDir, p));
      return stray.length === 0
        ? pass(`run dir under ${stateRoot}; ${ctx.plan.artifacts.length} planned artifact(s), none outside it`)
        : fail(`${stray.length} artifact path(s) outside the run dir: ${sample(stray)}`);
    },
  },
  {
    id: 'INV-CTX-01',
    needs: 'run+pr',
    run(ctx) {
      if (!ctx.stack) return fail('stack.json is missing — the run has no record of what stack it reviewed');
      const languages = ctx.stack.languages ?? [];
      const dependencies = ctx.stack.dependencies ?? [];
      const ecosystems = ctx.stack.ecosystems ?? [];
      const notes = ctx.stack.notes ?? [];
      if (languages.length === 0 && dependencies.length === 0 && ecosystems.length === 0 && notes.length === 0) {
        return fail('stack.json records no language, dependency or ecosystem evidence AND no note explaining why');
      }
      const linguist = existsSync(linguistCachePath(ctx.home));
      const detail = `${languages.length} language(s), ${dependencies.length} dependenc(ies), ${ecosystems.length} ecosystem(s)`;
      if (languages.length === 0 && notes.length > 0) {
        return pass(`no language evidence, explained: ${JSON.stringify(notes[0])}`);
      }
      return pass(`${detail}; Linguist cache ${linguist ? 'present' : 'absent'}`);
    },
  },
  {
    id: 'INV-CTX-02',
    needs: 'run',
    run(ctx) {
      if (!ctx.capabilities) return fail('capabilities.json is missing — the run has no record of what it could reach');
      const c = ctx.capabilities;
      const shaped = Array.isArray(c.installedPlugins) && Array.isArray(c.selectedPluginSkills) && Array.isArray(c.mcpServers) && Array.isArray(c.warnings);
      if (!shaped) return fail('capabilities.json is malformed (installedPlugins/selectedPluginSkills/mcpServers/warnings must all be arrays)');
      if (!ctx.routes) return fail('passes.json is missing or malformed — the run has no record of how skills were routed');
      if (ctx.routes.length === 0) return fail('passes.json is empty — no skill was even considered');
      const by = (kind: string) => ctx.routes!.filter((r) => r.matchedBy === kind).length;
      const dispatched = ctx.routes.filter((r) => !['context', 'index', 'skipped'].includes(r.matchedBy)).length;
      return pass(
        `${(c.installedPlugins as unknown[]).length} plugin(s), ${c.mcpServers!.length} MCP server(s), ` +
          `${ctx.routes.length} skill(s) routed (${dispatched} dispatched / ${by('context')} context / ${by('index')} index / ${by('skipped')} skipped)`,
      );
    },
  },
  {
    id: 'INV-CTX-03',
    needs: 'run',
    run(ctx) {
      const dispatched = (ctx.routes ?? []).filter((r) => !['context', 'index', 'skipped'].includes(r.matchedBy));
      if (dispatched.length > 0) return skip(`${dispatched.length} pass(es) ran — the zero-pass gate was not reached`);
      const exitCode = ctx.finalization?.exitCode;
      if (exitCode === 2 || ctx.errorTxt) return pass(`zero passes and the run failed loudly (${ctx.errorTxt ? 'error.txt present' : `exit ${exitCode}`})`);
      return fail('zero passes dispatched but the run did not exit 2 — an empty review rendered as a clean PR');
    },
  },
  {
    id: 'INV-CTX-04',
    needs: 'run',
    run(ctx) {
      if (!ctx.routes) return skip('passes.json is unavailable');
      if (!ctx.state) return skip('no authenticated delivery state to compare the routing against');
      const planned = new Set(ctx.state.planned);
      const contextNames = ctx.routes.filter((r) => r.matchedBy === 'context').map((r) => r.name);
      const leaked = contextNames.filter((name) => planned.has(name));
      if (leaked.length > 0) {
        return fail(`${leaked.length} project skill(s) consumed a pass slot instead of injecting as context: ${sample(leaked)}`);
      }
      const dispatchNames = new Set(
        ctx.routes.filter((r) => !['context', 'index', 'skipped'].includes(r.matchedBy)).map((r) => r.name),
      );
      const unrouted = ctx.state.planned.filter(
        (name) => !dispatchNames.has(name) && name !== 'verifier' && name !== 'codex' && !name.startsWith('companion:'),
      );
      return unrouted.length === 0
        ? pass(`${dispatchNames.size} dispatched pass(es), ${contextNames.length} project skill(s) as shared context`)
        : fail(`${unrouted.length} planned reviewer(s) have no pass route: ${sample(unrouted)}`);
    },
  },
  {
    id: 'INV-CTX-05',
    needs: 'run',
    run(ctx) {
      if (!ctx.plan) return skip('no authenticated dispatch plan — the MCP denial cannot be checked');
      const inventory = (ctx.capabilities?.mcpServers ?? []).map((s) => s.name);
      if (ctx.plan.runtime === 'copilot') {
        const denied = new Set(ctx.plan.disabledMcpServers);
        const uncovered = inventory.filter((name) => !denied.has(name));
        if (uncovered.length > 0) {
          return fail(`copilot run left ${uncovered.length} inventoried MCP server(s) undenied: ${sample(uncovered)}`);
        }
      }
      const usage = ctx.capabilityUsage?.usage ?? [];
      const reached = usage.filter((u) => (u.attempted?.length ?? 0) > 0 || (u.used?.length ?? 0) > 0);
      if (reached.length > 0) {
        return fail(
          `${reached.length} pass(es) reported reaching MCP despite process-level denial: ` +
            sample(reached.map((u) => u.reviewer)),
        );
      }
      const covered = ctx.plan.runtime === 'copilot' ? `${inventory.length} inventoried server(s) denied by name` : 'denied categorically (--strict-mcp-config)';
      return pass(`${ctx.plan.runtime}: ${covered}; ${usage.length} pass sidecar(s) report no MCP reached`);
    },
  },
  {
    id: 'INV-TRUST-01',
    needs: 'run',
    run(ctx) {
      const changed = new Set(ctx.gather.changedFiles.map((f) => f.path.replace(/\\/g, '/')));
      const touchedRule = [...changed].filter((p) =>
        /(^|\/)(\.claude|\.copilot|\.github|\.agents)\/(skills|rules|instructions)\//.test(p),
      );
      const touchedConfig = ['.pr-review.yaml', '.pr-review.yml', '.mcp.json', '.vscode/mcp.json'].filter((p) => changed.has(p));
      if (touchedRule.length === 0 && touchedConfig.length === 0) {
        return skip('the PR changed no rule file, .pr-review.yaml or MCP config');
      }
      const admitted = (ctx.routes ?? [])
        .filter((r) => r.matchedBy !== 'skipped' && r.source)
        .filter((r) => touchedRule.includes(r.source!.replace(/\\/g, '/')));
      if (admitted.length > 0) {
        return fail(`${admitted.length} PR-authored rule file(s) reached the review: ${sample(admitted.map((r) => r.name))}`);
      }
      const summary = readFileSafe(join(ctx.runDir, 'pr-review-summary.md')) ?? '';
      if (touchedConfig.length > 0 && !/untrusted|ignored|degraded/i.test(summary)) {
        return fail(`the PR changed ${sample(touchedConfig)} but the summary names no degraded coverage`);
      }
      return pass(
        `${touchedRule.length} PR-authored rule file(s) and ${touchedConfig.length} config file(s) excluded from the review`,
      );
    },
  },
  {
    id: 'INV-DEL-01',
    needs: 'run',
    run(ctx) {
      const failures: string[] = [];
      if (ctx.state) {
        if (ctx.state.kind !== 'complete') failures.push(`delivery state is '${ctx.state.kind}'`);
        if (ctx.state.missing.length > 0) failures.push(`${ctx.state.missing.length} reviewer(s) missing`);
        if (ctx.state.invalid.length > 0) failures.push(`${ctx.state.invalid.length} reviewer(s) invalid`);
      }
      const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
      const missingCompanions = names(ctx.companions?.missingReviewers);
      const duplicateCompanions = names(ctx.companions?.duplicateReviewers);
      if (missingCompanions.length > 0) failures.push(`companion(s) with no output: ${sample(missingCompanions)}`);
      if (duplicateCompanions.length > 0) failures.push(`companion(s) with duplicate output: ${sample(duplicateCompanions)}`);
      if (failures.length === 0) {
        return pass(
          `${ctx.state ? `${ctx.state.valid.length}/${ctx.state.planned.length} reviewer(s) delivered` : 'no delivery state (legacy run)'}` +
            `, 0 companion shortfall`,
        );
      }
      // Incomplete delivery is only a violation if the run still claimed success.
      const exitCode = ctx.finalization?.exitCode;
      if (exitCode === 2 || ctx.errorTxt) return pass(`incomplete delivery reported loudly (${failures.join('; ')})`);
      return fail(`${failures.join('; ')} — but the run did not exit 2`);
    },
  },
  {
    id: 'INV-DEL-02',
    needs: 'run',
    run(ctx) {
      if (!ctx.state) return skip('no authenticated delivery state (legacy run)');
      const initial = ctx.state.runtimeAttempts.filter((a) => a.kind === 'initial');
      if (initial.length !== 1) {
        return fail(`${initial.length} initial dispatch session(s); Phase 1 must dispatch exactly once`);
      }
      const extra = ctx.state.runtimeAttempts.filter((a) => a.kind !== 'initial');
      return pass(
        `1 initial session` + (extra.length > 0 ? ` + ${extra.length} (${sample([...new Set(extra.map((a) => a.kind))])})` : ''),
      );
    },
  },
  {
    id: 'INV-DEL-03',
    needs: 'run',
    run(ctx) {
      const complete = !ctx.state || ctx.state.kind === 'complete';
      if (complete) return skip('delivery was complete, so the partial-posting gate was not exercised');
      if (!ctx.marker || ctx.marker === 'corrupt') {
        return ctx.marker === 'corrupt'
          ? fail('delivery is incomplete and posted.marker is corrupt — a post attempt cannot be ruled out')
          : pass(`delivery is '${ctx.state!.kind}' and nothing was posted`);
      }
      return ctx.marker.attempted === 0
        ? pass(`delivery is '${ctx.state!.kind}' and nothing was attempted`)
        : fail(`delivery is '${ctx.state!.kind}' but ${ctx.marker.attempted} finding(s) were posted`);
    },
  },
  {
    id: 'INV-OUT-01',
    needs: 'run',
    run(ctx) {
      if (!ctx.finalization) return skip('no authenticated finalization record (run did not complete, or predates the record)');
      const { exitCode } = ctx.finalization;
      if (![0, 1, 2].includes(exitCode)) return fail(`finalization recorded exit ${exitCode}`);
      if (exitCode === 2 && !ctx.errorTxt) return fail('exit 2 without error.txt — the failure is unnamed');
      if (exitCode === 0 && ctx.errorTxt) return fail('exit 0 with error.txt present — a stale failure was not cleared');
      return pass(`exit ${exitCode}${exitCode === 2 ? ' with error.txt naming the failure' : ' and no error.txt'}`);
    },
  },
  {
    id: 'INV-OUT-02',
    needs: 'run',
    run(ctx) {
      const required = ['pr-review-gather.json', 'stack.json', 'passes.json', 'companions.json', 'capabilities.json'];
      if (ctx.finalization || existsSync(join(ctx.runDir, 'pr-review-summary.md'))) {
        required.push('pr-review-summary.md', 'pr-review-findings.json', 'progress.ndjson');
      }
      const absent = required.filter((f) => !existsSync(join(ctx.runDir, f)));
      if (absent.length > 0) return fail(`missing run artifact(s): ${sample(absent)}`);
      const raw = readdirSync(ctx.runDir).filter((f) => f.startsWith('raw-') && f.endsWith('.json'));
      if (ctx.state && raw.length < ctx.state.valid.length) {
        return fail(`${raw.length} raw-*.json sidecar(s) for ${ctx.state.valid.length} delivered reviewer(s)`);
      }
      return pass(`${required.length} contract artifact(s) present, ${raw.length} raw-*.json sidecar(s)`);
    },
  },
];

function readFileSafe(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

function runsRoot(home?: string): string {
  return home ? join(home, '.pr-review', 'runs') : RUNS_ROOT;
}

/** Newest-first: the run id ends in an ISO stamp, so name order is time order. */
function runDirsNewestFirst(home?: string): string[] {
  const root = runsRoot(home);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}

function resolveRunId(opts: { runId?: string; prUrl?: string; home?: string }): string {
  const candidates = runDirsNewestFirst(opts.home);
  if (opts.runId) {
    if (!existsSync(join(runsRoot(opts.home), opts.runId))) throw new Error(`verify: run dir not found: ${opts.runId}`);
    return opts.runId;
  }
  if (opts.prUrl) {
    const { ref } = resolvePr(opts.prUrl);
    for (const id of candidates) {
      const gather = readJson<GatherOutput>(join(runsRoot(opts.home), id, 'pr-review-gather.json'));
      if (gather?.pr?.url === opts.prUrl) return id;
      if (gather && gather.pr.provider === ref.provider && gather.pr.repo === ref.repo && gather.pr.number === ref.number) {
        return id;
      }
    }
    throw new Error(`verify: no run found for ${opts.prUrl} under ${runsRoot(opts.home)}`);
  }
  const newest = candidates[0];
  if (!newest) throw new Error(`verify: no runs under ${runsRoot(opts.home)}`);
  return newest;
}

export async function loadVerifyContext(opts: {
  runId?: string;
  prUrl?: string;
  offline?: boolean;
  home?: string;
  providerOverride?: PrProvider;
}): Promise<VerifyContext> {
  const runId = resolveRunId(opts);
  const runDir = join(runsRoot(opts.home), runId);
  const gather = readJson<GatherOutput>(join(runDir, 'pr-review-gather.json'));
  if (!gather) throw new Error(`verify: ${join(runDir, 'pr-review-gather.json')} is missing or unreadable — nothing to audit`);

  const control = readAuthoritativeControl(runDir, opts.home);
  const plan = control?.plan ?? null;
  const state = control?.state ?? null;
  let finalization: FinalizationRecord | null = null;
  if (plan) {
    try {
      finalization = readAuthoritativeFinalization(runDir, opts.home, plan);
    } catch {
      // A record that fails authentication is not a record; the OUT-01 row
      // reports the absence rather than trusting a tampered one.
      finalization = null;
    }
  }

  const findings = readJson<FindingsArtifact>(join(runDir, 'pr-review-findings.json'));
  const capabilities = readJson<CapabilitiesArtifact>(join(runDir, 'capabilities.json'));
  const routesRaw = readJson<unknown>(join(runDir, 'passes.json'));
  const routes =
    Array.isArray(routesRaw) && routesRaw.every((r) => r && typeof r.name === 'string' && typeof r.matchedBy === 'string')
      ? (routesRaw as PassRouteLike[])
      : null;

  const provider = opts.providerOverride ?? resolvePr(gather.pr.url).provider;
  const reanchor = provider.name === 'github' || provider.name === 'gitlab';
  const finalFindings = findings?.finalFindings ?? [];
  const postingShape = snapFindingsToDiff(finalFindings, gather.changedFiles, reanchor).findings;
  const expectedKeys = keyCounts(postingShape);

  let liveAll: ExistingComment[] | null = null;
  let liveMetadata: PrMetadata | null = null;
  let liveUnavailable: string | null = opts.offline ? 'the run was audited with --offline' : null;
  const planCreatedAt = plan ? Date.parse(plan.createdAt) : Date.parse(gather.gatheredAt);
  const floor = windowStart(gather.existingComments, planCreatedAt) - CLOCK_SLACK_MS;

  if (!opts.offline) {
    try {
      const ref: PrRef = gather.pr;
      liveAll = await withRetry(
        () => provider.fetchExistingComments(ref, new Date(floor)),
        (e) => provider.isTransientError(e),
        'verify PR read-back',
      );
      liveMetadata = await withRetry(
        () => provider.fetchMetadata(ref),
        (e) => provider.isTransientError(e),
        'verify PR metadata',
      );
    } catch (err) {
      // Unknown, never empty: the read that fails is exactly the read whose
      // absence would let every posting row pass vacuously.
      liveAll = null;
      liveMetadata = null;
      liveUnavailable = `the PR could not be read back (${(err as Error).message.split('\n')[0]})`;
    }
  }

  const liveWindow =
    liveAll === null
      ? null
      : liveAll.filter((c) => {
          const at = Date.parse(c.createdAt);
          return !Number.isFinite(at) || at >= floor;
        });

  // Identity by confirmed write: a comment matching a key this run planned to
  // post IS this run's. The modal author of that set is us — no provider needs
  // to grow a whoami() for it.
  let selfAuthor: string | null = null;
  if (liveWindow) {
    const votes = new Map<string, number>();
    for (const c of liveWindow) {
      if (!c.file) continue;
      if (!expectedKeys.has(commentKey(c.file, c.line, c.body))) continue;
      votes.set(c.author, (votes.get(c.author) ?? 0) + 1);
    }
    selfAuthor = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  const capabilityFiles: Record<string, string> = {};
  for (const file of existsSync(runDir) ? readdirSync(runDir) : []) {
    if (file.startsWith('capability-') && file.endsWith('.json')) {
      capabilityFiles[file.slice('capability-'.length, -'.json'.length)] = join(runDir, file);
    }
  }

  return {
    runId,
    runDir,
    offline: !!opts.offline,
    gather,
    plan,
    state,
    finalization,
    marker: readPostedMarker(runDir, opts.home),
    findings,
    stack: readJson<StackArtifact>(join(runDir, 'stack.json')),
    routes,
    capabilities,
    companions: readJson<CompanionsArtifact>(join(runDir, 'companions.json')),
    errorTxt: readFileSafe(join(runDir, ERROR_FILE)),
    capabilityUsage: Object.keys(capabilityFiles).length > 0 ? readCapabilityUsage(capabilityFiles) : { usage: [], warnings: [] },
    home: opts.home,
    postingShape,
    expectedKeys,
    liveWindow,
    liveAll,
    liveMetadata,
    liveUnavailable,
    selfAuthor,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Every registered ID gets exactly one row, in registry order then test-only
 * order. A check that throws becomes FAIL — the one thing a row must never do
 * is disappear, because a missing row reads as "fine" to every human and every
 * CI parser.
 */
export function runChecks(ctx: VerifyContext): VerifyRow[] {
  const rows: VerifyRow[] = [];
  for (const check of CHECKS) {
    if (check.needs === 'run+pr' && ctx.liveWindow === null) {
      rows.push({ id: check.id, status: 'skip', evidence: ctx.liveUnavailable ?? 'the PR was not read back' });
      continue;
    }
    try {
      const result = check.run(ctx);
      rows.push({ id: check.id, status: result.status, evidence: result.evidence });
    } catch (err) {
      rows.push({ id: check.id, status: 'fail', evidence: `check threw: ${(err as Error).message}` });
    }
  }
  for (const [id, reason] of Object.entries(TEST_ONLY)) rows.push({ id, status: 'skip', evidence: reason });
  return rows;
}

function renderText(ctx: VerifyContext, rows: VerifyRow[]): string {
  const width = Math.max(...rows.map((r) => r.id.length));
  const lines = rows.map((r) => `${r.id.padEnd(width)}  ${r.status.toUpperCase().padEnd(4)}  ${r.evidence}`);
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const r of rows) counts[r.status]++;
  return [
    `run ${ctx.runId}`,
    `pr  ${ctx.gather.pr.url}`,
    '',
    ...lines,
    '',
    `${rows.length} invariants: ${counts.pass} PASS, ${counts.skip} SKIP, ${counts.fail} FAIL`,
  ].join('\n');
}

export async function runVerify(opts: {
  runId?: string;
  prUrl?: string;
  offline?: boolean;
  json?: boolean;
  home?: string;
}): Promise<number> {
  const ctx = await loadVerifyContext(opts);
  const rows = runChecks(ctx);
  const exitCode = rows.some((r) => r.status === 'fail') ? 2 : 0;
  process.stdout.write(
    opts.json
      ? JSON.stringify({ runId: ctx.runId, prUrl: ctx.gather.pr.url, rows, exitCode }, null, 2) + '\n'
      : renderText(ctx, rows) + '\n',
  );
  return exitCode;
}
