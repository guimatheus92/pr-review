import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseJsonFindings, parseMarkdownFindings, parseSectionedFindings, parseReviewerOutput } from '../src/dispatch/parsers.js';

test('parseJsonFindings — bare JSON array', () => {
  const raw = `[{"severity":"HIGH","title":"SQL injection","body":"User input concatenated into query","file":"db.ts","line":42}]`;
  const result = parseJsonFindings(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.severity, 'HIGH');
  assert.equal(result[0]!.file, 'db.ts');
  assert.equal(result[0]!.line, 42);
});

test('parseJsonFindings — JSON inside fenced code block', () => {
  const raw = '```json\n[{"severity":"CRITICAL","title":"x","body":"y"}]\n```';
  const result = parseJsonFindings(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.severity, 'CRITICAL');
});

test('parseJsonFindings — object with findings array', () => {
  const raw = `{"findings":[{"severity":"LOW","title":"a","body":"b"}]}`;
  const result = parseJsonFindings(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.severity, 'LOW');
});

test('parseJsonFindings — empty array returns empty', () => {
  assert.deepEqual(parseJsonFindings('[]'), []);
});

test('parseJsonFindings — invalid JSON returns empty', () => {
  assert.deepEqual(parseJsonFindings('not json'), []);
});

test('parseJsonFindings — normalizes severity casing', () => {
  const raw = `[{"severity":"high","title":"x","body":"y"}]`;
  const result = parseJsonFindings(raw);
  assert.equal(result[0]!.severity, 'HIGH');
});

test('parseJsonFindings — unknown severity defaults to MEDIUM', () => {
  const raw = `[{"severity":"WHATEVER","title":"x","body":"y"}]`;
  const result = parseJsonFindings(raw);
  assert.equal(result[0]!.severity, 'MEDIUM');
});

test('parseJsonFindings — supports location object', () => {
  const raw = `[{"severity":"MEDIUM","title":"x","body":"y","location":{"file":"a.ts","line":10}}]`;
  const result = parseJsonFindings(raw);
  assert.equal(result[0]!.file, 'a.ts');
  assert.equal(result[0]!.line, 10);
});

test('parseMarkdownFindings — extracts H3 sections', () => {
  const raw = `### [CRITICAL] Title here
This is the body. File: src/foo.ts:42`;
  const result = parseMarkdownFindings(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.severity, 'CRITICAL');
  assert.equal(result[0]!.file, 'src/foo.ts');
  assert.equal(result[0]!.line, 42);
});

test('parseMarkdownFindings — drops "Critical Issues (0)" section header', () => {
  const raw = `## Critical Issues (0)
None. Build-side change is complete and consistent.
- All call sites updated correctly.`;
  const result = parseMarkdownFindings(raw);
  assert.equal(result.length, 0);
});

test('parseMarkdownFindings — drops prose containing severity words', () => {
  const raw = `Notes (not flagged — low signal / already raised):

- Some narration here.
- More narration mentioning high impact.`;
  const result = parseMarkdownFindings(raw);
  assert.equal(result.length, 0);
});

test('parseMarkdownFindings — drops narration even with bracketed severity', () => {
  const raw = `### [HIGH] I'll adapt this review workflow for Azure DevOps. Let me first check available tooling.

az CLI with azure-devops extension is available. Let me set up todos.`;
  const result = parseMarkdownFindings(raw);
  assert.equal(result.length, 0);
});

test('parseMarkdownFindings — drops bracketed-severity section with no file:line', () => {
  const raw = `### [MEDIUM] Some general observation without a code location

This is a paragraph about something with no file reference at all.`;
  const result = parseMarkdownFindings(raw);
  assert.equal(result.length, 0);
});

test('parseMarkdownFindings — accepts varied bracket styles', () => {
  const raw1 = `### (HIGH) Issue
File: foo.ts:1`;
  const raw2 = `### **HIGH** Issue
File: foo.ts:1`;
  assert.equal(parseMarkdownFindings(raw1).length, 1);
  assert.equal(parseMarkdownFindings(raw2).length, 1);
});

