/**
 * The graph's one writer (decision 0035, items 6 and 7): the contract a manifest's field bindings make, and the rows a
 * producer's answer becomes — a vertex with its key and columns, claims kept beside older ones, one evidence row each,
 * a rerun that writes nothing, and an entity a removal takes out of the reads.
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
  test('the kind has a column for its key and none for its claimed field', async () => {
    expect(contract.vertex.map((kind) => kind.name)).toEqual(['doc.term']);
    expect(contract.vertex[0]?.fields.map((field) => field.name)).toEqual(['name']);
    expect(contract.vertex[0]?.key).toEqual(['name']);
  });

  test('a vertex is published with its claim and its evidence, and a rerun writes nothing', async () => {
    const writes = [{ kind: 'vertex', evidence: 'docs/glossary.md', value: term('Fill', 'one run') }];
    const first = await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, writes));
    const second = await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, writes));
    expect(first).toBe(2);
    expect(second).toBe(0);
    const claims = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM claim'));
    expect(claims.rows[0]?.n).toBe('1');
    const evidence = await owner.transaction('snapshot', async (tx) => await tx.query<Record<string, unknown>>('SELECT repository, commit_or_digest, line_start, line_end, producer FROM evidence'));
    expect(evidence.rows[0]).toMatchObject({ repository: 'madarch', commit_or_digest: 'c0ffee', line_start: 3, line_end: 4, producer: 'glossary' });
    expect(await producerEntities(owner, contract, 'doc.term', 'glossary')).toEqual([{ key: { name: 'Fill' }, path: 'docs/glossary.md' }]);
  });

  test('a changed value is a new claim beside the old one, and the reader shows the newest', async () => {
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'docs/glossary.md', value: term('Fill', 'two runs') }]));
    const claims = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM claim'));
    expect(claims.rows[0]?.n).toBe('2');
  });

  test('a removal takes the entity out of the reads and leaves its claims behind', async () => {
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex-removal', evidence: 'docs/glossary.md', value: { kind: 'doc.term', key: { name: 'Fill' }, producer: 'glossary' } }]));
    const live = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${contract.vertex[0]!.table} WHERE NOT tombstone`));
    expect(live.rows[0]?.n).toBe('0');
  });

  test('a kind the contract does not declare is refused by the writer, naming it', async () => {
    await expect(owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'x', value: { ...term('x', 'y'), kind: 'doc.other' } }]))).rejects.toThrow(/doc.other/);
  });
});

