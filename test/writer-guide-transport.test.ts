import { describe, expect, test } from 'bun:test';
import { createKnowledgePart } from '../src/server/knowledge.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';
import type { PageModel } from '../src/knowledge/model.js';

// The stub tests only transport projection, never source verification or live execution acceptance.
describe('guide-only Markdown transport', () => {
  test('JSON and Markdown request the same production page assembly, with no raw artifact path', async () => {
    let calls = 0;
    const data = { guide: { id: 'administrator-guide:main' }, walk: { status: 'not-walked' }, markdown: '# Guide\n\nNot walked\n', diagnostics: [] };
    const page = { id: 'administrator-guide:main', kind: 'administrator-guide', title: 'Guide', trail: [], blocks: [{ type: 'guide', data }], resolutions: {}, findings: [], notes: [] } as unknown as PageModel;
    const product = { page: async () => { calls += 1; return { ok: true, page }; } } as unknown as KnowledgeProduct;
    const makers = {
      json: (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }),
      refused: (status: number, value: unknown) => ({ response: new Response(JSON.stringify(value), { status }) }),
      errorLog: () => {},
    };
    const api = createKnowledgePart(makers, product, () => []);
    const json = await api.page(new Request('http://example.test/api/k/page?id=administrator-guide:main'));
    const markdown = await api.page(new Request('http://example.test/api/k/page?id=administrator-guide:main&format=markdown'));
    expect(await json.response.json()).toEqual(page);
    expect(await markdown.response.text()).toBe(data.markdown);
    expect(calls).toBe(2);
  });

  test('a non-guide or mixed page refuses instead of silently omitting blocks', async () => {
    const page = { blocks: [{ type: 'markdown', markdown: '# Ordinary' }] };
    const product = { page: async () => ({ ok: true, page }) } as unknown as KnowledgeProduct;
    const api = createKnowledgePart({ json: (status, value) => new Response(JSON.stringify(value), { status }), refused: (status, value) => ({ response: new Response(JSON.stringify(value), { status }) }), errorLog: () => {} }, product, () => []);
    const result = await api.page(new Request('http://example.test/api/k/page?id=domain:sample&format=markdown'));
    expect(result.response.status).toBe(422);
    expect(await result.response.text()).toContain('no other blocks were omitted');
  });
});
