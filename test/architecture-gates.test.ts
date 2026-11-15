/**
 * The strict gates of madarch-64o5.121: one rule per agreed principle, each read from the TypeScript or the PostgreSQL
 * syntax tree, each held against the debt list .architecture/violations.json writes. Every case plants a violation in a
 * fixture tree and reads the rule's own answer: a rule that cannot refuse its own plant is not a gate.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appGraphReadViolations,
  cataloguePointerViolations,
  commandListViolations,
  extractionViolations,
  i18nViolations,
  ioSpansViolations,
  productDataViolations,
  regexViolations,
  routeAliasViolations,
  stateMachineViolations,
  tableSourceViolations,
  uiKitViolations,
} from '../scripts/check/architecture/gates.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-gates-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let trees = 0;

/** A fixture tree of the given files, in a folder of its own: every case plants its own violation. */
function fixture(files: Readonly<Record<string, string>>): string {
  trees += 1;
  const home = join(root, `t${String(trees)}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  return home;
}

const catalogue = (kind: string, body: string): Record<string, string> => ({ [`catalog/work/execution/${kind}.yaml`]: body });

describe('gate 1: the engine holds no product data', () => {
  test('a literal naming a catalogue kind or field is refused, and a plain literal passes', async () => {
    const home = fixture({
      ...catalogue('demo.task', 'id: practice.demo-task\nfields:\n  - name: statement\n    type: text\n    producers: [person]\n'),
      'src/a.ts': "export const kind = 'demo.task';\nexport const field = 'statement';\nexport const fine = 'an ordinary word';\n",
    });
    const found = productDataViolations(home);
    expect(found.map((violation) => [violation.file, violation.line, violation.symbol])).toEqual([
      ['src/a.ts', 1, 'demo.task'],
      ['src/a.ts', 2, 'statement'],
    ]);
  });

  test('a word the manifest format declares is the engine\'s, and only a catalogue-only word is product data', async () => {
    const home = fixture({
      // The reader's own declaration: the format's vocabulary list and the property its type declares.
      'src/product/manifest/kinds.ts': [
        'export const KIND_FIELDS: readonly string[] = [\'definition\', \'labels\'];',
        'export interface KindDecl { readonly descriptions?: Readonly<Record<string, string>>; }',
        '',
      ].join('\n'),
      ...catalogue('demo.task', 'id: practice.demo-task\nfields:\n  - name: definition\n    type: text\n    producers: [person]\n  - name: labels\n    type: text\n    producers: [person]\n  - name: statement\n    type: text\n    producers: [person]\n'),
      'src/a.ts': "export const format = ['definition', 'labels', 'descriptions'];\nexport const data = 'statement';\n",
    });
    // `definition`, `labels` and `descriptions` are the format's; `statement` only the catalogue declares, so it is data.
    expect(productDataViolations(home).map((violation) => [violation.file, violation.symbol])).toEqual([['src/a.ts', 'statement']]);
  });

  test('an import from catalog/ is refused: the engine reads the product\'s own files', async () => {
    const home = fixture({ 'src/a.ts': "import { x } from '../catalog/work/execution/task.yaml';\nexport const y = x;\n" });
    expect(productDataViolations(home).map((violation) => violation.symbol)).toEqual(['import ../catalog/work/execution/task.yaml']);
  });
});

describe('gate 2: everything is a vertex or an edge', () => {
  test('CREATE TABLE outside the graph core and the generator is refused; inside them it passes', async () => {
    const home = fixture({
      'src/a.ts': "export const sql = 'CREATE TABLE demo (id int)';\n",
      'src/adapters/schemas/graph-definition.ts': "export const sql = 'CREATE TABLE node (id bigint)';\n",
      'src/adapters/schemas/graph-contract.ts': "export const sql = 'CREATE TABLE opinions (id bigint)';\n",
    });
    const found = await tableSourceViolations(home);
    expect(found.map((violation) => [violation.file, violation.symbol])).toEqual([['src/a.ts', 'demo']]);
  });

  test('the catalogue refuses a reference field and a free json field', () => {
    const home = fixture(catalogue('demo.task', [
      'id: practice.demo-task',
      'fields:',
      '  - name: owner',
      '    type: json',
      '    reference: demo.person',
      '    producers: [person]',
      '  - name: front',
      '    type: json',
      '    producers: [person]',
      '  - name: title',
      '    type: text',
      '    producers: [person]',
    ].join('\n') + '\n'));
    // The rule's answers are in code point order of the symbol, not of the line.
    expect(cataloguePointerViolations(home).map((violation) => [violation.line, violation.symbol])).toEqual([[7, 'front'], [3, 'owner']]);
  });
});

describe('gate 4: no regex in the engine', () => {
  test('a RegExp literal, new RegExp and RegExp() are refused; a path string is not', async () => {
    const home = fixture({ 'src/a.ts': "const one = /a+/u;\nconst two = new RegExp('b');\nconst three = RegExp('c');\nconst fine = 'a/b';\n" });
    expect(regexViolations(home).map((violation) => [violation.line, violation.symbol])).toEqual([[1, '/a+/'], [3, 'RegExp'], [2, 'new RegExp']]);
  });
});

describe('gate 5: extraction is plugins only', () => {
  test('a file read outside the plugin host and the named infrastructure is refused, and inside them it passes', async () => {
    const home = fixture({
      'src/extract/reader.ts': "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;\n",
      'src/plugin/host.ts': "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;\n",
      'src/product/git.ts': "import { execFileSync } from 'node:child_process';\nexport const git = execFileSync;\n",
    });
    expect(extractionViolations(home).map((violation) => [violation.file, violation.symbol])).toEqual([['src/extract/reader.ts', 'node:fs']]);
  });
});

describe('gate 6: one command list and one route list', () => {
  test('a command the closed list does not hold is refused, and a declared command the line drops is too', async () => {
    const home = fixture({ 'src/product/cli.ts': [
      'export const COMMANDS = { start: {}, stop: {}, alias: {} };',
    ].join('\n') });
    const found = commandListViolations(home);
    expect(found.some((violation) => violation.symbol === 'alias')).toBe(true);
    expect(found.some((violation) => violation.symbol === 'declared serve')).toBe(true);
  });

  test('a route table entry that spells its path is an alias and is refused', async () => {
    const home = fixture({ 'src/server/http.ts': [
      'export const routes = [',
      "  { method: 'GET', path: '/models', handle: () => undefined },",
      '];',
    ].join('\n') });
    expect(routeAliasViolations(home).map((violation) => [violation.line, violation.symbol])).toEqual([[2, '/models']]);
  });
});

describe('gate 7: a page reads the graph, never a bespoke route', () => {
  test('a page importing a read command is refused, and a command import passes', async () => {
    const home = fixture({
      'wiki/app/src/components/page.tsx': "import { readProblems, makeProblemTask } from './command.js';\nexport const x = [readProblems, makeProblemTask];\n",
    });
    expect(appGraphReadViolations(home).map((violation) => violation.symbol)).toEqual(['readProblems']);
  });
});

describe('gate 8: the UI is built from the kit only', () => {
  test('an intrinsic element and a className are refused outside the kit, and pass inside it', async () => {
    const home = fixture({
      'wiki/app/src/components/tile.tsx': 'export const Tile = () => <div className="p-2" />;\n',
      'wiki/app/src/components/ui/tile.tsx': 'export const Tile = () => <div className="p-2" />;\n',
    });
    expect(uiKitViolations(home).map((violation) => [violation.file, violation.symbol])).toEqual([
      ['wiki/app/src/components/tile.tsx', 'className on <div>'],
      ['wiki/app/src/components/tile.tsx', 'element <div>'],
    ]);
  });
});

describe('gate 9: every visible string through i18n', () => {
  test('JSX text and a literal in a visible prop are refused, and a translated key passes', async () => {
    const home = fixture({
      'wiki/app/src/components/page.tsx': 'export const Page = ({ t }: { t: (key: string) => string }) => (<Text title="Hello">Save {t("save")}</Text>);\n',
    });
    expect(i18nViolations(home).map((violation) => violation.symbol)).toEqual(['Save', 'title: Hello']);
  });
});

describe('gate 10: I/O runs inside a span', () => {
  test('an I/O call outside a span is refused, and one inside withSpan passes', async () => {
    const home = fixture({ 'src/a.ts': [
      'export async function unspanned(): Promise<unknown> {',
      "  return await fetch('https://example.test');",
      '}',
      'export async function spanned(): Promise<unknown> {',
      "  return await withSpan('a', {}, async () => await fetch('https://example.test'));",
      '}',
    ].join('\n') });
    expect(ioSpansViolations(home).map((violation) => [violation.line, violation.symbol])).toEqual([[2, 'fetch()']]);
  });
});

describe('gate 11: one state machine', () => {
  test('a run or unit state written outside the state-machine store is refused, and inside it passes', async () => {
    const home = fixture({
      'src/fill/elsewhere.ts': "export const sql = 'UPDATE fill_run SET state = $2 WHERE run_id = $1';\n",
      'src/fill/state-store.ts': "export const sql = 'UPDATE fill_run SET state = $2 WHERE run_id = $1';\n",
    });
    expect((await stateMachineViolations(home)).map((violation) => [violation.file, violation.symbol])).toEqual([['src/fill/elsewhere.ts', 'fill_run']]);
  });
});
