import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { productFileReaderViolations } from '../scripts/check/architecture/product-file-readers.js';
import { architectureCheck, architectureCheckPasses, architectureProblemLines, renderViolationListOf } from '../scripts/check/architecture/check.js';

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'madarch-reader-rule-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), {recursive: true});
    writeFileSync(join(root, file), text);
  }
  mkdirSync(join(root, '.architecture'), {recursive: true});
  writeFileSync(join(root, '.architecture/violations.json'), '[]');
  return root;
}

const SURFACES = {
  'src/knowledge/product-files.ts': 'export interface ProductFileSource { text(path: string): string; }',
  'src/knowledge/graph-read.ts': 'export class GraphReader { content(repo: string, path: string) {return "";} contentsOf(repo: string, paths: string[]) {return new Map();} contentAt(repo: string,path:string,commit:string){return "";} }',
  'src/knowledge/markdown.ts': 'export function splitFrontMatter(text: string) { return text; }',
};

test('resolved reader types, renamed imports, namespaces, local aliases and element calls cannot conceal graph text', () => {
  const root = fixture({...SURFACES,
    'src/consumer.ts': `import type {ProductFileSource as Source} from './knowledge/product-files.js';
import {GraphReader as Renamed} from './knowledge/graph-read.js';
import * as grammar from './knowledge/markdown.js';
import {splitFrontMatter as renamedParser} from './knowledge/markdown.js';
function page(files: Source, graph: Renamed) {
  files.text('docs/a.md');
  graph.content('repo', 'a');
  const bytes = graph.contentsOf;
  bytes('repo', ['a']);
  graph['contentAt']('repo', 'a', 'commit');
  grammar.splitFrontMatter('a');
  renamedParser('b');
}
`,
  });
  try {
    const found = productFileReaderViolations(root).filter((row) => row.file === 'src/consumer.ts');
    expect(found.map((row) => row.symbol)).toEqual(expect.arrayContaining([
      'call:src/knowledge/product-files.ts:text',
      'call:src/knowledge/graph-read.ts:content',
      'call:src/knowledge/graph-read.ts:contentsOf',
      'call:src/knowledge/graph-read.ts:contentAt',
      'call:src/knowledge/markdown.ts:splitFrontMatter',
      'dependency:src/knowledge/markdown.ts:splitFrontMatter',
    ]));
    expect(found.find((row) => row.symbol === 'call:src/knowledge/product-files.ts:text')?.line).toBe(6);
    expect(found.find((row) => row.symbol === 'call:src/knowledge/graph-read.ts:contentsOf')?.line).toBe(9);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('moving raw reader declarations into plugins does not permit engine callers', () => {
  const root = fixture({
    'src/plugin/product-files.ts': 'export interface ProductFileSource { text(path: string): string; }',
    'src/reader.ts': "import type {ProductFileSource} from './plugin/product-files.js'; export function read(source: ProductFileSource) {return source.text('docs/a.md');}",
    'src/plugin/reader.ts': "import type {ProductFileSource} from './product-files.js'; export function read(source: ProductFileSource) {return source.text('docs/a.md');}",
  });
  try {
    expect(productFileReaderViolations(root)).toEqual([
      {rule:'product-file-readers', file:'src/reader.ts', line:1, symbol:'call:src/plugin/product-files.ts:text'},
    ]);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('URL target parsing does not read product-file text', () => {
  const root = fixture({
    'src/knowledge/markdown.ts': 'export function parseTarget(url: string) {return new URL(url);}',
    'src/consumer.ts': "import {parseTarget as target} from './knowledge/markdown.js'; target('https://example.test');",
  });
  try { expect(productFileReaderViolations(root)).toEqual([]); }
  finally {rmSync(root, {recursive: true, force: true});}
});

test('parser declarations and re-export dependencies are covered even without a file open', () => {
  const root = fixture({...SURFACES,
    'src/barrel.ts': "export { splitFrontMatter as parse } from './knowledge/markdown.js';",
    'src/type-only.ts': "import type {splitFrontMatter} from './knowledge/markdown.js';",
    'src/use-barrel.ts': "import {parse as converted} from './barrel.js'; converted('text');",
  });
  try {
    const found = productFileReaderViolations(root);
    expect(found).toEqual(expect.arrayContaining([
      expect.objectContaining({file: 'src/knowledge/markdown.ts', symbol: 'parser:src/knowledge/markdown.ts:splitFrontMatter'}),
      expect.objectContaining({file: 'src/barrel.ts', symbol: 'dependency:src/knowledge/markdown.ts:splitFrontMatter'}),
      expect.objectContaining({file: 'src/use-barrel.ts', symbol: 'call:src/knowledge/markdown.ts:splitFrontMatter'}),
    ]));
    expect(found.filter((row) => row.file === 'src/type-only.ts')).toEqual([]);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('fs aliases trace product paths while unrelated state reads and same-named methods pass', () => {
  const root = fixture({
    'src/reader.ts': `import {readFileSync as bytes} from 'node:fs';
import * as filesystem from 'node:fs';
import {readFile as asyncBytes} from 'node:fs/promises';
import {join} from 'node:path';
export async function read(productFolder: string, home: string) {
 const path = join(productFolder, 'custom.txt');
 bytes(path, 'utf8');
 filesystem.readFileSync(join(productFolder, 'more.txt'));
 await asyncBytes(join(productFolder, 'third.txt'));
 bytes(join(home, 'settings.json'));
 const unrelated = {text: (x: string) => x, content: () => ''};
 unrelated.text('nothing'); unrelated.content();
 console.log('show', 'cat-file');
}
`,
  });
  try {
    const found = productFileReaderViolations(root);
    expect(found.map((row) => [row.symbol,row.line])).toEqual([
      ['filesystem:readFile', 9], ['filesystem:readFileSync', 7],
    ]);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('git plumbing calls are found through wrappers and renamed child-process imports, not prose', () => {
  const root = fixture({
    'src/git.ts': `import {execFileSync as run} from 'node:child_process';
function git(args: string[]) {return run('git', args);}
function read(commit: string, path: string) {
 git(['show', commit + ':' + path]);
 run('git', ['cat-file', 'blob', commit]);
 git(['show', '-s', '--format=%cI', commit]);
 console.log('cat-file');
}
`,
  });
  try {
    expect(productFileReaderViolations(root)).toEqual([
      {rule:'product-file-readers', file:'src/git.ts', line:4, symbol:'git:file-text'},
    ]);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('only plugin and precise manifest loader files are exempt; the rest of knowledge is not', () => {
  const body = "import {parseDocument as yaml} from 'yaml'; yaml('text');";
  const root = fixture({
    'src/plugin/parser.ts':body, 'src/product/manifest.ts':body,
    'src/product/manifest/kinds.ts':body,
    'src/product/manifest/not-a-loader.ts':body,
    'src/knowledge/a.ts':body,
    'src/knowledge/z.ts':"import * as grammar from 'yaml'; grammar.parse('text');",
  });
  try {
    const found = productFileReaderViolations(root);
    expect(found.map((row) => row.file)).toEqual(['src/knowledge/a.ts', 'src/knowledge/z.ts', 'src/product/manifest/not-a-loader.ts']);
    expect(found.map((row) => row.symbol)).toEqual(['parser-call:yaml:parseDocument', 'parser-call:yaml:parse', 'parser-call:yaml:parseDocument']);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('the wired rule reports full path and line, baselines current debt, then refuses stale debt', async () => {
  const root = fixture({...SURFACES});
  try {
    const first = await architectureCheck({root, rules:['product-file-readers']});
    expect(architectureCheckPasses(first)).toBe(false);
    expect(architectureProblemLines(first)[0]).toContain(`${join(root,'src/knowledge/markdown.ts')}:1: product-file-readers:`);
    writeFileSync(join(root,'.architecture/violations.json'),renderViolationListOf(first));
    expect(architectureCheckPasses(await architectureCheck({root, rules:['product-file-readers']}))).toBe(true);
    rmSync(join(root,'src/knowledge/markdown.ts'));
    const reduced = await architectureCheck({root,rules:['product-file-readers']});
    expect(reduced.comparison.stale).toHaveLength(1);
    expect(architectureCheckPasses(reduced)).toBe(false);
  } finally {rmSync(root, {recursive:true,force:true});}
});
