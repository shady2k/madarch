import { expect, test } from 'bun:test';
import { graphQuestions, graphCorrections, graphProblemTasks } from '../src/loop/graph.js';
import type { GraphEntity } from '../src/knowledge/graph-read.js';
import type { KindsManifest, SemanticBinding } from '../src/product/manifest/kinds.js';
import { semanticEntities, type SemanticGraph } from '../src/knowledge/semantic-bindings.js';

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

const taskRole: SemanticBinding = {
  ...role('demo.work', ['title', 'description', 'tracker', 'status', 'key'], ['problems']),
  values: { tracker: { local: 'local' }, status: { open: 'open' } },
};
const taskManifest = { ...manifest, semanticBindings: new Map([...manifest.semanticBindings, ['problem-task', taskRole]]) };
const task: GraphEntity = { key: 'same-display', uid: 'task-uid', kind: 'demo.work', label: 'Task', nodeIds: [], scope: '', properties: { title: 'Fix it', front: { rule: 'wrong', identity: ['wrong'] } } };

test.each([
  ['missing description', { tracker: 'local', status: 'open' }, { tracker: 'local', status: 'open' }],
  ['null description', { description: null, tracker: 'local' }, { tracker: 'local' }],
  ['third-party tracker', { description: 'Managed externally', tracker: 'github', key: 'T-1' }, { description: 'Managed externally', key: 'T-1' }],
])('the problem-task projection accepts %s', async (_scenario, values, projected) => {
  const row = { ...task, properties: { title: 'Fix it', ...values } };
  const [read] = await semanticEntities(graph([row]), taskManifest, 'problem-task');
  expect(read?.properties).toEqual({ title: 'Fix it', ...projected, problems: [] });
});

test('the problem-task projection still requires a valid title', async () => {
  await expect(semanticEntities(graph([{ ...task, properties: {} }]), taskManifest, 'problem-task'))
    .rejects.toThrow('/product/kinds.yaml:2: same-display: semantic role "problem-task" field "title" is absent');
  const invalid = { ...task, properties: { title: null, description: 'Present', tracker: 'local', status: 'open', key: 'T-1' } };
  await expect(semanticEntities(graph([invalid]), taskManifest, 'problem-task'))
    .rejects.toThrow('semantic role "problem-task" projection /properties/title');

  const mapped = { ...taskManifest, semanticBindings: new Map(taskManifest.semanticBindings) };
  mapped.semanticBindings.set('problem-task', { ...taskRole, values: { ...taskRole.values, title: { known: 'Known title' } } });
  await expect(semanticEntities(graph([task]), mapped, 'problem-task'))
    .rejects.toThrow('field "title" has no declared semantic value for "Fix it"');
});

test('a nullable role field keeps explicit null when the field has a value map', async () => {
  const binding: SemanticBinding = {
    kind: 'demo.repo', fields: { name: 'alias' }, values: { name: { local: 'Local' } }, line: 2,
  };
  const configured = { ...manifest, semanticBindings: new Map([['repository', binding]]) };
  const repository = { ...task, kind: binding.kind, properties: { alias: null } };
  const [projected] = await semanticEntities(graph([repository]), configured, 'repository');
  expect(projected?.properties).toEqual({ name: null });
});

test('an extension role keeps its declared field checks', async () => {
  const binding = role('demo.work', ['title']);
  const configured = { ...manifest, semanticBindings: new Map([['custom-task', binding]]) };
  const [projected] = await semanticEntities(graph([task]), configured, 'custom-task');
  expect(projected?.properties).toEqual({ title: 'Fix it' });
  await expect(semanticEntities(graph([{ ...task, properties: {} }]), configured, 'custom-task'))
    .rejects.toThrow('field "title" is absent');
});

test('task links join protected problem fingerprints through stable endpoint UIDs, never front JSON', async () => {
  const protectedProblem: GraphEntity = { key: 'system.problem:problem-uid', uid: 'problem-uid', kind: 'system.problem', label: 'Problem', nodeIds: [], scope: '', properties: { rule: 'demo.rule', fingerprint: 'opaque-fingerprint' } };
  const read = { ...graph([task]), relationEdges: async () => ({ total: 1, rows: [{ from: { uid: task.uid!, key: task.key, kind: task.kind, label: task.label }, to: { uid: protectedProblem.uid!, key: protectedProblem.key, kind: protectedProblem.kind, label: protectedProblem.label }, properties: {} }] }), find: async () => [protectedProblem] };
  const links = await graphProblemTasks(read, taskManifest, [{ id: 'page-problem-id', rule: 'demo.rule', fingerprint: 'opaque-fingerprint' }]);
  expect(links.get('page-problem-id')).toMatchObject({ uid: 'task-uid', title: 'Fix it' });
  await expect(graphProblemTasks({ ...read, find: async () => [{ ...protectedProblem, uid: 'other-problem-uid' }] }, taskManifest, [])).rejects.toThrow('requires exactly one protected problem for UID problem-uid');
  await expect(graphProblemTasks({ ...read, find: async () => [{ ...protectedProblem, properties: { rule: 'demo.rule' } }] }, taskManifest, [])).rejects.toThrow('fingerprint');
  await expect(graphProblemTasks({ ...read, find: async () => [protectedProblem, protectedProblem] }, taskManifest, [])).rejects.toThrow('found 2');
});
