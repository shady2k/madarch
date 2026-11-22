import { expect, test } from 'bun:test';
import { graphQuestions, graphCorrections, graphProblemTasks } from '../src/loop/graph.js';
import type { GraphEntity } from '../src/knowledge/graph-read.js';
import type { KindsManifest, SemanticBinding } from '../src/product/manifest/kinds.js';
import type { SemanticGraph } from '../src/knowledge/semantic-bindings.js';

const role = (kind: string, fields: string[], edges: string[] = []): SemanticBinding => ({ kind, fields: Object.fromEntries(fields.map((field) => [field, field])), edges: Object.fromEntries(edges.map((edge) => [edge, { kind: edge, direction: 'from' as const, line: 3 }])), line: 2 });
const manifest = { file: '/product/kinds.yaml', semanticBindings: new Map([
  ['question', role('demo.inquiry', ['presentationSlug', 'file', 'language', 'questionType', 'status', 'questionText', 'why', 'answerText', 'askedAt', 'resolvedAt'], ['about', 'resolvedBy'])],
  ['question-claim', role('demo.side', ['ordinal', 'claimText'], ['parentKeys'])],
  ['correction', role('demo.correction', ['presentationSlug', 'file', 'status', 'statementText', 'reason', 'at', 'resolvedAt'], ['about', 'resolvedBy'])],
]) } satisfies Pick<KindsManifest, 'file' | 'semanticBindings'>;
const opinion = (field: string, value: unknown) => ({ field, value, opinionId: 'assertion:one', producer: 'person', lang: 'en', evidence: [], authorUid: 'principal-uid', validFrom: '2026-01-02', recordedAt: '2026-01-02' });
const question: GraphEntity = { key: 'demo.inquiry:q', uid: 'question-uid', kind: 'demo.inquiry', label: 'Why?', nodeIds: [], scope: '', properties: { presentationSlug: 'q', file: 'docs/q.md', language: 'en', questionType: 'gap', status: 'answered', questionText: 'Why?', why: 'Unknown', answerText: 'Yes', askedAt: '2026-01-01', resolvedAt: null }, opinions: [opinion('questionText', 'Why?'), opinion('answerText', 'Yes')] };
const graph = (rows: GraphEntity[]): SemanticGraph => ({ list: async (kind) => ({ rows: rows.filter((row) => row.kind === kind), total: rows.filter((row) => row.kind === kind).length, next: null }), relationEdges: async () => ({ rows: [], total: 0 }) });

test('question presentation assembles scalar answer and assertion lineage without JSON references', async () => {
  const [read] = await graphQuestions(graph([question]), manifest);
  expect(read).toMatchObject({ id: question.key, answer: { text: 'Yes', by: { uid: 'principal-uid' }, at: '2026-01-02' }, producer: 'person', sides: [], writtenAt: [] });
});

test('missing mappings or lineage refuses, never fabricates an author or shrinks output', async () => {
  await expect(graphQuestions(graph([question]), { ...manifest, semanticBindings: new Map() })).rejects.toThrow('/product/kinds.yaml:1: semantic role "question" is required');
  await expect(graphQuestions(graph([{ ...question, opinions: [] }]), manifest)).rejects.toThrow('questionText');
});

test('correction presentation requires one explicit graph target', async () => {
  const correction = { ...question, kind: 'demo.correction', properties: { presentationSlug: 'q', file: 'docs/q.md', status: 'open', statementText: 'Old', reason: 'Changed', at: '2026-01-01', resolvedAt: null }, opinions: [opinion('statementText', 'Old')] };
  await expect(graphCorrections(graph([correction]), manifest)).rejects.toThrow('must identify exactly one corrected graph target');
});

test('an answered assertion keeps its principal UID and never invents a human signature', async () => {
  const [read] = await graphQuestions(graph([question]), manifest);
  expect(read?.answer?.by).toEqual({ uid: 'principal-uid' });
  const unsigned = { ...question, opinions: question.opinions!.map((opinion) => ({ ...opinion, authorUid: '' })) };
  await expect(graphQuestions(graph([unsigned]), manifest)).rejects.toThrow('has no assertion author identity');
});

test('task links join protected problem fingerprints through stable endpoint UIDs, never front JSON', async () => {
  const taskRole = role('demo.work', ['title'], ['problems']);
  const configured = { ...manifest, semanticBindings: new Map([...manifest.semanticBindings, ['problem-task', taskRole]]) };
  const task: GraphEntity = { key: 'same-display', uid: 'task-uid', kind: 'demo.work', label: 'Task', nodeIds: [], scope: '', properties: { title: 'Fix it', front: { rule: 'wrong', identity: ['wrong'] } } };
  const protectedProblem: GraphEntity = { key: 'system.problem:problem-uid', uid: 'problem-uid', kind: 'system.problem', label: 'Problem', nodeIds: [], scope: '', properties: { rule: 'demo.rule', fingerprint: 'opaque-fingerprint' } };
  const read = { ...graph([task]), relationEdges: async () => ({ total: 1, rows: [{ from: { uid: task.uid!, key: task.key, kind: task.kind, label: task.label }, to: { uid: protectedProblem.uid!, key: protectedProblem.key, kind: protectedProblem.kind, label: protectedProblem.label }, properties: {} }] }), find: async () => [protectedProblem] };
  const links = await graphProblemTasks(read, configured, [{ id: 'page-problem-id', rule: 'demo.rule', fingerprint: 'opaque-fingerprint' }]);
  expect(links.get('page-problem-id')).toMatchObject({ uid: 'task-uid', title: 'Fix it' });
  await expect(graphProblemTasks({ ...read, find: async () => [{ ...protectedProblem, uid: 'other-problem-uid' }] }, configured, [])).rejects.toThrow('requires exactly one protected problem for UID problem-uid');
  await expect(graphProblemTasks({ ...read, find: async () => [{ ...protectedProblem, properties: { rule: 'demo.rule' } }] }, configured, [])).rejects.toThrow('fingerprint');
  await expect(graphProblemTasks({ ...read, find: async () => [protectedProblem, protectedProblem] }, configured, [])).rejects.toThrow('found 2');
});
