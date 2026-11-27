import { describe, expect, spyOn, test } from 'bun:test';
import * as swc from '@swc/core';
import { testFileImportViolations } from '../scripts/check/architecture/test-file-imports.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { architectureCheck, architectureCheckPasses, architectureProblemLines, renderViolationListOf, VIOLATION_LIST } from '../scripts/check/architecture/check.js';
import { baseGuard, baseGuardPasses, baseGuardProblemLines } from '../scripts/check/architecture/base-guard.js';
import type { ArchitectureRule, ListedViolation } from '../scripts/check/architecture/violation.js';

/**
 * The architecture check of decision 0033, item 4: one writer for the graph, one
 * storage layer, one entry point per fill, and no code unreachable from the declared
 * entry points, each held against the list of violations the project has accepted.
 *
 * Every case plants one violation in a throwaway module of a fixture project the
 * case writes, and reads the check's own answer: the rule's name, the module and the
 * line. A plant the rule does not see, or one it sees in a module that does not break
 * it, fails the case — a rule that cannot fail is not a rule.
 */

// The rules read the fixture's folders, and knip runs as a program of its own: a case
// that runs it twice (baselined, then planted) costs a few seconds each time.
const KNIP_CASE_MS = 120_000;

/**
 * The fixture project: one module per thing the rules speak of, laid out the way the
 * repository lays them out, with one program (`src/index.ts`) reaching the graph store
 * through the store's own barrel and the orchestrator host — and nothing importing a
 * fill runner or the connection. `src/writer/view.ts` reads a producer's name from the
 * module that also holds `fillGraph`, which is not a fill entry: the fill rule is
 * about names, and this case holds it to that.
 */
const FIXTURE: Readonly<Record<string, readonly string[]>> = {
  'package.json': [JSON.stringify({ name: 'madarch-architecture-fixture', private: true, type: 'module' }, null, 2)],
  'knip.json': [
    JSON.stringify(
      { bun: false, entry: ['src/index.ts'], project: ['src/**/*.ts'], include: ['files'] },
      null,
      2,
    ),
  ],
  'knip.production.json': [
    JSON.stringify(
      { bun: false, entry: ['src/index.ts!'], project: ['src/**/*.ts!'], include: ['files', 'exports', 'nsExports', 'types', 'nsTypes', 'enumMembers'] },
      null,
      2,
    ),
  ],
  'src/index.ts': ["import { write } from './graph/index.js';", '', 'export const entry = write;', ''],
  'src/graph/write.ts': ['/** The graph store\'s one writer. */', 'export function write(): string {', "  return 'written';", '}', ''],
  'src/graph/index.ts': ["export { write } from './write.js';", ''],
  'src/adapters/database-owner.ts': [
    "import type { SqlTransactionKind } from '../sql-driver.js';",
    '',
    '/** The process\'s one connection. */',
    'export interface DatabaseOwner {',
    '  query(sql: string): Promise<unknown>;',
    '  transaction<T>(kind: SqlTransactionKind, work: (transaction: unknown) => Promise<T>): Promise<T>;',
    '}',
    '',
  ],
  'src/sql-driver.ts': [
    '/** What a module runs a statement through. */',
    'export interface SqlExecutor {',
    '  query(sql: string): Promise<unknown>;',
    '}',
    '',
    'export type SqlTransactionKind = \'snapshot\' | \'write\';',
    '',
  ],
  'src/extract/driver/index.ts': [
    '/** The extract driver: a fill runner and a producer\'s name beside it. */',
    "export const DRIVER_PRODUCER = 'driver';",
    'export async function fillGraph(): Promise<void> {}',
    '',
  ],
  'src/fill/orchestrator.ts': ['/** The stage registry\'s runner. */', 'export async function driveRun(): Promise<void> {}', ''],
  'src/fill/orchestrator-host.ts': [
    "import { driveRun } from './orchestrator.js';",
    '',
    '/** The one module that starts a fill. */',
    'export function createFillOrchestratorService(): unknown {',
    '  return driveRun;',
    '}',
    '',
  ],
  'src/knowledge/fill-worker.ts': ['/** The knowledge fill worker\'s own loop. */', 'export async function runFillWorker(): Promise<void> {}', ''],
  'src/product/fill.ts': ['/** The product CLI\'s own fill. */', 'export async function startFill(): Promise<void> {}', ''],
  'src/product/fill-stages.ts': ['/** The declared stages\' wiring. */', 'export async function createStagesFill(): Promise<void> {}', ''],
  'src/writer/view.ts': [
    "import { DRIVER_PRODUCER } from '../extract/driver/index.js';",
    '',
    'export const view = DRIVER_PRODUCER;',
    '',
  ],
};

/** Writes the fixture project into a folder of its own and answers the folder. */
function fixtureProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'madarch-architecture-'));
  for (const [file, lines] of Object.entries(FIXTURE)) writeModule(root, file, lines);
  mkdirSync(join(root, '.architecture'), { recursive: true });
  writeFileSync(join(root, VIOLATION_LIST), '[]\n');
  return root;
}

function writeModule(root: string, file: string, lines: readonly string[]): void {
  mkdirSync(join(root, dirname(file)), { recursive: true });
  writeFileSync(join(root, file), `${lines.join('\n')}\n`);
}

/** The line a module writes a piece of text on, 1-based: what the check must name. */
function lineOf(lines: readonly string[], text: string): number {
  const index = lines.findIndex((line) => line.includes(text));
  if (index < 0) throw new Error(`the fixture's case writes ${JSON.stringify(text)} on no line`);
  return index + 1;
}

/** Writes down exactly what the rules find now, as the repository's own list does. */
async function acceptWhatIsFound(root: string, rules: readonly ArchitectureRule[]): Promise<void> {
  const report = await architectureCheck({ root, rules });
  writeFileSync(join(root, VIOLATION_LIST), renderViolationListOf(report));
}

