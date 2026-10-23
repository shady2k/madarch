/**
 * The diagram blocks (madarch-m38l.9, decision 0029): the neighbourhood of an
 * entity (`graph`), the end-to-end chain of a scenario (`sequence`), the
 * system view (`system`), the module graph of a service (`modules`) and the
 * file treemap (`treemap`). Each reads the graph and answers plain data; the
 * app draws it. Nothing here names a product, a service or a kind of the
 * product: the engine's own extractor vocabulary (`code.*`) is the default
 * and a template names another relation with `relation="..."`.
 *
 * Order is claimed only where the graph holds it. The graph holds no
 * execution order, but it holds the place of every call, table access and
 * remote call inside the function that makes it, so inside one function the
 * steps follow the source order of those places. Between functions the chain
 * follows the call (depth first), and what the graph links with no order
 * (the consumers of a published topic, the readers of a table a chain writes)
 * is marked `unordered` and drawn apart.
 */
import { byCodePoint } from '../model/order.js';
import type { GraphEntity, GraphReader, SourceSpan } from './graph-read.js';
import { spanOf } from './graph-read.js';
import type { RenderContext, Subject } from './blocks.js';
import { idOf, locationOf, refOfGraph, refOfMarkdown, declaredNeighbors, relatesGroups } from './blocks.js';
import type { Block, Chain, ChainLane, ChainStep, DiagramEdge, DiagramMore, DiagramNode, EntityRef, ModuleEdge, ModuleNode, Neighborhood, StepKind, SystemEdge, SystemNode, TreemapFile } from './model.js';

const toInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const list = (value: string | undefined): string[] | undefined => (value === undefined ? undefined : value.split(',').map((entry) => entry.trim()).filter(Boolean));

/**
 * Relations that describe history or bookkeeping rather than how the product is put together: a file's thousand
 * commits would bury its neighbours. A template that wants one names it with `relation="..."`.
 */
export const QUIET_RELATIONS: ReadonlySet<string> = new Set([
  'code.occurrence', 'code.touched', 'code.changed-with', 'code.parent', 'code.authored', 'code.tasks', 'code.facet-of', 'code.held', 'code.renamed-to',
]);

const dirname = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.');
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
/** The repository path inside a record key: what follows the kind and its colon, up to the `#` that names a part of the file. */
export const pathOfKey = (key: string): string => {
  const rest = key.slice(key.indexOf(':') + 1);
  return rest.includes('#') ? rest.slice(0, rest.indexOf('#')) : rest;
};
const isTestPath = (path: string): boolean => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$|_test\.go$/.test(path);

// ---- neighbourhood ------------------------------------------------------------------------------

interface NeighborRow {
  direction: 'out' | 'in';
  relation: string;
  ref: EntityRef;
  count: number;
}

interface Collected {
  rows: NeighborRow[];
  more: { relation: string; direction: 'out' | 'in'; hidden: number }[];
}

/** Pages that name a Markdown page in their `relates`: what relies on it. */
function markdownIn(ctx: RenderContext, id: string): NeighborRow[] {
  return [...ctx.markdown.values()].filter((page) => page.relates.includes(id)).map((page) => ({ direction: 'in' as const, relation: 'relates', ref: refOfMarkdown(ctx, page), count: 1 }));
}

/** The direct neighbours of a subject, grouped by relation and direction; a group cut to `limit` says how many it left out. */
export async function collectNeighbors(ctx: RenderContext, subject: Subject, options: { relations?: readonly string[]; direction?: 'out' | 'in'; limit: number }): Promise<Collected> {
  const rows: NeighborRow[] = [];
  const more: Collected['more'] = [];
  const wanted = (relation: string): boolean => (options.relations === undefined ? !QUIET_RELATIONS.has(relation) : options.relations.includes(relation));
  const keep = (direction: 'out' | 'in'): boolean => options.direction === undefined || options.direction === direction;
  if (subject.source === 'graph') {
    for (const group of await declaredNeighbors(ctx, subject)) {
      if (!wanted(group.relation) || !keep('out')) continue;
      for (const row of group.rows) rows.push({ direction: 'out', relation: group.relation, ref: row.entity, count: row.count });
    }
    const groups = await ctx.graph.neighbors(subject.entity, { ...(options.relations === undefined ? {} : { relations: options.relations }), ...(options.direction === undefined ? {} : { direction: options.direction }), limit: options.limit });
    for (const group of groups) {
      if (!wanted(group.relation)) continue;
      for (const row of group.rows) rows.push({ direction: group.direction, relation: group.relation, ref: refOfGraph(ctx, row.entity), count: row.edges });
      if (group.total > group.rows.length) more.push({ relation: group.relation, direction: group.direction, hidden: group.total - group.rows.length });
    }
  }
  if (subject.source === 'graph' && subject.entity.kind === 'code.route' && wanted('handled-by') && keep('out')) {
    for (const handler of await new ChainBuilder(ctx, { limit: 1, depth: 1 }).handlersOf(subject.entity)) rows.push({ direction: 'out', relation: 'handled-by', ref: refOfGraph(ctx, handler), count: 1 });
  }
  if (subject.source === 'graph' && subject.entity.kind === 'code.service') {
    for (const row of await serviceRows(ctx, subject.entity)) if (wanted(row.relation) && keep(row.direction)) rows.push(row);
  }
  if (wanted('relates')) {
    if (keep('out') || keep('in')) {
      for (const group of await relatesGroups(ctx, subject)) {
        if (!keep(group.direction)) continue;
        for (const row of group.rows) if (row.entity.broken === undefined) rows.push({ direction: group.direction, relation: 'relates', ref: row.entity, count: row.count });
      }
      if (subject.source === 'markdown' && keep('in')) rows.push(...markdownIn(ctx, subject.entity.id));
    }
  }
  return { rows, more };
}

