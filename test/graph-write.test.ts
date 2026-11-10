/**
 * The graph's one writer (decision 0035, items 6 and 7; the amendment of 2026-11-10): the contract a manifest's field
 * bindings make, and the rows a producer's answer becomes — a vertex with its key, one opinion of the kind's fields per
 * producer, a rerun that writes nothing, a changed value that closes the old opinion and opens a new one, and a removal
 * that takes the entity out of the reads.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { manifestContractOf } from '../src/fill/stages/plugin-contract.js';
import { parseKinds } from '../src/knowledge/kinds.js';
import { createTestDatabaseOwner } from './test-database.js';
import { publishGraphWrites } from '../src/graph/claims.js';
import type { GraphContract } from '../src/graph/contract.js';
import { producerEntities } from '../src/graph/plugin-turns.js';
import type { VertexDraft } from '../src/graph/contract.js';
import { GraphReader } from '../src/knowledge/graph-read.js';

const HASH = 'a'.repeat(64);
const root = mkdtempSync(join(tmpdir(), 'madarch-graph-write-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A product holding a manifest, a plugin's contract and its lock, as a product made by `madarch new` does. */
function product(): string {
  const folder = mkdtempSync(join(root, 'product-'));
  mkdirSync(join(folder, 'templates'), { recursive: true });
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  mkdirSync(join(folder, 'plugins', 'glossary'), { recursive: true });
  writeFileSync(join(folder, 'templates', 't.liquid'), '{% block lead %}{% endblock %}\n');
  writeFileSync(join(folder, 'plugins', 'glossary', 'contract.json'), JSON.stringify({
    id: 'glossary', version: '1.0.0',
    outputs: { vertices: [{ kind: 'doc.term', key: ['name'], fields: [
      { name: 'name', claim: 'authoritative', type: 'text', meaning: 'the term', example: 'Fill', required: true },
      { name: 'definition', claim: 'claimed', type: 'text', meaning: 'what it means', example: 'a run', required: true },
    ] }], edges: [] },
  }));
  writeFileSync(join(folder, 'madarch', 'plugins.lock'), `plugins:\n  - { id: glossary, version: 1.0.0, closure: ${HASH}, path: plugins/glossary }\n`);
  writeFileSync(join(folder, 'madarch', 'kinds.yaml'), [
    'kinds:',
    '  doc.term:',
    '    template: templates/t.liquid',
    '    source: document',
    '    terms: ["**/glossary*.md"]',
    '    semantics: term',
    '    fields:',
    '      - { name: name, type: text, binding: "glossary@1.name" }',
    '      - { name: definition, type: text, binding: "glossary@1.definition" }',
    '    key: [name]',
    'plugins:',
    '  - { id: glossary, version: 1, path: plugins/glossary, inputs: [doc.term], outputs: [doc.term], closure: [plugins/glossary/contract.json] }',
    '',
  ].join('\n'));
  return folder;
}

let owner: DatabaseOwner;
let contract: GraphContract;

beforeAll(async () => {
  const folder = product();
  const read = parseKinds(await Bun.file(join(folder, 'madarch', 'kinds.yaml')).text(), 'madarch/kinds.yaml', folder);
  expect(read.findings).toEqual([]);
  contract = manifestContractOf(read);
  owner = await createTestDatabaseOwner();
  await createOneGraphSchema(owner, contract);
});

afterAll(async () => { await owner.close(); });

/** One term as the plugin answers it. */
function term(name: string, definition: string): VertexDraft {
  return {
    kind: 'doc.term', key: { name },
    claims: [{ field: 'definition', value: definition, evidence: { repository: 'madarch', commit: 'c0ffee', path: 'docs/glossary.md', lineStart: 3, lineEnd: 4 } }],
    producer: 'glossary', producerVersion: '1.0.0',
  };
}

