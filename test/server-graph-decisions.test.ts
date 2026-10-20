/// <reference lib="dom" />
/**
 * The graph's decision routes over the background server (the self-filling charter's
 * outcome 5): `POST /api/graph/answer` and `POST /api/graph/decide`, the two ways a
 * person's own words reach the graph.
 *
 * What is held here is the contract the app depends on, over a stand-in source: the
 * request a decision must carry, what the answer holds on success (the document the
 * product's git holds and the pages the graph read again), and the status each refusal
 * answers with — a node the graph does not hold is a 404, a request that names nothing
 * a decision can be about is a 400, and a home with no fill behind it is a 503.
 */
import { describe, expect, test } from 'bun:test';
import { createGraphPagesPart, decisionStatus } from '../src/server/graph-pages.js';
import { emptyNextStep, emptyQuestionSet, type GraphDecisionWrite, type GraphPagesSource } from '../src/fill/graph-pages.js';

const QUESTION = `question:${'1'.repeat(64)}`;
const PAGE = `module:${'2'.repeat(64)}`;

/** A source that answers what it is given, and records what the route asked it. */
function standIn(answer: GraphDecisionWrite): { readonly source: GraphPagesSource; readonly asked: { answer: unknown[]; decide: unknown[] } } {
  const asked = { answer: [] as unknown[], decide: [] as unknown[] };
  const source: GraphPagesSource = {
    pageSet: async () => ({ product: 'Fixture Product', pages: [], counts: [], total: 0, changeSeq: 0, readAt: 0, message: null, questions: emptyQuestionSet(), nextStep: emptyNextStep('Fixture Product') }),
    page: async () => ({ ok: false, code: 'graph-pages/no-such-node', message: 'nothing' }),
    diagrams: async () => ({ ok: false, code: 'graph-pages/no-such-node', message: 'nothing' }),
    changes: async () => ({ changes: [], lastSeq: 0, truncated: false, marker: null }),
    answer: async (request) => { asked.answer.push(request); return answer; },
    decide: async (request) => { asked.decide.push(request); return answer; },
    subscribe: () => () => undefined,
  };
  return { source, asked };
}

const makers = {
  json: (status: number, body: unknown) => Response.json(body, { status }),
  refused: (status: number, error: { message: string; field?: string }) => ({ response: Response.json({ message: error.message, error }, { status }), refusal: error.message }),
  errorLog: () => undefined,
};

const post = (path: string, body: unknown): Request => new Request(`http://127.0.0.1:1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('a person answers a question over the graph routes', () => {
  test('the answer is passed to the source with its question, its words and who wrote them, and the answer names what landed', async () => {
    const { source, asked } = standIn({ ok: true, file: `answers/${'1'.repeat(64)}.md`, pages: [PAGE, QUESTION] });
    const part = createGraphPagesPart(makers, source);
    const handled = await part.answer(post('/api/graph/answer', { question: QUESTION, answer: 'At authorization.', by: 'the owner' }));
    expect(handled.response.status).toBe(200);
    expect(await handled.response.json()).toEqual({ file: `answers/${'1'.repeat(64)}.md`, pages: [PAGE, QUESTION] });
    expect(asked.answer).toEqual([{ question: QUESTION, answer: 'At authorization.', by: 'the owner' }]);
    // A request that names nobody still answers: the wiki's own words stand for the person who left the field out.
    await part.answer(post('/api/graph/answer', { question: QUESTION, answer: 'At authorization.' }));
    expect(asked.answer[1]).toEqual({ question: QUESTION, answer: 'At authorization.', by: 'a reader of the wiki' });
  });

  test('a request that names no question, no page or no verdict is refused before the source is asked', async () => {
    const { source, asked } = standIn({ ok: true, file: 'x.md', pages: [] });
    const part = createGraphPagesPart(makers, source);
    const notAFactId = await part.answer(post('/api/graph/answer', { question: 'QST-1', answer: 'x' }));
    expect(notAFactId.response.status).toBe(400);
    const noWords = await part.answer(post('/api/graph/answer', { question: QUESTION }));
    expect(noWords.response.status).toBe(400);
    const unknownVerdict = await part.decide(post('/api/graph/decide', { page: PAGE, verdict: 'maybe' }));
    expect(unknownVerdict.response.status).toBe(400);
    const notJson = await part.decide(new Request('http://127.0.0.1:1/api/graph/decide', { method: 'POST', body: 'not json' }));
    expect(notJson.response.status).toBe(400);
    expect(asked.answer).toEqual([]);
    expect(asked.decide).toEqual([]);
  });

  test('a decision the graph refused answers its own status, and names the document it did not keep', async () => {
    const refused = standIn({ ok: false, code: 'graph-pages/no-such-node', message: `the graph holds no question of the id ${QUESTION}` });
    const part = createGraphPagesPart(makers, refused.source);
    const missing = await part.answer(post('/api/graph/answer', { question: QUESTION, answer: 'x' }));
    expect(missing.response.status).toBe(404);
    expect(await missing.response.json()).toMatchObject({ error: { message: `the graph holds no question of the id ${QUESTION}` } });

    // The statuses the app tells apart: nothing to write to, nothing that kind, and a request no decision can be about.
    expect(decisionStatus('graph-pages/no-graph')).toBe(503);
    expect(decisionStatus('graph-pages/not-a-question')).toBe(404);
    expect(decisionStatus('graph-pages/not-a-page')).toBe(404);
    expect(decisionStatus('graph-pages/empty-answer')).toBe(400);
    expect(decisionStatus('graph-pages/refused')).toBe(500);
  });

  test('a person accepts a page: the verdict and the note reach the source, and a page that names no note sends an empty one', async () => {
    const { source, asked } = standIn({ ok: true, file: `acceptances/${'2'.repeat(64)}.md`, pages: [PAGE] });
    const part = createGraphPagesPart(makers, source);
    const handled = await part.decide(post('/api/graph/decide', { page: PAGE, verdict: 'accepted', note: 'the boundary is right' }));
    expect(handled.response.status).toBe(200);
    await part.decide(post('/api/graph/decide', { page: PAGE, verdict: 'rejected' }));
    expect(asked.decide).toEqual([
      { page: PAGE, verdict: 'accepted', note: 'the boundary is right', by: 'a reader of the wiki' },
      { page: PAGE, verdict: 'rejected', note: '', by: 'a reader of the wiki' },
    ]);
  });
});
