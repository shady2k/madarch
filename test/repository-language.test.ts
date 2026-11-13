import { expect, test } from 'bun:test';
import { languageOfPath } from '../src/fill/stages/repository-facts.js';

test('unrecognised names use an actual JSON parse, not a suffix guess', () => {
  for (const path of ['asset.js.map', 'arbitrary.unlisted-extension', 'no-extension']) {
    expect(languageOfPath(path, '{"version":3,"sources":[],"mappings":""}')).toEqual({ language: 'JSON', candidates: ['JSON'] });
    expect(languageOfPath(path, '{"broken":')).toEqual({ language: 'unknown', candidates: ['unknown'] });
    expect(languageOfPath(path)).toEqual({ language: 'unknown', candidates: ['unknown'] });
    expect(languageOfPath(path, '')).toEqual({ language: 'unknown', candidates: ['unknown'] });
  }
});

test('dataset names and ambiguity stay ahead of the content fallback', () => {
  expect(languageOfPath('Makefile', '{}')).toEqual({ language: 'Makefile', candidates: ['Makefile'] });
  expect(languageOfPath('src/example.ts', '{}')).toEqual({ language: 'ambiguous', candidates: ['TypeScript', 'XML'] });
  expect(languageOfPath('doc.md', '{}')).toEqual({ language: 'ambiguous', candidates: ['GCC Machine Description', 'Markdown'] });
  expect(languageOfPath('config.yaml', '{}')).toEqual({ language: 'ambiguous', candidates: ['MiniYAML', 'OASv2-yaml', 'OASv3-yaml', 'YAML'] });
});

 test('tree publication parses new blobs and preserves an explicit git attribute', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { readRepositoryTree } = await import('../src/fill/stages/repository-facts.js');
  const root = mkdtempSync(join(tmpdir(), 'language-tree-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]).toString().trim();
  try {
    git('init', '-q');
    writeFileSync(join(root, 'asset.map'), '{"version":3}');
    writeFileSync(join(root, 'declared.map'), '{}');
    writeFileSync(join(root, '.gitattributes'), 'declared.map linguist-language=Text\n');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
    const read = await readRepositoryTree({repository:'fixture',root,commit:git('rev-parse','HEAD'),url:''});
    expect(read.gaps).toEqual([]);
    expect(read.files.map(f=>f.path)).toEqual(['.gitattributes','asset.map','declared.map']);
    expect(read.files.find(f=>f.path==='asset.map')?.language).toBe('JSON');
    expect(read.files.find(f=>f.path==='declared.map')?.language).toBe('Text');
  } finally { rmSync(root,{recursive:true,force:true}); }
},60_000);
