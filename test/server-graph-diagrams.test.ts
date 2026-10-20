/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { createGraphDiagramsPart } from '../src/server/graph-diagrams.js';
import type { GraphPagesSource } from '../src/fill/graph-pages.js';
import { buildDiagram } from '../src/fill/diagrams.js';
import { DIAGRAM_FIXTURE, readsOf } from './fill-diagram-fixture.js';

/**
 * The graph's diagram routes (madarch-tzte.23.4): over a stand-in source, so the
 * answers the app depends on — the diagrams of a page, the documents' refusals, and
 * a misconfigured `MADARCH_WIKI_DIAGRAM` — are held without a database or a
 * renderer. The rendering behind the two document routes is the acceptance walk's
 * (`wiki-graph-diagrams-e2e.test.ts`, on the pod with the real tools).
 */
const fx = DIAGRAM_FIXTURE;
const lines: string[] = [];

const makers = {
  json: (status: number, body: unknown) => Response.json(body, { status }),
  refused: (status: number, error: { message: string; field?: string; code?: string; logMessage?: string }) => {
    lines.push(error.logMessage ?? error.message);
    const { logMessage, ...client } = error;
    return { response: Response.json({ message: error.message, error: client }, { status }), refusal: logMessage ?? error.message };
  },
  errorLog: (line: string) => lines.push(line),
};

/** A source answering one page's diagrams, and the page model the answer names. */
async function sourceWith(): Promise<GraphPagesSource> {
  const clean = readsOf(fx.facts.filter((fact) => fact.id !== fx.orphanImportsGone.id));
  const module = await buildDiagram({ type: 'module-dependency', nodes: [fx.shop.id] }, clean);
  return {
    pageSet: async () => ({ product: 'Fixture Product', pages: [], counts: [], total: 0, changeSeq: 0, readAt: 0, message: null }),
    page: async () => ({ ok: false, code: 'graph-pages/no-such-node', message: 'nothing' }),
    diagrams: async (id: string) => id === fx.shop.id
      ? {
          ok: true as const,
          product: 'Fixture Product',
          node: { id: fx.shop.id, kind: 'repository' as const, label: 'acme-shop', page: `/p/graph/${fx.shop.id}`, layer: 'extracted' as const, status: 'proposed' as const },
          page: `/p/graph/${fx.shop.id}`,
          readAt: 1_700_000_000_000,
          diagrams: [{ spec: { type: 'module-dependency' as const, nodes: [fx.shop.id] }, model: module }],
        }
      : { ok: false as const, code: 'graph-pages/no-such-node', message: `the graph holds no page of ${id}` },
    changes: async () => ({ changes: [], lastSeq: 0, truncated: false, marker: null }),
    subscribe: () => () => undefined,
  };
}

describe('the diagrams route', () => {
  test('answers one page diagrams with the tabs of every renderer that supports the type, the setting first', async () => {
    const part = createGraphDiagramsPart(makers, await sourceWith(), { env: { MADARCH_WIKI_DIAGRAM: 'archify' } });
    const handled = await part.diagrams(new Request(`http://127.0.0.1:1/api/graph/diagrams?id=${encodeURIComponent(fx.shop.id)}`));
    expect(handled.response.status).toBe(200);
    const body = await handled.response.json() as { firstTab: string; node: { id: string }; diagrams: { type: string; tabs: { renderer: string }[]; elements: unknown[] }[] };
    expect(body.firstTab).toBe('archify');
    expect(body.node.id).toBe(fx.shop.id);
    expect(body.diagrams.map((diagram) => diagram.type)).toEqual(['module-dependency']);
    expect(body.diagrams[0]!.tabs.map((tab) => tab.renderer)).toEqual(['archify', 'mermaid']);
  });

  test('an id the graph holds no page of is the page model own refusal, and an empty id is a wrong value', async () => {
    const part = createGraphDiagramsPart(makers, await sourceWith(), { env: {} });
    const missing = await part.diagrams(new Request(`http://127.0.0.1:1/api/graph/diagrams?id=${encodeURIComponent('module:' + '0'.repeat(64))}`));
    expect(missing.response.status).toBe(404);
    expect((await missing.response.json() as { error: { code: string } }).error.code).toBe('graph-pages/no-such-node');
    const empty = await part.diagrams(new Request('http://127.0.0.1:1/api/graph/diagrams'));
    expect(empty.response.status).toBe(400);
    expect((await empty.response.json() as { error: { field: string } }).error.field).toBe('id');
  });

  test('a MADARCH_WIKI_DIAGRAM the wiki does not hold is refused naming the value and the three, and says so in the log', async () => {
    lines.length = 0;
    const part = createGraphDiagramsPart(makers, await sourceWith(), { env: { MADARCH_WIKI_DIAGRAM: 'graphviz' } });
    const handled = await part.diagrams(new Request(`http://127.0.0.1:1/api/graph/diagrams?id=${encodeURIComponent(fx.shop.id)}`));
    expect(handled.response.status).toBe(500);
    expect((await handled.response.json() as { message: string }).message).toBe('unknown wiki diagram format "graphviz": allowed formats are "likec4", "mermaid" and "archify" (MADARCH_WIKI_DIAGRAM)');
    expect(lines.some((line) => line.includes('graphviz'))).toBe(true);
  });

  test('a document route names what it is missing: no id, no type, a type the seven do not hold', async () => {
    const part = createGraphDiagramsPart(makers, await sourceWith(), { env: {} });
    for (const [query, field] of [['', 'id'], ['?id=module:1', 'type'], ['?id=module:1&type=activity', 'type']] as const) {
      const handled = await part.archify(new Request(`http://127.0.0.1:1/api/graph/archify${query}`));
      expect(handled.response.status).toBe(400);
      expect((await handled.response.json() as { error: { field: string } }).error.field).toBe(field);
    }
  });
});
