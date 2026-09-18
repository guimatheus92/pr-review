import type { Finding, ReviewerOutput, Severity } from '../types.js';
import { canonicalJson, sha256 } from '../util/atomic-json.js';

export interface FindingCandidate {
  id: string;
  reviewer: string;
  finding: Finding;
}

export type FindingDecision = {
  findingId: string;
  reason: string;
  evidence: string[];
} & (
  | { action: 'accept' | 'reject'; finding?: never }
  | { action: 'amend'; finding: Finding }
);

export interface Adjudication {
  schemaVersion: 1;
  decisions: FindingDecision[];
  additions: Finding[];
}

const SEVERITIES: readonly Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NIT'];

export function findingShaped(value: unknown): value is Finding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const finding = value as Record<string, unknown>;
  if (!SEVERITIES.includes(finding.severity as Severity)) return false;
  if (typeof finding.title !== 'string' || typeof finding.body !== 'string') return false;
  if (finding.file !== undefined && typeof finding.file !== 'string') return false;
  if (finding.line !== undefined && (!Number.isInteger(finding.line) || (finding.line as number) < 1)) return false;
  if (finding.endLine !== undefined && (!Number.isInteger(finding.endLine) || (finding.endLine as number) < 1)) return false;
  return true;
}

export function findingCandidates(outputs: readonly ReviewerOutput[]): FindingCandidate[] {
  const names = outputs.map(output => output.reviewerName);
  if (new Set(names).size !== names.length) throw new Error('duplicate candidate reviewer');
  return outputs.flatMap(output => output.findings.map((finding, index) => ({
    id: sha256(canonicalJson({ reviewer: output.reviewerName, index, finding })),
    reviewer: output.reviewerName,
    finding,
  })));
}

export function parseAdjudication(raw: string, candidates: readonly FindingCandidate[]): Adjudication {
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('adjudication exceeds 1 MiB');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an adjudication object');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.decisions) || !Array.isArray(record.additions) ||
      Object.keys(record).some(key => !['schemaVersion', 'decisions', 'additions'].includes(key))) {
    throw new Error('invalid adjudication shape');
  }
  const expected = new Set(candidates.map(candidate => candidate.id));
  if (expected.size !== candidates.length) throw new Error('duplicate candidate ID');
  const seen = new Set<string>();
  for (const value of record.decisions) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid finding decision');
    const decision = value as Record<string, unknown>;
    if (typeof decision.findingId !== 'string' || !expected.has(decision.findingId) || seen.has(decision.findingId)) {
      throw new Error('unknown or duplicate decision ID');
    }
    if (!['accept', 'reject', 'amend'].includes(String(decision.action)) ||
        typeof decision.reason !== 'string' || !decision.reason.trim() ||
        !Array.isArray(decision.evidence) || decision.evidence.length === 0 ||
        !decision.evidence.every(entry => typeof entry === 'string' && entry.trim()) ||
        Object.keys(decision).some(key => !['findingId', 'action', 'reason', 'evidence', 'finding'].includes(key))) {
      throw new Error('decision requires an action, reason, and evidence');
    }
    if (decision.action === 'amend' ? !findingShaped(decision.finding) : Object.hasOwn(decision, 'finding')) {
      throw new Error('only amendments carry a valid replacement finding');
    }
    seen.add(decision.findingId);
  }
  if (seen.size !== expected.size) throw new Error('incomplete adjudication coverage');
  if (!record.additions.every(findingShaped)) throw new Error('invalid adjudication addition');
  return record as unknown as Adjudication;
}

export function actionableFindings(candidates: readonly FindingCandidate[], adjudication: Adjudication): Finding[] {
  const validated = parseAdjudication(JSON.stringify(adjudication), candidates);
  const decisions = new Map(validated.decisions.map(decision => [decision.findingId, decision]));
  return [
    ...candidates.flatMap(candidate => {
      const decision = decisions.get(candidate.id)!;
      return decision.action === 'reject' ? [] : [decision.action === 'amend' ? decision.finding : candidate.finding];
    }),
    ...validated.additions,
  ];
}