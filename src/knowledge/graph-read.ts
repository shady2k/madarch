/**
 * The wiki's reads of the one graph (decision 0034 and its amendment of 2026-11-10): a vertex is its identity and its
 * key, every value stands in its entity's table as an opinion, and an edge is never a vertex. A field one open opinion
 * states is that value; a field several do is every value with its source, never one picked silently. The reader
 * presents the graph's code kinds as the wiki's `code.*` kinds —
 * `code.repository`, `code.directory`, `code.file`, `code.commit`, `code.author`
 * (a git signature, not a person) — and answers nothing for a kind the one graph
 * does not hold yet: an empty result is the truth, never an error.
 */
import type { DatabaseOwner, OuterTransaction } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import { GIT_KINDS, GIT_TABLES } from '../fill/stages/git-contract.js';
import { commitFacts, fileFacts, listFiles, listRepositories, repositoryFacts, productFileIndex } from '../graph/index.js';
import type { FileDate, FileRecord } from '../graph/index.js';
import { entityAddress } from './addresses.js';

export interface SourceSpan {
  path: string;
  lineStart: number;
  lineEnd: number;
  byteStart: number;
  byteEnd: number;
}

/** One place a claim of an entity stands: the file, the lines, and the commit or digest the value was read at. */
export interface GraphEvidence {
  /** The field the evidence is under: the claim's attribute. */
  field: string;
  repository: string | null;
  path: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  commit: string | null;
  /** What the evidence names: a file place, a conversation or another opinion (the amendment's point 7). */
  type?: 'file' | 'conversation' | 'opinion';
  /** A conversation's or an opinion's id. */
  id?: string;
  speaker?: string | null;
  at?: string | null;
  /** The opinion that stated the value: the producer and its version, the agent, or a person's node. */
  saidBy?: string;
}

export interface GraphEntity {
  key: string;
  kind: string;
  label: string;
  properties: Record<string, unknown>;
  nodeIds: string[];
  scope: string;
  span?: SourceSpan;
  /** Where the entity's values were read, one per opinion's evidence: a term's page links to its definitions. */
  evidence?: readonly GraphEvidence[];
  /** Every field value with the opinion that stated it: value-to-source, never one picked silently (A4). */
  opinions?: readonly GraphEntityOpinion[];
}

/** One field value and the opinion that stated it: its stable id, its producer and version, its language, its evidence. */
export interface GraphEntityOpinion {
  readonly field: string;
  readonly value: unknown;
  readonly opinionId: string;
  readonly producer: string;
  readonly lang: string | null;
  readonly evidence: readonly GraphEvidence[];
}

/**
 * One kind's table as the manifest's declarations made it (decision 0034, item 14): the table, its columns and its
 * natural key. A reader with these reads the kind's vertices without naming any kind: the table and its key are the
 * product's own data.
 */
export interface GeneratedKindRead {
  readonly kind: string;
  readonly table: string;
  readonly columns: readonly string[];
  /** Each column's declared type, so a text column that holds digits stays text. */
  readonly types: Readonly<Record<string, 'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'json'>>;
  readonly key: readonly string[];
  /** Per-field producer names in explicit refinement order; all source opinions remain available. */
  readonly producers?: Readonly<Record<string, readonly string[]>>;
}

/**
 * One kind's edge table, as the manifest's `edges:` declarations made it (decision 0035, items 7 and 18): the edge's
 * own fields, their types, and the kinds its ends name. A kind with no fields keeps its values in no table, and its
 * relation answers from the edge row alone.
 */
export interface GeneratedEdgeRead {
  readonly kind: string;
  readonly table?: string;
  readonly columns: readonly string[];
  readonly types: Readonly<Record<string, 'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'json'>>;
  readonly from: readonly string[];
  readonly to: readonly string[];
}

export interface NeighborEdge {
  relation: string;
  direction: 'out' | 'in';
  other: GraphEntity;
  properties: Record<string, unknown>;
  position: { start: number; end: number } | null;
  span?: SourceSpan;
}

export interface RelationEdge {
  discriminator?: string;
  from: { key: string; kind: string; label: string; properties?: Record<string, unknown> };
  to: { key: string; kind: string; label: string; properties?: Record<string, unknown> };
  properties: Record<string, unknown>;
}

type Raw = Record<string, unknown>;

/** Relations are the ordinary names declared by the product. */
function graphRelationOf(relation: string, declared?: ReadonlyMap<string, GeneratedEdgeRead>): { kind: string } | undefined {
  return declared?.has(relation) === true ? { kind: relation } : undefined;
}

/** The repository a file, folder or gitlink names in its key, and the node it is. */
const REPOSITORY_KEY = (alias: string): string => `(${alias}.key->>'repository')`;

/**
 * Whether a vertex has an edge of one relation, as SQL: the entity's id is looked up once (an InitPlan), never per row
 * (a bulk read of 1 846 rows made 1 846 index scans of `entity` for the relation's name), and only the base context
 * counts, as every edge read does.
 */
const EDGE_EXISTS = (side: 'from_node' | 'to_node', relation: string, node: string): string =>
  `EXISTS (SELECT 1 FROM edge e WHERE e.${side} = ${node}.id AND e.context_id = 1 AND e.entity_id = (SELECT id FROM entity WHERE name = '${relation}'))`;

