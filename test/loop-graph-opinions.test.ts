import { expect, test } from 'bun:test';
import { graphQuestions, graphTasks, graphProblemDismissals, type LoopGraph } from '../src/loop/graph.js';
import { problemId } from '../src/problems/types.js';

const author = { name: 'Ada', email: 'ada@example.test', verified: 'local' };
const graph = (kind: string, properties: Record<string, unknown>): LoopGraph => ({ list: async (requested) => {
  expect(requested).toBe(kind);
  return { rows: [{ key: `${kind}:example`, kind, label: 'Example', properties, nodeIds: [], scope: '' }], total: 1, next: null };
} });

test('question opinions map declared snake-case fields to the loop view', async () => {
  const rows = await graphQuestions(graph('question', { producer: 'agent', slug: 'example', file: 'docs/questions/example.md', language: 'ru', type: 'gap', status: 'answered',
    about: [], asked_in: 'domain:orders', asked_at: '2026-01-01', question: 'Why?', why: 'Unknown', sides: [],
    answer: { text: 'Yes', by: author, at: '2026-01-02' }, resolved_by: ['domain:orders'], resolved_at: '2026-01-03', written_at: [] }));
  expect(rows[0]).toMatchObject({ askedIn: 'domain:orders', askedAt: '2026-01-01', resolvedBy: ['domain:orders'], resolvedAt: '2026-01-03', writtenAt: [], language: 'ru' });
});

test('task opinions preserve the exact scope and closing metadata', async () => {
  const scope = [{ type: 'lines', path: 'src/a.ts', start: 2, end: 2 }];
  const rows = await graphTasks(graph('task', { slug: 'example', file: 'docs/tasks/example.md', status: 'closed', question: '', answer: '', problem: '',
    grounds: [], scope, by: author, at: '2026-01-01', closed_by: 'person', closed_at: '2026-01-02' }));
  expect(rows[0]).toMatchObject({ id: 'task:example', title: 'Example', scope, closedBy: 'person', closedAt: '2026-01-02' });
});

test('dismissal opinions name the same stable problem id as the writer', async () => {
  const rows = await graphProblemDismissals(graph('problem-dismissal', { rule: 'example.rule', identity: 'code.file:src/a.ts', place: 'src/a.ts',
    dismissal_reason: 'Expected', by: author, at: '2026-01-01', file: 'docs/problems/example.md' }));
  expect(rows[0]?.id).toBe(problemId('example.rule', 'code.file:src/a.ts'));
});

test('a missing required opinion is an error, not a default or a file fallback', async () => {
  await expect(graphTasks(graph('task', { slug: 'example' }))).rejects.toThrow('task:example:1: task:example: graph opinion "file" is absent');
});

test('a malformed structured opinion is rejected before the loop uses it', async () => {
  await expect(graphQuestions(graph('question', { producer: 'agent', slug: 'example', file: 'docs/questions/example.md', language: 'en', type: 'gap', status: 'open', about: 'not-an-array' }))).rejects.toThrow('graph opinion "about" must be an array');
});

test('invalid nested question fields name the source file, line and field', async () => {
  const base = { producer: 'agent', slug: 'example', file: 'docs/questions/example.md', language: 'en', type: 'gap', status: 'open', about: [],
    asked_in: null, asked_at: null, question: 'Why?', why: 'Unknown', sides: [], answer: null, resolved_by: [], resolved_at: null, written_at: [] };
  for (const patch of [{ about: [1] }, { sides: [{ claim: 'x', grounds: [1] }] }, { answer: { text: 'x', by: { name: 'Ada' }, at: 'today' } }, { status: 'other' }]) {
    await expect(graphQuestions(graph('question', { ...base, ...patch }))).rejects.toThrow('docs/questions/example.md:1: question:example: graph opinion');
  }
});