/** What the system view says of one service: the services it calls and is called by, its databases, its topics. */
async function serviceRows(ctx: RenderContext, service: GraphEntity): Promise<NeighborRow[]> {
  const model = await systemModel(ctx);
  const rows: NeighborRow[] = [];
  const refOf = async (node: SystemNode): Promise<EntityRef> => {
    const [entity] = await ctx.graph.find(node.id);
    return entity === undefined ? { id: node.id, kind: node.kind === 'database' ? 'code.database' : node.kind === 'topic' ? 'code.channel' : 'code.service', label: node.label, href: null } : refOfGraph(ctx, entity);
  };
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  for (const edge of model.edges) {
    const other = edge.from === service.key ? byId.get(edge.to) : edge.to === service.key ? byId.get(edge.from) : undefined;
    if (other === undefined) continue;
    const outward = edge.from === service.key;
    const relation = edge.via === 'http' || edge.via === 'grpc' ? `calls-${edge.via}` : edge.via === 'sql' ? 'uses-database' : edge.via;
    // A topic the service consumes is an edge from the topic; from the service it goes out to the topic all the same.
    const direction: 'out' | 'in' = edge.via === 'consumes' ? 'out' : outward ? 'out' : 'in';
    rows.push({ direction, relation, ref: await refOf(other), count: edge.count });
  }
  return rows;
}

const nodeOf = (ref: EntityRef, hops: number): DiagramNode => ({ id: ref.id, kind: ref.kind, label: ref.label, href: ref.href, hops });

/**
 * The part of the graph around a subject, `depth` hops out, at most `maxNodes` nodes. A node the diagram does not
 * reach is counted in `more` with the relation and direction it hides behind, never dropped silently.
 */
export async function neighborhoodOf(ctx: RenderContext, subject: Subject, options: { depth: number; relations?: readonly string[]; limit: number; maxNodes: number; direction?: 'out' | 'in' }): Promise<{ hood: Neighborhood; total: number }> {
  const centerRef = subject.source === 'graph' ? refOfGraph(ctx, subject.entity) : refOfMarkdown(ctx, subject.entity);
  const nodes = new Map<string, DiagramNode>([[centerRef.id, nodeOf(centerRef, 0)]]);
  const edges = new Map<string, DiagramEdge>();
  const more: DiagramMore[] = [];
  const relationCount = new Map<string, { relation: string; direction: 'out' | 'in'; count: number }>();
  let total = 0;
  let frontier: Subject[] = [subject];
  const expanded = new Set<string>([centerRef.id]);
  for (let hop = 1; hop <= options.depth; hop += 1) {
    const next: Subject[] = [];
    for (const current of frontier) {
      const currentId = idOf(current);
      const collected = await collectNeighbors(ctx, current, { ...(options.relations === undefined ? {} : { relations: options.relations }), ...(options.direction === undefined || hop > 1 ? {} : { direction: options.direction }), limit: hop > 1 ? Math.max(2, Math.floor(options.limit / 2)) : options.limit });
      total += collected.rows.length;
      for (const row of collected.rows) {
        if (hop === 1) {
          const slot = `${row.direction}|${row.relation}`;
          const held = relationCount.get(slot) ?? { relation: row.relation, direction: row.direction, count: 0 };
          held.count += 1;
          relationCount.set(slot, held);
        }
        if (!nodes.has(row.ref.id)) {
          if (nodes.size >= options.maxNodes) continue;
          nodes.set(row.ref.id, nodeOf(row.ref, hop));
        }
        const [from, to] = row.direction === 'out' ? [currentId, row.ref.id] : [row.ref.id, currentId];
        const edgeKey = `${from}|${to}|${row.relation}`;
        if (!edges.has(edgeKey)) edges.set(edgeKey, { from, to, relation: row.relation, count: row.count });
        if (hop < options.depth && !expanded.has(row.ref.id)) {
          expanded.add(row.ref.id);
          const [again] = await ctx.graph.find(row.ref.id);
          if (again !== undefined) next.push({ source: 'graph', entity: again });
          else {
            const page = ctx.markdown.get(row.ref.id);
            if (page !== undefined) next.push({ source: 'markdown', entity: page });
          }
        }
      }
      for (const left of collected.more) {
        more.push({ node: currentId, relation: left.relation, direction: left.direction, hidden: left.hidden });
        if (hop === 1) {
          const held = relationCount.get(`${left.direction}|${left.relation}`);
          if (held !== undefined) held.count += left.hidden;
        }
      }
    }
    frontier = next;
  }
  const kept = new Set(nodes.keys());
  return {
    hood: {
      center: centerRef.id,
      nodes: [...nodes.values()],
      edges: [...edges.values()].filter((edge) => kept.has(edge.from) && kept.has(edge.to)).sort((a, b) => byCodePoint(`${a.relation}|${a.from}|${a.to}`, `${b.relation}|${b.from}|${b.to}`)),
      more,
      relations: [...relationCount.values()].sort((a, b) => byCodePoint(a.relation, b.relation) || (a.direction === b.direction ? 0 : a.direction === 'in' ? -1 : 1)),
    },
    total,
  };
}

export async function graphBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>): Promise<Block> {
  const depth = toInt(params['depth'], 1, 1, 3);
  const limit = toInt(params['limit'], 8, 1, 60);
  const maxNodes = toInt(params['nodes'], 48, 5, 200);
  const relations = list(params['relation']);
  const { hood, total } = await neighborhoodOf(ctx, subject, { depth: Math.max(depth, 2), ...(relations === undefined ? {} : { relations }), limit, maxNodes });
  return { type: 'graph', title: params['title'] ?? 'Links', neighborhood: hood, depth, shown: hood.nodes.length - 1, total };
}

// ---- the chain -----------------------------------------------------------------------------------

interface Located {
  entity: GraphEntity;
  span: SourceSpan;
}

interface Event {
  at: number;
  kind: 'call' | 'read' | 'write' | 'remote' | 'publish';
  target: GraphEntity;
  props: Record<string, unknown>;
  span?: SourceSpan;
}

const symbolName = (entity: GraphEntity): string => String(entity.properties['qualifiedName'] ?? entity.label);

export class ChainBuilder {
  readonly lanes = new Map<string, ChainLane>();
  steps: ChainStep[] = [];
  readonly notes = new Set<string>();
  total = 0;
  private readonly visited = new Set<string>();
  private readonly symbolsOfFile = new Map<string, GraphEntity[]>();
  private readonly fileEdges = new Map<string, Event[]>();
  private readonly pendingUnordered: { symbol: GraphEntity; span?: SourceSpan; from: string; reason: string }[] = [];
  private readonly written = new Set<string>();
  private serviceRoots: { key: string; label: string; root: string }[] | undefined;
  private expansions = 0;
  private cutAtDepth = 0;
  private omittedHelpers = 0;

