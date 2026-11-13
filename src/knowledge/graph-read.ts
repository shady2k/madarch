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
import type { LandmarkPlan } from './history-landmarks.js';
import { GIT_KINDS, GIT_TABLES } from '../fill/stages/git-contract.js';
import { RecordGap, commitWithPaths, fileFacts, fileHistory, folderChildrenOf, folderFiles, listDirectories, listDocuments, listFiles, listRepositories, repositoryFacts, repositoryFileIndex } from '../graph/index.js';
import type { FileDate, FileHistoryRow, FileRecord } from '../graph/index.js';
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

export interface NeighborGroup {
  relation: string;
  direction: 'out' | 'in';
  total: number;
  edges: number;
  rows: { entity: GraphEntity; edges: number; span?: SourceSpan }[];
}

export interface RelationEdge {
  discriminator?: string;
  from: { key: string; kind: string; label: string; properties?: Record<string, unknown> };
  to: { key: string; kind: string; label: string; properties?: Record<string, unknown> };
  properties: Record<string, unknown>;
}

/** One file's rhythm, as one aggregated read states it (madarch-j9ao.1): its commits per window, its last change and its authors. */
export interface FileRhythm {
  readonly path: string;
  /** Commits touching the file in the last 30 days, 90 days, a year, and the whole history the fill read. */
  readonly d30: number;
  readonly d90: number;
  readonly d365: number;
  readonly all: number;
  /** The instant of the newest commit touching it, ISO 8601 in UTC; null when none touched it. */
  readonly last: string | null;
  /** The distinct authors (a signature's name, else its email) of those commits, in code-point order. */
  readonly authors: readonly string[];
}

export interface HistoryEvidence {
  entities: GraphEntity[];
  edges: { from: string; to: string; relation: string; properties: Record<string, unknown> }[];
  /** The coupled files a path page found, including those its bounded rows leave out. */
  couplingTotal?: number;
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

/** One file of a folder's listing: the fields the table shows, not the facts of its own page. */
export interface GraphFolderFile {
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
}

/** One page of a folder's own folders and files. */
export interface GraphFolderFacts {
  readonly repository: string;
  readonly id: string;
  readonly folder: string;
  readonly parent: { readonly path: string; readonly href: string } | null;
  readonly folders: readonly { readonly path: string; readonly href: string }[];
  readonly files: readonly GraphFolderFile[];
  readonly nextHref: string | null;
}

/** One commit, its author and dates, its parents and the paths it changed. */
export interface GraphCommitFacts {
  readonly repository: string;
  readonly hash: string;
  readonly href: string;
  readonly author: { readonly name: string; readonly email: string };
  readonly authorDate: string;
  readonly authorOffsetMin: number;
  readonly commitDate: string;
  readonly commitOffsetMin: number;
  readonly subject: string;
  readonly parents: readonly string[];
  readonly changed: readonly { readonly path: string; readonly change: string | null; readonly added: number | null; readonly removed: number | null; readonly previousPath: string | null; readonly href: string | null }[];
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
  private readonly historyMemo = new Map<string, Promise<HistoryEvidence>>();

  at(instant: string, scope: string): GraphReader {
    return new GraphReader(this.owner, () => instant, BigInt(scope).toString(), this.transaction, this.declared, this.generated, this.generatedEdges);
  }

  /** Whether the product declares the graph kind; a reader without a set answers every kind. */
  holds(kind: string): boolean {
    return this.declared === undefined || this.declared.has(kind) || this.generated?.has(kind) === true;
  }

