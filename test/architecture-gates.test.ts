/**
 * The strict gates of madarch-64o5.121: one rule per agreed principle, each read from the TypeScript or the PostgreSQL
 * syntax tree, each held against the debt list .architecture/violations.json writes. Every case plants a violation in a
 * fixture tree and reads the rule's own answer: a rule that cannot refuse its own plant is not a gate.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  test('a field word is product data only in a module that names the kind declaring it', () => {
    const body = 'id: practice.demo-task\nfields:\n  - name: statement\n    type: text\n';
    const without = fixture({
      ...catalogue('demo.task', body),
      'src/without.ts': "export const field = 'statement';\n",
    });
    expect(productDataViolations(without)).toEqual([]);
    const withKind = fixture({
      ...catalogue('demo.task', body),
      'src/with.ts': "export const kind = 'demo.task';\nexport const field = 'statement';\n",
      'src/other.ts': "export const field = 'statement';\n",
    });
    expect(productDataViolations(withKind).map(({ file, line, symbol }) => [file, line, symbol])).toEqual([
      ['src/with.ts', 1, 'demo.task'],
      ['src/with.ts', 2, 'statement'],
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
      'src/a.ts': "export const format = ['definition', 'labels', 'descriptions'];\nexport const data = 'statement';\nexport const kind = 'demo.task';\n",
    });
    // `definition`, `labels` and `descriptions` are the format's; `statement` only the catalogue declares, so it is data.
    expect(productDataViolations(home).map((violation) => [violation.file, violation.symbol])).toEqual([
      ['src/a.ts', 'demo.task'], ['src/a.ts', 'statement'],
    ]);
  });

  test('external wire declarations and help dispatch keep context, not global word exemptions', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: result\n    type: text\n  - name: binary\n    type: text\n  - name: help\n    type: text\n'),
      'src/plugin/wire.ts': "export function isResponse(v: unknown): v is {jsonrpc: '2.0'; result?: unknown} { return typeof v === 'object' && v !== null && 'result' in v; }\nexport const product = 'result';\nexport const kind = 'demo.kind';\n",
      'src/plugin/product-source.ts': "interface IndexedFile { form: 'text' | 'binary' | null }\nexport const product = 'binary';\nexport const kind = 'demo.kind';\n",
      'src/product/cli.ts': "export function parse(args: string[]) { if(args[0] === 'help' || args[0] === '--help' || args[0] === '-h') return; }\nexport const product = 'help';\nexport const kind = 'demo.kind';\n",
      'src/other.ts': "export const product = ['result', 'binary', 'help'];\nexport const kind = 'demo.kind';\n",
      'src/render/likec4.ts': "const RESERVED = new Set(['result']); export function safe(name: string) { return RESERVED.has(name); }\nexport const product = 'result';\nexport const kind = 'demo.kind';\n",
    });
    expect(productDataViolations(home).map((finding) => [finding.file, finding.line, finding.symbol])).toEqual([
      ['src/other.ts', 1, 'binary'], ['src/other.ts', 2, 'demo.kind'], ['src/other.ts', 1, 'help'], ['src/other.ts', 1, 'result'],
      ['src/plugin/product-source.ts', 2, 'binary'], ['src/plugin/product-source.ts', 3, 'demo.kind'],
      ['src/plugin/wire.ts', 3, 'demo.kind'], ['src/plugin/wire.ts', 2, 'result'],
      ['src/product/cli.ts', 3, 'demo.kind'], ['src/product/cli.ts', 2, 'help'],
      ['src/render/likec4.ts', 3, 'demo.kind'], ['src/render/likec4.ts', 1, 'result'],
    ]);
  });

  test('TypeBox protocol literal proofs stay at imported exported schema declarations', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: scope\n    type: text\n'),
      'src/plugin/protocol.ts': [
        "import { Type } from 'typebox';",
        "export const Contract = Type.Object({ scope: Type.Literal('scope') });",
        "export const diagnostic = 'scope';",
        "const privateSchema = Type.Literal('scope');",
        "export const kind = 'demo.kind';",
      ].join('\n'),
      'src/other.ts': "import { Type } from 'typebox'; export const Product = Type.Literal('scope'); export const kind = 'demo.kind';",
    });
    expect(productDataViolations(home).map((finding) => [finding.file, finding.line])).toEqual([
      ['src/other.ts', 1], ['src/other.ts', 1], ['src/plugin/protocol.ts', 5], ['src/plugin/protocol.ts', 3],
    ]);
  });

  test('daemon type keys require the imported exported member declaration', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: activity\n    type: text\n  - name: missing\n    type: text\n'),
      'src/product/daemon-fills.ts': 'export interface DaemonFills { activity(): void }',
      'src/product/daemon.ts': [
        "import type { DaemonFills } from './daemon-fills.js';",
        "type A = Pick<DaemonFills, 'activity'>;",
        "type B = DaemonFills['activity'];",
        "type C = Pick<DaemonFills, 'missing'>;",
        "const product = 'activity';",
        "export const kind = 'demo.kind';",
      ].join('\n'),
    });
    expect(productDataViolations(home).map((finding) => [finding.line, finding.symbol])).toEqual([[5, 'activity'], [6, 'demo.kind'], [4, 'missing']]);
    const noAuthority = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: activity\n    type: text\n'),
      'src/product/daemon.ts': "interface DaemonFills { activity(): void }; type A = Pick<DaemonFills, 'activity'>; export const kind = 'demo.kind';",
    });
    expect(productDataViolations(noAuthority).map((finding) => finding.symbol)).toEqual(['activity', 'demo.kind']);
  });

  test('IndexedFile comparison proofs reject unrelated and shadowed form values', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: binary\n    type: text\n'),
      'src/plugin/product-source.ts': [
        "interface IndexedFile { form: 'text' | 'binary' | null }",
        'class Files { private index: Map<string, IndexedFile>;',
        "read(path: string) { const file = this.index.get(path); return file.form === 'binary'; }",
        "other() { const file = {form: 'ordinary'}; return file.form === 'binary'; }",
        '}',
        "export const kind = 'demo.kind';",
      ].join('\n'),
    });
    expect(productDataViolations(home).map((finding) => [finding.line, finding.symbol])).toEqual([[4, 'binary'], [6, 'demo.kind']]);
  });

  test('PluginManifest diagnostic keys require the same schema member and typed body', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: concurrency\n    type: text\n'),
      'src/plugin/closure.ts': [
        "import { Type } from 'typebox';",
        'export const PluginManifest = Type.Object({ concurrency: Type.Integer() });',
        'function parsePluginManifest(value: unknown) { const body = value as Partial<PluginManifest>;',
        "if (body.concurrency < 1) refuse('concurrency', 'bad value');",
        "const product = 'concurrency'; }",
        "export const kind = 'demo.kind';",
      ].join('\n'),
    });
    expect(productDataViolations(home).map((finding) => finding.line)).toEqual([5, 6]);
  });

  test('protocol contexts reject unrelated strings inside guards and help branches', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: result\n    type: text\n  - name: help\n    type: text\n'),
      'src/plugin/wire.ts': "export function isResponse(v: unknown): v is {jsonrpc: '2.0'; result?: unknown} { const product = 'result'; return 'result' in v; } export const kind = 'demo.kind';",
      'src/product/cli.ts': "function parse(args: string[]) { if(args[0] === 'help' || args[0] === '--help' || args[0] === '-h') { const product = 'help'; } } export const kind = 'demo.kind';",
    });
    expect(productDataViolations(home).map((finding) => [finding.file, finding.symbol])).toEqual([
      ['src/plugin/wire.ts', 'demo.kind'], ['src/plugin/wire.ts', 'result'],
      ['src/product/cli.ts', 'demo.kind'], ['src/product/cli.ts', 'help'],
    ]);
  });

  test('closed CLI command grammar and imported lifecycle outcomes stay contextual', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: url\n    type: text\n  - name: remote\n    type: text\n  - name: product\n    type: text\n'),
      'src/product/cli.ts': [
        "export const COMMANDS = { remote: { positionals: ['url'], flags: {} } };",
        "export function main(args: string[]) { const command = args[0]!; if (!(command in COMMANDS)) return 2; if (command === 'remote') return; }",
        "async function whereHelp() { const { whereAmI } = await import('./lifecycle.js'); const context = whereAmI({}); if (context.outcome === 'product') return; }",
        "export const data = ['url', 'remote', 'product'];",
        "export const kind = 'demo.kind';",
      ].join('\n'),
      'src/product/lifecycle.ts': "export type WhereResult = {outcome: 'product'} | {outcome: 'none'}; export function whereAmI(): WhereResult { return {outcome: 'none'}; }",
    });
    expect(productDataViolations(home).filter((finding) => finding.file === 'src/product/cli.ts').map((finding) => [finding.line, finding.symbol])).toEqual([[5, 'demo.kind'], [4, 'product'], [4, 'remote'], [4, 'url']]);
  });

  test('a command comparison without the closed dispatcher guard is refused', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: remote\n    type: text\n'),
      'src/product/cli.ts': "export const COMMANDS = {remote: {positionals: []}}; export function main(args: string[]) { const command = args[0]; if(command === 'remote') return; } export const kind = 'demo.kind';",
    });
    expect(productDataViolations(home).map((finding) => finding.symbol)).toEqual(['demo.kind', 'remote']);
  });

  test('plugin verb union and parser tests do not exempt unrelated literals', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: check\n    type: text\n'),
      'src/plugin/cli.ts': [
        "interface PluginOptions { verb: 'check' | 'run' }",
        "function parse(args: string[]) { const verb = args[0]; if (verb !== 'check' && verb !== 'run') return 2; }",
        "const product = 'check';",
        "export const kind = 'demo.kind';",
      ].join('\n'),
    });
    expect(productDataViolations(home).map((finding) => finding.line)).toEqual([3, 4]);
  });

  test('LikeC4 keywords require official grammar membership and the reserved-name adapter', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: size\n    type: text\n  - name: invented\n    type: text\n'),
      'src/render/likec4.ts': [
        "const RESERVED = new Set(['size', 'invented']);",
        'function identifier(name: string) { return RESERVED.has(name) ? name + "_" : name; }',
        "export const product = 'size';",
        "export const kind = 'demo.kind';",
      ].join('\n'),
      'src/other.ts': "const RESERVED = new Set(['size']); export const check = RESERVED.has('anything'); export const kind = 'demo.kind';",
    });
    expect(productDataViolations(home).map((finding) => [finding.file, finding.line, finding.symbol])).toEqual([
      ['src/other.ts', 1, 'demo.kind'], ['src/other.ts', 1, 'size'],
      ['src/render/likec4.ts', 4, 'demo.kind'], ['src/render/likec4.ts', 1, 'invented'], ['src/render/likec4.ts', 3, 'size'],
    ]);
  });

  test('semantic projection reads retain the exact checked role protocol', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: ordinal\n    type: integer\n'),
      'src/model/semantic-role-protocol.ts': [
        "import {Type} from 'typebox'; import {Value} from 'typebox/value';",
        "export const ROLE_BINDING_SCHEMA = Type.Union([Type.Object({role:Type.Literal('claim-projection'),properties:Type.Object({ordinal:Type.Integer()})}),Type.Object({role:Type.Literal('other'),properties:Type.Object({text:Type.String()})})]);",
        'export function checkRoleProperties(schema: unknown, properties: unknown) { return Value.Check(ROLE_BINDING_SCHEMA, properties); }',

      ].join('\n'),
      'src/knowledge/semantic-bindings.ts': "import {checkRoleProperties} from '../model/semantic-role-protocol.js'; export function semanticEntities(graph: unknown, manifest: unknown, role: string) { checkRoleProperties(role, {}); }",
      'src/graph/records.ts': [
        "import {checkRoleProperties} from '../model/semantic-role-protocol.js';",
        "function semanticRecords(tx: unknown, role: string, fields: string[]) { checkRoleProperties(role, {}); }",
        "const held = await semanticRecords(tx,'claim-projection',['ordinal']);",
        "const bad = await semanticRecords(tx,'other',[]);",
        "held.sort((a,b)=>Number(a.values['ordinal'])-Number(b.values['ordinal']));",
        "bad.map(row=>row.values['ordinal']);",
        "function scalar(row: unknown, field: string) { return row.values[field]; }",
        "function good() { const rows=semanticRecords(tx,'claim-projection',[]); return scalar(rows.find(row=>true),'ordinal'); }",
        "function wrong() { const rows=semanticRecords(tx,'other',[]); return scalar(rows.find(row=>true),'ordinal'); }",
        "export const kind = 'demo.kind';",
      ].join('\n'),
      'src/reader.ts': [
        "import {semanticEntities} from './knowledge/semantic-bindings.js';",
        "const claims = await semanticEntities(graph, manifest, 'claim-projection');",
        "claims.filter(row => true).sort((a,b) => Number(a.properties['ordinal']) - Number(b.properties['ordinal']));",
        "const other = await semanticEntities(graph, manifest, 'other');",
        "other.map(row => row.properties['ordinal']);",
        "export const kind = 'demo.kind';",
      ].join('\n'),
    });
    expect(productDataViolations(home).map((finding) => [finding.file, finding.line])).toEqual([
      ['src/graph/records.ts', 10], ['src/graph/records.ts', 6], ['src/reader.ts', 6], ['src/reader.ts', 5],
    ]);
  });

  test('batch semantic slots follow checked request positions even when the helper is renamed', () => {
    const batch = 'async function renamedProjection(tx, requests) {\n const manifest = await readPublishedManifest(tx);\n const plans = requests.map(({role, fields, edgeRole}) => {\n const binding = manifest.semanticBindings.get(role);\n const edge = edgeRole === undefined ? undefined : binding.edges[edgeRole];\n const mappings = edge === undefined ? binding.fields : edge.fields;\n return {role, edgeRole, mappings, request: {kind: binding.kind, fields: fields.map(field => mappings[field])}};\n });\n const batches = await readKindsAssertions(tx, plans.map(plan => plan.request));\n return plans.map(({role, edgeRole, mappings}, index) => batches[index].map(row => {\n const values = {};\n for (const [semantic, actual] of Object.entries(mappings)) { values[semantic] = row.values[actual]; }\n checkRoleProperties(edgeRole === undefined ? role : `${role}.${edgeRole}`, values);\n return {...row, values};\n }));\n}';
    const protocol = [
      "import {Type} from 'typebox'; import {Value} from 'typebox/value';",
      "export const ROLE_BINDING_SCHEMA = Type.Union([Type.Object({role:Type.Literal('claim-projection'),properties:Type.Object({ordinal:Type.Integer()})}),Type.Object({role:Type.Literal('other'),properties:Type.Object({text:Type.String()})})]);",
      'export function checkRoleProperties(schema, properties) { return Value.Check(ROLE_BINDING_SCHEMA, properties); }',
    ].join('\n');
    const read = [
      "const [claims=[], other=[]] = await renamedProjection(tx,[{role:'claim-projection',fields:['ordinal']},{role:'other',fields:[]}]);",
      "claims.map(row => row.values['ordinal']);",
      "other.map(row => row.values['ordinal']);",
      "const [wrong=[]] = await renamedProjection(tx,[{role:'other',fields:['ordinal']}]);",
    ].join('\n');
    const findings = (helper: string, schema = protocol, reads = read) => productDataViolations(fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: ordinal\n    type: integer\n'),
      'src/model/semantic-role-protocol.ts': schema,
      'src/knowledge/semantic-bindings.ts': "import {checkRoleProperties} from '../model/semantic-role-protocol.js'; export function semanticEntities(graph, manifest, role) { checkRoleProperties(role, {}); }",
      'src/graph/records.ts': "import {checkRoleProperties} from '../model/semantic-role-protocol.js'; export const kind = 'demo.kind';\n" + helper + '\n' + reads,
    })).filter(finding => finding.file === 'src/graph/records.ts').map(finding => finding.line);
    const start = batch.split('\n').length + 2;
    expect(findings(batch)).toEqual([1, start + 2]);
    expect(findings(batch, protocol, read.split('\n')[3])).toEqual([1, start]);
    expect(findings(batch.replace('checkRoleProperties(edgeRole === undefined ? role : `${role}.${edgeRole}`, values);', ''))).toEqual([1, start]);
    expect(findings(batch, protocol.replace('return Value.Check(ROLE_BINDING_SCHEMA, properties);', 'return true;'))).toEqual([1, start]);
    expect(findings(batch.replace('values[semantic] = row.values[actual];', 'values[actual] = row.values[actual];'))).toEqual([1, start]);
    expect(findings(batch.replace('return plans.map(', 'return plans.reverse().map('))).toEqual([1, start]);
    expect(findings(batch.replace('await readKindsAssertions(', 'await fakeRead('))).toEqual([1, start]);
    expect(findings(batch.replace('plans.map(plan => plan.request)', 'plans.map(plan => unrelated)'))).toEqual([1, start]);
    expect(findings(batch.replace('mappings}, index)', 'mappings}, wrongIndex)'))).toEqual([1, start]);
  });

  test('assertion schema names are scoped to exported typed declaration arrays', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: question\n    type: text\n'),
      'src/graphql/schema.ts': [
        "export const ASSERTION_SCHEMA_TYPES: readonly TypeDef[] = [{name:'Assertion', fields:[{name:'question', type:'String'}]}];",
        "export const arbitrary: readonly TypeDef[] = [{name:'Other', fields:[{name:'question', type:'String'}]}];",
        "export const kind = 'demo.kind';",
      ].join('\n'),
    });
    expect(productDataViolations(home).map((finding) => finding.line)).toEqual([3, 2]);
  });

  test('protected system fields require their exact registry kind and storage helper', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: digest\n    type: text\n'),
      'src/graph/system-contract.ts': "export const SYSTEM_VERTEX_DEFINITIONS = [{name: 'system.operation', fields: [{name: 'digest', type: 'text'}]}];",
      'src/graph/operation-host.ts': [
        'async function selected(tx: unknown, kind: string, uid: string, property: string) { return loadAssertions(tx, kind, property); }',
        "const a = selected(tx, 'system.operation', uid, 'digest');",
        "const b = selected(tx, 'demo.kind', uid, 'digest');",
      ].join('\n'),
    });
    expect(productDataViolations(home).map((finding) => [finding.file, finding.line])).toEqual([['src/graph/operation-host.ts', 3], ['src/graph/operation-host.ts', 3]]);
  });

  test('system selector lists and evidence metadata stay tied to their declared fields', () => {
    const home = fixture({
      ...catalogue('demo.kind', 'fields:\n  - name: digest\n    type: text\n  - name: absent\n    type: text\n'),
      'src/graph/system-contract.ts': [
        "export const SYSTEM_OPERATION='system.operation';",
        "export const SYSTEM_VERTEX_DEFINITIONS=[{name:'system.operation',evidence:{digestField:'digest',contentField:'absent'},fields:[{name:'digest',type:'text'}]}];",
        "export const kind='demo.kind';",
      ].join('\n'),
      'src/graph/fill-orchestration.ts': [
        "const fields={'system.operation':['digest']};",
        "const known=['digest'];",
        "const wrong=['digest'];",
        "function read(tx,kind,uid) { return readKindAssertions(tx,'vertex',kind,kind==='system.operation'?known:kind==='system.unknown'?wrong:fields[kind]); }",
        "const arbitrary=['digest'];",
        "export const kind='demo.kind';",
      ].join('\n'),
    });
    expect(productDataViolations(home).map(finding=>[finding.file,finding.line,finding.symbol])).toEqual([
      ['src/graph/fill-orchestration.ts',6,'demo.kind'],
      ['src/graph/fill-orchestration.ts',3,'digest'],
      ['src/graph/system-contract.ts',2,'absent'],
      ['src/graph/system-contract.ts',3,'demo.kind'],
    ]);
  });

  test('transaction modes require the canonical mode type and owner-backed forwarding', () => {
    const home=fixture({
      ...catalogue('demo.kind','fields:\n  - name: snapshot\n    type: text\n'),
      'src/sql-driver.ts': [
        "export const SQL_TRANSACTION_KINDS = { snapshot: 'snapshot', write: 'write' } as const;",
        'export type SqlTransactionKind = typeof SQL_TRANSACTION_KINDS[keyof typeof SQL_TRANSACTION_KINDS];',
        "export const arbitrary = 'snapshot';",
        "export const kind = 'demo.kind';",
      ].join('\n'),
      'src/adapters/database-owner.ts': [
        "import type {SqlTransactionKind} from '../sql-driver.js';",
        'export interface DatabaseOwner { transaction(kind:SqlTransactionKind,work:unknown):Promise<unknown> }',
      ].join('\n'),
      'src/reader.ts': [
        "import type {DatabaseOwner} from './adapters/database-owner.js';",
        "type Owner=Pick<DatabaseOwner,'transaction'>;",
        "function run(database:Owner,kind:'snapshot'|'write',work:unknown){ const arbitrary='snapshot'; return database.transaction(kind,work); }",
        "run(database,'snapshot',work);",
        "const arbitrary='snapshot';",
        "export const kind='demo.kind';",
      ].join('\n'),
    });
    expect(productDataViolations(home).map(finding=>[finding.file,finding.line])).toEqual([
      ['src/reader.ts',6],['src/reader.ts',3],['src/sql-driver.ts',4],['src/sql-driver.ts',3],
    ]);
  });

  test('the registry form declares no mode word without a typed owner consumer', () => {
    const driver=[
      "export const SQL_TRANSACTION_KINDS = { snapshot: 'snapshot', write: 'write' } as const;",
      'export type SqlTransactionKind = typeof SQL_TRANSACTION_KINDS[keyof typeof SQL_TRANSACTION_KINDS];',
      "export const kind = 'demo.kind';",
    ].join('\n');
    const tree={ ...catalogue('demo.kind','fields:\n  - name: snapshot\n    type: text\n'), 'src/sql-driver.ts': driver };
    const findings=(files:Readonly<Record<string,string>>)=>productDataViolations(fixture(files))
      .filter(finding=>finding.file==='src/sql-driver.ts').map(finding=>[finding.line,finding.symbol]);
    expect(findings(tree)).toEqual([[3,'demo.kind'],[1,'snapshot']]);
    expect(findings({ ...tree, 'src/adapters/database-owner.ts': 'export interface DatabaseOwner { transaction(kind:string,work:unknown):void }' })).toEqual([[3,'demo.kind'],[1,'snapshot']]);
  });

  test('logical state selectors require the exact system template projection', () => {
    const home=fixture({
      ...catalogue('demo.kind','fields:\n  - name: scope\n    type: text\n'),
      'src/graph/system-contract.ts': "export const SYSTEM_VERTEX_DEFINITIONS=[{name:'system.unit',fields:[{name:'scope',type:'text'}]}];",
      'src/graph/fill-state.ts': [
        "const fields={unit:['scope'],run:['scope']};",
        "function rows(tx,kind){return readGraphRecords(tx,'vertex',`system.${kind}`,fields[kind]);}",
        "const arbitrary=['scope'];",
        "export const kind='demo.kind';",
      ].join('\n'),
    });
    expect(productDataViolations(home).map(finding=>[finding.file,finding.line])).toEqual([
      ['src/graph/fill-state.ts',4],['src/graph/fill-state.ts',1],
    ]);
  });

  test('a typed FSM state subset retains canonical machine authority', () => {
    const home=fixture({
      ...catalogue('demo.kind','fields:\n  - name: skipped\n    type: text\n'),
      'src/fill/fsm.ts': "export const UNIT_STATES=['skipped']; export type UnitState=typeof UNIT_STATES[number]; export const kind='demo.kind';",
      'src/reader.ts': [
        "import type {UnitState} from './fill/fsm.js';",
        "const subset:readonly UnitState[]=['skipped'];",
        "const arbitrary=['skipped'];",
        "export const kind='demo.kind';",
      ].join('\n'),
    });
    expect(productDataViolations(home).map(finding=>[finding.file,finding.line])).toEqual([
      ['src/fill/fsm.ts',1],['src/fill/fsm.ts',1],['src/reader.ts',4],['src/reader.ts',3],
    ]);
  });

  test('protected row loops retain lexical collection and exact kind provenance', () => {
    const home=fixture({
      ...catalogue('demo.kind','fields:\n  - name: result\n    type: text\n'),
      'src/graph/system-contract.ts': "export const SYSTEM_VERTEX_DEFINITIONS=[{name:'system.operation',fields:[{name:'result',type:'text'}]}];",
      'src/reader.ts': [
        "import {readKindAssertions} from './graph/records.js';",
        "const records=await readKindAssertions(tx,'vertex','system.operation',['result']);",
        "for(const record of records){consume(record.values['result']);}",
        "async function wrong(){const records=await readKindAssertions(tx,'vertex','other',[]);for(const record of records){consume(record.values['result']);}}",
        "function readGraphRecords(tx,sort,kind,fields){return readKindAssertions(tx,sort,kind,fields);}",
        "function project(row){return row.values['result'];}",
        "const privateRows=await readGraphRecords(tx,'vertex','system.operation',['result']);",
        "const wrongRows=await readGraphRecords(tx,'vertex','other',['result']);",
        "privateRows.map(row=>project(row));",
        "export const kind='demo.kind';",

      ].join('\n'),
    });
    expect(productDataViolations(home).map(finding=>[finding.file,finding.line])).toEqual([
      ['src/reader.ts',10],['src/reader.ts',4],
    ]);
  });

  test('private row projectors require agreement of every actual caller', () => {
    const home=fixture({
      ...catalogue('demo.kind','fields:\n  - name: result\n    type: text\n'),
      'src/graph/system-contract.ts': "export const SYSTEM_VERTEX_DEFINITIONS=[{name:'system.operation',fields:[{name:'result',type:'text'}]}];",
      'src/reader.ts': [
        "import {readKindAssertions} from './graph/records.js';",
        "function project(row){return row.values['result'];}",
        "const known=await readKindAssertions(tx,'vertex','system.operation',[]);",
        "known.map(row=>project(row));",
        "const other=await readKindAssertions(tx,'vertex','other',[]);",
        "other.map(row=>project(row));",
        "export const kind='demo.kind';",
      ].join('\n'),
    });
    expect(productDataViolations(home).map(finding=>[finding.file,finding.line])).toEqual([
      ['src/reader.ts',7],['src/reader.ts',2],
    ]);
  });

  test('a forwarding row reader must call the imported assertion reader', () => {
    const home=fixture({
      ...catalogue('demo.kind','fields:\n  - name: result\n    type: text\n'),
      'src/graph/system-contract.ts': "export const SYSTEM_VERTEX_DEFINITIONS=[{name:'system.operation',fields:[{name:'result',type:'text'}]}];",
      'src/reader.ts': [
        "function unrelated(tx,sort,kind,fields){return arbitrary(tx,sort,kind,fields);}",
        "const records=await unrelated(tx,'vertex','system.operation',[]);",
        "records.map(row=>row.values['result']);",
        "export const kind='demo.kind';",
      ].join('\n'),
    });
    expect(productDataViolations(home).map(finding=>[finding.file,finding.line])).toEqual([
      ['src/reader.ts',4],['src/reader.ts',3],
    ]);
  });

  test('locator reads require earlier validation of the exact receiver', () => {
    const home=fixture({
      ...catalogue('demo.kind','fields:\n  - name: digest\n    type: text\n'),
      'src/graph/evidence-locator.ts': "export const EVIDENCE_LOCATOR_SCHEMA={properties:{digest:{type:'string'}}}; const validate=validateDeclaredJsonSchema(EVIDENCE_LOCATOR_SCHEMA);",
      'src/reader.ts': [
        "import {validateEvidenceLocator} from './graph/evidence-locator.js';",
        "function good(proof){validateEvidenceLocator(proof.locator);return proof.locator['digest'];}",
        "function wrong(proof){validateEvidenceLocator(proof.other);return proof.locator['digest'];}",
        "export const kind='demo.kind';",
      ].join('\n'),
    });
    expect(productDataViolations(home).map(finding=>[finding.file,finding.line])).toEqual([
      ['src/reader.ts',4],['src/reader.ts',3],
    ]);
  });

  test('SourceText may declare the actual file-read protocol fields that collide with catalogue fields', () => {
    const home = fixture({
      ...catalogue('demo.task', 'fields:\n  - name: bytes\n    type: number\n'),
      'src/knowledge/file-text-shape.ts': readFileSync(new URL('../src/knowledge/file-text-shape.ts', import.meta.url), 'utf8'),
      'src/graphql/schema.ts': readFileSync(new URL('../src/graphql/schema.ts', import.meta.url), 'utf8'),
    });
    expect(productDataViolations(home)).toEqual([]);
  });

  test('protocol vocabulary is scoped to direct SourceText field names, not arbitrary engine strings', () => {
    const home = fixture({
      ...catalogue('demo.task', 'fields:\n  - name: bytes\n    type: number\n  - name: statement\n    type: text\n  - name: line\n    type: number\n'),
      'src/knowledge/file-text-shape.ts': 'export interface FileTextResult { readonly bytes: number; readonly next: { readonly line: number }; }',
      'src/graphql/schema.ts': [
        "this.type('SourceText', [{ name: 'bytes', type: 'Int!' }]);",
        "this.type('SourceText', [{ name: 'statement', type: 'String' }]);",
        "this.type('SourceText', [{ name: 'line', type: 'Int!' }]);",
        "this.type('OtherType', [{ name: 'bytes', type: 'Int!' }]);",
        "this.type('SourceText', [{ name: 'text', type: 'bytes' }]);",
        "export const arbitrary = 'bytes';",
        "export const kind = 'demo.task';",
      ].join('\n'),
      'src/a.ts': "export const arbitrary = 'bytes';\nexport const kind = 'demo.task';\n",
    });
    expect(productDataViolations(home).map(({ file, line, symbol }) => [file, line, symbol])).toEqual([
      ['src/a.ts', 1, 'bytes'], ['src/a.ts', 2, 'demo.task'],
      ['src/graphql/schema.ts', 4, 'bytes'], ['src/graphql/schema.ts', 7, 'demo.task'],
      ['src/graphql/schema.ts', 3, 'line'], ['src/graphql/schema.ts', 2, 'statement'],
    ]);
  });

  test('a protocol word outside its declaration slot is still product data', () => {
    for (const source of [
      "export const arbitrary = 'bytes';",
      "this.type('OtherType', [{ name: 'bytes', type: 'Int!' }]);",
      "this.type('SourceText', [{ name: 'text', type: 'bytes' }]);",
      "other.type('SourceText', [{ name: 'bytes', type: 'Int!' }]);",
      "this.other('SourceText', [{ name: 'bytes', type: 'Int!' }]);",
    ]) {
      const home = fixture({
        ...catalogue('demo.task', 'fields:\n  - name: bytes\n    type: number\n'),
        'src/knowledge/file-text-shape.ts': 'export interface FileTextResult { readonly bytes: number; }',
        'src/graphql/schema.ts': `${source} export const kind = 'demo.task';`,
      });
      expect(productDataViolations(home).map(({ symbol }) => symbol)).toEqual(['bytes', 'demo.task']);
    }
  });

  test('only FileTextResult properties justify a protocol declaration', () => {
    for (const declaration of [
      'export interface OtherResult { readonly bytes: number; }',
      'export interface FileTextResult { readonly text: string; }',
      '',
    ]) {
      const home = fixture({
        ...catalogue('demo.task', 'fields:\n  - name: bytes\n    type: number\n'),
        'src/knowledge/file-text-shape.ts': declaration,
        'src/graphql/schema.ts': "this.type('SourceText', [{ name: 'bytes', type: 'Int!' }]); export const kind = 'demo.task';",
      });
      expect(productDataViolations(home).map(({ symbol }) => symbol)).toEqual(['bytes', 'demo.task']);
    }
  });

  test('system declarations do not make their words manifest format vocabulary', () => {
    const home = fixture({
      ...catalogue('question', 'id: practice.question\n'),
      'src/product/manifest/system-catalogue.ts': "export const declarations = [['question', 'Question']];\n",
      'src/a.ts': "export const literal = 'question';\n",
    });
    expect(productDataViolations(home).map((violation) => [violation.file, violation.symbol])).toEqual([
      ['src/a.ts', 'question'],
    ]);
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

describe('catalogue JSON schemas (0039 item 4)', () => {
  const dialect = 'https://json-schema.org/draft/2020-12/schema';
  function metadata(schema: unknown): string {
    return JSON.stringify({ fields: [{ name: 'metadata', type: 'json', ...(schema === undefined ? {} : { schema }) }] });
  }
  test('a valid closed structured scalar schema is accepted', () => {
    const schema = { $schema: dialect, type: 'object', properties: { ports: { type: 'array', items: { type: 'integer' } } }, additionalProperties: false };
    expect(cataloguePointerViolations(fixture(catalogue('demo.kind', metadata(schema))))).toEqual([]);
  });
  test('missing, invalid, unconstrained and wrong dialect schemas are refused', () => {
    for (const schema of [undefined, { $schema: dialect, type: 'unknown' }, { $schema: dialect }, { $schema: dialect, type: 'object' }, { $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' }]) {
      expect(cataloguePointerViolations(fixture(catalogue('demo.kind', metadata(schema)))).map((finding) => finding.symbol)).toEqual(['metadata']);
    }
  });
  test('declared nested entity identity is still a pointer', () => {
    const schema = { $schema: dialect, type: 'array', items: { type: 'object', properties: { kind: { const: 'demo.person' }, key: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false } }, required: ['kind', 'key'], additionalProperties: false } };
    expect(cataloguePointerViolations(fixture(catalogue('demo.kind', metadata(schema)))).map((finding) => finding.symbol)).toEqual(['metadata']);
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

  test('a prop that names a test, a key or a style is structure, not words a reader reads', async () => {
    const home = fixture({
      'wiki/app/src/components/page.tsx': [
        'export const Page = () => (<Stack>',
        '  <Select testId="a-model" display="timeline" checked="indeterminate" />',
        '  <svg viewBox="0 0 20 20"><path d="M20 20 L180 80" /></svg>',
        '  <Text label="Checkbox" emptyText="nothing yet" />',
        '</Stack>);',
      ].join('\n'),
    });
    // `label` and `emptyText` end in a text word and are read; the rest name a test, a variant, a control's state, a path.
    expect(i18nViolations(home).map((violation) => violation.symbol)).toEqual(['emptyText: nothing yet', 'label: Checkbox']);
  });

  test('a dash, a slash or a bracket standing for an empty value is layout, not a sentence', async () => {
    const home = fixture({
      'wiki/app/src/components/page.tsx': 'export const Page = () => (<Text>—</Text>);\nexport const Sep = () => (<Text> / </Text>);\n',
    });
    expect(i18nViolations(home)).toEqual([]);
  });

  test('an aria-label is heard by a screen reader, so its literal is refused', async () => {
    const home = fixture({
      'wiki/app/src/components/page.tsx': 'export const Page = () => (<Button aria-label="next" />);\n',
    });
    expect(i18nViolations(home).map((violation) => violation.symbol)).toEqual(['aria-label: next']);
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

  test('the synchronous form opens a span, and a node in a slot of the span call is enclosed by it', async () => {
    const home = fixture({ 'src/b.ts': [
      'export function unspanned(): string {',
      "  return readFileSync('/tmp/a', 'utf8');",
      '}',
      'export function spanned(): string {',
      "  return String(withSpanSync('a', {}, () => statSync('/tmp/a').isFile()));",
      '}',
      'export async function arrow(): Promise<unknown> {',
      "  return await withSpan('a', {}, async () => {",
      "    return await fetch('https://example.test');",
      '  });',
      '}',
    ].join('\n') });
    expect(ioSpansViolations(home).map((violation) => [violation.line, violation.symbol])).toEqual([[2, 'readFileSync()']]);
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
