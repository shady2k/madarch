/**
 * The writer's tools (decision 0032, section 2): the answers a unit asks of its graph — a symbol by
 * name with its code, callers, callees, references and tests; an entity's context in one call; a flow
 * from a route to its tables and events; document sections by intent; the pages already written; one
 * page as Markdown or JSON; and the questions the people were asked — held as the unit's own tools,
 * beside the subgraph each of them is handed and the journal that counts what a call read, could not
 * resolve and produced.
 *
 * The graph here is a stub of the pinned snapshot reader's own reads (`GraphReads`) and the pages a
 * memory sink: no database, no model and no fill, so what is judged is the answer — its evidence, its
 * order, its bounds, its truncation, and the repository and revision it names.
 */
import { describe, expect, test } from 'bun:test';
import { documentAnchors } from '../src/knowledge/anchors.js';
import type { GraphEntity, NeighborEdge, NeighborGroup } from '../src/knowledge/graph-read.js';
import type { Question } from '../src/loop/entities.js';
import {
  AnswerRefusal, CONTEXT_PURPOSES, getContext, getDocumentSections, getPage, getSymbol,
  searchPages, searchQuestions, traceFlow, type GraphReads,
} from '../src/writer/answers.js';
import { memorySink } from '../src/writer/index.js';
import { addCounters, betweenCounters, countersOf, fileJournal, journalOfUnit, NO_COUNTERS, recordOf } from '../src/writer/journal.js';
import { preparedContextPart, productPrompt } from '../src/writer/prompts.js';
import { DEFAULT_UNIT_BOUNDS, UnitTools, WRITER_TOOLS, type PageSink, type UnitSpec } from '../src/writer/tools.js';
import type { GraphView } from '../src/writer/view.js';

// ---- part one: the seven answers themselves -------------------------------------------------
// ---- a stub of the pinned snapshot reader ---------------------------------------------------

interface StubSpan { path: string; lineStart: number; lineEnd: number; byteStart: number; byteEnd: number }
interface StubNode { key: string; kind: string; label: string; properties?: Record<string, unknown>; span?: StubSpan }
interface StubEdge { from: string; to: string; relation: string; properties?: Record<string, unknown>; span?: StubSpan }

const SHOP = 'services/shop/';
const FILES: Record<string, string> = {
  [`${SHOP}src/checkout.ts`]: [
    'export class Checkout {',
    '  pay(order: Order): Promise<Payment> {',
    '    return this.client.charge(order.total);',
    '  }',
    '  refund(order: Order): Promise<void> {',
    '    return this.store.refund(order.id);',
    '  }',
    '}',
    'export function tariffFor(order: Order): number {',
    '  return order.total;',
    '}',
  ].join('\n'),
  [`${SHOP}src/checkout.test.ts`]: ['test(\'pays\', async () => { await new Checkout().pay(order); });'].join('\n'),
  [`${SHOP}package.json`]: '{"name":"shop"}',
  'docs/requirements.md': [
    '# Requirements',
    '',
    '## Qualities',
    '',
    'A payment answer reaches the shopper in two seconds.',
    '',
    '## Checkout',
    '',
    'The shopper pays once per order.',
    '',
    '## Retention',
    '',
    'A receipt is kept for ninety days.',
  ].join('\n'),
  'docs/vision.md': ['# Vision', '', '## Users', '', 'The shopper buys without an account.'].join('\n'),
};

const span = (path: string, lineStart: number, lineEnd: number): StubSpan => ({ path, lineStart, lineEnd, byteStart: lineStart * 10, byteEnd: lineEnd * 10 + 5 });

const NODES: StubNode[] = [
  { key: `code.service:shop`, kind: 'code.service', label: 'shop', properties: { language: 'typescript', frameworks: ['express'] }, span: span(`${SHOP}package.json`, 1, 1) },
  { key: `code.file:${SHOP}src/checkout.ts`, kind: 'code.file', label: 'checkout.ts', span: span(`${SHOP}src/checkout.ts`, 1, 11) },
  { key: `code.file:${SHOP}src/client.ts`, kind: 'code.file', label: 'client.ts', span: span(`${SHOP}src/client.ts`, 1, 5) },
  { key: `code.file:${SHOP}src/store.ts`, kind: 'code.file', label: 'store.ts', span: span(`${SHOP}src/store.ts`, 1, 5) },
  { key: `code.file:${SHOP}src/routes.ts`, kind: 'code.file', label: 'routes.ts', span: span(`${SHOP}src/routes.ts`, 1, 9) },
  { key: `code.file:${SHOP}src/checkout.test.ts`, kind: 'code.file', label: 'checkout.test.ts', span: span(`${SHOP}src/checkout.test.ts`, 1, 1) },
  { key: `code.symbol:${SHOP}src/checkout.ts#Checkout`, kind: 'code.symbol', label: 'Checkout', properties: { symbolKind: 'class', name: 'Checkout', exported: true }, span: span(`${SHOP}src/checkout.ts`, 1, 8) },
  { key: `code.symbol:${SHOP}src/checkout.ts#Checkout.pay`, kind: 'code.symbol', label: 'Checkout.pay', properties: { symbolKind: 'method', name: 'pay', exported: false }, span: span(`${SHOP}src/checkout.ts`, 2, 4) },
  { key: `code.symbol:${SHOP}src/checkout.ts#Checkout.refund`, kind: 'code.symbol', label: 'Checkout.refund', properties: { symbolKind: 'method', name: 'refund', exported: false }, span: span(`${SHOP}src/checkout.ts`, 5, 7) },
  { key: `code.symbol:${SHOP}src/checkout.ts#tariffFor`, kind: 'code.symbol', label: 'tariffFor', properties: { symbolKind: 'function', name: 'tariffFor', exported: true }, span: span(`${SHOP}src/checkout.ts`, 9, 11) },
  { key: `code.symbol:${SHOP}src/client.ts#Client.charge`, kind: 'code.symbol', label: 'Client.charge', properties: { symbolKind: 'method', name: 'charge' }, span: span(`${SHOP}src/client.ts`, 1, 5) },
  { key: `code.symbol:${SHOP}src/store.ts#Store.refund`, kind: 'code.symbol', label: 'Store.refund', properties: { symbolKind: 'method', name: 'refund' }, span: span(`${SHOP}src/store.ts`, 1, 5) },
  { key: `code.table:shop.public.payment`, kind: 'code.table', label: 'public.payment', properties: { name: 'payment', engine: 'postgres' }, span: span('db/schema.sql', 3, 9) },
  { key: 'code.channel:payments', kind: 'code.channel', label: 'payments', span: span('docs/asyncapi.yaml', 4, 9) },
  { key: `code.route:${SHOP}src/routes.ts#POST:/pay`, kind: 'code.route', label: 'POST /pay', properties: { method: 'POST', path: '/pay', middleware: ['auth'] }, span: span(`${SHOP}src/routes.ts`, 4, 4) },
  { key: `code.symbol:${SHOP}src/routes.ts#register`, kind: 'code.symbol', label: 'register', properties: { symbolKind: 'function', name: 'register' }, span: span(`${SHOP}src/routes.ts`, 1, 9) },
  { key: `code.test-case:${SHOP}src/checkout.test.ts#pays`, kind: 'code.test-case', label: 'pays', span: span(`${SHOP}src/checkout.test.ts`, 1, 1) },
  { key: 'code.service:billing', kind: 'code.service', label: 'billing', span: span('services/billing/package.json', 1, 1) },
  { key: `code.symbol:services/billing/src/refund.ts#refund`, kind: 'code.symbol', label: 'refund', properties: { symbolKind: 'function', name: 'refund' }, span: span('services/billing/src/refund.ts', 1, 3) },
];

