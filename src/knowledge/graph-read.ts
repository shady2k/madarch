/**
 * The wiki's reads of the one graph (decision 0034): a vertex is identity only,
 * a kind's attributes stand in its own table, and an edge is never a vertex. The
 * reader presents the graph's code kinds as the wiki's `code.*` kinds —
 * `code.repository`, `code.directory`, `code.file`, `code.commit`, `code.author`
 * (a git signature, not a person) — and answers nothing for a kind the one graph
 * does not hold yet: an empty result is the truth, never an error.
 */
import type { DatabaseOwner, OuterTransaction } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import type { LandmarkPlan } from './history-landmarks.js';
import { GIT_KINDS, GIT_TABLES } from '../fill/stages/git-contract.js';

export interface SourceSpan {
  path: string;
  lineStart: number;
  lineEnd: number;
  byteStart: number;
  byteEnd: number;
}

export interface GraphEntity {
  key: string;
  kind: string;
  label: string;
  properties: Record<string, unknown>;
  nodeIds: string[];
  scope: string;
  span?: SourceSpan;
}

export interface NeighborEdge {
  relation: string;
  direction: 'out' | 'in';
  other: GraphEntity;
  properties: Record<string, unknown>;
  position: { start: number; end: number } | null;
  span?: SourceSpan;
}

export interface NeighborGroup {
  relation: string;
  direction: 'out' | 'in';
  total: number;
  edges: number;
  rows: { entity: GraphEntity; edges: number; span?: SourceSpan }[];
}

export interface RelationEdge {
  discriminator?: string;
  from: { key: string; kind: string; label: string };
  to: { key: string; kind: string; label: string };
  properties: Record<string, unknown>;
}

export interface HistoryEvidence {
  entities: GraphEntity[];
  edges: { from: string; to: string; relation: string; properties: Record<string, unknown> }[];
}

type Raw = Record<string, unknown>;

const WIKI_KIND: Readonly<Record<string, string>> = {
  repository: 'code.repository',
  directory: 'code.directory',
  file: 'code.file',
  commit: 'code.commit',
  signature: 'code.author',
};

function graphKindOf(wikiKind: string): string | undefined {
  for (const [graph, wiki] of Object.entries(WIKI_KIND)) if (wiki === wikiKind) return graph;
  return undefined;
}

function graphRelationOf(relation: string): { kind: string } | undefined {
  const bare = relation.startsWith('code.') ? relation.slice('code.'.length) : relation;
  if (bare === `${GIT_KINDS.contains}` || bare === `${GIT_KINDS.touched}` || bare === `${GIT_KINDS.authored}` || bare === `${GIT_KINDS.parent}`) return { kind: bare };
  if (bare === 'renamed-to' || bare === `${GIT_KINDS.renamedFrom}`) return { kind: `${GIT_KINDS.renamedFrom}` };
  return undefined;
}

const WIKI_RELATION: Readonly<Record<string, string>> = {
  contains: 'code.contains',
  touched: 'code.touched',
  authored: 'code.authored',
  parent: 'code.parent',
  [GIT_KINDS.renamedFrom]: 'code.renamed-to',
};

export function spanFromProvenance(properties: Record<string, unknown>): SourceSpan | undefined {
  const provenance = properties['provenance'];
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) return undefined;
  const place = (provenance as Record<string, unknown>)['place'];
  if (place === null || typeof place !== 'object' || Array.isArray(place)) return undefined;
  const held = place as Record<string, unknown>;
  const range = held['range'];
  const path = held[GIT_KINDS.file];
  if (typeof path !== 'string' || range === null || typeof range !== 'object' || Array.isArray(range)) return undefined;
  const measured = range as Record<string, unknown>;
  const { startLine, endLine, startByte, endByte } = measured;
  if (typeof startLine !== 'number' || typeof endLine !== 'number' || typeof startByte !== 'number' || typeof endByte !== 'number') return undefined;
  return { path, lineStart: startLine, lineEnd: endLine, byteStart: startByte, byteEnd: endByte };
}

export function spanOf(value: unknown): SourceSpan | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const span = value as Record<string, unknown>;
  const { path, lineStart, lineEnd, byteStart, byteEnd } = span;
  if (typeof path !== 'string' || typeof lineStart !== 'number' || typeof lineEnd !== 'number' || typeof byteStart !== 'number' || typeof byteEnd !== 'number') return undefined;
  return { path, lineStart, lineEnd, byteStart, byteEnd };
}

