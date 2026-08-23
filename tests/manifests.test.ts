import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ecosystemTags, findManifests, parseManifest, readDependencyTags } from '../src/stack/manifests.js';

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
