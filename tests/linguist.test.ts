import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { languageTags, linguistCachePath, loadLinguist, parseLinguist } from '../src/stack/linguist.js';

const FIXTURE = `
Go:
  type: programming
  aliases: [golang]
  extensions: ['.go']
HCL:
  type: programming
  aliases: ['HashiCorp Configuration Language', opentofu, terraform]
  extensions: ['.hcl', '.tf', '.tfvars']
'C#':
  type: programming
  aliases: [csharp, cake]
  extensions: ['.cs', '.cs.pp', '.csx']
Smalltalk:
  type: programming
  aliases: [squeak]
  extensions: ['.cs']
TypeScript:
  type: programming
  aliases: [ts]
  extensions: ['.ts', '.tsx']
TSX:
  type: programming
  group: TypeScript
  extensions: ['.tsx']
Dockerfile:
  type: programming
  aliases: [Containerfile]
  extensions: ['.dockerfile']
  filenames: [Dockerfile, Containerfile]
XML:
  aliases: [rss, xsd, wsdl]
  extensions: ['.csproj']
JSON:
  extensions: ['.json']
  filenames: [package.json]
OpenAPI Specification v3:
  aliases: [oasv3-json]
  extensions: ['.json']
Markdown:
  aliases: [md]
  extensions: ['.md']
GCC Machine Description:
  extensions: ['.md']
${Array.from({ length: 120 }, (_, i) => `Synth${i}:\n  extensions: ['.synth${i}']`).join('\n')}
`;

test('parseLinguist + languageTags — canonical names, ambiguity resolution, dotted suffixes, unions', () => {
  const idx = parseLinguist(FIXTURE);
  assert.deepEqual(languageTags(idx, 'infra/main.tf'), ['hcl']);
  assert.deepEqual(languageTags(idx, 'src/Api/UserController.cs').sort(), ['c#', 'smalltalk']);
  assert.deepEqual(languageTags(idx, 'src/Api/UserController.cs', ['csharp']), ['c#']);
  // dotted suffix: a.cs.pp hits '.cs.pp' (and '.pp' would too if defined)
  assert.ok(languageTags(idx, 'gen/a.cs.pp').includes('c#'));
  // The extension itself is canonical evidence when a claimant is named for it.
  const tsx = languageTags(idx, 'web/App.tsx');
  assert.deepEqual(tsx, ['tsx']);
  // extension-less well-known filename
  assert.deepEqual(languageTags(idx, 'deploy/Dockerfile'), ['dockerfile']);
  assert.deepEqual(languageTags(idx, 'src/App.csproj'), ['xml'], 'aliases are lookup metadata, not stack identities');
  assert.deepEqual(languageTags(idx, 'package.json'), ['json'], 'exact filenames override ambiguous extensions');
  assert.deepEqual(languageTags(idx, 'docs/guide.md'), ['markdown']);
  assert.deepEqual(languageTags(idx, 'schemas/data.json'), ['json']);
  assert.deepEqual(languageTags(idx, 'unknown.xyz'), []);
});

test('loadLinguist — fetch writes the cache once; later loads and failed refreshes use it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-review-ling-'));
  let fetches = 0;
  const okFetch = (async () => {
    fetches++;
    return { ok: true, status: 200, text: async () => FIXTURE } as Response;
  }) as unknown as typeof fetch;
  const badFetch = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  try {
    const first = await loadLinguist({ home, fetchFn: okFetch });
    assert.ok(first);
    assert.equal(fetches, 1);
    assert.ok(existsSync(linguistCachePath(home)));
    assert.match(readFileSync(linguistCachePath(home), 'utf8'), /HashiCorp/);

    const second = await loadLinguist({ home, fetchFn: badFetch });
    assert.ok(second, 'cache hit — no network needed');

    const forced = await loadLinguist({ home, fetchFn: badFetch, force: true });
    assert.ok(forced, 'failed forced refresh falls back to the cache');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadLinguist — no cache and no network → null with a warning', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-review-ling-'));
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    lines.push(s);
    return true;
  };
  try {
    const badFetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const idx = await loadLinguist({ home, fetchFn: badFetch });
    assert.equal(idx, null);
    assert.ok(lines.some((l) => l.includes('packs sync')));
  } finally {
    (process.stderr as unknown as { write: typeof orig }).write = orig;
    rmSync(home, { recursive: true, force: true });
  }
});