  constructor(
    private readonly ctx: RenderContext,
    private readonly options: { limit: number; depth: number },
  ) {}

  private async roots(): Promise<{ key: string; label: string; root: string }[]> {
    if (this.serviceRoots === undefined) {
      const found = await this.ctx.graph.list('code.service', { limit: 200 });
      this.serviceRoots = found.rows
        .flatMap((service) => (service.span === undefined ? [] : [{ key: service.key, label: service.label, root: dirname(service.span.path) }]))
        .sort((a, b) => b.root.length - a.root.length || byCodePoint(a.root, b.root));
    }
    return this.serviceRoots;
  }

  /** The service whose folder holds the path; the repository's top level when none does. */
  async serviceOf(path: string): Promise<string> {
    const found = (await this.roots()).find((service) => service.root === '.' || path === service.root || path.startsWith(`${service.root}/`));
    return found?.label ?? 'repository';
  }

  private async laneOfFile(path: string, entityKey: string | undefined): Promise<ChainLane> {
    const id = `file:${path}`;
    const held = this.lanes.get(id);
    if (held !== undefined) return held;
    const key = entityKey ?? `code.file:${path}`;
    const [file] = await this.ctx.graph.find(key);
    const lane: ChainLane = {
      id,
      label: basename(path),
      sub: dirname(path),
      kind: 'code.file',
      href: file !== undefined ? refOfGraph(this.ctx, file).href : null,
      group: await this.serviceOf(path),
    };
    this.lanes.set(id, lane);
    return lane;
  }

  private laneOfTable(table: GraphEntity): ChainLane {
    const id = `table:${table.key}`;
    const held = this.lanes.get(id);
    if (held !== undefined) return held;
    const database = String(table.properties['database'] ?? 'database');
    const lane: ChainLane = { id, label: table.label, sub: `${database} database`, kind: table.kind, href: refOfGraph(this.ctx, table).href, group: `${database} database` };
    this.lanes.set(id, lane);
    return lane;
  }

  private laneOfChannel(channel: GraphEntity): ChainLane {
    const id = `channel:${channel.key}`;
    const held = this.lanes.get(id);
    if (held !== undefined) return held;
    const lane: ChainLane = { id, label: channel.label, sub: 'topic', kind: channel.kind, href: refOfGraph(this.ctx, channel).href, group: 'broker' };
    this.lanes.set(id, lane);
    return lane;
  }

  actor(): ChainLane {
    const held = this.lanes.get('actor');
    if (held !== undefined) return held;
    const lane: ChainLane = { id: 'actor', label: 'Caller', sub: 'client', kind: 'actor', href: null, group: 'client' };
    this.lanes.set('actor', lane);
    return lane;
  }

  private push(step: Omit<ChainStep, 'n'>): void {
    this.total += 1;
    if (this.steps.length >= this.options.limit) {
      this.notes.add(`The chain has more steps than the ${this.options.limit} drawn; the diagram stops there.`);
      return;
    }
    this.steps.push({ n: this.steps.length + 1, ...step });
  }

  private site(entity: GraphEntity, span: SourceSpan | undefined): { site?: ReturnType<typeof locationOf> } {
    return span === undefined ? {} : { site: locationOf(this.ctx, entity.scope, span) };
  }

  /** The symbols of a file, in key order. */
  private async symbolsIn(path: string): Promise<GraphEntity[]> {
    const held = this.symbolsOfFile.get(path);
    if (held !== undefined) return held;
    const found = await this.ctx.graph.byPrefix('code.symbol', `code.symbol:${path}#`, 2000);
    this.symbolsOfFile.set(path, found.rows);
    return found.rows;
  }

  /** The smallest declaration in the file whose bytes hold the span. */
  async enclosing(path: string, span: { byteStart: number; byteEnd: number }): Promise<GraphEntity | undefined> {
    let best: GraphEntity | undefined;
    for (const symbol of await this.symbolsIn(path)) {
      if (symbol.span === undefined) continue;
      if (symbol.span.byteStart <= span.byteStart && span.byteEnd <= symbol.span.byteEnd) {
        if (best === undefined || best.span === undefined || symbol.span.byteEnd - symbol.span.byteStart < best.span.byteEnd - best.span.byteStart) best = symbol;
      }
    }
    return best;
  }

  /** The file-level edges (remote calls, publications, consumption, serving) read at places of the file. */
  private async fileEventsOf(path: string): Promise<Event[]> {
    const held = this.fileEdges.get(path);
    if (held !== undefined) return held;
    const events: Event[] = [];
    const [file] = await this.ctx.graph.find(`code.file:${path}`);
    if (file !== undefined) {
      for (const [relation, kind] of [['code.calls-remote', 'remote'], ['code.publishes', 'publish']] as const) {
        const found = await this.ctx.graph.edgesOf(file, relation, 'out', 200);
        for (const edge of found.rows) {
          if (relation === 'code.publishes' && edge.other.kind !== 'code.channel') continue;
          events.push({ at: edge.span?.byteStart ?? 0, kind, target: edge.other, props: edge.properties, ...(edge.span === undefined ? {} : { span: edge.span }) });
        }
      }
    }
    this.fileEdges.set(path, events);
    return events;
  }

