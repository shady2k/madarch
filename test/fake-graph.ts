/**
 * A graph reader over declarations held in memory, for the wiki's page tests:
 * the one graph's reader is a class with a database behind it, and a page's
 * rendering is judged on the entities and edges a test declares. The fake
 * answers the same methods the real reader does, in the same order.
 */
import type { GraphReader, GraphEntity, HistoryEvidence, NeighborEdge, NeighborGroup, RelationEdge, SourceSpan } from '../src/knowledge/graph-read.js';
import { byCodePoint } from '../src/model/order.js';

interface FakeNode {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly properties: Record<string, unknown>;
  readonly scope: string;
}

interface FakeEdge {
  readonly relation: string;
  readonly from: string;
  readonly to: string;
  readonly properties: Record<string, unknown>;
  readonly discriminator: string;
}

export class FakeGraph {
  private readonly nodes = new Map<string, FakeNode>();
  private readonly edges: FakeEdge[] = [];
  private readonly scope: string;

  constructor(scope = '1') { this.scope = scope; }

  add(key: string, kind: string, label: string, properties: Record<string, unknown> = {}, scope = this.scope): void {
    this.nodes.set(key, { key, kind, label, properties: { ...properties, recordKey: key }, scope });
  }

  link(relation: string, from: string, to: string, properties: Record<string, unknown> = {}, discriminator = ''): void {
    this.edges.push({ relation, from, to, properties, discriminator });
  }

  reader(): GraphReader {
    return new FakeReader(this) as unknown as GraphReader;
  }

  /** The declarations, for a reader that asks for one entity by key. */
  node(key: string): FakeNode | undefined { return this.nodes.get(key); }
  allNodes(): readonly FakeNode[] { return [...this.nodes.values()]; }
  allEdges(): readonly FakeEdge[] { return this.edges; }
  repository(): string { return this.scope; }
}

class FakeReader {
  constructor(private readonly graph: FakeGraph) {}

  private entity(node: FakeNode): GraphEntity {
    const span = (node.properties['span'] as SourceSpan | undefined);
    return { key: node.key, kind: node.kind, label: node.label, properties: node.properties, nodeIds: [node.key], scope: node.scope, ...(span === undefined ? {} : { span }) };
  }

  private ofKind(kind: string): GraphEntity[] {
    return this.graph.allNodes().filter((node) => node.kind === kind).map((node) => this.entity(node)).sort((a, b) => byCodePoint(a.key, b.key));
  }

  async landmarkPlan(): Promise<undefined> { return undefined; }
  at(): GraphReader { return this as unknown as GraphReader; }

  async find(key: string): Promise<GraphEntity[]> {
    const node = this.graph.node(key);
    return node === undefined ? [] : [this.entity(node)];
  }

