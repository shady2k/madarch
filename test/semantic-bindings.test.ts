import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRoleProperties } from '../src/model/semantic-role-protocol.js';
import { problemFingerprint } from '../src/loop/problem-task.js';
import { evaluateCode, readCodeSnapshot } from '../src/problems/code.js';
import { defaultSettings, type ProblemSettings } from '../src/problems/types.js';
import type { GraphEntity, GraphReader } from '../src/knowledge/graph-read.js';
import { semanticEntities, type SemanticGraph } from '../src/knowledge/semantic-bindings.js';
import { createDraft } from '../src/product/draft.js';
import { readKinds, type KindsManifest, type SemanticBinding } from '../src/product/manifest/kinds.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

const manifest = (binding?: SemanticBinding) => ({ file: '/product/kinds.yaml', semanticBindings: new Map(binding === undefined ? [] : [['inquiry', binding]]) });
const binding: SemanticBinding = { kind: 'demo.inquiry', fields: { text: 'prompt', status: 'state' }, edges: { subjects: { kind: 'demo.about', direction: 'from', line: 8 } }, values: { status: { pending: 'new', complete: 'done' } }, line: 4 };
const row = { key: 'demo.inquiry:q1', uid: 'inquiry-uid', kind: 'demo.inquiry', label: 'First', properties: { prompt: 'Why?', state: 'new' }, nodeIds: [], scope: '' };
const graph: SemanticGraph = { list: async () => ({ rows: [row], total: 1, next: null }), relationEdges: async () => ({ total: 1, rows: [{ from: { key: row.key, uid: row.uid, kind: row.kind, label: row.label }, to: { key: 'demo.subject:s1', uid: 'subject-uid', kind: 'demo.subject', label: 'Subject' }, properties: {} }] }) };

function detectorGraph(entities: readonly GraphEntity[], edges: GraphReader['relationEdges']): GraphReader {
  return {
    list: async (kind: string) => {
      const rows = entities.filter(entity => entity.kind === kind);
      return { rows, total: rows.length, next: null };
    },
    byPrefix: async () => ({ rows: [], total: 0 }),
    fileFacts: async () => ({ rows: [], total: 0 }),
    relationEdges: edges,
  } as unknown as GraphReader;
}

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

test('the default starter catalogue yields no code problems or detector warnings before Fill', async () => {
  const home = mkdtempSync(join(tmpdir(), 'madarch-starter-problems-'));
  try {
    const draft = createDraft({ home, name: 'sample', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    expect(draft.template).toBe('everything');
    const read = readKinds(draft.folder);
    if (!read.present) throw new Error(`${draft.folder}/madarch/catalog.yaml:1: fixture has no catalogue`);
    expect(read.manifest.findings).toEqual([]);
    const settings = read.manifest.problems;
    if (settings === undefined) throw new Error(`${read.manifest.file}:1: fixture has no problem settings`);
    const graph = detectorGraph([], async () => ({ rows: [], total: 0 }));
    const snapshot = await readCodeSnapshot(graph, read.manifest, settings);
    expect(evaluateCode(snapshot, settings)).toEqual({ problems: [], notes: [] });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a missing detector capability is visible and does not suppress another detector snapshot', async () => {
  const debt = { ...row, properties: { token: 'FIXME', words: 'Repair this', location: 'src/example.ts', rowNumber: 3 } };
  const graph = detectorGraph([debt], async () => ({ rows: [], total: 0 }));
  const declared = { file: '/product/kinds.yaml', semanticBindings: new Map([['detector-debt', { ...binding, fields: { markerWord: 'token', text: 'words', path: 'location', line: 'rowNumber' }, values: {}, edges: {} }]]) } as unknown as KindsManifest;
  const settings: ProblemSettings = { ...defaultSettings(), rules: {
    'sample.unused': { predicate: 'dependency-declared-unused', kind: 'unused', sonar: 'code-smell', severity: 'minor', section: 'code', action: 'task', label: { en: 'Unused dependency', ru: 'Неиспользуемая зависимость' } },
  } };
  const result = await readCodeSnapshot(graph, declared, settings);
  expect(result.debts).toHaveLength(1);
  expect(result.notes).toContain('the detector-dependency rule capability could not be read: /product/kinds.yaml:1: semantic role "detector-dependency" is required by this operation; declare semantic-bindings.detector-dependency');
});

test('a missing operation owner is reported when an unserved route makes ownership relevant', async () => {
  const route = { ...row, kind: 'demo.route', key: 'demo.route:sample', uid: 'route-uid', properties: { path: '/sample', method: 'GET' } };
  const operation = { ...row, kind: 'demo.operation', key: 'demo.operation:sample', uid: 'operation-uid', properties: { path: '/sample', openToCallers: true } };
  const service = { key: 'demo.service:sample', uid: 'service-uid', kind: 'demo.service', label: 'Sample' };
  const ownerEdge = { from: route, to: service, properties: {} };
  const servedEdge = { from: route, to: operation, properties: {} };
  const declared = {
    file: '/product/kinds.yaml', semanticBindings: new Map<string, SemanticBinding>([
      ['detector-route', { kind: route.kind, fields: { path: 'path', method: 'method' }, edges: {
        ownerKeys: { kind: 'demo.owner', direction: 'from', line: 9 },
        handlerKeys: { kind: 'demo.handler', direction: 'from', line: 10 },
      }, line: 8 }],
      ['detector-operation', { kind: operation.kind, fields: { path: 'path', openToCallers: 'openToCallers' }, edges: {
        contractKeys: { kind: 'demo.contract', direction: 'from', line: 13 },
      }, line: 12 }],
    ]),
  } as unknown as KindsManifest;
  const settings: ProblemSettings = { ...defaultSettings(), rules: {
    'sample.coverage': { predicate: 'route-without-operation', kind: 'coverage', sonar: 'bug', severity: 'minor', section: 'code', action: 'task', label: { en: 'Route coverage', ru: 'Покрытие маршрутов' } },
  } };
  const coverageNotes = async (entities: readonly GraphEntity[], served = false) => {
    const edges: Record<string, (typeof ownerEdge | typeof servedEdge)[]> = {
      'code.serves': served ? [servedEdge] : [],
      'demo.owner': [ownerEdge],
    };
    const graph = detectorGraph(entities, async kind => {
      const rows = edges[kind] ?? [];
      return { rows, total: rows.length };
    });
    const snapshot = await readCodeSnapshot(graph, declared, settings);
    return snapshot.notes.filter(note => note.includes('detector-operation'));
  };
  expect(await coverageNotes([route])).toEqual([]);
  expect(await coverageNotes([route, operation], true)).toEqual([]);
  expect(await coverageNotes([route, operation])).toEqual([
    '/product/kinds.yaml:12: detector-operation has no declared ownership relation; owner-dependent route coverage is not judged',
  ]);
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
