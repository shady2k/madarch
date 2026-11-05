/**
 * The repository the two per-file facts' acceptance tests generate
 * (madarch-8bdc.2.4, step 1 of the port's prerequisites): a handful of files
 * whose manifests declare units at different depths, one folder the repository
 * conventions call another project's, one manifest that declares nothing, one
 * folder holding both manifest kinds, and the code each unit listens with.
 *
 * The expected units are `expectedUnitsOf`'s own answer and the expected ports
 * `expectedPortsOf`'s: the generator says what the facts must be, and the tests
 * compare the published graph with it. `writeProduct` wires the repository into
 * a product the fill can run on, as `madarch repo add` does: by a link under
 * `repos/`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The product's repository name, and the name the fill reads it under. */
export const UNITS_REPOSITORY = 'units';

/** One unit a file belongs to, as the fact must carry it. */
export interface ExpectedUnit {
  readonly name: string;
  readonly root: string;
  readonly manifestPath: string;
  readonly ecosystem: 'go' | 'node';
  readonly declared: string;
}

/** One port a file's code listens on, and the unit it serves where one declares it. */
export interface ExpectedPort {
  readonly file: string;
  readonly port: string;
  readonly service?: string;
}

/** The Go file whose server listens on a constant address: a port read through the file's constants. */
export const ORDERS_MAIN = 'services/orders/cmd/main.go';

/** The TypeScript file of a nested unit: a port read from the app's `listen`, and a `new` expression. */
export const TOOLS_FILE = 'services/orders/tools/src/tool.ts';

/** The TypeScript file of the outer unit: a port read from the app's `listen`. */
export const WEB_FILE = 'services/web/src/index.ts';

/** The file under a folder the repository conventions call another project's: it belongs to the unit above it. */
export const VENDORED_FILE = 'services/web/node_modules/dep/index.js';

/** The file of the manifest that names nothing: the folder names its unit. */
export const NAMELESS_FILE = 'services/nameless/src/x.ts';

/** The file of the go.mod that declares no module: no manifest declares a unit for it. */
export const NOMODULE_FILE = 'services/nomodule/x.go';

/** The file of the folder that holds both manifest kinds: the smaller declared name answers. */
export const BOTH_FILE = 'services/both/src/b.ts';