  /** What a function does, in the order of the places the graph read it at. */
  private async eventsOf(symbol: GraphEntity, within?: { lineStart: number; lineEnd: number }): Promise<Event[]> {
    const events: Event[] = [];
    const inRange = (span: SourceSpan | undefined): boolean => within === undefined || (span !== undefined && span.lineStart >= within.lineStart && span.lineEnd <= within.lineEnd);
    const relations: [string, Event['kind']][] = [['code.calls', 'call'], ['code.reads-table', 'read'], ['code.writes-table', 'write']];
    if (within !== undefined) relations.push(['code.references', 'call']);
    for (const [relation, kind] of relations) {
      const found = await this.ctx.graph.edgesOf(symbol, relation, 'out', 300);
      for (const edge of found.rows) {
        if (!inRange(edge.span)) continue;
        if (kind === 'call' && (edge.other.kind !== 'code.symbol' || edge.other.properties['test'] === true)) continue;
        if (relation === 'code.references' && !['function', 'method', 'class'].includes(String(edge.other.properties['symbolKind']))) continue;
        events.push({ at: edge.span?.byteStart ?? Number.MAX_SAFE_INTEGER, kind, target: edge.other, props: edge.properties, ...(edge.span === undefined ? {} : { span: edge.span }) });
      }
    }
    if (symbol.span !== undefined) {
      for (const event of await this.fileEventsOf(symbol.span.path)) {
        if (event.span === undefined || event.span.byteStart < symbol.span.byteStart || event.span.byteEnd > symbol.span.byteEnd) continue;
        if (!inRange(event.span)) continue;
        events.push(event);
      }
    }
    events.sort((a, b) => a.at - b.at || byCodePoint(a.target.key, b.target.key));
    return await this.withoutInterfaceTwins(events);
  }

  /**
   * A call through an interface is read as a call of the interface's method and of the implementation's, at one site:
   * the interface's is dropped (the implementation's step says it is reached through one), so the chain shows the code
   * that runs and not its declaration.
   */
  private async withoutInterfaceTwins(events: Event[]): Promise<Event[]> {
    const dropped = new Set<Event>();
    for (const event of events) {
      if (event.kind !== 'call' || event.span === undefined) continue;
      const name = symbolName(event.target);
      const dot = name.lastIndexOf('.');
      if (dot < 0 || event.target.span === undefined) continue;
      const [owner] = await this.ctx.graph.find(`code.symbol:${event.target.span.path}#${name.slice(0, dot)}`);
      if (owner === undefined || String(owner.properties['symbolKind']) !== 'interface') continue;
      const method = name.slice(dot + 1);
      const twin = events.find((other) => other !== event && other.kind === 'call' && other.span?.byteStart === event.span?.byteStart && symbolName(other.target).endsWith(`.${method}`) && !dropped.has(other));
      if (twin !== undefined) {
        dropped.add(event);
        twin.props = { ...twin.props, viaInterface: name.slice(0, dot) };
      }
    }
    const kept = events.filter((event) => !dropped.has(event));
    // Several functions called at one site (the implementations behind one call) are alternatives, not a sequence.
    for (const event of kept) {
      if (event.kind !== 'call' || event.span === undefined) continue;
      const same = kept.filter((other) => other.kind === 'call' && other.span?.byteStart === event.span?.byteStart && other.span?.path === event.span?.path);
      if (same.length > 1) event.props = { ...event.props, alternatives: same.length };
    }
    return kept;
  }

  /** Enters a function: its lane, and what it does in source order. */
  async visit(symbol: GraphEntity, depthLeft: number, within?: { lineStart: number; lineEnd: number }, unordered = false): Promise<void> {
    if (symbol.span === undefined) return;
    const fromLane = await this.laneOfFile(symbol.span.path, undefined);
    if (!within) {
      if (this.visited.has(symbol.key)) return;
      this.visited.add(symbol.key);
    }
    this.expansions += 1;
    if (this.expansions > 400) {
      this.notes.add('The walk stopped after 400 functions.');
      return;
    }
    const order: ChainStep['order'] = unordered ? 'unordered' : 'source';
    for (const event of await this.eventsOf(symbol, within)) {
      if (event.kind === 'call') {
        const target = event.target;
        if (target.span === undefined) continue;
        const toLane = await this.laneOfFile(target.span.path, undefined);
        const again = this.visited.has(target.key);
        const same = toLane.id === fromLane.id;
        const before = this.steps.length;
        const totalBefore = this.total;
        this.push({
          from: fromLane.id, to: toLane.id, label: symbolName(target), kind: same ? 'self' : 'call', href: refOfGraph(this.ctx, target).href, order,
          ...this.site(symbol, event.span), ...(again ? { note: 'called again; its steps are shown above' } : typeof event.props['alternatives'] === 'number' ? { note: `one of ${event.props['alternatives']} functions called at this site; the graph holds no order between them` } : typeof event.props['viaInterface'] === 'string' ? { note: `through ${event.props['viaInterface']}` } : {}),
        });
        if (!again && depthLeft > 1) await this.visit(target, depthLeft - 1, undefined, unordered);
        else if (!again && depthLeft <= 1) this.cutAtDepth += 1;
        // A helper of the same file that reaches nothing else adds a row and no information: it is left out, and counted.
        if (same && !again && depthLeft > 1 && this.steps.length === before + 1 && this.total === totalBefore + 1) {
          this.steps.pop();
          this.total -= 1;
          this.omittedHelpers += 1;
        }
      } else if (event.kind === 'read' || event.kind === 'write') {
        const lane = this.laneOfTable(event.target);
        if (event.kind === 'write') this.written.add(event.target.key);
        this.push({ from: fromLane.id, to: lane.id, label: `${event.kind === 'write' ? 'writes' : 'reads'} ${event.target.label}`, kind: event.kind, href: refOfGraph(this.ctx, event.target).href, order, ...this.site(symbol, event.span) });
      } else if (event.kind === 'publish') {
        const channel = this.laneOfChannel(event.target);
        this.push({ from: fromLane.id, to: channel.id, label: `publishes ${event.target.label}`, kind: 'publish', href: refOfGraph(this.ctx, event.target).href, order, ...this.site(symbol, event.span) });
        await this.consumersOf(event.target, channel);
      } else {
        await this.remote(symbol, fromLane, event, depthLeft, order);
      }
    }
  }

