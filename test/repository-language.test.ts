import { expect, test } from 'bun:test';
import { languageOfPath } from '../plugins/disk/reader.js';

test('unrecognised names use an actual JSON parse, not a suffix guess', () => {
  for (const path of ['asset.js.map', 'arbitrary.unlisted-extension', 'no-extension']) {
    expect(languageOfPath(path, '{"version":3,"sources":[],"mappings":""}')).toEqual({ language: 'JSON', candidates: ['JSON'] });
    expect(languageOfPath(path, '{"broken":')).toEqual({ language: 'unknown', candidates: ['unknown'] });
    expect(languageOfPath(path)).toEqual({ language: 'unknown', candidates: ['unknown'] });
    expect(languageOfPath(path, '')).toEqual({ language: 'unknown', candidates: ['unknown'] });
  }
});

test('an ambiguous extension is decided by its content, then by the extension\'s default language', () => {
  expect(languageOfPath('Makefile', '{}')).toEqual({ language: 'Makefile', candidates: ['Makefile'] });
  expect(languageOfPath('src/example.ts', 'export const a = 1;\n')).toEqual({ language: 'TypeScript', candidates: ['TypeScript', 'XML'] });
  expect(languageOfPath('src/translations.ts', '<?xml version="1.0" encoding="utf-8"?><TS></TS>\n')).toEqual({ language: 'XML', candidates: ['TypeScript', 'XML'] });
  expect(languageOfPath('src/qt.ts', '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE TS>\n<TS version="2.1"></TS>\n')).toEqual({ language: 'XML', candidates: ['TypeScript', 'XML'] });
  expect(languageOfPath('src/qt-comments.ts', '\uFEFF<?xml version="1.0"?>\n<!-- generated -->\n<!DOCTYPE TS>\n<!-- another -->\n<TS></TS>\n')).toEqual({ language: 'XML', candidates: ['TypeScript', 'XML'] });
  // A TypeScript file that mentions the XML element inside its own text stays TypeScript: the XML rule is anchored.
  expect(languageOfPath('src/reader.ts', 'export const tag = "<TS";\n')).toEqual({ language: 'TypeScript', candidates: ['TypeScript', 'XML'] });
  expect(languageOfPath('src/view.tsx', 'export const View = () => <TS />;\n')).toEqual({ language: 'TSX', candidates: ['TSX', 'XML'] });
  expect(languageOfPath('doc.md', '# A document\n')).toEqual({ language: 'Markdown', candidates: ['GCC Machine Description', 'Markdown'] });
  expect(languageOfPath('machine.md', '(define_insn "add"\n  [(set (match_operand:SI 0 "register_operand" "")\n        (plus:SI (match_operand:SI 1 "register_operand" "")\n                 (match_operand:SI 2 "register_operand" "")))]\n  "" "")\n')).toEqual({ language: 'GCC Machine Description', candidates: ['GCC Machine Description', 'Markdown'] });
  expect(languageOfPath('config.yaml', 'name: example\n')).toEqual({ language: 'YAML', candidates: ['MiniYAML', 'OASv2-yaml', 'OASv3-yaml', 'YAML'] });
  expect(languageOfPath('openapi.yaml', 'openapi: 3.0.0\ninfo:\n  title: Example\npaths: {}\n')).toEqual({ language: 'OASv3-yaml', candidates: ['MiniYAML', 'OASv2-yaml', 'OASv3-yaml', 'YAML'] });
  expect(languageOfPath('swagger.yaml', 'swagger: "2.0"\ninfo:\n  title: Example\npaths: {}\n')).toEqual({ language: 'OASv2-yaml', candidates: ['MiniYAML', 'OASv2-yaml', 'OASv3-yaml', 'YAML'] });
  expect(languageOfPath('openapi.json', '{"openapi":"3.0.0","info":{"title":"Example"},"paths":{}}')).toEqual({ language: 'OASv3-json', candidates: ['JSON', 'OASv2-json', 'OASv3-json'] });
  expect(languageOfPath('swagger.json', '{"swagger":"2.0","info":{"title":"Example"},"paths":{}}')).toEqual({ language: 'OASv2-json', candidates: ['JSON', 'OASv2-json', 'OASv3-json'] });
  expect(languageOfPath('data.json', '{"name":"example"}')).toEqual({ language: 'JSON', candidates: ['JSON', 'OASv2-json', 'OASv3-json'] });
  expect(languageOfPath('page.html', '<!doctype html><p>hi</p>')).toEqual({ language: 'HTML', candidates: ['Ecmarkup', 'HTML'] });
  expect(languageOfPath('spec.html', '<!doctype html><emu-clause id="x"></emu-clause>')).toEqual({ language: 'Ecmarkup', candidates: ['Ecmarkup', 'HTML'] });
  expect(languageOfPath('query.sql', 'select 1;\n')).toEqual({ language: 'SQL', candidates: ['PLSQL', 'PLpgSQL', 'SQL', 'SQLPL', 'TSQL'] });
  expect(languageOfPath('header.h', '#include <stdio.h>\nint value;\n')).toEqual({ language: 'C', candidates: ['C', 'C++', 'Objective-C'] });
  expect(languageOfPath('header.h', 'class Value { public: int v; };\n')).toEqual({ language: 'C++', candidates: ['C', 'C++', 'Objective-C'] });
  expect(languageOfPath('header.h', '@interface Value : NSObject\n@end\n')).toEqual({ language: 'Objective-C', candidates: ['C', 'C++', 'Objective-C'] });
});

