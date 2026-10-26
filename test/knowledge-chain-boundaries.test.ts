import {expect, test} from 'bun:test';
import {createPGliteDatabaseOwner,type DatabaseOwner} from '../src/adapters/database-owner.js';
import {createGraphStore,type GraphId} from '../src/graph/index.js';
import {GraphReader,spanOf,type GraphEntity,type NeighborEdge,type RelationEdge,type SourceSpan} from '../src/knowledge/graph-read.js';
import {ChainBuilder,chainFrom} from '../src/knowledge/diagrams.js';
import type {RenderContext} from '../src/knowledge/blocks.js';
import {parseKinds} from '../src/knowledge/kinds.js';
import {Resolver} from '../src/knowledge/resolve.js';
import {byCodePoint} from '../src/model/order.js';
import {buildViews,type GraphView} from '../src/knowledge/views.js';
import type {Chain} from '../src/knowledge/model.js';

test('final 1: route entry uses actual handled-by; callback references stay unordered with a range',async()=>{
 const owner=createPGliteDatabaseOwner({btreeGist:true});await owner.ready;
 try {
  const store=createGraphStore(owner,{now:()=>new Date('2026-06-01T00:00:00Z')});await store.createSchema();
  await store.registerCodeSchema({kinds:['code.route'],relations:[{key:'code.handled-by'},{key:'code.references',discriminated:true}]});
  const scope=await store.newNode();const owned={producer:'code.extract.code',scope};const time='2026-01-01T00:00:00Z';
  const span={path:'services/api/main.ts',byteStart:0,byteEnd:100,lineStart:1,lineEnd:10};
  const add=async(key:string,kind:string,label:string,start=0,end=100,file=span.path)=>store.openNode({kind,label,properties:{recordKey:key,symbolKind:'function',qualifiedName:label,span:{...span,path:file,byteStart:start,byteEnd:end}},validFrom:time,owner:owned});
  const registrar=await add('code.symbol:services/api/main.ts#setup','code.symbol','setup');
  const callback=await add('code.symbol:services/api/main.ts#callback','code.symbol','callback',20,80);
  const target=await add('code.symbol:services/api/helper.ts#target','code.symbol','target',0,100,'services/api/helper.ts');
  const unrelated=await add('code.symbol:services/api/main.ts#unrelated','code.symbol','unrelated',90,95);
  const route=await add('code.route:services/api/main.ts#GET:/healthz','code.route','GET /healthz',10,85);
  const link=async(relation:string,from:GraphId,to:GraphId,properties:Record<string,unknown>={},discriminator?:string)=>store.openEdge({relation,src:from,dst:to,properties:{...properties,span:{...span,byteStart:20,byteEnd:80}},validFrom:time,owner:owned,...(discriminator===undefined?{}:{discriminator})});
  await link('code.handled-by',route.nodeId,callback.nodeId);
  await link('code.references',registrar.nodeId,callback.nodeId,{role:'callback-value'},'20');
  await link('code.references',registrar.nodeId,unrelated.nodeId,{},'90');
  await link('code.calls',callback.nodeId,target.nodeId);
  const graph=new GraphReader(owner,()=> '2026-06-01T00:00:00Z');const manifest=parseKinds('kinds: {}','kinds.yaml','.');
  const ctx:RenderContext={productFolder:'.',manifest,graph,markdown:new Map(),docEntities:new Map(),localizedSources:new Map(),language:'en',documents:[],repositories:[],commitOf:()=>null,repoOfScope:()=>undefined,readSource:async()=>undefined,resolver:new Resolver({graph,markdown:new Map(),declared:()=>true,readDocument:async()=>undefined,repositories:()=>[],locate:()=>undefined})};
  const [registered]=await graph.find('code.route:services/api/main.ts#GET:/healthz');const [setup]=await graph.find('code.symbol:services/api/main.ts#setup');if(registered===undefined||setup===undefined)throw new Error('missing declared fixture');
  const routeChain=new ChainBuilder(ctx,{limit:50,depth:5});expect((await routeChain.handlersOf(registered)).map((entity)=>entity.label)).toEqual(['callback']);await routeChain.enterRoute(registered,5);await routeChain.finish(4);expect(routeChain.steps.some((step)=>step.label==='callback'&&step.order==='source')).toBe(false);expect(routeChain.steps.some((step)=>step.label==='unrelated')).toBe(false);expect(routeChain.steps.some((step)=>step.label==='target')).toBe(true);
  for(const ranged of [false,true]){const builder=new ChainBuilder(ctx,{limit:50,depth:5});await builder.visit(setup,5,ranged?{lineStart:1,lineEnd:10}:undefined);await builder.finish(4);expect(builder.steps.filter((step)=>step.label==='callback').map((step)=>step.order)).toEqual(['unordered']);expect(builder.steps.some((step)=>step.label==='unrelated')).toBe(false);expect(builder.steps.filter((step)=>step.label==='target').map((step)=>step.order)).toEqual(['unordered']);}
 }finally{await owner.close();}
},20_000);

