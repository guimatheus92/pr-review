import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { SkillDefinition } from '../src/types.js';
import { MAX_STACK_PASSES, selectPasses } from '../src/dispatch/pass-select.js';
import { dependencyNameTokens } from '../src/stack/manifests.js';

function packSkill(name: string, over: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: `pk/${name}`,
    description: `about ${name}`,
    source: `/packs/pk/${name}.md`,
    body: `body of ${name}`,
    appliesTo: [],
    tags: [],
    pack: 'pk',
    origin: 'pack',
    mode: 'auto',
    ...over,
  };
}

function repoSkill(name: string, over: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name,
    description: `about ${name}`,
    source: `/repo/.claude/skills/${name}.md`,
    body: `body of ${name}`,
    appliesTo: [],
    origin: 'repo',
    ...over,
  };
}

const FILES = [{ path: 'src/main.go' }, { path: 'infra/main.tf', patch: '+resource "aws_s3_bucket" "b" {}' }];

function base(input: Partial<Parameters<typeof selectPasses>[0]> = {}) {
  return selectPasses({
    skills: [],
    catalog: [],
    packSkills: [],
    inScopeFiles: FILES,
    stackTags: ['go', 'golang', 'hcl', 'terraform'],
    baseline: [],
    ...input,
  });
}

test('selectPasses — glob hit via CSV-parsed applyTo; match-all is never a glob hit', () => {
  const go = packSkill('go', { appliesTo: ['**/*.go', '**/go.mod'] });
  const generic = packSkill('code-review-generic', { appliesTo: ['**'] });
  const sel = base({ packSkills: [go, generic], baseline: ['pk/code-review-generic'] });
  const goPass = sel.passes.find((p) => p.name === 'pk/go')!;
  assert.equal(goPass.matchedBy, 'glob');
  // Extension-only glob + stack-consistent identity: matchedOn carries both signals.
  assert.deepEqual(goPass.matchedOn, ['go', '**/*.go']);
  const gen = sel.passes.find((p) => p.name === 'pk/code-review-generic')!;
  assert.equal(gen.matchedBy, 'baseline', 'applyTo ** falls through to the baseline pointer');
});

test('selectPasses — a promiscuous extension glob without stack identity is demoted to the index', () => {
  // Observed live: awesome-copilot astro/nestjs/svelte/wordpress all claim **/*.ts.
  const astro = packSkill('astro', { appliesTo: ['**/*.ts', '**/*.md'] });
  const csharp = packSkill('csharp', { appliesTo: ['**/*.cs'] });
  const sel = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [astro, csharp],
    inScopeFiles: [{ path: 'src/app.ts' }, { path: 'src/Api.cs' }],
    stackTags: ['typescript', 'ts', 'c#', 'csharp'],
    baseline: [],
  });
  assert.ok(!sel.passes.some((p) => p.name === 'pk/astro'), 'astro has no stack identity here → index');
  assert.ok(sel.indexEntries.some((e) => e.name === 'pk/astro'));
  // The brace form is still extension-only matching (observed live: pcf-*/aws-appsync).
  const brace = packSkill('pcf-alm', { appliesTo: ['**/*.{ts,tsx,js,json,xml,pcfproj,csproj,sln}'] });
  const braceSel = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [brace],
    inScopeFiles: [{ path: 'src/app.ts' }],
    stackTags: ['typescript', 'ts'],
    baseline: [],
  });
  assert.ok(!braceSel.passes.some((p) => p.name === 'pk/pcf-alm'), 'brace extension glob without identity → index');
  const cs = sel.passes.find((p) => p.name === 'pk/csharp')!;
  assert.equal(cs.matchedBy, 'glob', 'csharp is stack-consistent → its extension glob counts');
});

test('selectPasses — a specific glob (filename/dir/compound) counts on its own, no identity needed', () => {
  const agentSkills = packSkill('agent-skills', { appliesTo: ['**/skills/**/SKILL.md'] });
  const sel = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [agentSkills],
    inScopeFiles: [{ path: 'skills/help/SKILL.md' }],
    stackTags: [],
    baseline: [],
  });
  assert.equal(sel.passes.find((p) => p.name === 'pk/agent-skills')?.matchedBy, 'glob');
});

