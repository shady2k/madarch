/** Graph reads select typed per-source assertions and active declared edges (0039 items 25 and 30). */
import { decodeCitation, type Citation } from '../page-contract/citation.js';
import type { DatabaseOwner, OuterTransaction } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import { GIT_KINDS } from '../fill/stages/git-contract.js';
import { commitFacts, fileFacts, listFiles, listRepositories, repositoryFacts, productFileIndex } from '../graph/index.js';
import type { FileDate, FileRecord } from '../graph/index.js';
import { readKindAssertions } from '../graph/records.js';
import { assertionReadSql } from '../graph/assertion-read.js';
import { withSpan } from '../obs/trace.js';
import { entityAddress } from './addresses.js';

export interface SourceSpan {
  path: string;
  lineStart: number;
  lineEnd: number;
  byteStart: number;
  byteEnd: number;
}

/** One place a claim of an entity stands: the file, the lines, and the commit or digest the value was read at. */
export interface GraphEvidence extends Citation {
  /** The field the evidence is under: the claim's attribute. */
  field: string;
  /** The stored locator, including coordinates and digest supplied by the source. */
  locator: Readonly<Record<string, unknown>> | null;
  repository: string | null;
  path: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  commit: string | null;
  /** What the evidence names: a file place, a conversation or another opinion (the amendment's point 7). */
  type?: 'file' | 'conversation' | 'assertion';
  /** A conversation's or an opinion's id. */
  id?: string;
  speaker?: string | null;
  at?: string | null;
  /** The opinion that stated the value: the producer and its version, the agent, or a person's node. */
  saidBy?: string;
}

export interface GraphEntity {
  key: string;
  /** The entity's stable uid, when the read asked for it (a document's page is addressed by it). */
  uid?: string;
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
  readonly authorUid: string;
  readonly recordedAt: string;
  readonly validFrom: string;
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
  readonly keyEdges?: readonly import('../graph/contract.js').KeyEdgeContract[];
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
  from: { uid: string; key: string; kind: string; label: string; properties?: Record<string, unknown> };
  to: { uid: string; key: string; kind: string; label: string; properties?: Record<string, unknown> };
  properties: Record<string, unknown>;
}

/** Relations are declared graph edge kinds. */
function graphRelationOf(relation: string, declared?: ReadonlyMap<string, GeneratedEdgeRead>): { kind: string } | undefined {
  return declared?.has(relation) === true ? { kind: relation } : undefined;
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
  /** The vertex's stable public identity; local numeric joins stay inside the reader. */
  readonly node: string;
  readonly path: string;
  readonly repository: string;
  readonly scope: string;
  /** The file class the disk producer states (`generated`, `dependency`, `test`, …), when one opinion says it. */
  readonly class: string | null;
  readonly lines: number | null;
  /** A fact a reader states about the file that the graph holds no column for today (a repository-declared generated file). */
  readonly generated?: unknown;
}