// ---- the step budget of a sequence view (madarch-mwhd.3) -------------------------------------------

const unusedChainOwner: DatabaseOwner = {
  location: 'unused chain fixture', ready: Promise.resolve(), allowConcurrentSnapshots: false, backend: 'pglite', hasVector: false,
  transaction: async () => { throw new Error('the chain fixture must not query SQL'); },
  run: async () => { throw new Error('the chain fixture must not query SQL'); },
  exec: async () => { throw new Error('the chain fixture must not query SQL'); }, close: async () => {},
};

/** One fact between two keys of the fixture, with the site the graph read it at. */
interface Wire { relation: string; from: string; to: string; properties: Record<string, unknown> }

/**
 * The graph-read boundary doubled, every projection real: a chain view and the chain behind it are built by the code
 * under test from these entities and edges, so the fixture names no product and no service of any repository.
 */
class ChainFixture extends GraphReader {
  constructor(readonly entities: GraphEntity[], readonly wires: readonly Wire[]) { super(unusedChainOwner, () => '2026-01-01T00:00:00Z'); }
  private nodeAt(key: string): GraphEntity | undefined { return this.entities.find((entity) => entity.key === key); }
  override async find(key: string) { return this.entities.filter((entity) => entity.key === key); }
  override async list(kind: string, options: { limit: number }) {
    const rows = this.entities.filter((entity) => entity.kind === kind);
    return { rows: rows.slice(0, options.limit), total: rows.length, next: null };
  }
  override async byPrefix(kind: string, prefix: string, limit: number) {
    const rows = this.entities.filter((entity) => entity.kind === kind && entity.key.startsWith(prefix));
    return { rows: rows.slice(0, limit), total: rows.length };
  }
  override async relationEdges(relation: string, limit = 2000) {
    const rows: RelationEdge[] = this.wires.filter((wire) => wire.relation === relation)
      .map((wire) => ({ from: { key: wire.from, kind: this.nodeAt(wire.from)?.kind ?? '', label: this.nodeAt(wire.from)?.label ?? wire.from }, to: { key: wire.to, kind: this.nodeAt(wire.to)?.kind ?? '', label: this.nodeAt(wire.to)?.label ?? wire.to }, properties: wire.properties }));
    return { rows: rows.slice(0, limit), total: rows.length };
  }
  override async neighbors() { return []; }
  /** One row per distinct entity at the other end, as the reader groups them, the first site's properties leading. */
  override async edgesOf(entity: GraphEntity, relation: string, direction: 'out' | 'in', limit: number) {
    const other = (wire: Wire): string => (direction === 'out' ? wire.to : wire.from);
    const touching = this.wires.filter((wire) => wire.relation === relation && (direction === 'out' ? wire.from : wire.to) === entity.key);
    const keys = [...new Set(touching.map(other))].sort(byCodePoint);
    const rows: NeighborEdge[] = [];
    for (const key of keys.slice(0, limit)) {
      const found = this.nodeAt(key);
      if (found === undefined) continue;
      const first = touching.filter((wire) => other(wire) === key).sort((a, b) => (spanOf(a.properties['span'])?.byteStart ?? 0) - (spanOf(b.properties['span'])?.byteStart ?? 0))[0]!;
      const site = spanOf(first.properties['span']);
      rows.push({ relation, direction, other: found, properties: first.properties, position: site === undefined ? null : { start: site.byteStart, end: site.byteEnd }, ...(site === undefined ? {} : { span: site }) });
    }
    return { total: keys.length, rows };
  }
}