/** The repository's bytes, by path: text, or the raw bytes of a manifest that is not UTF-8 text. */
const FILES: readonly { readonly path: string; readonly text?: string; readonly bytes?: readonly number[] }[] = [
  { path: 'README.md', text: '# Units\n\nThe units of the fixture.\n' },
  { path: 'services/orders/go.mod', text: 'module training.example/orders\n\ngo 1.23\n' },
  {
    path: ORDERS_MAIN,
    text: [
      'package main',
      '',
      'import "net/http"',
      '',
      'const listenAddr = ":8080"',
      '',
      'func main() {',
      '\tserver := &http.Server{Addr: listenAddr}',
      '\t_ = server.ListenAndServe()',
      '}',
      '',
    ].join('\n'),
  },
  { path: 'services/orders/internal/order.go', text: 'package internal\n\ntype Order struct {\n\tID string\n}\n' },
  { path: 'services/orders/tools/package.json', text: '{\n  "name": "@acme/orders-tools",\n  "version": "1.0.0"\n}\n' },
  {
    path: TOOLS_FILE,
    text: [
      'import express from "express";',
      '',
      'const app = express();',
      'const PORT = 8090;',
      'const startedAt = new Date();',
      '',
      'app.listen(PORT);',
      'export const started = startedAt;',
      '',
    ].join('\n'),
  },
  { path: 'services/web/package.json', text: '{\n  "name": "@acme/web",\n  "version": "1.0.0"\n}\n' },
  {
    path: WEB_FILE,
    text: [
      'import express from "express";',
      '',
      'const app = express();',
      'const PORT = 8083;',
      '',
      'app.listen(PORT);',
      '',
    ].join('\n'),
  },
  { path: 'services/web/node_modules/dep/package.json', text: '{\n  "name": "dep",\n  "version": "2.0.0"\n}\n' },
  { path: VENDORED_FILE, text: 'export const dep = 1;\n' },
  { path: 'services/nameless/package.json', text: '{\n  "version": "1.0.0"\n}\n' },
  { path: NAMELESS_FILE, text: 'export const x = 1;\n' },
  { path: 'services/nomodule/go.mod', text: 'go 1.23\n' },
  { path: NOMODULE_FILE, text: 'package nomodule\n\nconst Name = "nomodule"\n' },
  { path: 'services/both/go.mod', text: 'module training.example/zeta\n\ngo 1.23\n' },
  { path: 'services/both/package.json', text: '{\n  "name": "alpha",\n  "version": "1.0.0"\n}\n' },
  { path: BOTH_FILE, text: 'export const b = 1;\n' },
  // A folder whose go.mod declares the smaller name: the smaller name answers, whatever order
  // the manifests are read in.
  { path: 'services/first/go.mod', text: 'module training.example/aaa\n\ngo 1.23\n' },
  { path: 'services/first/package.json', text: '{\n  "name": "zzz",\n  "version": "1.0.0"\n}\n' },
  { path: 'services/first/src/f.ts', text: 'export const f = 1;\n' },
  // A manifest whose name is blank is known by its folder, and one whose name is padded is
  // read trimmed: both are `serviceUnits`' own rules.
  { path: 'services/blank/package.json', text: '{\n  "name": "   ",\n  "version": "1.0.0"\n}\n' },
  { path: 'services/blank/src/x.ts', text: 'export const x = 1;\n' },
  // The name is padded and carries a trailing slash: it is read trimmed, and its last
  // non-empty segment names the unit.
  { path: 'services/spaced/package.json', text: '{\n  "name": "  @acme/spaced/  ",\n  "version": "1.0.0"\n}\n' },
  { path: 'services/spaced/src/x.ts', text: 'export const x = 1;\n' },
  // A folder whose two manifests declare the same name: the tree's path order answers, and
  // `go.mod` stands before `package.json`, as `serviceUnits` indexes them.
  { path: 'services/tie/go.mod', text: 'module training.example/tie\n\ngo 1.23\n' },
  { path: 'services/tie/package.json', text: '{\n  "name": "tie",\n  "version": "1.0.0"\n}\n' },
  { path: 'services/tie/src/t.ts', text: 'export const t = 1;\n' },
  // A manifest that declares nothing nearer than the unit above it: the walk continues.
  { path: 'services/first/nomodule/go.mod', text: 'go 1.23\n' },
  { path: 'services/first/nomodule/x.go', text: 'package nomodule\n' },
  // A go.mod whose module path is a dot: its last segment is empty, so it declares no unit.
  { path: 'services/dot/go.mod', text: 'module .\n\ngo 1.23\n' },
  { path: 'services/dot/src/x.ts', text: 'export const x = 1;\n' },
  // A file that listens where no manifest declares a unit: the port fact carries no service.
  {
    path: 'services/dot/src/server.ts',
    text: [
      'import express from "express";',
      '',
      'const app = express();',
      'const PORT = 8091;',
      '',
      'app.listen(PORT);',
      '',
    ].join('\n'),
  },
  // A manifest whose bytes are not UTF-8 text is read as `serviceUnits` reads it: the folder names it.
  { path: 'services/broken/package.json', bytes: [0xff, 0xfe, 0x00, 0x7b] },
  { path: 'services/broken/src/x.ts', text: 'export const x = 1;\n' },
  // A manifest above the static reading cap: its declaration cannot be read, and the file is a
  // named coverage gap rather than a file read as if it were whole.
  { path: 'services/big/package.json', text: `{\n  "name": "big",\n  "padding": "${'x'.repeat(1_048_576)}"\n}\n` },
  { path: 'services/big/src/x.ts', text: 'export const x = 1;\n' },
];

/** Every unit the fact must publish for the fixture's files, by path, in code point order. */
export function expectedUnitByFile(): ReadonlyMap<string, ExpectedUnit> {
  const orders: ExpectedUnit = { name: 'orders', root: 'services/orders', manifestPath: 'services/orders/go.mod', ecosystem: 'go', declared: 'training.example/orders' };
  const tools: ExpectedUnit = { name: 'orders-tools', root: 'services/orders/tools', manifestPath: 'services/orders/tools/package.json', ecosystem: 'node', declared: '@acme/orders-tools' };
  const web: ExpectedUnit = { name: 'web', root: 'services/web', manifestPath: 'services/web/package.json', ecosystem: 'node', declared: '@acme/web' };
  const nameless: ExpectedUnit = { name: 'nameless', root: 'services/nameless', manifestPath: 'services/nameless/package.json', ecosystem: 'node', declared: 'nameless' };
  const both: ExpectedUnit = { name: 'alpha', root: 'services/both', manifestPath: 'services/both/package.json', ecosystem: 'node', declared: 'alpha' };
  // The fact is published for the files this stage reads — the repository's source code — and a
  // manifest's own unit is the unit it declares, which its reader already holds.
  const expected = new Map<string, ExpectedUnit>();
  for (const path of [ORDERS_MAIN, 'services/orders/internal/order.go']) expected.set(path, orders);
  expected.set(TOOLS_FILE, tools);
  for (const path of [WEB_FILE, VENDORED_FILE]) expected.set(path, web);
  expected.set(NAMELESS_FILE, nameless);
  expected.set(BOTH_FILE, both);
  expected.set('services/first/src/f.ts', { name: 'aaa', root: 'services/first', manifestPath: 'services/first/go.mod', ecosystem: 'go', declared: 'training.example/aaa' });
  expected.set('services/blank/src/x.ts', { name: 'blank', root: 'services/blank', manifestPath: 'services/blank/package.json', ecosystem: 'node', declared: 'blank' });
  expected.set('services/spaced/src/x.ts', { name: 'spaced', root: 'services/spaced', manifestPath: 'services/spaced/package.json', ecosystem: 'node', declared: '@acme/spaced/' });
  expected.set('services/tie/src/t.ts', { name: 'tie', root: 'services/tie', manifestPath: 'services/tie/go.mod', ecosystem: 'go', declared: 'training.example/tie' });
  expected.set('services/first/nomodule/x.go', { name: 'aaa', root: 'services/first', manifestPath: 'services/first/go.mod', ecosystem: 'go', declared: 'training.example/aaa' });
  expected.set('services/broken/src/x.ts', { name: 'broken', root: 'services/broken', manifestPath: 'services/broken/package.json', ecosystem: 'node', declared: 'broken' });
  // The go.mod that names no module declares nothing, and no ancestor declares a unit: the
  // file belongs to none, exactly as `serviceUnits` answers.
  return new Map([...expected].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)));
}