const ENTITY_SCOPE_EXPRESSION = `(CASE WHEN k.name = '${GIT_KINDS.repository}' THEN n.id
    WHEN k.name IN ('${GIT_KINDS.directory}', '${GIT_KINDS.file}', '${GIT_KINDS.gitlink}') THEN (SELECT rn.id FROM node rn JOIN entity re ON re.id = rn.entity_id AND re.name = '${GIT_KINDS.repository}' WHERE rn.key->>'name' = ${REPOSITORY_KEY('n')} AND rn.context_id = 1 LIMIT 1)
    ELSE coalesce(
      (SELECT min(he.from_node) FROM edge he JOIN entity hk ON hk.id = he.entity_id AND hk.name = '${GIT_KINDS.history}' WHERE he.to_node = n.id AND he.context_id = 1),
      (SELECT min(h2.from_node) FROM edge ae JOIN entity ak ON ak.id = ae.entity_id AND ak.name = '${GIT_KINDS.authored}'
         JOIN edge h2 ON h2.to_node = ae.to_node AND h2.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.history}') AND h2.context_id = 1 WHERE ae.from_node = n.id AND ae.context_id = 1)
    ) END)::text`;

const PRESENTATION_COLUMNS = `${ENTITY_SCOPE_EXPRESSION} AS scope,
  CASE WHEN k.name = '${GIT_KINDS.commit}' THEN (SELECT count(*)::int FROM edge pe WHERE pe.from_node = n.id AND pe.context_id = 1 AND pe.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.parent}')) END AS parent_count,
  CASE WHEN k.name = '${GIT_KINDS.commit}' THEN (SELECT jsonb_build_object('name', sn.key->>'name', 'email', sn.key->>'email') FROM edge ae JOIN node sn ON sn.id = ae.from_node WHERE ae.to_node = n.id AND ae.context_id = 1 AND ae.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.authored}') ORDER BY ae.id LIMIT 1) END AS author`;

/** A value with the keys of every object in code point order, so two equal values render equal. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const held = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(held).sort().map((key) => [key, canonical(held[key])]));
  }
  return value;
}

/** The places one opinion's evidence list names, as a reader holds them: a file place, a conversation or an opinion. */
function evidencePlaces(value: unknown): readonly GraphEvidence[] {
  if (!Array.isArray(value)) return [];
  const out: GraphEvidence[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const held = entry as Record<string, unknown>;
    if (held['type'] === 'conversation') out.push({ type: 'conversation', id: String(held['id'] ?? ''), speaker: typeof held['speaker'] === 'string' ? held['speaker'] : null, at: typeof held['at'] === 'string' ? held['at'] : null, field: '', repository: null, path: null, lineStart: null, lineEnd: null, commit: null });
    else if (held['type'] === 'opinion') out.push({ type: 'opinion', id: String(held['id'] ?? ''), field: '', repository: null, path: null, lineStart: null, lineEnd: null, commit: null });
    else out.push({
      type: 'file',
      field: '',
      repository: typeof held['repository'] === 'string' ? held['repository'] : null,
      path: typeof held['path'] === 'string' ? held['path'] : null,
      lineStart: typeof held['line_start'] === 'number' ? held['line_start'] : null,
      lineEnd: typeof held['line_end'] === 'number' ? held['line_end'] : null,
      commit: typeof held['commit_or_digest'] === 'string' ? held['commit_or_digest'] : null,
    });
  }
  return out;
}

/** A text as a SQL literal: a kind's name stands in the counts that name it. */
function quoteLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** A table, column or key name of a generated table: lower-case letters, digits and underscores, quoted. */
function quoteColumn(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(name)) throw new Error(`src/knowledge/graph-read.ts:1: ${JSON.stringify(name)} is not a column of a generated table: a column is a lower-case identifier`);
  return `"${name}"`;
}

/** The select over one manifest-declared kind's table: the vertices an opinion stands for, with their keys. */
function generatedSelect(decl: GeneratedKindRead): string {
  return `SELECT DISTINCT n.id::text AS node_id, n.uid::text AS uid, n.key AS key FROM ${decl.table} t JOIN node n ON n.id = t.node_id WHERE t.state = 'open' AND t.context_id = 1 AND n.context_id = 1 AND NOT n.removed`;
}

/** One column's value as a reader holds it: a count as a number, a flag as a boolean, everything else as it stands. */
function valueOfColumn(value: unknown, type: GeneratedKindRead['types'][string]): unknown {
  if (value === null || value === undefined) return value;
  if (type === 'integer' || type === 'bigint') return Number(value);
  if (type === 'boolean') return value === true || value === 't' || value === 'true';
  return value;
}

/** The history's open opinion of one edge's own values: the attributes a reader shows beside the relation. */
/**
 * One edge's own values, as the wiki shows them beside the relation: every open opinion of the edge in the base
 * context is read, a field they all agree on is its value, and a field they differ on is the list of their values —
 * no producer's opinion is picked, and the newest row is not privileged (the review of stage 1c, finding 4).
 */