/** Shared protocol project; cases vary only the owner transaction consumer. */
function protocolFixture(): { root: string; words: string[] } {
  const root = fixtureProject();
  const words = ['json', 'event', 'role', 'question', 'identity', 'scope', 'merge', 'blob', 'repository', 'target', 'snapshot', 'catalogue-only', 'arbitrary-array', 'private-type', 'unrelated-type'];
  writeModule(root, 'catalog/work/execution/example.yaml', ['fields:', ...words.flatMap(name => [`  - name: ${name}`, '    type: text'])]);
  writeModule(root, 'src/graph/system-contract.ts', [
    "const OPERATIONAL_KINDS = ['event', 'role', 'question'] as const;",
    "const IDENTITY_KINDS = ['person'];",
    "function identityKind(): VertexContract { return { fields: [{ name: 'identity' }] }; }",
    "export const SYSTEM_CONTRACT: GraphContract = { vertex: [...OPERATIONAL_KINDS.map(name => ({name})), ...IDENTITY_KINDS.map(identityKind), { name: 'scope' }] };",
    "const diagnostic = { name: 'catalogue-only' };",
    "const UNRELATED_KINDS = ['arbitrary-array'];",
    "export const kind = 'example';",
  ]);
  writeModule(root, 'src/graph/producer-binding.ts', [
    "export type ProducerAction = 'assert' | 'merge';",
    "type Private = 'private-type';",
    "export type Unrelated = 'unrelated-type';",
    "export const kind = 'example';",
  ]);
  writeModule(root, 'src/graph/evidence-targets.ts', [
    "export interface EvidenceTargetKinds { readonly repository: string; }",
    "export type EvidenceLocatorDraft = { readonly type: 'blob' };",
    "export type EvidenceTarget = { readonly target: string };",
  ]);
  writeModule(root, 'src/graph/system-contract.ts', [
    ...readFileSync(join(root, 'src/graph/system-contract.ts'), 'utf8').trimEnd().split('\n'),
    "export const SYSTEM_VERTEX_DEFINITIONS = [{ name: 'system.fixture-a', fields: [{ name: 'json' }] }, { name: 'system.fixture-b', fields: [{ name: 'scope' }] }];",
  ]);
  writeModule(root, 'src/protected-read.ts', [
    "import { loadAssertions } from './graph/assertion-read.js';",
    "loadAssertions(null, 'vertex', 'system.fixture-a', ['json']);",
  ]);
  writeModule(root, 'src/protected-read-invalid.ts', [
    "import { loadAssertions } from './graph/assertion-read.js';",
    "loadAssertions(null, 'vertex', 'system.fixture-b', ['json']);",
    "export const kind = 'example';",
  ]);
  writeModule(root, 'src/conditional-use.ts', [
    "import { loadAssertions } from './graph/assertion-read.js';",
    "async function records(tx: any, kind: string) { const properties = kind === 'system.fixture-a' ? ['json'] : ['scope']; return loadAssertions(tx, 'vertex', kind, properties); }",
    "records(null, 'system.fixture-a'); records(null, 'system.fixture-b');",
  ]);
  writeModule(root, 'src/conditional-invalid.ts', [
    "import { loadAssertions } from './graph/assertion-read.js';",
    "async function records(tx: any, kind: string) { const properties = kind === 'system.fixture-a' ? ['json'] : ['scope']; return loadAssertions(tx, 'vertex', kind, properties); }",
    "records(null, 'system.fixture-a'); records(null, 'arbitrary-product');",
    "export const kind = 'example';",
  ]);
  writeModule(root, 'src/sql-driver.ts', ["export type SqlTransactionKind = 'snapshot' | 'write';"]);
  writeModule(root, 'src/graph/contract.ts', [
    "export type FieldType = 'text' | 'json';",
    "export interface FieldContract { readonly type: FieldType; }",
  ]);
  writeModule(root, 'src/field-use.ts', [
    "import type { FieldContract, FieldType } from './graph/contract.js';",
    "export function valid(field: FieldContract) { switch (field.type) { case 'json': return 1; } }",
    "export function invalid(field: any) { switch (field.type) { case 'json': return 1; } }",
    "export function scalar(type: FieldType) { return type === 'json'; }",
    "export function scalarInvalid(type: string) { return type === 'json'; }",
    "export const kind = 'example';",
  ]);
  writeModule(root, 'src/protocol-use.ts', [...words.map(word => `consume('${word}');`), "export const kind = 'example';"]);
  writeModule(root, 'src/owner-use.ts', [
    "import type { DatabaseOwner } from './adapters/database-owner.js';",
    "export function valid(owner: DatabaseOwner) { return owner.transaction('snapshot', async () => {}); }",
    "export function invalid(owner: any) { return owner.transaction('snapshot', async () => {}); }",
    "consume('snapshot');",
    "export const kind = 'example';",
  ]);
  writeModule(root, 'src/counterfeit-use.ts', [
    "interface FieldContract { type: string }",
    "export function counterfeit(field: FieldContract) { return field.type === 'json'; }",
    "export const kind = 'example';",
  ]);
  writeModule(root, 'src/wrong-import-use.ts', [
    "import type { FieldContract } from './unrelated.js';",
    "export function counterfeit(field: FieldContract) { return field.type === 'json'; }",
    "export const kind = 'example';",
  ]);
  writeModule(root, 'src/lexical-use.ts', [
    "import type { FieldContract } from './graph/contract.js';",
    "export function invalid(field: any, unrelated: FieldContract) { return field.type === 'json'; }",
    "export const kind = 'example';",
  ]);
  writeModule(root, 'src/shadow-use.ts', [
    "import type { FieldContract } from './graph/contract.js';",
    "export function shadow(field: FieldContract) { return ((field: any) => field.type === 'json')({}); }",
    "export const kind = 'example';",
  ]);
  writeModule(root, 'src/comparison-use.ts', [
    "import type { SqlTransactionKind } from './sql-driver.js';",
    "export function valid(kind: SqlTransactionKind) { return kind === 'snapshot'; }",
    "export function invalid(kind: string) { return kind === 'snapshot'; }",
    "export function unrelated(kind: SqlTransactionKind) { return kind === 'repository'; }",
    "export const kind = 'example';",
  ]);
  return { root, words };
}