const EDGES: StubEdge[] = [
  { from: `code.file:${SHOP}src/checkout.ts`, to: `code.symbol:${SHOP}src/checkout.ts#Checkout`, relation: 'code.contains' },
  { from: 'code.service:shop', to: `code.file:${SHOP}src/checkout.ts`, relation: 'code.contains' },
  { from: `code.symbol:${SHOP}src/checkout.ts#Checkout.pay`, to: `code.symbol:${SHOP}src/client.ts#Client.charge`, relation: 'code.calls', properties: { count: 1 }, span: span(`${SHOP}src/checkout.ts`, 3, 3) },
  { from: `code.symbol:${SHOP}src/checkout.ts#Checkout.pay`, to: `code.table:shop.public.payment`, relation: 'code.writes-table', properties: {}, span: span(`${SHOP}src/checkout.ts`, 3, 3) },
  // Two calls at one site are alternatives: the graph holds no order between them.
  { from: `code.symbol:${SHOP}src/checkout.ts#Checkout.refund`, to: `code.symbol:${SHOP}src/store.ts#Store.refund`, relation: 'code.calls', properties: {}, span: span(`${SHOP}src/checkout.ts`, 6, 6) },
  { from: `code.symbol:${SHOP}src/checkout.ts#Checkout.refund`, to: `code.table:shop.public.payment`, relation: 'code.reads-table', properties: {}, span: span(`${SHOP}src/checkout.ts`, 6, 6) },
  { from: `code.symbol:${SHOP}src/checkout.ts#Checkout.refund`, to: 'code.channel:payments', relation: 'code.publishes', properties: { topic: 'payments' }, span: span(`${SHOP}src/checkout.ts`, 6, 6) },
  { from: `code.symbol:${SHOP}src/routes.ts#register`, to: `code.symbol:${SHOP}src/checkout.ts#Checkout.pay`, relation: 'code.calls', properties: {}, span: span(`${SHOP}src/routes.ts`, 4, 4) },
  { from: `code.symbol:${SHOP}src/checkout.ts#Checkout.pay`, to: `code.symbol:${SHOP}src/checkout.ts#tariffFor`, relation: 'code.calls', properties: {}, span: span(`${SHOP}src/checkout.ts`, 3, 3) },
  { from: `code.test-case:${SHOP}src/checkout.test.ts#pays`, to: `code.symbol:${SHOP}src/checkout.ts#Checkout.pay`, relation: 'code.tests', properties: {}, span: span(`${SHOP}src/checkout.test.ts`, 1, 1) },
  { from: `code.symbol:${SHOP}src/checkout.ts#tariffFor`, to: `code.table:shop.public.payment`, relation: 'code.reads-table', properties: {} },
];

function entityOf(node: StubNode): GraphEntity {
  return {
    key: node.key,
    kind: node.kind,
    label: node.label,
    properties: { recordKey: node.key, ...(node.properties ?? {}) },
    nodeIds: [node.key],
    scope: '1',
    ...(node.span === undefined ? {} : { span: node.span }),
  };
}

const at = '2026-10-20T10:00:00.000000Z';

function stubGraph(nodes: StubNode[] = NODES, edges: StubEdge[] = EDGES, files: Record<string, string> = FILES): GraphReads {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const others = (key: string, relation: string, direction: 'out' | 'in'): { edge: StubEdge; other: StubNode }[] =>
    edges
      .filter((edge) => edge.relation === relation && (direction === 'out' ? edge.from : edge.to) === key)
      .flatMap((edge) => {
        const other = byKey.get(direction === 'out' ? edge.to : edge.from);
        return other === undefined ? [] : [{ edge, other }];
      });
  return {
    at,
    entity: async (key) => {
      const node = byKey.get(key);
      return node === undefined ? undefined : entityOf(node);
    },
    list: async (kind, options) => {
      const wanted = options.q?.toLowerCase();
      const rows = nodes.filter((node) => node.kind === kind && (wanted === undefined || node.key.toLowerCase().includes(wanted) || node.label.toLowerCase().includes(wanted))).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return { rows: rows.slice(0, options.limit).map(entityOf), total: rows.length };
    },
    byPrefix: async (kind, prefix, limit) => {
      const rows = nodes.filter((node) => node.kind === kind && node.key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : 1));
      return { rows: rows.slice(0, limit).map(entityOf), total: rows.length };
    },
    edges: async (entity, relation, direction, limit) => {
      const found = others(entity.key, relation, direction);
      const distinct = [...new Map(found.map((one) => [one.other.key, one])).values()];
      const rows: NeighborEdge[] = distinct.slice(0, limit).map((one) => ({
        relation,
        direction,
        other: entityOf(one.other),
        properties: one.edge.properties ?? {},
        position: null,
        ...(one.edge.span === undefined ? {} : { span: one.edge.span }),
      }));
      return { total: distinct.length, rows };
    },
    neighbors: async (entity, options) => {
      const groups: NeighborGroup[] = [];
      const directions: ('out' | 'in')[] = options.direction === 'both' ? ['in', 'out'] : [options.direction];
      for (const direction of directions) {
        const relations = [...new Set(edges.filter((edge) => (direction === 'out' ? edge.from : edge.to) === entity.key).map((edge) => edge.relation))].sort();
        for (const relation of relations) {
          const found = others(entity.key, relation, direction);
          const distinct = [...new Map(found.map((one) => [one.other.key, one])).values()].sort((a, b) => (a.other.key < b.other.key ? -1 : 1));
          groups.push({
            relation,
            direction,
            total: distinct.length,
            edges: found.length,
            rows: distinct.slice(0, options.limit).map((one) => ({ entity: entityOf(one.other), edges: 1, ...(one.edge.span === undefined ? {} : { span: one.edge.span }) })),
          });
        }
      }
      return groups;
    },
    documentPaths: async () => Object.keys(files).filter((path) => path.endsWith('.md')).sort(),
    fileText: async (path) => files[path] ?? null,
  };
}