  /** The manifest-declared kind a key or a listing names, when the product's tables hold it. */
  private generatedKind(kind: string): GeneratedKindRead | undefined {
    return this.generated?.get(kind);
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
      historyShallow: facts.historyShallow, steps: { tree: facts.asIsCommit !== null, history: facts.commitCount > 0 },
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
  async fileIndex(repository: string): Promise<readonly FileRecord[]> {
    if (!this.holds(GIT_KINDS.file)) return [];
    return await repositoryFileIndex(this.storeOwner(), repository).catch((error: unknown) => {
      if (error instanceof RecordGap) return [] as readonly FileRecord[];
      throw error;
    });
  }

  /**
   * One page of a repository's current Markdown documents, in code point order: the path rule stands in the statement,
   * so a repository of more files than a page holds still answers its documents, and a store that holds no such
   * repository answers an empty page.
   */
  async documents(repository: string, options: { readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
    return await listDocuments(this.storeOwner(), { repository, suffixes: ['.md', '.markdown'], ...(options.after === undefined ? {} : { after: options.after }), limit: options.limit });
  }

  /** One page of a repository's files, for an agent's listing: the graph's own answer, never a checkout's. */
  async files(repository: string, options: { readonly prefix?: string; readonly language?: string; readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
    if (!this.holds(GIT_KINDS.file)) return { rows: [], next: null };
    return await listFiles(this.storeOwner(), { repository, ...(options.prefix === undefined ? {} : { prefix: options.prefix }), ...(options.language === undefined ? {} : { language: options.language }), ...(options.after === undefined ? {} : { after: options.after }), limit: options.limit });
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

  /** One page of the commits that touched a path. */
  async fileHistory(repository: string, path: string, options: { readonly after?: { readonly walk: number; readonly commit: string }; readonly limit: number }): Promise<{ readonly rows: readonly FileHistoryRow[]; readonly next: { readonly walk: number; readonly commit: string } | null }> {
    if (!this.holds(GIT_KINDS.commit) || !this.holds(GIT_KINDS.touched) || !this.holds(GIT_KINDS.history)) return { rows: [], next: null };
    return await fileHistory(this.storeOwner(), { repository, path, limit: options.limit, ...(options.after === undefined ? {} : { after: options.after }) });
  }

  /** One commit of a repository with its author, dates, parents and changed paths. */
  async commit(repository: string, hash: string): Promise<GraphCommitFacts | null> {
    if (!this.holds(GIT_KINDS.commit)) return null;
    const facts = await commitWithPaths(this.storeOwner(), repository, hash);
    if (facts === null) return null;
    const hrefOf = (path: string): string | null => entityAddress(`code.file:${repository}/${path}`);
    return {
      repository, hash: facts.hash, href: entityAddress(`code.commit:${facts.hash}`), author: { name: facts.author.name, email: facts.author.email },
      authorDate: facts.authorDate, authorOffsetMin: facts.authorOffsetMin, commitDate: facts.commitDate, commitOffsetMin: facts.commitOffsetMin,
      subject: facts.subject, parents: [...facts.parents],
      changed: facts.touched.map((one) => ({ path: one.path, change: one.change, added: one.added, removed: one.removed, previousPath: one.previousPath, href: one.change === 'deleted' ? null : hrefOf(one.path) })),
    };
  }

  /** One folder's page: its own subfolders and one page of its files, bounded by the cursor the page carries. */
  async folder(repository: string, folder: string, after: string | undefined, limit: number): Promise<GraphFolderFacts | null> {
    const facts = await this.repository(repository);
    if (facts === null || facts.asIsCommit === null) return null;
    const directories = this.holds(GIT_KINDS.directory) ? await listDirectories(this.storeOwner(), repository) : [];
    const found = folder === '' ? undefined : directories.find((one) => one.path === folder);
    if (folder !== '' && found === undefined) return null;
    const parent = folder === '' ? null : found?.parent ?? '';
    const page = this.holds(GIT_KINDS.file) ? await folderFiles(this.storeOwner(), { repository, folder, limit, ...(after === undefined ? {} : { after }) }) : { rows: [] as readonly FileRecord[], next: null };
    const files: GraphFolderFile[] = page.rows.map((row) => ({
      path: row.path, id: `code.file:${repository}/${row.path}`, href: entityAddress(`code.file:${repository}/${row.path}`),
      mode: row.mode, blob: row.blob, bytes: row.bytes, lines: row.lines, form: row.form, language: row.language, candidates: [...row.candidates],
    }));
    const children = this.holds(GIT_KINDS.directory) ? await folderChildrenOf(this.storeOwner(), repository, folder) : [];
    const id = folder === '' ? `code.repository:${repository}` : `code.directory:${repository}/${folder}`;
    return {
      repository, id, folder,
      parent: parent === null || parent === '' ? null : { path: parent, href: entityAddress(`code.directory:${repository}/${parent}`) },
      folders: [...children].sort(byCodePoint).map((path) => ({ path, href: entityAddress(`code.directory:${repository}/${path}`) })),
      files,
      nextHref: page.next === null ? null : `${entityAddress(id)}?after=${encodeURIComponent(page.next)}`,
    };
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

  async listOperations(options: { q?: string; after?: string; limit: number }): Promise<{ rows: GraphEntity[]; next: string | null; total: number }> {
    return await this.listKinds(['code.operation', 'code.channel'], options);
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
    const parts = declarations.map((decl) => `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, ${quoteLiteral(decl.kind)} AS kind,
      (SELECT jsonb_agg(to_jsonb(t) || jsonb_build_object('node', n.id::text, 'opinion_id', t.id::text, 'scope', metadata.scope, 'parent_count', metadata.parent_count, 'author', metadata.author, 'evidence_scope', (SELECT rn.id::text FROM node rn JOIN entity rk ON rk.id = rn.entity_id WHERE rk.name = '${GIT_KINDS.repository}' AND rn.context_id = 1 AND NOT rn.removed AND rn.key->>'name' = (SELECT evidence_place.value->>'repository' FROM jsonb_array_elements(t.evidence) AS evidence_place(value) WHERE evidence_place.value->>'repository' IS NOT NULL LIMIT 1) LIMIT 1)) ORDER BY t.id)
       FROM ${decl.table} t WHERE t.node_id = n.id AND t.state = 'open' AND t.context_id = 1) AS opinions
      FROM node n JOIN entity k ON k.id = n.entity_id
      CROSS JOIN LATERAL (SELECT ${PRESENTATION_COLUMNS}) metadata
      WHERE k.name = ${quoteLiteral(decl.kind)} AND n.id = ANY($1::bigint[]) AND n.context_id = 1 AND NOT n.removed`);
    const found = await tx.query<Raw>(parts.join(' UNION ALL '), [`{${ids.join(',')}}`]);
    for (const decl of declarations) {
      const rows = found.rows.filter((row) => row['kind'] === decl.kind && Array.isArray(row['opinions']));
      const opinions = rows.flatMap((row) => row['opinions'] as Raw[]);
      for (const entity of await this.generatedEntities(tx, decl, rows, opinions)) {
        held.set(entity.nodeIds[0]!, scope === null ? entity : { ...entity, scope });
      }
    }
    return held;
  }

  async neighbors(entity: GraphEntity, options: { relations?: readonly string[]; direction?: 'out' | 'in' | 'both'; limit: number }): Promise<NeighborGroup[]> {
    if (this.declared !== undefined && this.declared.size === 0) return [];
    const wanted = (options.relations ?? ['code.contains', 'code.touched', 'code.authored', 'code.parent', 'code.renamed-from'])
      .map((relation) => ({ relation, graph: graphRelationOf(relation, this.generatedEdges) }))
      .filter((one): one is { relation: string; graph: { kind: string } } => one.graph !== undefined);
    if (wanted.length === 0) return [];
    const directions: ('out' | 'in')[] = options.direction === 'out' ? ['out'] : options.direction === 'in' ? ['in'] : ['out', 'in'];
    return await this.run(async (tx) => {
      const found = await tx.query<Record<string, string>>(
        `SELECT e.id::text AS id, rk.name AS relation, e.from_node::text AS from_node, e.to_node::text AS to_node
         FROM edge e JOIN entity rk ON rk.id = e.entity_id
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
          const wiki = relationName;
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

  /**
   * Every edge touching a vertex, once per relation and direction, with the number of edges behind each far end.
   * No kind is named here: the store's own `entity` catalogue answers the relation, and a product that declares no
   * edges takes no query (madarch-j9ao.3.1). Every edge row is read — the store's writer already keeps one open opinion
   * per producer, and this read filters none of them — and each relation's far ends are capped at `limit`; `total` says
   * how many the graph holds.
   */
  async allNeighbors(entity: GraphEntity, options: { limit: number }): Promise<NeighborGroup[]> {
    if (this.declared !== undefined && this.declared.size === 0) return [];
    if (entity.nodeIds.length === 0) return [];
    return await this.run(async (tx) => {
      const groups: NeighborGroup[] = [];
      for (const direction of ['out', 'in'] as const) {
        const [self, far] = direction === 'out' ? ['from_node', 'to_node'] : ['to_node', 'from_node'];
        const found = await tx.query<{ relation: string; node: string; node_edges: string; total: string; edges: string }>(
          `WITH held AS (
             SELECT rk.name AS relation, e.${far} AS node
             FROM edge e JOIN entity rk ON rk.id = e.entity_id
             WHERE e.${self} = ANY($1::bigint[])
           ), totals AS (
             SELECT relation, count(*)::text AS edges, count(DISTINCT node)::text AS total FROM held GROUP BY relation
           ), numbered AS (
             SELECT relation, node, count(*) OVER (PARTITION BY relation, node) AS node_edges,
                    row_number() OVER (PARTITION BY relation ORDER BY node) AS at
             FROM (SELECT DISTINCT relation, node FROM held) one
           )
           SELECT n.relation, n.node::text AS node, n.node_edges::text AS node_edges, t.total, t.edges
           FROM numbered n JOIN totals t ON t.relation = n.relation
           WHERE n.at <= $2::int
           ORDER BY n.relation, n.at`,
          [`{${entity.nodeIds.join(',')}}`, options.limit],
        );
        const byRelation = new Map<string, { total: number; edges: number; rows: { id: string; count: number }[] }>();
        for (const row of found.rows) {
          const held = byRelation.get(row.relation) ?? { total: Number(row.total), edges: Number(row.edges), rows: [] };
          held.rows.push({ id: row.node, count: Number(row.node_edges) });
          byRelation.set(row.relation, held);
        }
        for (const relation of [...byRelation.keys()].sort(byCodePoint)) {
          const held = byRelation.get(relation)!;
          const entities = await this.entitiesOfIds(tx, held.rows.map((row) => row.id));
          const rows = held.rows
            .map((row) => ({ entity: entities.get(row.id), count: row.count }))
            .filter((row): row is { entity: GraphEntity; count: number } => row.entity !== undefined)
            .sort((left, right) => byCodePoint(left.entity.key, right.entity.key));
          if (rows.length === 0) continue;
          groups.push({ relation, direction, total: held.total, edges: held.edges, rows: rows.map((row) => ({ entity: row.entity, edges: row.count })) });
        }
      }
      return groups;
    });
  }

  /**
   * Every entity whose open opinion names a file place this vertex stands at: the reverse of the evidence a produced
   * value carries. A term's definition names the file it is defined in, and the file's page answers its terms. One
   * statement over every kind table the contract made and the git capability's own, so no kind is named here
   * (madarch-j9ao.3.1); every open opinion is read and its `said_by` is kept as the source.
   */
  async evidenceToward(entity: GraphEntity, options: { limit: number }): Promise<{ entity: GraphEntity; sources: string[] }[]> {
    const repository = typeof entity.properties['repository'] === 'string' ? entity.properties['repository'] : undefined;
    const path = typeof entity.properties['path'] === 'string' ? entity.properties['path'] : undefined;
    if (repository === undefined || path === undefined) return [];
    const tables = new Set<string>();
    for (const decl of this.generated?.values() ?? []) tables.add(decl.table);
    if (tables.size === 0) return [];
    return await this.run(async (tx) => {
      const found = await tx.query<{ node_id: string; said_by: string }>(
        [...tables].map((table) => `SELECT n.id::text AS node_id, o."said_by" AS said_by FROM ${table} o JOIN node n ON n.id = o."node_id" WHERE o."state" = 'open' AND o."context_id" = 1 AND o."evidence" @> $1::jsonb`).join(' UNION ALL '),
        [JSON.stringify([{ type: 'file', repository, path }])],
      );
      const sources = new Map<string, Set<string>>();
      for (const row of found.rows) {
        if (entity.nodeIds.includes(row.node_id)) continue;
        const held = sources.get(row.node_id) ?? new Set<string>();
        held.add(row.said_by);
        sources.set(row.node_id, held);
      }
      const entities = await this.entitiesOfIds(tx, [...sources.keys()]);
      return [...entities.values()]
        .sort((left, right) => byCodePoint(left.key, right.key))
        .slice(0, options.limit)
        .map((one) => ({ entity: one, sources: [...(sources.get(one.nodeIds[0]!) ?? [])].sort(byCodePoint) }));
    });
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

  async containers(entity: GraphEntity, relation: string, limit = 8): Promise<GraphEntity[]> {
    if (this.declared !== undefined && this.declared.size === 0) return [];
    const graph = graphRelationOf(relation, this.generatedEdges);
    if (graph === undefined) return [];
    return await this.run(async (tx) => {
      const chain: GraphEntity[] = [];
      let current = entity;
      const seen = new Set<string>([entity.key]);
      for (let step = 0; step < limit; step += 1) {
        const parent = await tx.query<{ node: string }>(
          `SELECT e.from_node::text AS node FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = $1 WHERE e.to_node = ANY($2::bigint[]) LIMIT 1`,
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
    const graph = graphRelationOf(relation, this.generatedEdges);
    if (graph === undefined) return { total: 0, rows: [] };
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; hops: number }>(
        `WITH RECURSIVE reach(node_id, hops) AS (
           SELECT e.to_node, 1 FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = $2 WHERE e.from_node = ANY($1::bigint[])
           UNION
           SELECT e.to_node, p.hops + 1 FROM reach p JOIN edge e ON e.from_node = p.node_id JOIN entity k ON k.id = e.entity_id AND k.name = $2 WHERE p.hops < $3::int
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
        const rows = await this.generatedEntities(tx, generated, page.rows);
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

  /**
   * The in-degrees of nodes the caller already holds, by local id: one query for every node, never one lookup per key.
   * The treemap's rows are no entities, and a `find` per key would be a query per file (madarch-64o5.2, the page budget).
   */
  async inDegreesOfNodes(relation: string, nodes: readonly { readonly id: string; readonly key: string }[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const one of nodes) if (!counts.has(one.key)) counts.set(one.key, 0);
    if (nodes.length === 0) return counts;
    const graph = graphRelationOf(relation, this.generatedEdges);
    if (graph === undefined) return counts;
    const byNode = new Map(nodes.map((one) => [one.id, one.key]));
    const found = await this.run(async (tx) => await tx.query<{ node: string; n: string }>(
      `SELECT e.to_node::text AS node, count(DISTINCT e.id)::text AS n FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = $1
       WHERE e.context_id = 1 AND e.to_node = ANY($2::bigint[]) GROUP BY 1`,
      [graph.kind, `{${nodes.map((one) => one.id).join(',')}}`],
    ));
    for (const row of found.rows) {
      const key = byNode.get(row.node);
      if (key !== undefined) counts.set(key, Number(row.n));
    }
    return counts;
  }

  /** The in-degrees of entities the caller already read: one query for every entity, never one lookup per key. */
  async inDegreesOf(relation: string, entities: readonly GraphEntity[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>(entities.map((entity) => [entity.key, 0]));
    if (entities.length === 0) return counts;
    const graph = graphRelationOf(relation, this.generatedEdges);
    if (graph === undefined) return counts;
    const ids = entities.flatMap((entity) => entity.nodeIds);
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; n: string }>(
        `SELECT e.to_node::text AS node, count(DISTINCT e.id)::text AS n FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = $1
         WHERE e.context_id = 1 AND e.to_node = ANY($2::bigint[]) GROUP BY 1`,
        [graph.kind, `{${ids.join(',')}}`],
      );
      const byNode = new Map(entities.flatMap((entity) => entity.nodeIds.map((id) => [id, entity.key] as const)));
      for (const row of found.rows) {
        const key = byNode.get(row.node);
        if (key !== undefined) counts.set(key, Number(row.n));
      }
      return counts;
    });
  }

  async inDegrees(relation: string, keys: readonly string[]): Promise<Map<string, number>> {
    if (this.declared !== undefined && this.declared.size === 0) return new Map(keys.map((key) => [key, 0]));
    const counts = new Map<string, number>(keys.map((key) => [key, 0]));
    if (keys.length === 0) return counts;
    const graph = graphRelationOf(relation, this.generatedEdges);
    if (graph === undefined) return counts;
    const entities = new Map<string, GraphEntity>();
    for (const key of keys) for (const entity of await this.find(key)) entities.set(key, entity);
    const ids = [...entities.values()].flatMap((entity) => entity.nodeIds);
    if (ids.length === 0) return counts;
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; n: string }>(
        `SELECT e.to_node::text AS node, count(DISTINCT e.id)::text AS n FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = $1
         WHERE e.context_id = 1 AND e.to_node = ANY($2::bigint[]) GROUP BY 1`,
        [graph.kind, `{${ids.join(',')}}`],
      );
      for (const row of found.rows) for (const [key, entity] of entities) if (entity.nodeIds.includes(row.node)) counts.set(key, Number(row.n));
      return counts;
    });
  }

  /** A commit's parents with their churn and author, in parent order. */
  async commitParents(commit: GraphEntity): Promise<{ entity: GraphEntity; when: string; who?: string; files: number; added: number; removed: number }[]> {
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; date: string | null; who: string | null; files: number; added: number; removed: number }>(
        `SELECT e.to_node::text AS node,
                to_char(pc.commit_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
                (sn.key->>'name') AS who,
                count(te.id)::int AS files,
                coalesce(sum(t.added), 0)::int AS added,
                coalesce(sum(t.removed), 0)::int AS removed
         FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.parent}'
         JOIN LATERAL (SELECT o.position FROM ${GIT_TABLES.parent_position} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) pp ON true
         JOIN node cn ON cn.id = e.to_node
         LEFT JOIN LATERAL (SELECT o.commit_date FROM ${GIT_TABLES.commit} o WHERE o.node_id = cn.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) pc ON true
         LEFT JOIN edge ae ON ae.to_node = cn.id AND ae.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.authored}')
         LEFT JOIN node sn ON sn.id = ae.from_node
         LEFT JOIN edge te ON te.from_node = cn.id AND te.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.touched}')
         LEFT JOIN LATERAL (SELECT o.added, o.removed FROM ${GIT_TABLES.touched} o WHERE o.edge_id = te.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) t ON true
         WHERE e.from_node = $1::bigint
         GROUP BY e.to_node, pc.commit_date, (sn.key->>'name'), pp.position
         ORDER BY pp.position`,
        [commit.nodeIds[0] ?? '0'],
      );
      const entities = await this.entitiesOfIds(tx, found.rows.map((row) => row.node));
      return found.rows.flatMap((row) => {
        const entity = entities.get(row.node);
        return entity === undefined ? [] : [{
          entity, when: row.date ?? '', ...(row.who === null ? {} : { who: row.who }),
          files: row.files, added: row.added, removed: row.removed,
        }];
      });
    });
  }

  /** The commits on a merge's other parents that its first parent does not reach. */
  async commitBranches(commit: GraphEntity, limit: number): Promise<{ entity: GraphEntity; when: string; who?: string }[]> {
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; date: string | null; who: string | null }>(
        `WITH RECURSIVE first(commit) AS (
           SELECT e.to_node FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.parent}'
             JOIN LATERAL (SELECT o.position FROM ${GIT_TABLES.parent_position} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) pp ON true WHERE e.from_node = $1::bigint AND pp.position = 0
           UNION SELECT e.to_node FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.parent}'
             JOIN first f ON e.from_node = f.commit
         ), branch(commit) AS (
           SELECT e.to_node FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.parent}'
             JOIN LATERAL (SELECT o.position FROM ${GIT_TABLES.parent_position} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) pp ON true WHERE e.from_node = $1::bigint AND pp.position > 0
           UNION SELECT e.to_node FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.parent}'
             JOIN branch b ON e.from_node = b.commit WHERE e.to_node NOT IN (SELECT commit FROM first)
         )
         SELECT c.id::text AS node, to_char(co.commit_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, (sn.key->>'name') AS who
         FROM branch b JOIN node c ON c.id = b.commit
         LEFT JOIN LATERAL (SELECT o.commit_date, o.subject FROM ${GIT_TABLES.commit} o WHERE o.node_id = c.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) co ON true
         LEFT JOIN edge ae ON ae.to_node = c.id AND ae.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.authored}')
         LEFT JOIN node sn ON sn.id = ae.from_node
         ORDER BY co.commit_date DESC, (c.key->>'hash') LIMIT $2::int`,
        [commit.nodeIds[0] ?? '0', limit],
      );
      const entities = await this.entitiesOfIds(tx, found.rows.map((row) => row.node));
      return found.rows.flatMap((row) => {
        const entity = entities.get(row.node);
        return entity === undefined ? [] : [{ entity, when: row.date ?? '', ...(row.who === null ? {} : { who: row.who }) }];
      });
    });
  }

