import { testHostBinding } from './host-binding-fixture.js';
import { expect, test } from 'bun:test';
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import { stringify } from 'yaml';
import { checkValueTypes, compileValueSchema, fitsValueSchema, JSON_DIALECT, type ValueTypes } from '../src/graph/value-types.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { createTestDatabaseOwner } from './test-database.js';

const types: ValueTypes = {
  email: { storage: 'text', schema: { $schema: JSON_DIALECT, $id: 'urn:test:email:1', type: 'string', format: 'email' } },
};
const schema = { $schema: JSON_DIALECT, type: 'object', properties: { email: { $ref: 'urn:test:email:1' } }, required: ['email'], additionalProperties: false };

test('0039: offline 2020-12 refs, formats and strict schema installation', () => {
  checkValueTypes(types);
  expect(() => compileValueSchema({ $vocabulary: { 'urn:unsupported:vocab': true } }, types)).toThrow('unsupported vocabulary');
  const check = compileValueSchema(schema, types);
  expect(check({ email: 'person@example.org' })).toBe(true);
  expect(check({ email: 'not an email' })).toBe(false);
  expect(check({ email: 'person@example.org', extra: 1 })).toBe(false);
  expect(() => compileValueSchema({ $ref: 'https://example.org/missing' }, types)).toThrow();
  expect(() => compileValueSchema({ type: 'string', format: 'invented' }, types)).toThrow();
  expect(() => compileValueSchema({ type: 'string', unknownKeyword: true }, types)).toThrow();
  expect(() => compileValueSchema({ type: 'string', pattern: '^x$' }, types)).toThrow();
  const sets: ValueTypes = { state: { storage: 'text', schema: { $schema: JSON_DIALECT, $id: 'urn:test:state:1', type: 'string', enum: ['open', 'closed'] } } };
  checkValueTypes(sets);
  const state = compileValueSchema(sets.state!.schema, sets);
  expect(state('open')).toBe(true);
  expect(state('unknown')).toBe(false);
  expect(compileValueSchema({ type: 'object', properties: { pattern: { type: 'string' } } })({ pattern: 'literal' })).toBe(true);
  expect(() => checkValueTypes({ other: { storage: 'text', schema: { type: 'string' } } })).toThrow();
});

function manifest(fields: unknown[]) {
  return parseKinds(stringify({ 'value-types': types, kinds: { sample: { source: 'graph', fields } } }), '/tmp/sample/madarch/catalog.yaml', '/tmp/sample');
}
test('0039: field type and JSON schema refusal retain source location', () => {
  for (const field of [{ name: 'missing' }, { name: 'data', type: 'json' }, { name: 'data', type: 'json', schema: { type: 'object' } }]) {
    const read = manifest([field]);
    expect(read.findings.some((finding) => finding.message.includes('type') || finding.message.includes('schema'))).toBe(true);
    expect(read.findings.every((finding) => finding.file.startsWith('/') && finding.line > 0)).toBe(true);
  }
  const read = manifest([{ name: 'email', type: 'email' }, { name: 'data', type: 'json', schema }]);
  const contract = graphContractOf(read);
  expect(contract.vertex[0]?.fields[0]?.valueType).toBe('email');
  expect(contract.vertex[0]?.fields[1]?.schema).toEqual(schema);
});

test('0039: invalid vertex, key and edge values fail before any SQL', async () => {
  let calls = 0;
  const contract: GraphContract = { valueTypes: types, vertex: [{ name: 'sample', table: generatedTableName('sample', 'vertex'), key: ['email'], fields: [{ name: 'email', type: 'text', valueType: 'email' }, { name: 'data', type: 'json', schema }], capability: 'test' }], edge: [{ name: 'link', cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'links', in: 'linked' }, ru: { out: 'links', in: 'linked' } }, capability: 'test', from: ['sample'], to: ['sample'], repeats: false, fields: [{ name: 'email', type: 'text', valueType: 'email' }] }], dictionary: [] };
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const binding = await testHostBinding(owner, contract, 'test');
    await owner.transaction('write', async tx => {
      const executor = tx;
      executor.query = async () => { calls++; throw new Error('SQL must not run'); };
      const base = { kind: 'sample', key: { email: 'person@example.org' }, producer: 'test', producerVersion: '1' };
      for (const draft of [{ ...base, key: { email: 'bad' } }, { ...base, values: { data: { email: 'bad' } } }]) {
        await expect(publishGraphDrafts(executor, contract, { vertices: [draft], removals: [] }, 1, { binding })).rejects.toThrow('VALUE_TYPE_MISMATCH');
      }
      await expect(publishGraphDrafts(executor, contract, { vertices: [], edges: [{ kind: 'link', from: { kind: 'sample', key: base.key }, to: { kind: 'sample', key: base.key }, values: { email: 'bad' }, producer: 'test', producerVersion: '1' }], removals: [] }, 1, { binding })).rejects.toThrow('VALUE_TYPE_MISMATCH');
      expect(calls).toBe(0);
    });
  } finally { await owner.close(); }
});

