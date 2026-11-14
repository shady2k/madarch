/**
 * The diagram route (decision 0036, sections 7 and 8; capability views, one-view): the same picture for the same graph
 * revision, in three formats — Mermaid's source, LikeC4's workspace with its laid-out view, archify's self-contained
 * page — and the MCP tool answers through the same function. The graph is a stub here: the route's own refusals and the
 * renderers are what is checked, and the walk on a filled product checks the read.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiagramNeighbourhood } from '../src/graph/graphql-read.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';
import { renderDiagram } from '../src/render/diagram-render.js';
import { callProductTool } from '../src/mcp/authored.js';
import type { WriteSource } from '../src/graph/graph-writes.js';

/** One entity of the stub graph: a repository and two files that contain edges reach. */
function entity(uid: string, kind: string): Record<string, unknown> {
  return { nodeId: uid, uid, kind, key: {}, typeName: kind.split('.').map((part) => part[0]!.toUpperCase() + part.slice(1)).join('') };
}

const repository = entity('1', 'code.repository');
const one = entity('2', 'code.file');
const two = entity('3', 'code.file');

const neighbourhood: DiagramNeighbourhood = {
  entity: repository as never,
  nodes: new Map([[repository['uid'] as string, repository as never], [one['uid'] as string, one as never], [two['uid'] as string, two as never]]),
  links: [
    { from: '1', to: '2', relation: 'codeContains' },
    { from: '1', to: '3', relation: 'codeContains' },
    { from: '2', to: '1', relation: 'codeContainsOf' },
  ],
  labels: new Map([['1', 'repo'], ['2', 'a.ts'], ['3', 'b.ts']]),
  truncated: false,
};

const product = { diagramNeighbourhood: async () => neighbourhood } as unknown as KnowledgeProduct;

test('the Mermaid format answers the server\'s source with a click per node that has a page', async () => {
  const answer = await renderDiagram(product, { entity: '1', format: 'mermaid' });
  if (!('body' in answer)) throw new Error('the Mermaid answer is not JSON');
  const body = answer.body as { source: string; folded: number };
  expect(body.source).toStartWith('%%{init');
  expect(body.source).toContain('flowchart LR');
  // An edge and its inverse are one line: the pair reads both ways, and each other pair keeps its own line.
  expect(body.source.match(/<-->/gu)).toHaveLength(1);
  expect(body.source.match(/^  n\d+ (?:<-->|-->)\|/gmu)).toHaveLength(2);
  expect(body.source).toContain('click n0 href "/e/code.repository/1"');
  expect(body.source).toContain('click n1 href "/e/code.file/2"');
});

test('the LikeC4 format answers the workspace and its laid-out view, with each node\'s page', async () => {
  const answer = await renderDiagram(product, { entity: '1', format: 'likec4' });
  if (!('body' in answer)) throw new Error('the LikeC4 answer is not JSON');
  const body = answer.body as { workspace: string; view: { views?: Record<string, { nodes?: readonly { x?: number }[] }> }; links: Record<string, string> };
  expect(body.workspace).toContain('specification {');
  expect(body.workspace).toContain('view index {');
  expect(body.view.views?.['index']?.nodes?.length).toBe(3);
  expect(body.view.views?.['index']?.nodes?.every((node) => typeof node.x === 'number')).toBe(true);
  expect(body.links['n0']).toBe('/e/code.repository/1');
}, 60_000);

test('the archify format answers its self-contained interactive page, each node carrying the entity\'s page', async () => {
  const answer = await renderDiagram(product, { entity: '1', format: 'archify' });
  if (!('html' in answer)) throw new Error('the archify answer is not HTML');
  expect(answer.html.toLowerCase()).toContain('<!doctype html');
  expect(answer.html).toContain('data-node-id');
  expect(answer.html).toContain('/e/code.file/2');
  expect(answer.html).toContain("madarch:'open'");
}, 60_000);

test('the same graph revision answers the same bytes', async () => {
  const first = await renderDiagram(product, { entity: '1', format: 'mermaid' });
  const second = await renderDiagram(product, { entity: '1', format: 'mermaid' });
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  const firstLike = await renderDiagram(product, { entity: '1', format: 'likec4' });
  const secondLike = await renderDiagram(product, { entity: '1', format: 'likec4' });
  expect(JSON.stringify(firstLike)).toBe(JSON.stringify(secondLike));
}, 60_000);

test('neighbours of one kind above the bound are one node with the count', async () => {
  const answer = await renderDiagram(product, { entity: '1', format: 'mermaid', aggregateAbove: 1 });
  if (!('body' in answer)) throw new Error('the Mermaid answer is not JSON');
  const body = answer.body as { source: string; folded: number };
  expect(body.folded).toBe(2);
  expect(body.source).toContain('code.file<br/>× 2');
});

test('an entity the graph does not hold is refused', async () => {
  const missing = { diagramNeighbourhood: async () => undefined } as unknown as KnowledgeProduct;
  const answer = await renderDiagram(missing, { entity: 'nope', format: 'mermaid' });
  expect(answer).toMatchObject({ status: 404 });
});

test('the MCP tool answers through the same function', async () => {
  const source: WriteSource = { producer: 'test', version: '1' } as unknown as WriteSource;
  const answer = await callProductTool(product, source, 'render_diagram', { entity: '1', format: 'mermaid' });
  expect(answer.isError).toBe(false);
  const held = answer.answer as { format: string; source: string };
  expect(held.format).toBe('mermaid');
  expect(held.source).toContain('flowchart LR');
});

test('an unknown format, a depth below one and a missing entity are refused by the route', async () => {
  const { createKnowledgePart } = await import('../src/server/knowledge.js');
  const makers = {
    json: (status: number, body: unknown) => Response.json(body, { status }),
    refused: (status: number, error: Record<string, unknown>) => ({ response: Response.json({ error }, { status }) }),
    errorLog: () => undefined,
  };
  const folder = mkdtempSync(join(tmpdir(), 'madarch-diagram-refusals-'));
  try {
    const part = createKnowledgePart(makers as never, { ...(product as object), folder } as unknown as KnowledgeProduct, () => [], {});
    const ask = async (query: string): Promise<Response> => {
      const answer = await part.diagram(new Request(`http://localhost/render/diagram?${query}`));
      return answer.response;
    };
    const format = await ask('entity=1&format=svg');
    expect(format.status).toBe(400);
    expect(((await format.json()) as { error: { message: string } }).error.message).toContain('"format" is one of "likec4", "mermaid" and "archify"');
    const depth = await ask('entity=1&format=mermaid&depth=0');
    expect(depth.status).toBe(400);
    expect(((await depth.json()) as { error: { message: string } }).error.message).toContain('"depth" is a whole number of levels, 1 or more');
    const missing = await ask('format=mermaid');
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { message: string } }).error.message).toContain('"entity" is the id of the entity');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