  /** One commit's changed files in one read: churn, old path and symbol count, with the total, never one query per file. */
  async commitChanged(commit: GraphEntity, limit: number): Promise<{ rows: { entity: GraphEntity; change: string; added: number | null; removed: number | null; previousPath: string | null; symbols: number }[]; total: number }> {
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; change: string; added: string | null; removed: string | null; previous: string | null; symbols: number; total: number }>(
        `SELECT e.to_node::text AS node, t.change, t.added::text AS added, t.removed::text AS removed,
                (pn.key->>'path') AS previous,
                (SELECT count(*)::int FROM edge se JOIN entity sk ON sk.id = se.entity_id AND sk.name = '${GIT_KINDS.contains}' WHERE se.from_node = e.to_node) AS symbols,
                count(*) OVER ()::int AS total
         FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.touched}'
         JOIN LATERAL (SELECT o.change, o.added, o.removed FROM ${GIT_TABLES.touched} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) t ON true
         JOIN node ct ON ct.id = e.from_node
         LEFT JOIN edge r ON r.from_node = e.to_node AND r.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.renamedFrom}') AND r.discriminator = (ct.key->>'hash')
         LEFT JOIN node pn ON pn.id = r.to_node
         WHERE e.from_node = $1::bigint
         ORDER BY e.to_node LIMIT $2::int`,
        [commit.nodeIds[0] ?? '0', limit],
      );
      const entities = await this.entitiesOfIds(tx, found.rows.map((row) => row.node));
      return {
        total: found.rows[0]?.total ?? 0,
        rows: found.rows.flatMap((row) => {
          const entity = entities.get(row.node);
          return entity === undefined ? [] : [{
            entity, change: row.change, added: row.added === null ? null : Number(row.added),
            removed: row.removed === null ? null : Number(row.removed), previousPath: row.previous, symbols: row.symbols,
          }];
        }),
      };
    });
  }

  /** The bounded repository history the repository page's history block shows: aggregates and top rows, not every edge. */
  async repositoryHistory(scope: string, limit: number): Promise<{
    commits: number; firstParent: number; merges: number; nonMerge: number; authors: number;
    since?: string; until?: string;
    hotspots: { entity: GraphEntity; commits: number }[];
    hotspotsTotal: number;
    authorRows: { entity: GraphEntity; commits: number }[];
    authorsTotal: number;
  }> {
    if (!this.holds(GIT_KINDS.history) || !this.holds(GIT_KINDS.commit)) return { commits: 0, firstParent: 0, merges: 0, nonMerge: 0, authors: 0, hotspots: [], hotspotsTotal: 0, authorRows: [], authorsTotal: 0 };
    return await this.run(async (tx) => {
      // Every commit's parent count is aggregated once, not counted by a subquery per commit: the first plan's 2 554
      // correlated counts were 19 ms on the own wiki's store, and the same shape under hotspots was 40 ms (madarch-64o5.3).
      const summary = await tx.query<{ commits: number; merges: number; authors: number; since: string | null; until: string | null }>(
        `WITH hc AS (
           SELECT DISTINCT he.to_node AS commit FROM edge he JOIN entity hk ON hk.id = he.entity_id AND hk.name = '${GIT_KINDS.history}'
           WHERE he.from_node = $1::bigint AND he.context_id = 1
         ), parents AS (
           SELECT pe.from_node AS commit, count(*)::int AS n FROM edge pe JOIN entity pk ON pk.id = pe.entity_id AND pk.name = '${GIT_KINDS.parent}'
           WHERE pe.from_node IN (SELECT commit FROM hc) AND pe.context_id = 1 GROUP BY 1
         ), authors AS (
           SELECT count(DISTINCT ae.from_node)::int AS n FROM edge ae JOIN entity ak ON ak.id = ae.entity_id AND ak.name = '${GIT_KINDS.authored}'
           JOIN hc ON hc.commit = ae.to_node WHERE ae.context_id = 1
         )
         SELECT count(*)::int AS commits,
                count(*) FILTER (WHERE coalesce(p.n, 0) > 1)::int AS merges,
                (SELECT n FROM authors) AS authors,
                to_char(min(o.commit_date AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS since,
                to_char(max(o.commit_date AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS until
         FROM hc LEFT JOIN parents p ON p.commit = hc.commit
         JOIN ${GIT_TABLES.commit} o ON o.node_id = hc.commit AND o.state = 'open' AND o.context_id = 1`,
        [scope],
      );
      const row = summary.rows[0] ?? { commits: 0, merges: 0, authors: 0, since: null, until: null };
      const hotspots = await tx.query<{ node: string; n: number }>(
        `WITH hc AS (
           SELECT DISTINCT he.to_node AS commit FROM edge he JOIN entity hk ON hk.id = he.entity_id AND hk.name = '${GIT_KINDS.history}'
           WHERE he.from_node = $1::bigint AND he.context_id = 1
         ), parents AS (
           SELECT pe.from_node AS commit, count(*)::int AS n FROM edge pe JOIN entity pk ON pk.id = pe.entity_id AND pk.name = '${GIT_KINDS.parent}'
           WHERE pe.from_node IN (SELECT commit FROM hc) AND pe.context_id = 1 GROUP BY 1
         )
         SELECT e.to_node::text AS node, count(*)::int AS n
         FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.touched}'
         JOIN hc ON hc.commit = e.from_node
         LEFT JOIN parents p ON p.commit = e.from_node
         WHERE coalesce(p.n, 0) <= 1 AND e.context_id = 1
         GROUP BY 1`,
        [scope],
      );
      // A rename joins two paths into one identity: the hotspots are the identity's, as the history projection reads them.
      const renamed = await tx.query<{ from: string; to: string }>(
        `SELECT e.from_node::text AS "from", e.to_node::text AS "to" FROM edge e
         JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.renamedFrom}'
         WHERE e.from_node = ANY($1::bigint[])`,
        [`{${hotspots.rows.map((one) => one.node).join(',') || '0'}}`],
      );
      const parentOf = new Map(renamed.rows.map((row) => [row.from, row.to]));
      const rootOf = (node: string): string => {
        let at = node; const seen = new Set<string>();
        while (parentOf.has(at) && !seen.has(at)) { seen.add(at); at = parentOf.get(at)!; }
        return at;
      };
      const merged = new Map<string, number>();
      for (const one of hotspots.rows) { const root = rootOf(one.node); merged.set(root, (merged.get(root) ?? 0) + one.n); }
      // Only the rows the block shows are resolved to their labels: the history block reads `limit` hotspots, and the
      // whole repository's 2 800 files were read as entities to sort them (madarch-64o5.3's own wiki).
      const hottest = [...merged.entries()].sort((left, right) => right[1] - left[1] || byCodePoint(left[0], right[0])).slice(0, limit);
      const hotspotEntities = await this.entitiesOfIds(tx, hottest.map(([node]) => node), scope);
      const authors = await tx.query<{ node: string; n: number }>(
        `WITH hc AS (
           SELECT DISTINCT he.to_node AS commit FROM edge he JOIN entity hk ON hk.id = he.entity_id AND hk.name = '${GIT_KINDS.history}'
           WHERE he.from_node = $1::bigint AND he.context_id = 1
         )
         SELECT ae.from_node::text AS node, count(*)::int AS n
         FROM edge ae JOIN entity ak ON ak.id = ae.entity_id AND ak.name = '${GIT_KINDS.authored}'
         JOIN hc ON hc.commit = ae.to_node WHERE ae.context_id = 1 GROUP BY 1`,
        [scope],
      );
      const authorEntities = await this.entitiesOfIds(tx, authors.rows.map((one) => one.node));
      const sort = (rows: { node: string; n: number }[], entities: Map<string, GraphEntity>) => rows
        .flatMap((one) => { const entity = entities.get(one.node); return entity === undefined ? [] : [{ entity, commits: one.n }]; })
        .sort((left, right) => right.commits - left.commits || byCodePoint(left.entity.key, right.entity.key))
        .slice(0, limit);
      return {
        commits: row.commits, firstParent: row.commits, merges: row.merges, nonMerge: row.commits - row.merges,
        authors: row.authors, ...(row.since === null ? {} : { since: row.since }), ...(row.until === null ? {} : { until: row.until }),
        hotspots: sort(hottest.map(([node, n]) => ({ node, n })), hotspotEntities), hotspotsTotal: merged.size,
        authorRows: sort(authors.rows, authorEntities), authorsTotal: authors.rows.length,
      };
    });
  }

  /**
   * The rhythm of every file of a repository, in one statement: the commits that touched each file in three windows,
   * the newest of them and the distinct authors. It reads the graph's opinions as they stand: every open opinion of a
   * commit's date and of a signature's name is a value (a window counts a commit when any open date falls in it, and
   * the newest change is the newest of them all), never the value of one producer picked over another. It is a bounded
   * read on purpose (madarch-j9ao.1): the whole history evidence of a repository holds every commit and every edge, and
   * a page that drew a map of files may not carry it. A merge repeats what its parents did and is not a change of its
   * own, as git's own path history has it.
   */
  async fileRhythm(repository: string, windows: { readonly d30: string; readonly d90: string; readonly d365: string }): Promise<Map<string, FileRhythm>> {
    const answer = new Map<string, FileRhythm>();
    if (this.declared !== undefined && this.declared.size === 0) return answer;
    // Every table the statement names belongs to a kind or an edge the manifest must declare (stage C): a product that
    // declares the files and no history edge reads no rhythm, rather than a table its store never built.
    for (const kind of [GIT_KINDS.file, GIT_KINDS.commit, GIT_KINDS.signature, GIT_KINDS.contains, GIT_KINDS.touched, GIT_KINDS.authored, GIT_KINDS.parent] as const) {
      if (!this.holds(kind)) return answer;
    }
    return await this.run(async (tx) => {
      // The read is a set of aggregates joined once; the planner's default estimate for a CTE scan is a handful of rows
      // and it nested-loops the whole map of marks over every file (measured: 156 ms against 7 ms on 1 800 files). The
      // joins are hashes for this one statement, and the setting is put back as it was before the next read.
      await tx.query('SET LOCAL enable_nestloop = off');
      let found;
      try {
        found = await tx.query<{ path: string; d30: string; d90: string; d365: string; all_count: string; last: Date | string | null; authors: string[] | null }>(
          `WITH tree AS MATERIALIZED (
           SELECT f.id AS file_node, (f.key->>'path') AS path
           FROM node f JOIN entity fe ON fe.id = f.entity_id AND fe.name = '${GIT_KINDS.file}'
           WHERE (f.key->>'repository') = $1 AND f.context_id = 1 AND NOT f.removed
             AND EXISTS (SELECT 1 FROM edge c JOIN entity ce ON ce.id = c.entity_id AND ce.name = '${GIT_KINDS.contains}'
                         WHERE c.to_node = f.id AND c.context_id = 1)
         ), dates AS MATERIALIZED (
           -- Every date the open opinions of a commit state, once per commit (the graph's opinions, no producer picked).
           SELECT o.node_id AS commit_node, array_agg(DISTINCT o.commit_date) AS dates
           FROM ${GIT_TABLES.commit} o
           WHERE o.state = 'open' AND o.context_id = 1 AND o.commit_date IS NOT NULL
           GROUP BY o.node_id
         ), authors AS MATERIALIZED (
           SELECT ae.to_node AS commit_node, array_agg(DISTINCT coalesce(sa.key->>'name', sa.key->>'email')) AS authors
           FROM edge ae JOIN entity aee ON aee.id = ae.entity_id AND aee.name = '${GIT_KINDS.authored}'
           JOIN node sa ON sa.id = ae.from_node AND sa.context_id = 1 AND NOT sa.removed
           WHERE ae.context_id = 1 AND (sa.key ? 'name' OR sa.key ? 'email')
           GROUP BY ae.to_node
         ), parents AS MATERIALIZED (
           SELECT p.from_node AS commit_node, count(*) AS held
           FROM edge p JOIN entity pe ON pe.id = p.entity_id AND pe.name = '${GIT_KINDS.parent}'
           WHERE p.context_id = 1
           GROUP BY p.from_node
         ), marks AS MATERIALIZED (
           -- A commit's newest open date is the newest of every value the opinions state: no value is dropped and none
           -- is preferred, and a window holds the commit when that newest date is in it.
           SELECT e.to_node AS file_node, e.from_node AS commit_node, a.authors,
                  (SELECT max(x) FROM unnest(d.dates) x) AS at
           FROM edge e JOIN entity ee ON ee.id = e.entity_id AND ee.name = '${GIT_KINDS.touched}'
           JOIN dates d ON d.commit_node = e.from_node
           LEFT JOIN authors a ON a.commit_node = e.from_node
           LEFT JOIN parents p ON p.commit_node = e.from_node
           WHERE e.context_id = 1 AND coalesce(p.held, 0) <= 1
         ), file_marks AS MATERIALIZED (
           SELECT m.file_node,
                  count(m.commit_node) FILTER (WHERE m.at >= $2::timestamptz) AS d30,
                  count(m.commit_node) FILTER (WHERE m.at >= $3::timestamptz) AS d90,
                  count(m.commit_node) FILTER (WHERE m.at >= $4::timestamptz) AS d365,
                  count(m.commit_node) AS all_count,
                  max(m.at) AS last
           FROM marks m GROUP BY m.file_node
         ), file_authors AS MATERIALIZED (
           SELECT m.file_node, array_agg(DISTINCT a) AS authors FROM marks m, unnest(m.authors) a GROUP BY m.file_node
         )
         SELECT t.path, coalesce(fm.d30, 0)::text AS d30, coalesce(fm.d90, 0)::text AS d90,
                coalesce(fm.d365, 0)::text AS d365, coalesce(fm.all_count, 0)::text AS all_count,
                fm.last, coalesce(fa.authors, '{}') AS authors
         FROM tree t LEFT JOIN file_marks fm ON fm.file_node = t.file_node
         LEFT JOIN file_authors fa ON fa.file_node = t.file_node`,
          [repository, windows.d30, windows.d90, windows.d365],
        );
      } finally {
        await tx.query('RESET enable_nestloop');
      }
      for (const row of found.rows) {
        const last = row.last === null ? null : row.last instanceof Date ? row.last.toISOString() : new Date(row.last).toISOString();
        answer.set(row.path, {
          path: row.path,
          d30: Number(row.d30), d90: Number(row.d90), d365: Number(row.d365), all: Number(row.all_count),
          last: last !== null && Number.isFinite(Date.parse(last)) ? last : null,
          authors: [...(row.authors ?? [])].sort(byCodePoint),
        });
      }
      return answer;
    });
  }

  async historyEvidence(scope: string): Promise<HistoryEvidence> {
    if (this.declared !== undefined && this.declared.size === 0) return { entities: [], edges: [] };
    const held = this.historyMemo.get(scope);
    if (held !== undefined) return await held;
    const read = this.historyEvidenceOnce(scope);
    this.historyMemo.set(scope, read);
    read.catch(() => { if (this.historyMemo.get(scope) === read) this.historyMemo.delete(scope); });
    return await read;
  }

  /** The history evidence of one scope, read once for the page that holds this reader. */
  private async historyEvidenceOnce(scope: string): Promise<HistoryEvidence> {
    if (!this.holds(GIT_KINDS.history) || !this.holds(GIT_KINDS.commit)) return { entities: [], edges: [] };
    return await this.run(async (tx) => {
      const found = await tx.query<Raw>(
        `SELECT n.id::text AS node_id FROM node n WHERE n.context_id = 1 AND NOT n.removed AND (
           n.id = $1::bigint
           OR (n.key->>'repository') = (SELECT r.key->>'name' FROM node r WHERE r.id = $1::bigint)
           OR n.id IN (SELECT e.to_node FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.history}' WHERE e.from_node = $1::bigint)
           OR n.id IN (SELECT ae.from_node FROM edge ae JOIN entity ak ON ak.id = ae.entity_id AND ak.name = '${GIT_KINDS.authored}'
                        JOIN edge h ON h.to_node = ae.to_node AND h.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.history}') WHERE h.from_node = $1::bigint)
         ) ORDER BY n.id`,
        [scope],
      );
      const byId = await this.entitiesOfIds(tx, found.rows.map((row) => String(row['node_id'])), scope);
      const entities = [...byId.values()];
      const edges = await tx.query<{ id: string; relation: string; from_node: string; to_node: string; discriminator: string; change: string | null; added: string | null; removed: string | null; position: number | null; walk: number | null }>(
        `WITH evidence_nodes AS (
           SELECT n.id FROM node n
           WHERE n.id = $1::bigint OR (n.key->>'repository') = (SELECT r.key->>'name' FROM node r WHERE r.id = $1::bigint)
             OR n.id IN (SELECT he.to_node FROM edge he JOIN entity hk ON hk.id = he.entity_id AND hk.name = '${GIT_KINDS.history}' WHERE he.from_node = $1::bigint)
             OR n.id IN (SELECT ae.from_node FROM edge ae JOIN entity ak ON ak.id = ae.entity_id AND ak.name = '${GIT_KINDS.authored}'
                          JOIN edge he ON he.to_node = ae.to_node AND he.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.history}') WHERE he.from_node = $1::bigint)
         )
         SELECT e.id::text AS id, rk.name AS relation, e.from_node::text AS from_node, e.to_node::text AS to_node,
                e.discriminator, t.change, t.added::text AS added, t.removed::text AS removed, pp.position, h.walk
         FROM edge e JOIN entity rk ON rk.id = e.entity_id
         LEFT JOIN LATERAL (SELECT o.change, o.added, o.removed FROM ${GIT_TABLES.touched} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) t ON true
         LEFT JOIN LATERAL (SELECT o.position FROM ${GIT_TABLES.parent_position} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) pp ON true
         LEFT JOIN LATERAL (SELECT o.walk FROM ${GIT_TABLES.history} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) h ON true
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
          return [{ from: from.key, to: to.key, relation: row.relation, properties: {
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

  /**
   * The evidence a file's or an author's history page needs, bounded to that page: the file's own commits and the
   * files it changed with, or the author's commits and the files they touched. The whole repository's evidence is
   * never read for these two shapes.
   */
  async historyEvidenceFor(subject: GraphEntity, shape: 'path' | 'author', limit: number): Promise<HistoryEvidence> {
    if (this.declared !== undefined && this.declared.size === 0) return { entities: [], edges: [] };
    if (!this.holds(GIT_KINDS.commit) || !this.holds(GIT_KINDS.touched) || !this.holds(GIT_KINDS.history)) return { entities: [], edges: [] };
    return await this.run(async (tx) => {
      const ids = `{${subject.nodeIds.join(',')}}`;
      const edgeRows = shape === 'author'
        ? await tx.query<Raw>(
          `WITH authored AS MATERIALIZED (
             SELECT e.to_node AS id FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.authored}' WHERE e.from_node = ANY($1::bigint[])
           ), parents AS MATERIALIZED (
             SELECT p.from_node AS id, count(*) AS n FROM edge p
             JOIN entity pk ON pk.id = p.entity_id AND pk.name = '${GIT_KINDS.parent}'
             WHERE p.from_node IN (SELECT id FROM authored) GROUP BY p.from_node
           ), touched AS (
             SELECT e.id FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.touched}'
             LEFT JOIN parents p ON p.id = e.from_node
             WHERE e.from_node IN (SELECT id FROM authored) AND coalesce(p.n, 0) <= 1
           )
           SELECT e.id::text AS id, rk.name AS relation, e.from_node::text AS from_node, e.to_node::text AS to_node,
                  e.discriminator, t.change, t.added::text AS added, t.removed::text AS removed, NULL AS position, NULL AS walk
           FROM edge e JOIN entity rk ON rk.id = e.entity_id
           LEFT JOIN (SELECT DISTINCT ON (o.edge_id) o.edge_id, o.change, o.added, o.removed
             FROM ${GIT_TABLES.touched} o WHERE o.state = 'open' AND o.edge_id IN (SELECT id FROM touched)
             ORDER BY o.edge_id, o.id DESC) t ON t.edge_id = e.id AND rk.name = '${GIT_KINDS.touched}'
           WHERE (rk.name = '${GIT_KINDS.authored}' AND e.from_node = ANY($1::bigint[]))
              OR (rk.name = '${GIT_KINDS.touched}' AND e.id IN (SELECT id FROM touched))`,
          [ids],
        )
        : await tx.query<Raw>(
          `WITH RECURSIVE focus AS (
             SELECT unnest($1::bigint[]) AS id
             UNION
             SELECT CASE WHEN e.from_node = f.id THEN e.to_node ELSE e.from_node END
             FROM focus f JOIN edge e ON e.from_node = f.id OR e.to_node = f.id
             JOIN entity rk ON rk.id = e.entity_id AND rk.name = '${GIT_KINDS.renamedFrom}'
           ), focus_commits AS (
             SELECT DISTINCT e.from_node AS id FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.touched}'
             WHERE e.to_node IN (SELECT id FROM focus)
               AND (SELECT count(*) FROM edge p JOIN entity pk ON pk.id = p.entity_id AND pk.name = '${GIT_KINDS.parent}' WHERE p.from_node = e.from_node) <= 1
           ), coupled_all AS (
             SELECT e.to_node AS id, count(DISTINCT e.from_node) AS n FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.touched}'
             WHERE e.from_node IN (SELECT id FROM focus_commits) AND e.to_node NOT IN (SELECT id FROM focus)
               AND (SELECT count(*) FROM edge p JOIN entity pk ON pk.id = p.entity_id AND pk.name = '${GIT_KINDS.parent}' WHERE p.from_node = e.from_node) <= 1
             GROUP BY 1 HAVING count(DISTINCT e.from_node) >= 2
           ), coupled AS (
             SELECT id, n FROM coupled_all ORDER BY n DESC FETCH FIRST $2 ROWS WITH TIES
           ), included AS (
             SELECT id FROM focus UNION SELECT id FROM coupled
           ), identities AS (
             SELECT id FROM included
             UNION
             SELECT CASE WHEN e.from_node = f.id THEN e.to_node ELSE e.from_node END
             FROM identities f JOIN edge e ON e.from_node = f.id OR e.to_node = f.id
             JOIN entity rk ON rk.id = e.entity_id AND rk.name = '${GIT_KINDS.renamedFrom}'
           ), ancestors AS (
             SELECT id FROM identities
             UNION
             SELECT e.from_node FROM ancestors a JOIN edge e ON e.to_node = a.id
             JOIN entity rk ON rk.id = e.entity_id AND rk.name = '${GIT_KINDS.contains}'
           ), imports AS (
             SELECT e.id, e.from_node, e.to_node FROM edge e JOIN entity rk ON rk.id = e.entity_id AND rk.name = 'code.imports'
             WHERE e.from_node IN (SELECT id FROM ancestors) OR e.to_node IN (SELECT id FROM ancestors)
           ), members AS (
             SELECT from_node AS id FROM imports UNION SELECT to_node FROM imports
             UNION
             SELECT e.to_node FROM members m JOIN edge e ON e.from_node = m.id
             JOIN entity rk ON rk.id = e.entity_id AND rk.name = '${GIT_KINDS.contains}'
           )
           SELECT e.id::text AS id, rk.name AS relation, e.from_node::text AS from_node, e.to_node::text AS to_node,
                  e.discriminator, t.change, t.added::text AS added, t.removed::text AS removed, pp.position, h.walk,
                  (SELECT count(*)::text FROM coupled_all) AS coupling_total
           FROM edge e JOIN entity rk ON rk.id = e.entity_id
           LEFT JOIN LATERAL (SELECT o.change, o.added, o.removed FROM ${GIT_TABLES.touched} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) t ON true
           LEFT JOIN LATERAL (SELECT o.position FROM ${GIT_TABLES.parent_position} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) pp ON true
           LEFT JOIN LATERAL (SELECT o.walk FROM ${GIT_TABLES.history} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) h ON true
           WHERE (rk.name = '${GIT_KINDS.touched}' AND e.to_node IN (SELECT id FROM included) AND e.from_node IN (SELECT id FROM focus_commits))
              OR (rk.name = '${GIT_KINDS.authored}' AND e.to_node IN (SELECT id FROM focus_commits))
              OR (rk.name = '${GIT_KINDS.renamedFrom}' AND e.from_node IN (SELECT id FROM identities))
              OR (rk.name = '${GIT_KINDS.contains}' AND e.from_node IN (SELECT id FROM members))
              OR e.id IN (SELECT id FROM imports)`,
          [ids, limit],
        );
      const nodeIds = new Set<string>(subject.nodeIds);
      for (const row of edgeRows.rows) { nodeIds.add(row['from_node'] as string); nodeIds.add(row['to_node'] as string); }
      // Path history needs the commits' subject and clock, not their complete changed-path lists.
      const byId = await this.entitiesOfIds(tx, [...nodeIds], subject.scope === '' ? null : subject.scope);
      const entities = [...byId.values()];
      const couplingTotal = edgeRows.rows.find((row) => row['coupling_total'] !== undefined)?.['coupling_total'];
      return {
        entities,
        ...(typeof couplingTotal === 'string' ? { couplingTotal: Number(couplingTotal) } : {}),
        edges: edgeRows.rows.flatMap((row) => {
          const from = byId.get(String(row['from_node']));
          const to = byId.get(String(row['to_node']));
          if (from === undefined || to === undefined) return [];
          return [{ from: from.key, to: to.key, relation: String(row['relation']), properties: {
            ...(row['change'] === null ? {} : { change: row['change'] }),
            ...(row['added'] === null ? {} : { added: Number(row['added']) }),
            ...(row['removed'] === null ? {} : { removed: Number(row['removed']) }),
            ...(row['position'] === null ? {} : { position: Number(row['position']) }),
            ...(row['walk'] === null ? {} : { walk: Number(row['walk']) }),
            ...(row['discriminator'] === '' ? {} : { discriminator: row['discriminator'] }),
          } }];
        }),
      };
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
