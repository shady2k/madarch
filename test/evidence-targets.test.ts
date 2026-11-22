import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { generatedTableName, type GraphContract, type VertexDraft } from '../src/graph/contract.js';
import { withSystemContract } from '../src/graph/system-contract.js';
import { registerSystemSource } from '../src/graph/system-installation.js';
import { activateGraphProducer, bindGraphProducer, type ProducerBinding } from '../src/graph/producer-binding.js';
import { publishGraphDrafts, removeEntity } from '../src/graph/write.js';
import { resolveEvidenceTargets, type EvidenceLocatorDraft, type EvidenceTargetKinds } from '../src/graph/evidence-targets.js';

const kinds: EvidenceTargetKinds = { repository: 'fixture.repo', file: 'fixture.file', commit: 'fixture.commit', blob: 'fixture.blob', currentCommitEdge: 'fixture.pin', currentFileEdge: 'fixture.contains', repositoryKey: 'name', fileRepositoryEdge: 'fixture.file-repository', filePathKey: 'path', commitKey: 'hash', blobKey: 'hash', lineCountField: 'lines', fileBlobEdge: 'fixture.file-blob' };
const contract: GraphContract = {
  vertex: [
    { name: kinds.repository, key: ['name'], fields: [{ name: 'name', type: 'text' as const }] },
    { name: kinds.commit, key: ['hash'], fields: [{ name: 'hash', type: 'text' as const }] },
    { name: kinds.blob, key: ['hash'], fields: [{ name: 'hash', type: 'text' as const }] },
    { name: kinds.file, key: ['path'], keyEdges: [{ role: 'repository', edge: kinds.fileRepositoryEdge, direction: 'from' as const, onDelete: 'restrict' as const }], fields: [{ name: 'path', type: 'text' as const }, { name: 'lines', type: 'bigint' as const, nullable: true }] },
  ].map(one => ({ ...one, table: generatedTableName(one.name, 'vertex'), capability: 'fixture' })),
  edge: [
    { name: kinds.currentCommitEdge, from: [kinds.repository], to: [kinds.commit] },
    { name: kinds.currentFileEdge, from: [kinds.repository], to: [kinds.file] },
    { name: kinds.fileRepositoryEdge, from: [kinds.file], to: [kinds.repository] },
    { name: kinds.fileBlobEdge, from: [kinds.file], to: [kinds.blob] },
  ].map(one => ({ ...one, fields: [], repeats: false, capability: 'fixture', cardinality: { from: 'many' as const, to: one.name === kinds.fileRepositoryEdge ? 'one' as const : 'many' as const }, labels: { en: { out: one.name, in: one.name }, ru: { out: one.name, in: one.name } } })), dictionary: [],
};
const repositoryRef = { kind: kinds.repository, key: { name: 'example' } };
const fileRef = { kind: kinds.file, key: { path: 'src/main.ts' }, keyEdges: { repository: repositoryRef } };
let owner: DatabaseOwner;
let binding: ProducerBinding;
let otherBinding: ProducerBinding;
const file: EvidenceLocatorDraft = { type: 'file', repository: 'example', commit: 'revision', path: 'src/main.ts', lineStart: 1, lineEnd: 3 };
const vertex = (kind: string, key: Record<string, string>, values?: Record<string, unknown>, producer = 'fixture'): VertexDraft => ({ kind, key, values, ...(kind === kinds.file ? { keyEdges: fileRef.keyEdges } : {}), producer, producerVersion: '1' });
const resolve = (draft: EvidenceLocatorDraft, graph = contract, context = 1) => owner.transaction('snapshot', async tx => await resolveEvidenceTargets(tx, graph, draft, kinds, context));

beforeAll(async () => {
  owner = await createTestDatabaseOwner({ graphContract: contract });
  const grants = async (producer: string) => {
    const source = await registerSystemSource(owner, withSystemContract(contract), { type: 'plugin', installationKey: producer, scope: 'fixture', version: '1' });
    const principal = source.principal;
    return bindGraphProducer(owner, contract, { principal, vertices: Object.fromEntries(contract.vertex.map(one => [one.name, one.fields.map(field => field.name)])), edges: Object.fromEntries(contract.edge.map(one => [one.name, []])) });
  };
  binding = await grants('fixture');
  otherBinding = await grants('other');
  await owner.transaction('write', async tx => { await activateGraphProducer(tx, contract, binding); return await publishGraphDrafts(tx, contract, {
    vertices: [vertex(kinds.repository, { name: 'example' }), vertex(kinds.commit, { hash: 'revision' }), vertex(kinds.commit, { hash: 'historical' }), vertex(kinds.blob, { hash: 'content' }), vertex(kinds.file, { path: 'src/main.ts' }, { lines: '3' })],
    edges: [{ kind: kinds.fileRepositoryEdge, from: fileRef, to: repositoryRef, producer: 'fixture', producerVersion: '1' }, { kind: kinds.fileBlobEdge, from: fileRef, to: { kind: kinds.blob, key: { hash: 'content' } }, producer: 'fixture', producerVersion: '1' }, { kind: kinds.currentFileEdge, from: { kind: kinds.repository, key: { name: 'example' } }, to: fileRef, producer: 'fixture', producerVersion: '1' }, { kind: kinds.currentCommitEdge, from: { kind: kinds.repository, key: { name: 'example' } }, to: { kind: kinds.commit, key: { hash: 'revision' } }, producer: 'fixture', producerVersion: '1' }], removals: [],
  }, 1); });
});
afterAll(async () => { await owner?.close(); });

