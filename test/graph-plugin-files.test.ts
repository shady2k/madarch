/**
 * One plugin turn lists a product's file vertices through `graphFiles` (madarch-64o5.74). The read asks for the
 * repository, path and key edges of every file once: its statement count does not grow with the number of files,
 * its rows are the same rows in the same order, and its failures are the same failures.
 */
import { expect, spyOn, test } from 'bun:test';
import { Client } from 'pg';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { graphFiles } from '../src/graph/plugin-turns.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';
import type { GraphContract } from '../src/graph/contract.js';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';

/** The manifest's own encoding: a Map is a list of pairs, so the declaration survives JSON. */
const encode = (value: unknown): unknown => value instanceof Map
  ? { $map: [...value].map(([key, held]) => [key, encode(held)]) }
  : Array.isArray(value) ? value.map(encode)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, held]) => [key, encode(held)]))
  : value;

const manifestOf = (): ReturnType<typeof parseKinds> => {
  const manifest = parseKinds({ root: {
    kinds: {
      'fixture.file': {
        source: 'graph', key: ['path'], 'key-edges': [{ role: 'repository', edge: 'fixture.owner', side: 'from' }],
        fields: [{ name: 'path', type: 'text', producers: ['fixture'] }],
      },
      'fixture.repository': { source: 'graph', key: ['name'], fields: [{ name: 'name', type: 'text', producers: ['fixture'] }] },
      'fixture.other': { source: 'graph', key: ['name'], fields: [{ name: 'name', type: 'text', producers: ['fixture'] }] },
    },
    edges: [
      { name: 'fixture.contains', from: ['fixture.file'], to: ['fixture.repository', 'fixture.other'],
        cardinality: { from: { min: 0, max: null }, to: { min: 0, max: null } },
        labels: { en: { out: 'contains', in: 'contains' }, ru: { out: 'содержит', in: 'содержит' } } },
      { name: 'fixture.owner', from: ['fixture.file'], to: ['fixture.repository'], 'on-parent-delete': 'restrict',
        cardinality: { from: { min: 1, max: 1 }, to: { min: 0, max: null } },
        labels: { en: { out: 'belongs to', in: 'holds' }, ru: { out: 'принадлежит', in: 'держит' } } },
    ],
    'semantic-bindings': {
      file: { kind: 'fixture.file', fields: { path: 'path' }, edges: { repository: { kind: 'fixture.contains', direction: 'from' } } },
      repository: { kind: 'fixture.repository', fields: { name: 'name' } },
    },
  }, at: () => 1 }, '/fixture/catalog.yaml', '/fixture');
  expect(manifest.findings).toEqual([]);
  return manifest;
};

interface Fixture {
  readonly owner: DatabaseOwner;
  readonly contract: GraphContract;
  readonly publish: (draft: Parameters<typeof publishGraphDrafts>[2]) => Promise<number>;
}

async function fixture(): Promise<Fixture> {
  const manifest = manifestOf();
  const contract = withManifestContract(graphContractOf(manifest));
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  const publish = async (draft: Parameters<typeof publishGraphDrafts>[2]): Promise<number> => await owner.transaction('write', async tx => {
    await bindTestWriteCapability(tx, contract);
    return await publishGraphDrafts(tx, contract, draft);
  });
  await publish({ vertices: [{ kind: 'manifest.catalogue', key: { name: 'product' }, values: { declaration: JSON.stringify(encode(manifest)) }, producer: 'fixture', producerVersion: '1' }], removals: [] });
  return { owner, contract, publish };
}

const repository = (name: string) => ({ kind: 'fixture.repository', key: { name } });
const repositoryDraft = (name: string) => ({ ...repository(name), values: {}, producer: 'fixture', producerVersion: '1' });
const file = (path: string, name: string) => ({
  kind: 'fixture.file', key: { path }, keyEdges: { repository: repository(name) }, producer: 'fixture', producerVersion: '1',
});
const membership = (path: string, owner: string, target: { readonly kind: string; readonly key: { readonly name: string } } = repository(owner)) => ({
  kind: 'fixture.contains',
  from: { kind: 'fixture.file', key: { path }, keyEdges: { repository: repository(owner) } },
  to: target,
  producer: 'fixture', producerVersion: '1',
});