/** Every port the fact must publish, in code point order of the files. */
export function expectedPortsOf(): readonly ExpectedPort[] {
  return [
    { file: ORDERS_MAIN, port: '8080', service: 'orders' },
    { file: TOOLS_FILE, port: '8090', service: 'orders-tools' },
    { file: WEB_FILE, port: '8083', service: 'web' },
    { file: 'services/dot/src/server.ts', port: '8091' },
  ];
}

/** One git call in the generated repository, with the fixed identity and date every commit of it carries. */
function git(folder: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: folder,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Units Fixture',
      GIT_AUTHOR_EMAIL: 'units@example.invalid',
      GIT_COMMITTER_NAME: 'Units Fixture',
      GIT_COMMITTER_EMAIL: 'units@example.invalid',
      GIT_AUTHOR_DATE: '2024-04-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2024-04-01T00:00:00Z',
    },
  }).trim();
}

/** Writes the fixture repository into `folder` and commits it, answering the commit it stands on. */
export function writeUnitsRepository(folder: string): string {
  mkdirSync(folder, { recursive: true });
  git(folder, ['init', '-q', '-b', 'main']);
  git(folder, ['config', 'user.name', 'Units Fixture']);
  git(folder, ['config', 'user.email', 'units@example.invalid']);
  for (const file of FILES) {
    mkdirSync(join(folder, file.path, '..'), { recursive: true });
    writeFileSync(join(folder, file.path), file.bytes === undefined ? file.text! : new Uint8Array(file.bytes));
  }
  git(folder, ['add', '-A']);
  git(folder, ['commit', '-qm', 'the units fixture']);
  return git(folder, ['rev-parse', 'HEAD']);
}

/** The product the fill runs on: the fixture repository connected under `repos/`, and the product repository itself. */
export function writeUnitsProduct(root: string): { readonly product: string; readonly repository: string; readonly repositoryName: string } {
  const product = join(root, 'product');
  const repository = join(root, UNITS_REPOSITORY);
  writeUnitsRepository(repository);
  mkdirSync(join(product, 'repos'), { recursive: true });
  symlinkSync(repository, join(product, 'repos', UNITS_REPOSITORY), 'dir');
  // The stages the facts stand on: the snapshot and the inventory's file nodes. Every other
  // deterministic stage is disabled, so the acceptance reads the code-facts stage's work and
  // nothing beside it (the full pipeline is `test/fill-stages.test.ts`'s case).
  writeFileSync(join(product, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 7c4e1d2a-9b3f-4a61-8d2e-5f0a1b2c3d4e',
    'name: units-product',
    'repos:',
    `  - name: ${UNITS_REPOSITORY}`,
    '    url: file:///units',
    'fill:',
    '  stages:',
    ...['build-configuration', 'document-index', 'history', 'modules', 'semantic-resolution', 'state-machines', 'syntax'].flatMap((id) => [`    ${id}:`, '      enabled: false']),
    '',
  ].join('\n'));
  git(product, ['init', '-q', '-b', 'main']);
  git(product, ['config', 'user.name', 'Units Fixture']);
  git(product, ['config', 'user.email', 'units@example.invalid']);
  git(product, ['add', '-A']);
  git(product, ['commit', '-qm', 'the units product']);
  return { product, repository, repositoryName: UNITS_REPOSITORY };
}

/** Commits one changed file in the fixture repository, answering the new commit. */
export function commitChange(repository: string, path: string, text: string): string {
  writeFileSync(join(repository, path), text);
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-qm', `change ${path}`]);
  return git(repository, ['rev-parse', 'HEAD']);
}