test('selectPasses — exact tag match, never prefixes: java ≠ javascript, terraform hits', () => {
  const java = packSkill('java', { tags: ['java'] });
  const tf = packSkill('terraform-hardening', { tags: ['terraform'] });
  const sel = base({ packSkills: [java, tf], stackTags: ['javascript', 'terraform'] });
  assert.ok(!sel.passes.some((p) => p.name === 'pk/java'), 'java must not match javascript');
  const tfPass = sel.passes.find((p) => p.name === 'pk/terraform-hardening')!;
  assert.equal(tfPass.matchedBy, 'tag');
  assert.deepEqual(tfPass.matchedOn, ['terraform']);
  assert.ok(sel.indexEntries.some((e) => e.name === 'pk/java'));
});

test('selectPasses — dependency evidence promotes MSTest and rejects unrelated C# products', () => {
  const packSkills = [
    packSkill('github-copilot-sdk-c#', { appliesTo: ['**/*.cs', '**/*.csproj'] }),
    packSkill('azure-durable-functions-csharp', { appliesTo: ['**/*.cs', '**/*.csproj'] }),
    packSkill('azure-functions-csharp', { appliesTo: ['**/*.cs', '**/*.csproj'] }),
    packSkill('csharp-mcp-server', { appliesTo: ['**/*.cs', '**/*.csproj'] }),
    packSkill('dotnet-architecture-good-practices', { appliesTo: ['**/*.cs', '**/*.csproj'] }),
    packSkill('dotnet-framework', { appliesTo: ['**/*.cs', '**/*.csproj'] }),
    packSkill('csharp-mstest', { source: '/packs/pk/skills/csharp-mstest/SKILL.md' }),
    packSkill('dotnet-best-practices'),
  ];
  const sel = selectPasses({
    skills: [],
    catalog: [],
    packSkills,
    inScopeFiles: [{ path: 'src/IntegrationTests/RegionalApiCatalogTests.cs' }, { path: 'src/IntegrationTests/Interop.csproj' }],
    stackTags: ['c#', 'csharp', 'dotnet', 'nuget', 'xml', 'mstest.testframework', 'mstest'],
    stackEvidence: {
      languages: ['c#', 'xml'],
      ecosystems: ['csharp', 'dotnet', 'nuget'],
      dependencies: ['mstest.testframework'],
      dependencyTokens: ['mstest', 'testframework'],
      dependencyGroups: [{ dependency: 'mstest.testframework', tokens: ['mstest', 'testframework'] }],
    },
    baseline: [],
  });

  assert.equal(sel.passes.find((pass) => pass.name === 'pk/csharp-mstest')?.matchedBy, 'dependency');
  assert.ok(sel.passes.some((pass) => pass.name === 'pk/dotnet-best-practices'));
  assert.ok(sel.passes.some((pass) => pass.name === 'pk/dotnet-architecture-good-practices'));
  for (const unrelated of [
    'pk/github-copilot-sdk-c#',
    'pk/azure-durable-functions-csharp',
    'pk/azure-functions-csharp',
    'pk/csharp-mcp-server',
  ]) {
    assert.ok(!sel.passes.some((pass) => pass.name === unrelated), `${unrelated} requires product evidence`);
    assert.ok(sel.indexEntries.some((entry) => entry.name === unrelated));
  }
});

test('selectPasses — product skills return when their package tokens are present', () => {
  const products = [
    packSkill('github-copilot-sdk-c#', { appliesTo: ['**/*.cs'] }),
    packSkill('azure-durable-functions-csharp', { appliesTo: ['**/*.cs'] }),
    packSkill('azure-functions-csharp', { appliesTo: ['**/*.cs'] }),
    packSkill('csharp-mcp-server', { appliesTo: ['**/*.cs'] }),
  ];
  const dependencies = [
    'github.copilot.sdk',
    'microsoft.azure.functions.worker.extensions.durabletask',
    'modelcontextprotocol',
  ];
  const dependencyGroups = dependencies.map((dependency) => ({
    dependency,
    tokens: dependency === 'microsoft.azure.functions.worker.extensions.durabletask'
      ? dependencyNameTokens('Microsoft.Azure.Functions.Worker.Extensions.DurableTask')
      : dependencyNameTokens(dependency),
  }));
  const dependencyTokens = [...new Set(dependencyGroups.flatMap((group) => group.tokens))];
  const sel = selectPasses({
    skills: [],
    catalog: [],
    packSkills: products,
    inScopeFiles: [{ path: 'src/App.cs' }],
    stackTags: ['c#', 'csharp', 'dotnet', ...dependencyTokens],
    stackEvidence: {
      languages: ['c#'],
      ecosystems: ['csharp', 'dotnet'],
      dependencies,
      dependencyTokens,
      dependencyGroups,
    },
    baseline: [],
  });
  assert.deepEqual(sel.passes.map((pass) => pass.name).sort(), products.map((skill) => skill.name).sort());
  assert.ok(sel.passes.every((pass) => pass.matchedBy === 'dependency'));
});