/** The site of a fact: a path, the half-open bytes and the line, in the shape the graph holds spans in. */
const site = (path: string, byteStart: number, lineStart: number, lines = 1, bytes = 8): SourceSpan => ({ path, byteStart, byteEnd: byteStart + bytes, lineStart, lineEnd: lineStart + lines - 1 });

/** A graph made of a fixture's own names, with the helpers that state one symbol, route, file or fact. */
function fixtureBuilder() {
  const entities: GraphEntity[] = [];
  const wires: Wire[] = [];
  const add = (kind: string, name: string, label: string, at: SourceSpan, extra: Record<string, unknown> = {}): GraphEntity => {
    const key = `${kind}:${name}`;
    const entity: GraphEntity = { key, kind, label, nodeIds: [key], scope: 'repo', span: at, properties: { recordKey: key, span: at, ...extra } };
    entities.push(entity);
    return entity;
  };
  return {
    entities,
    wires,
    /** A service of a folder: the lane group a reader sees. */
    service: (name: string) => add('code.service', name, name, site(`services/${name}/service.json`, 0, 1), { path: `services/${name}/service.json` }),
    file: (path: string) => add('code.file', path, path, site(path, 0, 1, 400)),
    symbol: (path: string, name: string, at: SourceSpan) => add('code.symbol', `${path}#${name}`, name, at, { qualifiedName: name, symbolKind: 'method', callable: true }),
    route: (path: string, name: string, label: string, at: SourceSpan) => add('code.route', `${path}#${name}`, label, at),
    fact: (relation: string, from: GraphEntity, to: GraphEntity, at?: SourceSpan, properties: Record<string, unknown> = {}) => {
      wires.push({ relation, from: from.key, to: to.key, properties: { ...properties, ...(at === undefined ? {} : { span: at }) } });
    },
    graph: () => new ChainFixture(entities, wires),
  };
}

/**
 * A route whose handler calls a first client (HTTP, whose serving handler is `firstSteps` steps of its own) and then a
 * second client (gRPC): the shape in which a flat prefix of the walk spends the budget inside the first callee.
 */
function crossingFixture(firstSteps: number) {
  const fixture = fixtureBuilder();
  for (const name of ['edge', 'first', 'second']) fixture.service(name);
  const entry = fixture.route('services/edge/api/routes.ts', 'GET:/first', 'GET /first', site('services/edge/api/routes.ts', 0, 1, 3));
  const run = fixture.symbol('services/edge/edge-handlers.ts', 'EdgeHandlers.run', site('services/edge/edge-handlers.ts', 0, 1, 40));
  fixture.fact('code.handled-by', entry, run, site('services/edge/api/routes.ts', 10, 2));
  const firstClient = fixture.file('services/edge/first-client.ts');
  const secondClient = fixture.file('services/edge/second-client.ts');
  // The two clients' bodies hold their remote call, so a file event of the client lies inside the symbol's own bytes.
  const firstSend = fixture.symbol('services/edge/first-client.ts', 'FirstClient.send', site('services/edge/first-client.ts', 0, 1, 6, 100));
  const secondSend = fixture.symbol('services/edge/second-client.ts', 'SecondClient.send', site('services/edge/second-client.ts', 0, 1, 6, 100));
  fixture.fact('code.calls', run, firstSend, site('services/edge/edge-handlers.ts', 100, 10));
  fixture.fact('code.calls', run, secondSend, site('services/edge/edge-handlers.ts', 300, 30));
  // The first hop: HTTP into the service that serves it, whose handler is the subtree that spends a flat budget.
  const firstRoute = fixture.route('services/first/api/routes.ts', 'POST:/handle', 'POST /handle', site('services/first/api/routes.ts', 0, 1, 3));
  fixture.fact('code.calls-remote', firstClient, firstRoute, site('services/edge/first-client.ts', 10, 2), { via: 'http', client: 'FirstClient.send' });
  const firstHandler = fixture.symbol('services/first/handlers.ts', 'FirstHandlers.handle', site('services/first/handlers.ts', 0, 1, 200));
  fixture.fact('code.handled-by', firstRoute, firstHandler, site('services/first/api/routes.ts', 10, 2));
  for (let step = 1; step <= firstSteps; step += 1) {
    const name = `step${String(step).padStart(2, '0')}`;
    fixture.fact('code.calls', firstHandler, fixture.symbol('services/first/steps.ts', name, site('services/first/steps.ts', step * 16, step, 2)), site('services/first/handlers.ts', 100 + step * 2, 5 + step));
  }
  // The second hop: gRPC, after the first, into a service of its own.
  const secondRoute = fixture.route('services/second/api/routes.ts', 'POST:/charge', 'POST /charge', site('services/second/api/routes.ts', 0, 1, 3));
  fixture.fact('code.calls-remote', secondClient, secondRoute, site('services/edge/second-client.ts', 10, 2), { via: 'grpc', client: 'SecondClient.send' });
  const secondHandler = fixture.symbol('services/second/handlers.ts', 'SecondHandlers.charge', site('services/second/handlers.ts', 0, 1, 6));
  fixture.fact('code.handled-by', secondRoute, secondHandler, site('services/second/api/routes.ts', 10, 2));
  return { graph: fixture.graph(), entry };
}

