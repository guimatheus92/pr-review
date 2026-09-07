import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Finding, PrMetadata, PrRef, ReviewerOutput, Severity } from '../types.js';
import { atomicFileExistsSync, atomicWriteFileSync, atomicWriteJsonSync, canonicalJson, readAtomicFileSync, sha256, sha256File } from '../util/atomic-json.js';
import type { Runtime } from './runtime.js';
import { readAuthenticatedJsonSync, writeAuthenticatedJsonSync } from '../util/control-auth.js';
import { controlDirForRun } from '../util/tmp.js';

export const DISPATCH_PLAN_SCHEMA_VERSION = 1;
export const DELIVERY_STATE_SCHEMA_VERSION = 1;
export const OUTPUT_PATH_TOKEN = '{{PR_REVIEW_OUTPUT_PATH}}';

export type PlannedReviewerKind = 'pass' | 'companion-agent' | 'companion-slash';
export type ReviewerDeliveryStatus = 'valid' | 'missing' | 'invalid';

export interface DispatchReviewerPlan {
  name: string;
  kind: PlannedReviewerKind;
  description: string;
  agentType: string;
  promptTemplate: string;
  canonicalOutputPath: string;
  attemptsDir: string;
  capabilityPath?: string;
  source?: string;
  matchedBy?: string;
  maxAttempts: number;
}

export interface DispatchVerifierPlan {
  enabled: boolean;
  promptTemplate?: string;
  canonicalOutputPath?: string;
  attemptsDir?: string;
  maxAttempts: number;
}

export interface DispatchPlanArtifact {
  path: string;
  sha256: string;
}

export interface DispatchPlan {
  schemaVersion: typeof DISPATCH_PLAN_SCHEMA_VERSION;
  fingerprint: string;
  runId: string;
  runDir: string;
  createdAt: string;
  pr: PrRef;
  metadata: Pick<PrMetadata, 'headSha' | 'baseSha' | 'headBranch' | 'baseBranch' | 'state' | 'isDraft'>;
  runtime: Runtime;
  runtimeBinary: string;
  repoRoot?: string;
  disabledMcpServers: string[];
  model: string;
  timeoutMs: number;
  phase1Path: string;
  findingsPath: string;
  execution: {
    dryRun: boolean;
    publish: boolean;
    dedupeMode: 'strict' | 'loose' | 'off';
    failOn?: Severity;
  };
  configProjection: unknown;
  configFingerprint: string;
  cliArtifact?: DispatchPlanArtifact;
  artifacts: DispatchPlanArtifact[];
  reviewers: DispatchReviewerPlan[];
  verifier: DispatchVerifierPlan;
  codex: {
    enabled: boolean;
    contextPath: string;
    skillsPath?: string;
    attemptsDir: string;
    maxAttempts: number;
  };
}

export interface RuntimeAttemptState {
  number: number;
  kind: 'initial' | 'automatic-recovery' | 'manual-recovery' | 'verifier';
  reviewers: string[];
  startedAt: string;
  endedAt: string;
  exitCode: number;
  timedOut: boolean;
  timeoutMs: number;
  durationMs: number;
}

export type VerifierDeliveryState =
  | 'not-evaluated'
  | 'skipped-disabled'
  | 'skipped-no-severe'
  | 'required'
  | 'valid'
  | 'missing'
  | 'invalid';

export interface DeliveryState {
  schemaVersion: typeof DELIVERY_STATE_SCHEMA_VERSION;
  planFingerprint: string;
  updatedAt: string;
  kind: 'running' | 'complete' | 'recoverable-incomplete' | 'terminal-incomplete';
  planned: string[];
  valid: string[];
  missing: string[];
  invalid: string[];
  recoveredFindingCount: number;
  severityCounts: Record<Severity, number>;
  reviewerAttempts: Record<string, number>;
  reviewerDigests: Record<string, string>;
  runtimeAttempts: RuntimeAttemptState[];
  phase1: 'missing' | 'invalid' | 'valid';
  phase1Digest?: string;
  consolidated: 'missing' | 'invalid' | 'valid';
  consolidatedDigest?: string;
  verifier: { state: VerifierDeliveryState; phase1Digest?: string; digest?: string; attempts: number };
  codex: {
    state: 'disabled' | 'pending' | 'valid' | 'failed';
    attempts: number;
    output?: ReviewerOutput;
  };
  reasonCodes: string[];
}