  /** The consumers of a topic: their order against the publisher is not in the graph, so they are drawn unordered. */
  private async consumersOf(channel: GraphEntity, lane: ChainLane): Promise<void> {
    const found = await this.ctx.graph.edgesOf(channel, 'code.consumes', 'in', 50);
    for (const edge of found.rows) {
      const path = pathOfKey(edge.other.key);
      const span = edge.span;
      // The edge names the handler (`Service.ApplyPaymentEvent`); the function the subscription is read in is the fallback.
      const handlerName = edge.properties['handler'];
      let symbol: GraphEntity | undefined;
      if (typeof handlerName === 'string' && handlerName !== '') {
        const candidates = await this.ctx.graph.list('code.symbol', { q: handlerName.slice(handlerName.lastIndexOf('.') + 1), limit: 50 });
        symbol = candidates.rows.find((candidate) => symbolName(candidate) === handlerName && candidate.properties['test'] !== true);
      }
      if (symbol === undefined && span !== undefined) symbol = await this.enclosing(path, span);
      if (symbol === undefined || symbol.span === undefined) {
        this.notes.add(`${channel.label} is consumed in ${path}, but the graph does not say by which function.`);
        continue;
      }
      const group = edge.properties['group'];
      this.pendingUnordered.push({ symbol, ...(span === undefined ? {} : { span }), from: lane.id, reason: `consumes ${channel.label}${typeof group === 'string' ? ` as group ${group}` : ''}, subscribed in ${path}` });
    }
  }

  /** A call to another service: to the route or the handler that serves the operation, when the graph knows it. */
  private async remote(symbol: GraphEntity, fromLane: ChainLane, event: Event, depthLeft: number, order: ChainStep['order']): Promise<void> {
    const target = event.target;
    const via = String(event.props['via'] ?? 'http');
    const kind: StepKind = via === 'grpc' ? 'grpc' : 'http';
    const servers: { entity: GraphEntity; span?: SourceSpan }[] = [];
    if (target.kind === 'code.route') servers.push({ entity: target });
    else {
      const found = await this.ctx.graph.edgesOf(target, 'code.serves', 'in', 10);
      for (const edge of found.rows) servers.push({ entity: edge.other, ...(edge.span === undefined ? {} : { span: edge.span }) });
    }
    if (servers.length === 0) {
      const lane: ChainLane = { id: `external:${target.key}`, label: target.label, sub: 'no service in the graph serves it', kind: 'external', href: refOfGraph(this.ctx, target).href, group: 'elsewhere' };
      this.lanes.set(lane.id, lane);
      this.push({ from: fromLane.id, to: lane.id, label: String(event.props['client'] ?? target.label), kind, href: lane.href, order, ...this.site(symbol, event.span), note: 'no service of the graph serves this operation' });
      return;
    }
    for (const server of servers.slice(0, 1)) {
      const serverEntity = server.entity;
      const path = pathOfKey(serverEntity.key);
      const toLane = await this.laneOfFile(path, serverEntity.kind === 'code.file' ? serverEntity.key : undefined);
      this.push({
        from: fromLane.id, to: toLane.id, label: serverEntity.kind === 'code.route' ? serverEntity.label : target.label, kind, href: refOfGraph(this.ctx, serverEntity).href, order,
        ...this.site(symbol, event.span), note: `${via === 'grpc' ? 'gRPC' : 'HTTP'} call of ${String(event.props['client'] ?? target.label)}`,
      });
      if (depthLeft <= 1) continue;
      if (serverEntity.kind === 'code.route') await this.enterRoute(serverEntity, depthLeft - 1, order === 'unordered', false);
      else if (server.span !== undefined) {
        const handler = await this.enclosing(path, server.span);
        if (handler !== undefined) await this.visit(handler, depthLeft - 1, { lineStart: server.span.lineStart, lineEnd: server.span.lineEnd }, order === 'unordered');
        else this.notes.add(`${target.label} is served in ${path}, but the graph does not say by which function.`);
      }
    }
  }

  /** The route as the first step of a chain (from the caller), and what the function that registers it does at its lines. */
  async enterRoute(route: GraphEntity, depthLeft: number, unordered = false, fromActor = true): Promise<void> {
    const span = route.span;
    if (span === undefined) return;
    if (fromActor) this.actor();
    const lane = await this.laneOfFile(span.path, undefined);
    if (fromActor) {
      const middleware = Array.isArray(route.properties['middleware']) ? (route.properties['middleware'] as unknown[]).map(String) : [];
      this.push({
        from: this.actor().id, to: lane.id, label: route.label, kind: 'route', href: refOfGraph(this.ctx, route).href, order: unordered ? 'unordered' : 'source', ...this.site(route, span),
        ...(middleware.length === 0 ? {} : { note: `middleware: ${middleware.join(', ')}` }),
      });
    }
    const registrar = await this.enclosing(span.path, span);
    if (registrar === undefined) {
      this.notes.add(`${route.label} is registered in ${span.path}, but the graph does not say which function holds the registration.`);
      return;
    }
    await this.visit(registrar, depthLeft, { lineStart: span.lineStart, lineEnd: span.lineEnd }, unordered);
  }

  /** The functions a route hands the request to: what its registration calls or references at the route's own lines. */
  async handlersOf(route: GraphEntity): Promise<GraphEntity[]> {
    const span = route.span;
    if (span === undefined) return [];
    const registrar = await this.enclosing(span.path, span);
    if (registrar === undefined) return [];
    const handlers = new Map<string, GraphEntity>();
    for (const event of await this.eventsOf(registrar, { lineStart: span.lineStart, lineEnd: span.lineEnd })) if (event.kind === 'call') handlers.set(event.target.key, event.target);
    return handlers.size === 0 ? [registrar] : [...handlers.values()].sort((a, b) => byCodePoint(a.key, b.key));
  }

  /** Starts from a function with no route above it. */
  async enterSymbol(symbol: GraphEntity, depthLeft: number): Promise<void> {
    if (symbol.span === undefined) return;
    await this.laneOfFile(symbol.span.path, undefined);
    await this.visit(symbol, depthLeft);
  }