test('selectPasses — package.json alone does not prove a Node product is present', () => {
  const productSkills = [
    packSkill('github-copilot-sdk-node.js', { appliesTo: ['package.json', '**/*.ts'] }),
    packSkill('power-apps-code-apps', { appliesTo: ['**/package.json'] }),
    packSkill('typescript-mcp-server', { appliesTo: ['**/package.json', '**/*.ts'] }),
  ];
  const sel = selectPasses({
    skills: [],
    catalog: [],
    packSkills: productSkills,
    inScopeFiles: [{ path: 'package.json' }, { path: 'src/app.ts' }],
    stackTags: ['javascript', 'typescript', 'node', 'nodejs', 'npm'],
    stackEvidence: {
      languages: ['javascript', 'typescript'],
      ecosystems: ['node', 'nodejs', 'npm'],
      dependencies: ['commander'],
      dependencyTokens: ['commander'],
      dependencyGroups: [{ dependency: 'commander', tokens: ['commander'] }],
    },
    baseline: [],
  });
  assert.deepEqual(sel.passes, []);
  assert.deepEqual(sel.indexEntries.map((entry) => entry.name).sort(), productSkills.map((skill) => skill.name).sort());
});

test('selectPasses — broad keyword alternatives are weak but literal product filenames stay specific', () => {
  const m365 = packSkill('mcp-m365-copilot', {
    appliesTo: ['**/{*mcp*,*agent*,*plugin*,declarativeAgent.json,ai-plugin.json,mcp.json,manifest.json}'],
  });
  const weak = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [m365],
    inScopeFiles: [{ path: 'src/plugins/companions.ts' }],
    stackTags: ['typescript', 'node', 'npm'],
    stackEvidence: {
      languages: ['typescript'],
      ecosystems: ['node', 'npm'],
      dependencies: ['commander'],
      dependencyTokens: ['commander'],
    },
    baseline: [],
  });
  assert.deepEqual(weak.passes, []);

  const literal = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [m365],
    inScopeFiles: [{ path: 'config/mcp.json' }],
    stackTags: ['json'],
    stackEvidence: { languages: ['json'], ecosystems: [], dependencies: [], dependencyTokens: [] },
    baseline: [],
  });
  assert.equal(literal.passes[0]?.matchedBy, 'glob');
  assert.deepEqual(literal.passes[0]?.matchedOn, ['**/mcp.json']);

  const genericManifest = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [m365],
    inScopeFiles: [{ path: 'extension/manifest.json' }],
    stackTags: ['json'],
    stackEvidence: { languages: ['json'], ecosystems: [], dependencies: [], dependencyTokens: [] },
    baseline: [],
  });
  assert.deepEqual(genericManifest.passes, []);
});