test('a shebang names the language of a script no extension names', () => {
  expect(languageOfPath('bin/run', '#!/usr/bin/env bash\necho hi\n')).toEqual({ language: 'Shell', candidates: ['Shell'] });
  expect(languageOfPath('bin/run', '#!/bin/sh\necho hi\n')).toEqual({ language: 'Shell', candidates: ['Shell'] });
  expect(languageOfPath('bin/tool', '#!/usr/bin/env python3\nprint("hi")\n')).toEqual({ language: 'Python', candidates: ['Python'] });
  expect(languageOfPath('bin/tool', '#!/usr/bin/env node\nconsole.log("hi")\n')).toEqual({ language: 'JavaScript', candidates: ['JavaScript'] });
  expect(languageOfPath('README', 'plain words\n')).toEqual({ language: 'unknown', candidates: ['unknown'] });
});

 test('tree publication parses new blobs and preserves an explicit git attribute', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { readRepositoryTree } = await import('../plugins/disk/reader.js');
  const root = mkdtempSync(join(tmpdir(), 'language-tree-'));
  const previousGit = process.env['MADARCH_TOOL_GIT'];
  process.env['MADARCH_TOOL_GIT'] = Bun.which('git') ?? (() => { throw new Error('git is required'); })();
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
  } finally {
    if (previousGit === undefined) delete process.env['MADARCH_TOOL_GIT'];
    else process.env['MADARCH_TOOL_GIT'] = previousGit;
    rmSync(root,{recursive:true,force:true});
  }
},60_000);


test('a tree names the language of every fixture file: ambiguous extensions, a shebang script and .gitignore', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { readRepositoryTree } = await import('../plugins/disk/reader.js');
  const root = mkdtempSync(join(tmpdir(), 'language-fixture-'));
  const previousGit = process.env['MADARCH_TOOL_GIT'];
  process.env['MADARCH_TOOL_GIT'] = Bun.which('git') ?? (() => { throw new Error('git is required'); })();
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]).toString().trim();
  try {
    git('init', '-q');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'a.tsx'), 'export const A = () => <div />;\n');
    writeFileSync(join(root, 'a.json'), '{"name":"example"}\n');
    writeFileSync(join(root, 'a.md'), '# A document\n');
    writeFileSync(join(root, 'a.yaml'), 'name: example\n');
    writeFileSync(join(root, 'a.sh'), '#!/bin/sh\necho hi\n');
    writeFileSync(join(root, 'script'), '#!/usr/bin/env bash\necho hi\n');
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    git('add', '-A');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
    const read = await readRepositoryTree({ repository: 'fixture', root, commit: git('rev-parse', 'HEAD'), url: '' });
    expect(Object.fromEntries(read.files.map((file) => [file.path, file.language]))).toEqual({
      '.gitignore': 'Ignore List',
      'a.json': 'JSON',
      'a.md': 'Markdown',
      'a.sh': 'Shell',
      'a.ts': 'TypeScript',
      'a.tsx': 'TSX',
      'a.yaml': 'YAML',
      script: 'Shell',
    });
  } finally {
    if (previousGit === undefined) delete process.env['MADARCH_TOOL_GIT'];
    else process.env['MADARCH_TOOL_GIT'] = previousGit;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('this repository decides all but at most 2% of its tracked files', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\u0000').filter((path) => path !== '');
  expect(paths.length).toBeGreaterThan(1_000);
  const undecided: string[] = [];
  for (const path of paths) {
    let content: string | undefined;
    try {
      const bytes = readFileSync(join(root, path));
      if (!bytes.includes(0)) content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch { /* A file this reader cannot read is no text, and its name alone answers. */ }
    if (languageOfPath(path, content).language === 'ambiguous') undecided.push(path);
  }
  const byExtension = new Map<string, number>();
  for (const path of undecided) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : name;
    byExtension.set(extension, (byExtension.get(extension) ?? 0) + 1);
  }
  const listed = [...byExtension].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([extension, count]) => `${extension} (${String(count)})`).join(', ');
  if (undecided.length > paths.length * 0.02) throw new Error(`${String(undecided.length)} of ${String(paths.length)} tracked files stay undecided; extensions: ${listed}`);
  expect(undecided.length).toBeLessThanOrEqual(Math.floor(paths.length * 0.02));
}, 120_000);