describe('the architecture check', () => {
  for (const loop of [true, false]) test(`graph-definition ${loop ? 'trigger loop proves' : 'outside loop retains'} core table literals`, async () => {
    const root = fixtureProject();
    try {
      writeModule(root, 'catalog/work/execution/example.yaml', ['fields:', '  - name: context', '    type: text']);
      writeModule(root, 'src/adapters/schemas/graph-definition.ts', [
        'export const SCHEMA = [`CREATE TABLE IF NOT EXISTS context (id bigint)`];',
        ...(loop ? [
          'export function generate() {',
          "  for (const table of ['context']) {",
          '    const statement = `CREATE TRIGGER dirty BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION dirty()`;',
          '  }',
          '}',
        ] : ["export const unrelated = 'context';", "export const kind = 'example';"]),
      ]);
      expect((await architectureCheck({ root, rules: ['no-product-data'] })).found).toEqual(loop ? [] : [
        { rule: 'no-product-data', file: 'src/adapters/schemas/graph-definition.ts', line: 2, symbol: 'context' },
        { rule: 'no-product-data', file: 'src/adapters/schemas/graph-definition.ts', line: 3, symbol: 'example' },
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const [name, space] of [['two spaces', '  '], ['tab', '\t'], ['newline', '\n']] as const) {
    test(`trigger header accepts ${name} whitespace`, async () => {
      const root = fixtureProject();
      try {
        writeModule(root, 'catalog/work/execution/example.yaml', ['fields:', '  - name: context', '    type: text']);
        writeModule(root, 'src/adapters/schemas/graph-definition.ts', [
          'export const SCHEMA = [`CREATE TABLE IF NOT EXISTS context (id bigint)`];',
          'export function generate() {',
          "  for (const table of ['context']) {",
          '    const statement = `CREATE' + space + 'CONSTRAINT' + space + 'TRIGGER' + space + 'dirty' + space + 'AFTER' + space + 'UPDATE' + space + 'OF' + space + 'id' + space + 'OR' + space + 'INSERT' + space + 'ON' + space + '"${table}"' + space + 'FOR EACH ROW EXECUTE FUNCTION dirty()`;',
          '  }',
          '}',
        ]);
        expect((await architectureCheck({ root, rules: ['no-product-data'] })).found).toEqual([]);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test('a trigger name interpolation does not prove the loop table is its target', async () => {
    const root = fixtureProject();
    try {
      writeModule(root, 'catalog/work/execution/example.yaml', ['fields:', '  - name: node', '    type: text']);
      writeModule(root, 'src/adapters/schemas/graph-definition.ts', [
        'export const SCHEMA = [`CREATE TABLE IF NOT EXISTS node (id bigint)`];',
        'export function generate() {',
        "  for (const table of ['node']) {",
        '    const statement = `CREATE TRIGGER ${table} BEFORE INSERT ON context FOR EACH ROW EXECUTE FUNCTION dirty()`;',
        '  }',
        '}',
        "export const kind = 'example';",
      ]);
      expect((await architectureCheck({ root, rules: ['no-product-data'] })).found).toEqual([
        { rule: 'no-product-data', file: 'src/adapters/schemas/graph-definition.ts', line: 7, symbol: 'example' },
        { rule: 'no-product-data', file: 'src/adapters/schemas/graph-definition.ts', line: 3, symbol: 'node' },
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('I/O in a span callback retains its enclosing function through SWC argument wrappers', async () => {
    const root = fixtureProject();
    writeModule(root, 'src/callbacks.ts', [
      'export async function spanned(tx: any): Promise<unknown> {',
      "  return await withSpan('read', {}, async () => await tx.query('SELECT 1'));",
      '}',
      'export async function unspanned(tx: any): Promise<unknown> {',
      "  return await unrelated('read', {}, async () => await tx.query('SELECT 1'));",
      '}',
      'export function syncSpanned(path: string): string {',
      "  return withSpanSync('read', {}, () => readFileSync(path, 'utf8'));",
      '}',
    ]);
    expect((await architectureCheck({ root, rules: ['io-spans'] })).found).toEqual([
      { rule: 'io-spans', file: 'src/callbacks.ts', line: 5, symbol: 'query()' },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test('system kinds and explicit protocol declarations are engine vocabulary, not arbitrary implementation literals', async () => {
    const { root, words } = protocolFixture();
    const report = await architectureCheck({ root, rules: ['no-product-data'] });
    expect(report.found.filter(one => one.file === 'src/protocol-use.ts').map(one => one.symbol)).toEqual([...words, 'example'].sort());
    expect(report.found.filter(one => one.file === 'src/sql-driver.ts' && one.symbol === 'snapshot')).toEqual([]);
    expect(report.found.some(one => one.file === 'src/graph/producer-binding.ts' && one.symbol === 'merge')).toBe(false);
    expect(report.found.some(one => one.file === 'src/graph/producer-binding.ts' && one.symbol === 'unrelated-type')).toBe(true);
    expect(report.found.some(one => one.file === 'src/graph/evidence-targets.ts' && one.symbol === 'blob')).toBe(false);
    expect(report.found.some(one => one.file === 'src/graph/system-contract.ts' && one.symbol === 'catalogue-only')).toBe(true);
    expect(report.found.filter(one => one.file === 'src/graph/system-contract.ts').map(one => one.symbol)).toEqual(['arbitrary-array', 'catalogue-only', 'example']);
    expect(report.found.filter(one => ['src/counterfeit-use.ts', 'src/wrong-import-use.ts', 'src/lexical-use.ts', 'src/shadow-use.ts'].includes(one.file))).toEqual([
      { rule: 'no-product-data', file: 'src/counterfeit-use.ts', line: 3, symbol: 'example' },
      { rule: 'no-product-data', file: 'src/counterfeit-use.ts', line: 2, symbol: 'json' },
      { rule: 'no-product-data', file: 'src/lexical-use.ts', line: 3, symbol: 'example' },
      { rule: 'no-product-data', file: 'src/lexical-use.ts', line: 2, symbol: 'json' },
      { rule: 'no-product-data', file: 'src/shadow-use.ts', line: 3, symbol: 'example' },
      { rule: 'no-product-data', file: 'src/shadow-use.ts', line: 2, symbol: 'json' },
      { rule: 'no-product-data', file: 'src/wrong-import-use.ts', line: 3, symbol: 'example' },
      { rule: 'no-product-data', file: 'src/wrong-import-use.ts', line: 2, symbol: 'json' },
    ]);
    expect(report.found.filter(one => one.file === 'src/protected-read.ts')).toEqual([]);
    expect(report.found.filter(one => one.file === 'src/protected-read-invalid.ts').map(one => one.symbol)).toEqual(['example', 'json']);
    expect(report.found.filter(one => one.file === 'src/conditional-use.ts')).toEqual([]);
    expect(report.found.filter(one => one.file === 'src/conditional-invalid.ts').map(one => one.symbol)).toEqual(['example', 'json', 'scope']);
    expect(report.found.filter(one => one.file === 'src/field-use.ts')).toEqual([
      { rule: 'no-product-data', file: 'src/field-use.ts', line: 6, symbol: 'example' },
      { rule: 'no-product-data', file: 'src/field-use.ts', line: 3, symbol: 'json' },
    ]);
    expect(report.found.filter(one => one.file === 'src/comparison-use.ts')).toEqual([
      { rule: 'no-product-data', file: 'src/comparison-use.ts', line: lineOf(readFileSync(join(root, 'src/comparison-use.ts'), 'utf8').split('\n'), 'export const kind'), symbol: 'example' },
      { rule: 'no-product-data', file: 'src/comparison-use.ts', line: lineOf(readFileSync(join(root, 'src/comparison-use.ts'), 'utf8').split('\n'), 'export function unrelated'), symbol: 'repository' },
      { rule: 'no-product-data', file: 'src/comparison-use.ts', line: lineOf(readFileSync(join(root, 'src/comparison-use.ts'), 'utf8').split('\n'), 'export function invalid'), symbol: 'snapshot' },
    ]);
    expect(report.found.filter(one => one.file === 'src/owner-use.ts')).toEqual([
      { rule: 'no-product-data', file: 'src/owner-use.ts', line: lineOf(readFileSync(join(root, 'src/owner-use.ts'), 'utf8').split('\n'), 'export const kind'), symbol: 'example' },
      { rule: 'no-product-data', file: 'src/owner-use.ts', line: lineOf(readFileSync(join(root, 'src/owner-use.ts'), 'utf8').split('\n'), 'export function invalid'), symbol: 'snapshot' },
    ]);
    rmSync(root, { recursive: true, force: true });
  });


  test('an unused SQL transaction kind is reported', async () => {
    const { root } = protocolFixture();
    const sqlDriver = readFileSync(join(root, 'src/sql-driver.ts'), 'utf8').split('\n');
    const owner = readFileSync(join(root, 'src/adapters/database-owner.ts'), 'utf8').trimEnd().split('\n');
    writeModule(root, 'src/adapters/database-owner.ts', owner.filter(line => !line.includes('  transaction<T>')));
    writeModule(root, 'src/sql-driver.ts', ["export type SqlTransactionKind = 'snapshot' | 'write';", "export const kind = 'example';"]);
    const report = await architectureCheck({ root, rules: ['no-product-data'] });
    expect(report.found.filter(one => one.file === 'src/sql-driver.ts' && one.symbol === 'snapshot')).toEqual([
      { rule: 'no-product-data', file: 'src/sql-driver.ts', line: lineOf(sqlDriver, "'snapshot'"), symbol: 'snapshot' },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test('an untyped SQL transaction consumer does not establish transaction vocabulary', async () => {
    const { root } = protocolFixture();
    const sqlDriver = readFileSync(join(root, 'src/sql-driver.ts'), 'utf8').split('\n');
    const owner = readFileSync(join(root, 'src/adapters/database-owner.ts'), 'utf8').trimEnd().split('\n');
    writeModule(root, 'src/adapters/database-owner.ts', owner.map(line => line.replace('kind: SqlTransactionKind', 'kind: string')));
    writeModule(root, 'src/sql-driver.ts', ["export type SqlTransactionKind = 'snapshot' | 'write';", "export const kind = 'example';"]);
    const report = await architectureCheck({ root, rules: ['no-product-data'] });
    expect(report.found.filter(one => one.file === 'src/sql-driver.ts' && one.symbol === 'snapshot')).toEqual([
      { rule: 'no-product-data', file: 'src/sql-driver.ts', line: lineOf(sqlDriver, "'snapshot'"), symbol: 'snapshot' },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test('semantic role literals require the checked projector and document properties require its typed projection', async () => {
    const root = fixtureProject();
    writeModule(root, 'catalog/work/execution/example.yaml', ['fields:', '  - name: document', '    type: text', '  - name: anchors', '    type: text', '  - name: repository', '    type: text']);
    writeModule(root, 'src/model/semantic-role-protocol.ts', [
      "import { Type } from 'typebox'; import { Value } from 'typebox/value';",
      "export const ROLE_BINDING_SCHEMA = Type.Union([Type.Object({ role: Type.Literal('document'), properties: Type.Object({ anchors: Type.String(), repository: Type.String() }) }), Type.Object({ role: Type.Literal('repository'), properties: Type.Object({ name: Type.String() }) })]);",
      "export function checkRoleProperties(value: unknown) { return Value.Check(ROLE_BINDING_SCHEMA, value); }",
    ]);
    writeModule(root, 'src/knowledge/semantic-bindings.ts', [
      "import { checkRoleProperties } from '../model/semantic-role-protocol.js';",
      "export function semanticEntities(...args: unknown[]) { checkRoleProperties(args); return []; }",
    ]);
    writeModule(root, 'src/knowledge/anchors.ts', [
      "import { semanticEntities } from './semantic-bindings.js';",
      "export interface DocumentOpinion { properties: { anchors: string } }",
      "export function documentOpinions(graph: any, manifest: any, role: 'document' = 'document') { return semanticEntities(graph, manifest, role); }",
      "export function valid(document: DocumentOpinion) { return document.properties['anchors']; }",
      "export function invalid(document: any) { return document.properties['anchors']; }",
      "export const kind = 'example';",
    ]);
    writeModule(root, 'src/role-use.ts', [
      "import { semanticEntities, semanticBinding } from './knowledge/semantic-bindings.js';",
      "semanticEntities(null, null, 'repository');",
      "consume('repository');",
      "const binding = semanticBinding(null, 'document'); binding.fields['repository'];",
      "binding.fields['repository'];",
      "export const kind = 'example';",
    ]);
    writeModule(root, 'src/role-shadow.ts', [
      "import { semanticBinding } from './knowledge/semantic-bindings.js';",
      "function counterfeit(semanticBinding: any) { const other = semanticBinding(null, 'document'); return other.fields['repository']; }",
      "export const kind = 'example';",
    ]);
    const report = await architectureCheck({ root, rules: ['no-product-data'] });
    expect(report.found.filter(one => one.file === 'src/role-shadow.ts')).toEqual([
      { rule: 'no-product-data', file: 'src/role-shadow.ts', line: 2, symbol: 'document' },
      { rule: 'no-product-data', file: 'src/role-shadow.ts', line: 3, symbol: 'example' },
      { rule: 'no-product-data', file: 'src/role-shadow.ts', line: 2, symbol: 'repository' },
    ]);
    expect(report.found.filter(one => one.file === 'src/knowledge/anchors.ts')).toEqual([
      { rule: 'no-product-data', file: 'src/knowledge/anchors.ts', line: 5, symbol: 'anchors' },
      { rule: 'no-product-data', file: 'src/knowledge/anchors.ts', line: 6, symbol: 'example' },
    ]);
    expect(report.found.filter(one => one.file === 'src/role-use.ts')).toEqual([
      { rule: 'no-product-data', file: 'src/role-use.ts', line: 6, symbol: 'example' },
      { rule: 'no-product-data', file: 'src/role-use.ts', line: 3, symbol: 'repository' },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test('MCP argument diagnostics follow the published schema through lexical tool-list spreads', async () => {
    const root = fixtureProject();
    writeModule(root, 'catalog/work/execution/example.yaml', ['fields:', '  - name: preconditions', '    type: text']);
    const source = [
      "import { Type } from 'typebox'; import { Value } from 'typebox/value';",
      "const PRECONDITIONS = Type.Array(Type.String());",
      "const WRITE_TOOLS = [{inputSchema: {properties: {preconditions: PRECONDITIONS}}}];",
      "export const PRODUCT_TOOLS = [...WRITE_TOOLS];",
      "function check(input: unknown) { const args = input as Record<string, unknown>; const value = args['preconditions']; if (!Value.Check(PRECONDITIONS, value)) throw new WriteRefusal('invalid', 'preconditions'); }",
      "export const kind = 'example';",
    ];
    writeModule(root, 'src/mcp/authored.ts', source);
    expect((await architectureCheck({ root, rules: ['no-product-data'] })).found).toEqual([
      { rule: 'no-product-data', file: 'src/mcp/authored.ts', line: 6, symbol: 'example' },
    ]);
    for (const change of [
      (line: string) => line.replace('Value.Check(PRECONDITIONS, value)', 'Value.Check(OTHER, value)'),
      (line: string) => line.replace('[...WRITE_TOOLS]', '[]'),
    ]) {
      const negative = fixtureProject();
      writeModule(negative, 'catalog/work/execution/example.yaml', ['fields:', '  - name: preconditions', '    type: text']);
      writeModule(negative, 'src/mcp/authored.ts', source.map(change));
      expect((await architectureCheck({ root: negative, rules: ['no-product-data'] })).found.some(one => one.symbol === 'preconditions')).toBe(true);
      rmSync(negative, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  });

  test('receipt namespaces require the checked host request return slot', async () => {
    const root = fixtureProject();
    writeModule(root, 'catalog/work/execution/example.yaml', ['fields:', '  - name: request', '    type: text']);
    writeModule(root, 'src/graph/operation-host.ts', [
      "export interface OperationRequest { key: string; request: unknown }",
      "function execute(request: OperationRequest) { operationReceipt(tx, contract, unit, request.key); }",
    ]);
    writeModule(root, 'src/receipt.ts', [
      "import { operationReceipt, type OperationRequest } from './graph/operation-host.js';",
      "function valid(): OperationRequest { return { key: 'request', request: {} }; }",
      "function unknown() { return { key: 'request', request: {} }; }",
      "operationReceipt(tx, contract, unit, 'request');",
      "export const kind = 'example';",
    ]);
    for (const [name, body] of [
      ['unknown', "function unknown() { return { key: 'request', request: {} }; }"],
      ['wrong', "function wrong(): OperationRequest { return { key: 'other', request: 'request' }; }"],
      ['slot', "operationReceipt(tx, contract, 'request', key);"],
      ['shadow', "function shadow(operationReceipt: any) { operationReceipt(tx, contract, unit, 'request'); }"],
    ]) writeModule(root, `src/receipt-${name}.ts`, ["import { operationReceipt, type OperationRequest } from './graph/operation-host.js';", body!, "export const kind = 'example';"]);
    const report = await architectureCheck({ root, rules: ['no-product-data'] });
    expect(report.found.filter(one => one.file === 'src/receipt.ts')).toEqual([
      { rule: 'no-product-data', file: 'src/receipt.ts', line: 5, symbol: 'example' },
      { rule: 'no-product-data', file: 'src/receipt.ts', line: 3, symbol: 'request' },
    ]);
    for (const name of ['unknown', 'wrong', 'slot', 'shadow']) expect(report.found.filter(one => one.file === `src/receipt-${name}.ts`)).toEqual([
      { rule: 'no-product-data', file: `src/receipt-${name}.ts`, line: 3, symbol: 'example' },
      { rule: 'no-product-data', file: `src/receipt-${name}.ts`, line: 2, symbol: 'request' },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test('receipt namespaces reject counterfeit or unconsumed host authority', async () => {
    for (const authority of [
      "interface OperationRequest { key: string }\nfunction execute(request: OperationRequest) { operationReceipt(tx, contract, unit, request.key); }",
      "export interface OperationRequest { other: string }\nfunction execute(request: OperationRequest) { operationReceipt(tx, contract, unit, request.key); }",
      "export interface OperationRequest { key: string }\nfunction execute(request: OperationRequest) { operationReceipt(tx, contract, unit, request.other); }",
    ]) {
      const root = fixtureProject();
      writeModule(root, 'catalog/work/execution/example.yaml', ['fields:', '  - name: request', '    type: text']);
      writeModule(root, 'src/graph/operation-host.ts', authority.split('\n'));
      writeModule(root, 'src/receipt.ts', [
        "import { operationReceipt, type OperationRequest } from './graph/operation-host.js';",
        "function request(): OperationRequest { return { key: 'request' }; }",
        "export const kind = 'example';",
      ]);
      const report = await architectureCheck({ root, rules: ['no-product-data'] });
      expect(report.found.filter(one => one.file === 'src/receipt.ts')).toEqual([
        { rule: 'no-product-data', file: 'src/receipt.ts', line: 3, symbol: 'example' },
        { rule: 'no-product-data', file: 'src/receipt.ts', line: 2, symbol: 'request' },
      ]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a second writer of the graph fails with the rule, the file and the line, and passes when the plant is removed', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['graph-single-writer']);
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['graph-single-writer'] }))).toEqual([]);

    const plant = ['/**', ' * A second writer of the graph, planted by the test.', ' */', "import { write } from './graph/write.js';", '', 'export const written = write;'];
    writeModule(root, 'src/second-writer.ts', plant);

    const planted = await architectureCheck({ root, rules: ['graph-single-writer'] });
    expect(planted.comparison.unlisted).toEqual([
      { rule: 'graph-single-writer', file: 'src/second-writer.ts', line: lineOf(plant, 'graph/write.js'), symbol: 'src/graph/write.ts' },
    ]);
    const problems = architectureProblemLines(planted);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'src', 'second-writer.ts')}:${lineOf(plant, 'graph/write.js')}: graph-single-writer:`);
    expect(problems[0]).toContain(`${VIOLATION_LIST} does not list it`);

    rmSync(join(root, 'src', 'second-writer.ts'));
    const removed = await architectureCheck({ root, rules: ['graph-single-writer'] });
    expect(architectureProblemLines(removed)).toEqual([]);
    expect(architectureCheckPasses(removed)).toBe(true);
  });

  test('a module that runs a statement of its own fails once for the connection and once for the query interface', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['sql-only-in-storage-layer']);
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['sql-only-in-storage-layer'] }))).toEqual([]);

    const plant = [
      '/**',
      ' * SQL outside the storage layer, planted by the test.',
      ' */',
      "import type { DatabaseOwner } from './adapters/database-owner.js';",
      "import type { SqlExecutor } from './sql-driver.js';",
      '',
      'export type Rogue = DatabaseOwner | SqlExecutor;',
    ];
    writeModule(root, 'src/rogue-query.ts', plant);

    const planted = await architectureCheck({ root, rules: ['sql-only-in-storage-layer'] });
    expect(planted.comparison.unlisted).toEqual([
      { rule: 'sql-only-in-storage-layer', file: 'src/rogue-query.ts', line: lineOf(plant, 'database-owner.js'), symbol: 'src/adapters/database-owner.ts' },
      { rule: 'sql-only-in-storage-layer', file: 'src/rogue-query.ts', line: lineOf(plant, 'sql-driver.js'), symbol: 'src/sql-driver.ts' },
    ]);
    const problems = architectureProblemLines(planted);
    expect(problems.length).toBe(2);
    expect(problems[0]).toContain(`${join(root, 'src', 'rogue-query.ts')}:${lineOf(plant, 'database-owner.js')}: sql-only-in-storage-layer:`);
    expect(problems[0]).toContain('the database owner');
    expect(problems[1]).toContain('the query interface');

    rmSync(join(root, 'src', 'rogue-query.ts'));
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['sql-only-in-storage-layer'] }))).toEqual([]);
  });

  test('a second fill entry point fails, and a module reading a producer from the same module is not an entry point', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['one-fill-entry']);
    const clean = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(clean.found).toEqual([]);
    expect(architectureProblemLines(clean)).toEqual([]);

    const plant = ['/**', ' * A second entry point for a fill, planted by the test.', ' */', "import { fillGraph } from './extract/driver/index.js';", '', 'export const started = fillGraph;'];
    writeModule(root, 'src/rogue-fill.ts', plant);

    const planted = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(planted.comparison.unlisted).toEqual([
      { rule: 'one-fill-entry', file: 'src/rogue-fill.ts', line: lineOf(plant, 'fillGraph'), symbol: 'src/extract/driver/index.ts:fillGraph' },
    ]);
    const problems = architectureProblemLines(planted);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'src', 'rogue-fill.ts')}:${lineOf(plant, 'fillGraph')}: one-fill-entry:`);
    expect(problems[0]).toContain('the fill runner fillGraph of src/extract/driver/index.ts');

    rmSync(join(root, 'src', 'rogue-fill.ts'));
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['one-fill-entry'] }))).toEqual([]);
  });

  test('a second wiring of the fill fails by name, and passes when the plant is removed', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['one-fill-entry']);
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['one-fill-entry'] }))).toEqual([]);

    const plant = [
      '/**',
      ' * A second wiring of the fill, planted by the test: the host and the stages built beside the one runner.',
      ' */',
      "import { createFillOrchestratorService } from './fill/orchestrator-host.js';",
      "import { createStagesFill } from './product/fill-stages.js';",
      '',
      'export const wired = [createFillOrchestratorService, createStagesFill];',
    ];
    writeModule(root, 'src/second-wiring.ts', plant);

    const planted = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(planted.comparison.unlisted).toEqual([
      { rule: 'one-fill-entry', file: 'src/second-wiring.ts', line: lineOf(plant, 'fill/orchestrator-host.js'), symbol: 'src/fill/orchestrator-host.ts:createFillOrchestratorService' },
      { rule: 'one-fill-entry', file: 'src/second-wiring.ts', line: lineOf(plant, 'product/fill-stages.js'), symbol: 'src/product/fill-stages.ts:createStagesFill' },
    ]);
    const problems = architectureProblemLines(planted);
    expect(problems.length).toBe(2);
    expect(problems[0]).toContain(`${join(root, 'src', 'second-wiring.ts')}:${lineOf(plant, 'fill/orchestrator-host.js')}: one-fill-entry:`);
    expect(problems[0]).toContain('the fill runner createFillOrchestratorService of src/fill/orchestrator-host.ts');
    expect(problems[1]).toContain('the fill runner createStagesFill of src/product/fill-stages.ts');

    rmSync(join(root, 'src', 'second-wiring.ts'));
    const removed = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(architectureProblemLines(removed)).toEqual([]);
    expect(architectureCheckPasses(removed)).toBe(true);
  });

  test('a manifest binding taken outside the manifest publication fails, and the publication\'s own call passes', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['one-manifest-binding']);
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['one-manifest-binding'] }))).toEqual([]);

    // The publication takes the binding for the manifest producer, and the rule names no module but a second one.
    const publication = [
      "/** The one module that states the catalogue\'s declarations. */",
      'export function startupBinding(tx: unknown, contract: unknown, producer: string): unknown {',
      '  return [tx, contract, producer];',
      '}',
      '',
      'export function publish(tx: unknown): unknown {',
      "  return startupBinding(tx, {}, 'manifest');",
      '}',
    ];
    writeModule(root, 'src/graph/manifest-publication.ts', publication);
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['one-manifest-binding'] }))).toEqual([]);

    // A binding for another producer is no second publication, whatever module takes it.
    const hostStart = [
      "import { startupBinding } from './graph/manifest-publication.js';",
      '',
      "export const start = (tx: unknown) => startupBinding(tx, {}, 'start');",
    ];
    writeModule(root, 'src/host-start.ts', hostStart);
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['one-manifest-binding'] }))).toEqual([]);

    const plant = [
      '/**',
      ' * A second publication, planted by the test: the manifest producer bound beside the one module that states',
      ' * the declarations.',
      ' */',
      "import { bindStartupWriter } from './graph/manifest-publication.js';",
      '',
      "export const second = (tx: unknown) => bindStartupWriter(tx, {}, 'manifest');",
    ];
    writeModule(root, 'src/second-publication.ts', plant);

    const planted = await architectureCheck({ root, rules: ['one-manifest-binding'] });
    expect(planted.comparison.unlisted).toEqual([
      { rule: 'one-manifest-binding', file: 'src/second-publication.ts', line: lineOf(plant, "bindStartupWriter(tx"), symbol: 'bindStartupWriter' },
    ]);
    const problems = architectureProblemLines(planted);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'src', 'second-publication.ts')}:${lineOf(plant, 'bindStartupWriter(tx')}: one-manifest-binding:`);
    expect(problems[0]).toContain("takes the manifest publication's binding (bindStartupWriter)");

    rmSync(join(root, 'src', 'second-publication.ts'));
    const removed = await architectureCheck({ root, rules: ['one-manifest-binding'] });
    expect(architectureProblemLines(removed)).toEqual([]);
    expect(architectureCheckPasses(removed)).toBe(true);
  });

  test('an import of a retired surface fails, and passes when the importer is removed', async () => {
    const root = fixtureProject();
    const view = FIXTURE['src/writer/view.ts']!;
    const report = await architectureCheck({ root, rules: ['no-retired-surfaces'] });
    expect(report.found).toEqual([
      { rule: 'no-retired-surfaces', file: 'src/writer/view.ts', line: lineOf(view, '../extract/driver/index.js'), symbol: 'src/extract/driver/index.ts' },
    ]);
    const problems = architectureProblemLines(report);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'src', 'writer', 'view.ts')}:${lineOf(view, '../extract/driver/index.js')}: no-retired-surfaces:`);
    expect(problems[0]).toContain('retired surface');

    rmSync(join(root, 'src', 'writer', 'view.ts'));
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['no-retired-surfaces'] }))).toEqual([]);
  });

  test(
    'a module no entry reaches fails, and passes when the plant is removed',
    async () => {
      // A project of its own: this rule takes no baseline, so the fixture must hold no other dead module.
      const root = mkdtempSync(join(tmpdir(), 'madarch-architecture-unreachable-'));
      writeModule(root, 'package.json', [JSON.stringify({ name: 'madarch-unreachable-fixture', private: true, type: 'module' }, null, 2)]);
      writeModule(root, 'knip.json', [JSON.stringify({ bun: false, entry: ['src/index.ts'], project: ['src/**/*.ts'], include: ['files'] }, null, 2)]);
      writeModule(root, 'knip.production.json', [JSON.stringify({ bun: false, entry: ['src/index.ts!'], project: ['src/**/*.ts!'], include: ['files', 'exports', 'nsExports', 'types', 'nsTypes', 'enumMembers'] }, null, 2)]);
      writeModule(root, 'src/index.ts', ["import { reached } from './reached.js';", '', 'export const entry = reached;', '']);
      writeModule(root, 'src/reached.ts', ['/** A module the entry reaches. */', 'export const reached = 1;']);
      mkdirSync(join(root, '.architecture'), { recursive: true });
      writeFileSync(join(root, VIOLATION_LIST), '[]\n');

      const clean = await architectureCheck({ root, rules: ['no-unreachable-code'] });
      expect(architectureProblemLines(clean)).toEqual([]);

      writeModule(root, 'src/orphan.ts', ['/** A module nothing reaches, planted by the test. */', 'export const orphan = 1;']);

      const planted = await architectureCheck({ root, rules: ['no-unreachable-code'] });
      expect(planted.comparison.unlisted).toEqual([{ rule: 'no-unreachable-code', file: 'src/orphan.ts', line: 1, symbol: null }]);
      const problems = architectureProblemLines(planted);
      expect(problems.length).toBe(1);
      expect(problems[0]).toContain(`${join(root, 'src', 'orphan.ts')}:1: no-unreachable-code:`);
      expect(problems[0]).toContain('unreachable from every declared entry point');

      rmSync(join(root, 'src', 'orphan.ts'));
      expect(architectureProblemLines(await architectureCheck({ root, rules: ['no-unreachable-code'] }))).toEqual([]);
      rmSync(root, { recursive: true, force: true });
    },
    KNIP_CASE_MS,
  );

  test('an entry the rules no longer find fails, naming the list and the entry, so the list only shrinks', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['graph-single-writer', 'sql-only-in-storage-layer']);

    const listed: ListedViolation[] = [{ rule: 'sql-only-in-storage-layer', file: 'src/gone.ts', symbol: 'src/adapters/database-owner.ts' }];
    writeFileSync(join(root, VIOLATION_LIST), `${JSON.stringify(listed, null, 2)}\n`);

    const report = await architectureCheck({ root, rules: ['graph-single-writer', 'sql-only-in-storage-layer'] });
    expect(report.comparison.stale).toEqual(listed);
    const problems = architectureProblemLines(report);
    expect(problems.length).toBe(1);
    const writtenOn = readFileSync(join(root, VIOLATION_LIST), 'utf8')
      .split('\n')
      .findIndex((line) => line.trim() === '"rule": "sql-only-in-storage-layer",') + 1;
    expect(problems[0]).toContain(`${join(root, VIOLATION_LIST)}:${writtenOn}: sql-only-in-storage-layer: src/gone.ts: src/adapters/database-owner.ts`);
    expect(problems[0]).toContain('no rule finds it any more');
    expect(architectureCheckPasses(report)).toBe(false);
  });

  test('a no-unreachable-code entry is refused even when the list holds it, and the list writer never writes one', async () => {
    const root = fixtureProject();
    const entry: ListedViolation = { rule: 'no-unreachable-code', file: 'src/orphan.ts', symbol: null };
    writeFileSync(join(root, VIOLATION_LIST), `${JSON.stringify([entry], null, 2)}\n`);

    const report = await architectureCheck({ root, rules: ['no-unreachable-code'] });
    expect(report.noBaseline).toEqual([entry]);
    expect(architectureCheckPasses(report)).toBe(false);
    expect(architectureProblemLines(report).some((line) => line.includes('takes no baseline'))).toBe(true);
    expect(renderViolationListOf(report)).not.toContain('no-unreachable-code');
  });

  test('the same violation written twice in the list fails, so an entry is one entry', async () => {
    const root = fixtureProject();
    const entry: ListedViolation = { rule: 'one-fill-entry', file: 'src/a.ts', symbol: 'src/product/fill.ts:startFill' };
    writeFileSync(join(root, VIOLATION_LIST), `${JSON.stringify([entry, entry], null, 2)}\n`);

    const report = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(report.comparison.duplicated).toEqual([entry]);
    expect(architectureProblemLines(report).length).toBe(3);
  });

  test('every way a module names a fill runner is one entry point beside the host', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['one-fill-entry']);

    const plant = [
      '/**',
      ' * A module that takes the runners as a namespace, a re-export, a whole re-export and a',
      ' * computed load, planted by the test.',
      ' */',
      "import * as driver from './extract/driver/index.js';",
      "export { fillGraph } from './extract/driver/index.js';",
      "export * from './fill/orchestrator.js';",
      '',
      "export const pick = async (): Promise<unknown> => import('./product/fill-stages.js');",
      'export const whole = driver;',
      'const load = async (path: string): Promise<unknown> => await import(path);',
      "export const loaded = await load('src/fill/orchestrator-host.ts');",
      "export const elsewhere = await load('src/writer/view.ts');",
    ];
    writeModule(root, 'src/rogue-imports.ts', plant);

    const planted = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(planted.comparison.unlisted.map((violation) => [violation.line, violation.symbol])).toEqual([
      [lineOf(plant, "import * as driver"), 'src/extract/driver/index.ts:*'],
      [lineOf(plant, 'export { fillGraph }'), 'src/extract/driver/index.ts:fillGraph'],
      // A local loader handed a runner's path takes the module as a whole; a module that is no runner is not an entry.
      [lineOf(plant, "load('src/fill/orchestrator-host.ts')"), 'src/fill/orchestrator-host.ts:*'],
      [lineOf(plant, 'export * from'), 'src/fill/orchestrator.ts:*'],
      [lineOf(plant, "import('./product/fill-stages.js')"), 'src/product/fill-stages.ts:*'],
    ]);
    expect(architectureProblemLines(planted).length).toBe(5);

    rmSync(join(root, 'src', 'rogue-imports.ts'));
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['one-fill-entry'] }))).toEqual([]);
  });

  test('a module written as JavaScript is read too, and a file of two-byte characters keeps its lines', async () => {
    const root = fixtureProject();
    await acceptWhatIsFound(root, ['sql-only-in-storage-layer']);

    const legacy = ["import { createPGliteDatabaseOwner } from './adapters/database-owner.js';", '', 'export const open = createPGliteDatabaseOwner;'];
    writeModule(root, 'src/legacy.mjs', legacy);
    const cyrillic = ['/**', ' * «Каждый модуль спрашивает хранилище» — a comment of characters a byte is not a character of.', ' */', "import type { SqlExecutor } from './sql-driver.js';", ''];
    writeModule(root, 'src/cyrillic.ts', cyrillic);

    const planted = await architectureCheck({ root, rules: ['sql-only-in-storage-layer'] });
    expect(planted.comparison.unlisted.map((violation) => [violation.file, violation.line, violation.symbol])).toEqual([
      ['src/cyrillic.ts', lineOf(cyrillic, 'sql-driver.js'), 'src/sql-driver.ts'],
      ['src/legacy.mjs', lineOf(legacy, 'database-owner.js'), 'src/adapters/database-owner.ts'],
    ]);

    rmSync(join(root, 'src', 'legacy.mjs'));
    rmSync(join(root, 'src', 'cyrillic.ts'));
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['sql-only-in-storage-layer'] }))).toEqual([]);
  });

  test('the violations come out in code point order of rule, file and symbol, whatever order they are found in', async () => {
    const root = fixtureProject();
    writeModule(root, 'src/zzz-writer.ts', ["import { write } from './graph/write.js';", '', 'export const written = write;']);
    writeModule(root, 'src/aaa-query.ts', ["import type { SqlExecutor } from './sql-driver.js';", '', 'export type Rogue = SqlExecutor;']);
    writeModule(root, 'src/aaa-writer.ts', ["import { write } from './graph/write.js';", '', 'export const also = write;']);

    const report = await architectureCheck({ root, rules: ['graph-single-writer', 'sql-only-in-storage-layer'] });
    expect(report.found.map((violation) => `${violation.rule} ${violation.file} ${violation.symbol}`)).toEqual([
      'graph-single-writer src/aaa-writer.ts src/graph/write.ts',
      'graph-single-writer src/zzz-writer.ts src/graph/write.ts',
      'sql-only-in-storage-layer src/aaa-query.ts src/sql-driver.ts',
    ]);
    expect(renderViolationListOf(report)).toBe(`${JSON.stringify(report.found.map((violation) => ({ rule: violation.rule, file: violation.file, symbol: violation.symbol })), null, 2)}\n`);
  });

  test('a module the parser cannot read is refused by name, with the path and the reason', async () => {
    const root = fixtureProject();
    writeModule(root, 'src/broken.mjs', ['export const = ;']);
    await expect(architectureCheck({ root, rules: ['one-fill-entry'] })).rejects.toThrow(/src\/broken\.mjs:1: the module could not be parsed by swc/);
  });

  test('a list the check cannot read is refused by name, with what is wrong', async () => {
    const root = fixtureProject();
    const refusals: readonly (readonly [string, string])[] = [
      ['[', 'the list is not JSON'],
      ['{"rule": "one-fill-entry"}', 'the list is a JSON array of {rule, file, symbol} entries'],
      [JSON.stringify([{ rule: 'no-such-rule', file: 'src/a.ts', symbol: null }]), 'which is not one of'],
      [JSON.stringify([{ rule: 'one-fill-entry', file: '', symbol: null }]), 'a file is a path from the repository root'],
      [JSON.stringify([{ rule: 'one-fill-entry', file: 'src/a.ts', symbol: 7 }]), 'a symbol is a string or null'],
      [JSON.stringify([{ rule: 'one-fill-entry', file: 'src/a.ts', symbol: null, line: 3 }]), 'an entry is exactly rule, file and symbol'],
      [JSON.stringify(['one-fill-entry']), 'is not an object with rule, file and symbol'],
    ];
    for (const [text, expected] of refusals) {
      writeFileSync(join(root, VIOLATION_LIST), text);
      const report = await architectureCheck({ root, rules: ['one-fill-entry'] });
      expect(report.refusal).toContain(expected);
      expect(architectureCheckPasses(report)).toBe(false);
      expect(architectureProblemLines(report)[0]).toStartWith(`${join(root, VIOLATION_LIST)}:1:`);
    }

    rmSync(join(root, VIOLATION_LIST));
    const missing = await architectureCheck({ root, rules: ['one-fill-entry'] });
    expect(missing.refusal).toContain('the list of accepted violations is missing');
  });

  test('an engine module importing the starter set fails, while the copy madarch init makes passes', async () => {
    const root = fixtureProject();
    // The starter set's data modules stand in the fixture, and the copy `madarch init` makes imports them.
    writeModule(root, 'src/knowledge/starter-catalog.ts', ["export const CATALOG = 'catalog';"]);
    writeModule(root, 'src/knowledge/seed.ts', ["import { CATALOG } from './starter-catalog.js';", 'export const STARTER = CATALOG;']);
    writeModule(root, 'src/product/draft.ts', ["import { STARTER } from '../knowledge/seed.js';", 'export const copied = STARTER;']);
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['starter-data-when-copying'] }))).toEqual([]);

    const plant = [
      '/**',
      ' * A serving module that reads the engine\'s own starter set, planted by the test.',
      ' */',
      "import { STARTER } from './knowledge/seed.js';",
      '',
      'export const served = STARTER;',
    ];
    writeModule(root, 'src/serving.ts', plant);
    const planted = await architectureCheck({ root, rules: ['starter-data-when-copying'] });
    expect(planted.comparison.unlisted).toEqual([
      { rule: 'starter-data-when-copying', file: 'src/serving.ts', line: lineOf(plant, 'knowledge/seed.js'), symbol: 'src/knowledge/seed.ts' },
    ]);
    const problems = architectureProblemLines(planted);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, 'src', 'serving.ts')}:${lineOf(plant, 'knowledge/seed.js')}: starter-data-when-copying:`);
    expect(problems[0]).toContain('imports the starter set src/knowledge/seed.ts');

    rmSync(join(root, 'src', 'serving.ts'));
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['starter-data-when-copying'] }))).toEqual([]);
  });

  test('test-file imports parse each reachable module once per check and read edits on the next check', () => {
    const root = fixtureProject();
    try {
      writeModule(root, 'test/a.test.ts', ["import '../scripts/shared.ts';"]);
      writeModule(root, 'test/b.test.ts', ["import '../scripts/shared.ts';"]);
      writeModule(root, 'test/target.test.ts', ['', "import 'bun:test';"]);
      writeModule(root, 'scripts/shared.ts', ["import '../src/leaf.ts';", "import '../test/target.test.ts';"]);
      writeModule(root, 'src/leaf.ts', ["import '../scripts/shared.ts';"]);
      writeModule(root, 'src/unreachable.ts', ['not valid TypeScript @@@']);
      const parser = spyOn(swc, 'parseSync');
      try {
        const first = testFileImportViolations(root);
        expect(first).toEqual(['a', 'b'].map((name) => ({
          rule: 'no-test-file-imports', file: `test/${name}.test.ts`, line: 1,
          symbol: `test/${name}.test.ts:1 → scripts/shared.ts:2 → test/target.test.ts:2`,
        })));
        expect(parser).toHaveBeenCalledTimes(5);
        parser.mockClear();
        writeModule(root, 'scripts/shared.ts', ["import '../src/leaf.ts';"]);
        expect(testFileImportViolations(root)).toEqual([]);
        expect(parser).toHaveBeenCalledTimes(5);
      } finally {
        parser.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('test-file imports cross helpers outside test with the full chain and lines', async () => {
    const root = fixtureProject();
    try {
      writeModule(root, 'test/base.test.ts', ['', "import { test } from 'bun:test';", "test('base', () => {});"]);
      writeModule(root, 'scripts/helper.ts', ['', '', "export * from '../test/base.test.ts';"]);
      writeModule(root, 'test/other.test.ts', ['', "import '../scripts/helper.ts';"]);
      writeModule(root, 'scripts/not-a-start.test.ts', ["import '../test/base.test.ts';"]);
      const report = await architectureCheck({ root, rules: ['no-test-file-imports'] });
      expect(architectureCheckPasses(report)).toBe(false);
      expect(report.comparison.unlisted).toEqual([{
        rule: 'no-test-file-imports', file: 'test/other.test.ts', line: 2,
        symbol: 'test/other.test.ts:2 → scripts/helper.ts:3 → test/base.test.ts:2',
      }]);
      const problems = architectureProblemLines(report);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`${join(root, 'test/other.test.ts')}:2: no-test-file-imports:`);
      expect(problems[0]).toContain('test/other.test.ts:2 → scripts/helper.ts:3 → test/base.test.ts:2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('test-file imports ignore erased type edges but refuse mixed value and type edges', async () => {
    const root = fixtureProject();
    try {
      writeModule(root, 'test/base.test.ts', ['export interface X {}', 'export const value = 1;']);
      const erased = [
        "import type { X } from './base.test.ts';",
        "export type { X } from './base.test.ts';",
        "export type * from './base.test.ts';",
        "import { type X } from './base.test.ts';",
        "export { type X } from './base.test.ts';",
        "import type X from './base.test.ts';",
        "import type * as X from './base.test.ts';",
      ];
      for (const edge of erased) {
        writeModule(root, 'test/other.test.ts', [edge]);
        const report = await architectureCheck({ root, rules: ['no-test-file-imports'] });
        expect(architectureProblemLines(report), edge).toEqual([]);
        expect(architectureCheckPasses(report), edge).toBe(true);
      }
      for (const edge of [
        "import { type X, value } from './base.test.ts';",
        "export { type X, value } from './base.test.ts';",
      ]) {
        writeModule(root, 'test/other.test.ts', ['', edge]);
        const report = await architectureCheck({ root, rules: ['no-test-file-imports'] });
        expect(architectureCheckPasses(report), edge).toBe(false);
        expect(report.comparison.unlisted).toEqual([{
          rule: 'no-test-file-imports', file: 'test/other.test.ts', line: 2,
          symbol: 'test/other.test.ts:2 → test/base.test.ts:1',
        }]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('test-file imports through require, re-export, dynamic import and helpers fail the public check', async () => {
    const root = fixtureProject();
    writeFileSync(join(root, VIOLATION_LIST), '[]\n');
    writeModule(root, 'test/base.test.ts', ["import { test } from 'bun:test';", "test('base', () => {});", '']);
    const cases = [
      { importer: 'test/require.test.ts', content: ["require('./base.test.ts');"], token: 'base.test.ts', source: 'test/base.test.ts' },
      { importer: 'test/reexport.test.ts', content: ["export { x } from './base.test.js';"], token: 'base.test.js', source: 'test/base.test.ts' },
      { importer: 'test/dynamic.test.ts', content: ["void import('./base.test.js');"], token: 'base.test.js', source: 'test/base.test.ts' },
      { importer: 'test/direct.test.ts', content: ["import { test } from './base.test.js';"], token: 'base.test.js', source: 'test/base.test.ts' },
      { importer: 'test/chain.test.ts', content: ["import './helper.js';"], token: 'helper.js', source: 'test/base.test.ts' },
    ];
    writeModule(root, 'test/helper.ts', ["export { x } from './base.test.js';"]);
    writeModule(root, 'test/safe-helper.ts', ['export const value = 1;']);
    writeModule(root, 'test/safe.test.ts', ["import { value } from './safe-helper.js';", "import { test } from 'bun:test';", "test('safe', () => { value; });"]);
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['no-test-file-imports'] }))).toEqual([]);
    for (const item of cases) {
      const plant = item.content;
      writeModule(root, item.importer, plant);
      const report = await architectureCheck({ root, rules: ['no-test-file-imports'] });
      expect(architectureCheckPasses(report)).toBe(false);
      const diagnostic = architectureProblemLines(report).find((line) => line.includes(`${join(root, item.importer)}:`));
      expect(diagnostic).toContain(`${join(root, item.importer)}:${lineOf(plant, item.token)}: no-test-file-imports:`);
      expect(diagnostic).toContain(item.source);
      if (item.importer === 'test/chain.test.ts') {
        expect(report.comparison.unlisted[0]?.symbol).toBe('test/chain.test.ts:1 → test/helper.ts:1 → test/base.test.ts:1');
        expect(diagnostic).toContain('test/chain.test.ts imports the test file test/base.test.ts through test/helper.ts (test/chain.test.ts:1 → test/helper.ts:1 → test/base.test.ts:1)');
      }
      if (item.importer === 'test/direct.test.ts') {
        expect(diagnostic).toContain('test/direct.test.ts imports the test file test/base.test.ts');
        expect(diagnostic).not.toContain(' through ');
      }
      rmSync(join(root, item.importer));
    }
  });

});

describe('the base guard', () => {

  function commit(root: string, message: string): void {
    execFileSync('git', ['-C', root, 'add', '--all'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '--allow-empty', '-m', message], {
      stdio: 'ignore',
    });
  }

  function repository(): string {
    const root = mkdtempSync(join(tmpdir(), 'madarch-architecture-git-'));
    execFileSync('git', ['-C', root, 'init', '--quiet'], { stdio: 'ignore' });
    return root;
  }

  const LISTED: ListedViolation = { rule: 'sql-only-in-storage-layer', file: 'src/fill/graph-pages.ts', symbol: 'src/sql-driver.ts' };

  test('an entry the branch added fails until a commit of the branch carries the owner\'s decision', () => {
    const root = repository();
    mkdirSync(join(root, '.architecture'), { recursive: true });
    writeFileSync(join(root, VIOLATION_LIST), '[]\n');
    commit(root, 'the list starts empty');
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    writeFileSync(join(root, VIOLATION_LIST), `${JSON.stringify([LISTED], null, 2)}\n`);
    commit(root, 'list a new violation');

    const refused = baseGuard({ root, base });
    expect(refused.added).toEqual([LISTED]);
    expect(refused.ownerDecision).toBeNull();
    expect(baseGuardPasses(refused)).toBe(false);
    const problems = baseGuardProblemLines(refused);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(`${join(root, VIOLATION_LIST)}:1: sql-only-in-storage-layer:`);
    expect(problems[0]).toContain('Owner-decision:');
    expect(problems[0]).toContain(base);

    commit(root, 'list a new violation\n\nOwner-decision: the graph pages read the projection directly until the stage lands');
    const allowed = baseGuard({ root, base });
    expect(allowed.added).toEqual([LISTED]);
    expect(allowed.ownerDecision).toBe('Owner-decision: the graph pages read the projection directly until the stage lands');
    expect(baseGuardProblemLines(allowed)).toEqual([]);
    expect(baseGuardPasses(allowed)).toBe(true);
  });

  test('an entry of a rule that takes no baseline fails even when the owner decided', () => {
    const root = repository();
    mkdirSync(join(root, '.architecture'), { recursive: true });
    writeFileSync(join(root, VIOLATION_LIST), '[]\n');
    commit(root, 'the list starts empty');
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const entry: ListedViolation = { rule: 'no-unreachable-code', file: 'src/orphan.ts', symbol: null };
    writeFileSync(join(root, VIOLATION_LIST), `${JSON.stringify([entry], null, 2)}\n`);
    commit(root, 'list dead code\n\nOwner-decision: the owner allows this violation');

    const refused = baseGuard({ root, base });
    expect(refused.added).toEqual([entry]);
    expect(refused.ownerDecision).toContain('Owner-decision:');
    expect(baseGuardPasses(refused)).toBe(false);
    expect(baseGuardProblemLines(refused)[0]).toContain('takes no baseline');
  });

  test('a list the branch only lost entries from passes, and a base that holds no list is not compared', () => {
    const root = repository();
    mkdirSync(join(root, '.architecture'), { recursive: true });
    writeFileSync(join(root, VIOLATION_LIST), `${JSON.stringify([LISTED, { rule: 'one-fill-entry', file: 'src/a.ts', symbol: 'src/product/fill.ts:startFill' }], null, 2)}\n`);
    commit(root, 'the list holds two entries');
    const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    writeFileSync(join(root, VIOLATION_LIST), `${JSON.stringify([LISTED], null, 2)}\n`);
    commit(root, 'fix one of them');
    const shrunk = baseGuard({ root, base });
    expect(shrunk.added).toEqual([]);
    expect(baseGuardProblemLines(shrunk)).toEqual([]);

    const withoutList = repository();
    writeFileSync(join(withoutList, 'README.md'), 'a repository whose base holds no list\n');
    commit(withoutList, 'a base without a list');
    const before = execFileSync('git', ['-C', withoutList, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    mkdirSync(join(withoutList, '.architecture'), { recursive: true });
    writeFileSync(join(withoutList, VIOLATION_LIST), `${JSON.stringify([LISTED], null, 2)}\n`);
    commit(withoutList, 'introduce the list');
    const introduced = baseGuard({ root: withoutList, base: before });
    expect(introduced.baseHasList).toBe(false);
    expect(introduced.added).toEqual([]);
    expect(baseGuardPasses(introduced)).toBe(true);
  });

  test('a base that cannot be resolved fails by name rather than passing silently', () => {
    const root = repository();
    mkdirSync(join(root, '.architecture'), { recursive: true });
    writeFileSync(join(root, VIOLATION_LIST), '[]\n');
    commit(root, 'the list starts empty');
    expect(() => baseGuard({ root })).toThrow(/origin\/main/);
  });
});

describe('the reads and names of decision 0036, section 8', () => {
  /** The fixture with a route table and the API map a route is written through. */
  function readFixture(): string {
    const root = fixtureProject();
    writeModule(root, 'src/knowledge/addresses.ts', [
      '/** The API the wiki answers, one address per answer. */',
      'export const API = {',
      "  status: '/api/status',",
      "  page: '/api/page',",
      '} as const;',
      '',
    ]);
    return root;
  }

  test('a read route outside /graphql and the kept list fails, naming the route; a kept route passes', async () => {
    const root = readFixture();
    const routes = (planted: string): string[] => [
      '/** The one way in. */',
      "import { API } from '../knowledge/addresses.js';",
      '',
      'export const routes = [',
      "  { method: 'GET', path: '/graphql/schema' },",
      "  { method: 'GET', path: API.status },",
      planted,
      '];',
      '',
    ];
    writeModule(root, 'src/server/http.ts', routes("  { method: 'GET', path: API.page },"));
    const found = architectureProblemLines(await architectureCheck({ root, rules: ['graphql-only-reads'] }));
    expect(found).toHaveLength(1);
    expect(found[0]).toStartWith(`${join(root, 'src/server/http.ts')}:7: graphql-only-reads: `);
    expect(found[0]).toContain('answers the route GET /api/page');
    writeModule(root, 'src/server/http.ts', routes("  { method: 'GET', path: '/api/kind-usage' },"));
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['graphql-only-reads'] }))).toEqual([]);
  });

  test('a route path the check cannot resolve to a literal is a violation, not a pass', async () => {
    const root = readFixture();
    const routes = (planted: string): string[] => [
      '/** The one way in. */',
      "import { API } from '../knowledge/addresses.js';",
      '',
      'export const routes = [',
      "  { method: 'GET', path: '/graphql/schema' },",
      "  { method: 'GET', path: API.status },",
      planted,
      '];',
      '',
    ];
    // A path this check cannot read is a violation of its own: a variable is not a literal.
    writeModule(root, 'src/server/http.ts', routes("  { method: 'GET', path: computed },"));
    const unresolved = architectureProblemLines(await architectureCheck({ root, rules: ['graphql-only-reads'] }));
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toStartWith(`${join(root, 'src/server/http.ts')}:7: graphql-only-reads: `);
    expect(unresolved[0]).toContain('not a literal path');
    // A template with no substitution is a literal and is checked as one: it is refused for being a retired read.
    writeModule(root, 'src/server/http.ts', routes("  { method: 'GET', path: `/api/page` },"));
    const retired = architectureProblemLines(await architectureCheck({ root, rules: ['graphql-only-reads'] }));
    expect(retired).toHaveLength(1);
    expect(retired[0]).toContain('answers the route GET /api/page');
  });

  test('the authored reads are GraphQL\'s and its writes are kept: GET fails, POST, PATCH and DELETE pass', async () => {
    const root = readFixture();
    const routes = (method: string): string[] => [
      '/** The one way in. */',
      '',
      'export const routes = [',
      "  { method: 'GET', path: '/graphql/schema' },",
      `  { method: '${method}', path: '/api/authored' },`,
      '];',
      '',
    ];
    writeModule(root, 'src/server/http.ts', routes('GET'));
    const refused = architectureProblemLines(await architectureCheck({ root, rules: ['graphql-only-reads'] }));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('answers the route GET /api/authored');
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      writeModule(root, 'src/server/http.ts', routes(method));
      expect(architectureProblemLines(await architectureCheck({ root, rules: ['graphql-only-reads'] })), method).toEqual([]);
    }
  });

  test('a kind name in the server layer fails, and the catalogue written as data does not', async () => {
    const root = readFixture();
    writeModule(root, 'catalog/code/structure/code.file.yaml', ['id: code.file', '']);
    const planted = ['/** The server names a kind. */', "export const PAGE_KIND = 'code.file';", ''];
    writeModule(root, 'src/server/pages.ts', planted);
    const found = architectureProblemLines(await architectureCheck({ root, rules: ['no-kind-names'] }));
    expect(found).toHaveLength(1);
    expect(found[0]).toStartWith(`${join(root, 'src/server/pages.ts')}:2: no-kind-names: `);
    expect(found[0]).toContain('names the kind code.file');
    rmSync(join(root, 'src/server/pages.ts'));
    expect(architectureProblemLines(await architectureCheck({ root, rules: ['no-kind-names'] }))).toEqual([]);
  });

  test('the kind name is refused in the remaining knowledge modules and in the app too', async () => {
    const root = readFixture();
    writeModule(root, 'catalog/code/structure/code.file.yaml', ['id: code.file', '']);
    writeModule(root, 'src/knowledge/probe.ts', ['/** The knowledge readers name no kind either. */', "export const PAGE_KIND = 'code.file';", '']);
    writeModule(root, 'wiki/app/src/probe.tsx', ['/** Nor does the app. */', "export const TERM_KIND = 'code.file';", '']);
    const found = architectureProblemLines(await architectureCheck({ root, rules: ['no-kind-names'] }));
    expect(found).toHaveLength(2);
    expect(found[0]).toStartWith(`${join(root, 'src/knowledge/probe.ts')}:2: no-kind-names: `);
    expect(found[1]).toStartWith(`${join(root, 'wiki/app/src/probe.tsx')}:2: no-kind-names: `);
  });
});
