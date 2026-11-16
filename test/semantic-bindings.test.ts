import { expect, test } from 'bun:test';
import { checkRoleProperties } from '../src/model/semantic-role-protocol.js';
import { problemFingerprint } from '../src/loop/problem-task.js';
import { readCodeSnapshot } from '../src/problems/code.js';
import { semanticEntities, type SemanticGraph } from '../src/knowledge/semantic-bindings.js';
import type { SemanticBinding } from '../src/product/manifest/kinds.js';

const manifest = (binding?: SemanticBinding) => ({ file: '/product/kinds.yaml', semanticBindings: new Map(binding === undefined ? [] : [['inquiry', binding]]) });
const binding: SemanticBinding = { kind: 'demo.inquiry', fields: { text: 'prompt', status: 'state' }, edges: { subjects: { kind: 'demo.about', direction: 'from', line: 8 } }, values: { status: { pending: 'new', complete: 'done' } }, line: 4 };
const row = { key: 'demo.inquiry:q1', uid: 'inquiry-uid', kind: 'demo.inquiry', label: 'First', properties: { prompt: 'Why?', state: 'new' }, nodeIds: [], scope: '' };
const graph: SemanticGraph = { list: async () => ({ rows: [row], total: 1, next: null }), relationEdges: async () => ({ total: 1, rows: [{ from: { key: row.key, uid: row.uid, kind: row.kind, label: row.label }, to: { key: 'demo.subject:s1', uid: 'subject-uid', kind: 'demo.subject', label: 'Subject' }, properties: {} }] }) };

test('explicit bindings project fields, enum meanings and endpoint identity without kind inference', async () => {
  const [entity] = await semanticEntities(graph, manifest(binding), 'inquiry');
  expect(entity).toEqual({ ...row, properties: { text: 'Why?', status: 'pending', subjects: ['subject-uid'] } });
});

test('a missing role, required field, unknown enum or partial edge read refuses the whole projection', async () => {
  await expect(semanticEntities(graph, manifest(), 'inquiry')).rejects.toThrow('/product/kinds.yaml:1: semantic role "inquiry" is required');
  await expect(semanticEntities(graph, manifest({ ...binding, fields: { text: 'missing' } }), 'inquiry')).rejects.toThrow('/product/kinds.yaml:4: demo.inquiry:q1:');
  await expect(semanticEntities(graph, manifest({ ...binding, values: { status: { complete: 'done' } } }), 'inquiry')).rejects.toThrow('no declared semantic value');
  await expect(semanticEntities({ ...graph, relationEdges: async () => ({ total: 2, rows: [] }) }, manifest(binding), 'inquiry')).rejects.toThrow('/product/kinds.yaml:8: semantic role "inquiry" reads 0 of 2');
});

test('UID endpoint matching distinguishes equal display keys and refuses missing identities', async () => {
  const relationEdges: NonNullable<SemanticGraph['relationEdges']> = async () => ({ total: 1, rows: [{ from: { key: row.key, uid: 'other-parent-uid', kind: row.kind, label: row.label }, to: { key: 'same-key', uid: 'target-uid', kind: 'demo.subject', label: 'Other' }, properties: {} }] });
  const [entity] = await semanticEntities({ ...graph, relationEdges }, manifest(binding), 'inquiry');
  expect(entity?.properties['subjects']).toEqual([]);
  await expect(semanticEntities({ ...graph, list: async () => ({ rows: [{ ...row, uid: undefined }], total: 1, next: null }) }, manifest(binding), 'inquiry')).rejects.toThrow('requires a stable graph UID');
});

test('a missing detector capability is visible and does not suppress another detector snapshot', async () => {
  const debt = { ...row, properties: { token: 'FIXME', words: 'Repair this', location: 'src/example.ts', rowNumber: 3 } };
  const graph = {
    list: async (kind: string) => ({ rows: kind === row.kind ? [debt] : [], total: kind === row.kind ? 1 : 0, next: null }),
    byPrefix: async () => ({ rows: [], total: 0 }),
    fileFacts: async () => ({ rows: [], total: 0 }),
    relationEdges: async () => ({ rows: [], total: 0 }),
  } as unknown as import('../src/knowledge/graph-read.js').GraphReader;
  const declared = { file: '/product/kinds.yaml', semanticBindings: new Map([['detector-debt', { ...binding, fields: { markerWord: 'token', text: 'words', path: 'location', line: 'rowNumber' }, values: {}, edges: {} }]]) } as unknown as import('../src/product/manifest/kinds.js').KindsManifest;
  const result = await readCodeSnapshot(graph, declared);
  expect(result.debts).toHaveLength(1);
  expect(result.notes.some((note) => note.includes('detector-dependency') && note.includes('/product/kinds.yaml:1'))).toBe(true);
});

test('engine projection schema validates declared role slots and rejects unknown or ill-typed slots', () => {
  expect(() => checkRoleProperties('question-claim', { ordinal: 1, claimText: 'A statement', parentKeys: ['parent-uid'] }, '/product/catalog.yaml:7')).not.toThrow();
  expect(() => checkRoleProperties('question-claim', { ordinal: 'first', claimText: 'A statement', parentKeys: [] }, '/product/catalog.yaml:7')).toThrow('/product/catalog.yaml:7');
  expect(() => checkRoleProperties('question-claim', { ordinal: 1, claimText: 'A statement', parentKeys: [], unbound: true }, '/product/catalog.yaml:7')).toThrow('projection');
  expect(() => checkRoleProperties('repository', { name: 'example', url: null }, '/product/catalog.yaml:9')).not.toThrow();
  expect(() => checkRoleProperties('repository.history', { walk: 'first' }, '/product/catalog.yaml:9')).toThrow('projection');
  expect(() => checkRoleProperties('evidence-support', { about: ['source-uid'] }, '/product/catalog.yaml:10')).not.toThrow();
  expect(() => checkRoleProperties('evidence-support', { about: 'source-key' }, '/product/catalog.yaml:10')).toThrow('projection');
});

test('problem fingerprints contain diagnostic values and the actual graph target UID, never composite graph keys', () => {
  const diagnostic = { rule: 'size-rule', text: { code: 'largeFile' as const, args: { count: 731, limit: 600 } }, file: 'src/example.ts', line: 1, identity: 'display-key-one' };
  const first = problemFingerprint(diagnostic, 'target-uid-one');
  const renamedDiagnostic = { ...diagnostic, identity: 'renamed-display-key' };
  expect(problemFingerprint(renamedDiagnostic, 'target-uid-one')).toBe(first);
  expect(problemFingerprint(diagnostic, 'target-uid-two')).not.toBe(first);
  expect(problemFingerprint({ ...diagnostic, text: { code: 'largeFile', args: { count: 732, limit: 600 } } }, 'target-uid-one')).not.toBe(first);
  expect(first).not.toContain(diagnostic.identity);
});
