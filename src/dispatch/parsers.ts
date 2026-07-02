import type { Finding, Severity } from '../types.js';

const SEVERITY_TOKENS: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NIT'];

function extractJsonBlock(raw: string): string | null {
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fence) return fence[1];
  const first = raw.indexOf('{');
  const firstArr = raw.indexOf('[');
  let start = -1;
  if (first === -1) start = firstArr;
  else if (firstArr === -1) start = first;
  else start = Math.min(first, firstArr);
  if (start === -1) return null;
  const balanced = sliceBalancedJson(raw, start);
  return balanced ?? raw.slice(start).trim();
}

/**
 * Slice from `start` to the position where the opening brace/bracket closes,
 * tracking string literals and escapes — LLM output routinely has trailing
 * prose after the JSON, which would otherwise defeat JSON.parse.
 */
function sliceBalancedJson(raw: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJsonFindings(raw: string): Finding[] {
  const block = extractJsonBlock(raw);
  if (!block) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => normalizeFinding(item))
    .filter((f): f is Finding => f !== null);
}

function normalizeFinding(item: unknown): Finding | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  const severityRaw = String(o.severity ?? o.type ?? 'MEDIUM').toUpperCase();
  const severity: Severity = (SEVERITY_TOKENS as string[]).includes(severityRaw)
    ? (severityRaw as Severity)
    : 'MEDIUM';
  const title = String(o.title ?? o.summary ?? '').trim();
  const body = String(o.body ?? o.description ?? o.message ?? '').trim();
  if (!title && !body) return null;
  const location = o.location as { file?: string; line?: number; endLine?: number } | undefined;
  return {
    severity,
    title: title || body.split('\n')[0]!,
    body: body || title,
    file: (o.file as string | undefined) ?? location?.file,
    line: (o.line as number | undefined) ?? location?.line,
    endLine: (o.endLine as number | undefined) ?? location?.endLine,
  };
}

const SEV_BRACKETED_RE = new RegExp(
  `[\\[(*_]\\s*(${SEVERITY_TOKENS.join('|')})\\s*[\\])*_]`,
  'i',
);
const SEV_BRACKETED_RE_GLOBAL = new RegExp(SEV_BRACKETED_RE.source, 'gi');

const FILE_LINE_RE =
  /(?<![:./\w])([\w.\-/\\]+\.[a-zA-Z][a-zA-Z0-9]{0,9}|[\w.\-/\\]+\/[\w.\-/\\]+):(\d+)(?:[-–](\d+))?/;