  /** The tail: what the graph links with no order, after the ordered steps. */
  async finish(depthLeft: number): Promise<void> {
    // Readers of a table the chain wrote, when the reader goes on to publish: the outbox relay reads the row the chain wrote.
    for (const key of [...this.written].sort(byCodePoint)) {
      const [table] = await this.ctx.graph.find(key);
      if (table === undefined) continue;
      const readers = await this.ctx.graph.edgesOf(table, 'code.reads-table', 'in', 40);
      for (const edge of readers.rows) {
        const reader = edge.other;
        if (this.visited.has(reader.key) || reader.kind !== 'code.symbol' || reader.properties['test'] === true) continue;
        if (await this.reachesPublish(reader, 3)) this.pendingUnordered.push({ symbol: reader, from: `table:${table.key}`, reason: `reads ${table.label}` });
      }
    }
    const done = new Set<string>();
    let marked = false;
    for (let at = 0; at < this.pendingUnordered.length && at < 40; at += 1) {
      const item = this.pendingUnordered[at]!;
      if (done.has(item.symbol.key) || item.symbol.span === undefined) continue;
      done.add(item.symbol.key);
      const lane = await this.laneOfFile(item.symbol.span.path, undefined);
      if (!marked) {
        marked = true;
        this.notes.add('The graph holds no order between a publisher and the consumers of its topic, nor between a writer of a table and the functions that read the row later: those steps are drawn apart, below the dashed line.');
      }
      this.push({ from: item.from, to: lane.id, label: symbolName(item.symbol), kind: 'consume', href: refOfGraph(this.ctx, item.symbol).href, order: 'unordered', ...this.site(item.symbol, item.span), note: item.reason });
      await this.visit(item.symbol, depthLeft, undefined, true);
    }
  }

  private async reachesPublish(symbol: GraphEntity, depth: number): Promise<boolean> {
    if (symbol.span === undefined) return false;
    if ((await this.fileEventsOf(symbol.span.path)).some((event) => event.kind === 'publish' && event.span !== undefined && symbol.span !== undefined && event.span.byteStart >= symbol.span.byteStart && event.span.byteEnd <= symbol.span.byteEnd)) return true;
    if (depth <= 1) return false;
    const calls = await this.ctx.graph.edgesOf(symbol, 'code.calls', 'out', 40);
    for (const edge of calls.rows) if (edge.other.kind === 'code.symbol' && (await this.reachesPublish(edge.other, depth - 1))) return true;
    return false;
  }

  /** What the walk left out, said once. */
  summaryNotes(): string[] {
    const notes: string[] = [];
    if (this.cutAtDepth > 0) notes.push(`The walk follows calls ${this.options.depth} levels deep; the calls below ${this.cutAtDepth} functions at that depth are not followed.`);
    if (this.omittedHelpers > 0) notes.push(`${this.omittedHelpers} calls to helpers of the same file that reach nothing else are not drawn.`);
    return notes;
  }

  /** Lanes in groups: lanes of one container stand together, groups in the order they first appear. */
  orderedLanes(): ChainLane[] {
    const used = new Set(this.steps.flatMap((step) => [step.from, step.to]));
    const lanes = [...this.lanes.values()].filter((lane) => used.has(lane.id));
    const groupAt = new Map<string, number>();
    lanes.forEach((lane, index) => {
      if (!groupAt.has(lane.group)) groupAt.set(lane.group, index);
    });
    return lanes.map((lane, index) => ({ lane, index })).sort((a, b) => groupAt.get(a.lane.group)! - groupAt.get(b.lane.group)! || a.index - b.index).map((entry) => entry.lane);
  }
}

export type Entry = { kind: 'route'; entity: GraphEntity } | { kind: 'symbol'; entity: GraphEntity; note?: string };

const isEntrySymbolKind = (entity: GraphEntity): boolean => entity.kind === 'code.symbol';

/** The routes of a file whose lines hold the site. */
async function routesAt(graph: GraphReader, path: string, site: SourceSpan): Promise<GraphEntity[]> {
  const found = await graph.byPrefix('code.route', `code.route:${path}#`, 200);
  return found.rows.filter((route) => route.span !== undefined && route.span.lineStart <= site.lineStart && site.lineEnd <= route.span.lineEnd);
}

/**
 * Where a chain through a function starts: the route that reaches it, found by walking the callers upward until a
 * caller stands inside a route's lines; the function itself when no route reaches it.
 */
export async function entryOfSymbol(ctx: RenderContext, symbol: GraphEntity): Promise<Entry> {
  const seen = new Set<string>([symbol.key]);
  let frontier: GraphEntity[] = [symbol];
  for (let level = 0; level < 6; level += 1) {
    const next: GraphEntity[] = [];
    const routes = new Map<string, GraphEntity>();
    for (const current of frontier) {
      for (const relation of ['code.calls', 'code.references']) {
        const found = await ctx.graph.edgesOf(current, relation, 'in', 60);
        for (const edge of found.rows) {
          const caller = edge.other;
          if (caller.kind !== 'code.symbol' || caller.span === undefined || isTestPath(caller.span.path) || caller.properties['test'] === true) continue;
          if (edge.span !== undefined) for (const route of await routesAt(ctx.graph, caller.span.path, edge.span)) routes.set(route.key, route);
          if (!seen.has(caller.key)) {
            seen.add(caller.key);
            next.push(caller);
          }
        }
      }
    }
    const [first] = [...routes.values()].sort((a, b) => byCodePoint(a.key, b.key));
    if (first !== undefined) return { kind: 'route', entity: first };
    if (next.length === 0) break;
    frontier = next.sort((a, b) => byCodePoint(a.key, b.key));
  }
  return { kind: 'symbol', entity: symbol, note: 'no route of the graph reaches this function; the chain starts here' };
}

export async function entriesOf(ctx: RenderContext, subject: Subject): Promise<Entry[]> {
  if (subject.source === 'graph') {
    if (subject.entity.kind === 'code.route') return [{ kind: 'route', entity: subject.entity }];
    if (isEntrySymbolKind(subject.entity)) return [await entryOfSymbol(ctx, subject.entity)];
    return [];
  }
  if (subject.source !== 'markdown') return [];
  const entries = new Map<string, Entry>();
  for (const key of subject.entity.relates) {
    const [entity] = await ctx.graph.find(key);
    if (entity === undefined) continue;
    for (const entry of await entriesOf(ctx, { source: 'graph', entity })) entries.set(entry.entity.key, entry);
  }
  return [...entries.values()].sort((a, b) => byCodePoint(a.entity.key, b.entity.key));
}