test('0039: catalogue formats and JSON structures are executable, not labels', () => {
  const library = (Bun.YAML.parse(CATALOG_FILES['catalog.yaml']!) as { 'value-types': ValueTypes })['value-types'];
  checkValueTypes(library);
  for (const [name, good, bad] of [
    ['email', 'reader@example.org', 'missing-at'],
    ['ipv4', '192.0.2.1', '999.1.1.1'],
    ['ipv6', '2001:db8::1', 'not-ip'],
    ['url', 'https://example.org/path', 'not-url'],
    ['path', 'src/file.ts', ''],
    ['port', 443, 65536],
    ['date', '2026-11-15', '2026-02-30'],
    ['class-diagram-level', 'code', 'other'],
    ['bigint', '9007199254740993', '01'],
  ] as const) {
    const validate = compileValueSchema(library[name]!.schema, library);
    expect(validate(good)).toBe(true);
    expect(validate(bad)).toBe(false);
  }
});

test('0039: Git remotes and recorded identities keep producer values', () => {
  const library = (Bun.YAML.parse(CATALOG_FILES['catalog.yaml']!) as { 'value-types': ValueTypes })['value-types'];
  const remote = compileValueSchema(library['git-remote']!.schema, library);
  for (const value of ['git@example.org:team/repo.git', 'example.org:repo.git', '/srv/git/repo.git', '../repo.git', './repo:with-colon', 'file:///srv/git/repo.git', 'ssh://git@example.org/team/repo.git', 'remote\nname', 'helper::address']) {
    expect(remote(value)).toBe(true);
  }
  expect(remote('')).toBe(true);
  expect(remote('repo\u0000path')).toBe(false);
  const identity = compileValueSchema(library['recorded-identity']!.schema, library);
  for (const value of ['', 'not an email', 'name@', 'Name <missing-at>', 'escaped\\xff', 'identity\u0000name']) {
    expect(identity(value)).toBe(true);
  }
  expect(identity(7)).toBe(false);
  const personEmail = compileValueSchema(library.email!.schema, library);
  expect(personEmail('not an email')).toBe(false);
  expect(personEmail('')).toBe(false);
  for (const [path, fieldName, expectedType] of [
    ['code/structure/code.repository.yaml', 'url', 'git-remote'],
    ['history/work/code.author.yaml', 'name', 'recorded-identity'],
    ['history/work/code.author.yaml', 'email', 'recorded-identity'],
  ] as const) {
    const kind = Bun.YAML.parse(CATALOG_FILES[path]!) as { fields: { name: string; type: string }[] };
    expect(kind.fields.find((field) => field.name === fieldName)?.type).toBe(expectedType);
  }
});

test('0039: validation results and malformed registry boundaries are explicit', () => {
  expect(fitsValueSchema(schema, types, { email: 'reader@example.org' })).toBe(true);
  expect(fitsValueSchema(schema, types, { email: 'bad' })).toBe(false);
  expect(fitsValueSchema(schema, types, { email: 'reader@example.org' })).toBe(true);
  for (const value of [null, [], { bad: null }, { bad: { storage: 'other', schema: {} } }, { bad: { storage: 'text', schema: { $schema: JSON_DIALECT } } }, { bad: { storage: 'text', schema: { $schema: JSON_DIALECT, $id: 7 } } }]) {
    expect(() => checkValueTypes(value as unknown as ValueTypes)).toThrow();
  }
  expect(() => checkValueTypes({ a: types.email!, b: { ...types.email!, schema: { ...types.email!.schema } } })).toThrow('duplicate schema id');
  expect(() => checkValueTypes({ bad: { storage: 'text', schema: { $schema: JSON_DIALECT, $id: 'urn:test:bad', type: 'invalid' } } })).toThrow();
  expect(() => compileValueSchema({ $vocabulary: { 'urn:unsupported': false } })).toThrow('unsupported vocabulary');
});