function looksLikeNarration(firstLine: string): boolean {
  const stripped = firstLine
    .replace(/^[#>*\-\d.\s]+/, '')
    .replace(/\*\*/g, '')
    .replace(SEV_BRACKETED_RE_GLOBAL, '')
    .trim()
    .toLowerCase();
  if (!stripped) return true;
  const narrationStarts = [
    "i'll ",
    'i will ',
    'let me ',
    'now i ',
    'now let me ',
    'wait, ',
    'wait — ',
    'thought for ',
    'thinking ',
  ];
  return narrationStarts.some((s) => stripped.startsWith(s));
}

export function parseMarkdownFindings(raw: string): Finding[] {
  const findings: Finding[] = [];
  const sections = raw.split(/\n(?=#{1,3}\s|[-*]\s\*\*|\d+\.\s)/);

  for (const section of sections) {
    const sev = section.match(SEV_BRACKETED_RE);
    if (!sev) continue;

    const fileLine = section.match(FILE_LINE_RE);
    if (!fileLine) continue;

    const firstLineRaw = section.split('\n')[0] ?? '';
    if (looksLikeNarration(firstLineRaw)) continue;

    const severity = sev[1]!.toUpperCase() as Severity;
    const firstLine = firstLineRaw
      .replace(/^#{1,3}\s*/, '')
      .replace(/^[-*]\s*/, '')
      .replace(/^\d+\.\s*/, '')
      .replace(/\*\*/g, '')
      .replace(SEV_BRACKETED_RE_GLOBAL, '')
      .replace(/^\s*[:\-—]+\s*/, '')
      .replace(/\s*[:\-—]+\s*$/, '')
      .trim();

    findings.push({
      severity,
      title: firstLine || section.split('\n')[0]!.trim(),
      body: section.trim(),
      file: fileLine[1],
      line: parseInt(fileLine[2]!, 10),
      endLine: fileLine[3] ? parseInt(fileLine[3], 10) : undefined,
    });
  }
  return findings;
}

const SECTION_SEV_MAP: Record<string, Severity> = {
  critical: 'CRITICAL',
  'critical issue': 'CRITICAL',
  'critical issues': 'CRITICAL',
  blocker: 'CRITICAL',
  blockers: 'CRITICAL',
  bug: 'CRITICAL',
  bugs: 'CRITICAL',
  high: 'HIGH',
  'high issue': 'HIGH',
  'high issues': 'HIGH',
  important: 'HIGH',
  'important issue': 'HIGH',
  'important issues': 'HIGH',
  major: 'HIGH',
  'major issue': 'HIGH',
  'major issues': 'HIGH',
  medium: 'MEDIUM',
  'medium issue': 'MEDIUM',
  'medium issues': 'MEDIUM',
  moderate: 'MEDIUM',
  'moderate issue': 'MEDIUM',
  'moderate issues': 'MEDIUM',
  low: 'LOW',
  'low issue': 'LOW',
  'low issues': 'LOW',
  minor: 'LOW',
  'minor issue': 'LOW',
  'minor issues': 'LOW',
  suggestion: 'LOW',
  suggestions: 'LOW',
  nit: 'NIT',
  nits: 'NIT',
  nitpick: 'NIT',
  nitpicks: 'NIT',
};

function sectionSeverityOf(line: string): Severity | null {
  if (!/^#{1,3}\s+/.test(line)) return null;
  const clean = line
    .replace(/^#+\s*/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[:!?.]+$/, '')
    .trim()
    .toLowerCase();
  return SECTION_SEV_MAP[clean] ?? null;
}

const NONE_RE = /^(none|n\/a|no\s+(issues?|findings?|comments?))\.?$/i;

function makeBulletFinding(bulletText: string, severity: Severity): Finding | null {
  const text = bulletText.trim();
  if (!text) return null;
  const cleaned = text.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim();
  if (NONE_RE.test(cleaned)) return null;
  const fl = cleaned.match(FILE_LINE_RE);
  if (!fl) return null;
  const boldMatch = cleaned.match(/^\*\*([^*]+)\*\*/);
  let title = boldMatch ? boldMatch[1]!.trim() : cleaned.split(/[—\n]/)[0]!.trim();
  title = title.replace(/[:.—\s]+$/, '').trim();
  return {
    severity,
    title: title || cleaned.slice(0, 80),
    body: cleaned,
    file: fl[1],
    line: parseInt(fl[2]!, 10),
  };
}

export function parseSectionedFindings(raw: string): Finding[] {
  const findings: Finding[] = [];
  const lines = raw.split('\n');
  let currentSeverity: Severity | null = null;
  let buffer: string[] = [];

  const flushBuffer = () => {
    if (!currentSeverity || buffer.length === 0) return;
    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) return;
    const f = makeBulletFinding(text, currentSeverity);
    if (f) findings.push(f);
  };

  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line)) {
      flushBuffer();
      currentSeverity = sectionSeverityOf(line);
      continue;
    }
    const isBullet = /^\s*([-*]\s|\d+\.\s)/.test(line);
    if (isBullet && currentSeverity) {
      flushBuffer();
      buffer = [line];
    } else if (buffer.length > 0 && line.trim()) {
      buffer.push(line);
    }
  }
  flushBuffer();
  return findings;
}

export function parseReviewerOutput(raw: string, preferredFormat: 'json' | 'markdown'): Finding[] {
  if (preferredFormat === 'json') {
    const json = parseJsonFindings(raw);
    if (json.length > 0) return json;
  }
  const md = parseMarkdownFindings(raw);
  if (md.length > 0) return md;
  const sectioned = parseSectionedFindings(raw);
  if (sectioned.length > 0) return sectioned;
  if (preferredFormat !== 'json') {
    return parseJsonFindings(raw);
  }
  return [];
}