describe('the manifest makes the table and the writer fills it', () => {
  test('the kind has a column for every field it states and none for its key', async () => {
    expect(contract.vertex.map((kind) => kind.name)).toEqual(['doc.term']);
    // The key is the vertex's; the fields are the columns of the opinion table, claimed ones included.
    expect(contract.vertex[0]?.fields.map((field) => field.name)).toEqual(['name', 'definition']);
    expect(contract.vertex[0]?.key).toEqual(['name']);
  });

  test('a vertex is published with its opinion and its evidence, and a rerun writes nothing', async () => {
    const writes = [{ kind: 'vertex', evidence: 'docs/glossary.md', value: term('Fill', 'one run') }];
    const first = await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, writes));
    const second = await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, writes));
    expect(first).toBe(2);
    expect(second).toBe(0);
    const table = contract.vertex[0]!.table;
    const opinions = await owner.transaction('snapshot', async (tx) => await tx.query<{ said_by: string; state: string; definition: string; evidence: readonly Record<string, unknown>[] }>(`SELECT said_by, state, definition, evidence FROM ${table}`));
    expect(opinions.rows).toHaveLength(1);
    expect(opinions.rows[0]).toMatchObject({ said_by: 'glossary@1.0.0', state: 'open', definition: 'one run' });
    expect(opinions.rows[0]?.evidence).toEqual([{ repository: 'madarch', commit_or_digest: 'c0ffee', path: 'docs/glossary.md', line_start: 3, line_end: 4 }]);
    // The key is the vertex's, once, and no opinion repeats it.
    const nodes = await owner.transaction('snapshot', async (tx) => await tx.query<{ key: unknown }>('SELECT key FROM node'));
    expect(nodes.rows.map((row) => row.key)).toEqual([{ name: 'Fill' }]);
    expect(await producerEntities(owner, contract, 'doc.term', 'glossary')).toEqual([{ key: { name: 'Fill' }, path: 'docs/glossary.md' }]);
  });

  test('a changed value closes the producer\'s open opinion and opens a new one', async () => {
    const table = contract.vertex[0]!.table;
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'docs/glossary.md', value: term('Fill', 'two runs') }]));
    const opinions = await owner.transaction('snapshot', async (tx) => await tx.query<{ state: string; definition: string }>(`SELECT state, definition FROM ${table} ORDER BY id`));
    expect(opinions.rows).toEqual([{ state: 'closed', definition: 'one run' }, { state: 'open', definition: 'two runs' }]);
  });

  test('a removal closes the producer\'s opinions, takes the entity out of the reads and keeps its history', async () => {
    const table = contract.vertex[0]!.table;
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex-removal', evidence: 'docs/glossary.md', value: { kind: 'doc.term', key: { name: 'Fill' }, producer: 'glossary' } }]));
    const open = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} o JOIN node n ON n.id = o.node_id WHERE o.state = 'open' AND NOT n.removed`));
    expect(open.rows[0]?.n).toBe('0');
    const held = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`));
    expect(held.rows[0]?.n).toBe('2');
    expect(await producerEntities(owner, contract, 'doc.term', 'glossary')).toEqual([]);
  });

  test('a second producer states its own opinion of the same vertex beside the first', async () => {
    const table = contract.vertex[0]!.table;
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'docs/other.md', value: { ...term('Fill', 'the one run'), producer: 'other', producerVersion: '2.1.0' } }]));
    const opinions = await owner.transaction('snapshot', async (tx) => await tx.query<{ said_by: string; state: string; definition: string }>(`SELECT said_by, state, definition FROM ${table} WHERE state = 'open' ORDER BY said_by`));
    expect(opinions.rows).toEqual([{ said_by: 'other@2.1.0', state: 'open', definition: 'the one run' }]);
  });

  test('a field two producers disagree on shows every value with its source, never one picked silently', async () => {
    // A term of its own, so the earlier cases' opinions do not stand beside this one's.
    const table = contract.vertex[0]!.table;
    const vertex = (producer: string, definition: string): VertexDraft => ({
      kind: 'doc.term', key: { name: 'Run' },
      claims: [{ field: 'definition', value: definition, evidence: { repository: 'madarch', commit: 'c0ffee', path: 'docs/glossary.md', lineStart: 1, lineEnd: 2 } }],
      producer, producerVersion: '1.0.0',
    });
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [
      { kind: 'vertex', evidence: 'docs/glossary.md', value: vertex('glossary', 'one run') },
      { kind: 'vertex', evidence: 'docs/glossary.md', value: vertex('other', 'the run') },
    ]));
    const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, undefined, new Map([['doc.term', { kind: 'doc.term', table, columns: ['definition'], types: { definition: 'text' }, key: ['name'] }]]));
    const [entity] = await reader.find('doc.term:Run');
    if (entity === undefined) throw new Error('the term was not read');
    // Several open opinions: every value stands, and each carries the opinion that stated it.
    expect(entity.properties['definition']).toEqual(['one run', 'the run']);
    expect((entity.evidence ?? []).map((one) => [one.field, one.saidBy, one.path]).sort()).toEqual([
      ['definition', 'glossary@1.0.0', 'docs/glossary.md'],
      ['definition', 'other@1.0.0', 'docs/glossary.md'],
    ]);
    // One open opinion standing is its value itself, never a list of one: the glossary's opinion of Fill was closed
    // when the term was removed, and the second producer's stands alone.
    const [fill] = await reader.list('doc.term', { limit: 20 }).then((page) => page.rows.filter((one) => one.label === 'Fill'));
    expect(fill?.properties['definition']).toBe('the one run');
  });

  test('a kind the contract does not declare is refused by the writer, naming it', async () => {
    await expect(owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'x', value: { ...term('x', 'y'), kind: 'doc.other' } }]))).rejects.toThrow(/doc.other/);
  });
});