/** A route whose handler calls `leaves` functions of one other file: every step of the chain stands at one layer. */
function flatFixture(leaves: number) {
  const fixture = fixtureBuilder();
  fixture.service('flat');
  const entry = fixture.route('services/flat/api/routes.ts', 'POST:/run', 'POST /run', site('services/flat/api/routes.ts', 0, 1, 3));
  const handler = fixture.symbol('services/flat/handlers.ts', 'FlatHandlers.run', site('services/flat/handlers.ts', 0, 1, 200));
  fixture.fact('code.handled-by', entry, handler, site('services/flat/api/routes.ts', 10, 2));
  for (let leaf = 1; leaf <= leaves; leaf += 1) {
    const name = `leaf${String(leaf).padStart(2, '0')}`;
    fixture.fact('code.calls', handler, fixture.symbol('services/flat/steps.ts', name, site('services/flat/steps.ts', leaf * 16, leaf, 2)), site('services/flat/handlers.ts', 100 + leaf * 2, 5 + leaf));
  }
  return { graph: fixture.graph(), entry };
}

/** The context a chain view is built in: the page's, with nothing but the graph behind it. */
function chainContext(graph: GraphReader): RenderContext {
  return {
    graph, productFolder: '', manifest: { file: '', roles: new Map(), kinds: new Map(), groups: new Map(), excludeDocuments: [], findings: [] },
    markdown: new Map(), docEntities: new Map(), localizedSources: new Map(), language: 'en', documents: [], repositories: [],
    commitOf: () => null, repoOfScope: () => undefined, readSource: async () => undefined,
    resolver: new Resolver({ graph, markdown: new Map(), declared: () => false, readDocument: async () => undefined, repositories: () => [], locate: () => undefined }),
  };
}

/** The sequence view a page asks for, and the builder's own chain behind it (the limits the view passes it). */
async function sequenceOf(fixture: { graph: ChainFixture; entry: GraphEntity }): Promise<{ view: GraphView; chain: Chain }> {
  const ctx = chainContext(fixture.graph);
  const [view] = await buildViews({ ctx, lang: 'en', productTitle: 'Edge' }, { type: 'sequence', subject: fixture.entry.key, entry: fixture.entry.key });
  if (view === undefined) throw new Error(`the fixture drew no sequence view for ${fixture.entry.key}`);
  const chain = await chainFrom(ctx, { kind: 'route', entity: fixture.entry }, { limit: 100, depth: 6 });
  return { view, chain };
}

/** The numbers the view's fold says: the steps it draws, the chain's total, and the steps it leaves out. */
function foldOf(view: GraphView): { drawn: number; total: number; folded: number } {
  const marker = /^Showing (\d+) of (\d+)\.$/.exec(view.marker ?? '');
  const note = /(\d+) further steps are not drawn\./.exec(view.notes.join(' '));
  if (marker === null || note === null) throw new Error(`the view folded nothing and said so: marker ${JSON.stringify(view.marker)}, notes ${JSON.stringify(view.notes)}`);
  return { drawn: Number(marker[1]), total: Number(marker[2]), folded: Number(note[1]) };
}