export interface ReviewerDelivery {
  name: string;
  path: string;
  status: ReviewerDeliveryStatus;
  output?: ReviewerOutput;
  bytes?: number;
  sha256?: string;
  error?: string;
}

export interface DeliveryInventory {
  planned: string[];
  deliveries: ReviewerDelivery[];
  valid: string[];
  missing: string[];
  invalid: string[];
  outputs: ReviewerOutput[];
  complete: boolean;
  recoveredFindingCount: number;
  severityCounts: Record<Severity, number>;
}

export interface PromotionResult {
  reviewer: string;
  attempt: number;
  status: ReviewerDeliveryStatus | 'collision';
  path: string;
  canonicalPath: string;
  error?: string;
}

type DispatchPlanDraft = Omit<DispatchPlan, 'schemaVersion' | 'fingerprint'>;

const SEVERITIES: readonly Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NIT'];
const EMPTY_SEVERITY_COUNTS = (): Record<Severity, number> => ({
  CRITICAL: 0,
  HIGH: 0,
  MEDIUM: 0,
  LOW: 0,
  NIT: 0,
});

export function isPathInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function findingShaped(value: unknown): value is Finding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const finding = value as Record<string, unknown>;
  if (!SEVERITIES.includes(finding.severity as Severity)) return false;
  if (typeof finding.title !== 'string' || typeof finding.body !== 'string') return false;
  if (finding.file !== undefined && typeof finding.file !== 'string') return false;
  if (finding.line !== undefined && (!Number.isInteger(finding.line) || (finding.line as number) < 1)) return false;
  if (finding.endLine !== undefined && (!Number.isInteger(finding.endLine) || (finding.endLine as number) < 1)) return false;
  return true;
}

function parseSidecar(
  reviewerName: string,
  path: string,
  model: string,
  durationMs: number,
): ReviewerDelivery {
  if (!existsSync(path)) return { name: reviewerName, path, status: 'missing' };
  try {
    const rawOutput = readFileSync(path, 'utf8');
    const parsed = JSON.parse(rawOutput) as unknown;
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    if (!parsed.every(findingShaped)) throw new Error('array contains an invalid finding');
    const findings = parsed as Finding[];
    return {
      name: reviewerName,
      path,
      status: 'valid',
      output: { reviewerName, model, findings, rawOutput, durationMs, exitCode: 0 },
      bytes: Buffer.byteLength(rawOutput),
      sha256: sha256(rawOutput),
    };
  } catch (error) {
    return { name: reviewerName, path, status: 'invalid', error: (error as Error).message };
  }
}

export function createDispatchPlan(draft: DispatchPlanDraft): DispatchPlan {
  const core: Omit<DispatchPlan, 'fingerprint'> = { schemaVersion: DISPATCH_PLAN_SCHEMA_VERSION, ...draft };
  return { ...core, fingerprint: sha256(canonicalJson(core)) };
}

function dispatchPlanShaped(value: unknown): value is DispatchPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<DispatchPlan>;
  return plan.schemaVersion === DISPATCH_PLAN_SCHEMA_VERSION &&
    typeof plan.fingerprint === 'string' &&
    typeof plan.runId === 'string' &&
    typeof plan.runDir === 'string' &&
    typeof plan.phase1Path === 'string' &&
    typeof plan.findingsPath === 'string' &&
    Array.isArray(plan.reviewers) &&
    !!plan.verifier &&
    typeof plan.verifier === 'object' &&
    !!plan.codex &&
    typeof plan.codex === 'object';
}