const graph = stubGraph();

describe('get_symbol answers with the code, not with a whole file', () => {
  test('one declaration: its signature, its lines, its owner, its callers, its callees, its references and its tests', async () => {
    const answer = await getSymbol(graph, { name: 'Checkout.pay' });
    const selected = answer.body['selected'] as Record<string, unknown>;
    expect(selected['key']).toBe(`code.symbol:${SHOP}src/checkout.ts#Checkout.pay`);
    expect(selected['signature']).toMatchObject({ text: '  pay(order: Order): Promise<Payment> {', lineStart: 2, lineEnd: 2, cut: true });
    expect(selected['span']).toMatchObject({ path: `${SHOP}src/checkout.ts`, lineStart: 2, lineEnd: 4 });
    expect(selected['owner']).toMatchObject({ key: `code.symbol:${SHOP}src/checkout.ts#Checkout`, symbolKind: 'class' });
    expect(selected['service']).toMatchObject({ key: 'code.service:shop' });
    expect(answer.body['callers']).toEqual({ total: 1, shown: [{ key: `code.symbol:${SHOP}src/routes.ts#register`, kind: 'code.symbol', label: 'register', site: { path: `${SHOP}src/routes.ts`, lineStart: 4, lineEnd: 4 } }] });
    expect((answer.body['callees'] as { shown: { key: string }[] }).shown.map((one) => one.key)).toEqual([`code.symbol:${SHOP}src/client.ts#Client.charge`, `code.symbol:${SHOP}src/checkout.ts#tariffFor`]);
    expect((answer.body['tests'] as { shown: { key: string }[] }).shown.map((one) => one.key)).toEqual([`code.test-case:${SHOP}src/checkout.test.ts#pays`]);
    expect((answer.body['references'] as { total: number }).total).toBe(0);
    // The evidence and the source bytes it was shown: the evidence is the graph keys, sorted.
    expect(answer.evidence).toContain(`code.symbol:${SHOP}src/checkout.ts#Checkout.pay`);
    expect(answer.evidence).toContain(`code.file:${SHOP}src/checkout.ts`);
    // Every ground is named once: the tool that serves the answer orders them by code point.
    expect(new Set(answer.evidence).size).toBe(answer.evidence.length);
    expect(answer.reads).toEqual([{ path: `${SHOP}src/checkout.ts`, startLine: 2, endLine: 2, bytes: Buffer.byteLength('  pay(order: Order): Promise<Payment> {', 'utf8') + 1 }]);
    expect(answer.truncated).toBe(false);
  });

  test('a name that several declarations have lists the candidates and selects nothing', async () => {
    const answer = await getSymbol(graph, { name: 'refund' });
    expect(answer.body['selected']).toBeNull();
    const candidates = answer.body['candidates'] as { key: string }[];
    expect(candidates.map((one) => one.key).sort()).toEqual([`code.symbol:${SHOP}src/checkout.ts#Checkout.refund`, `code.symbol:${SHOP}src/store.ts#Store.refund`, 'code.symbol:services/billing/src/refund.ts#refund'].sort());
    expect(answer.body['total']).toBe(3);
    expect(String(answer.body['note'])).toContain('pass "service" or the symbol\'s key');
  });

  test('a service narrows the candidates to its own folder, and a wrong service is refused with the services named', async () => {
    const narrowed = await getSymbol(graph, { name: 'refund', service: 'shop' });
    expect(narrowed.body['selected']).toBeNull();
    expect(narrowed.body['total']).toBe(2);
    expect((narrowed.body['candidates'] as { key: string }[]).map((one) => one.key)).not.toContain('code.symbol:services/billing/src/refund.ts#refund');
    const elsewhere = await getSymbol(graph, { name: 'refund', service: 'billing' });
    expect((elsewhere.body['selected'] as { key: string }).key).toBe('code.symbol:services/billing/src/refund.ts#refund');
    await expect(getSymbol(graph, { name: 'refund', service: 'nothing' })).rejects.toThrow(/the graph has no service "nothing"; the services are code\.service:billing, code\.service:shop/);
  });

  test('a name the graph does not hold is refused in words, with how many declarations were searched', async () => {
    const refusal = await getSymbol(graph, { name: 'chargeEverything' }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(AnswerRefusal);
    expect((refusal as AnswerRefusal).code).toBe('no-such-symbol');
    expect((refusal as AnswerRefusal).message).toContain('the graph holds no symbol named "chargeEverything"');
  });

  test('a symbol whose file the graph holds no text for says so instead of inventing a signature', async () => {
    const answer = await getSymbol(stubGraph(NODES, EDGES, {}), { name: `code.symbol:${SHOP}src/checkout.ts#tariffFor` });
    expect((answer.body['selected'] as Record<string, unknown>)['signature']).toBeNull();
    expect(answer.unresolved.join(' ')).toContain('the graph holds no text for');
  });
});

describe('get_context answers one entity in one call, for the purpose it is asked', () => {
  test('a domain context reads what holds the service, what it reaches, and the document sections that name it', async () => {
    const answer = await getContext(graph, { entity: 'code.service:shop', purpose: 'domain' });
    const relations = answer.body['relations'] as { relation: string; direction: string; total: number; entities: { key: string }[] }[];
    expect(relations[0]).toMatchObject({ relation: 'code.contains', direction: 'out', total: 1 });
    expect(relations[0]!.entities.map((one) => one.key)).toEqual([`code.file:${SHOP}src/checkout.ts`]);
    expect(answer.body['entity']).toMatchObject({ key: 'code.service:shop', kind: 'code.service', service: { key: 'code.service:shop' } });
    const documents = answer.body['documents'] as { sections: { target: string }[]; scanned: number } | undefined;
    expect(documents).not.toBeUndefined();
    // The documents that name the service are found by its own name, and every section is a ground a page may use.
    expect(documents!.sections.map((one) => one.target)).toContain('doc:docs/requirements.md#qualities');
    expect(documents!.sections.every((one) => one.target.startsWith('doc:'))).toBe(true);
    // Both documents of the stub name the service ("the shopper" holds "shop"), and both are searched.
    expect(documents!.scanned).toBe(2);
    expect(answer.evidence).toContain('doc:docs/requirements.md#qualities');
  });

  test('an implementation context reads the callers and the callees, not the documents', async () => {
    const answer = await getContext(graph, { entity: `code.symbol:${SHOP}src/checkout.ts#Checkout.pay`, purpose: 'implementation' });
    const relations = answer.body['relations'] as { relation: string; direction: string }[];
    expect(relations[0]).toMatchObject({ relation: 'code.calls', direction: 'in' });
    expect(relations[1]).toMatchObject({ relation: 'code.calls', direction: 'out' });
    expect(answer.body['documents']).toBeUndefined();
  });

  test('an overview context holds the counts and no rows at all', async () => {
    const answer = await getContext(graph, { entity: 'code.service:shop', purpose: 'overview' });
    for (const relation of answer.body['relations'] as { entities: unknown[] }[]) expect(relation.entities).toEqual([]);
  });

  test('an entity the graph does not hold is refused, and a page or a document is pointed at its own tool', async () => {
    await expect(getContext(graph, { entity: 'code.service:nowhere', purpose: 'domain' })).rejects.toThrow(/the graph has no entity with the key "code.service:nowhere"/);
    await expect(getContext(graph, { entity: 'code.service:nowhere', purpose: 'domain' })).rejects.toThrow(/A page is read with get_page, a document section with get_document_sections/);
  });
});

describe('trace_flow goes from a route to the tables and events, and never shows reachability as order', () => {
  test('a route: the function that serves it, what it calls, and the table it reaches', async () => {
    const answer = await traceFlow(graph, { entry: 'POST /pay', targets: ['table', 'event', 'external'], depth: 4, maxSteps: 60 });
    expect(answer.body['entry']).toMatchObject({ key: `code.route:${SHOP}src/routes.ts#POST:/pay`, method: 'POST', path: '/pay' });
    expect(answer.body['handlers']).toEqual([`code.symbol:${SHOP}src/checkout.ts#Checkout.pay`]);
    const steps = answer.body['steps'] as { to: { key: string }; kind: string; depth: number; order: string; site: { lineStart: number } | null }[];
    // The handler's own calls are read before the calls of what it calls: a flow is a walk by depth, and within a
    // declaration its order is the site the graph read each call at.
    expect(steps.map((step) => `${step.kind} ${step.to.key}`)).toEqual([
      `call code.symbol:${SHOP}src/checkout.ts#tariffFor`,
      `call code.symbol:${SHOP}src/client.ts#Client.charge`,
      `table-write code.table:shop.public.payment`,
      `table-read code.table:shop.public.payment`,
    ]);
    expect(steps.map((step) => step.depth)).toEqual([0, 0, 0, 1]);
    expect(steps.map((step) => step.order)).toEqual(['source', 'source', 'source', 'unknown']);
    // A target reached twice is one target at its nearest distance, not two.
    expect(answer.body['found']).toEqual([{ kind: 'table', key: 'code.table:shop.public.payment', label: 'public.payment', hops: 1 }]);
    expect(String(answer.body['orderNote'])).toContain('depth is how many calls away a step is, not an order');
    // The fourth step's site is not in the graph: the answer says so and is cut.
    expect(answer.unresolved.join(' ')).toContain('1 steps have no site in the graph');
    expect(answer.truncated).toBe(true);
  });

  test('a function as the entry: its calls, its table and its channel, all at one depth in the order of their sites', async () => {
    const answer = await traceFlow(graph, { entry: `code.symbol:${SHOP}src/checkout.ts#Checkout.refund`, targets: ['table', 'event'], depth: 2, maxSteps: 60 });
    const steps = answer.body['steps'] as { to: { key: string }; depth: number; order: string }[];
    expect(steps.every((step) => step.depth === 0 && step.order === 'source')).toBe(true);
    expect((answer.body['found'] as { kind: string }[]).map((one) => one.kind)).toEqual(['event', 'table']);
    expect(answer.truncated).toBe(false);
    expect(answer.unresolved).toEqual([]);
  });

  test('an edge the graph holds no site for is marked unknown, and the answer says its order is unknown', async () => {
    const answer = await traceFlow(graph, { entry: `code.symbol:${SHOP}src/checkout.ts#tariffFor`, targets: ['table'], depth: 2, maxSteps: 60 });
    const steps = answer.body['steps'] as { order: string; note?: string }[];
    expect(steps[0]).toMatchObject({ order: 'unknown' });
    expect(steps[0]!.note).toContain('the graph holds no site for this edge');
    expect(answer.truncated).toBe(true);
    expect(answer.unresolved.join(' ')).toContain('1 steps have no site in the graph');
  });

  test('a route whose registration reaches no function is refused rather than shown as a flow of nothing', async () => {
    const nodes = NODES.filter((node) => !node.key.endsWith('#register'));
    const edges = EDGES.filter((edge) => !edge.from.endsWith('#register'));
    const refusal = await traceFlow(stubGraph(nodes, edges), { entry: 'POST /pay', targets: ['table'], depth: 2, maxSteps: 20 }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(AnswerRefusal);
    expect((refusal as AnswerRefusal).code).toBe('no-handler');
  });

  test('a depth bound stops the walk and says how many calls it did not follow', async () => {
    const answer = await traceFlow(graph, { entry: `code.symbol:${SHOP}src/routes.ts#register`, targets: ['table'], depth: 1, maxSteps: 60 });
    expect(answer.body['steps']).toHaveLength(1);
    expect(answer.body['stopped']).toMatchObject({ byDepth: 1 });
    expect(answer.truncated).toBe(true);
  });

  test('an entry that is not a route or a function is refused in words', async () => {
    await expect(traceFlow(graph, { entry: 'code.table:shop.public.payment', targets: ['table'], depth: 2, maxSteps: 20 })).rejects.toThrow(/a flow starts at a code\.route or a code\.symbol declaration/);
  });
});

describe('get_document_sections finds a section by what it says, numbered or not', () => {
  test('a section without a number is found, and its target is an anchor the writer accepts', async () => {
    const answer = await getDocumentSections(graph, { intent: 'payment answer reaches the shopper' });
    const sections = answer.body['sections'] as { target: string; path: string; anchor: string; heading: string; lineStart: number }[];
    expect(sections.length).toBeGreaterThan(0);
    expect(sections[0]).toMatchObject({ path: 'docs/requirements.md', anchor: 'qualities', heading: 'Qualities' });
    expect(sections[0]!.target).toBe('doc:docs/requirements.md#qualities');
    // The anchor is one of the document's own anchors: a page may ground on it.
    expect(documentAnchors(FILES['docs/requirements.md']!)).toContain(sections[0]!.anchor);
    expect(sections[0]!.lineStart).toBe(3);
    expect(answer.truncated).toBe(false);
  });

  test('a scope reads only the documents under it', async () => {
    const answer = await getDocumentSections(graph, { intent: 'shopper', scope: 'docs/vision.md' });
    const sections = answer.body['sections'] as { path: string }[];
    expect([...new Set(sections.map((one) => one.path))]).toEqual(['docs/vision.md']);
    expect((await getDocumentSections(graph, { intent: 'shopper', scope: 'docs' })).body['documents']).toMatchObject({ held: 2 });
  });

  test('a scope the graph holds no document for is refused with the documents named', async () => {
    await expect(getDocumentSections(graph, { intent: 'shopper', scope: 'notes' })).rejects.toThrow(/the graph holds no Markdown document under "notes"/);
  });
});

describe('the pages already written', () => {
  const pages = (): PageSink => {
    const sink = memorySink();
    sink.pages.set('docs/product.md', ['---', 'id: product:shop', 'kind: product', 'title: Shop', 'producer: agent', '---', '', '## What it is', '', 'The shop sells goods.[^a]', '', '[^a]: [Vision](madarch:doc:docs/vision.md#users)'].join('\n'));
    sink.pages.set('docs/domains/payments.md', ['---', 'id: domain:payments', 'kind: domain', 'title: Payments', 'producer: agent', '---', '', '## How payments work', '', 'A payment is taken once.[^a]', '', '[^a]: [UC-2](madarch:doc:docs/requirements.md#checkout)'].join('\n'));
    return sink;
  };

  test('search_pages finds a page by a word and names the line that holds it', async () => {
    const answer = await searchPages(pages(), { text: 'payments', limit: 10 });
    const found = answer.body['pages'] as { path: string; id: string; matches: { line: number; text: string }[] }[];
    expect(found.map((one) => one.path)).toEqual(['docs/domains/payments.md']);
    expect(found[0]!.id).toBe('domain:payments');
    expect(found[0]!.matches[0]).toMatchObject({ line: 8, text: '## How payments work' });
    expect(answer.evidence).toEqual(['docs/domains/payments.md']);
  });

  test('search_pages says when no page holds the words, naming the pages it read', async () => {
    const answer = await searchPages(pages(), { text: 'invoices', limit: 10 });
    expect(answer.body['pages']).toEqual([]);
    expect(answer.unresolved.join(' ')).toContain('no page of the 2 read holds "invoices"');
  });

  test('get_page as Markdown and as JSON: the statements, with the grounds of each', async () => {
    const markdown = await getPage(pages(), { page: 'domain:payments', format: 'md' });
    expect(markdown.body['path']).toBe('docs/domains/payments.md');
    expect(String(markdown.body['text'])).toContain('A payment is taken once.[^a]');
    const json = await getPage(pages(), { page: 'docs/domains/payments.md', format: 'json' });
    const statements = json.body['statements'] as { id: string; grounds: string[] }[];
    expect(statements).toHaveLength(1);
    expect(statements[0]!.id).toBe('a');
    expect(statements[0]!.grounds).toEqual(['doc:docs/requirements.md#checkout']);
    expect(json.body['frontMatter']).toMatchObject({ id: 'domain:payments', kind: 'domain' });
  });

  test('a page that does not exist is refused with the pages named, and an id no page has is refused by its shape', async () => {
    await expect(getPage(pages(), { page: 'domain:ordering', format: 'md' })).rejects.toThrow(/the product holds no docs\/domains\/ordering\.md; the pages are docs\/domains\/payments\.md, docs\/product\.md/);
    await expect(getPage(pages(), { page: 'nonsense', format: 'md' })).rejects.toThrow(/is no page the writer keeps/);
  });
});

describe('the questions the people were asked', () => {
  const asked = (): Question[] => [
    { slug: 'retention', id: 'question:retention', file: 'docs/questions/retention.md', title: 'How long is a receipt kept?', type: 'gap', status: 'open', about: ['code.table:shop.public.payment'], askedIn: 'domain:payments', askedAt: '2026-10-20T10:00:00.000Z', question: 'How long?', why: 'A reader must know.', sides: [], answer: null, resolvedBy: [], resolvedAt: null, writtenAt: [] },
    { slug: 'timeout', id: 'question:timeout', file: 'docs/questions/timeout.md', title: 'Is the charge timeout intended?', type: 'undocumented', status: 'answered', about: [], askedIn: 'domain:payments', askedAt: '2026-10-20T10:00:00.000Z', question: 'Intended?', why: 'It differs from refunds.', sides: [], answer: { text: 'Yes: the provider retries.', by: { name: 'Ada', email: 'ada@example.test', verified: 'local, not verified' }, at: '2026-10-21T10:00:00.000Z' }, resolvedBy: [], resolvedAt: null, writtenAt: [] },
  ];

  test('open questions by default, the answered ones with their answer when asked for', async () => {
    const open = await searchQuestions(async () => asked(), { includeAnswered: false, limit: 60 });
    expect((open.body['questions'] as { id: string }[]).map((one) => one.id)).toEqual(['question:retention']);
    expect(open.body['held']).toEqual({ open: 1, answered: 1 });
    const all = await searchQuestions(async () => asked(), { includeAnswered: true, limit: 60 });
    expect((all.body['questions'] as { answer: string | null }[]).map((one) => one.answer)).toEqual([null, 'Yes: the provider retries.']);
  });

  test('a text narrows the questions by their title, text or subject', async () => {
    const answer = await searchQuestions(async () => asked(), { text: 'receipt', includeAnswered: true, limit: 60 });
    expect((answer.body['questions'] as { id: string }[]).map((one) => one.id)).toEqual(['question:retention']);
    expect(answer.body['total']).toBe(1);
  });
});

describe('the purposes an answer is read for are the writer\'s own', () => {
  test('every purpose has a plan, and a flow is traced to tables, events or calls out of the service', () => {
    expect([...CONTEXT_PURPOSES]).toEqual(['domain', 'scenario', 'rule', 'decision', 'implementation', 'overview']);
  });
});

// ---- part two: the unit's tools, the subgraph it is handed, and the journal -------------

const TOOL_AT = '2026-10-20T10:00:00.000000Z';
const BASIS = [{ repository: 'shop', commit: 'a'.repeat(40) }];
const FILE = ['export function refund(order: Order) {', '  return order.total;', '}'].join('\n');
const ORDERS = ['export const orders = [];', ''].join('\n');

const toolEntity = (key: string, kind: string, label: string, properties: Record<string, unknown> = {}, span?: GraphEntity['span']): GraphEntity =>
  ({ key, kind, label, properties: { recordKey: key, ...properties }, nodeIds: [key], scope: '1', ...(span === undefined ? {} : { span }) });

const TOOL_NODES: GraphEntity[] = [
  toolEntity('code.service:payments', 'code.service', 'payments', { language: 'typescript' }, { path: 'services/payments/package.json', lineStart: 1, lineEnd: 1, byteStart: 0, byteEnd: 20 }),
  toolEntity('code.file:services/payments/orders.ts', 'code.file', 'orders.ts', {}, { path: 'services/payments/orders.ts', lineStart: 1, lineEnd: 2, byteStart: 0, byteEnd: 40 }),
  toolEntity('code.file:services/payments/refund.ts', 'code.file', 'refund.ts', {}, { path: 'services/payments/refund.ts', lineStart: 1, lineEnd: 3, byteStart: 0, byteEnd: 70 }),
  toolEntity('code.symbol:services/payments/refund.ts#refund', 'code.symbol', 'refund', { symbolKind: 'function', name: 'refund', path: 'services/payments/refund.ts' }, { path: 'services/payments/refund.ts', lineStart: 1, lineEnd: 3, byteStart: 0, byteEnd: 70 }),
  toolEntity('code.table:shop.public.payment', 'code.table', 'public.payment', { name: 'payment' }),
];

function stubReads(): GraphReads {
  const byKey = new Map(TOOL_NODES.map((node) => [node.key, node]));
  const edges: { from: string; to: string; relation: string }[] = [
    { from: 'code.service:payments', to: 'code.file:services/payments/refund.ts', relation: 'code.contains' },
    { from: 'code.symbol:services/payments/refund.ts#refund', to: 'code.table:shop.public.payment', relation: 'code.writes-table' },
  ];
  return {
    at: TOOL_AT,
    entity: async (key) => byKey.get(key),
    list: async (kind, options) => {
      const rows = TOOL_NODES.filter((node) => node.kind === kind && (options.q === undefined || node.key.includes(options.q))).sort((a, b) => (a.key < b.key ? -1 : 1));
      return { rows: rows.slice(0, options.limit), total: rows.length };
    },
    byPrefix: async (kind, prefix, limit) => {
      const rows = TOOL_NODES.filter((node) => node.kind === kind && node.key.startsWith(prefix));
      return { rows: rows.slice(0, limit), total: rows.length };
    },
    edges: async (node, relation, direction, limit) => {
      const found = edges.filter((edge) => edge.relation === relation && (direction === 'out' ? edge.from : edge.to) === node.key).flatMap((edge) => {
        const other = byKey.get(direction === 'out' ? edge.to : edge.from);
        return other === undefined ? [] : [other];
      });
      return { total: found.length, rows: found.slice(0, limit).map((other) => ({ relation, direction, other, properties: {}, position: null })) };
    },
    neighbors: async (node, options) => {
      const groups = [];
      for (const direction of options.direction === 'both' ? ['in', 'out'] as const : [options.direction as 'out' | 'in']) {
        for (const relation of [...new Set(edges.filter((edge) => (direction === 'out' ? edge.from : edge.to) === node.key).map((edge) => edge.relation))].sort()) {
          const found = edges.filter((edge) => edge.relation === relation && (direction === 'out' ? edge.from : edge.to) === node.key);
          groups.push({ relation, direction, total: found.length, edges: found.length, rows: found.slice(0, options.limit).map((edge) => ({ entity: byKey.get(direction === 'out' ? edge.to : edge.from)!, edges: 1 })) });
        }
      }
      return groups;
    },
    documentPaths: async () => ['docs/requirements.md'],
    fileText: async (path) => (path === 'services/payments/refund.ts' ? FILE : path === 'services/payments/orders.ts' ? ORDERS : null),
  };
}

/** The ground resolver a checked page is judged by; the graph keys below are the page's own grounds. */
const KEYS: Record<string, string> = {
  'code.service:payments': 'payments',
  'code.symbol:services/payments/refund.ts#refund': 'refund',
};
const SECTIONS: Record<string, string> = { 'docs/requirements.md#uc-2': 'UC-2' };

function view(read: GraphReads = stubReads()): GraphView {
  return {
    at: TOOL_AT,
    reader: () => undefined,
    fileText: async (path: string) => await read.fileText(path),
    documentPaths: async () => await read.documentPaths(),
    graphKey: async (key: string) => key in KEYS,
    docSection: async (path: string, anchor: string) => `${path}#${anchor}` in SECTIONS,
    sourceName: async () => true,
    nameOf: async (target: { type: string; key?: string; path?: string; anchor?: string }) => (target.type === 'graph' ? KEYS[target.key ?? ''] : target.type === 'doc' ? SECTIONS[`${target.path}#${target.anchor}`] : undefined),
    uniqueRoute: async () => undefined,
    uniqueSymbol: async () => undefined,
  } as unknown as GraphView;
}

const DOMAIN: UnitSpec = { kind: 'domain', id: 'domain:payments', path: 'docs/domains/payments.md', domain: { slug: 'payments', title: 'Payments', summary: 'Payments are taken.', evidence: ['code.service:payments'] } };

function tools(sink: PageSink = memorySink(), read: GraphReads = stubReads(), questions: () => Promise<readonly never[]> = async () => []): UnitTools {
  return new UnitTools(view(read), DOMAIN, sink, [], DEFAULT_UNIT_BOUNDS, BASIS, { reads: read, questions });
}

const PAGE = [
  '---',
  'id: domain:payments',
  'kind: domain',
  'title: Payments',
  'relates:',
  '  - code.service:payments',
  'producer: agent',
  'sources: []',
  '---',
  '',
  '## How payments work',
  '',
  'Payments are taken by the [payments service](madarch:code.service:payments).[^taken]',
  'A refund writes the payment row.[^writes]',
  '',
  '[^taken]: [UC-2](madarch:doc:docs/requirements.md#uc-2)',
  '[^writes]: [refund](madarch:code.symbol:services/payments/refund.ts#refund)',
].join('\n');

describe('a unit holds the tools that answer its questions', () => {
  test('the seven answers are tools, of a product unit and of a domain unit alike', () => {
    const names = WRITER_TOOLS.map((tool) => tool.name);
    for (const name of ['get_symbol', 'get_context', 'trace_flow', 'get_document_sections', 'search_pages', 'get_page', 'search_questions', 'read_file']) expect(names).toContain(name);
    const held = tools().tools.map((tool) => tool.name);
    for (const name of ['get_symbol', 'get_context', 'trace_flow', 'get_document_sections', 'search_pages', 'get_page', 'search_questions']) expect(held).toContain(name);
    // A domain unit writes no domains: the product unit's write_page takes them, and its own is the only difference.
    const write = tools().tools.find((tool) => tool.name === 'write_page')!;
    expect(JSON.stringify(write.inputSchema)).not.toContain('domains');
  });

  test('every answer names the repository, the revision and the instant it was read at, with its evidence and its cuts', async () => {
    const session = tools();
    const answer = await session.call('get_symbol', { name: 'refund' });
    expect(answer.isError).toBe(false);
    const held = answer.answer as Record<string, unknown>;
    expect(held['source']).toEqual({ repositories: [{ repository: 'shop', commit: 'a'.repeat(40) }], at: TOOL_AT });
    expect(held['evidence']).toEqual(['code.file:services/payments/refund.ts', 'code.service:payments', 'code.symbol:services/payments/refund.ts#refund']);
    expect(held['truncated']).toBe(false);
    expect(answer.counters?.evidence).toBe(3);
  });

  test('a read the same lines twice is counted as repeated source bytes', async () => {
    const session = tools();
    const first = await session.call('read_file', { path: 'services/payments/refund.ts' });
    expect(first.isError).toBe(false);
    const bytes = Buffer.byteLength(FILE, 'utf8') + 1;
    expect(first.counters?.sourceBytes).toEqual({ served: bytes, repeated: 0 });
    const again = await session.call('read_file', { path: 'services/payments/refund.ts' });
    expect(again.counters?.sourceBytes).toEqual({ served: 0, repeated: bytes });
    expect(session.counters().sourceBytes).toEqual({ served: bytes, repeated: bytes });
    // Another file is served, not repeated.
    const other = await session.call('read_file', { path: 'services/payments/orders.ts' });
    expect(other.counters?.sourceBytes).toEqual({ served: Buffer.byteLength('export const orders = [];', 'utf8') + 1, repeated: 0 });
  });

  test('a join the tool could not make is counted, and the answer says so', async () => {
    const session = tools();
    const refusal = await session.call('get_symbol', { name: 'nowhere' });
    expect(refusal.isError).toBe(true);
    expect((refusal.answer as { error: { code: string } }).error.code).toBe('no-such-symbol');
    expect(refusal.counters?.unresolvedJoins).toBe(1);
    const absent = await session.call('trace_flow', { entry: 'GET /nothing' });
    expect(absent.isError).toBe(true);
    expect(session.counters().unresolvedJoins).toBe(2);
  });

  test('what the unit produced is counted: the page, its statements, their grounds and links, and a question', async () => {
    const sink = memorySink();
    const session = tools(sink);
    const written = await session.call('write_page', { markdown: PAGE });
    expect(written.isError, JSON.stringify(written.answer)).toBe(false);
    // Two statements, two footnotes of grounds, and one link in the text: a footnote's ground is a ground, not a link.
    expect(written.counters?.produced).toEqual({ pages: 1, statements: 2, grounds: 2, links: 1, questions: 0 });
    const empty = await session.call('ask_question', { type: 'gap' });
    expect(empty.isError).toBe(true);
    expect(session.counters().produced.questions).toBe(0);
  });

  test('a call over the bound is answered with no counters at all', async () => {
    const session = new UnitTools(view(), DOMAIN, memorySink(), [], { maxWriteAttempts: 5, maxCalls: 1 }, BASIS, { reads: stubReads() });
    await session.call('read_file', { path: 'services/payments/refund.ts' });
    const over = await session.call('read_file', { path: 'services/payments/refund.ts' });
    expect(over.isError).toBe(true);
    expect(over.counters).toEqual(NO_COUNTERS);
  });
});

describe('the subgraph a unit is handed comes before it asks', () => {
  test('the prompt names the services, routes, tables, channels and documents, with the key to go on from', async () => {
    const read = stubReads();
    const held = { ...read, list: async (kind: string, options: { q?: string; limit: number }) => await read.list(kind, options), documentPaths: async () => ['docs/requirements.md'] };
    const prompt = await preparedContextPart({
      ...view(held),
      overview: async () => ({ kinds: [{ kind: 'code.service', count: 1 }], relations: [], documents: ['docs/requirements.md'] }),
      find: async (options: { kind?: string; limit: number }) => ({ nodes: (await held.list(options.kind ?? '', { limit: options.limit })).rows.map((node) => ({ key: node.key, kind: node.kind, label: node.label, properties: node.properties })), next: null }),
    } as unknown as GraphView);
    const text = prompt.join('\n');
    expect(text).toContain('## The subgraph you are given');
    expect(text).toContain('- code.service:payments: language typescript');
    expect(text).toContain('- code.table:shop.public.payment: public.payment');
    expect(text).toContain('- docs/requirements.md');
    expect(text).toContain('the graph holds no code.route node');
  });

  test('the product prompt carries the subgraph and the tools that answer a question about one function', async () => {
    const stub = { at: TOOL_AT, overview: async () => ({ kinds: [{ kind: 'code.service', count: 1 }], relations: [], documents: ['docs/requirements.md'] }), find: async () => ({ nodes: [], next: null }) } as unknown as GraphView;
    const prompt = await productPrompt(stub, { kind: 'product', id: 'product:shop', path: 'docs/product.md', name: 'Shop' }, 'en');
    expect(prompt).toContain('## The subgraph you are given');
    expect(prompt).toContain('get_symbol(name, service?)');
    expect(prompt).toContain('trace_flow(entry, targets?, depth?, maxSteps?)');
    expect(prompt).toContain('read_file');
  });
});

describe('the journal counts what a call did, not only that it was made', () => {
  test('a record holds the counters of its call, and a line without them reads as none', () => {
    const context = { run: 'run-a', unit: 'domain:payments', agent: 'fake', model: null, session: null };
    const entry = { kind: 'tool-call' as const, tool: 'read_file', arguments: { path: 'a.ts' }, response: '{}', isError: false, outcome: 'ok' as const, reason: null, startedAt: new Date('2026-10-20T10:00:00.000Z'), durationMs: 2 };
    expect(recordOf(context, entry).counters).toEqual(NO_COUNTERS);
    const counters = { sourceBytes: { served: 10, repeated: 4 }, evidence: 2, unresolvedJoins: 1, produced: { pages: 1, statements: 2, grounds: 2, links: 1, questions: 0 } };
    expect(recordOf(context, { ...entry, counters }).counters).toEqual(counters);
    // A guide's record counts nothing: its byte count would say how much of its source there is.
    expect(recordOf({ ...context, privateGuide: true }, { ...entry, counters }).counters).toEqual(NO_COUNTERS);
    expect(countersOf(undefined)).toEqual(NO_COUNTERS);
    expect(countersOf({ sourceBytes: { served: 3 }, produced: { pages: 1 } })).toEqual({ sourceBytes: { served: 3, repeated: 0 }, evidence: 0, unresolvedJoins: 0, produced: { pages: 1, statements: 0, grounds: 0, links: 0, questions: 0 } });
  });

  test('one call\'s counters are the difference between the totals before and after it', () => {
    const before = { sourceBytes: { served: 10, repeated: 0 }, evidence: 2, unresolvedJoins: 0, produced: { pages: 0, statements: 0, grounds: 0, links: 0, questions: 0 } };
    const after = { sourceBytes: { served: 16, repeated: 3 }, evidence: 5, unresolvedJoins: 1, produced: { pages: 1, statements: 0, grounds: 0, links: 0, questions: 0 } };
    expect(betweenCounters(before, after)).toEqual({ sourceBytes: { served: 6, repeated: 3 }, evidence: 3, unresolvedJoins: 1, produced: { pages: 1, statements: 0, grounds: 0, links: 0, questions: 0 } });
    expect(betweenCounters(after, before)).toEqual(NO_COUNTERS);
    expect(addCounters(before, after)).toEqual({ sourceBytes: { served: 26, repeated: 3 }, evidence: 7, unresolvedJoins: 1, produced: { pages: 1, statements: 0, grounds: 0, links: 0, questions: 0 } });
  });

  test('a run\'s journal adds its records up, so a page shows what its unit read twice and produced', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const folder = mkdtempSync(join(tmpdir(), 'madarch-counters-'));
    try {
      const journal = fileJournal(join(folder, 'journal'), 'run-counters');
      const context = { run: 'run-counters', unit: 'domain:payments', agent: 'fake', model: null, session: null };
      const at = new Date('2026-10-20T10:00:00.000Z');
      journal.record(context, { kind: 'tool-call', tool: 'read_file', arguments: {}, response: '{}', isError: false, outcome: 'ok', reason: null, startedAt: at, durationMs: 1, counters: { sourceBytes: { served: 100, repeated: 0 }, evidence: 1, unresolvedJoins: 0, produced: { pages: 0, statements: 0, grounds: 0, links: 0, questions: 0 } } });
      journal.record(context, { kind: 'tool-call', tool: 'read_file', arguments: {}, response: '{}', isError: false, outcome: 'ok', reason: null, startedAt: at, durationMs: 1, counters: { sourceBytes: { served: 0, repeated: 100 }, evidence: 0, unresolvedJoins: 2, produced: { pages: 0, statements: 0, grounds: 0, links: 0, questions: 0 } } });
      journal.record(context, { kind: 'tool-call', tool: 'write_page', arguments: {}, response: '{}', isError: false, outcome: 'ok', reason: null, startedAt: at, durationMs: 1, counters: { sourceBytes: { served: 0, repeated: 0 }, evidence: 3, unresolvedJoins: 0, produced: { pages: 1, statements: 4, grounds: 4, links: 2, questions: 0 } } });
      const page = journalOfUnit(join(folder, 'journal'), 'domain:payments');
      expect(page.records).toHaveLength(3);
      expect(page.totals).toEqual({ sourceBytes: { served: 100, repeated: 100 }, evidence: 4, unresolvedJoins: 2, produced: { pages: 1, statements: 4, grounds: 4, links: 2, questions: 0 } });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

