/**
 * The diagram route (decision 0036, sections 7 and 8; capability views, one-view): the same picture for the same graph
 * revision, in three formats — Mermaid's source, LikeC4's workspace with its laid-out view, archify's self-contained
 * page — and the MCP tool answers through the same function. The graph is a stub here: the route's own refusals and the
 * renderers are what is checked, and the walk on a filled product checks the read.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiagramNeighbourhood } from '../src/graph/graphql-read.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
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
  groups: [{ relation: 'codeContains', side: 'out', kind: 'code.file', total: 2, nodes: ['2', '3'] }],
  kindWords: new Map([['code.file', 'Файлы']]),
  kindPages: new Map(),
  labels: new Map([['1', 'repo'], ['2', 'a.ts'], ['3', 'b.ts']]),
  truncated: false,
};

const product = { diagramNeighbourhood: async () => neighbourhood } as unknown as KnowledgeProduct;

test('LikeC4 shows a self relation through another occurrence linked to the same real entity', async () => {
  const self: DiagramNeighbourhood = {
    ...neighbourhood,
    nodes: new Map([['1', repository as never]]),
    groups: [{ relation: 'code.imports', label: 'импортирует', side: 'out', kind: 'code.repository', total: 1, nodes: ['1'], canonicalLabel: true }],
    links: [{ from: '1', to: '1', relation: 'code.imports' }],
  };
  const held = { diagramNeighbourhood: async () => self } as unknown as KnowledgeProduct;
  const answer = await renderDiagram(held, { entity: '1', format: 'likec4' });
  if (!('body' in answer)) throw new Error(JSON.stringify(answer));
  const body = answer.body as { workspace: string; links: Record<string, string>; view: { views: Record<string, { edges: { label: string }[] }> } };
  expect(body.workspace).toContain('n0 -> n1 "импортирует"');
  expect(body.view.views['index']!.edges.map(edge => edge.label)).toContain('импортирует');
  expect(body.links).toEqual({ n0: '/e/code.repository/1', n1: '/e/code.repository/1' });
  const mermaid = await renderDiagram(held, { entity: '1', format: 'mermaid' });
  if (!('body' in mermaid)) throw new Error(JSON.stringify(mermaid));
  expect(mermaid.body['source']).toContain('n0 -->|"импортирует"| n0');
});

test('the Mermaid format answers the server\'s source with a click per node that has a page', async () => {
  const answer = await renderDiagram(product, { entity: '1', format: 'mermaid' });
  if (!('body' in answer)) throw new Error('the Mermaid answer is not JSON');
  const body = answer.body as { source: string; folded: number };
  expect(body.source).toStartWith('%%{init');
  expect(body.source).toContain('flowchart LR');
  // One line per relation of the root: the read counts the groups, so each pair keeps its own line.
  expect(body.source.match(/-->/gu)?.length).toBeGreaterThanOrEqual(2);
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
  // The first archify answer may pay the drawing process's own start; the guard is for that, not for the page.
  const first = await renderDiagram(product, { entity: '1', format: 'archify' });
  const answer = 'html' in first ? first : await renderDiagram(product, { entity: '1', format: 'archify' });
  if (!('html' in answer)) throw new Error(`the archify answer is not HTML: ${JSON.stringify(answer).slice(0, 400)}`);
  expect(answer.html.toLowerCase()).toContain('<!doctype html');
  expect(answer.html).toContain('data-node-id');
  expect(answer.html).toContain('/e/code.file/2');
  expect(answer.html).toContain("madarch:'open'");
}, 60_000);

test('every diagram link stands under the product base the request came in on', async () => {
  // A products-home server answers a wiki under /products/<folder>/, so a node's page must carry that prefix in all
  // three formats; without it the server answers a different address (madarch-64o5.98).
  const base = '/products/shop';
  const mermaid = await renderDiagram(product, { entity: '1', format: 'mermaid', base });
  if (!('body' in mermaid)) throw new Error('the Mermaid answer is not JSON');
  const source = (mermaid.body as { source: string }).source;
  expect(source).toContain(`click n0 href "${base}/e/code.repository/1"`);
  expect(source).toContain(`click n1 href "${base}/e/code.file/2"`);
  const likec4 = await renderDiagram(product, { entity: '1', format: 'likec4', base });
  if (!('body' in likec4)) throw new Error('the LikeC4 answer is not JSON');
  expect((likec4.body as { links: Record<string, string> }).links['n1']).toBe(`${base}/e/code.file/2`);
  const archify = await renderDiagram(product, { entity: '1', format: 'archify', base });
  if (!('html' in archify)) throw new Error('the archify answer is not HTML');
  expect(archify.html).toContain(`${base}/e/code.file/2`);
  // The folded node opens the list under the same prefix.
  const folded = await renderDiagram({ ...(product as object), diagramNeighbourhood: async () => ({ ...neighbourhood, kindPages: new Map([['code.file', '/e/catalogue/x']]) }) } as unknown as KnowledgeProduct, { entity: '1', format: 'mermaid', base, aggregateAbove: 1 });
  if (!('body' in folded)) throw new Error('the folded answer is not JSON');
  expect((folded.body as { source: string }).source).toContain(`click n1 href "${base}/e/catalogue/x"`);
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
  expect(body.source).toContain('Файлы · 2');
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


test('the archify renderer is taken from the vendor tree and run from the scratch folder', async () => {
  const { archifyVendorFolder, ARCHIFY_RENDERER } = await import('../src/render/archify-vendor.js');
  const { archifyDocument, diagramGraphOf, likec4PictureOf, renderArchify } = await import('../src/render/diagram.js');
  const { existsSync } = await import('node:fs');
  const vendor = archifyVendorFolder();
  if (vendor === undefined) throw new Error('no vendor folder holds the archify renderer');
  expect(existsSync(join(vendor, ...ARCHIFY_RENDERER))).toBe(true);
  const graph = diagramGraphOf(neighbourhood, 1, 12);
  const document = archifyDocument(graph, await likec4PictureOf(graph));
  let copied = false;
  const page = await renderArchify(document, graph, { started: (_pid, folder) => { copied = existsSync(join(folder, 'archify', 'renderers', 'architecture', 'render-architecture.mjs')) && existsSync(join(folder, 'archify', 'assets', 'template.html')); } });
  expect(copied).toBe(true);
  expect(page).toContain('data-node-id');
}, 60_000);

test('an archify failure answers one sentence in the reader\'s language, never JSON or a bundle path', async () => {
  const { createKnowledgePart } = await import('../src/server/knowledge.js');
  const folder = mkdtempSync(join(tmpdir(), 'madarch-diagram-failure-'));
  const makers = {
    json: (status: number, body: unknown) => Response.json(body, { status }),
    refused: (status: number, error: Record<string, unknown>) => ({ response: Response.json({ error }, { status }) }),
    errorLog: () => undefined,
  };
  try {
    const missing = { ...(product as object), folder, diagramNeighbourhood: async () => undefined } as unknown as KnowledgeProduct;
    const part = createKnowledgePart(makers as never, missing, () => [], {});
    const ru = (await part.diagram(new Request('http://localhost/render/diagram?entity=nope&format=archify&lang=ru'))).response;
    expect(ru.headers.get('content-type')).toContain('text/html');
    const ruText = await ru.text();
    expect(ruText).toContain('archify не смог нарисовать эту диаграмму.');
    expect(ruText).not.toContain('{"');
    expect(ruText).not.toContain('$bunfs');
    const en = await (await part.diagram(new Request('http://localhost/render/diagram?entity=nope&format=archify&lang=en'))).response.text();
    expect(en).toContain('archify could not draw this diagram.');
    // Mermaid and LikeC4 stay JSON: the page reads their code and says the failure in its own words.
    const json = (await part.diagram(new Request('http://localhost/render/diagram?entity=nope&format=mermaid&lang=ru'))).response;
    expect(json.headers.get('content-type')).toContain('application/json');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a CPU-looping renderer is killed by its own deadline while another diagram remains responsive', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-render-loop-'));
  const looping = join(folder, 'loop.ts');
  const marker = join(folder, 'started');
  writeFileSync(looping, `import { writeFileSync } from 'node:fs'; self.onmessage = () => { writeFileSync(${JSON.stringify(marker)}, 'started'); while (true) {} };`);
  try {
    const started = performance.now();
    const stuck = renderDiagram(product, { entity: '1', format: 'mermaid' }, { deadlineMs: 700, workerUrl: new URL(`file://${looping}`) });
    const other = await renderDiagram(product, { entity: '1', format: 'mermaid' });
    expect('body' in other).toBe(true);
    expect(performance.now() - started).toBeLessThan(650);
    const stopped = await stuck;
    expect(stopped).toMatchObject({ code: 'TIMEOUT' });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(await Bun.file(marker).text()).toBe('started');
    // A timed-out worker must not kill or consume a subsequent request's answer.
    expect('body' in await renderDiagram(product, { entity: '1', format: 'mermaid' })).toBe(true);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 10_000);

test('the render deadline includes the neighbourhood read', async () => {
  const unread = { diagramNeighbourhood: async () => await new Promise(() => undefined) } as unknown as KnowledgeProduct;
  expect(await renderDiagram(unread, { entity: '1', format: 'mermaid' }, { deadlineMs: 30 })).toMatchObject({ code: 'TIMEOUT' });
});


test('a cached picture is reused only for the exact freshly read graph', async () => {
  let label = 'before';
  const changing = { diagramNeighbourhood: async () => ({ ...neighbourhood, labels: new Map(neighbourhood.labels).set('1', label) }) } as unknown as KnowledgeProduct;
  const before = await renderDiagram(changing, { entity: '1', format: 'mermaid' });
  label = 'after';
  const after = await renderDiagram(changing, { entity: '1', format: 'mermaid' });
  expect(after).not.toEqual(before);
  expect(await renderDiagram(changing, { entity: '1', format: 'mermaid' })).toEqual(after);
});


test('read budgets default to thirty seconds and accept server or environment settings', () => {
  const getter = Object.getOwnPropertyDescriptor(KnowledgeProduct.prototype, 'readDeadlineMs')!.get!;
  expect(getter.call({ options: {}, env: {} })).toBe(30_000);
  expect(getter.call({ options: { readDeadlineMs: 450 }, env: {} })).toBe(450);
  expect(getter.call({ options: {}, env: { MADARCH_READ_DEADLINE_MS: '650' } })).toBe(650);
  expect(() => getter.call({ options: { readDeadlineMs: -1 }, env: {} })).toThrow('positive');
});

 test('unsupported diagram depth is BAD_INPUT before reading, through the route and MCP', async () => {
  let reads = 0;
  const held = { folder: '/tmp/no-manifest', diagramNeighbourhood: async () => { reads += 1; return neighbourhood; } } as unknown as KnowledgeProduct;
  expect(await renderDiagram(held, { entity: '1', format: 'mermaid', depth: 2 })).toMatchObject({ status: 400, code: 'BAD_INPUT' });
  const { createKnowledgePart } = await import('../src/server/knowledge.js');
  const part = createKnowledgePart({ json: (status: number, body: unknown) => Response.json(body, { status }), refused: (status: number, error: unknown) => ({ response: Response.json({ error }, { status }) }), errorLog: () => undefined }, held, () => [], {});
  const route = await part.diagram(new Request('http://localhost/render/diagram?entity=1&format=mermaid&depth=2'));
  expect(route.response.status).toBe(400);
  const mcp = await callProductTool(held, {} as WriteSource, 'render_diagram', { entity: '1', format: 'mermaid', depth: 2 });
  expect(mcp.isError).toBe(true);
  expect(reads).toBe(0);
});

test('the requested fold bound reaches the neighbourhood reader', async () => {
  let sample: number | undefined;
  const held = { diagramNeighbourhood: async (_id: string, _depth: number, _lang: string | undefined, first?: number) => { sample = first; return neighbourhood; } } as unknown as KnowledgeProduct;
  const answer = await renderDiagram(held, { entity: '1', format: 'mermaid', aggregateAbove: 30 });
  expect('body' in answer).toBe(true);
  expect(sample).toBe(30);
});