async function edgePropertiesOf(tx: OuterTransaction, edgeIds: readonly string[], _graphKind: string, declared?: GeneratedEdgeRead): Promise<Map<string, Record<string, unknown>>> {
  const properties = new Map<string, Record<string, unknown>>();
  if (edgeIds.length === 0) return properties;
  const opinions = async (table: string, columns: readonly string[]): Promise<Map<string, Record<string, unknown>[]>> => {
    const found = await tx.query<Record<string, unknown> & { edge_id: string }>(`SELECT o."edge_id"::text AS edge_id, ${columns.map((column) => `o."${column}"`).join(', ')} FROM ${table} o WHERE o."edge_id" = ANY($1::bigint[]) AND o."state" = 'open' AND o."context_id" = 1 ORDER BY o."id"`, [`{${edgeIds.join(',')}}`]);
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const row of found.rows) {
      const rows = grouped.get(row.edge_id) ?? [];
      rows.push(row);
      grouped.set(row.edge_id, rows);
    }
    return grouped;
  };
  const agreed = (rows: readonly Record<string, unknown>[], field: string): unknown => {
    const values = rows.map((row) => row[field]).filter((value) => value !== null && value !== undefined);
    const distinct = new Map(values.map((value) => [JSON.stringify(value), value]));
    if (distinct.size === 0) return undefined;
    return distinct.size === 1 ? values[0] : [...distinct.values()];
  };
  // One read loads the whole relation's opinions; agreement is still computed separately for each edge.
  const columns = declared?.columns ?? [];
  const table = declared?.table;
  if (table === undefined || columns.length === 0) return properties;
  const grouped = await opinions(table, columns);
  for (const edgeId of edgeIds) {
    const rows = grouped.get(edgeId) ?? [];
    const values = Object.fromEntries(columns.map((field) => [field, agreed(rows, field)]));
    for (const field of columns) if (values[field] !== undefined) {
      const value = values[field];
      values[field] = Array.isArray(value) ? value.map((one) => valueOfColumn(one, declared!.types[field] ?? 'text')) : valueOfColumn(value, declared!.types[field] ?? 'text');
    }
    properties.set(edgeId, values);
  }
  return properties;
}

async function edgeProperties(tx: OuterTransaction, edgeId: string, graphKind: string, declared?: GeneratedEdgeRead): Promise<Record<string, unknown>> {
  return (await edgePropertiesOf(tx, [edgeId], graphKind, declared)).get(edgeId) ?? {};
}


/** The repository as the graph states it, and the page a block shows of it. */
export interface GraphRepositoryFacts {
  readonly nodeId: string;
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly defaultBranch: string | null;
  readonly asIsCommit: string | null;
  readonly asIsHref: string | null;
  readonly counts: { readonly files: number; readonly commits: number; readonly folders: number };
  /** Whether the clone the history pass read is shallow: the pass's own opinion of the repository. */
  readonly historyShallow: boolean | null;
  readonly steps: { readonly tree: boolean; readonly history: boolean };
}

/** One file of a repository as a block shows it. */
export interface GraphFileFacts {
  readonly repository: string;
  readonly path: string;
  readonly id: string;
  readonly href: string;
  readonly mode: string | null;
  readonly blob: string | null;
  readonly bytes: number | null;
  readonly lines: number | null;
  readonly form: 'text' | 'binary' | null;
  readonly language: string | null;
  readonly candidates: readonly string[];
  readonly created: (FileDate & { readonly href: string }) | null;
  readonly modified: (FileDate & { readonly href: string }) | null;
  readonly commitCount: number;
  readonly authors: readonly string[];
}

/** The text one file held at one commit, or why the graph holds none of that version. */

/**
 * One file's facts, as a listing or a rule draws them: its key, its local node, its path, the repository's name, the
 * repository's node it stands in and the line count its open opinions agree on — no other field, no opinion, no evidence.
 */
export interface FileFactRow {
  readonly key: string;
  /** The vertex's local id: the churn read counts its incoming edges by it, in one query. */
  readonly node: string;
  readonly path: string;
  readonly repository: string;
  readonly scope: string;
  readonly lines: number | null;
  /** A fact a reader states about the file that the graph holds no column for today (a repository-declared generated file). */
  readonly generated?: unknown;
}

export class GraphReader {
  constructor(
    private readonly owner: DatabaseOwner,
    _validAt: () => Promise<string> | string,
    private readonly scope?: string,
    private readonly transaction?: OuterTransaction,
    /** The graph kinds the product declares; a reader without a set answers every kind a store holds. */
    private readonly declared?: ReadonlySet<string>,
    /** The kinds the manifest's own field declarations build tables for, by graph kind. */
    private readonly generated?: ReadonlyMap<string, GeneratedKindRead>,
    /** The edge kinds the manifest's `edges:` declarations build, by graph kind. */
    private readonly generatedEdges?: ReadonlyMap<string, GeneratedEdgeRead>,
  ) {}

  /** One page's repository facts: every block of a page asks for the same repository, and it is read once. */
  private readonly repositoryMemo = new Map<string, Promise<GraphRepositoryFacts | null>>();

  /** One page's history evidence: two blocks of a page ask for the same repository's story, and it is read once. */

  /** Whether the product declares the graph kind; a reader without a set answers every kind. */
  holds(kind: string): boolean {
    return this.declared === undefined || this.declared.has(kind) || this.generated?.has(kind) === true;
  }

  /** The manifest-declared kind a key or a listing names, when the product's tables hold it. */
  private generatedKind(kind: string): GeneratedKindRead | undefined {
    return this.generated?.get(kind);
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
    const kind = colon < 0 ? key : key.slice(0, colon);
    const decl = this.generatedKind(kind);
    if (decl === undefined) return [];
    return await this.run(async (tx) => this.scoped(await this.generatedFind(tx, decl, colon < 0 ? '' : key.slice(colon + 1))));
  }


