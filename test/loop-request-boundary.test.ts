import { expect, test } from 'bun:test';
import { createKnowledgePart } from '../src/server/knowledge.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';

function fixture() {
  const calls: unknown[][] = [];
  const product = {
    folder: '/unused/loop-request-boundary',
    answer: async (...args: unknown[]) => {
      calls.push(args);
      return { question: { slug: 'stable', answer: { by: { uid: 'person' }, at: 'now' } }, committed: false };
    },
    proposeTask: async (...args: unknown[]) => { calls.push(args); return { proposed: true }; },
  } as unknown as KnowledgeProduct;
  const part = createKnowledgePart({
    json: (status, body) => Response.json(body, { status }),
    refused: (status, body) => ({ response: Response.json(body, { status }) }),
    errorLog: () => {},
  }, product, () => []);
  return { part, calls };
}
const request = (body: unknown) => new Request('http://localhost/api/answer', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('answer and propose-task refuse malformed requests before calling the product', async () => {
  const { part, calls } = fixture();
  for (const [handler, body] of [
    [part.answer, null],
    [part.answer, { text: 'answer' }],
    [part.answer, { question: 42, text: 'answer' }],
    [part.answer, { question: 'inquiry:stable', text: false }],
    [part.answer, { question: 'inquiry:stable', text: 'answer', extra: true }],
    [part.proposeTask, { question: 'inquiry:stable', choice: 'other' }],
    [part.proposeTask, { question: 'inquiry:stable', choice: 'docs', language: 'invalid' }],
    [part.proposeTask, { question: 'inquiry:stable', choice: 'code', extra: true }],
  ] as const) {
    const result = await handler(request(body));
    expect(result.response.status).toBe(400);
    const refused = await result.response.json();
    expect(typeof refused.field).toBe('string');
    expect(refused.message).toContain('/src/server/knowledge.ts:');
  }
  expect(calls).toEqual([]);
});

test('answer and propose-task retain validated identities and optional language', async () => {
  const { part, calls } = fixture();
  expect((await part.answer(request({ question: 'inquiry:stable', text: 'answer' }))).response.status).toBe(200);
  expect((await part.proposeTask(request({ question: 'inquiry:stable', choice: 'docs' }))).response.status).toBe(200);
  expect((await part.proposeTask(request({ question: 'inquiry:stable', choice: 'code', language: 'ru' }))).response.status).toBe(200);
  expect(calls).toEqual([['inquiry:stable', 'answer'], ['inquiry:stable', 'docs', undefined], ['inquiry:stable', 'code', 'ru']]);
});