function validatePlanPaths(plan: DispatchPlan): void {
  const paths = [
    plan.phase1Path,
    plan.findingsPath,
    ...plan.artifacts.map((artifact) => artifact.path),
    ...plan.reviewers.flatMap((reviewer) => [reviewer.canonicalOutputPath, reviewer.attemptsDir]),
    ...(plan.verifier.canonicalOutputPath ? [plan.verifier.canonicalOutputPath] : []),
    ...(plan.verifier.attemptsDir ? [plan.verifier.attemptsDir] : []),
    plan.codex.contextPath,
    plan.codex.attemptsDir,
    ...(plan.codex.skillsPath ? [plan.codex.skillsPath] : []),
  ];
  if (paths.some((path) => !isPathInside(plan.runDir, path))) {
    throw new Error('dispatch plan contains a path outside its run directory');
  }
  const names = plan.reviewers.map((reviewer) => reviewer.name);
  if (new Set(names).size !== names.length) throw new Error('dispatch plan contains duplicate reviewer names');
  const canonicalPaths = plan.reviewers.map((reviewer) => resolve(reviewer.canonicalOutputPath).toLowerCase());
  if (new Set(canonicalPaths).size !== canonicalPaths.length) {
    throw new Error('dispatch plan contains colliding reviewer output paths');
  }
  const attemptPaths = plan.reviewers.map((reviewer) => resolve(reviewer.attemptsDir).toLowerCase());
  if (new Set(attemptPaths).size !== attemptPaths.length) {
    throw new Error('dispatch plan contains colliding reviewer attempt paths');
  }
}

export function readDispatchPlan(path: string): DispatchPlan {
  const parsed = JSON.parse(readAtomicFileSync(path)) as unknown;
  if (!dispatchPlanShaped(parsed)) throw new Error('unsupported or malformed dispatch plan');
  const { fingerprint, ...core } = parsed;
  if (fingerprint !== sha256(canonicalJson(core))) throw new Error('dispatch plan fingerprint mismatch');
  validatePlanPaths(parsed);
  return parsed;
}

export function readAuthoritativeDispatchPlan(path: string): DispatchPlan {
  const parsed = readAuthenticatedJsonSync<unknown>(path);
  if (!dispatchPlanShaped(parsed)) throw new Error('unsupported or malformed authoritative dispatch plan');
  const { fingerprint, ...core } = parsed;
  if (fingerprint !== sha256(canonicalJson(core))) throw new Error('dispatch plan fingerprint mismatch');
  validatePlanPaths(parsed);
  return parsed;
}

export function writeDispatchPlan(plan: DispatchPlan, mirrorPath: string, authoritativePath?: string): void {
  validatePlanPaths(plan);
  if (authoritativePath) {
    mkdirSync(dirname(authoritativePath), { recursive: true });
    writeAuthenticatedJsonSync(authoritativePath, plan);
  }
  try {
    atomicWriteJsonSync(mirrorPath, plan);
  } catch (error) {
    if (!authoritativePath) throw error;
    process.stderr.write(`[delivery] could not write dispatch-plan mirror: ${(error as Error).message}\n`);
  }
}

export function assertDispatchPlanMirrors(planPath: string, authoritativePath: string): DispatchPlan {
  const plan = readAuthoritativeDispatchPlan(authoritativePath);
  let repair = !existsSync(planPath);
  if (!repair) {
    try {
      const mirror = readDispatchPlan(planPath);
      repair = plan.fingerprint !== mirror.fingerprint;
    } catch {
      repair = true;
    }
  }
  if (repair) atomicWriteJsonSync(planPath, plan);
  return plan;
}

export function validateDispatchArtifacts(plan: DispatchPlan): string[] {
  const failures: string[] = [];
  for (const artifact of plan.artifacts) {
    if (!existsSync(artifact.path)) {
      failures.push(`immutable artifact missing: ${artifact.path}`);
    } else if (sha256File(artifact.path) !== artifact.sha256) {
      failures.push(`immutable artifact changed: ${artifact.path}`);
    }
  }
  if (plan.cliArtifact) {
    if (!existsSync(plan.cliArtifact.path)) {
      failures.push(`CLI artifact missing: ${plan.cliArtifact.path}`);
    } else if (sha256File(plan.cliArtifact.path) !== plan.cliArtifact.sha256) {
      failures.push(`CLI artifact changed: ${plan.cliArtifact.path}`);
    }
  }
  if (sha256(canonicalJson(plan.configProjection)) !== plan.configFingerprint) {
    failures.push('trusted configuration fingerprint mismatch');
  }
  return failures;
}

