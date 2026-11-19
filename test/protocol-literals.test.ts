import { describe, expect, test } from 'bun:test';
import { parseSync } from '@swc/core';
import type { GateModule } from '../scripts/check/architecture/gates.js';
import { declarationProtocolLiteral } from '../scripts/check/architecture/protocol-literals.js';

type Node = Record<string, unknown>;
function parsed(file: string, text: string): GateModule {
  return { file, text, tree: parseSync(text, { syntax: 'typescript' }) as unknown as Node, lineAt: () => 1 };
}
function literals(node: Node): Node[] {
  const found: Node[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (value === null || typeof value !== 'object') return;
    const item = value as Node;
    if (item['type'] === 'StringLiteral') found.push(item);
    for (const [key, child] of Object.entries(item)) if (key !== 'span' && key !== 'ctxt') walk(child);
  };
  walk(node); return found;
}
function decisions(source: string, word: string, file = 'src/fixture.ts'): boolean[] {
  const module = parsed(file, source);
  const modules = new Map<string, GateModule>([
    ['src/graph/contract.ts', parsed('src/graph/contract.ts', `export type FieldType = 'text' | 'integer' | 'boolean';
      export interface FieldContract { type: FieldType }
      export interface VertexContract { fields: readonly FieldContract[] }
      export interface EdgeContract { fields: readonly FieldContract[] }
      export interface GraphContract { vertex: readonly VertexContract[]; edge: readonly EdgeContract[] }`)],
    ['src/sql-driver.ts', parsed('src/sql-driver.ts', "export type SqlTransactionKind = 'snapshot' | 'write';")],
    ['src/knowledge/index/page.ts', parsed('src/knowledge/index/page.ts', 'export interface WrittenAt { repository: string; commit: string }')],
    ['src/adapters/database-owner.ts', parsed('src/adapters/database-owner.ts', 'export interface DatabaseOwner { transaction(kind: unknown, work: unknown): void }')],
    ['src/graph/fill-orchestration.ts', parsed('src/graph/fill-orchestration.ts', "import type { DatabaseOwner } from '../adapters/database-owner.js'; export type OrchestratorDatabase = Pick<DatabaseOwner, 'transaction'>;")],
    ['src/graphql/manifest.ts', parsed('src/graphql/manifest.ts', "import type { FieldType } from '../graph/contract.js'; export interface PublishedField { type: FieldType }")],
    [file, module],
  ]);
  return literals(module.tree).filter(node => node['value'] === word).map(node => declarationProtocolLiteral(module, node, modules));
}