export async function chainFrom(ctx: RenderContext, entry: Entry, options: { limit: number; depth: number }): Promise<Chain> {
  const builder = new ChainBuilder(ctx, options);
  if (entry.kind === 'route') await builder.enterRoute(entry.entity, options.depth);
  else await builder.enterSymbol(entry.entity, options.depth);
  await builder.finish(Math.min(options.depth, 4));
  const notes = [...builder.notes, ...builder.summaryNotes()];
  if (entry.kind === 'symbol' && entry.note !== undefined) notes.unshift(entry.note);
  notes.push('Inside a function the steps follow the source order of the places the graph read them at; branches, loops, error paths and repeated calls are not modelled.');
  return {
    title: entry.entity.label,
    entry: refOfGraph(ctx, entry.entity),
    lanes: builder.orderedLanes(),
    steps: builder.steps,
    notes,
    total: builder.total,
  };
}

// ---- the system view ----------------------------------------------------------------------------

/** The service that holds a path: services sorted deepest folder first, so the nearest root wins. */
export async function serviceLocator(ctx: RenderContext): Promise<{ ownerOf: (path: string) => string | undefined; services: GraphEntity[] }> {
  const read = await ctx.graph.list('code.service', { limit: 200 });
  const roots = read.rows
    .flatMap((service) => (service.span === undefined ? [] : [{ entity: service, root: dirname(service.span.path) }]))
    .sort((a, b) => b.root.length - a.root.length || byCodePoint(a.root, b.root));
  return {
    services: read.rows,
    ownerOf: (path) => roots.find((service) => service.root === '.' || path === service.root || path.startsWith(`${service.root}/`))?.entity.key,
  };
}

/** The containers of the product and the links between them, read from the graph: services, their databases, the topics. */
export async function systemModel(ctx: RenderContext): Promise<{ nodes: SystemNode[]; edges: SystemEdge[]; notes: string[] }> {
  const servicesRead = await ctx.graph.list('code.service', { limit: 200 });
  const services = servicesRead.rows
    .flatMap((service) => (service.span === undefined ? [] : [{ entity: service, root: dirname(service.span.path) }]))
    .sort((a, b) => b.root.length - a.root.length || byCodePoint(a.root, b.root));
  const notes: string[] = [];
  if (servicesRead.total > servicesRead.rows.length) notes.push(`Showing ${servicesRead.rows.length} of ${servicesRead.total} services.`);
  const serviceOfPath = (path: string): string | undefined => services.find((service) => service.root === '.' || path === service.root || path.startsWith(`${service.root}/`))?.entity.key;
  const nodes = new Map<string, SystemNode>();
  for (const service of [...services].sort((a, b) => byCodePoint(a.entity.key, b.entity.key))) {
    const infrastructure = Array.isArray(service.entity.properties['infrastructure']) ? (service.entity.properties['infrastructure'] as unknown[]).map(String).join(', ') : '';
    nodes.set(service.entity.key, { id: service.entity.key, kind: 'service', label: service.entity.label, sub: [String(service.entity.properties['language'] ?? ''), infrastructure].filter(Boolean).join(' · '), href: refOfGraph(ctx, service.entity).href });
  }
  const edges = new Map<string, SystemEdge>();
  const addEdge = (from: string, to: string, via: SystemEdge['via'], label: string): void => {
    if (from === to) return;
    const key = `${from}|${to}|${via}`;
    const held = edges.get(key);
    if (held === undefined) edges.set(key, { from, to, via, label, count: 1 });
    else {
      held.count += 1;
      if (!held.label.split(', ').includes(label)) held.label = `${held.label}, ${label}`;
    }
  };
  // Who serves an operation: the service of the route or the file that serves it.
  const server = new Map<string, string>();
  const cut = (relation: string, read: { total: number; rows: unknown[] }): void => {
    if (read.total > read.rows.length) notes.push(`Only ${read.rows.length} of ${read.total} ${relation} links were read; links and services shown may be missing.`);
  };
  const serves = await ctx.graph.relationEdges('code.serves', 5000);
  cut('code.serves', serves);
  for (const edge of serves.rows) {
    const owner = serviceOfPath(pathOfKey(edge.from.key));
    if (owner !== undefined) server.set(edge.to.key, owner);
  }
  const remote = await ctx.graph.relationEdges('code.calls-remote', 5000);
  cut('code.calls-remote', remote);
  for (const edge of remote.rows) {
    const caller = serviceOfPath(pathOfKey(edge.from.key));
    if (caller === undefined) continue;
    const via = String(edge.properties['via'] ?? 'http') === 'grpc' ? 'grpc' : 'http';
    let callee = edge.to.kind === 'code.route' ? serviceOfPath(pathOfKey(edge.to.key)) : server.get(edge.to.key);
    if (callee === undefined) {
      callee = `external:${edge.to.key}`;
      nodes.set(callee, { id: callee, kind: 'external', label: edge.to.label, sub: 'no service of the graph serves it', href: null });
    }
    addEdge(caller, callee, via, edge.to.label.length > 28 ? `${edge.to.label.slice(0, 27)}…` : edge.to.label);
  }
  for (const [relation, word] of [['code.reads-table', 'reads'], ['code.writes-table', 'writes']] as const) {
    const found = await ctx.graph.relationEdges(relation, 5000);
    cut(relation, found);
    for (const edge of found.rows) {
      const caller = serviceOfPath(pathOfKey(edge.from.key));
      if (caller === undefined) continue;
      const database = edge.to.key.slice(edge.to.key.indexOf(':') + 1).split('/')[0]!;
      const id = `code.database:${database}`;
      if (!nodes.has(id)) {
        const [entity] = await ctx.graph.find(id);
        nodes.set(id, { id, kind: 'database', label: database, sub: 'database', href: entity === undefined ? null : refOfGraph(ctx, entity).href });
      }
      addEdge(caller, id, 'sql', word);
    }
  }
  for (const [relation, via] of [['code.publishes', 'publishes'], ['code.consumes', 'consumes']] as const) {
    const found = await ctx.graph.relationEdges(relation, 5000);
    cut(relation, found);
    for (const edge of found.rows) {
      if (edge.to.kind !== 'code.channel') continue;
      const owner = serviceOfPath(pathOfKey(edge.from.key));
      if (owner === undefined) continue;
      if (!nodes.has(edge.to.key)) {
        const [entity] = await ctx.graph.find(edge.to.key);
        nodes.set(edge.to.key, { id: edge.to.key, kind: 'topic', label: edge.to.label, sub: 'topic', href: entity === undefined ? null : refOfGraph(ctx, entity).href });
      }
      if (via === 'publishes') addEdge(owner, edge.to.key, 'publishes', 'publishes');
      else addEdge(edge.to.key, owner, 'consumes', 'consumes');
    }
  }
  if (services.length === 0) notes.push('The graph holds no service yet.');
  return { nodes: [...nodes.values()], edges: [...edges.values()].sort((a, b) => byCodePoint(`${a.from}|${a.to}|${a.via}`, `${b.from}|${b.to}|${b.via}`)), notes };
}