  async kindCounts(): Promise<{ kind: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const node of this.graph.allNodes()) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    return [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => byCodePoint(a.kind, b.kind));
  }

  async list(kind: string, options: { q?: string; after?: string; limit: number }): Promise<{ rows: GraphEntity[]; next: string | null; total: number }> {
    const text = options.q?.toLowerCase() ?? '';
    const all = this.ofKind(kind).filter((entity) => text === '' || entity.key.toLowerCase().includes(text) || entity.label.toLowerCase().includes(text));
    const after = options.after === undefined ? all : all.filter((entity) => byCodePoint(entity.key, options.after!) > 0);
    const shown = after.slice(0, options.limit);
    return { rows: shown, next: after.length > options.limit ? shown[shown.length - 1]?.key ?? null : null, total: all.length };
  }

  async listOperations(options: { q?: string; after?: string; limit: number }): Promise<{ rows: GraphEntity[]; next: string | null; total: number }> {
    return await this.list('code.operation', options);
  }

  async search(kinds: readonly string[], text: string, options: { perKind: number; limit: number }): Promise<{ kind: string; total: number; entities: GraphEntity[] }[]> {
    const needle = text.trim().toLowerCase();
    if (needle === '') return [];
    const groups: { kind: string; total: number; entities: GraphEntity[] }[] = [];
    let left = options.limit;
    for (const kind of kinds) {
      if (left <= 0) break;
      const page = await this.list(kind, { q: needle, limit: Math.min(options.perKind, left) });
      if (page.total === 0) continue;
      groups.push({ kind, total: page.total, entities: page.rows });
      left -= page.rows.length;
    }
    return groups.sort((a, b) => byCodePoint(a.kind, b.kind));
  }

  async neighbors(entity: GraphEntity, options: { relations?: readonly string[]; direction?: 'out' | 'in' | 'both'; limit: number }): Promise<NeighborGroup[]> {
    const directions: ('out' | 'in')[] = options.direction === 'out' ? ['out'] : options.direction === 'in' ? ['in'] : ['out', 'in'];
    const groups: NeighborGroup[] = [];
    for (const direction of directions) {
      const byRelation = new Map<string, Map<string, number>>();
      for (const edge of this.graph.allEdges()) {
        if (options.relations !== undefined && !options.relations.includes(edge.relation)) continue;
        const [self, far] = direction === 'out' ? [edge.from, edge.to] : [edge.to, edge.from];
        if (self !== entity.key) continue;
        const held = byRelation.get(edge.relation) ?? new Map<string, number>();
        held.set(far, (held.get(far) ?? 0) + 1);
        byRelation.set(edge.relation, held);
      }
      for (const [relation, byOther] of [...byRelation].sort((a, b) => byCodePoint(a[0], b[0]))) {
        const rows = [...byOther].map(([key, edges]) => ({ entity: this.entity(this.graph.node(key)!), edges })).sort((a, b) => byCodePoint(a.entity.key, b.entity.key));
        groups.push({ relation, direction, total: rows.length, edges: [...byOther.values()].reduce((sum, n) => sum + n, 0), rows: rows.slice(0, options.limit) });
      }
    }
    return groups;
  }

  async edgesOf(entity: GraphEntity, relation: string, direction: 'out' | 'in', limit: number): Promise<{ total: number; rows: NeighborEdge[] }> {
    const rows: NeighborEdge[] = [];
    const seen = new Set<string>();
    for (const edge of this.graph.allEdges()) {
      if (edge.relation !== relation) continue;
      const [self, far] = direction === 'out' ? [edge.from, edge.to] : [edge.to, edge.from];
      if (self !== entity.key || seen.has(far)) continue;
      seen.add(far);
      const other = this.graph.node(far);
      if (other === undefined) continue;
      rows.push({ relation, direction, other: this.entity(other), properties: edge.properties, position: null, ...((edge.properties['span'] as SourceSpan | undefined) === undefined ? {} : { span: (edge.properties['span'] as SourceSpan | undefined)! }) });
    }
    rows.sort((a, b) => byCodePoint(a.other.key, b.other.key));
    return { total: rows.length, rows: rows.slice(0, limit) };
  }

  async containers(entity: GraphEntity, relation: string, limit = 8): Promise<GraphEntity[]> {
    const chain: GraphEntity[] = [];
    let current = entity;
    const seen = new Set<string>([entity.key]);
    for (let step = 0; step < limit; step += 1) {
      const edge = this.graph.allEdges().find((one) => one.relation === relation && one.to === current.key);
      if (edge === undefined) break;
      const node = this.graph.node(edge.from);
      if (node === undefined || seen.has(node.key)) break;
      seen.add(node.key);
      const next = this.entity(node);
      chain.push(next);
      current = next;
    }
    return chain;
  }

  async reach(entity: GraphEntity, relation: string, depth: number, limit: number): Promise<{ total: number; rows: { entity: GraphEntity; hops: number }[] }> {
    const reached = new Map<string, number>();
    let frontier = [entity.key];
    for (let hop = 1; hop <= depth; hop += 1) {
      const next: string[] = [];
      for (const from of frontier) for (const edge of this.graph.allEdges()) if (edge.relation === relation && edge.from === from && !reached.has(edge.to) && edge.to !== entity.key) { reached.set(edge.to, hop); next.push(edge.to); }
      frontier = next;
    }
    const rows = [...reached].flatMap(([key, hops]) => { const node = this.graph.node(key); return node === undefined ? [] : [{ entity: this.entity(node), hops }]; }).sort((a, b) => a.hops - b.hops || byCodePoint(a.entity.key, b.entity.key));
    return { total: rows.length, rows: rows.slice(0, limit) };
  }

  async byPrefix(kind: string, prefix: string, limit: number): Promise<{ total: number; rows: GraphEntity[] }> {
    const all = this.ofKind(kind).filter((entity) => entity.key.startsWith(prefix));
    return { total: all.length, rows: all.slice(0, limit) };
  }

  async relationEdges(relation: string, limit: number): Promise<{ total: number; rows: RelationEdge[] }> {
    const all = this.graph.allEdges().filter((edge) => edge.relation === relation);
    const rows = all.flatMap((edge) => {
      const from = this.graph.node(edge.from);
      const to = this.graph.node(edge.to);
      return from === undefined || to === undefined ? [] : [{ discriminator: edge.discriminator, from: { key: from.key, kind: from.kind, label: from.label }, to: { key: to.key, kind: to.kind, label: to.label }, properties: edge.properties }];
    });
    return { total: rows.length, rows: rows.slice(0, limit) };
  }

  async inDegrees(relation: string, keys: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>(keys.map((key) => [key, 0]));
    for (const edge of this.graph.allEdges()) if (edge.relation === relation && counts.has(edge.to)) counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
    return counts;
  }

  async historyEvidenceFor(entity: GraphEntity, _shape: 'path' | 'author', _limit: number): Promise<HistoryEvidence> {
    return await this.historyEvidence(entity.scope);
  }

  async historyEvidence(scope: string): Promise<HistoryEvidence> {
    const entities = this.graph.allNodes().filter((node) => node.scope === scope || node.key === scope).map((node) => this.entity(node));
    const keys = new Set(entities.map((entity) => entity.key));
    const edges = this.graph.allEdges().filter((edge) => keys.has(edge.from) && keys.has(edge.to)).map((edge) => ({ from: edge.from, to: edge.to, relation: edge.relation, properties: edge.properties }));
    return { entities, edges };
  }

  async repositories(): Promise<{ nodeId: string; path: string }[]> {
    return this.graph.allNodes().filter((node) => node.kind === 'code.repository').map((node) => ({ nodeId: node.key, path: node.label }));
  }
}
