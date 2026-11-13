/**
 * The imports reader (decision 0035, items 3, 8, 15 and 24; task madarch-o0eq.6): a repository's TypeScript and JavaScript files,
 * as the graph holds them, become the import edges a reader follows — which file imports which, and which package it names —
 * each edge carrying the place of the import, so the same file pair imported twice is two edges.
 *
 * The reader is judged on a fixture that holds one file per import form: a default, a named and a namespace import, a
 * side-effect import, a type-only import, a re-export, a require, a dynamic import, a tsconfig path and a package. An
 * unresolvable relative specifier is a problem with its place, and the file's other imports are still read.
 */
import { describe, expect, test } from 'bun:test';
import { readRepository, type ImportRecord } from '../plugins/imports/read.js';

/** The fixture's files: one user per import form, its target, and the tsconfig the path form resolves with. */
const FILES: Record<string, string> = {
  'tsconfig.json': `{
  // The repository's own resolution: a path alias and a base the relative rules never see.
  "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } }
}`,
  'src/default-user.ts': "import value from './default-target.js';\n",
  'src/named-user.ts': "import { one, two as second } from './named-target.js';\n",
  'src/namespace-user.ts': "import * as ns from './namespace-target.js';\n",
  'src/side-effect-user.ts': "import './side-effect-target.js';\n",
  'src/type-user.ts': "import type { Shape } from './type-target.js';\n",
  'src/re-export-user.ts': "export { reexported } from './re-export-target.js';\nexport * from './star-target.js';\nexport type { Reexported } from './type-target.js';\n",
  'src/require-user.ts': "const required = require('./require-target.js');\n",
  'src/dynamic-user.ts': "const loaded = import('./dynamic-target.js');\n",
  'src/package-user.ts': "import { readFile } from 'node:fs';\nimport graphql from 'graphql';\nimport sub from '@scope/pkg/sub';\n",
  'src/paths-user.ts': "import { helper } from '@app/helper.js';\n",
  'src/index-user.ts': "import './folder';\n",
  'src/extension-user.ts': "import './component.js';\nimport './esm-target.mjs';\nimport './cjs-target.cjs';\n",
  'src/default-target.ts': 'export default 1;\n',
  'src/named-target.ts': 'export const one = 1;\nexport const two = 2;\n',
  'src/namespace-target.ts': 'export const member = 1;\n',
  'src/side-effect-target.ts': 'export {};\n',
  'src/type-target.ts': 'export type Shape = { id: number };\nexport type Reexported = { id: number };\n',
  'src/re-export-target.ts': 'export const reexported = 1;\n',
  'src/star-target.ts': 'export const star = 1;\n',
  'src/require-target.ts': 'module.exports = { required: 1 };\n',
  'src/dynamic-target.ts': 'export const dynamic = 1;\n',
  'src/helper.ts': 'export const helper = 1;\n',
  'src/folder/index.ts': 'export const folder = 1;\n',
  'src/component.tsx': 'export const Component = (): null => null;\n',
  'src/esm-target.mts': 'export const esm = 1;\n',
  'src/cjs-target.cts': 'export const cjs = 1;\n',
};

/** One line of the fixture, with the place the import opens at. */
function line(path: string, needle: string): { line: number; column: number; lineEnd: number } {
  const lines = FILES[path]!.split('\n');
  const at = lines.findIndex((entry) => entry.includes(needle));
  if (at < 0) throw new Error(`the fixture ${path} holds no line with ${JSON.stringify(needle)}`);
  return { line: at + 1, column: lines[at]!.indexOf(needle) + 1, lineEnd: at + 1 };
}

/** The edge as the test reads it: the file pair or the package, and the place and attributes that tell it apart. */
function edgeOf(record: ImportRecord): Record<string, unknown> {
  return {
    from: record.from,
    to: record.to.kind === 'file' ? record.to.path : `package:${record.to.name}`,
    line: record.line,
    column: record.column,
    lineEnd: record.lineEnd,
    specifier: record.specifier,
    form: record.form,
    ...(record.names === undefined ? {} : { names: record.names }),
    ...(record.typeOnly === true ? { typeOnly: true } : {}),
  };
}

/** The repository the reader reads: every fixture file, keyed by its path. */
const REPOSITORY = {
  repository: 'app',
  files: Object.keys(FILES),
  texts: new Map(Object.entries(FILES)),
  blobs: new Map(Object.keys(FILES).map((path) => [path, `blob-${path}`])),
};