test('selectPasses — real npm package tokens activate MCP and Node.js Copilot skills', () => {
  const mcp = packSkill('typescript-mcp-server', { appliesTo: ['**/*.ts', '**/package.json'] });
  const copilot = packSkill('github-copilot-sdk-node.js', { appliesTo: ['**/*.ts', 'package.json'] });
  const dependencyTokens = [
    ...new Set([
      ...dependencyNameTokens('@modelcontextprotocol/sdk'),
      ...dependencyNameTokens('@github/copilot-sdk'),
    ]),
  ];
  const selection = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [mcp, copilot],
    inScopeFiles: [{ path: 'src/server.ts' }, { path: 'package.json' }],
    stackTags: ['typescript', 'node', 'nodejs', 'npm', ...dependencyTokens],
    stackEvidence: {
      languages: ['typescript'],
      ecosystems: ['node', 'nodejs', 'npm'],
      dependencies: ['@modelcontextprotocol/sdk', '@github/copilot-sdk'],
      dependencyTokens,
      dependencyGroups: [
        { dependency: '@modelcontextprotocol/sdk', tokens: dependencyNameTokens('@modelcontextprotocol/sdk') },
        { dependency: '@github/copilot-sdk', tokens: dependencyNameTokens('@github/copilot-sdk') },
      ],
    },
    baseline: [],
  });
  assert.deepEqual(
    selection.passes.map((pass) => `${pass.name}:${pass.matchedBy}`).sort(),
    ['pk/github-copilot-sdk-node.js:dependency', 'pk/typescript-mcp-server:dependency'],
  );
});

test('selectPasses — unrelated dependencies cannot compose a product identity', () => {
  const azureFunctions = packSkill('azure-functions-csharp', { appliesTo: ['**/*.cs'] });
  const selection = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [azureFunctions],
    inScopeFiles: [{ path: 'src/App.cs' }],
    stackTags: ['c#', 'csharp', 'dotnet', 'azure', 'functions'],
    stackEvidence: {
      languages: ['c#'],
      ecosystems: ['csharp', 'dotnet'],
      dependencies: ['azure.identity', 'functions.core'],
      dependencyTokens: ['azure', 'identity', 'functions', 'core'],
      dependencyGroups: [
        { dependency: 'azure.identity', tokens: ['azure', 'identity'] },
        { dependency: 'functions.core', tokens: ['functions', 'core'] },
      ],
    },
    baseline: [],
  });
  assert.deepEqual(selection.passes, []);
});

test('selectPasses — stack passes capped at MAX_STACK_PASSES, baselines ALWAYS ride, project skills become context', () => {
  const packSkills: SkillDefinition[] = [];
  for (let i = 0; i < 8; i++) packSkills.push(packSkill(`glob-${i}`, { appliesTo: ['**/main.go'] }));
  for (let i = 0; i < 3; i++) packSkills.push(packSkill(`base-${i}`));
  const forced = repoSkill('forced-one', { origin: 'forced' });
  const targeted = repoSkill('team-rules', { appliesTo: ['**/*.go'] });
  const sel = base({
    packSkills,
    skills: [forced, targeted],
    baseline: ['pk/base-0', 'pk/base-1', 'pk/base-2'],
  });
  const kinds = sel.passes.map((p) => p.matchedBy);
  assert.deepEqual(
    kinds,
    ['glob', 'glob', 'glob', 'glob', 'glob', 'glob', 'baseline', 'baseline', 'baseline'],
    'MAX_STACK_PASSES glob + every baseline — baselines can no longer be starved out',
  );
  assert.equal(sel.passes.length, MAX_STACK_PASSES + 3);
  // 2 stack passes overflowed → head of the index
  assert.deepEqual(sel.indexEntries.slice(0, 2).map((e) => e.name), ['pk/glob-6', 'pk/glob-7']);
  // The user's own skills are context in every pass, not pass slots.
  assert.deepEqual(sel.projectSkills.map((s) => s.name).sort(), ['forced-one', 'team-rules']);
  for (const name of ['forced-one', 'team-rules']) {
    assert.equal(sel.routes.find((r) => r.name === name)?.matchedBy, 'context');
  }
});

test('selectPasses — index-only packs never become passes; missing baseline reported (incl. index-mode pointers)', () => {
  const idx = packSkill('detecting-x', { mode: 'index', appliesTo: ['**/*.go'] });
  const sel = base({ packSkills: [idx], baseline: ['pk/renamed-upstream', 'pk/detecting-x'] });
  assert.equal(sel.passes.length, 0);
  assert.ok(sel.indexEntries.some((e) => e.name === 'pk/detecting-x'));
  // A pointer into an index-mode pack can never dispatch — reported as missing too.
  assert.deepEqual(sel.missingBaseline.sort(), ['pk/detecting-x', 'pk/renamed-upstream']);
});

