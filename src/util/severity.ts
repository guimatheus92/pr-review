import type { Finding, Severity } from '../types.js';

export const SEVERITIES: readonly Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NIT'];

export interface PublicationMetadata {
  minimumSeverity: Severity;
  eligibleCount: number;
  suppressedCount: number;
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && SEVERITIES.includes(value as Severity);
}

export function parseSeverity(value: string | undefined, option: string): Severity | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toUpperCase();
  if (!isSeverity(normalized)) {
    throw new Error(`${option} must be one of: ${SEVERITIES.join(', ').toLowerCase()}`);
  }
  return normalized;
}

export function compareSeverity(left: Severity, right: Severity): number {
  const rank = (severity: Severity) => {
    const index = SEVERITIES.indexOf(severity);
    return index < 0 ? 99 : index;
  };
  return rank(left) - rank(right);
}

export function meetsSeverityThreshold(severity: Severity, minimumSeverity: Severity): boolean {
  if (!isSeverity(minimumSeverity)) throw new Error('invalid minimum severity');
  return compareSeverity(severity, minimumSeverity) <= 0;
}

export function partitionFindingsForPublication(
  finalFindings: readonly Finding[],
  minimumSeverity: Severity = 'NIT',
): {
  publicationEligibleFindings: Finding[];
  suppressedByPublicationFilter: Finding[];
  publication: PublicationMetadata;
} {
  if (!isSeverity(minimumSeverity)) throw new Error('invalid publication minimum severity');
  const publicationEligibleFindings: Finding[] = [];
  const suppressedByPublicationFilter: Finding[] = [];
  for (const finding of finalFindings) {
    if (!isSeverity(finding.severity)) throw new Error('invalid finding severity');
    (meetsSeverityThreshold(finding.severity, minimumSeverity)
      ? publicationEligibleFindings
      : suppressedByPublicationFilter).push(finding);
  }
  return {
    publicationEligibleFindings,
    suppressedByPublicationFilter,
    publication: {
      minimumSeverity,
      eligibleCount: publicationEligibleFindings.length,
      suppressedCount: suppressedByPublicationFilter.length,
    },
  };
}