export function attemptOutputPath(reviewer: Pick<DispatchReviewerPlan, 'attemptsDir'>, attempt: number): string {
  return join(reviewer.attemptsDir, `attempt-${attempt}.json`);
}

export function verifierAttemptOutputPath(verifier: DispatchVerifierPlan, attempt: number): string {
  if (!verifier.attemptsDir) throw new Error('verifier attempts directory is unavailable');
  return join(verifier.attemptsDir, `attempt-${attempt}.json`);
}

export function renderAttemptPrompt(promptTemplate: string, outputPath: string): string {
  if (!promptTemplate.includes(OUTPUT_PATH_TOKEN)) throw new Error('reviewer prompt has no output-path token');
  return promptTemplate.split(OUTPUT_PATH_TOKEN).join(outputPath);
}

/** Classify every expected sidecar in plan order. Empty arrays are valid completed reviews. */
export function inspectReviewerDelivery(
  files: Readonly<Record<string, string>>,
  model: string,
  durationMs: number,
): DeliveryInventory {
  const deliveries = Object.entries(files).map(([name, path]) => parseSidecar(name, path, model, durationMs));
  const outputs = deliveries.flatMap((delivery) => delivery.output ? [delivery.output] : []);
  const severityCounts = EMPTY_SEVERITY_COUNTS();
  for (const finding of outputs.flatMap((output) => output.findings)) severityCounts[finding.severity]++;
  return {
    planned: deliveries.map((delivery) => delivery.name),
    deliveries,
    valid: deliveries.filter((delivery) => delivery.status === 'valid').map((delivery) => delivery.name),
    missing: deliveries.filter((delivery) => delivery.status === 'missing').map((delivery) => delivery.name),
    invalid: deliveries.filter((delivery) => delivery.status === 'invalid').map((delivery) => delivery.name),
    outputs,
    complete: deliveries.length > 0 && outputs.length === deliveries.length,
    recoveredFindingCount: outputs.reduce((count, output) => count + output.findings.length, 0),
    severityCounts,
  };
}

