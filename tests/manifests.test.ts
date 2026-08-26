import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dependencyNameTokens,
  ecosystemTags,
  findChangedFileManifests,
  findManifests,
  parseManifest,
  parseManifestDependencyGroups,
  parseJsonDependencyPatch,
  readDependencyTags,
  safeManifestDiagnostic,
} from '../src/stack/manifests.js';

test('safeManifestDiagnostic — paths and errors cannot inject warning lines', () => {
  const rendered = safeManifestDiagnostic('src/bad\r\nforged\u0007');
  assert.equal(rendered, '"src/bad\\r\\nforged\\u0007"');
  assert.equal(rendered.split(/\r?\n/).length, 1);
});

test('parseManifest — one parser per format', () => {
  assert.deepEqual(
    parseManifest('package.json', JSON.stringify({ dependencies: { '@angular/core': '1', express: '4' }, devDependencies: { vitest: '2' } })),
    ['@angular/core', 'angular', 'express', 'vitest'],
  );
  assert.deepEqual(parseManifest('requirements.txt', '# comment\nDjango==5.0\nrequests>=2\n-r other.txt\n'), ['django', 'requests']);
  assert.deepEqual(
    parseManifest('pyproject.toml', 'dependencies = [\n  "fastapi>=0.100",\n  "pydantic",\n]\n[tool.poetry.dependencies]\npython = "^3.11"\nflask = "*"\n'),
    ['fastapi', 'pydantic', 'flask'],
  );
  assert.deepEqual(
    parseManifest('go.mod', 'module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n'),
    ['github.com/gin-gonic/gin', 'gin'],
  );
  assert.deepEqual(
    parseManifest('App.csproj', '<Project><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore" Version="8" /></ItemGroup></Project>'),
    ['microsoft.entityframeworkcore'],
  );
  assert.deepEqual(parseManifest('Cargo.toml', '[package]\nname = "x"\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n'), ['serde', 'tokio']);
  assert.deepEqual(parseManifest('Gemfile', "source 'https://rubygems.org'\ngem 'rails', '~> 7'\n  gem \"pg\"\n"), ['rails', 'pg']);
  assert.deepEqual(parseManifest('pom.xml', '<dependency><artifactId>spring-boot-starter</artifactId></dependency>'), ['spring-boot-starter']);
  assert.deepEqual(
    parseManifest('composer.json', JSON.stringify({ require: { php: '^8.2', 'laravel/framework': '^11', 'ext-json': '*' } })),
    ['laravel/framework', 'laravel'],
  );
});

test('ecosystemTags — manifest kind → ecosystem names', () => {
  assert.deepEqual(ecosystemTags('package.json'), ['node', 'nodejs', 'npm']);
  assert.deepEqual(ecosystemTags('App.csproj'), ['dotnet', 'nuget', 'csharp']);
  assert.deepEqual(ecosystemTags('README.md'), []);
});

test('dependencyNameTokens — preserves package segments and derives CamelCase initialisms', () => {
  assert.ok(dependencyNameTokens('MSTest.TestFramework').includes('mstest'));
  assert.ok(dependencyNameTokens('Microsoft.Azure.Functions.Worker').includes('functions'));
  assert.ok(dependencyNameTokens('GitHub.Copilot.SDK').includes('copilot'));
  assert.ok(dependencyNameTokens('ModelContextProtocol').includes('mcp'));
  assert.ok(dependencyNameTokens('@modelcontextprotocol/sdk').includes('mcp'));
  assert.ok(!dependencyNameTokens('Microsoft.AspNetCore.Mvc.Testing').includes('mancmt'));
});

test('parseManifestDependencyGroups — keeps original NuGet CamelCase inside each package group', () => {
  assert.deepEqual(
    parseManifestDependencyGroups(
      'App.csproj',
      '<PackageReference Include="Microsoft.Azure.Functions.Worker.Extensions.DurableTask" Version="1" />',
    ),
    [{
      dependency: 'microsoft.azure.functions.worker.extensions.durabletask',
      tokens: [
        'azure',
        'durable',
        'durabletask',
        'extensions',
        'functions',
        'microsoft',
        'microsoft.azure.functions.worker.extensions.durabletask',
        'task',
        'worker',
      ],
    }],
  );
});