test('selectPasses — a baseline that stack-matches but loses the stack cap STILL dispatches as baseline', () => {
  const packSkills: SkillDefinition[] = [];
  for (let i = 0; i < MAX_STACK_PASSES; i++) {
    // Stronger stack hits (2 matchedOn each) that fill the whole cap.
    packSkills.push(packSkill(`strong-${i}`, { appliesTo: ['**/main.go', 'infra/main.tf'] }));
  }
  // The baseline ALSO glob-matches (1 hit) — it loses the cap tie-break…
  const dual = packSkill('security-and-owasp', { appliesTo: ['**/main.go'] });
  const sel = base({ packSkills: [...packSkills, dual], baseline: ['pk/security-and-owasp'] });
  const row = sel.passes.find((p) => p.name === 'pk/security-and-owasp');
  // …but must never be silently evicted: it rides as a baseline pass.
  assert.equal(row?.matchedBy, 'baseline', 'evicted stack hit falls back to its baseline seat');
  assert.equal(sel.passes.length, MAX_STACK_PASSES + 1);
  assert.ok(!sel.indexEntries.some((e) => e.name === 'pk/security-and-owasp'), 'not double-listed in the index');
});

test('selectPasses — repo skills: targeted globs route as glob, untargeted go through the heuristic', () => {
  const targeted = repoSkill('auth-rules', { appliesTo: ['**/*.go'] });
  const missed = repoSkill('css-rules', { appliesTo: ['**/*.css'] });
  // Heuristic needles match 4-char stems of the changed paths/diff: 'infra'/'main'/'resources'/'buckets' clear THRESHOLD.
  const relevant = repoSkill('infra-conventions', { description: 'conventions for infra modules: main terraform resources and s3 buckets' });
  const unrelated = repoSkill('billing-glossary', { description: 'billing domain terms' });
  const sel = base({ skills: [targeted, missed], catalog: [relevant, unrelated] });
  assert.equal(sel.passes.find((p) => p.name === 'auth-rules')?.matchedBy, 'glob');
  assert.equal(sel.passes.find((p) => p.name === 'infra-conventions')?.matchedBy, 'repo');
  assert.ok(!sel.passes.some((p) => p.name === 'css-rules'));
  assert.ok(sel.indexEntries.some((e) => e.name === 'css-rules'));
  assert.ok(sel.indexEntries.some((e) => e.name === 'billing-glossary'));
});

test('selectPasses — baseline dedupe keeps the higher tier; description capped in index entries', () => {
  const dual = packSkill('security-and-owasp', { appliesTo: ['**/main.go'] });
  const longDesc = packSkill('wordy', { description: 'x'.repeat(500) });
  const sel = base({ packSkills: [dual, longDesc], baseline: ['pk/security-and-owasp'] });
  const rows = sel.passes.filter((p) => p.name === 'pk/security-and-owasp');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.matchedBy, 'glob');
  const entry = sel.indexEntries.find((e) => e.name === 'pk/wordy')!;
  assert.equal(entry.description.length, 200);
});

test('selectPasses — project skills never consume pass slots; heuristic-matched ones inject as context', () => {
  const packSkills: SkillDefinition[] = [];
  for (let i = 0; i < 10; i++) packSkills.push(packSkill(`pg-${i}`, { appliesTo: ['**/main.go'] }));
  // Untargeted repo skill promoted by the relevance heuristic (4 stem hits clear THRESHOLD).
  const mine = repoSkill('infra-conventions', { description: 'conventions for infra modules: main terraform resources and s3 buckets' });
  const sel = base({ packSkills, catalog: [mine] });
  assert.ok(!sel.passes.some((p) => p.name === 'infra-conventions'), 'not a pass slot');
  assert.deepEqual(sel.projectSkills.map((s) => s.name), ['infra-conventions']);
  assert.equal(sel.passes.length, MAX_STACK_PASSES, 'stack cap unaffected by project skills');
  assert.equal(sel.routes.find((r) => r.name === 'infra-conventions')?.matchedBy, 'context');
});