/** Validate an attempt artifact and promote its exact bytes to a write-once canonical sidecar. */
export function promoteReviewerAttempt(
  reviewer: DispatchReviewerPlan,
  attempt: number,
  model: string,
  durationMs: number,
): PromotionResult {
  const path = attemptOutputPath(reviewer, attempt);
  const candidate = parseSidecar(reviewer.name, path, model, durationMs);
  if (candidate.status !== 'valid') {
    const canonicalAppeared = existsSync(reviewer.canonicalOutputPath);
    return {
      reviewer: reviewer.name,
      attempt,
      status: canonicalAppeared ? 'collision' : candidate.status,
      path,
      canonicalPath: reviewer.canonicalOutputPath,
      error: canonicalAppeared
        ? 'canonical sidecar exists without a valid attempt-scoped artifact'
        : candidate.error,
    };
  }
  if (existsSync(reviewer.canonicalOutputPath)) {
    const canonical = parseSidecar(reviewer.name, reviewer.canonicalOutputPath, model, durationMs);
    if (canonical.status !== 'valid' || canonical.sha256 !== candidate.sha256) {
      return {
        reviewer: reviewer.name,
        attempt,
        status: 'collision',
        path,
        canonicalPath: reviewer.canonicalOutputPath,
        error: 'attempt output differs from the existing canonical sidecar',
      };
    }
    return { reviewer: reviewer.name, attempt, status: 'valid', path, canonicalPath: reviewer.canonicalOutputPath };
  }
  const contents = readFileSync(path, 'utf8');
  const tempPath = join(
    dirname(reviewer.canonicalOutputPath),
    `.${basename(reviewer.canonicalOutputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, 'wx');
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(tempPath, reviewer.canonicalOutputPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original create error.
      }
    }
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = parseSidecar(reviewer.name, reviewer.canonicalOutputPath, model, durationMs);
    if (winner.status !== 'valid' || winner.sha256 !== candidate.sha256) {
      return {
        reviewer: reviewer.name,
        attempt,
        status: 'collision',
        path,
        canonicalPath: reviewer.canonicalOutputPath,
        error: 'canonical sidecar was concurrently created with different bytes',
      };
    }
  } finally {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* Canonical publication already decided. */ }
  }
  return { reviewer: reviewer.name, attempt, status: 'valid', path, canonicalPath: reviewer.canonicalOutputPath };
}

export function promoteVerifierAttempt(
  verifier: DispatchVerifierPlan,
  attempt: number,
  model: string,
  durationMs: number,
): PromotionResult {
  if (!verifier.canonicalOutputPath || !verifier.attemptsDir) {
    throw new Error('verifier output paths are unavailable');
  }
  return promoteReviewerAttempt(
    {
      name: 'verifier',
      kind: 'pass',
      description: 'Reconcile findings',
      agentType: 'direct',
      promptTemplate: verifier.promptTemplate ?? OUTPUT_PATH_TOKEN,
      canonicalOutputPath: verifier.canonicalOutputPath,
      attemptsDir: verifier.attemptsDir,
      maxAttempts: verifier.maxAttempts,
    },
    attempt,
    model,
    durationMs,
  );
}

export function hasSevereFindings(outputs: readonly ReviewerOutput[]): boolean {
  return outputs.some((output) => output.findings.some(
    (finding) => finding.severity === 'CRITICAL' || finding.severity === 'HIGH',
  ));
}

function consolidatedPayload(outputs: readonly ReviewerOutput[]): {
  reviewers: Array<{ name: string; findings: Finding[] }>;
} {
  return { reviewers: outputs.map((output) => ({ name: output.reviewerName, findings: output.findings })) };
}

/** Assemble Phase 1 only after every planned reviewer has delivered valid output. */
export function assemblePhase1(path: string, inventory: DeliveryInventory): void {
  if (!inventory.complete) {
    throw new Error(
      `incomplete reviewer delivery: ${inventory.valid.length}/${inventory.planned.length} valid, ` +
      `${inventory.missing.length} missing, ${inventory.invalid.length} invalid`,
    );
  }
  atomicWriteJsonSync(path, consolidatedPayload(inventory.outputs));
}

export function assembleConsolidated(
  path: string,
  phase1Outputs: readonly ReviewerOutput[],
  verifier?: ReviewerOutput,
): void {
  atomicWriteJsonSync(path, consolidatedPayload(verifier ? [...phase1Outputs, verifier] : phase1Outputs));
}

export function artifactState(path: string): 'missing' | 'invalid' | 'valid' {
  if (!existsSync(path)) return 'missing';
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { reviewers?: unknown };
    return parsed && Array.isArray(parsed.reviewers) ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}

export function createDeliveryState(
  plan: DispatchPlan,
  inventory: DeliveryInventory,
  previous?: DeliveryState,
): DeliveryState {
  const reviewerAttempts = { ...(previous?.reviewerAttempts ?? {}) };
  for (const reviewer of plan.reviewers) reviewerAttempts[reviewer.name] ??= 0;
  const reviewerDigests = Object.fromEntries(
    inventory.deliveries.flatMap((delivery) =>
      delivery.status === 'valid' && delivery.sha256 ? [[delivery.name, delivery.sha256]] : []),
  );
  const exhausted = inventory.deliveries
    .filter((delivery) => delivery.status !== 'valid')
    .some((delivery) =>
      (reviewerAttempts[delivery.name] ?? 0) >=
      (plan.reviewers.find((reviewer) => reviewer.name === delivery.name)?.maxAttempts ?? 0));
  return {
    schemaVersion: DELIVERY_STATE_SCHEMA_VERSION,
    planFingerprint: plan.fingerprint,
    updatedAt: new Date().toISOString(),
    kind: inventory.complete ? 'running' : exhausted ? 'terminal-incomplete' : 'recoverable-incomplete',
    planned: inventory.planned,
    valid: inventory.valid,
    missing: inventory.missing,
    invalid: inventory.invalid,
    recoveredFindingCount: inventory.recoveredFindingCount,
    severityCounts: inventory.severityCounts,
    reviewerAttempts,
    reviewerDigests,
    runtimeAttempts: previous?.runtimeAttempts ?? [],
    phase1: previous?.phase1 ?? artifactState(plan.phase1Path),
    phase1Digest: previous?.phase1Digest,
    consolidated: previous?.consolidated ?? artifactState(plan.findingsPath),
    consolidatedDigest: previous?.consolidatedDigest,
    verifier: previous?.verifier ?? { state: 'not-evaluated', attempts: 0 },
    codex: previous?.codex ?? { state: plan.codex.enabled ? 'pending' : 'disabled', attempts: 0 },
    reasonCodes: inventory.complete ? [] : [exhausted ? 'attempts-exhausted' : 'reviewer-delivery-incomplete'],
  };
}

export function recordCodexResult(plan: DispatchPlan, state: DeliveryState, output: ReviewerOutput): DeliveryState {
  state.codex = {
    state: output.error ? 'failed' : 'valid',
    attempts: state.codex.attempts,
    output,
  };
  return reconcileDeliveryCompletion(plan, state);
}

export function reserveCodexAttempt(plan: DispatchPlan, state: DeliveryState): DeliveryState {
  if (!plan.codex.enabled) throw new Error('Codex is disabled for this run');
  if (state.codex.attempts >= plan.codex.maxAttempts) throw new Error('Codex attempts are exhausted');
  state.codex = { state: 'pending', attempts: state.codex.attempts + 1 };
  state.kind = 'running';
  state.reasonCodes = ['codex-running'];
  state.updatedAt = new Date().toISOString();
  return state;
}

export function reconcileDeliveryCompletion(plan: DispatchPlan, state: DeliveryState): DeliveryState {
  const primaryComplete = state.consolidated === 'valid' &&
    state.valid.length === state.planned.length &&
    state.missing.length === 0 &&
    state.invalid.length === 0 &&
    ['valid', 'skipped-disabled', 'skipped-no-severe'].includes(state.verifier.state);
  if (!primaryComplete) return state;
  if (!plan.codex.enabled || state.codex.state === 'valid') {
    state.kind = 'complete';
    state.reasonCodes = [];
  } else {
    state.kind = state.codex.attempts >= plan.codex.maxAttempts ? 'terminal-incomplete' : 'recoverable-incomplete';
    state.reasonCodes = ['codex-delivery-incomplete'];
  }
  state.updatedAt = new Date().toISOString();
  return state;
}

export function readDeliveryState(path: string, plan: DispatchPlan): DeliveryState | undefined {
  if (!atomicFileExistsSync(path)) return undefined;
  const state = JSON.parse(readAtomicFileSync(path)) as DeliveryState;
  if (state.schemaVersion !== DELIVERY_STATE_SCHEMA_VERSION || state.planFingerprint !== plan.fingerprint) {
    throw new Error('delivery state does not match the dispatch plan');
  }
  return state;
}

function validateDeliveryState(state: DeliveryState, plan: DispatchPlan): DeliveryState {
  if (state.schemaVersion !== DELIVERY_STATE_SCHEMA_VERSION || state.planFingerprint !== plan.fingerprint) {
    throw new Error('delivery state does not match the dispatch plan');
  }
  return state;
}

export function readAuthoritativeDeliveryState(path: string, plan: DispatchPlan): DeliveryState {
  return validateDeliveryState(readAuthenticatedJsonSync<DeliveryState>(path), plan);
}

export function writeDeliveryState(state: DeliveryState, mirrorPath: string, authoritativePath?: string): void {
  if (authoritativePath) {
    mkdirSync(dirname(authoritativePath), { recursive: true });
    writeAuthenticatedJsonSync(authoritativePath, state);
  }
  try {
    atomicWriteJsonSync(mirrorPath, state);
  } catch (error) {
    if (!authoritativePath) throw error;
    process.stderr.write(`[delivery] could not write delivery-state mirror: ${(error as Error).message}\n`);
  }
}

export function repairDeliveryStateMirror(path: string, authoritativePath: string, plan: DispatchPlan): DeliveryState {
  const state = readAuthoritativeDeliveryState(authoritativePath, plan);
  let repair = !existsSync(path);
  if (!repair) {
    try {
      const mirror = readDeliveryState(path, plan);
      repair = !mirror || canonicalJson(mirror) !== canonicalJson(state);
    } catch {
      repair = true;
    }
  }
  if (repair) atomicWriteJsonSync(path, state);
  return state;
}

export function validateDeliveryArtifacts(plan: DispatchPlan, state: DeliveryState): string[] {
  const failures: string[] = [];
  for (const reviewer of plan.reviewers) {
    const expected = state.reviewerDigests[reviewer.name];
    if (!expected) continue;
    if (!existsSync(reviewer.canonicalOutputPath)) {
      failures.push(`canonical reviewer output missing: ${reviewer.name}`);
    } else if (sha256File(reviewer.canonicalOutputPath) !== expected) {
      failures.push(`canonical reviewer output changed: ${reviewer.name}`);
    }
  }
  if (state.phase1 === 'valid') {
    if (!state.phase1Digest || !existsSync(plan.phase1Path) || sha256File(plan.phase1Path) !== state.phase1Digest) {
      failures.push('Phase 1 artifact digest mismatch');
    }
  }
  if (state.consolidated === 'valid') {
    if (!state.consolidatedDigest || !existsSync(plan.findingsPath) || sha256File(plan.findingsPath) !== state.consolidatedDigest) {
      failures.push('consolidated artifact digest mismatch');
    }
  }
  if (state.verifier.state === 'valid' && plan.verifier.canonicalOutputPath) {
    if (!state.verifier.digest || !existsSync(plan.verifier.canonicalOutputPath) || sha256File(plan.verifier.canonicalOutputPath) !== state.verifier.digest) {
      failures.push('verifier artifact digest mismatch');
    }
  }
  return failures;
}

export interface FinalizationRecord {
  schemaVersion: 1;
  planFingerprint: string;
  completedAt: string;
  exitCode: 0 | 1 | 2;
  summaryPath: string;
  summaryDigest: string;
  findingsPath: string;
  findingsDigest: string;
}

export function writeFinalizationRecord(
  outDir: string,
  homeOverride: string | undefined,
  record: FinalizationRecord,
): void {
  writeAuthenticatedJsonSync(join(controlDirForRun(outDir, homeOverride), 'finalization.json'), record);
  atomicWriteJsonSync(join(outDir, 'finalization.json'), record);
}

export function readAuthoritativeFinalization(
  outDir: string,
  homeOverride: string | undefined,
  plan: DispatchPlan,
): FinalizationRecord | null {
  const path = join(controlDirForRun(outDir, homeOverride), 'finalization.json');
  try {
    if (!atomicFileExistsSync(path)) return null;
    const record = readAuthenticatedJsonSync<FinalizationRecord>(path);
    if (record.schemaVersion !== 1 || record.planFingerprint !== plan.fingerprint) {
      throw new Error('finalization record does not match the dispatch plan');
    }
    if (!isPathInside(plan.runDir, record.summaryPath) || !isPathInside(plan.runDir, record.findingsPath)) {
      throw new Error('finalization record contains a path outside its run directory');
    }
    if (!existsSync(record.summaryPath) || sha256File(record.summaryPath) !== record.summaryDigest) {
      throw new Error('finalization summary digest mismatch');
    }
    if (!existsSync(record.findingsPath) || sha256File(record.findingsPath) !== record.findingsDigest) {
      throw new Error('finalization findings digest mismatch');
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}