  /** The owner a graph read opens its own statement on: the page's transaction while a page is drawn, never a nested one. */
  storeOwner(): DatabaseOwner {
    const transaction = this.transaction;
    if (transaction === undefined) return this.owner;
    const owner = this.owner;
    return new Proxy(owner, {
      get(target, key) {
        if (key === 'transaction') return async (_mode: string, work: (tx: OuterTransaction) => Promise<unknown>) => await work(transaction);
        if (key === 'run') return async (work: (tx: OuterTransaction) => Promise<unknown>) => await work(transaction);
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DatabaseOwner;
  }

  /**
   * One repository as the graph states it: its facts, its as-is commit, its counts and whether its history is shallow.
   * This is the graph's answer, never a page model of another store.
   */
  async repository(name: string): Promise<GraphRepositoryFacts | null> {
    const held = this.repositoryMemo.get(name);
    if (held !== undefined) return await held;
    const read = this.repositoryOnce(name);
    this.repositoryMemo.set(name, read);
    // A read that failed stands no cache entry: the next block asks again rather than inheriting the failure.
    read.catch(() => { if (this.repositoryMemo.get(name) === read) this.repositoryMemo.delete(name); });
    return await read;
  }

  /** The repository's facts, read once for the page that holds this reader. */
  private async repositoryOnce(name: string): Promise<GraphRepositoryFacts | null> {
    // A product that declares no repository kind has no repository table: the declared contract decides, never a failed read.
    if (!this.holds(GIT_KINDS.repository)) return null;
    const facts = await repositoryFacts(this.storeOwner(), name, this.declared);
    if (facts === null) return null;
    return {
      nodeId: facts.nodeId, id: `code.repository:${facts.name}`, name: facts.name, url: facts.url,
      defaultBranch: facts.defaultBranch, asIsCommit: facts.asIsCommit,
      asIsHref: facts.asIsCommit === null ? null : entityAddress(`code.commit:${facts.asIsCommit}`),
      counts: { files: facts.fileCount, commits: facts.commitCount, folders: facts.directoryCount },
      historyShallow: facts.historyShallow, steps: { tree: facts.hasTree, history: facts.commitCount > 0 },
    };
  }

  /** Every repository the graph holds, in code point order of the names, each read as its page states it. */
  async repositoryFactsAll(): Promise<GraphRepositoryFacts[]> {
    // A store with no contract tables holds no repository: it answers none, and its pages say the product is not filled.
    if (!this.holds(GIT_KINDS.repository)) return [];
    const held = await listRepositories(this.storeOwner(), this.declared);
    const out: GraphRepositoryFacts[] = [];
    for (const one of held) {
      const facts = await this.repository(one.name);
      if (facts !== null) out.push(facts);
    }
    return out;
  }

  /** Every file of a repository's current tree, in code point order: the product repository read whole once per revision. */
  async productFileIndex(repository: string): Promise<readonly { path: string; mode: string | null; bytes: number | null; form: 'text' | 'binary' | null }[]> {
    if (!this.holds(GIT_KINDS.file)) return [];
    return await productFileIndex(this.storeOwner(), repository);
  }

  /** One page of a repository's files, for an agent's listing: the graph's own answer, never a checkout's. */
  async files(repository: string, options: { readonly prefix?: string; readonly language?: string; readonly after?: string; readonly limit: number; readonly projection?: 'map' }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
    if (!this.holds(GIT_KINDS.file)) return { rows: [], next: null };
    return await listFiles(this.storeOwner(), { repository, ...(options.prefix === undefined ? {} : { prefix: options.prefix }), ...(options.language === undefined ? {} : { language: options.language }), ...(options.after === undefined ? {} : { after: options.after }), limit: options.limit, ...(options.projection === undefined ? {} : { projection: options.projection }) });
  }

  /** One file with its dates and authors, as the graph holds it. */
  async file(repository: string, path: string): Promise<GraphFileFacts | null> {
    const facts = await fileFacts(this.storeOwner(), repository, path, { history: this.holds(GIT_KINDS.commit) && this.holds(GIT_KINDS.touched) && this.holds(GIT_KINDS.history) });
    if (facts === null) return null;
    return {
      repository, path, id: `code.file:${repository}/${path}`, href: entityAddress(`code.file:${repository}/${path}`),
      mode: facts.mode, blob: facts.blob, bytes: facts.bytes, lines: facts.lines, form: facts.form, language: facts.language, candidates: [...facts.candidates],
      created: facts.created === null ? null : { ...facts.created, href: entityAddress(`code.commit:${facts.created.commit}`) },
      modified: facts.modified === null ? null : { ...facts.modified, href: entityAddress(`code.commit:${facts.modified.commit}`) },
      commitCount: facts.commitCount, authors: [...facts.authors],
    };
  }

  /** One commit of a repository with its author, dates, parents and changed paths. */
  async commitFacts(repository: string, hash: string) {
    if (!this.holds(GIT_KINDS.commit)) return null;
    return await commitFacts(this.storeOwner(), repository, hash);
  }

  /** Look up the same rendered natural key the listing exposes; key values may themselves contain slashes. */
  private async generatedFind(tx: OuterTransaction, decl: GeneratedKindRead, tail: string): Promise<GraphEntity[]> {
    const parts = decl.key.map((column) => `n.key->>'${column.replaceAll("'", "''")}'`);
    const rendered = parts.length === 0 ? 'n.uid::text' : `concat_ws('/', ${parts.join(', ')})`;
    const found = await tx.query<Raw>(`${generatedSelect(decl)} AND ${rendered} = $1 ORDER BY node_id`, [tail]);
    return await this.generatedEntities(tx, decl, found.rows);
  }

  /**
   * The rows of one manifest-declared kind as the wiki's entities: the vertex's key, and every open opinion of the
   * kind's fields. Declared writers resolve each field to the last present producer in its refinement chain.
   * Authored fields without declared writers show agreement or all distinct values. Every opinion keeps its id,
   * producer, language and evidence, including opinions superseded by a refinement.
   */
  private async generatedEntities(tx: OuterTransaction, decl: GeneratedKindRead, rows: readonly Raw[], loadedOpinions?: readonly Raw[]): Promise<GraphEntity[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => String(row['node_id']));
    const opinionColumns = ['t.node_id::text AS node', 't.id::text AS opinion_id', 't.said_by', 't.lang', 't.evidence', ...decl.columns.map((column) => `t.${quoteColumn(column)} AS ${quoteColumn(column)}`)];
    const opinions = loadedOpinions === undefined ? await tx.query<Raw>(
      `SELECT ${opinionColumns.join(', ')}, ${PRESENTATION_COLUMNS},
         (SELECT rn.id::text FROM node rn JOIN entity rk ON rk.id = rn.entity_id WHERE rk.name = '${GIT_KINDS.repository}' AND rn.context_id = 1 AND NOT rn.removed AND rn.key->>'name' = (SELECT evidence_place.value->>'repository' FROM jsonb_array_elements(t.evidence) AS evidence_place(value) WHERE evidence_place.value->>'repository' IS NOT NULL LIMIT 1) LIMIT 1) AS evidence_scope
       FROM ${decl.table} t JOIN node n ON n.id = t.node_id JOIN entity k ON k.id = n.entity_id WHERE t.node_id = ANY($1::bigint[]) AND t.state = 'open' AND t.context_id = 1 ORDER BY t.id`,
      [`{${ids.join(',')}}`],
    ) : { rows: loadedOpinions };
    const held = new Map<string, Raw[]>();
    for (const opinion of opinions.rows) {
      const list = held.get(String(opinion['node'])) ?? [];
      list.push(opinion);
      held.set(String(opinion['node']), list);
    }
    const nodeFacts = new Map(opinions.rows.map((row) => [String(row['node']), row]));
    return rows.map((row) => {
      const node = String(row['node_id']);
      const keyObject = (row['key'] ?? {}) as Record<string, unknown>;
      const keyValues = decl.key.map((column) => String(keyObject[column] ?? ''));
      const key = `${decl.kind}:${decl.key.length === 0 ? String(row['uid']) : keyValues.join('/')}`;
      const properties: Record<string, unknown> = {};
      for (const column of decl.key) properties[column] = valueOfColumn(keyObject[column], decl.types[column] ?? 'text');
      const entityOpinions: GraphEntityOpinion[] = [];
      const evidence: GraphEvidence[] = [];
      // The evidence of a vertex whose columns state no value: a table whose only column is null still names the file
      // and the lines it was read at, and its page links there. A field's own places are kept with the field below.
      const ownPlaces: GraphEvidence[] = [];
      for (const opinion of held.get(node) ?? []) {
        ownPlaces.push(...evidencePlaces(opinion['evidence']).map((place) => Object.assign({}, place, { saidBy: String(opinion['said_by']) })));
      }
      for (const column of decl.columns) {
        const stated: { value: unknown; producer: string }[] = [];
        for (const opinion of held.get(node) ?? []) {
          const value = valueOfColumn(opinion[column], decl.types[column] ?? 'text');
          if (value === null || value === undefined) continue;
          stated.push({ value, producer: String(opinion['said_by']).split('@')[0]! });
          const places = evidencePlaces(opinion['evidence']).map((place) => Object.assign({}, place, { field: column, saidBy: String(opinion['said_by']) }));
          entityOpinions.push({ field: column, value, opinionId: String(opinion['opinion_id']), producer: String(opinion['said_by']), lang: typeof opinion['lang'] === 'string' ? opinion['lang'] : null, evidence: places });
          evidence.push(...places);
        }
        const last = decl.producers?.[column]?.findLast((producer) => stated.some((one) => one.producer === producer));
        const values = (last === undefined ? stated : stated.filter((one) => one.producer === last)).map((one) => one.value);
        const distinct = new Map(values.map((one) => [JSON.stringify(canonical(one)), one]));
        if (distinct.size === 1) properties[column] = values[0];
        else if (distinct.size > 1) properties[column] = [...distinct.values()];
      }
      if (evidence.length === 0) evidence.push(...ownPlaces);
      properties['recordKey'] = key;
      // A generated entity is named by the last value of its key: a table by its name, not by its database, a column by
      // the column. Its place is where its open opinions were read — the first place its evidence names — so a page's
      // source block and the links to its code stand on the same rows as its values.
      let label = keyValues[keyValues.length - 1] ?? key;
      if (decl.kind === GIT_KINDS.file) properties['candidates'] = properties['languages'] ?? [];
      if (decl.kind === GIT_KINDS.repository) properties['defaultBranch'] = properties['default_branch'];
      if (decl.kind === GIT_KINDS.commit) {
        properties['authoredAt'] = properties['author_date'];
        properties['committedAt'] = properties['commit_date'];
        properties['effectiveAt'] = properties['commit_date'];
        properties['merge'] = Number(nodeFacts.get(node)?.['parent_count'] ?? 0) > 1;
        properties['onFirstParent'] = true;
        const author = nodeFacts.get(node)?.['author'] as Record<string, unknown> | null | undefined;
        if (author !== null && author !== undefined) {
          properties['author'] = author['name'];
          properties['authorEmail'] = author['email'];
        }
        label = String(properties['subject'] ?? properties['hash']);
      }
      if (decl.kind === GIT_KINDS.signature) label = `${String(properties['name'])} <${String(properties['email'])}>`;
      // The place its opinions were read at: a page's source block and its links to the code stand on it. A plugin's
      // evidence states lines, not bytes, and a generated entity's span carries no byte offsets.
      const place = evidence.find((one) => typeof one.path === 'string');
      if (properties['repository'] === undefined && place?.repository !== undefined && place.repository !== null) properties['repository'] = place.repository;
      const span: SourceSpan | undefined = place?.path === undefined || place.path === null
        ? undefined
        : { path: place.path, lineStart: place.lineStart ?? 1, lineEnd: place.lineEnd ?? place.lineStart ?? 1, byteStart: 0, byteEnd: 0 };
      // The scope a place is read in is its repository's node: a page's source block and its links resolve the
      // repository from it, the way every other entity's place does.
      const scope = String(nodeFacts.get(node)?.['scope'] ?? nodeFacts.get(node)?.['evidence_scope'] ?? '');
      return { key, kind: decl.kind, label, properties, nodeIds: [node], scope, ...(span === undefined ? {} : { span }), ...(evidence.length === 0 ? {} : { evidence }), ...(entityOpinions.length === 0 ? {} : { opinions: entityOpinions }) };
    });
  }

  async kindCounts(): Promise<{ kind: string; count: number }[]> {
    const parts = [...this.generated?.values() ?? []].map((decl) => `SELECT ${quoteLiteral(decl.kind)} AS kind, count(DISTINCT n.id)::text AS n FROM ${decl.table} t JOIN node n ON n.id = t.node_id WHERE t.state = 'open' AND t.context_id = 1 AND n.context_id = 1 AND NOT n.removed`);
    if (parts.length === 0) return [];
    return await this.run(async (tx) => {
      const found = await tx.query<{ kind: string; n: string }>(parts.join(' UNION ALL '));
      return found.rows.map((row) => ({ kind: row.kind, count: Number(row.n) })).sort((a, b) => byCodePoint(a.kind, b.kind));
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

  private async listKinds(kinds: readonly string[], options: { q?: string; after?: string; limit: number }): Promise<{ rows: GraphEntity[]; next: string | null; total: number }> {
    const generated = kinds.map((kind) => this.generatedKind(kind)).filter((one): one is GeneratedKindRead => one !== undefined);
    if (generated.length === 0) return { rows: [], next: null, total: 0 };
    return await this.run(async (tx) => {
      // A page of a manifest-declared kind is chosen in SQL — its key's fields are the order and the cursor — and only
      // the page's opinions are loaded (the review of stage 1c, finding 15). A read of several kinds, or of code kinds,
      // merges what each kind answers and is bounded by those kinds' own counts.
      if (generated.length === 1) return await this.generatedPage(tx, generated[0]!, options);
      const entities = await this.generatedOfKinds(tx, generated);
      const text = options.q === undefined || options.q.trim() === '' ? undefined : options.q.trim().toLowerCase();
      const matching = entities.filter((entity) => text === undefined || entity.key.toLowerCase().includes(text) || entity.label.toLowerCase().includes(text));
      matching.sort((a, b) => byCodePoint(a.key, b.key));
      const tail = options.after === undefined ? matching : matching.filter((entity) => byCodePoint(entity.key, options.after!) > 0);
      const shown = tail.slice(0, options.limit);
      return { rows: shown, next: tail.length > options.limit ? shown[shown.length - 1]?.key ?? null : null, total: matching.length };
    });
  }

  /**
   * One page of one manifest-declared kind, chosen in SQL: the key's values in the contract's order are the order and
   * the cursor, the search is a position over them, and the opinions of the page's vertices are loaded afterwards.
   */
  private async generatedPage(tx: OuterTransaction, decl: GeneratedKindRead, options: { q?: string; after?: string; limit: number }): Promise<{ rows: GraphEntity[]; next: string | null; total: number }> {
    const fields = decl.key.map((field) => `n.key->>'${field.replaceAll("'", "''")}'`);
    const rendered = fields.length === 0 ? `n.uid::text` : `concat_ws('/', ${fields.join(', ')})`;
    const text = options.q === undefined || options.q.trim() === '' ? undefined : options.q.trim().toLowerCase();
    const after = options.after === undefined || options.after === '' ? null : (options.after.startsWith(`${decl.kind}:`) ? options.after.slice(decl.kind.length + 1) : options.after);
    const page = await tx.query<Raw>(
      `WITH matching AS MATERIALIZED (
         SELECT DISTINCT n.id::text AS node_id, n.uid::text AS uid, n.key AS key, (${rendered}) AS cursor
         FROM ${decl.table} t JOIN node n ON n.id = t.node_id
         WHERE t.state = 'open' AND t.context_id = 1 AND n.context_id = 1 AND NOT n.removed
           AND ($1::text IS NULL OR position($1::text in lower((${rendered}))) > 0)
       ), total AS (SELECT count(*)::text AS n FROM matching)
       SELECT page.node_id, page.uid, page.key, total.n FROM total
       LEFT JOIN LATERAL (
         SELECT * FROM matching WHERE $2::text IS NULL OR cursor > $2::text
         ORDER BY cursor LIMIT $3::bigint
       ) page ON true
       ORDER BY page.cursor`,
      [text ?? null, after, String(options.limit + 1)],
    );
    const rows = page.rows.filter((row) => row['node_id'] !== null);
    const more = rows.length > options.limit;
    const shown = more ? rows.slice(0, options.limit) : rows;
    const entities = await this.generatedEntities(tx, decl, shown);
    return { rows: entities, next: more ? entities[entities.length - 1]?.key ?? null : null, total: Number(page.rows[0]?.['n'] ?? '0') };
  }

  /** The entities of every manifest-declared kind a read names, from the tables their declarations made. */
  private async generatedOfKinds(tx: OuterTransaction, kinds: readonly GeneratedKindRead[]): Promise<GraphEntity[]> {
    const entities: GraphEntity[] = [];
    for (const decl of kinds) {
      const found = await tx.query<Raw>(`${generatedSelect(decl)} ORDER BY node_id`);
      entities.push(...await this.generatedEntities(tx, decl, found.rows));
    }
    return entities;
  }

  private async entitiesOfIds(tx: OuterTransaction, ids: readonly string[], scope: string | null = this.scope ?? null): Promise<Map<string, GraphEntity>> {
    const held = new Map<string, GraphEntity>();
    if (ids.length === 0) return held;
    const declarations = [...this.generated?.values() ?? []];
    if (declarations.length === 0) return held;
    const opinions = declarations.map((decl) => `SELECT to_jsonb(t) AS opinion FROM ${decl.table} t
      WHERE k.name = ${quoteLiteral(decl.kind)} AND t.node_id = n.id AND t.state = 'open' AND t.context_id = 1`);
    const found = await tx.query<Raw>(
      `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, k.name AS kind,
        (SELECT jsonb_agg(t.opinion || jsonb_build_object('node', n.id::text, 'opinion_id', t.opinion->>'id', 'scope', metadata.scope, 'parent_count', metadata.parent_count, 'author', metadata.author,
          'evidence_scope', (SELECT rn.id::text FROM node rn JOIN entity rk ON rk.id = rn.entity_id WHERE rk.name = '${GIT_KINDS.repository}' AND rn.context_id = 1 AND NOT rn.removed AND rn.key->>'name' = (SELECT evidence_place.value->>'repository' FROM jsonb_array_elements(t.opinion->'evidence') AS evidence_place(value) WHERE evidence_place.value->>'repository' IS NOT NULL LIMIT 1) LIMIT 1)) ORDER BY (t.opinion->>'id')::bigint)
         FROM (${opinions.join(' UNION ALL ')}) t) AS opinions
       FROM node n JOIN entity k ON k.id = n.entity_id
       CROSS JOIN LATERAL (SELECT ${PRESENTATION_COLUMNS}) metadata
       WHERE k.name = ANY($2::text[]) AND n.id = ANY($1::bigint[]) AND n.context_id = 1 AND NOT n.removed`,
      [`{${ids.join(',')}}`, declarations.map((decl) => decl.kind)],
    );
    for (const decl of declarations) {
      const rows = found.rows.filter((row) => row['kind'] === decl.kind && Array.isArray(row['opinions']));
      const opinions = rows.flatMap((row) => row['opinions'] as Raw[]);
      for (const entity of await this.generatedEntities(tx, decl, rows, opinions)) {
        held.set(entity.nodeIds[0]!, scope === null ? entity : { ...entity, scope });
      }
    }
    return held;
  }

  async edgesOf(entity: GraphEntity, relation: string, direction: 'out' | 'in', limit: number): Promise<{ total: number; rows: NeighborEdge[] }> {
    if (this.declared !== undefined && this.declared.size === 0) return { total: 0, rows: [] };
    const graph = graphRelationOf(relation, this.generatedEdges);
    if (graph === undefined) return { total: 0, rows: [] };
    const [self, far] = direction === 'out' ? ['from_node', 'to_node'] : ['to_node', 'from_node'];
    return await this.run(async (tx) => {
      const found = await tx.query<{ id: string; other: string; discriminator: string }>(
        `SELECT e.id::text AS id, e.${far}::text AS other, e.discriminator FROM edge e JOIN entity k ON k.id = e.entity_id
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
        rows.push({ relation, direction, other, properties: { ...(await edgeProperties(tx, first.id, graph.kind, this.generatedEdges?.get(graph.kind))), discriminator: first.discriminator, sites: edges.length }, position: null });
      }
      return { total: ordered.length, rows };
    });
  }

  async byPrefix(kind: string, prefix: string, limit: number, after?: string): Promise<{ total: number; rows: GraphEntity[] }> {
    if (this.declared !== undefined && this.declared.size === 0 && this.generated === undefined) return { total: 0, rows: [] };
    // A kind the manifest's own field declarations made has its table, not a code kind: the findings kind the Problems
    // page reads is one of these (madarch-stm0.7.1). Its page is read in SQL by the key's own text, so a store of many
    // findings is not loaded whole to answer one page.
    const generated = this.generatedKind(kind);
    if (generated !== undefined) {
      return await this.run(async (tx) => {
        const values = generated.key.map((column) => `(n.key->>'${column.replaceAll("'", "''")}')`);
        const keyText = values.length === 1 ? values[0]! : `concat_ws('/', ${values.join(', ')})`;
        const head = prefix.startsWith(`${generated.kind}:`) ? prefix.slice(generated.kind.length + 1) : prefix;
        const params: unknown[] = [`${head}%`];
        let condition = `${keyText} LIKE $1`;
        if (after !== undefined) {
          params.push(after.slice(after.indexOf(':') + 1));
          condition += ` AND ${keyText} > $2`;
        }
        const page = await tx.query<Raw>(`SELECT n.id::text AS node_id, n.key AS key FROM ${generated.table} t JOIN node n ON n.id = t.node_id WHERE t.state = 'open' AND t.context_id = 1 AND n.context_id = 1 AND NOT n.removed AND ${condition} GROUP BY n.id, n.key ORDER BY ${keyText} LIMIT ${String(limit)}`, params);
        const counted = await tx.query<{ n: string }>(`SELECT count(DISTINCT n.id)::text AS n FROM ${generated.table} t JOIN node n ON n.id = t.node_id WHERE t.state = 'open' AND t.context_id = 1 AND n.context_id = 1 AND NOT n.removed AND ${keyText} LIKE $1`, [params[0]]);
        const entities = await this.generatedEntities(tx, generated, page.rows);
        const rows = entities.map(({ evidence: _evidence, opinions: _opinions, ...entity }) => entity);
        return { total: Number(counted.rows[0]?.n ?? '0'), rows };
      });
    }
    return { total: 0, rows: [] };
  }

  /**
   * The files' facts, chosen and cut in SQL: a file's key, its repository and path, its local node and the line count its
   * open opinions agree on — no other field, no opinion and no evidence. The treemap and the Problems page's code rules
   * drew these from the bulk entity read, which assembled every opinion of every file (5 538 opinions, ~20 ms of server
   * time and ~10 ms of client assembly twice a page) for one number a row (madarch-64o5.2, the page budget).
   */
  async fileFacts(prefix: string, limit: number): Promise<{ total: number; rows: readonly FileFactRow[] }> {
    if (this.declared !== undefined && this.declared.size === 0) return { total: 0, rows: [] };
    if (!this.holds(GIT_KINDS.file)) return { total: 0, rows: [] };
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; path: string; repository: string; scope: string; lines: number | null; total: string }>(
        `SELECT n.id::text AS node, (n.key->>'path') AS path, (n.key->>'repository') AS repository, ${ENTITY_SCOPE_EXPRESSION} AS scope,
                (SELECT CASE WHEN count(DISTINCT o."lines") = 1 THEN min(o."lines") ELSE NULL END
                   FROM ${GIT_TABLES.file} o
                  WHERE o."node_id" = n.id AND o."state" = 'open' AND o."context_id" = 1) AS lines,
                count(*) OVER ()::text AS total
         FROM node n JOIN entity k ON k.id = n.entity_id AND k.name = '${GIT_KINDS.file}'
         WHERE n.context_id = 1 AND NOT n.removed
           AND ($1::text = '' OR left((n.key->>'path'), length($1::text)) = $1::text)
           AND ${EDGE_EXISTS('to_node', GIT_KINDS.contains, 'n')}
         ORDER BY (n.key->>'repository'), (n.key->>'path') LIMIT $2::bigint`,
        [prefix, String(limit)],
      );
      return {
        total: Number(found.rows[0]?.total ?? '0'),
        rows: found.rows.map((row) => ({
          key: `${GIT_KINDS.file}:${row.repository}/${row.path}`,
          node: row.node,
          path: row.path,
          repository: row.repository,
          scope: row.scope,
          lines: row.lines === null ? null : Number(row.lines),
        })),
      };
    });
  }

  async relationEdges(relation: string, limit: number): Promise<{ total: number; rows: RelationEdge[] }> {
    if (this.declared !== undefined && this.declared.size === 0 && (this.generatedEdges?.size ?? 0) === 0) return { total: 0, rows: [] };
    const graph = graphRelationOf(relation, this.generatedEdges);
    if (graph === undefined) return { total: 0, rows: [] };
    return await this.run(async (tx) => {
      const found = await tx.query<{ id: string; from_node: string; to_node: string; discriminator: string }>(
        `SELECT e.id::text AS id, e.from_node::text AS from_node, e.to_node::text AS to_node, e.discriminator
         FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = $1 WHERE e.context_id = 1 ORDER BY e.from_node, e.to_node, e.discriminator, e.id`,
        [graph.kind],
      );
      const entities = await this.entitiesOfIds(tx, [...new Set(found.rows.flatMap((row) => [row.from_node, row.to_node]))]);
      const shown = found.rows.slice(0, limit);
      const properties = await edgePropertiesOf(tx, shown.map((row) => row.id), graph.kind, this.generatedEdges?.get(graph.kind));
      const rows: RelationEdge[] = [];
      for (const row of shown) {
        const from = entities.get(row.from_node);
        const to = entities.get(row.to_node);
        if (from === undefined || to === undefined) continue;
        // Both ends carry the values the page reads of them: a foreign key's column names its table there, and a
        // relation stated between two tables answers with the tables themselves.
        rows.push({
          discriminator: row.discriminator,
          from: { key: from.key, kind: from.kind, label: from.label, properties: from.properties },
          to: { key: to.key, kind: to.kind, label: to.label, properties: to.properties },
          properties: properties.get(row.id) ?? {},
        });
      }
      return { total: found.rows.length, rows };
    });
  }

  async repositories(): Promise<{ nodeId: string; path: string }[]> {
    if (this.declared !== undefined && this.declared.size === 0) return [];
    return await this.run(async (tx) => {
      const found = await tx.query<{ node_id: string; name: string }>(`SELECT n.id::text AS node_id, (n.key->>'name') AS name FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.repository}' WHERE NOT n.removed ORDER BY name`);
      return found.rows.map((row) => ({ nodeId: row.node_id, path: row.name }));
    });
  }
}