/** Delete one repository node as the `gone` case does: replica mode leaves the key edges that named it dangling. */
async function deleteRepositoryNode(owner: DatabaseOwner, name: string): Promise<void> {
  const found = await owner.transaction('snapshot', tx => tx.query<{ id: string }>(
    "SELECT n.id::text AS id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='fixture.repository' AND n.key->>'name'=$1", [name]));
  expect(found.rows).toHaveLength(1);
  await owner.transaction('write', async tx => {
    await tx.query('SET LOCAL session_replication_role = replica');
    await tx.query('DELETE FROM node WHERE id=$1::bigint', [found.rows[0]!.id]);
  });
}

/** Statements one call of `graphFiles` issues, in both the text and the parameterized client form. */
async function countStatements(owner: DatabaseOwner, contract: GraphContract): Promise<{ rows: readonly unknown[]; statements: string[] }> {
  const statements: string[] = [];
  const original = Client.prototype.query;
  const spy = spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
    const first = args[0] as unknown;
    if (typeof first === 'string') statements.push(first);
    else if (first !== null && typeof first === 'object' && typeof (first as { text?: unknown }).text === 'string') statements.push((first as { text: string }).text);
    return Reflect.apply(original, this, args) as never;
  } as typeof original);
  try { return { rows: await graphFiles(owner, contract), statements }; } finally { spy.mockRestore(); }
}

test('file listing issues the same statements for 10 and for 200 files', async () => {
  // The brief's bound is eight statements for the reference resolution. The four `readKindAssertions` calls of the
  // existing readers cost 18 statements (each goes through the assertion loader), the one batch read and its node
  // read cost 7, and the transaction costs 1, so the fixed cost is 26. The test therefore compares that fixed cost
  // with an empty graph's call and holds only what reference resolution adds to the brief's eight.
  const { owner, contract, publish } = await fixture();
  try {
    const empty = await countStatements(owner, contract);
    expect(empty.rows).toEqual([]);
    const ten = Array.from({ length: 10 }, (_, index) => `f${String(index)}.ts`);
    await publish({
      vertices: [repositoryDraft('repo'), ...ten.map((path) => file(path, 'repo'))], removals: [],
      edges: ten.map((path) => membership(path, 'repo')),
    });
    const small = await countStatements(owner, contract);
    const rest = Array.from({ length: 190 }, (_, index) => `f${String(index + 10).padStart(3, '0')}.ts`);
    await publish({
      vertices: rest.map((path) => file(path, 'repo')), removals: [],
      edges: rest.map((path) => membership(path, 'repo')),
    });
    const large = await countStatements(owner, contract);
    console.log('graphFiles statements', JSON.stringify({
      empty: empty.statements.length, ten: small.statements.length, twoHundred: large.statements.length,
      referenceResolution: small.statements.length - empty.statements.length,
    }));
    expect(small.rows).toHaveLength(10);
    expect(large.rows).toHaveLength(200);
    expect(large.statements.length).toBe(small.statements.length);
    expect(small.statements.length - empty.statements.length).toBeLessThanOrEqual(8);
  } finally { await owner.close(); }
}, 180_000);

test('file listing returns the same rows in the same order', async () => {
  const { owner, contract, publish } = await fixture();
  try {
    await publish({ vertices: [
      repositoryDraft('zeta'), repositoryDraft('alpha'),
      file('b.ts', 'zeta'), file('z.ts', 'alpha'), file('a.ts', 'zeta'), file('a.ts', 'alpha'), file('invisible.ts', 'zeta'),
    ], removals: [] });
    await publish({ vertices: [], removals: [], edges: [
      membership('b.ts', 'zeta'), membership('z.ts', 'alpha'), membership('a.ts', 'zeta'), membership('a.ts', 'alpha'),
    ] });
    const expected = [
      { repository: 'alpha', path: 'a.ts', keyEdges: { repository: { kind: 'fixture.repository', key: { name: 'alpha' } } } },
      { repository: 'alpha', path: 'z.ts', keyEdges: { repository: { kind: 'fixture.repository', key: { name: 'alpha' } } } },
      { repository: 'zeta', path: 'a.ts', keyEdges: { repository: { kind: 'fixture.repository', key: { name: 'zeta' } } } },
      { repository: 'zeta', path: 'b.ts', keyEdges: { repository: { kind: 'fixture.repository', key: { name: 'zeta' } } } },
    ];
    const rows = await graphFiles(owner, contract);
    expect(rows).toEqual(expected);
    expect(JSON.stringify(rows)).toBe(JSON.stringify(expected));
  } finally { await owner.close(); }
}, 60_000);