describe('declaration-scoped protocol literals', () => {
  test('canonical transaction vocabulary needs actual DatabaseOwner parameter consumption', () => {
    const file = 'src/sql-driver.ts', module = parsed(file, "export type SqlTransactionKind = 'snapshot' | 'write';");
    const ownerFile = 'src/adapters/database-owner.ts';
    const run = (text: string) => {
      const modules = new Map([[file, module], [ownerFile, parsed(ownerFile, text)]]);
      return literals(module.tree).map(node => declarationProtocolLiteral(module, node, modules));
    };
    expect(run("import type { SqlTransactionKind as Mode } from '../sql-driver.js'; export interface DatabaseOwner { transaction(kind: Mode, work: unknown): void }")).toEqual([true, true]);
    expect(run('export interface DatabaseOwner { transaction(kind: string, work: unknown): void }')).toEqual([false, false]);
    expect(run("import type { SqlTransactionKind } from '../counterfeit.js'; export interface DatabaseOwner { transaction(kind: SqlTransactionKind, work: unknown): void }")).toEqual([false, false]);
    expect(run("import type { SqlTransactionKind } from '../sql-driver.js'; export interface DatabaseOwner { transaction(work: unknown, kind: SqlTransactionKind): void }")).toEqual([false, false]);
  });

  test('the registry form requires the indexed alias to read that registry, not just its key', () => {
    const file = 'src/sql-driver.ts', ownerFile = 'src/adapters/database-owner.ts';
    const module = parsed(file, [
      "export const OTHER = { snapshot: 'snapshot', write: 'write' } as const;",
      "export const SQL_TRANSACTION_KINDS = { snapshot: 'snapshot', write: 'write' } as const;",
      'export type SqlTransactionKind = typeof OTHER[keyof typeof SQL_TRANSACTION_KINDS];',
    ].join('\n'));
    const modules = new Map([
      [file, module],
      [ownerFile, parsed(ownerFile, "import type { SqlTransactionKind } from '../sql-driver.js'; export interface DatabaseOwner { transaction(kind: SqlTransactionKind, work: unknown): void }")],
    ]);
    expect(literals(module.tree).map(node => declarationProtocolLiteral(module, node, modules))).toEqual([false, false, false, false]);
  });

  test('typed transaction mode initializer requires its actual owner consumer', () => {
    expect(decisions(`import type { DatabaseOwner } from './adapters/database-owner.js'; import type { SqlTransactionKind } from './sql-driver.js';
      function valid(owner: DatabaseOwner) { const kind: SqlTransactionKind = 'snapshot'; trace(kind); owner.transaction(kind, work); }
      function unused(owner: DatabaseOwner) { const kind: SqlTransactionKind = 'snapshot'; trace(kind); }
      function wrongSlot(owner: DatabaseOwner) { const kind: SqlTransactionKind = 'snapshot'; owner.transaction('write', kind); }
      function plain(owner: { transaction: Function }) { const kind: SqlTransactionKind = 'snapshot'; owner.transaction(kind, work); }
      function shadow(owner: DatabaseOwner) { const kind: SqlTransactionKind = 'snapshot'; ((kind: string) => owner.transaction(kind, work))('other'); }
    `, 'snapshot')).toEqual([true, false, false, false, false]);
    expect(decisions(`import type { DatabaseOwner } from './adapters/database-owner.js'; type SqlTransactionKind = 'snapshot';
      function fake(owner: DatabaseOwner) { const kind: SqlTransactionKind = 'snapshot'; owner.transaction(kind, work); }
    `, 'snapshot')).toEqual([false, false]);
  });

  test('transaction authority follows real owner aliases and nonoverriding intersections', () => {
    expect(decisions(`import type { DatabaseOwner } from './adapters/database-owner.js';
      type Snapshot = Pick<DatabaseOwner, 'transaction'>; type Fill = Snapshot & { readonly graphContract: unknown }; type Orchestrator = Fill;
      function read(database: Orchestrator) { database.transaction('snapshot', work); }
      type PlainOwner = { transaction: Function }; type Fake = Pick<PlainOwner, 'transaction'>;
      function fake(database: Fake) { database.transaction('snapshot', work); }
      type WrongKey = Pick<DatabaseOwner, 'other'>;
      function wrong(database: WrongKey) { database.transaction('snapshot', work); }
      type Override = Snapshot & { transaction: Function };
      function override(database: Override) { database.transaction('snapshot', work); }
      function shadow(database: Orchestrator) { return ((database: PlainOwner) => database.transaction('snapshot', work))(other); }`, 'snapshot')).toEqual([true, false, false, false, false]);
    expect(decisions(`import type { DatabaseOwner } from './adapters/database-owner.js';
      type Pick<T,K> = { transaction: Function }; type Fake = Pick<DatabaseOwner, 'transaction'>;
      function fake(database: Fake) { database.transaction('snapshot', work); }`, 'snapshot')).toEqual([false]);
  });

  test('manifest field and optional storage comparisons prove separate actual authorities', () => {
    const file = 'src/product/manifest/kinds.ts';
    const source = `import type { FieldType } from '../../graph/contract.js'; import type { ValueTypeDeclaration } from '../../graph/value-types.js';
      export interface FieldDecl { type: FieldType }
      function check(field: FieldDecl) { const type: ValueTypeDeclaration | undefined = lookup(); return field.type !== 'json' || type?.storage !== 'json'; }
      function fake(field: { type: string }) { const type: { storage: string } | undefined = lookup(); return field.type !== 'json' || type?.storage !== 'json'; }
      function optional() { const field: FieldDecl | undefined = lookup(); return field?.type === 'json'; }
      function optionalFake() { const field: { type: string } | undefined = lookup(); return field?.type === 'json'; }`;
    const module = parsed(file, source), modules = new Map([[file, module],
      ['src/graph/contract.ts', parsed('src/graph/contract.ts', "export type FieldType = 'text' | 'json';")],
      ['src/graph/value-types.ts', parsed('src/graph/value-types.ts', "import type { FieldType } from './contract.js'; export interface ValueTypeDeclaration { storage: FieldType }")]]);
    expect(literals(module.tree).filter(node => node['value'] === 'json').map(node => declarationProtocolLiteral(module, node, modules))).toEqual([true, true, false, false, true, false]);
    const wrongMember = parsed(file, source.replaceAll('?.storage', '?.other'));
    const wrongModules = new Map(modules); wrongModules.set(file, wrongMember);
    expect(literals(wrongMember.tree).filter(node => node['value'] === 'json').map(node => declarationProtocolLiteral(wrongMember, node, wrongModules))).toEqual([true, false, false, false, true, false]);
    const wrongOperator = parsed(file, source.replaceAll("?.storage !== 'json'", "?.storage > 'json'"));
    const operatorModules = new Map(modules); operatorModules.set(file, wrongOperator);
    expect(literals(wrongOperator.tree).filter(node => node['value'] === 'json').map(node => declarationProtocolLiteral(wrongOperator, node, operatorModules))).toEqual([true, false, false, false, true, false]);
    const loose = parsed(file, source.replace('export interface FieldDecl { type: FieldType }', 'export interface FieldDecl { type: string }'));
    const looseModules = new Map(modules); looseModules.set(file, loose);
    expect(literals(loose.tree).filter(node => node['value'] === 'json').map(node => declarationProtocolLiteral(loose, node, looseModules))).toEqual([false, true, false, false, false, false]);
    const counterfeit = new Map(modules); counterfeit.set('src/graph/value-types.ts', parsed('src/graph/value-types.ts', "export interface Other { storage: 'json' }"));
    expect(literals(module.tree).filter(node => node['value'] === 'json').map(node => declarationProtocolLiteral(module, node, counterfeit))).toEqual([true, false, false, false, true, false]);
  });

  test('Git tree object types occupy only their exact tuple or typed comparison', () => {
    const file = 'src/plugin/repository-snapshot.ts';
    const source = `export const GIT_TREE_OBJECT_TYPES = ['blob', 'commit', 'tree'] as const;
      export type GitTreeObjectType = typeof GIT_TREE_OBJECT_TYPES[number];
      function check() { const type: GitTreeObjectType | undefined = decode(raw); return type !== 'blob'; }
      function counterfeit(type: string) { return type !== 'blob'; }
      const product = 'blob';`;
    expect(decisions(source, 'blob', file)).toEqual([true, true, false, false]);
    expect(decisions(source.replace('typeof GIT_TREE_OBJECT_TYPES[number]', 'typeof OTHER[number]'), 'blob', file)).toEqual([false, false, false, false]);
  });

  test('map callback parameter zero follows its actual typed array receiver', () => {
    expect(decisions(`import type { FieldContract } from './graph/contract.js';
      function check(fields: readonly FieldContract[], plain: readonly { type: string }[]) {
        fields.map(field => field.type === 'text');
        plain.map(field => field.type === 'text');
        fields.map((field, index) => index.type === 'text');
        fields.map(field => ((field: { type: string }) => field.type === 'text')(other));
        ((fields: readonly { type: string }[]) => fields.map(field => field.type === 'text'))(plain);
      }`, 'text')).toEqual([true, false, false, false, false]);
  });

  test('direct FieldType switches and nullable annotated fields retain imported authority', () => {
    expect(decisions(`import type { FieldType, FieldContract } from './graph/contract.js';
      function cast(type: FieldType) { switch (type) { case 'text': return 1; } }
      function fake(type: string) { switch (type) { case 'text': return 1; } }
      function check() { const field: FieldContract | undefined = lookup(); return field.type === 'text'; }`, 'text')).toEqual([true, false, true]);
  });

  test('SourceLanguage values require its imported TypeBox schema authority', () => {
    const file = 'src/server/knowledge.ts', authorityFile = 'src/page-contract/source-response.ts';
    const authority = `import { Type, type Static } from 'typebox'; import { Value } from 'typebox/value';
      export const SOURCE_LANGUAGE_SCHEMA = Type.Union([Type.Literal('json'),Type.Literal('text')]); export type SourceLanguage = Static<typeof SOURCE_LANGUAGE_SCHEMA>;
      export const SOURCE_RESPONSE_SCHEMA = Type.Object({ language: SOURCE_LANGUAGE_SCHEMA });
      export function decodeSourceResponse(value: unknown) { if (!Value.Check(SOURCE_RESPONSE_SCHEMA, value)) { throw new Error(); } return value; }`;
    const source = `import type { SourceLanguage } from '../page-contract/source-response.js';
      const languages: Readonly<Record<string, SourceLanguage>> = { json: 'json' };
      function languageOf(): SourceLanguage { return languages[key] ?? 'json'; }
      function counterfeit(): string { return 'json'; }
      const product = 'json';`;
    const run = (schema: string, input = source): boolean[] => {
      const module = parsed(file, input), modules = new Map([[file, module], [authorityFile, parsed(authorityFile, schema)]]);
      return literals(module.tree).filter(node => node['value'] === 'json').map(node => declarationProtocolLiteral(module, node, modules));
    };
    expect(run(authority)).toEqual([true, true, false, false]);
    const declarationModule = parsed(authorityFile, authority), declarationModules = new Map([[authorityFile, declarationModule]]);
    expect(literals(declarationModule.tree).filter(node => node['value'] === 'json').map(node => declarationProtocolLiteral(declarationModule, node, declarationModules))).toEqual([true]);
    expect(run(authority.replace("from 'typebox'", "from './product.js'"))).toEqual([false, false, false, false]);
    expect(run(authority, source.replace("'../page-contract/source-response.js'", "'./product.js'"))).toEqual([false, false, false, false]);
    expect(run(authority.replace("Type.Literal('json')", "Type.Literal('other')"))).toEqual([false, false, false, false]);
    expect(run(authority.replace('language: SOURCE_LANGUAGE_SCHEMA', 'language: OTHER'))).toEqual([false, false, false, false]);
    expect(run(authority.replace('Value.Check(SOURCE_RESPONSE_SCHEMA, value)', 'Value.Check(OTHER, value)'))).toEqual([false, false, false, false]);
    expect(run(authority.replace('Type.Object({ language: SOURCE_LANGUAGE_SCHEMA })', 'counterfeit({ language: SOURCE_LANGUAGE_SCHEMA })'))).toEqual([false, false, false, false]);
    expect(run(authority.replace('throw new Error();', 'const neverCalled = () => { throw new Error(); };'))).toEqual([false, false, false, false]);
    expect(run(authority.replace('export function decodeSourceResponse(value: unknown) {', 'export function decodeSourceResponse(value: unknown) { return value;'))).toEqual([false, false, false, false]);
    expect(run(authority.replace('export function decodeSourceResponse(value: unknown) {', 'export function decodeSourceResponse(value: unknown) { if (skip) return value;'))).toEqual([false, false, false, false]);
    expect(run(authority.replace("from 'typebox/value'", "from './counterfeit.js'"))).toEqual([false, false, false, false]);
    expect(run(authority.replace('{ Value }', '{ Other as Value }'))).toEqual([false, false, false, false]);
    expect(run(authority.replace('!Value.Check', 'Value.Check'))).toEqual([false, false, false, false]);
    expect(run(authority.replace('throw new Error();', 'report();'))).toEqual([false, false, false, false]);
    expect(run(authority.replace('if (!Value.Check(SOURCE_RESPONSE_SCHEMA, value)) { throw new Error(); }', 'if (!Value.Check(SOURCE_RESPONSE_SCHEMA, value)) { report(); } else { throw new Error(); }'))).toEqual([false, false, false, false]);
    expect(run(authority.replace('export function decodeSourceResponse(value: unknown) {', 'function other(value: unknown) { if (!Value.Check(SOURCE_RESPONSE_SCHEMA, value)) { throw new Error(); } } export function decodeSourceResponse(value: unknown) {').replace('export function decodeSourceResponse(value: unknown) { if (!Value.Check(SOURCE_RESPONSE_SCHEMA, value)) { throw new Error(); }', 'export function decodeSourceResponse(value: unknown) {'))).toEqual([false, false, false, false]);
    expect(run(authority.replace('if (!Value.Check', 'const Value = fake; if (!Value.Check'))).toEqual([false, false, false, false]);
    expect(run(authority, source.replace('function languageOf(): SourceLanguage', 'function languageOf(): string'))).toEqual([true, false, false, false]);
    expect(run(authority, source + ` function shadow() { type SourceLanguage = string; const values: Readonly<Record<string, SourceLanguage>> = { x: 'json' }; }`)).toEqual([true, true, false, false, false]);
  });

  test('FieldType vocabulary follows its exact exported const tuple', () => {
    const file = 'src/check.ts';
    const source = `import type { FieldContract } from './graph/contract.js'; function check(field: FieldContract) { return field.type === 'json'; } const product = 'json';`;
    const run = (authoritySource: string): boolean[] => {
      const module = parsed(file, source), authority = parsed('src/graph/contract.ts', authoritySource);
      const modules = new Map([[file, module], ['src/graph/contract.ts', authority]]);
      return literals(module.tree).filter(node => node['value'] === 'json').map(node => declarationProtocolLiteral(module, node, modules));
    };
    const authority = `export const FIELD_TYPES = ['text', 'json'] as const; export type FieldType = typeof FIELD_TYPES[number]; export interface FieldContract { type: FieldType }`;
    expect(run(authority)).toEqual([true, false]);
    expect(run(authority.replace('typeof FIELD_TYPES[number]', '(typeof FIELD_TYPES)[number]'))).toEqual([true, false]);
    expect(run(authority.replace('typeof FIELD_TYPES[number]', 'typeof OTHER[number]'))).toEqual([false, false]);
    expect(run(authority.replace(' as const', ''))).toEqual([false, false]);
    expect(run(authority.replace('[number]', '[string]'))).toEqual([false, false]);
    expect(run(authority.replace('export const FIELD_TYPES', 'const FIELD_TYPES'))).toEqual([false, false]);
    expect(run(authority.replace('export const FIELD_TYPES', 'export let FIELD_TYPES'))).toEqual([false, false]);
    expect(run(authority.replace("['text', 'json']", "['json', 3]"))).toEqual([false, false]);
    expect(run(authority.replace("['text', 'json']", "['text', ...PRODUCT]"))).toEqual([false, false]);
  });

  test('optional map members follow the actual snapshot form declaration', () => {
    const file = 'src/plugin/repository-snapshot.ts';
    const source = `const SNAPSHOT_ENTRY_FORMS = ['blob', 'commit'] as const;
      type SnapshotEntryForm = (typeof SNAPSHOT_ENTRY_FORMS)[number];
      export interface SnapshotEntry { form: SnapshotEntryForm }
      interface Entry { form: SnapshotEntry['form'] }
      const entries = new Map<string, Entry>();
      const other = new Map<string, { form: string }>();
      const okay = entries.get(path)?.form === 'blob';
      const nope = other.get(path)?.form === 'blob';
      function shadow(Map: unknown) { const local = new Map<string, Entry>(); return local.get(path)?.form === 'blob'; }`;
    expect(decisions(source, 'blob', file)).toEqual([true, true, false, false]);
  });

  test('direct evidence error fields name the typed locator member in argument two', () => {
    const file = 'src/graph/evidence-targets.ts';
    const source = `export type EvidenceLocatorDraft = { type: 'blob'; blob: string } | { type: 'commit'; repository: string };
      export class EvidenceTargetError extends Error {}
      function check(draft: EvidenceLocatorDraft) {
        new EvidenceTargetError('CODE', 'blob', draft.blob);
        new EvidenceTargetError('CODE', 'blob', draft.repository);
        new OtherError('CODE', 'blob', draft.blob);
      }`;
    expect(decisions(source, 'blob', file)).toEqual([false, true, false, false]);
  });

  test('storage validation follows typed Object.entries value bindings and exact union members', () => {
    const file = 'src/graph/value-types.ts';
    const source = `export interface ValueTypeDeclaration { storage: 'text' | 'json' }
      export type ValueTypes = Readonly<Record<string, ValueTypeDeclaration>>;
      function check(types: ValueTypes) { for (const [name, type] of Object.entries(types)) {
        if (!['text', 'json'].includes(type.storage)) throw new Error(name);
        if (!['json'].includes(type.storage)) throw new Error(name);
        if (!['text', 'json', 'product'].includes(type.storage)) throw new Error(name);
      } }
      function fake(types: Record<string, unknown>) { for (const [name, type] of Object.entries(types)) { ['text', 'json'].includes(type.storage); } }`;
    expect(decisions(source, 'json', file)).toEqual([false, true, false, false, false]);
    expect(decisions(source.replace('Object.entries(types)', 'other.entries(types)'), 'json', file)).toEqual([false, false, false, false, false]);
    expect(decisions(source.replace('storage:', 'other:'), 'json', file)).toEqual([false, false, false, false, false]);
  });

  test('page format guards prove the tuple enum and validator consumer', () => {
    const schemaFile = 'src/page-contract/schema.ts', file = 'wiki/app/src/components/table.tsx';
    const schema = `const FORMATS = ['text', 'repository'] as const;
      export type FieldFormat = (typeof FORMATS)[number];
      export function isFieldFormat(value: unknown): value is FieldFormat { return typeof value === 'string' && FORMATS.some(format => format === value); }
      export const COMPONENT_SCHEMAS = { table: { parameters: { format: { enum: FORMATS } } } };
      export function parametersSchema(component: string) { const held = COMPONENT_SCHEMAS[component]; return { properties: held.parameters }; }`;
    const source = `import { isFieldFormat } from '../../../../src/page-contract/schema.js';
      function cell(column: { format?: unknown }) { const format = isFieldFormat(column.format) ? column.format : 'text'; return format === 'repository'; }
      const product = 'repository';`;
    const reader = `import { parametersSchema } from './schema.js'; import { validateNode } from './validate.js'; validateNode(text, node, parametersSchema(component));`;
    const run = (schemaSource: string, readerSource = reader, input = source): boolean[] => {
      const module = parsed(file, input), authority = parsed(schemaFile, schemaSource);
      const modules = new Map([[file, module], [schemaFile, authority],
        ['src/page-contract/template.ts', parsed('src/page-contract/template.ts', readerSource)],
        ['src/page-contract/validate.ts', parsed('src/page-contract/validate.ts', 'export function validateNode(text: unknown, node: unknown, schema: unknown) {}')]]);
      return literals(module.tree).filter(node => node['value'] === 'repository').map(node => declarationProtocolLiteral(module, node, modules));
    };
    expect(run(schema)).toEqual([true, false]);
    expect(run(schema.replace('format === value', 'format !== value'))).toEqual([false, false]);
    expect(run(schema.replace('enum: FORMATS', 'enum: OTHER'))).toEqual([false, false]);
    expect(run(schema, reader.replace("'./validate.js'", "'./counterfeit.js'"))).toEqual([false, false]);
    expect(run(schema, reader, source.replace("'../../../../src/page-contract/schema.js'", "'./product.js'"))).toEqual([false, false]);
  });

  test('transaction conditional modes retain the exact owner argument boundary', () => {
    expect(decisions(`import type { DatabaseOwner } from './adapters/database-owner.js';
      function read(owner: DatabaseOwner) {
        owner.transaction(writing ? 'write' : 'snapshot', work);
        owner.transaction(work, writing ? 'write' : 'snapshot');
        owner.transaction(writing ? unrelated('snapshot') : 'write', work);
      }`, 'snapshot')).toEqual([true, false, false]);
  });
  test('typed GraphCondition switches use the real exported union', () => {
    const file = 'src/knowledge/graph-verdict-rules.ts';
    expect(decisions(`export type GraphCondition = { type: 'target' };
      function check(condition: GraphCondition) { switch (condition.type) { case 'target': return true; } }
      function other(condition: { type: string }) { switch (condition.type) { case 'target': return true; } }`, 'target', file)).toEqual([false, true, false]);
  });
  test('locator object arguments follow the actual parameter indexed declaration', () => {
    const file = 'src/graph/evidence-targets.ts';
    const source = `export type EvidenceTarget = { locator: { type: 'commit' | 'blob' } };
      function resolved(row: unknown, locator: EvidenceTarget['locator']) {}
      resolved(row, { type: 'blob' }); resolved({ type: 'blob' }, row);
      function unrelated(row: unknown, locator: { type: string }) {}
      unrelated(row, { type: 'blob' });`;
    expect(decisions(source, 'blob', file)).toEqual([false, true, false, false]);
  });

  test('nested GraphCondition objects follow exact contextual declaration slots', () => {
    const file = 'src/knowledge/graph-verdict-rules.ts';
    const declarations = `export type GraphCondition = { type: 'target'; then: GraphCondition } | { type: 'not'; of: GraphCondition } | { type: 'all'; of: readonly GraphCondition[] };
      export interface GraphEscalation { when: GraphCondition }
      export interface GraphNodeRule { escalate: readonly GraphEscalation[] }`;
    const source = `${declarations}
      const rules: readonly GraphNodeRule[] = [{ escalate: [{ when: { type: 'not', of: { type: 'target', then: { type: 'all', of: [{ type: 'target' }] } } } }] }];
      const unrelated = { type: 'target' };
      const wrong: readonly GraphNodeRule[] = factory(() => ({ type: 'target' }));
      const wrongArray: readonly GraphNodeRule[] = [{ escalate: [{ when: { type: 'not', of: [{ type: 'target' }] } }] }];`;
    expect(decisions(source, 'target', file)).toEqual([false, true, true, false, false, false]);
    expect(decisions(source.replace('when: GraphCondition', 'when: unknown'), 'target', file)).toEqual([false, false, false, false, false, false]);
  });

  test('snapshot forms require the tuple-to-exported-form declaration chain', () => {
    const file = 'src/plugin/repository-snapshot.ts';
    const source = `const SNAPSHOT_ENTRY_FORMS = ['blob', 'commit', 'link'] as const;
      type SnapshotEntryForm = (typeof SNAPSHOT_ENTRY_FORMS)[number];
      export interface SnapshotEntry { form: SnapshotEntryForm }
      const FORM_OF_MODE: Readonly<Record<string, SnapshotEntryForm>> = { file: 'blob' };
      function read(entry: SnapshotEntry) { return entry.form === 'blob' }
      function fake(entry: { form: string }) { return entry.form === 'blob' }
      const other = 'blob';`;
    expect(decisions(source, 'blob', file)).toEqual([true, true, true, false, false]);
    expect(decisions(source.replace('form: SnapshotEntryForm', 'form: string'), 'blob', file)).toEqual([false, false, false, false, false]);
  });
  test('evidence diagnostics name only the actual draft member checked by a proven assertion', () => {
    const source = `export type EvidenceLocatorDraft = { type: 'blob'; blob: string } | { type: 'file'; repository: string };
      export class EvidenceTargetError extends Error { constructor(code: string, field: string, value: unknown) { super(field) } }
      function text(value: unknown, field: string): asserts value is string { if (typeof value !== 'string') throw new EvidenceTargetError('invalid', field, value) }
      function check(draft: EvidenceLocatorDraft) { text(draft.blob, 'blob'); text(draft.repository, 'blob'); }`;
    expect(decisions(source, 'blob', 'src/graph/evidence-targets.ts').slice(-2)).toEqual([true, false]);
    expect(decisions(source.replace('asserts value is string', 'void'), 'blob', 'src/graph/evidence-targets.ts').slice(-2)).toEqual([false, false]);
  });
  test('mapped validator keys require the imported WrittenAt declaration and optional unknown values', () => {
    const source = `import type { WrittenAt as At } from './knowledge/index/page.js';
      function check(entry: unknown) {
        const record = entry as { readonly [Field in keyof At]?: unknown };
        return record['repository'];
      }`;
    expect(decisions(source, 'repository')).toEqual([true]);
    expect(decisions(source.replace('WrittenAt as At', 'Other as At'), 'repository')).toEqual([false]);
    expect(decisions(source.replace(']?: unknown', ']: unknown'), 'repository')).toEqual([false]);
    expect(decisions(source.replace("record['repository']", "record['missing']"), 'missing')).toEqual([false]);
  });
  test('Git merge command occupies only the argv slot of a proven execFile adapter', () => {
    const source = `import { execFile as execute } from 'node:child_process';
      function git(folder: string, args: string[]) { execute('git', args, { cwd: folder }, done) }
      function refresh() { git(folder, ['merge', '--ff-only']); git(folder, ['status', 'merge']); }
      function fake(git: Function) { git(folder, ['merge']); }`;
    expect(decisions(source, 'merge', 'src/product/own-wiki.ts')).toEqual([true, false, false]);
    expect(decisions(source.replace('node:child_process', './fake.js'), 'merge', 'src/product/own-wiki.ts')).toEqual([false, false, false]);
  });
  test('field declaration words occupy only their exact type slot', () => {
    expect(decisions(`export interface FieldDecl { type: 'text' | 'integer'; name: 'text' }
      export interface Unrelated { type: 'text' }
      export interface PluginFieldDecl { type: FieldDecl['type'] }`, 'text', 'src/product/manifest/kinds.ts')).toEqual([true, false, false]);
    expect(decisions(`export interface FieldDecl { type: 'text' }
      export interface PluginFieldDecl { type: FieldDecl['type']; other: FieldDecl['type'] }`, 'type', 'src/product/manifest/kinds.ts')).toEqual([true, false]);
  });
  test('PublishedField comparisons follow imported authority and lexical bindings across closures', () => {
    expect(decisions(`import type { PublishedField as Field } from './graphql/manifest.js';
      function check(field: Field) {
        const closed = () => field.type === 'text';
        const shadowed = (field: { type: string }) => field.type === 'text';
        return field.type === 'text';
      }`, 'text')).toEqual([true, false, true]);
    expect(decisions(`import type { Other as PublishedField } from './graphql/manifest.js';
      function check(field: PublishedField) { return field.type === 'text' }`, 'text')).toEqual([false]);
    expect(decisions(`import type { PublishedField } from './foreign.js';
      function check(field: PublishedField) { return field.type === 'text' }`, 'text')).toEqual([false]);
  });
  test('for-of field comparisons follow typed collection members and reject shadow loops', () => {
    expect(decisions(`import type { GraphContract } from './graph/contract.js';
      function check(contract: GraphContract) {
        for (const kind of [...contract.vertex, ...contract.edge]) {
          for (const field of kind.fields) {
            if (field.type === 'text') return true;
            const nested = () => field.type === 'text';
            for (const field of untyped) { if (field.type === 'text') return false; }
          }
        }
      }`, 'text')).toEqual([true, true, false]);
  });
  test('missing annotations cannot establish field or transaction authority', () => {
    expect(decisions(`function check(field) { return field.type === 'text' }
      const fields = [{ type: 'text' }];`, 'text')).toEqual([false, false]);
    expect(decisions(`function read(database) { database.transaction('snapshot', work) }
      class Reader { constructor(private owner) {} read() { this.owner.transaction('snapshot', work) } }`, 'snapshot')).toEqual([false, false]);
  });
  test('transaction modes require owner authority and argument zero', () => {
    expect(decisions(`import type { OrchestratorDatabase as Database } from './graph/fill-orchestration.js';
      function read(database: Database) {
        database.transaction('snapshot', work);
        database.transaction(work, 'snapshot');
        const shadowed = (database: { transaction: Function }) => database.transaction('snapshot', work);
      }`, 'snapshot')).toEqual([true, false, false]);
    expect(decisions(`import type { Missing as OrchestratorDatabase } from './graph/fill-orchestration.js';
      function read(database: OrchestratorDatabase) { database.transaction('snapshot', work) }`, 'snapshot')).toEqual([false]);
  });
  test('this.owner needs an owner-typed property on its own lexical class', () => {
    expect(decisions(`import type { DatabaseOwner as Owner } from './adapters/database-owner.js';
      class Reader {
        constructor(private readonly owner: Owner) {}
        read() {
          this.owner.transaction('snapshot', work);
          const arrow = () => this.owner.transaction('snapshot', work);
          function detached() { this.owner.transaction('snapshot', work) }
        }
      }
      class Fake { constructor(private owner: unknown) {} read() { this.owner.transaction('snapshot', work) } }`, 'snapshot')).toEqual([true, true, false, false]);
  });
});