export class GraphReader {
  constructor(
    private readonly owner: DatabaseOwner,
    private readonly validAt: () => Promise<string> | string,
    private readonly scope?: string,
    private readonly transaction?: OuterTransaction,
    /** The graph kinds the product declares; a reader without a set answers every kind a store holds. */
    private readonly declared?: ReadonlySet<string>,
    /** The kinds the manifest's own field declarations build tables for, by graph kind. */
    private readonly generated?: ReadonlyMap<string, GeneratedKindRead>,
    /** The edge kinds the manifest's `edges:` declarations build, by graph kind. */
    private readonly generatedEdges?: ReadonlyMap<string, GeneratedEdgeRead>,
    private readonly contract?: import('../graph/contract.js').GraphContract,
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

  private repositoryKinds(kind: string): string[] {
    return [...this.generatedEdges?.values() ?? []].filter(edge => edge.from.includes(kind) && edge.to.includes(GIT_KINDS.repository)).map(edge => edge.kind);
  }

  private async records(tx: OuterTransaction, sort: 'vertex' | 'edge', kind: string, fields: readonly string[], subjectIds?: readonly number[]): Promise<import('../graph/records.js').AssertionRecord[]> {
    const contract = this.contract;
    return await readKindAssertions(tx, sort, kind, fields, { validAt: await this.validAt(), ...(contract === undefined ? {} : { contract }), ...(subjectIds === undefined ? {} : { subjectIds }), ...(sort === 'vertex' ? { repositoryKinds: this.repositoryKinds(kind) } : {}) });
  }

  private async run<T>(work: (tx: OuterTransaction) => Promise<T>): Promise<T> {
    return await withSpan('graph.reader', {}, async () => {
      if (this.transaction !== undefined) return await work(this.transaction);
      return await this.owner.transaction('snapshot', work);
    });
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
    return await productFileIndex(this.storeOwner(), repository);
  }

  /** One page of a repository's files, for an agent's listing: the graph's own answer, never a checkout's. */
  async files(repository: string, options: { readonly prefix?: string; readonly language?: string; readonly after?: string; readonly limit: number; readonly projection?: 'map' }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
    return await listFiles(this.storeOwner(), { repository, ...(options.prefix === undefined ? {} : { prefix: options.prefix }), ...(options.language === undefined ? {} : { language: options.language }), ...(options.after === undefined ? {} : { after: options.after }), limit: options.limit, ...(options.projection === undefined ? {} : { projection: options.projection }) });
  }

  /** One file with its dates and authors, as the graph holds it. */
  async file(repository: string, path: string): Promise<GraphFileFacts | null> {
    const facts = await fileFacts(this.storeOwner(), repository, path);
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
    return await commitFacts(this.storeOwner(), repository, hash);
  }

  /** Look up the same rendered natural key the listing exposes; key values may themselves contain slashes. */
  private async generatedFind(tx: OuterTransaction, decl: GeneratedKindRead, tail:string):Promise<GraphEntity[]> {
    return (await this.generatedOfKinds(tx,[decl])).filter(e=>e.key===`${decl.kind}:${tail}`||e.uid===tail);
  }

  private async generatedEntities(decl:GeneratedKindRead, records:readonly import('../graph/records.js').AssertionRecord[]):Promise<GraphEntity[]> {
    if (records.length === 0) return [];
    const evidenceRows = { rows: records.flatMap(record => record.assertions.flatMap(assertion => assertion.evidenceAttachments.map(attachment => ({ assertion_uid: assertion.id, target_uid: attachment.targetUid, locator: attachment.locator, key: attachment.key })))) };
    return records.map(row=>{
      const properties:Record<string,unknown>={...row.key,...row.values};
      delete properties['$exists'];
      const keyValues=decl.key.map(f=>String(row.key[f]??''));
      const key=`${decl.kind}:${keyValues.length===0 || (decl.keyEdges?.length ?? 0) > 0 ? row.uid : keyValues.join('/')}`;
      properties['recordKey']=key;
      const repository=row.assertions[0]?.repositoryTargets[0];
      if (repository !== undefined) properties['repositoryName'] = repository.key['name'];
      const entityOpinions:GraphEntityOpinion[]=row.assertions.filter(a=>a.property!=='$exists').map(a=>({field:a.property,value:a.value,opinionId:a.id,producer:a.source,authorUid:a.author,recordedAt:a.recordedAt,validFrom:a.validFrom,lang:a.language,evidence:evidenceRows.rows.filter(e => e.assertion_uid === a.id).map(e => {
        const attachment = JSON.parse(e.locator) as { locator: Record<string, unknown> | null };
        const locator = attachment.locator ?? {};
        return { field: a.property, locator: attachment.locator, ...decodeCitation({ repository: null, path: typeof locator['path'] === 'string' ? locator['path'] : typeof e.key['path'] === 'string' ? e.key['path'] : null, lineStart: typeof locator['lineStart'] === 'number' ? locator['lineStart'] : null, lineEnd: typeof locator['lineEnd'] === 'number' ? locator['lineEnd'] : null }, `${import.meta.path}:366`), commit: typeof locator['commit'] === 'string' ? locator['commit'] : null, type: 'assertion' as const, id: e.target_uid, saidBy: a.source };
      })}));
      const placed = entityOpinions.flatMap(assertion => assertion.evidence).find(evidence => evidence.path !== null && evidence.lineStart !== null && evidence.lineEnd !== null);
      const span = placed === undefined ? undefined : { path: placed.path!, lineStart: placed.lineStart!, lineEnd: placed.lineEnd!, byteStart: 0, byteEnd: 0 };
      const label=String(properties['label']??properties['name']??properties['subject']??keyValues.at(-1)??row.uid);
      return {key,uid:row.uid,kind:decl.kind,label,properties,...(span === undefined ? {} : { span }),nodeIds:[row.uid],scope:repository===undefined?'':repository.uid,opinions:entityOpinions,evidence:entityOpinions.flatMap(a=>a.evidence)};
    });
  }

  async kindCounts():Promise<{kind:string;count:number}[]> {
    return await this.run(async tx=>{const rows=[];for(const decl of this.generated?.values()??[])rows.push({kind:decl.kind,count:(await this.records(tx,'vertex',decl.kind,[])).length});return rows.sort((a,b)=>byCodePoint(a.kind,b.kind));});
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
  private async generatedPage(tx:OuterTransaction,decl:GeneratedKindRead,options:{q?:string;after?:string;limit:number}):Promise<{rows:GraphEntity[];next:string|null;total:number}> {
    const validAt = await this.validAt();
    const fields = decl.columns.filter(field => !decl.key.includes(field));
    const membershipFields = fields.filter(field => ['label', 'name', 'subject'].includes(field));
    const typed = await assertionReadSql([{ sort: 'vertex', kind: decl.kind, properties: ['$exists', ...membershipFields] }], { validAt });
    const parameters = [...typed.parameters];
    const param = (value: unknown): string => { parameters.push(value); return `$${parameters.length}`; };
    const kind = param(decl.kind);
    const key = decl.key.length === 0 || (decl.keyEdges?.length ?? 0) > 0 ? 'n.uid::text' : decl.key.map(field => `n.key->>${param(field)}`).join(" || '/' || ");
    const fallback = decl.key.length === 0 ? 'n.uid::text' : `n.key->>${param(decl.key.at(-1)!)}`;
    const text = param(options.q?.trim().toLowerCase() ?? '');
    const after = param(options.after ?? null);
    const limit = param(options.limit + 1);
    const membership = await tx.query<{ id: number | null; uid: string | null; key: Record<string, unknown> | null; total: string }>(`
      WITH assertions AS (${typed.sql}), effective AS (
        SELECT subject_id,jsonb_object_agg(property,value ORDER BY property_rank,recorded_sequence::bigint) AS values
        FROM assertions WHERE selected GROUP BY subject_id
      ), named AS (
        SELECT n.id,n.uid::text,n.key,${kind} || ':' || (${key}) AS record_key,
          coalesce(e.values->>'label',e.values->>'name',e.values->>'subject',${fallback}) AS label
        FROM node n JOIN entity k ON k.id=n.entity_id JOIN effective e ON e.subject_id=n.id
        WHERE k.name=${kind} AND e.values->>'$exists'='true'
      ), matching AS MATERIALIZED (
        SELECT * FROM named WHERE ${text}='' OR position(${text} IN lower(record_key))>0 OR position(${text} IN lower(label))>0
      ), page AS (
        SELECT * FROM matching WHERE ${after}::text IS NULL OR record_key COLLATE "C">${after} COLLATE "C"
        ORDER BY record_key COLLATE "C" LIMIT ${limit}
      ) SELECT page.id,page.uid,page.key,(SELECT count(*) FROM matching)::text AS total
        FROM (SELECT 1) seed LEFT JOIN page ON TRUE ORDER BY page.record_key COLLATE "C"`, parameters);
    const total = Number(membership.rows[0]!.total);
    const identities = membership.rows.filter((row): row is typeof row & { id: number; uid: string; key: Record<string, unknown> } => row.id !== null).slice(0,options.limit);
    if (identities.length === 0) return { rows: [], next: null, total };
    const records = await readKindAssertions(tx,'vertex',decl.kind,fields,{ validAt, identities, repositoryKinds: this.repositoryKinds(decl.kind) });
    const rows = await this.generatedEntities(decl,records);
    rows.sort((a,b) => byCodePoint(a.key,b.key));
    return { rows, next: membership.rows.length > options.limit ? rows.at(-1)!.key : null, total };
  }
  private async generatedOfKinds(tx:OuterTransaction,kinds:readonly GeneratedKindRead[]):Promise<GraphEntity[]> {
    const entities:GraphEntity[]=[];
    for(const decl of kinds)entities.push(...await this.generatedEntities(decl,await this.records(tx,'vertex',decl.kind,decl.columns.filter(field => !decl.key.includes(field)))));
    return entities;
  }
  private async entitiesOfIds(tx:OuterTransaction,ids:readonly string[],scope:string|null=this.scope??null,localIds=false):Promise<Map<string,GraphEntity>> {
    if (ids.length === 0) return new Map();
    const identities = await tx.query<{ id: number; uid: string; kind: string }>(
      `SELECT n.id,n.uid::text,k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE ${localIds ? 'n.id=ANY($1::bigint[])' : 'n.uid=ANY($1::uuid[])'}`, [ids]);
    const entities: GraphEntity[] = [];
    for (const kind of new Set(identities.rows.map(row => row.kind))) {
      const decl = this.generatedKind(kind);
      if (decl === undefined) continue;
      const subjects = identities.rows.filter(row => row.kind === kind).map(row => Number(row.id));
      const records = await this.records(tx, 'vertex', kind, decl.columns.filter(field => !decl.key.includes(field)), subjects);
      entities.push(...await this.generatedEntities( decl, records));
    }
    return new Map(entities.map(e=>[localIds ? String(identities.rows.find(row => row.uid === e.uid)!.id) : e.nodeIds[0]!,scope===null?e:{...e,scope}]));
  }

  async edgesOf(entity: GraphEntity, relation: string, direction: 'out' | 'in', limit: number): Promise<{ total: number; rows: NeighborEdge[] }> {
    if (this.declared !== undefined && this.declared.size === 0) return { total: 0, rows: [] };
    const graph = graphRelationOf(relation, this.generatedEdges);
    if (graph === undefined) return { total: 0, rows: [] };
    const [self, far] = direction === 'out' ? ['from_node', 'to_node'] : ['to_node', 'from_node'];
    return await this.run(async (tx) => {
      const found = await tx.query<{ id: string; other: string; discriminator: string }>(
        `SELECT e.id::text AS id, e.${far}::text AS other, e.discriminator FROM edge e JOIN entity k ON k.id = e.entity_id
         WHERE k.name = $1 AND e.${self} IN (SELECT id FROM node WHERE uid=ANY($2::uuid[])) ORDER BY e.${far}, e.id`,
        [graph.kind, entity.nodeIds],
      );
      const edgeRecords = await this.records(tx, 'edge', graph.kind, this.generatedEdges?.get(graph.kind)?.columns ?? [], found.rows.map(edge => Number(edge.id)));
      const active = new Set(edgeRecords.map(edge => String(edge.id)));
      const properties = new Map(edgeRecords.map(edge => [String(edge.id), Object.fromEntries(Object.entries(edge.values).filter(([property]) => property !== '$exists'))]));
      found.rows = found.rows.filter(e=>active.has(e.id));
      const keys = [...new Set(found.rows.map((row) => row.other))];
      const entities = await this.entitiesOfIds(tx, keys, this.scope ?? null, true);
      const ordered = keys.map((id) => entities.get(id)).filter((one): one is GraphEntity => one !== undefined).sort((a, b) => byCodePoint(a.key, b.key));
      const shown = ordered.slice(0, limit);
      const rows: NeighborEdge[] = [];
      for (const other of shown) {
        const edges = found.rows.filter((row) => entities.get(row.other) === other);
        const first = edges[0];
        if (first === undefined) continue;
        rows.push({ relation, direction, other, properties: { ...properties.get(first.id), discriminator: first.discriminator, sites: edges.length }, position: null });
      }
      return { total: ordered.length, rows };
    });
  }

  async byPrefix(kind:string,prefix:string,limit:number,after?:string):Promise<{total:number;rows:GraphEntity[]}> {
    const decl=this.generatedKind(kind);if(decl===undefined)return {total:0,rows:[]};
    return await this.run(async tx=>{const all=(await this.generatedOfKinds(tx,[decl])).filter(e=>e.key.startsWith(prefix)).sort((a,b)=>byCodePoint(a.key,b.key));return {total:all.length,rows:all.filter(e=>after===undefined||byCodePoint(e.key,after)>0).slice(0,limit)};});
  }
  async fileFacts(prefix:string,limit:number):Promise<{total:number;rows:readonly FileFactRow[]}> {
    const decl=this.generatedKind(GIT_KINDS.file);if(decl===undefined)return {total:0,rows:[]};
    return await this.run(async tx=>{const entities=(await this.generatedOfKinds(tx,[decl])).filter(e=>String(e.properties['path']).startsWith(prefix));return {total:entities.length,rows:entities.slice(0,limit).map(e=>({key:e.key,node:e.nodeIds[0]!,path:String(e.properties['path']),repository:String(e.properties['repositoryName']??''),scope:e.scope,class:typeof e.properties['class']==='string'?e.properties['class']:'unknown',lines:e.properties['lines']==null?null:Number(e.properties['lines'])}))};});
  }

  async relationEdges(relation: string, limit: number): Promise<{ total: number; rows: RelationEdge[] }> {
    if (this.declared !== undefined && this.declared.size === 0 && (this.generatedEdges?.size ?? 0) === 0) return { total: 0, rows: [] };
    const graph = graphRelationOf(relation, this.generatedEdges);
    if (graph === undefined) return { total: 0, rows: [] };
    return await this.run(async (tx) => {
      const edgeRecords = await this.records(tx, 'edge', graph.kind, this.generatedEdges?.get(graph.kind)?.columns ?? []);
      const found = edgeRecords.map(edge => ({ id: String(edge.id), from_node: String(edge.from!), to_node: String(edge.to!), discriminator: edge.discriminator! }))
        .sort((a, b) => Number(a.from_node) - Number(b.from_node) || Number(a.to_node) - Number(b.to_node) || byCodePoint(a.discriminator, b.discriminator) || Number(a.id) - Number(b.id));
      const entities = await this.entitiesOfIds(tx, [...new Set(found.flatMap(row => [row.from_node, row.to_node]))], this.scope ?? null, true);
      const visible = found.filter(row => entities.has(row.from_node) && entities.has(row.to_node));
      const shown = visible.slice(0, limit);
      const properties = new Map(edgeRecords.map(edge => [String(edge.id), Object.fromEntries(Object.entries(edge.values).filter(([property]) => property !== '$exists'))]));
      const rows: RelationEdge[] = [];
      for (const row of shown) {
        const from = entities.get(row.from_node);
        const to = entities.get(row.to_node);
        if (from === undefined || to === undefined) continue;
        // Both ends carry the values the page reads of them: a foreign key's column names its table there, and a
        // relation stated between two tables answers with the tables themselves.
        if (from.uid === undefined || to.uid === undefined) throw new Error(`${import.meta.path}:427: relation endpoint lacks graph UID`);
        rows.push({
          discriminator: row.discriminator,
          from: { uid: from.uid, key: from.key, kind: from.kind, label: from.label, properties: from.properties },
          to: { uid: to.uid, key: to.key, kind: to.kind, label: to.label, properties: to.properties },
          properties: properties.get(row.id) ?? {},
        });
      }
      return { total: visible.length, rows };
    });
  }

  async repositories(): Promise<{ nodeId: string; path: string }[]> {
    if (this.declared !== undefined && this.declared.size === 0) return [];
    return await this.run(async tx=>(await this.records(tx,'vertex',GIT_KINDS.repository,[])).map(r=>({nodeId:r.uid,path:String(r.key['name'])})).sort((a,b)=>byCodePoint(a.path,b.path)));
  }
}
