import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExistingComment, GatherOutput, ReviewerDefinition, SkillDefinition } from '../types.js';
import { filterFiles } from '../util/globs.js';

interface MaterializeOptions {
  reviewer: ReviewerDefinition;
  gather: GatherOutput;
  skills: SkillDefinition[];
  outDir: string;
}

export interface MaterializedPrompt {
  reviewerName: string;
  promptPath: string;
  hadMatchingFiles: boolean;
  matchedFileCount: number;
}

function renderMetadataBlock(gather: GatherOutput): string {
  const m = gather.metadata;
  const linked = m.linkedItems.length
    ? m.linkedItems
        .map((l) => `  - ${l.type} #${l.id}: ${l.title ?? '<no title>'} (${l.state ?? 'unknown state'})`)
        .join('\n')
    : '  (none)';
  return [
    `## PR Metadata`,
    `- **Title:** ${m.title}`,
    `- **Author:** ${m.author}`,
    `- **Branch:** ${m.headBranch} → ${m.baseBranch}`,
    `- **Head SHA:** ${m.headSha.slice(0, 12)}`,
    `- **Labels:** ${m.labels.length ? m.labels.join(', ') : '(none)'}`,
    `- **Draft:** ${m.isDraft ? 'yes' : 'no'}`,
    `- **State:** ${m.state}`,
    ``,
    `### Description`,
    m.description.trim() || '_(no description)_',
    ``,
    `### Linked Work Items / Issues`,
    linked,
  ].join('\n');
}

function renderExistingReviewsBlock(comments: ExistingComment[]): string {
  if (comments.length === 0) {
    return [
      `## Existing Reviews on This PR`,
      ``,
      `(none — this is a first-pass review)`,
    ].join('\n');
  }
  const ordered = comments
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const items = ordered.map((c) => {
    const loc = c.file ? ` (${c.file}${c.line ? `:${c.line}` : ''})` : '';
    return `- **${c.author}** [${c.source}]${loc}: ${c.body.replace(/\s+/g, ' ').slice(0, 320)}`;
  });
  return [
    `## Existing Reviews on This PR`,
    ``,
    `**Important: do NOT repeat findings already covered below. Only report NEW issues.**`,
    ``,
    ...items,
  ].join('\n');
}

function renderChangedFilesBlock(gather: GatherOutput, matched: string[]): string {
  const total = gather.changedFiles.length;
  const excluded = gather.changedFiles.filter((f) => f.excluded);
  const lines = [
    `## Files Changed`,
    `- ${total} files changed total; ${matched.length} match this reviewer's globs.`,
    excluded.length
      ? `- ${excluded.length} files excluded from the diff (lockfiles, generated, vendor): ${excluded
          .map((f) => f.path)
          .slice(0, 10)
          .join(', ')}${excluded.length > 10 ? '…' : ''}`
      : null,
  ].filter((s): s is string => s !== null);
  return lines.join('\n');
}

function renderDiffBlock(gather: GatherOutput, matchedPaths: Set<string>): string {
  const patches = gather.changedFiles
    .filter((f) => !f.excluded && f.patch && matchedPaths.has(f.path))
    .map(
      (f) =>
        `### ${f.path} (${f.status}, +${f.additions} -${f.deletions})\n\n\`\`\`diff\n${f.patch}\n\`\`\``,
    );
  if (patches.length === 0) {
    return [`## Diff`, ``, '_(no files in scope of this reviewer\'s globs)_'].join('\n');
  }
  return [`## Diff`, ``, ...patches].join('\n\n');
}

function renderSkillsBlock(skills: SkillDefinition[]): string {
  if (skills.length === 0) return '';
  const items = skills.map(
    (s) =>
      `### ${s.name}\n${s.description ? `_${s.description}_\n\n` : ''}${s.body.trim()}`,
  );
  return [
    `## Project-Specific Context (Skills)`,
    ``,
    `The following project conventions, business rules, and team standards apply. Treat them as authoritative requirements for this review.`,
    ``,
    ...items,
  ].join('\n\n');
}

function renderOutputInstructions(reviewer: ReviewerDefinition): string {
  if (reviewer.outputFormat === 'json') {
    return [
      `## Output Format (REQUIRED)`,
      ``,
      'Respond with a JSON array of findings. Each finding has these fields:',
      '```',
      '{',
      '  "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NIT",',
      '  "title": "short imperative summary",',
      '  "body": "explanation of the issue and what to change",',
      '  "file": "path/relative/to/repo.ext",',
      '  "line": <number in the new file>',
      '}',
      '```',
      '',
      'If you find nothing, respond with `[]`. Output ONLY the JSON. No prose. No markdown fences.',
    ].join('\n');
  }
  return [
    `## Output Format (REQUIRED)`,
    ``,
    'Respond with a Markdown list of findings. Use this exact format for each:',
    '',
    '`### [SEVERITY] Title`',
    '`<body — what is wrong and what to change>`',
    '`File: path/to/file.ext:LINE`',
    '',
    'SEVERITY must be one of CRITICAL, HIGH, MEDIUM, LOW, NIT.',
    'If you find nothing, output exactly: `No findings.`',
  ].join('\n');
}

export function materializeReviewerPrompt(opts: MaterializeOptions): MaterializedPrompt {
  const { reviewer, gather, skills, outDir } = opts;
  const safeName = reviewer.name.replace(/[\\\/:*?"<>|]/g, '_');

  if (reviewer.rawPrompt) {
    const promptPath = join(outDir, `prompt-${safeName}.md`);
    writeFileSync(promptPath, reviewer.promptBody, 'utf8');
    return {
      reviewerName: reviewer.name,
      promptPath,
      hadMatchingFiles: true,
      matchedFileCount: gather.changedFiles.filter((f) => !f.excluded).length,
    };
  }

  const matched = filterFiles(
    gather.changedFiles.filter((f) => !f.excluded),
    reviewer.appliesTo,
  );
  const matchedPaths = new Set(matched.map((f) => f.path));
  const applicableSkills = skills.filter((s) => {
    if (s.injectInto && s.injectInto.length > 0 && !s.injectInto.includes(reviewer.name)) {
      return false;
    }
    if (s.appliesTo.length === 0) return true;
    return matched.some((f) => filterFiles([f], s.appliesTo).length > 0);
  });

  const sections = [
    renderMetadataBlock(gather),
    renderExistingReviewsBlock(gather.existingComments),
    renderChangedFilesBlock(gather, matched.map((f) => f.path)),
    renderSkillsBlock(applicableSkills),
    `## Your Review Criteria`,
    reviewer.promptBody.trim(),
    renderDiffBlock(gather, matchedPaths),
    renderOutputInstructions(reviewer),
  ].filter(Boolean);

  const promptPath = join(outDir, `prompt-${safeName}.md`);
  writeFileSync(promptPath, sections.join('\n\n'), 'utf8');
  return {
    reviewerName: reviewer.name,
    promptPath,
    hadMatchingFiles: matched.length > 0,
    matchedFileCount: matched.length,
  };
}
