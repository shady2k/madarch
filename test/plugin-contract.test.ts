/**
 * The contract a manifest's field bindings make (decision 0035, items 17 and 18): the columns a kind's table gets, the
 * fields that name a producer, the agent's own binding, and the types a reader reads.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { declaredKindReads, manifestContractOf } from '../src/fill/stages/plugin-contract.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-plugin-contract-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A product holding a manifest text, a plugin contract and its lock. */
function product(manifest: string, contract?: unknown): string {
  const folder = mkdtempSync(join(root, 'p-'));
  mkdirSync(join(folder, 'templates'), { recursive: true });
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  mkdirSync(join(folder, 'plugins', 'g'), { recursive: true });
  writeFileSync(join(folder, 'templates', 't.liquid'), '{% block lead %}{% endblock %}\n');
  if (contract !== undefined) writeFileSync(join(folder, 'plugins', 'g', 'contract.json'), JSON.stringify(contract));
  writeFileSync(join(folder, 'madarch', 'plugins.lock'), `plugins:\n  - { id: g, version: 1.0.0, closure: ${'a'.repeat(64)}, path: plugins/g }\n`);
  writeFileSync(join(folder, 'madarch', 'kinds.yaml'), manifest);
  return folder;
}

const CONTRACT = {
  id: 'g', version: '1.0.0',
  reads: 'whole-graph',
  outputs: { vertices: [{ kind: 'doc.term', key: ['name'], fields: [
    { name: 'name', type: 'text', meaning: 'the term', example: 'x', required: true },
    { name: 'definition', type: 'text', meaning: 'what it means', example: 'y', required: true, evidence: true },
    { name: 'rank', type: 'integer', meaning: 'its place', example: 1, required: false },
  ] }], edges: [] },
};

const MANIFEST = [
  'kinds:',
  '  doc.term:',
  '    template: templates/t.liquid',
  '    source: document',
  '    origin: person',
  '    terms: ["**/glossary*.md"]',
  '    semantics: term',
  '    fields:',
  '      - { name: name, type: text, binding: "g@1.name" }',
  '      - { name: definition, type: text, binding: "g@1.definition" }',
  '      - { name: rank, type: integer, nullable: true, binding: "g@1.rank" }',
  '      - { name: note, type: text, nullable: true, binding: { agent: "the note a person writes" } }',
  '      - { name: strict, type: text, binding: { agent: "a word the agent settles" } }',
  '    key: [name]',
  '    derives-from: []',
  'plugins:',
  '  - { id: g, version: 1, path: plugins/g, inputs: [doc.term], outputs: [doc.term], closure: [plugins/g/contract.json] }',
  '',
].join('\n');

describe('a kind\'s table comes from the manifest', () => {
  test('every field the manifest binds is a column of the opinion table, and the key is the vertex\'s alone', () => {
    const folder = product(MANIFEST, CONTRACT);
    const read = parseKinds(MANIFEST, 'madarch/kinds.yaml', folder);
    expect(read.findings).toEqual([]);
    const contract = manifestContractOf(read);
    expect(contract.vertex.map((kind) => kind.name)).toEqual(['doc.term']);
    // A3 of the 2026-11-10 amendment: no field is authoritative, so every bound field — a plugin's and the agent's
    // own included — is a column of the kind's opinion table; the key is the vertex's, never a column.
    expect(contract.vertex[0]?.fields.map((field) => field.name)).toEqual(['name', 'definition', 'rank', 'note', 'strict']);
    expect(contract.vertex[0]?.key).toEqual(['name']);
    expect(contract.vertex[0]?.capability).toBe('g');
    // The path index an evidence row names stands in the mechanism (`src/graph/one-graph.ts`), not in the contract a
    // manifest's bindings make.
    expect(contract.dictionary).toEqual([]);
  });

  test('a plugin contract states what it reads and which fields must carry evidence', () => {
    const folder = product(MANIFEST, CONTRACT);
    const read = parseKinds(MANIFEST, 'madarch/kinds.yaml', folder);
    const contract = read.plugins?.get('g')?.contract;
    expect(contract?.reads).toBe('whole-graph');
    expect(contract?.vertices[0]?.fields.find((field): boolean => field.name === 'definition')?.evidence).toBe(true);
    expect(contract?.vertices[0]?.fields.find((field): boolean => field.name === 'rank')?.evidence).toBeUndefined();
  });

  test('a reader knows the columns, their types and the key of a kind the manifest makes', () => {
    const folder = product(MANIFEST, CONTRACT);
    const read = parseKinds(MANIFEST, 'madarch/kinds.yaml', folder);
    const reads = declaredKindReads(read);
    expect(reads.get('doc.term')?.columns).toEqual(['definition', 'rank', 'note', 'strict']);
    expect(reads.get('doc.term')?.types).toMatchObject({ definition: 'text', rank: 'integer', note: 'text', strict: 'text' });
    expect(reads.get('doc.term')?.key).toEqual(['name']);
  });

  test('a kind with no key is a kind of random identities, and a kind whose plugin the manifest does not hold makes no table', () => {
    // A keyless kind gets its table: its entities stand by a random identity (the amendment, point 2), and no key
    // field constrains it.
    const noKey = MANIFEST.replace('    key: [name]\n', '');
    const folder = product(noKey, CONTRACT);
    const read = parseKinds(noKey, 'madarch/kinds.yaml', folder);
    expect(manifestContractOf(read).vertex.map((kind) => [kind.name, kind.key])).toEqual([['doc.term', []]]);
    expect(declaredKindReads(read).get('doc.term')?.key).toEqual([]);
    // A kind whose only plugin the manifest does not hold names no producer for its key, and makes no table.
    const noPlugin = MANIFEST.replace("  - { id: g, version: 1, path: plugins/g, inputs: [doc.term], outputs: [doc.term], closure: [plugins/g/contract.json] }\n", '');
    const other = product(noPlugin, CONTRACT);
    const readOther = parseKinds(noPlugin, 'madarch/kinds.yaml', other);
    expect(manifestContractOf(readOther).vertex).toEqual([]);
    expect(declaredKindReads(readOther).size).toBe(0);
  });
});