test('selectPasses — fallback with no pack passes: project skills become the passes themselves', () => {
  const targeted = repoSkill('db-access-layer', { appliesTo: ['src/**/*.go'] });
  const heuristic = repoSkill('infra-conventions', { description: 'conventions for infra modules: main terraform resources and s3 buckets' });
  const sel = base({ skills: [targeted], catalog: [heuristic], packSkills: [] });
  assert.deepEqual(sel.passes.map((p) => p.name).sort(), ['db-access-layer', 'infra-conventions']);
  assert.deepEqual(sel.projectSkills, [], 'promoted — no separate context set');
  assert.equal(sel.passes.find((p) => p.name === 'db-access-layer')?.matchedBy, 'glob');
  assert.equal(sel.passes.find((p) => p.name === 'infra-conventions')?.matchedBy, 'repo');
});

test('selectPasses — explicit skills honor scope while forced skills bypass it', () => {
  const explicit = repoSkill('explicit-rule', { origin: 'explicit', appliesTo: ['**/*.css'] });
  const forced = repoSkill('forced-rule', { origin: 'forced', appliesTo: ['**/*.css'] });
  const sel = base({ skills: [explicit, forced], packSkills: [] });
  assert.ok(!sel.passes.some((pass) => pass.name === 'explicit-rule'));
  assert.ok(sel.indexEntries.some((entry) => entry.name === 'explicit-rule'));
  assert.equal(sel.passes.find((pass) => pass.name === 'forced-rule')?.matchedBy, 'forced');
});

test('selectPasses — fallback overflow beyond MAX_PASSES stays CONTEXT, never the index (no rule lost)', () => {
  const many = Array.from({ length: 12 }, (_, i) => repoSkill(`rule-${String(i).padStart(2, '0')}`, { appliesTo: ['**/*.go'] }));
  const sel = base({ skills: many, catalog: [], packSkills: [] });
  assert.equal(sel.passes.length, 10, 'passes cap at MAX_PASSES');
  assert.equal(sel.projectSkills.length, 2, 'overflow injects as context into every pass');
  for (const s of sel.projectSkills) {
    assert.equal(sel.routes.find((r) => r.name === s.name)?.matchedBy, 'context');
  }
  assert.ok(!sel.indexEntries.some((e) => e.name.startsWith('rule-')), 'no project rule demoted to the on-demand index');
});

test('selectPasses — the skill file’s own .md extension is never identity: a changed README must not tag-match every pack skill', () => {
  // Every pack file ends in .md and Linguist aliases Markdown as 'md' — without
  // stripping the extension, one changed README.md made all 604 awesome-copilot
  // skills tag-match and evicted every baseline (observed live).
  const clojure = packSkill('clojure', { source: '/packs/pk/clojure.instructions.md' });
  const baseline = packSkill('code-review-generic');
  const sel = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [clojure, baseline],
    inScopeFiles: [{ path: 'README.md' }, { path: 'src/app.ts' }],
    stackTags: ['md', 'markdown', 'typescript', 'ts'],
    baseline: ['pk/code-review-generic'],
  });
  assert.ok(!sel.passes.some((p) => p.name === 'pk/clojure'), '.md extension must not count as identity');
  assert.equal(sel.passes.find((p) => p.name === 'pk/code-review-generic')?.matchedBy, 'baseline', 'baseline survives');
});

test('selectPasses — within a tier, more matchedOn evidence wins the tie-break', () => {
  const narrow = packSkill('narrow', { appliesTo: ['**/main.go'] });
  const wide = packSkill('wide', { appliesTo: ['**/main.go', 'infra/main.tf'] });
  const sel = base({ packSkills: [narrow, wide] });
  assert.deepEqual(sel.passes.map((p) => p.name), ['pk/wide', 'pk/narrow']);
});

test('selectPasses — routes mirror passes + index', () => {
  const go = packSkill('go', { appliesTo: ['**/*.go'] });
  const idle = packSkill('idle');
  const sel = base({ packSkills: [go, idle] });
  assert.deepEqual(
    sel.routes.map((r) => `${r.name}:${r.matchedBy}`).sort(),
    ['pk/go:glob', 'pk/idle:index'],
  );
});