export function presentedKey(kind: string, properties: Record<string, unknown>): string {
  if (kind === 'code.file' && typeof properties['path'] === 'string') return `code.file:${String(properties['repository'] ?? '')}/${properties['path']}`;
  if (kind === 'code.directory' && typeof properties['path'] === 'string') return `code.directory:${String(properties['repository'] ?? '')}/${properties['path']}`;
  if (kind === 'code.gitlink' && typeof properties['path'] === 'string') return `code.gitlink:${String(properties['repository'] ?? '')}/${properties['path']}`;
  if (kind === 'code.repository' && typeof properties['name'] === 'string') return `code.repository:${properties['name']}`;
  if (kind === 'code.commit' && typeof properties['hash'] === 'string') return `code.commit:${properties['hash']}`;
  if ((kind === 'code.author' || kind === 'code.signature') && typeof properties['email'] === 'string') return `code.author:${properties['email']}`;
  const recordKey = properties['recordKey'];
  return typeof recordKey === 'string' ? recordKey : String(recordKey ?? '');
}

function gitDateOf(localClock: string | null, offsetMin: number | null): string | undefined {
  if (localClock === null || offsetMin === null) return undefined;
  const sign = offsetMin < 0 ? '-' : '+';
  const total = Math.abs(offsetMin);
  return `${localClock}${sign}${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const ENTITY_SELECT = `SELECT n.id::text AS node_id, k.name AS kind,
  r.name AS repository_name, r.url AS repository_url, r.default_branch, rr.name AS scope_repository_name,
  p.text AS path, f.mode, b.hash AS blob, b.bytes::text AS bytes, b.form, b.lines::text AS lines,
  c.hash AS commit_hash, c.subject,
  to_char(c.author_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS author_clock, c.author_offset_min,
  to_char(c.commit_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS commit_clock, c.commit_offset_min,
  (SELECT count(*)::int FROM edge pe JOIN kind pk ON pk.id = pe.kind_id AND pk.name = '${GIT_KINDS.parent}' WHERE pe.from_node = n.id) AS parent_count,
  s.name AS signature_name, s.email,
  (SELECT c2.value FROM claim c2 WHERE c2.node_id = n.id AND c2.attribute = 'language' ORDER BY c2.id DESC LIMIT 1) AS language,
  (CASE WHEN k.name = '${GIT_KINDS.repository}' THEN n.id ELSE coalesce(f.repository_node, d.repository_node, g.repository_node,
    (SELECT min(he.from_node) FROM edge he JOIN kind hk ON hk.id = he.kind_id AND hk.name = '${GIT_KINDS.history}' WHERE he.to_node = n.id),
    (SELECT min(h2.from_node) FROM edge ae JOIN kind ak ON ak.id = ae.kind_id AND ak.name = '${GIT_KINDS.authored}'
       JOIN edge h2 ON h2.to_node = ae.to_node AND h2.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.history}') WHERE ae.from_node = n.id)
  ) END)::text AS scope
 FROM node n JOIN kind k ON k.id = n.kind_id
 LEFT JOIN ${GIT_TABLES.repository} r ON r.node_id = n.id
 LEFT JOIN ${GIT_TABLES.directory} d ON d.node_id = n.id
 LEFT JOIN ${GIT_TABLES.file} f ON f.node_id = n.id
 LEFT JOIN ${GIT_TABLES.gitlink} g ON g.node_id = n.id
 LEFT JOIN ${GIT_TABLES.repository} rr ON rr.node_id = coalesce(d.repository_node, f.repository_node, g.repository_node)
 LEFT JOIN ${GIT_TABLES.path} p ON p.id = coalesce(d.path_id, f.path_id, g.path_id)
 LEFT JOIN ${GIT_TABLES.blob} b ON b.id = f.blob_id
 LEFT JOIN ${GIT_TABLES.commit} c ON c.node_id = n.id
 LEFT JOIN ${GIT_TABLES.signature} s ON s.node_id = n.id`;

function keyOf(row: Raw): string {
  const kind = String(row['kind']);
  if (kind === `${GIT_KINDS.repository}`) return `code.repository:${String(row['repository_name'])}`;
  if (kind === `${GIT_KINDS.directory}`) return `code.directory:${String(row['scope_repository_name'])}/${String(row['path'])}`;
  if (kind === `${GIT_KINDS.file}`) return `code.file:${String(row['scope_repository_name'])}/${String(row['path'])}`;
  if (kind === `${GIT_KINDS.gitlink}`) return `code.gitlink:${String(row['scope_repository_name'])}/${String(row['path'])}`;
  if (kind === `${GIT_KINDS.commit}`) return `code.commit:${String(row['commit_hash'])}`;
  if (kind === `${GIT_KINDS.signature}`) return `code.author:${String(row['email'])}`;
  return `${kind}:${String(row['node_id'])}`;
}

function labelOf(row: Raw): string {
  const kind = String(row['kind']);
  if (kind === `${GIT_KINDS.repository}`) return String(row['repository_name']);
  if (kind === `${GIT_KINDS.directory}` || kind === `${GIT_KINDS.file}`) return String(row['path']);
  if (kind === `${GIT_KINDS.commit}`) return String(row['subject'] ?? row['commit_hash']);
  if (kind === `${GIT_KINDS.signature}`) return `${String(row['signature_name'])} <${String(row['email'])}>`;
  return String(row['node_id']);
}

function entityOf(row: Raw): GraphEntity {
  const graphKind = String(row['kind']);
  const kind = WIKI_KIND[graphKind] ?? graphKind;
  const properties: Record<string, unknown> = { recordKey: keyOf(row) };
  if (graphKind === `${GIT_KINDS.repository}`) {
    properties['name'] = row['repository_name'];
    properties['url'] = row['repository_url'];
    properties['defaultBranch'] = row['default_branch'];
  } else if (graphKind === `${GIT_KINDS.directory}` || graphKind === `${GIT_KINDS.file}` || graphKind === `${GIT_KINDS.gitlink}`) {
    properties['repository'] = row['scope_repository_name'];
    properties['path'] = row['path'];
    if (graphKind === `${GIT_KINDS.file}`) {
      properties['mode'] = row['mode'];
      properties['blob'] = row['blob'];
      properties['bytes'] = row['bytes'] === null || row['bytes'] === undefined ? undefined : Number(row['bytes']);
      properties['form'] = row['form'];
      properties['lines'] = row['lines'] === null || row['lines'] === undefined ? undefined : Number(row['lines']);
      const claim = (row['language'] ?? undefined) as Record<string, unknown> | undefined;
      const language = typeof claim?.['language'] === 'string' ? claim['language'] : undefined;
      const candidates = Array.isArray(claim?.['candidates']) ? claim['candidates'].filter((one): one is string => typeof one === 'string') : [];
      properties['language'] = language;
      properties['candidates'] = language === undefined ? candidates : candidates.length === 0 ? [language] : candidates;
    }
  } else if (graphKind === `${GIT_KINDS.commit}`) {
    properties['hash'] = row['commit_hash'];
    properties['subject'] = row['subject'];
    properties['authoredAt'] = gitDateOf(row['author_clock'] as string | null, row['author_offset_min'] as number | null);
    properties['committedAt'] = gitDateOf(row['commit_clock'] as string | null, row['commit_offset_min'] as number | null);
    properties['effectiveAt'] = properties['committedAt'];
    properties['merge'] = Number(row['parent_count'] ?? 0) > 1;
    properties['onFirstParent'] = true;
  } else if (graphKind === `${GIT_KINDS.signature}`) {
    properties['name'] = row['signature_name'];
    properties['email'] = row['email'];
  }
  const span = spanOf(properties['span']) ?? spanFromProvenance(properties);
  return {
    key: presentedKey(kind, properties), kind, label: labelOf(row), properties,
    nodeIds: [String(row['node_id'])], scope: String(row['scope'] ?? ''),
    ...(span === undefined ? {} : { span }),
  };
}

async function edgeProperties(tx: OuterTransaction, edgeId: string, graphKind: string): Promise<Record<string, unknown>> {
  if (graphKind === `${GIT_KINDS.touched}`) {
    const found = await tx.query<{ change: string; added: string | null; removed: string | null }>(`SELECT change, added::text AS added, removed::text AS removed FROM ${GIT_TABLES.touched} WHERE edge_id = $1::bigint`, [edgeId]);
    const row = found.rows[0];
    return row === undefined ? {} : { change: row.change, added: row.added === null ? null : Number(row.added), removed: row.removed === null ? null : Number(row.removed) };
  }
  if (graphKind === `${GIT_KINDS.parent}`) {
    const found = await tx.query<{ position: number }>(`SELECT position FROM ${GIT_TABLES.parent_position} WHERE edge_id = $1::bigint`, [edgeId]);
    return found.rows[0] === undefined ? {} : { position: found.rows[0].position };
  }
  if (graphKind === `${GIT_KINDS.history}`) {
    const found = await tx.query<{ walk: number }>(`SELECT walk FROM ${GIT_TABLES.history} WHERE edge_id = $1::bigint`, [edgeId]);
    return found.rows[0] === undefined ? {} : { walk: found.rows[0].walk };
  }
  return {};
}

export class GraphReader {
  constructor(
    private readonly owner: DatabaseOwner,
    _validAt: () => Promise<string> | string,
    private readonly scope?: string,
    private readonly transaction?: OuterTransaction,
    /** The graph kinds the product declares; a reader without a set answers every kind a store holds. */
    private readonly declared?: ReadonlySet<string>,
  ) {}

  at(instant: string, scope: string): GraphReader {
    return new GraphReader(this.owner, () => instant, BigInt(scope).toString(), this.transaction, this.declared);
  }

  /** Whether the product declares the graph kind; a reader without a set answers every kind. */
  private holds(kind: string): boolean {
    return this.declared === undefined || this.declared.has(kind);
  }

  async landmarkPlan(_repo?: string, _scope?: string, _head?: string): Promise<LandmarkPlan | undefined> {
    return undefined;
  }

  private async run<T>(work: (tx: OuterTransaction) => Promise<T>): Promise<T> {
    if (this.transaction !== undefined) return await work(this.transaction);
    return await this.owner.transaction('snapshot', work);
  }

  private scoped(entities: readonly GraphEntity[]): GraphEntity[] {
    return this.scope === undefined ? [...entities] : entities.filter((entity) => entity.scope === this.scope);
  }

  async find(key: string): Promise<GraphEntity[]> {
    const colon = key.indexOf(':');
    const prefix = colon < 0 ? key : key.slice(0, colon);
    const tail = colon < 0 ? '' : key.slice(colon + 1);
    const graphKind = graphKindOf(prefix);
    if (graphKind === undefined || !this.holds(graphKind)) return [];
    return await this.run(async (tx) => {
      const referenceKind = graphKind === `${GIT_KINDS.directory}` || graphKind === `${GIT_KINDS.file}` || graphKind === `${GIT_KINDS.gitlink}`;
      const slash = referenceKind ? tail.indexOf('/') : -1;
      const repository = slash < 0 ? '' : tail.slice(0, slash);
      const path = slash < 0 ? tail : tail.slice(slash + 1);
      const condition = graphKind === `${GIT_KINDS.repository}` ? 'r.name = $2'
        : graphKind === `${GIT_KINDS.commit}` ? 'c.hash = $2'
          : graphKind === `${GIT_KINDS.signature}` ? 's.email = $2'
            : referenceKind && repository !== '' ? 'rr.name = $2 AND p.text = $3' : 'p.text = $2';
      const params = referenceKind && repository !== '' ? [graphKind, repository, path] : [graphKind, referenceKind ? path : tail];
      const found = await tx.query<Raw>(`${ENTITY_SELECT} WHERE k.name = $1 AND ${condition} ORDER BY n.id`, params);
      return this.scoped(found.rows.map(entityOf));
    });
  }

  async kindCounts(): Promise<{ kind: string; count: number }[]> {
    const parts: string[] = [];
    if (this.holds(`${GIT_KINDS.repository}`)) parts.push(`SELECT '${GIT_KINDS.repository}' AS kind, count(*)::text AS n FROM ${GIT_TABLES.repository}`);
    if (this.holds(`${GIT_KINDS.directory}`)) parts.push(`SELECT '${GIT_KINDS.directory}', count(*)::text FROM ${GIT_TABLES.directory} d JOIN edge e ON e.to_node = d.node_id AND e.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.contains}')`);
    if (this.holds(`${GIT_KINDS.file}`)) parts.push(`SELECT '${GIT_KINDS.file}', count(*)::text FROM ${GIT_TABLES.file} f JOIN edge e ON e.to_node = f.node_id AND e.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.contains}')`);
    if (this.holds(`${GIT_KINDS.commit}`)) parts.push(`SELECT '${GIT_KINDS.commit}', count(*)::text FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.history}'`);
    if (this.holds(`${GIT_KINDS.signature}`)) parts.push(`SELECT '${GIT_KINDS.signature}', count(*)::text FROM ${GIT_TABLES.signature} s WHERE EXISTS (SELECT 1 FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.authored}' WHERE e.from_node = s.node_id)`);
    if (parts.length === 0) return [];
    return await this.run(async (tx) => {
      const found = await tx.query<{ kind: string; n: string }>(parts.join(' UNION ALL '));
      return found.rows.map((row) => ({ kind: WIKI_KIND[row.kind] ?? row.kind, count: Number(row.n) })).sort((a, b) => byCodePoint(a.kind, b.kind));
    });
  }

  async list(kind: string, options: { q?: string; after?: string; limit: number }): Promise<{ rows: GraphEntity[]; next: string | null; total: number }> {
    return await this.listKinds([kind], options);
  }

  /**
   * The wiki-wide search over the one graph: the entities of the declared kinds whose label or key holds the text, at
   * most `perKind` of each kind, with each kind's own total. The read is the same store the lists are read from.
   */
  async search(kinds: readonly string[], text: string, options: { perKind: number; limit: number }): Promise<{ kind: string; total: number; entities: GraphEntity[] }[]> {
    const needle = text.trim();
    if (kinds.length === 0 || needle === '') return [];
    const groups: { kind: string; total: number; entities: GraphEntity[] }[] = [];
    let remaining = options.limit;
    for (const kind of kinds) {
      if (remaining <= 0) break;
      const page = await this.list(kind, { q: needle, limit: Math.min(options.perKind, remaining) });
      if (page.total === 0) continue;
      groups.push({ kind, total: page.total, entities: page.rows });
      remaining -= page.rows.length;
    }
    return groups.sort((a, b) => byCodePoint(a.kind, b.kind));
  }

  async listOperations(options: { q?: string; after?: string; limit: number }): Promise<{ rows: GraphEntity[]; next: string | null; total: number }> {
    return await this.listKinds(['code.operation', 'code.channel'], options);
  }

  private async listKinds(kinds: readonly string[], options: { q?: string; after?: string; limit: number }): Promise<{ rows: GraphEntity[]; next: string | null; total: number }> {
    const graphKinds = kinds.map(graphKindOf).filter((one): one is string => one !== undefined && this.holds(one));
    if (graphKinds.length === 0) return { rows: [], next: null, total: 0 };
    return await this.run(async (tx) => {
      const entities = await this.entitiesOfKinds(tx, graphKinds);
      const text = options.q === undefined || options.q.trim() === '' ? undefined : options.q.trim().toLowerCase();
      const matching = entities.filter((entity) => text === undefined || entity.key.toLowerCase().includes(text) || entity.label.toLowerCase().includes(text));
      matching.sort((a, b) => byCodePoint(a.key, b.key));
      const tail = options.after === undefined ? matching : matching.filter((entity) => byCodePoint(entity.key, options.after!) > 0);
      const shown = tail.slice(0, options.limit);
      return { rows: shown, next: tail.length > options.limit ? shown[shown.length - 1]?.key ?? null : null, total: matching.length };
    });
  }

  private async entitiesOfKinds(tx: OuterTransaction, graphKinds: readonly string[]): Promise<GraphEntity[]> {
    const found = await tx.query<Raw>(
      `${ENTITY_SELECT} WHERE k.name = ANY($1::text[])
       AND (k.name NOT IN ('${GIT_KINDS.directory}', '${GIT_KINDS.file}') OR EXISTS (SELECT 1 FROM edge e JOIN kind ek ON ek.id = e.kind_id AND ek.name = '${GIT_KINDS.contains}' WHERE e.to_node = n.id))
       AND (k.name <> '${GIT_KINDS.commit}' OR EXISTS (SELECT 1 FROM edge e JOIN kind ek ON ek.id = e.kind_id AND ek.name = '${GIT_KINDS.history}' WHERE e.to_node = n.id))
       AND (k.name <> '${GIT_KINDS.signature}' OR EXISTS (SELECT 1 FROM edge e JOIN kind ek ON ek.id = e.kind_id AND ek.name = '${GIT_KINDS.authored}' WHERE e.from_node = n.id))
       ORDER BY n.id`,
      [`{${graphKinds.join(',')}}`],
    );
    return this.scoped(found.rows.map(entityOf));
  }

  private async entitiesOfIds(tx: OuterTransaction, ids: readonly string[]): Promise<Map<string, GraphEntity>> {
    if (ids.length === 0) return new Map();
    const found = await tx.query<Raw>(`${ENTITY_SELECT} WHERE n.id = ANY($1::bigint[]) ORDER BY n.id`, [`{${ids.join(',')}}`]);
    return new Map(found.rows.map((row) => [String(row['node_id']), entityOf(row)]));
  }

  async neighbors(entity: GraphEntity, options: { relations?: readonly string[]; direction?: 'out' | 'in' | 'both'; limit: number }): Promise<NeighborGroup[]> {
    if (this.declared !== undefined && this.declared.size === 0) return [];
    const wanted = (options.relations ?? ['code.contains', 'code.touched', 'code.authored', 'code.parent', 'code.renamed-to'])
      .map((relation) => ({ relation, graph: graphRelationOf(relation) }))
      .filter((one): one is { relation: string; graph: { kind: string } } => one.graph !== undefined);
    if (wanted.length === 0) return [];
    const directions: ('out' | 'in')[] = options.direction === 'out' ? ['out'] : options.direction === 'in' ? ['in'] : ['out', 'in'];
    return await this.run(async (tx) => {
      const found = await tx.query<Record<string, string>>(
        `SELECT e.id::text AS id, rk.name AS relation, e.from_node::text AS from_node, e.to_node::text AS to_node
         FROM edge e JOIN kind rk ON rk.id = e.kind_id
         WHERE rk.name = ANY($1::text[]) AND (e.from_node = ANY($2::bigint[]) OR e.to_node = ANY($2::bigint[]))`,
        [`{${[...new Set(wanted.map((one) => one.graph.kind))].join(',')}}`, `{${entity.nodeIds.join(',')}}`],
      );
      const groups: NeighborGroup[] = [];
      for (const direction of directions) {
        const [self, far] = direction === 'out' ? ['from_node', 'to_node'] : ['to_node', 'from_node'];
        const relevant = found.rows.filter((row) => entity.nodeIds.includes(row[self]!) && wanted.some((one) => one.graph.kind === row['relation']));
        const byRelation = new Map<string, Map<string, number>>();
        for (const row of relevant) {
          const relationName = row['relation']!;
          const wiki = WIKI_RELATION[relationName] ?? `code.${relationName}`;
          const held = byRelation.get(wiki) ?? new Map<string, number>();
          const other = row[far]!;
          held.set(other, (held.get(other) ?? 0) + 1);
          byRelation.set(wiki, held);
        }
        for (const [relation, byOther] of [...byRelation].sort((a, b) => byCodePoint(a[0], b[0]))) {
          const ids = [...byOther.keys()];
          const entities = await this.entitiesOfIds(tx, ids);
          const ordered = ids.map((id) => ({ id, entity: entities.get(id) })).filter((one): one is { id: string; entity: GraphEntity } => one.entity !== undefined).sort((a, b) => byCodePoint(a.entity.key, b.entity.key));
          const shown = ordered.slice(0, options.limit);
          groups.push({ relation, direction, total: ordered.length, edges: [...byOther.values()].reduce((sum, count) => sum + count, 0), rows: shown.map((one) => ({ entity: one.entity, edges: byOther.get(one.id) ?? 1 })) });
        }
      }
      return groups;
    });
  }

  async edgesOf(entity: GraphEntity, relation: string, direction: 'out' | 'in', limit: number): Promise<{ total: number; rows: NeighborEdge[] }> {
    if (this.declared !== undefined && this.declared.size === 0) return { total: 0, rows: [] };
    const graph = graphRelationOf(relation);
    if (graph === undefined) return { total: 0, rows: [] };
    const [self, far] = direction === 'out' ? ['from_node', 'to_node'] : ['to_node', 'from_node'];
    return await this.run(async (tx) => {
      const found = await tx.query<{ id: string; other: string; discriminator: string }>(
        `SELECT e.id::text AS id, e.${far}::text AS other, e.discriminator FROM edge e JOIN kind k ON k.id = e.kind_id
         WHERE k.name = $1 AND e.${self} = ANY($2::bigint[]) ORDER BY e.${far}, e.id`,
        [graph.kind, `{${entity.nodeIds.join(',')}}`],
      );
      const keys = [...new Set(found.rows.map((row) => row.other))];
      const entities = await this.entitiesOfIds(tx, keys);
      const ordered = keys.map((id) => entities.get(id)).filter((one): one is GraphEntity => one !== undefined).sort((a, b) => byCodePoint(a.key, b.key));
      const shown = ordered.slice(0, limit);
      const rows: NeighborEdge[] = [];
      for (const other of shown) {
        const edges = found.rows.filter((row) => row.other === other.nodeIds[0]);
        const first = edges[0];
        if (first === undefined) continue;
        rows.push({ relation, direction, other, properties: { ...(await edgeProperties(tx, first.id, graph.kind)), discriminator: first.discriminator, sites: edges.length }, position: null });
      }
      return { total: ordered.length, rows };
    });
  }

  async containers(entity: GraphEntity, relation: string, limit = 8): Promise<GraphEntity[]> {
    if (this.declared !== undefined && this.declared.size === 0) return [];
    const graph = graphRelationOf(relation);
    if (graph === undefined) return [];
    return await this.run(async (tx) => {
      const chain: GraphEntity[] = [];
      let current = entity;
      const seen = new Set<string>([entity.key]);
      for (let step = 0; step < limit; step += 1) {
        const parent = await tx.query<{ node: string }>(
          `SELECT e.from_node::text AS node FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = $1 WHERE e.to_node = ANY($2::bigint[]) LIMIT 1`,
          [graph.kind, `{${current.nodeIds.join(',')}}`],
        );
        const id = parent.rows[0]?.node;
        if (id === undefined) break;
        const [next] = [...(await this.entitiesOfIds(tx, [id])).values()];
        if (next === undefined || seen.has(next.key)) break;
        seen.add(next.key);
        chain.push(next);
        current = next;
      }
      return chain;
    });
  }

  async reach(entity: GraphEntity, relation: string, depth: number, limit: number): Promise<{ total: number; rows: { entity: GraphEntity; hops: number }[] }> {
    if (this.declared !== undefined && this.declared.size === 0) return { total: 0, rows: [] };
    const graph = graphRelationOf(relation);
    if (graph === undefined) return { total: 0, rows: [] };
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; hops: number }>(
        `WITH RECURSIVE reach(node_id, hops) AS (
           SELECT e.to_node, 1 FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = $2 WHERE e.from_node = ANY($1::bigint[])
           UNION
           SELECT e.to_node, p.hops + 1 FROM reach p JOIN edge e ON e.from_node = p.node_id JOIN kind k ON k.id = e.kind_id AND k.name = $2 WHERE p.hops < $3::int
         )
         SELECT node_id::text AS node, min(hops)::int AS hops FROM reach GROUP BY node_id ORDER BY hops, node_id`,
        [`{${entity.nodeIds.join(',')}}`, graph.kind, depth],
      );
      const wanted = found.rows.filter((row) => !entity.nodeIds.includes(row.node));
      const shown = wanted.slice(0, limit);
      const entities = await this.entitiesOfIds(tx, shown.map((row) => row.node));
      return { total: wanted.length, rows: shown.flatMap((row) => { const one = entities.get(row.node); return one === undefined || one.key === entity.key ? [] : [{ entity: one, hops: Number(row.hops) }]; }) };
    });
  }

  async byPrefix(kind: string, prefix: string, limit: number): Promise<{ total: number; rows: GraphEntity[] }> {
    if (this.declared !== undefined && this.declared.size === 0) return { total: 0, rows: [] };
    const graphKind = graphKindOf(kind);
    if (graphKind === undefined || !this.holds(graphKind)) return { total: 0, rows: [] };
    return await this.run(async (tx) => {
      const entities = await this.entitiesOfKinds(tx, [graphKind]);
      const referenceKind = graphKind === `${GIT_KINDS.directory}` || graphKind === `${GIT_KINDS.file}` || graphKind === `${GIT_KINDS.gitlink}`;
      const head = `code.${graphKind}:`;
      const rest = prefix.startsWith(head) ? prefix.slice(head.length) : '';
      const pathPrefix = referenceKind && rest !== '' && rest.includes('/') ? rest : undefined;
      const matching = entities.filter((entity) => pathPrefix !== undefined
        ? String(entity.properties['path'] ?? '').startsWith(pathPrefix)
        : entity.key.startsWith(prefix)).sort((a, b) => byCodePoint(a.key, b.key));
      return { total: matching.length, rows: matching.slice(0, limit) };
    });
  }

  async relationEdges(relation: string, limit: number): Promise<{ total: number; rows: RelationEdge[] }> {
    if (this.declared !== undefined && this.declared.size === 0) return { total: 0, rows: [] };
    const graph = graphRelationOf(relation);
    if (graph === undefined) return { total: 0, rows: [] };
    return await this.run(async (tx) => {
      const found = await tx.query<{ id: string; from_node: string; to_node: string; discriminator: string }>(
        `SELECT e.id::text AS id, e.from_node::text AS from_node, e.to_node::text AS to_node, e.discriminator
         FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = $1 ORDER BY e.from_node, e.to_node, e.discriminator, e.id`,
        [graph.kind],
      );
      const entities = await this.entitiesOfIds(tx, [...new Set(found.rows.flatMap((row) => [row.from_node, row.to_node]))]);
      const rows: RelationEdge[] = [];
      for (const row of found.rows.slice(0, limit)) {
        const from = entities.get(row.from_node);
        const to = entities.get(row.to_node);
        if (from === undefined || to === undefined) continue;
        rows.push({ discriminator: row.discriminator, from: { key: from.key, kind: from.kind, label: from.label }, to: { key: to.key, kind: to.kind, label: to.label }, properties: await edgeProperties(tx, row.id, graph.kind) });
      }
      return { total: found.rows.length, rows };
    });
  }

  async inDegrees(relation: string, keys: readonly string[]): Promise<Map<string, number>> {
    if (this.declared !== undefined && this.declared.size === 0) return new Map(keys.map((key) => [key, 0]));
    const counts = new Map<string, number>(keys.map((key) => [key, 0]));
    if (keys.length === 0) return counts;
    const graph = graphRelationOf(relation);
    if (graph === undefined) return counts;
    const entities = new Map<string, GraphEntity>();
    for (const key of keys) for (const entity of await this.find(key)) entities.set(key, entity);
    const ids = [...entities.values()].flatMap((entity) => entity.nodeIds);
    if (ids.length === 0) return counts;
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; n: string }>(
        `SELECT e.to_node::text AS node, count(DISTINCT e.id)::text AS n FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = $1
         WHERE e.to_node = ANY($2::bigint[]) GROUP BY 1`,
        [graph.kind, `{${ids.join(',')}}`],
      );
      for (const row of found.rows) for (const [key, entity] of entities) if (entity.nodeIds.includes(row.node)) counts.set(key, Number(row.n));
      return counts;
    });
  }

  async historyEvidence(scope: string): Promise<HistoryEvidence> {
    if (this.declared !== undefined && this.declared.size === 0) return { entities: [], edges: [] };
    return await this.run(async (tx) => {
      const found = await tx.query<Raw>(
        `${ENTITY_SELECT} WHERE
           n.id = $1::bigint
           OR f.repository_node = $1::bigint OR d.repository_node = $1::bigint
           OR n.id IN (SELECT e.to_node FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.history}' WHERE e.from_node = $1::bigint)
           OR n.id IN (SELECT ae.from_node FROM edge ae JOIN kind ak ON ak.id = ae.kind_id AND ak.name = '${GIT_KINDS.authored}'
                        JOIN edge h ON h.to_node = ae.to_node AND h.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.history}') WHERE h.from_node = $1::bigint)
         ORDER BY n.id`,
        [scope],
      );
      const entities = found.rows.map(entityOf);
      const byId = new Map(found.rows.map((row) => [String(row['node_id']), entityOf(row)]));
      const edges = await tx.query<{ id: string; relation: string; from_node: string; to_node: string; discriminator: string; change: string | null; added: string | null; removed: string | null; position: number | null; walk: number | null }>(
        `WITH evidence_nodes AS (
           SELECT n.id FROM node n LEFT JOIN ${GIT_TABLES.file} f ON f.node_id = n.id LEFT JOIN ${GIT_TABLES.directory} d ON d.node_id = n.id
           WHERE n.id = $1::bigint OR f.repository_node = $1::bigint OR d.repository_node = $1::bigint
             OR n.id IN (SELECT he.to_node FROM edge he JOIN kind hk ON hk.id = he.kind_id AND hk.name = '${GIT_KINDS.history}' WHERE he.from_node = $1::bigint)
             OR n.id IN (SELECT ae.from_node FROM edge ae JOIN kind ak ON ak.id = ae.kind_id AND ak.name = '${GIT_KINDS.authored}'
                          JOIN edge he ON he.to_node = ae.to_node AND he.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.history}') WHERE he.from_node = $1::bigint)
         )
         SELECT e.id::text AS id, rk.name AS relation, e.from_node::text AS from_node, e.to_node::text AS to_node,
                e.discriminator, t.change, t.added::text AS added, t.removed::text AS removed, pp.position, h.walk
         FROM edge e JOIN kind rk ON rk.id = e.kind_id
         LEFT JOIN ${GIT_TABLES.touched} t ON t.edge_id = e.id
         LEFT JOIN ${GIT_TABLES.parent_position} pp ON pp.edge_id = e.id
         LEFT JOIN ${GIT_TABLES.history} h ON h.edge_id = e.id
         WHERE rk.name IN ('${GIT_KINDS.contains}', '${GIT_KINDS.touched}', '${GIT_KINDS.authored}', '${GIT_KINDS.parent}', '${GIT_KINDS.renamedFrom}')
           AND e.from_node IN (SELECT id FROM evidence_nodes) AND e.to_node IN (SELECT id FROM evidence_nodes)
         ORDER BY rk.name, e.from_node, e.to_node, e.id`,
        [scope],
      );
      return {
        entities,
        edges: edges.rows.flatMap((row) => {
          const from = byId.get(row.from_node);
          const to = byId.get(row.to_node);
          if (from === undefined || to === undefined) return [];
          return [{ from: from.key, to: to.key, relation: WIKI_RELATION[row.relation] ?? `code.${row.relation}`, properties: {
            ...(row.change === null ? {} : { change: row.change }),
            ...(row.added === null ? {} : { added: Number(row.added) }),
            ...(row.removed === null ? {} : { removed: Number(row.removed) }),
            ...(row.position === null ? {} : { position: Number(row.position) }),
            ...(row.walk === null ? {} : { walk: Number(row.walk) }),
            ...(row.discriminator === '' ? {} : { discriminator: row.discriminator }),
          } }];
        }),
      };
    });
  }

  async repositories(): Promise<{ nodeId: string; path: string }[]> {
    if (this.declared !== undefined && this.declared.size === 0) return [];
    return await this.run(async (tx) => {
      const found = await tx.query<{ node_id: string; name: string }>(`SELECT node_id::text AS node_id, name FROM ${GIT_TABLES.repository} ORDER BY name`);
      return found.rows.map((row) => ({ nodeId: row.node_id, path: row.name }));
    });
  }
}
