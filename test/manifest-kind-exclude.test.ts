/**
 * A kind's `exclude` (madarch-64o5.83): the product's own path patterns, so no engine list decides what a repository's
 * knowledge is. The parser keeps them and refuses a malformed list; the disk producer leaves the matching paths out.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readKinds } from '../src/product/manifest/kinds.js';
import { parse } from 'yaml';
import { excludedPath } from '../plugins/disk/reader.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

const KIND = (extra: string): string => `id: code.file
purpose: structure
definition: A file.
sources: [https://example.test/standard]
acquisition: [document]
relation-constraints: { out: [], in: [] }
audience: [developer]
template-policy: page
source: graph
title: path
labels:
  en: { one: File, many: Files }
  ru: { one: Файл, many: Файлы }
description: { en: A file., ru: Файл. }
${extra}fields:
- { name: repository, type: text, producers: [person] }
- { name: path, type: text, producers: [person] }
key: [repository, path]
`;

function product(extra: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-kind-exclude-'));
  mkdirSync(join(folder, 'madarch/kinds/code/structure'), { recursive: true });
  writeFileSync(join(folder, 'madarch/catalog.yaml'), [
    'purposes:',
    '  structure: { labels: { en: Structure, ru: Структура }, order: 10 }',
    'groups:',
    '  code: { en: Code, ru: Код, short: { en: Code, ru: Код }, open: true }',
    '  code.structure: { en: Structure, ru: Структура, parent: code, short: { en: Structure, ru: Структура } }',
    'catalog:',
    '  subgroup-kind-bound: 12',
    '  attributes: [version]',
    '  origin-marks: [document, conversation]',
    '  extractor-mark: extractor',
    '  template-policies: [page]',
    '  relations: {}',
    'roles:',
    '  developer:',
    '    lead: [code]',
    '  architect:',
    '    open: [code]',
    '',
  ].join('\n'));
  writeFileSync(join(folder, 'madarch/kinds/code/structure/code.file.yaml'), KIND(extra));
  execFileSync('git', ['init', '-q'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  return folder;
}

test('a kind keeps the path patterns its producer leaves out', () => {
  const folder = product('exclude:\n- "**/node_modules/**"\n- "**/dist/**"\n');
  try {
    const read = readKinds(folder);
    if (!read.present) throw new Error('no manifest');
    const said = read.manifest.findings.map((one) => one.message).join('; ');
    expect(said).toBe('');
    expect(read.manifest.kinds.get('code.file')?.exclude).toEqual(['**/node_modules/**', '**/dist/**']);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a malformed exclude list is refused, naming the field', () => {
  const folder = product('exclude: []\n');
  try {
    const read = readKinds(folder);
    if (!read.present) throw new Error('no manifest');
    expect(read.manifest.findings.map((one) => one.message).join('; ')).toContain('"exclude" is a list of path patterns');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a declared pattern leaves a dependency tree and a build output out, and keeps the product', () => {
  const patterns = ['**/node_modules/**', '**/dist/**'];
  expect(excludedPath('plugins/disk/node_modules/lodash/index.js', patterns)).toBe(true);
  expect(excludedPath('node_modules/react/index.js', patterns)).toBe(true);
  expect(excludedPath('wiki/app/dist/app.js', patterns)).toBe(true);
  expect(excludedPath('src/knowledge/product.ts', patterns)).toBe(false);
  expect(excludedPath('docs/decisions/0020.md', patterns)).toBe(false);
});

test('the starter leaves out only what is never a person\'s source, so a tracked build output stays (madarch-64o5.83)', () => {
  // A product may ship `dist/` on purpose (a GitHub Action's own bundle): a blanket default would drop tracked files
  // (review P2). The starter names the dependency tree and the repository's own folder, and a product may add more.
  for (const file of ['catalog/code/structure/code.file.yaml', 'catalog/code/structure/code.directory.yaml']) {
    const declaration = parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')) as { exclude?: string[] };
    expect({ file, patterns: declaration.exclude }).toEqual({ file, patterns: ['**/node_modules/**', '**/.git/**'] });
  }
});