test('selectPasses — installed plugin skills are selected from path/topic evidence without a technology map', () => {
  const pluginSkill = (name: string, description: string): SkillDefinition => ({
    name: `fabric-tools/${name}`,
    description,
    source: `/plugins/fabric-tools/${name}/SKILL.md`,
    body: `Review ${description}. Validate the changed artifacts using read-only tools.`,
    appliesTo: [],
    origin: 'plugin',
    plugin: 'fabric-tools',
    mcpServers: ['model-inspector'],
  });
  const selection = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [],
    installedPluginSkills: [
      pluginSkill('report-authoring', 'PowerBI PBIR report pages visuals and filters'),
      pluginSkill('semantic-model', 'PowerBI semantic model TMDL tables measures and relationships'),
      pluginSkill('workspace-management', 'Publish and manage Fabric workspaces'),
    ],
    inScopeFiles: [
      { path: 'fabric/powerBI/orb/Matrix.Report/definition/pages/home/visuals/kpi/visual.json' },
      { path: 'fabric/powerBI/orb/Model.SemanticModel/definition/tables/Dim Region.tmdl' },
    ],
    stackTags: ['json', 'tmdl'],
    stackEvidence: { languages: ['json', 'tmdl'], ecosystems: [], dependencies: [], dependencyTokens: [] },
    baseline: [],
    reviewContext: { repoName: 'data-node', title: 'Update report and semantic model' },
  });
  assert.deepEqual(selection.passes.map((pass) => pass.name).sort(), [
    'fabric-tools/report-authoring',
    'fabric-tools/semantic-model',
  ].sort());
  assert.ok(selection.passes.every((pass) => pass.matchedBy === 'plugin'));
  assert.ok(selection.indexEntries.some((entry) => entry.name === 'fabric-tools/workspace-management'));
});

test('selectPasses — generic and partial plugin topic overlap cannot activate an unrelated installed plugin', () => {
  const unrelated: SkillDefinition = {
    name: 'domain-docs/build-rollout',
    description: 'Build JSON service docs, templates, and rollout artifacts.',
    source: '/plugins/domain-docs/build-rollout/SKILL.md',
    body: 'Build deployment artifacts for another product.',
    appliesTo: [],
    origin: 'plugin',
    plugin: 'domain-docs',
    mcpServers: ['release-builds'],
  };
  const selection = selectPasses({
    skills: [], catalog: [], packSkills: [], installedPluginSkills: [unrelated],
    inScopeFiles: [{ path: 'docs/service/templates/rolloutSpec.json' }],
    stackTags: ['json'],
    stackEvidence: { languages: ['json'], ecosystems: [], dependencies: [], dependencyTokens: [] },
    baseline: [],
    reviewContext: { repoName: 'data-node', title: 'Update service rollout templates' },
  });
  assert.equal(selection.passes.length, 0);
  assert.ok(selection.indexEntries.some((entry) => entry.name === unrelated.name));
});

test('selectPasses — exact repository identity can activate a specialized installed review skill', () => {
  const specialized: SkillDefinition = {
    name: 'domain-tools/review-pr',
    description: 'Review rdinfra changes with domain architecture and orchestration knowledge.',
    source: '/plugins/domain-tools/review-pr/SKILL.md',
    body: 'Use the rdinfra knowledge graph to validate the PR blast radius.',
    appliesTo: [],
    origin: 'plugin',
    plugin: 'domain-tools',
    mcpServers: ['domain-knowledge'],
  };
  const operational: SkillDefinition = {
    ...specialized,
    name: 'domain-tools/build-artifacts',
    description: 'Build and validate deployment artifacts for rdinfra.',
    source: '/plugins/domain-tools/build-artifacts/SKILL.md',
  };
  const selection = selectPasses({
    skills: [], catalog: [], packSkills: [], installedPluginSkills: [operational, specialized],
    inScopeFiles: [{ path: 'src/RDBroker/Controllers/PartnerController.cs' }],
    stackTags: ['c#'],
    stackEvidence: { languages: ['c#'], ecosystems: ['dotnet'], dependencies: [], dependencyTokens: [] },
    baseline: [],
    reviewContext: { repoName: 'rdinfra', title: 'Update regional partner API' },
  });
  assert.equal(selection.passes[0]?.name, 'domain-tools/review-pr');
  assert.equal(selection.passes[0]?.matchedBy, 'plugin');
  assert.ok(selection.indexEntries.some((entry) => entry.name === operational.name));
});