test('parseJsonDependencyPatch — accepts dependency sections and ignores unrelated string properties', () => {
  const patch = [
    '@@ -1,5 +1,9 @@',
    ' {',
    '+  "modelContextProtocol": "enabled",',
    '+  "scripts": { "mcp": "node server.js" },',
    '   "dependencies": {',
    '+    "@modelcontextprotocol/sdk": "^1.0.0",',
    '     "express": "4"',
    '   },',
    '+  "devDependencies": { "vitest": "2" }',
    ' }',
  ].join('\n');
  assert.deepEqual(parseJsonDependencyPatch(patch), ['@modelcontextprotocol/sdk', 'vitest']);
});

test('parseJsonDependencyPatch — recognizes a dependency hunk without its section header', () => {
  const patch = [
    '@@ -20,3 +20,4 @@',
    '     "express": "4",',
    '+    "@modelcontextprotocol/sdk": "^1.0.0",',
    '+    "build": "tsc",',
    '+    "version": "2.0.0"',
    '   }',
  ].join('\n');
  assert.deepEqual(parseJsonDependencyPatch(patch), ['@modelcontextprotocol/sdk']);
});

test('findManifests + readDependencyTags — walks 2 levels, skips node_modules and dot dirs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-man-'));
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
    mkdirSync(join(cwd, 'api'), { recursive: true });
    writeFileSync(join(cwd, 'api', 'App.csproj'), '<Project><ItemGroup><PackageReference Include="Dapper" Version="2" /></ItemGroup></Project>');
    mkdirSync(join(cwd, 'node_modules', 'evil'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'evil', 'package.json'), JSON.stringify({ dependencies: { malware: '1' } }));
    mkdirSync(join(cwd, '.hidden'), { recursive: true });
    writeFileSync(join(cwd, '.hidden', 'Gemfile'), "gem 'secret'\n");

    const found = findManifests(cwd);
    assert.equal(found.length, 2, JSON.stringify(found));

    const tags = readDependencyTags(cwd);
    assert.deepEqual(tags.dependencies, ['dapper', 'express']);
    assert.ok(tags.ecosystems.includes('node') && tags.ecosystems.includes('dotnet'));
    assert.ok(!tags.dependencies.includes('malware'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('readDependencyTags — changed files contribute their deep owning manifest', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-man-'));
  try {
    const projectDir = join(cwd, 'src', 'IntegrationTests', 'test', 'ContractTests');
    mkdirSync(projectDir, { recursive: true });
    const project = join(projectDir, 'ContractTests.csproj');
    writeFileSync(
      project,
      '<Project><ItemGroup><PackageReference Include="MSTest.TestFramework" Version="3" /><PackageReference Include="MSTest.TestAdapter" Version="3" /></ItemGroup></Project>',
    );
    const changed = [
      'src/IntegrationTests/test/ContractTests/CatalogApiTests.cs',
      'src/IntegrationTests/test/ContractTests/ContractTests.csproj',
      '../outside/Unrelated.csproj',
    ];

    assert.deepEqual(findManifests(cwd), [], 'the general two-level scan does not reach the project');
    assert.deepEqual(findChangedFileManifests(cwd, changed), [project]);
    const tags = readDependencyTags(cwd, changed);
    assert.deepEqual(tags.dependencies, ['mstest.testadapter', 'mstest.testframework']);
    assert.ok(tags.tokens.includes('mstest'));
    assert.ok(tags.ecosystems.includes('dotnet') && tags.ecosystems.includes('csharp'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('readDependencyTags — changed paths cannot escape through a directory link', (context) => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-man-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'pr-review-man-outside-'));
  try {
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ dependencies: { exfiltrated: '1' } }));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    const link = join(cwd, 'src', 'linked');
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
        context.skip(`directory links unavailable: ${code}`);
        return;
      }
      throw error;
    }
    const tags = readDependencyTags(cwd, ['src/linked/app.ts']);
    assert.deepEqual(tags.dependencies, []);
    assert.deepEqual(tags.manifests, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('readDependencyTags — deleted nested paths still find a manifest in the nearest existing ancestor', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-man-deleted-'));
  try {
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(
      join(cwd, 'src', 'App.csproj'),
      '<Project><ItemGroup><PackageReference Include="MSTest.TestFramework" Version="4" /></ItemGroup></Project>',
    );
    const tags = readDependencyTags(cwd, ['src/deleted/subtree/ContractTests.cs']);
    assert.deepEqual(tags.dependencies, ['mstest.testframework']);
    assert.deepEqual(tags.warnings, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