test('file listing fails as before for ambiguous membership', async () => {
  const { owner, contract, publish } = await fixture();
  try {
    await publish({ vertices: [repositoryDraft('ambiguous'), repositoryDraft('ambiguous-other'), file('ambiguous.ts', 'ambiguous')], removals: [] });
    await publish({ vertices: [], removals: [], edges: [
      membership('ambiguous.ts', 'ambiguous'), membership('ambiguous.ts', 'ambiguous', repository('ambiguous-other')),
    ] });
    await expect(graphFiles(owner, contract)).rejects.toThrow(/\/fixture\/catalog\.yaml:1: file .* has ambiguous repository membership$/);
  } finally { await owner.close(); }
}, 60_000);

test('file listing fails as before for a repository endpoint that is not an active repository', async () => {
  const { owner, contract, publish } = await fixture();
  try {
    await publish({ vertices: [
      repositoryDraft('active'), { kind: 'fixture.other', key: { name: 'gamma' }, values: {}, producer: 'fixture', producerVersion: '1' }, file('other.ts', 'active'),
    ], removals: [] });
    await publish({ vertices: [], removals: [], edges: [membership('other.ts', 'active', { kind: 'fixture.other', key: { name: 'gamma' } })] });
    await expect(graphFiles(owner, contract)).rejects.toThrow(/\/fixture\/catalog\.yaml:1: file .* repository endpoint is not an active fixture\.repository$/);
  } finally { await owner.close(); }
}, 60_000);

test('file listing fails as before when a key edge parent node is gone', async () => {
  // On H `referenceOf` reports the same body from `${path}:30`; the one batch reader reports it from
  // `referencesOf` at `${path}:73`, so the body is held and only the module line is allowed to move.
  const { owner, contract, publish } = await fixture();
  try {
    await publish({ vertices: [repositoryDraft('alpha5'), repositoryDraft('beta5'), file('gone.ts', 'beta5')], removals: [] });
    await publish({ vertices: [], removals: [], edges: [membership('gone.ts', 'beta5', repository('alpha5'))] });
    await deleteRepositoryNode(owner, 'beta5');
    await expect(graphFiles(owner, contract)).rejects.toThrow(/plugin-turns\.ts:\d+: fixture\.file .* requires exactly one key edge repository, found 0$/);
  } finally { await owner.close(); }
}, 60_000);

test('file listing skips a file without membership whose key edge parent is gone', async () => {
  // The batch reader resolves references only for the files it lists: a file with no `contains` edge never reaches
  // that read, so the dangling key edge it holds is not an error.
  const { owner, contract, publish } = await fixture();
  try {
    await publish({ vertices: [repositoryDraft('orphan-key'), repositoryDraft('orphan-live'),
      file('orphan.ts', 'orphan-key'), file('normal.ts', 'orphan-live')], removals: [] });
    await publish({ vertices: [], removals: [], edges: [membership('normal.ts', 'orphan-live')] });
    await deleteRepositoryNode(owner, 'orphan-key');
    expect(await graphFiles(owner, contract)).toEqual([
      { repository: 'orphan-live', path: 'normal.ts', keyEdges: { repository: { kind: 'fixture.repository', key: { name: 'orphan-live' } } } },
    ]);
  } finally { await owner.close(); }
}, 60_000);

test('membership errors are reported for every file before any key edge error', async () => {
  // File A is published first and the parent of its key edge is gone; file B has two `contains` edges. The candidate
  // checks the membership of every file before it resolves references, so B's error is raised; the reader of
  // c18818a50 resolved A's reference first and raised its key edge error here.
  const { owner, contract, publish } = await fixture();
  try {
    await publish({ vertices: [repositoryDraft('mixed-a-key'), repositoryDraft('mixed-a-live'),
      file('mixed-a.ts', 'mixed-a-key')], removals: [] });
    await publish({ vertices: [], removals: [], edges: [membership('mixed-a.ts', 'mixed-a-key', repository('mixed-a-live'))] });
    await deleteRepositoryNode(owner, 'mixed-a-key');
    await publish({ vertices: [repositoryDraft('mixed-b-live'), repositoryDraft('mixed-b-other'),
      file('mixed-b.ts', 'mixed-b-live')], removals: [] });
    await publish({ vertices: [], removals: [], edges: [
      membership('mixed-b.ts', 'mixed-b-live'),
      membership('mixed-b.ts', 'mixed-b-live', repository('mixed-b-other')),
    ] });
    await expect(graphFiles(owner, contract)).rejects.toThrow(/\/fixture\/catalog\.yaml:1: file .* has ambiguous repository membership$/);
  } finally { await owner.close(); }
}, 60_000);