test('parseSectionedFindings — extracts findings from pr-review-toolkit format', () => {
  const raw = `## Critical Issues
None.

## Important Issues
- **No guard for missing/empty principalType** — \`AddRoleAssignments.ps1:181\`. The script will throw if any assignment lacks the field. Add an explicit check.

## Suggestions
- **Indentation regression** — \`AddRoleAssignments.ps1:181\`. The line gained an extra tab vs. its comment.
- **Duplicated definitions** — \`mlops/.../roleAssignments.bicep:18\`. Future drift risk.`;
  const result = parseSectionedFindings(raw);
  assert.equal(result.length, 3);
  assert.equal(result[0]!.severity, 'HIGH');
  assert.equal(result[0]!.file, 'AddRoleAssignments.ps1');
  assert.equal(result[0]!.line, 181);
  assert.match(result[0]!.title, /No guard/);
  assert.equal(result[1]!.severity, 'LOW');
  assert.equal(result[2]!.severity, 'LOW');
});

test('parseSectionedFindings — skips "None." sections', () => {
  const raw = `## Critical Issues
None.

## Important Issues
None.`;
  const result = parseSectionedFindings(raw);
  assert.equal(result.length, 0);
});

test('parseSectionedFindings — handles arbitrary parenthetical labels (e.g. "Suggestions (nice to have)")', () => {
  const raw = `## Suggestions (nice to have)
1. **Indentation nit** — \`AddRoleAssignments.ps1:181\`. Description.`;
  const result = parseSectionedFindings(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.severity, 'LOW');
  assert.equal(result[0]!.file, 'AddRoleAssignments.ps1');
});

test('parseSectionedFindings — handles section header with count in parens', () => {
  const raw = `## Critical Issues (2)
- **First** — \`a.ts:1\`. Description.
- **Second** — \`b.ts:2\`. Description.`;
  const result = parseSectionedFindings(raw);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.severity, 'CRITICAL');
});

test('parseSectionedFindings — does not match section without file:line', () => {
  const raw = `## Suggestions
- General observation about code style without a specific file reference.
- Another vague comment.`;
  const result = parseSectionedFindings(raw);
  assert.equal(result.length, 0);
});

test('parseSectionedFindings — recognizes Important/Major as HIGH', () => {
  const raw = `## Major
- **Bug** — \`a.ts:1\`. Body.`;
  assert.equal(parseSectionedFindings(raw)[0]!.severity, 'HIGH');
});

test('parseReviewerOutput — falls back to sectioned when bracketed not present', () => {
  const raw = `## Important Issues
- **Authz check missing** — \`api.ts:42\`. Description.`;
  const result = parseReviewerOutput(raw, 'markdown');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.severity, 'HIGH');
});

test('parseMarkdownFindings — does not match URLs as file:line', () => {
  const raw = `### [HIGH] Server is reachable
The server at https://example.com:8080 responded correctly.`;
  const result = parseMarkdownFindings(raw);
  assert.equal(result.length, 0);
});

test('parseMarkdownFindings — handles multiple findings', () => {
  const raw = `### [HIGH] First
body 1. File: a.ts:1
### [LOW] Second
body 2. File: b.ts:2`;
  const result = parseMarkdownFindings(raw);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.severity, 'HIGH');
  assert.equal(result[1]!.severity, 'LOW');
});

test('parseReviewerOutput — falls back to markdown when JSON expected but absent', () => {
  const raw = `### [HIGH] markdown finding
File: foo.ts:1`;
  const result = parseReviewerOutput(raw, 'json');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.severity, 'HIGH');
});

test('parseReviewerOutput — falls back to JSON when markdown expected but unparseable', () => {
  const raw = `[{"severity":"NIT","title":"a","body":"b"}]`;
  const result = parseReviewerOutput(raw, 'markdown');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.severity, 'NIT');
});