// ---- modules of a service -----------------------------------------------------------------------

/** The module graph of a service: its modules, the dependencies between them and the cycles; undefined when the subject is no service. */
export async function modulesBlockModel(ctx: RenderContext, subject: Subject): Promise<{ service: string; nodes: ModuleNode[]; edges: ModuleEdge[]; cycles: string[][]; notes: string[] } | undefined> {
  if (subject.source !== 'graph' || subject.entity.kind !== 'code.service' || subject.entity.span === undefined) return undefined;
  const root = dirname(subject.entity.span.path);
  const found = await ctx.graph.byPrefix('code.module', root === '.' ? 'code.module:' : `code.module:${root}`, 400);
  const inside = found.rows.filter((module) => {
    const path = module.key.slice('code.module:'.length);
    return root === '.' || path === root || path.startsWith(`${root}/`);
  });
  const notes: string[] = [];
  if (found.total > found.rows.length) notes.push(`Showing ${found.rows.length} of ${found.total} modules.`);
  const keys = new Set(inside.map((module) => module.key));
  const dependsOn = await ctx.graph.relationEdges('code.depends-on', 20000);
  const cycleMembers = await ctx.graph.relationEdges('code.cycle-member', 20000);
  if (dependsOn.total > dependsOn.rows.length) notes.push(`Only ${dependsOn.rows.length} of ${dependsOn.total} module dependencies were read.`);
  if (cycleMembers.total > cycleMembers.rows.length) notes.push(`Only ${cycleMembers.rows.length} of ${cycleMembers.total} cycle memberships were read.`);
  const cycles = new Map<string, string[]>();
  for (const edge of cycleMembers.rows) {
    if (edge.from.kind === 'code.cycle' && edge.to.kind === 'code.module' && keys.has(edge.to.key)) cycles.set(edge.from.key, [...(cycles.get(edge.from.key) ?? []), edge.to.key]);
  }
  const inCycle = new Set([...cycles.values()].flat());
  const cycleOf = (a: string, b: string): boolean => [...cycles.values()].some((members) => members.includes(a) && members.includes(b));
  const prefix = root === '.' ? '' : `${root}/`;
  const nodes: ModuleNode[] = inside.map((module) => ({
    id: module.key, label: module.key.slice('code.module:'.length).slice(prefix.length) || '.', files: Number(module.properties['files'] ?? 0), href: refOfGraph(ctx, module).href, cycle: inCycle.has(module.key),
  }));
  const edges: ModuleEdge[] = dependsOn.rows
    .filter((edge) => keys.has(edge.from.key) && keys.has(edge.to.key))
    .map((edge) => ({ from: edge.from.key, to: edge.to.key, cycle: cycleOf(edge.from.key, edge.to.key) }));
  if (nodes.length === 0) notes.push(`The graph holds no module under ${root}.`);
  return { service: subject.entity.label, nodes, edges, cycles: [...cycles.entries()].sort((a, b) => byCodePoint(a[0], b[0])).map(([, members]) => members.sort(byCodePoint)), notes };
}

// ---- the treemap --------------------------------------------------------------------------------

export async function treemapBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>): Promise<Block> {
  const title = params['title'] ?? 'Files by size and change';
  const limit = toInt(params['limit'], 400, 10, 1500);
  let scope = '';
  if (params['scope'] !== undefined) scope = params['scope'].replace(/\/+$/, '');
  else if (subject.source === 'graph' && subject.entity.kind === 'code.service' && subject.entity.span !== undefined) scope = dirname(subject.entity.span.path) === '.' ? '' : dirname(subject.entity.span.path);
  const found = await ctx.graph.byPrefix('code.file', scope === '' ? 'code.file:' : `code.file:${scope}/`, limit);
  const notes: string[] = [];
  if (found.total > found.rows.length) notes.push(`Showing the first ${found.rows.length} of ${found.total} files by path.`);
  // Generated files (lock files) are not code anyone edits: they would fill the picture and carry no hotspot.
  const generated = (path: string): boolean => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|go\.sum|Cargo\.lock|poetry\.lock|composer\.lock)$/.test(path);
  const churn = await ctx.graph.inDegrees('code.touched', found.rows.map((file) => file.key));
  let lockfiles = 0;
  const files: TreemapFile[] = [];
  let unread = 0;
  const queue = [...found.rows];
  const read = async (): Promise<void> => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const path = String(file.properties['path'] ?? pathOfKey(file.key));
      if (generated(path)) {
        lockfiles += 1;
        continue;
      }
      const repo = ctx.repoOfScope(file.scope) ?? null;
      const text = await ctx.readSource(repo, path);
      if (text === undefined) {
        unread += 1;
        continue;
      }
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      files.push({ id: file.key, path, href: refOfGraph(ctx, file).href, lines, churn: churn.get(file.key) ?? 0 });
    }
  };
  await Promise.all(Array.from({ length: 8 }, read));
  if (lockfiles > 0) notes.push(`${lockfiles} lock file${lockfiles === 1 ? ' is' : 's are'} generated and not drawn.`);
  if (unread > 0) notes.push(`${unread} file${unread === 1 ? ' was' : 's were'} not readable at the commit the graph was filled from and ${unread === 1 ? 'is' : 'are'} not drawn.`);
  files.sort((a, b) => byCodePoint(a.path, b.path));
  return { type: 'treemap', title, scope, files, maxChurn: files.reduce((max, file) => Math.max(max, file.churn), 0), total: found.total, notes };
}