describe('the imports reader', () => {
  test('it reads one edge per import form, with the specifier, the place, the kind and the names as written', () => {
    const read = readRepository(REPOSITORY);
    expect(read.problems).toEqual([]);
    const byPlace = (left: Record<string, unknown>, right: Record<string, unknown>): number => `${String(left['from'])}:${String(left['line'])}:${String(left['column'])}`.localeCompare(`${String(right['from'])}:${String(right['line'])}:${String(right['column'])}`) || String(left['to']).localeCompare(String(right['to']));
    const edges = read.records.map(edgeOf).sort(byPlace);
    const expected = [
      { from: 'src/default-user.ts', to: 'src/default-target.ts', ...line('src/default-user.ts', 'import value'), specifier: './default-target.js', form: 'static', names: ['default'] },
      { from: 'src/named-user.ts', to: 'src/named-target.ts', ...line('src/named-user.ts', 'import { one'), specifier: './named-target.js', form: 'static', names: ['one', 'two'] },
      { from: 'src/namespace-user.ts', to: 'src/namespace-target.ts', ...line('src/namespace-user.ts', 'import * as ns'), specifier: './namespace-target.js', form: 'static', names: ['*'] },
      { from: 'src/side-effect-user.ts', to: 'src/side-effect-target.ts', ...line('src/side-effect-user.ts', "import './side-effect"), specifier: './side-effect-target.js', form: 'static' },
      { from: 'src/type-user.ts', to: 'src/type-target.ts', ...line('src/type-user.ts', 'import type'), specifier: './type-target.js', form: 'type', names: ['Shape'], typeOnly: true },
      { from: 'src/re-export-user.ts', to: 'src/re-export-target.ts', ...line('src/re-export-user.ts', 'export { reexported'), specifier: './re-export-target.js', form: 're-export', names: ['reexported'] },
      { from: 'src/re-export-user.ts', to: 'src/star-target.ts', ...line('src/re-export-user.ts', 'export * from'), specifier: './star-target.js', form: 're-export', names: ['*'] },
      { from: 'src/re-export-user.ts', to: 'src/type-target.ts', ...line('src/re-export-user.ts', 'export type { Reexported'), specifier: './type-target.js', form: 're-export', names: ['Reexported'], typeOnly: true },
      { from: 'src/require-user.ts', to: 'src/require-target.ts', ...line('src/require-user.ts', 'require('), specifier: './require-target.js', form: 'require' },
      { from: 'src/dynamic-user.ts', to: 'src/dynamic-target.ts', ...line('src/dynamic-user.ts', "import('./dynamic"), specifier: './dynamic-target.js', form: 'dynamic' },
      { from: 'src/package-user.ts', to: 'package:node:fs', ...line('src/package-user.ts', "import { readFile }"), specifier: 'node:fs', form: 'static', names: ['readFile'] },
      { from: 'src/package-user.ts', to: 'package:graphql', ...line('src/package-user.ts', "import graphql"), specifier: 'graphql', form: 'static', names: ['default'] },
      { from: 'src/package-user.ts', to: 'package:@scope/pkg', ...line('src/package-user.ts', "import sub"), specifier: '@scope/pkg/sub', form: 'static', names: ['default'] },
      { from: 'src/paths-user.ts', to: 'src/helper.ts', ...line('src/paths-user.ts', 'import { helper }'), specifier: '@app/helper.js', form: 'static', names: ['helper'] },
      { from: 'src/index-user.ts', to: 'src/folder/index.ts', ...line('src/index-user.ts', "import './folder'"), specifier: './folder', form: 'static' },
      { from: 'src/extension-user.ts', to: 'src/component.tsx', ...line('src/extension-user.ts', "import './component.js'"), specifier: './component.js', form: 'static' },
      { from: 'src/extension-user.ts', to: 'src/esm-target.mts', ...line('src/extension-user.ts', "import './esm-target.mjs'"), specifier: './esm-target.mjs', form: 'static' },
      { from: 'src/extension-user.ts', to: 'src/cjs-target.cts', ...line('src/extension-user.ts', "import './cjs-target.cjs'"), specifier: './cjs-target.cjs', form: 'static' },
    ].sort(byPlace);
    expect(edges).toEqual(expected);
    // One package vertex per name and ecosystem, at the first place that names it, in code point order.
    expect(read.packages.map((one) => one.key)).toEqual([
      { ecosystem: 'node', name: '@scope/pkg' },
      { ecosystem: 'node', name: 'graphql' },
      { ecosystem: 'node', name: 'node:fs' },
    ]);
    expect(read.packages.every((one) => one.evidence.repository === 'app' && one.evidence.commitOrDigest?.startsWith('blob-'))).toBe(true);
  });

  test('an unresolvable relative specifier is a problem with its place, and the other imports of the file are still read', () => {
    const read = readRepository({
      repository: 'app',
      files: ['src/a.ts', 'src/util.ts'],
      texts: new Map([
        ['src/a.ts', "import './missing.js';\nimport util from './util.js';\n"],
        ['src/util.ts', 'export default 1;\n'],
      ]),
      blobs: new Map([['src/a.ts', 'blob-a'], ['src/util.ts', 'blob-u']]),
    });
    expect(read.problems).toEqual([
      { repository: 'app', path: 'src/a.ts', line: 1, column: 1, lineEnd: 1, specifier: './missing.js', form: 'static', target: 'src/missing.js', message: 'the relative specifier "./missing.js" resolves to no file of the repository' },
    ]);
    expect(read.records.map(edgeOf)).toEqual([{ from: 'src/a.ts', to: 'src/util.ts', line: 2, column: 1, lineEnd: 2, specifier: './util.js', form: 'static', names: ['default'] }]);
  });

  test('a source the caller did not hand over is not read, and the texts it did hand over are', () => {
    const read = readRepository({
      repository: 'app',
      files: ['src/a.ts', 'src/b.ts'],
      texts: new Map([['src/b.ts', "import a from './a.js';\n"], ['src/a.ts', 'export default 1;\n']]),
      blobs: new Map(),
    });
    expect(read.problems).toEqual([]);
    expect(read.records.map(edgeOf)).toEqual([{ from: 'src/b.ts', to: 'src/a.ts', line: 1, column: 1, lineEnd: 1, specifier: './a.js', form: 'static', names: ['default'] }]);
    const unread = readRepository({ repository: 'app', files: ['src/a.ts'], texts: new Map(), blobs: new Map() });
    expect(unread.records).toEqual([]);
    expect(unread.problems).toEqual([]);
  });
});