test('a sequence view spends its budget on a caller\'s own calls before a callee\'s subtree (madarch-mwhd.3)', async () => {
  const { view, chain } = await sequenceOf(crossingFixture(45));
  // The caller's own second call survives its first callee's subtree: the gRPC hop is drawn, after the HTTP hop.
  const http = view.edges.find((edge) => edge.kind === 'http');
  const grpc = view.edges.find((edge) => edge.kind === 'grpc');
  expect(http).toBeDefined();
  expect(grpc).toBeDefined();
  expect(view.edges.indexOf(grpc!)).toBeGreaterThan(view.edges.indexOf(http!));
  expect(view.edges.find((edge) => edge.kind === 'grpc')!.to).toBe('lane:second');
  expect(view.elements.map((element) => element.id)).toContain('lane:second');
  // The drawn steps keep the walk's own order, whatever order they were chosen in.
  expect(view.edges.map((edge) => edge.step)).toEqual(view.edges.map((edge) => edge.step).sort((a, b) => (a ?? 0) - (b ?? 0)));
  // The fold is not silent: drawn and folded are the chain's own total.
  expect(chain.steps.length).toBe(chain.total);
  expect(chain.total).toBeGreaterThan(40);
  const fold = foldOf(view);
  expect(fold.drawn).toBe(view.edges.length);
  expect(fold.total).toBe(chain.total);
  expect(fold.drawn + fold.folded).toBe(fold.total);
  // The block carries the total and every step found, so a reader sees which step was folded and not only how many.
  expect(view.total).toBe(chain.total);
  expect(view.fullEdges!.map((edge) => edge.step)).toEqual(chain.steps.map((step) => step.n));
  expect(view.fullEdges!.some((edge) => edge.kind === 'grpc')).toBe(true);
  // What this pins: the flat first 40 steps of the walk are the first callee's, and hold no gRPC hop at all.
  expect(chain.steps.slice(0, 40).some((step) => step.kind === 'grpc')).toBe(false);
  // The layer each hop was produced at: the caller's own calls at one layer, the first callee's steps one deeper.
  expect(chain.steps.filter((step) => step.kind === 'http' || step.kind === 'grpc').map((step) => step.layer)).toEqual([1, 1]);
  expect(chain.steps.find((step) => step.label === 'step01')!.layer).toBe(2);
});

test('a chain shorter than the budget is drawn whole, in the walk\'s order, unchanged', async () => {
  const { view, chain } = await sequenceOf(crossingFixture(2));
  expect(chain.total).toBeLessThanOrEqual(40);
  expect(view.marker).toBeNull();
  expect(view.total).toBe(chain.total);
  expect(view.fullEdges).toBeUndefined();
  expect(view.notes.join(' ')).not.toContain('further steps are not drawn');
  // Every step, step for step: the number, the kind and the label of the builder's own chain.
  expect(view.edges.map((edge) => [edge.step, edge.kind, edge.label])).toEqual(chain.steps.map((step) => [step.n, step.kind, step.label]));
  // Every lane of the chain is drawn, with no lane of a folded step missing.
  expect(view.elements.map((element) => element.id).sort()).toEqual([...new Set(chain.lanes.map((lane) => `lane:${lane.group}`))].sort());
});

test('a chain whose every step stands at one layer keeps the order it has today', async () => {
  const { view, chain } = await sequenceOf(flatFixture(50));
  expect(chain.steps.every((step) => step.layer === 0)).toBe(true);
  expect(chain.total).toBe(52);
  // The same 40 steps in the same order a flat prefix drew: the rule reorders nothing when no callee stands deeper.
  expect(view.edges.map((edge) => edge.step)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
  expect(view.edges.map((edge) => edge.label)).toEqual(chain.steps.slice(0, 40).map((step) => step.label));
  expect(view.marker).toBe('Showing 40 of 52.');
  expect(view.notes.join(' ')).toContain('12 further steps are not drawn.');
});