test('resolves real vertices, with typed span and no vertex ids inside locators', async () => {
  const targets = await resolve({ ...file, blob: 'content' });
  expect(targets.map(one => one.target.kind)).toEqual([kinds.file, kinds.commit, kinds.blob]);
  expect(targets.map(one => one.locator)).toEqual([{ type: 'file', path: 'src/main.ts', lineStart: 1, lineEnd: 3 }, { type: 'commit' }, { type: 'blob' }]);
  expect((await resolve({ ...file, lineStart: 2, lineEnd: undefined }))[0]!.locator).toEqual({ type: 'file', path: 'src/main.ts', lineStart: 2, lineEnd: 2 });
  const held = await owner.run(async tx => await tx.query<{ uid: string }>('SELECT uid::text AS uid FROM node'));
  for (const one of targets) expect(held.rows.map(row => row.uid)).toContain(one.target.uid);
  expect((await resolve({ type: 'commit', repository: 'example', commit: 'revision' }))[0]!.target.kind).toBe(kinds.commit);
  expect((await resolve({ type: 'blob', blob: 'content' }))[0]!.target.kind).toBe(kinds.blob);
});

test('refuses missing, wrong-kind, wrong-context and unproved historical targets without creating nodes', async () => {
  const count = async () => (await owner.run(async tx => await tx.query<{ count: string }>('SELECT count(*)::text AS count FROM node'))).rows[0]!.count;
  const before = await count();
  await expect(resolve({ ...file, path: 'absent' })).rejects.toThrow('EVIDENCE_UNRESOLVED');
  await expect(resolve({ ...file, commit: 'historical' })).rejects.toThrow('EVIDENCE_UNRESOLVED');
  await expect(resolve({ type: 'blob', blob: 'revision' })).rejects.toThrow('EVIDENCE_UNRESOLVED');
  await expect(resolve(file, contract, 2)).rejects.toThrow('EVIDENCE_UNRESOLVED');
  await expect(resolve({ type: 'blob', blob: 'content' }, { ...contract, vertex: contract.vertex.filter(one => one.name !== kinds.blob) })).rejects.toThrow('EVIDENCE_KIND');
  expect(await count()).toBe(before);
});

test('refuses malformed and out-of-file inclusive spans', async () => {
  for (const span of [{ lineStart: 0, lineEnd: 1 }, { lineStart: 2, lineEnd: 1 }, { lineStart: 1.5, lineEnd: 2 }, { lineStart: 1, lineEnd: 4 }, { lineStart: undefined, lineEnd: 1 }, { lineStart: 1, lineEnd: Number.POSITIVE_INFINITY }]) {
    await expect(resolve({ ...file, ...span })).rejects.toThrow('EVIDENCE_LINES');
  }
  await expect(resolve({ ...file, path: '' })).rejects.toThrow('EVIDENCE_INVALID');
});

test('refuses competing line counts and blob mismatches rather than selecting a convenient opinion', async () => {
  await owner.transaction('write', async tx => { await activateGraphProducer(tx, contract, otherBinding); await publishGraphDrafts(tx, contract, { vertices: [vertex(kinds.file, { path: 'src/main.ts' }, { lines: '5' }, 'other')], removals: [] }); });
  await expect(resolve(file)).rejects.toThrow('EVIDENCE_AMBIGUOUS');
  await expect(resolve({ ...file, lineStart: undefined, lineEnd: undefined, blob: 'absent' })).rejects.toThrow('EVIDENCE_UNRESOLVED');
  await owner.transaction('write', async tx => { await activateGraphProducer(tx, contract, otherBinding); await removeEntity(tx, contract, { ...fileRef, selectedFields: ['lines'], producer: 'other' }); });
  expect((await resolve(file)).length).toBe(2);
});

test('refuses removed targets', async () => {
  await owner.transaction('write', async tx => {
    await activateGraphProducer(tx, contract, binding);
    await publishGraphDrafts(tx, contract, { vertices: [], removals: [{ kind: kinds.blob, key: { hash: 'content' }, producer: 'fixture' }] });
  });
  await expect(resolve({ type: 'blob', blob: 'content' })).rejects.toThrow('EVIDENCE_UNRESOLVED');
});
