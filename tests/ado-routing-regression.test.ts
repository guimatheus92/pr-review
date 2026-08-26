import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectPasses } from '../src/dispatch/pass-select.js';
import { cwdMatchesPr, detectStack } from '../src/stack/detect.js';
import { parseLinguist } from '../src/stack/linguist.js';
import type { SkillDefinition } from '../src/types.js';

const LINGUIST = parseLinguist(`
'C#':
  aliases: [csharp, cake, cakescript]
  extensions: ['.cs']
Smalltalk:
  aliases: [squeak]
  extensions: ['.cs']
XML:
  aliases: [rss, wsdl, xsd]
  extensions: ['.csproj']
`);

function packSkill(name: string, appliesTo: string[] = [], source = `/pack/${name}.instructions.md`): SkillDefinition {
  return {
    name: `awesome-copilot/${name}`,
    description: name,
    source,
    body: name,
    appliesTo,
    tags: [],
    pack: 'awesome-copilot',
    origin: 'pack',
    mode: 'auto',
  };
}

test('ado routing regression — legacy visualstudio.com origin matches the canonical PR identity', () => {
  assert.equal(
    cwdMatchesPr(
      'https://contoso.visualstudio.com/DefaultCollection/Platform/_git/infra-core',
      'contoso',
      'infra-core',
      'Platform',
    ),
    true,
  );
});

test('ado routing regression — a changed file contributes its deeply nested MSTest project', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-ado-routing-regression-'));
  try {
    const projectDir = join(cwd, 'src', 'IntegrationTests', 'test', 'ContractTests');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'ContractTests.csproj'),
      '<Project><ItemGroup><PackageReference Include="MSTest.TestFramework" Version="4" /><PackageReference Include="MSTest.TestAdapter" Version="4" /></ItemGroup></Project>',
    );
    const stack = detectStack([{ path: 'src/IntegrationTests/test/ContractTests/ApiContractTests.cs' }], {
      linguist: LINGUIST,
      cwd,
      pr: { owner: 'contoso', repo: 'infra-core', project: 'Platform' },
      gitRemote: () => 'https://dev.azure.com/contoso/Platform/_git/infra-core',
      gitToplevel: () => cwd,
    });
    assert.deepEqual(stack.dependencies, ['mstest.testadapter', 'mstest.testframework']);
    assert.deepEqual(stack.languages, ['c#']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('ado routing regression — MSTest outranks unrelated C# products', () => {
  const packSkills = [
    packSkill('github-copilot-sdk-c#', ['**/*.cs', '**/*.csproj']),
    packSkill('azure-durable-functions-csharp', ['**/*.cs', '**/*.csproj']),
    packSkill('azure-functions-csharp', ['**/*.cs', '**/*.csproj']),
    packSkill('csharp-mcp-server', ['**/*.cs', '**/*.csproj']),
    packSkill('dotnet-architecture-good-practices', ['**/*.cs', '**/*.csproj']),
    packSkill('dotnet-framework', ['**/*.cs', '**/*.csproj']),
    packSkill('csharp-mstest', [], '/pack/skills/csharp-mstest/SKILL.md'),
  ];
  const selection = selectPasses({
    skills: [],
    catalog: [],
    packSkills,
    inScopeFiles: [{ path: 'src/IntegrationTests/ApiContractTests.cs' }, { path: 'src/IntegrationTests/Contracts.csproj' }],
    stackTags: ['c#', 'csharp', 'dotnet', 'nuget', 'xml', 'mstest', 'mstest.testframework'],
    stackEvidence: {
      languages: ['c#', 'xml'],
      ecosystems: ['csharp', 'dotnet', 'nuget'],
      dependencies: ['mstest.testframework'],
      dependencyTokens: ['mstest', 'testframework'],
    },
    baseline: [],
  } as Parameters<typeof selectPasses>[0]);

  assert.equal(selection.passes[0]?.name, 'awesome-copilot/csharp-mstest');
  const unrelated = new Set([
    'awesome-copilot/github-copilot-sdk-c#',
    'awesome-copilot/azure-durable-functions-csharp',
    'awesome-copilot/azure-functions-csharp',
    'awesome-copilot/csharp-mcp-server',
  ]);
  assert.deepEqual(selection.passes.map((pass) => pass.name).filter((name) => unrelated.has(name)), []);
});