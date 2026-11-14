/**
 * The read side of the GraphQL API (decision 0036, sections 2 to 4): one resolver layer over the store, one
 * read-only snapshot per operation, relations and fields batched per level so a list of entities costs a statement
 * per type and per edge and never one per row.
 *
 * **Values are opinions.** The open opinions of a field are read together; the value every one of them agrees on is
 * the field's, a field they disagree on is null and listed in `contested`, and `<field>Opinions` keeps each opinion
 * with its producer, its language, when it was stated and the places it rests on. A text field held in several
 * languages gives the opinion in the reader's language, else the product's.
 *
 * **A vertex is its node.** A vertex kind's key stands in `node.key` and is not a column; every other field is a
 * column of the kind's opinion table. An edge is a row of `edge` with its own opinion table; its record keeps the
 * discriminator, so repeated edges between the same ends stay apart. A reference field holds `{kind, key}` and its
 * inverse is read from the source kind's table.
 *
 * **The catalogue is a graph too.** Every entry the product's start publishes as a `manifest.kind` vertex is a
 * catalogue entity, taken or not; its fields, the plugins that fill it, whether the product takes it and its
 * derivation relations come from those vertices and the manifest's field and dependency vertices.
 */
import type { GraphQLFieldResolver } from 'graphql';
import type { OuterTransaction } from '../adapters/database-owner.js';
import { generatedTableName, type FieldType } from '../graph/contract.js';
import { byCodePoint } from '../model/order.js';
import { homeKind, type KindsManifest } from '../product/manifest/kinds.js';
import { fieldNameOf, typeNameOf } from '../graphql/names.js';
import type { PublishedEdge, PublishedField, PublishedKind, PublishedManifest } from '../graphql/manifest.js';
import type { ProductTemplates } from './product-templates.js';

/** One open opinion of a vertex or an edge, as the read holds it. */
export interface OpinionRow {
  readonly id: string;
  readonly saidBy: string;
  readonly producer: string;
  readonly version: string;
  readonly statedAt: unknown;
  readonly lang: string | null;
  readonly evidence: readonly unknown[];
  readonly values: Readonly<Record<string, unknown>>;
}

/** One entity the schema answers: a graph vertex, its kind, its key and the concrete GraphQL type it completes as. */
export interface EntityValue {
  readonly nodeId: string;
  readonly uid: string;
  /** The product kind name, or `catalogue` for a catalogue entry. */
  readonly kind: string;
  readonly key: Readonly<Record<string, unknown>>;
  readonly typeName: string;
  /** The reader language the root named, inherited by everything reached through this entity. */
  readonly lang?: string;
  readonly catalogue?: CatalogueValue;
}

/** One catalogue entry, read from what the product's start published into the graph. */
export interface CatalogueValue {
  readonly nodeId: string;
  readonly uid: string;
  readonly name: string;
  readonly entry: Readonly<Record<string, unknown>>;
  readonly taken: boolean;
  readonly plugins: readonly string[];
  readonly fields: readonly CatalogueFieldValue[];
  readonly derivesFrom: readonly string[];
  readonly derivedBy: readonly string[];
}

/** One field a catalogue entry's declaration names. */
export interface CatalogueFieldValue {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly reference: string | null;
  readonly producers: readonly string[];
}

/** What a GraphQL argument list may give a connection. */
export interface ConnectionArgs {
  readonly where?: Readonly<Record<string, unknown>>;
  readonly orderBy?: readonly Readonly<Record<string, unknown>>[];
  readonly first?: number | null;
  readonly after?: string | null;
}

/** One row of an edge connection, as the record answers it. */
interface EdgeRow {
  readonly edgeId: string;
  readonly discriminator: string;
  readonly node: EntityValue;
  readonly values: Readonly<Record<string, unknown>>;
  readonly cursor: string;
  readonly lang?: string;
}

/** One parent's edge rows and their opinions, held for the connection that reads them. */
interface EdgeBatch {
  readonly rows: EdgeRow[];
  readonly total: number;
  readonly opinions: Map<string, OpinionRow[]>;
}

/** A parameterised statement under construction. */
class Sql {
  readonly parts: string[] = [];
  readonly params: unknown[] = [];

  param(value: unknown, cast: string): string {
    this.params.push(value);
    return `$${String(this.params.length)}${cast}`;
  }
}

/** The cast a field's values take as SQL parameters and comparisons. */
function castOf(type: FieldType): string {
  switch (type) {
    case 'text': return '::text';
    case 'integer': return '::integer';
    case 'bigint': return '::bigint';
    case 'boolean': return '::boolean';
    case 'timestamp': return '::timestamptz';
    case 'json': return '::jsonb';
  }
}

/** A cursor: an opaque base64url JSON value. */
function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: string | null | undefined): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown; } catch { return undefined; }
}

/** The page's size: 50 by default, at most 200. */
function clampFirst(first: number | null | undefined): number {
  if (first === null || first === undefined) return 50;
  return Math.min(Math.max(0, Math.trunc(first)), 200);
}

/** A JSON value with its object keys in code point order, so two equal values write one text. */
function canonicalJson(value: unknown): string {
  const canonical = (held: unknown): unknown => {
    if (Array.isArray(held)) return held.map(canonical);
    if (held !== null && typeof held === 'object') {
      return Object.fromEntries(Object.keys(held as Record<string, unknown>).sort().map((key) => [key, canonical((held as Record<string, unknown>)[key])]));
    }
    return held;
  };
  return JSON.stringify(canonical(value));
}

/** How many distinct values one field's opinions state, ignoring the nulls no opinion states. */
function distinctCount(rows: readonly OpinionRow[], field: string): number {
  const out = new Set<string>();
  for (const row of rows) {
    const value = row.values[field];
    if (value === null || value === undefined) continue;
    out.add(JSON.stringify(value));
  }
  return out.size;
}

/** The value every opinion of one field states, as the typed value itself; null when they differ or none states one. */
function agreedValue(rows: readonly OpinionRow[], field: string): unknown {
  let agreed: unknown;
  let seen = false;
  for (const row of rows) {
    const value = row.values[field];
    if (value === null || value === undefined) continue;
    if (!seen) { agreed = value; seen = true; continue; }
    if (JSON.stringify(value) !== JSON.stringify(agreed)) return null;
  }
  return seen ? agreed : null;
}

/** One opinion as the schema shows it. */
function opinionOf(row: OpinionRow, field: string): unknown {
  return { ...opinionOfAll(row), value: row.values[field] };
}

/** One opinion of an edge, with all its attributes as its value. */
function opinionOfAll(row: OpinionRow): Record<string, unknown> {
  return { value: row.values, producer: row.producer, version: row.version, lang: row.lang, statedAt: row.statedAt, evidence: evidenceOf(row.evidence) };
}

/** The places one opinion rests on, as the schema's `Evidence`: a file line, a conversation, or an outside address. */
function evidenceOf(entries: readonly unknown[]): unknown[] {
  return entries.map((entry) => {
    const held = (entry ?? {}) as Record<string, unknown>;
    const type = held['type'] === 'conversation' || held['type'] === 'url' || held['type'] === 'opinion' ? String(held['type']) : 'file';
    return {
      type,
      repository: typeof held['repository'] === 'string' ? held['repository'] : null,
      path: typeof held['path'] === 'string' ? held['path'] : null,
      lineStart: typeof held['line_start'] === 'number' ? held['line_start'] : null,
      lineEnd: typeof held['line_end'] === 'number' ? held['line_end'] : null,
      revision: typeof held['commit_or_digest'] === 'string' ? held['commit_or_digest'] : null,
      id: typeof held['id'] === 'string' ? held['id'] : null,
      url: typeof held['url'] === 'string' ? held['url'] : null,
      at: typeof held['at'] === 'string' ? held['at'] : null,
      words: typeof held['words'] === 'string' ? held['words'] : null,
    };
  });
}

/** One opinion row from a table's row: its identity and the values the requested columns hold. */
function rowOf(row: Record<string, unknown>, values: Record<string, unknown>): OpinionRow {
  const saidBy = String(row['said_by'] ?? '');
  const at = saidBy.lastIndexOf('@');
  return {
    id: String(row['opinion_id'] ?? ''),
    saidBy,
    producer: at < 0 ? saidBy : saidBy.slice(0, at),
    version: at < 0 ? '' : saidBy.slice(at + 1),
    statedAt: row['said_at'],
    lang: row['lang'] === null || row['lang'] === undefined ? null : String(row['lang']),
    evidence: Array.isArray(row['evidence']) ? row['evidence'] as readonly unknown[] : [],
    values,
  };
}

/** Whether the source is one of the schema's entities. */
export function entityOf(source: unknown): EntityValue | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const held = source as Partial<EntityValue>;
  return typeof held.nodeId === 'string' && typeof held.uid === 'string' && typeof held.typeName === 'string' ? held as EntityValue : undefined;
}

/** Whether the source is one of the schema's edge records. */
function edgeOf(source: unknown): EdgeRow | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const held = source as Partial<EdgeRow>;
  return typeof held.edgeId === 'string' && typeof held.discriminator === 'string' && held.node !== undefined ? held as EdgeRow : undefined;
}

/** One scheduled batch: the work runs in a microtask, after every resolver of the level has queued its keys. */
function scheduled(work: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    queueMicrotask(() => {
      void work().then(resolve, reject);
    });
  });
}

/** One row of a diagram's neighbourhood: an edge's ends and the relation field it was read as. */
export interface DiagramLink {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
}

/** One entity's neighbourhood at a depth: the entity, the entities it reaches, and the relations between them. */
export interface DiagramNeighbourhood {
  readonly entity: EntityValue;
  readonly nodes: ReadonlyMap<string, EntityValue>;
  readonly links: readonly DiagramLink[];
  /** Each entity's label, as the field resolver answers it. */
  readonly labels: ReadonlyMap<string, string>;
  /** Whether a level was read short of every relation, so the picture is a page of the neighbourhood, not all of it. */
  readonly truncated: boolean;
}

/** The read one operation makes: the transaction, the manifest and the batches it queues. */
export class ReadContext {
  readonly published: PublishedManifest;
  private readonly kindByType = new Map<string, PublishedKind>();
  private readonly kindByRoot = new Map<string, PublishedKind>();
  private readonly fieldsByType = new Map<string, Map<string, PublishedField>>();
  private readonly relationByType = new Map<string, Map<string, { edge: PublishedEdge; side: 'from' | 'to' }>>();
  private readonly referenceInverseByType = new Map<string, Map<string, { source: PublishedKind; field: PublishedField }>>();
  private readonly titles = new Map<string, string>();
  private readonly vertexTable = new Map<string, string>();
  private readonly edgeTable = new Map<string, string>();
  private readonly lang: string;
  private readonly fallbackLang: string;

  /** Per kind and node: the columns fetched for that node and its open opinions. */
  private readonly fieldCache = new Map<string, Map<string, { columns: Set<string>; rows: OpinionRow[] }>>();
  private fieldQueue: Map<string, Map<string, Set<string>>> | undefined;
  private fieldFlush: Promise<void> | undefined;

  /** Every reference resolved in this operation, by kind and canonical key. */
  private readonly referenceCache = new Map<string, EntityValue | null>();
  private referenceQueue: Map<string, Map<string, unknown>> | undefined;
  private referenceFlush: Promise<void> | undefined;

  private readonly edgeCache = new Map<string, Map<string, EdgeBatch>>();
  private edgeQueue: Map<string, { edge: PublishedEdge; side: 'from' | 'to'; ids: Set<string>; args: ConnectionArgs; lang?: string }> | undefined;
  private edgeFlush: Promise<void> | undefined;
  private readonly edgeOpinions = new Map<string, OpinionRow[]>();

  private readonly inverseCache = new Map<string, Map<string, { rows: EntityValue[]; cursors: string[]; total: number }>>();
  private inverseQueue: Map<string, { source: PublishedKind; field: PublishedField; targets: Map<string, EntityValue>; args: ConnectionArgs; lang?: string }> | undefined;
  private inverseFlush: Promise<void> | undefined;

  private readonly linkCache = new Map<string, { relation: string; other: EntityValue; id: string }[]>();
  private readonly linkTotals = new Map<string, number>();
  private linkQueue: Map<string, { entity: EntityValue; direction: 'in' | 'out' }> | undefined;
  private linkFlush: Promise<void> | undefined;

  private catalogueRead: { byName: Map<string, CatalogueValue>; byId: Map<string, CatalogueValue> } | undefined;

  constructor(
    private readonly tx: OuterTransaction,
    private readonly manifest: KindsManifest,
    published: PublishedManifest,
    readonly folder: string,
    lang: string | undefined,
    /** The revision of the schema and the templates, as the bootstrap states it. */
    private readonly structure: string,
    /** The product's templates and the pages they open, as the bootstrap states them. */
    private readonly productTemplates: ProductTemplates,
  ) {
    this.published = published;
    this.lang = lang ?? manifest.language ?? 'en';
    this.fallbackLang = manifest.language ?? 'en';
    for (const kind of published.kinds) {
      const type = typeNameOf(kind.name);
      this.kindByType.set(type, kind);
      this.kindByRoot.set(`all${type}`, kind);
      this.vertexTable.set(kind.name, generatedTableName(kind.name, 'vertex'));
      this.fieldsByType.set(type, new Map(kind.fields.map((field) => [fieldNameOf(field.name), field])));
      const title = manifest.kinds.get(kind.name)?.title;
      if (title !== undefined) this.titles.set(kind.name, title);
    }
    const everyType = ['CatalogueEntity', ...[...this.kindByType.keys()]];
    for (const edge of published.edges) {
      this.edgeTable.set(edge.name, generatedTableName(edge.name, 'edge'));
      // An `any` end stands on the Entity interface: the field answers on every entity, the catalogue's too.
      for (const from of edge.from) {
        for (const type of from === 'any' ? everyType : [typeNameOf(from)]) {
          const held = this.relationByType.get(type) ?? new Map<string, { edge: PublishedEdge; side: 'from' | 'to' }>();
          held.set(fieldNameOf(edge.name), { edge, side: 'from' });
          this.relationByType.set(type, held);
        }
      }
      for (const to of edge.to) {
        for (const type of to === 'any' ? everyType : [typeNameOf(to)]) {
          const held = this.relationByType.get(type) ?? new Map<string, { edge: PublishedEdge; side: 'from' | 'to' }>();
          held.set(`${fieldNameOf(edge.name)}Of`, { edge, side: 'to' });
          this.relationByType.set(type, held);
        }
      }
    }
    for (const kind of published.kinds) {
      for (const field of kind.fields) {
        if (field.reference === undefined) continue;
        const target = typeNameOf(field.reference);
        const held = this.referenceInverseByType.get(target) ?? new Map<string, { source: PublishedKind; field: PublishedField }>();
        held.set(`${fieldNameOf(field.name)}Of${typeNameOf(kind.name)}`, { source: kind, field });
        this.referenceInverseByType.set(target, held);
      }
    }
  }

  /** The GraphQL resolver of one field, over whatever the parent is. */
  readonly resolve: GraphQLFieldResolver<unknown, ReadContext> = (source, args, _context, info) => {
    if (info.parentType.name === 'Query') return this.root(info.fieldName, args as Record<string, unknown>);
    const entity = entityOf(source);
    if (entity !== undefined) return this.entityField(entity, info.fieldName, args as ConnectionArgs);
    const edge = edgeOf(source);
    if (edge !== undefined) return this.edgeField(edge, info.fieldName);
    if (source !== null && typeof source === 'object') {
      const held = source as Record<string, unknown>;
      return info.fieldName in held ? held[info.fieldName] : null;
    }
    return null;
  };

  // ---- fields ------------------------------------------------------------------------------------------------

  private async entityField(entity: EntityValue, name: string, args: ConnectionArgs): Promise<unknown> {
    if (entity.catalogue !== undefined) return this.catalogueField(entity.catalogue, name, args, entity.lang);
    if (name === 'id') return entity.uid;
    if (name === 'kind') return entity.kind;
    if (name === 'label') return this.labelOf(entity);
    if (name === 'template') return this.templateOf(entity, entity.kind);
    if (name === 'contested') return this.contestedOf(entity);
    if (name === 'backlinks') return this.backlinks(entity, args);
    if (name === 'outgoing') return this.outgoing(entity, args);
    const field = this.fieldsByType.get(entity.typeName)?.get(name);
    if (field !== undefined) {
      const read = await this.fieldRead(entity, field);
      if (field.reference !== undefined && read.value !== null && typeof read.value === 'object') return this.referenceValue(entity, field.reference, read.value as Record<string, unknown>);
      return read.value;
    }
    const opinions = /^(.*)Opinions$/u.exec(name);
    if (opinions !== null) {
      const held = this.fieldsByType.get(entity.typeName)?.get(opinions[1]!);
      if (held !== undefined) return await this.fieldOpinions(entity, held);
    }
    const count = /^(.*)OpinionsCount$/u.exec(name);
    if (count !== null) {
      const held = this.fieldsByType.get(entity.typeName)?.get(count[1]!);
      if (held !== undefined) return (await this.fieldRead(entity, held)).count;
    }
    const relation = this.relationByType.get(entity.typeName)?.get(name);
    if (relation !== undefined) return this.relation(entity, relation.edge, relation.side, args);
    const inverse = this.referenceInverseByType.get(entity.typeName)?.get(name);
    if (inverse !== undefined) return this.referenceInverse(entity, inverse.source, inverse.field, args);
    return null;
  }

  /**
   * The vertex a reference field names, as the entity the schema shows. References are batched per level by kind:
   * every parent of the level that names one is resolved by one statement, and the same reference is looked up once.
   */
  private async referenceValue(parent: EntityValue, reference: string, value: Record<string, unknown>): Promise<EntityValue | null> {
    const kind = typeof value['kind'] === 'string' ? value['kind'] : reference;
    const key = value['key'];
    if (key === null || typeof key !== 'object') return null;
    const cacheKey = `${kind}\u0000${canonicalJson(key)}`;
    for (;;) {
      const held = this.referenceCache.get(cacheKey);
      if (held !== undefined) return held === null ? null : { ...held, ...(parent.lang === undefined ? {} : { lang: parent.lang }) };
      this.referenceQueue ??= new Map();
      const byKind = this.referenceQueue.get(kind) ?? new Map<string, unknown>();
      byKind.set(canonicalJson(key), key);
      this.referenceQueue.set(kind, byKind);
      this.referenceFlush ??= scheduled(() => this.flushReferences());
      await this.referenceFlush;
    }
  }

  private async flushReferences(): Promise<void> {
    await Promise.resolve();
    const queue = this.referenceQueue;
    this.referenceQueue = undefined;
    this.referenceFlush = undefined;
    if (queue === undefined) return;
    for (const [kind, keys] of queue) {
      const wanted = [...keys.values()];
      const rows = await this.tx.query<Record<string, unknown>>(
        `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity
         FROM node n JOIN entity en ON en.id = n.entity_id
         WHERE en.name = $1 AND n.context_id = 1 AND NOT n.removed
           AND n.key IN (SELECT jsonb_array_elements($2::jsonb))`,
        [kind, JSON.stringify(wanted)],
      );
      const found = new Map<string, EntityValue>();
      for (const row of rows.rows) {
        const value = this.entityFromRow(row);
        if (value !== undefined) found.set(canonicalJson(row['key']), value);
      }
      for (const key of wanted) {
        const held = found.get(canonicalJson(key));
        this.referenceCache.set(`${kind}\u0000${canonicalJson(key)}`, held ?? null);
      }
    }
  }

  private async labelOf(entity: EntityValue): Promise<string> {
    // The label is the field the manifest's `title:` names (decision 0036, section 1): a key field answers its own
    // value, any other field its agreed opinion. A kind that names no title is labelled by the first text of its key.
    const title = this.titles.get(entity.kind);
    const typeFields = this.fieldsByType.get(entity.typeName);
    const field = title === undefined ? undefined : typeFields?.get(fieldNameOf(title));
    if (field !== undefined) {
      if (field.type === 'text' && entity.key[field.name] !== undefined) return String(entity.key[field.name]);
      const read = await this.fieldRead(entity, field);
      if (typeof read.value === 'string' && read.value !== '') return read.value;
      if (read.value !== null && read.value !== undefined) return String(read.value);
    } else if (typeFields === undefined || typeFields.size === 0) {
      // A kind that declares no field still states its label: the writer holds it in the storage column the schema does
      // not publish, and a store whose table has no such column answers its key instead.
      const value = await this.storageLabel(entity).catch(() => undefined);
      if (typeof value === 'string' && value !== '') return value;
    }
    for (const value of Object.values(entity.key)) if (typeof value === 'string' && value !== '') return value;
    return entity.uid;
  }

  /** The label a kind that declares no field keeps in its own table. */
  private async storageLabel(entity: EntityValue): Promise<unknown> {
    await this.ensureFields(entity.kind, entity.nodeId, ['label']);
    const rows = (this.fieldCache.get(entity.kind)?.get(entity.nodeId)?.rows ?? []).filter((row) => row.values['label'] !== null && row.values['label'] !== undefined);
    const inLang = rows.filter((row) => row.lang === (entity.lang ?? this.lang));
    const fallback = rows.filter((row) => row.lang === this.fallbackLang);
    const chosen = inLang.length > 0 ? inLang : fallback.length > 0 ? fallback : rows.filter((row) => row.lang === null);
    return agreedValue(chosen.length > 0 ? chosen : rows, 'label');
  }

  /**
   * The page template an entity opens with (decision 0036, section 6): its own template, else its kind's record template,
   * else the base `entity`; a catalogue entity's page is the product's catalogue template.
   */
  private templateOf(entity: EntityValue | undefined, kind: string): string {
    if (entity?.catalogue !== undefined) return this.productTemplates.catalogue;
    const own = entity === undefined ? undefined : this.productTemplates.own.get(entity.uid);
    if (own !== undefined) return own;
    return this.productTemplates.records.get(kind) ?? 'entity';
  }

  private async contestedOf(entity: EntityValue): Promise<string[]> {
    const kind = this.kindByType.get(entity.typeName);
    if (kind === undefined) return [];
    // A key field is identity, not an opinion: only the kind's other fields can differ.
    const fields = kind.fields.filter((field) => !kind.key.includes(field.name));
    await this.ensureFields(kind.name, entity.nodeId, fields.map((field) => field.name));
    return fields.filter((field) => distinctCount(this.chosenOpinions(kind.name, entity.nodeId, field, entity.lang), field.name) > 1).map((field) => fieldNameOf(field.name));
  }

  private async fieldRead(entity: EntityValue, field: PublishedField): Promise<{ value: unknown; count: number }> {
    const kind = this.kindByType.get(entity.typeName);
    if (kind === undefined) return { value: null, count: 0 };
    if (kind.key.includes(field.name)) return { value: entity.key[field.name] ?? null, count: 0 };
    await this.ensureFields(kind.name, entity.nodeId, [field.name]);
    const rows = this.chosenOpinions(kind.name, entity.nodeId, field, entity.lang);
    return { value: agreedValue(rows, field.name), count: rows.length };
  }

  private async fieldOpinions(entity: EntityValue, field: PublishedField): Promise<unknown[]> {
    const kind = this.kindByType.get(entity.typeName);
    if (kind === undefined) return [];
    if (kind.key.includes(field.name)) return [];
    await this.ensureFields(kind.name, entity.nodeId, [field.name]);
    // The newest opinions first: the list is the 50 a reader may show, and an old one is never chosen over a new one.
    return this.chosenOpinions(kind.name, entity.nodeId, field, entity.lang).slice(-50).reverse().map((row) => opinionOf(row, field.name));
  }

  private chosenOpinions(kind: string, nodeId: string, field: PublishedField, lang: string | undefined): OpinionRow[] {
    const rows = (this.fieldCache.get(kind)?.get(nodeId)?.rows ?? []).filter((row) => row.values[field.name] !== null && row.values[field.name] !== undefined);
    if (field.type !== 'text') return rows;
    const wanted = lang ?? this.lang;
    const inLang = rows.filter((row) => row.lang === wanted);
    if (inLang.length > 0) return inLang;
    const fallback = rows.filter((row) => row.lang === this.fallbackLang);
    if (fallback.length > 0) return fallback;
    const none = rows.filter((row) => row.lang === null);
    return none.length > 0 ? none : [];
  }

  private async ensureFields(kind: string, nodeId: string, columns: readonly string[]): Promise<void> {
    for (;;) {
      const loaded = this.fieldCache.get(kind)?.get(nodeId);
      if (loaded !== undefined && columns.every((column) => loaded.columns.has(column))) return;
      this.fieldQueue ??= new Map();
      const byNode = this.fieldQueue.get(kind) ?? new Map<string, Set<string>>();
      const held = byNode.get(nodeId) ?? new Set<string>();
      for (const column of columns) held.add(column);
      byNode.set(nodeId, held);
      this.fieldQueue.set(kind, byNode);
      this.fieldFlush ??= scheduled(() => this.flushFields());
      await this.fieldFlush;
    }
  }

  private async flushFields(): Promise<void> {
    await Promise.resolve();
    const queue = this.fieldQueue;
    this.fieldQueue = undefined;
    this.fieldFlush = undefined;
    if (queue === undefined) return;
    for (const [kind, nodes] of queue) {
      const cache = this.fieldCache.get(kind) ?? new Map<string, { columns: Set<string>; rows: OpinionRow[] }>();
      const declared = this.kindByType.get(typeNameOf(kind));
      if (declared === undefined) continue;
      const wanted = new Set<string>();
      for (const [id, columns] of nodes) {
        const held = cache.get(id);
        for (const column of columns) wanted.add(column);
        // A node fetched again keeps every column it was fetched with: the statement replaces its rows.
        for (const column of held?.columns ?? []) wanted.add(column);
      }
      const select = [...wanted].filter((column) => !declared.key.includes(column)).map((column) => {
        const field = declared.fields.find((one) => one.name === column);
        return field?.type === 'bigint' ? `"${column}"::text AS "${column}"` : `"${column}" AS "${column}"`;
      });
      const rows = await this.tx.query<Record<string, unknown>>(
        `SELECT node_id::text AS holder_id, id::text AS opinion_id, said_by, said_at, lang, evidence${select.length === 0 ? '' : `, ${select.join(', ')}`}
         FROM "${this.vertexTable.get(kind)!}"
         WHERE node_id = ANY($1::bigint[]) AND state = 'open' AND context_id = 1 ORDER BY id`,
        [[...nodes.keys()]],
      );
      const byId = new Map<string, OpinionRow[]>();
      for (const id of nodes.keys()) byId.set(id, []);
      for (const row of rows.rows) {
        const values: Record<string, unknown> = {};
        for (const column of wanted) values[column] = row[column];
        byId.get(String(row['holder_id']))?.push(rowOf(row, values));
      }
      for (const id of nodes.keys()) cache.set(id, { columns: new Set(wanted), rows: byId.get(id) ?? [] });
      this.fieldCache.set(kind, cache);
    }
  }

  // ---- relations ---------------------------------------------------------------------------------------------

  private async relation(parent: EntityValue, edge: PublishedEdge, side: 'from' | 'to', args: ConnectionArgs): Promise<unknown> {
    const key = `${edge.name}\u0000${side}\u0000${JSON.stringify(args)}\u0000${parent.lang ?? ''}`;
    this.edgeQueue ??= new Map();
    const held = this.edgeQueue.get(key) ?? { edge, side, ids: new Set<string>(), args, lang: parent.lang };
    held.ids.add(parent.nodeId);
    this.edgeQueue.set(key, held);
    this.edgeFlush ??= scheduled(() => this.flushEdges());
    await this.edgeFlush;
    const batch = this.edgeCache.get(key)?.get(parent.nodeId);
    const first = clampFirst(args.first);
    const rows = batch?.rows ?? [];
    const page = rows.slice(0, first);
    return {
      edges: page.map((row) => ({ cursor: row.cursor, node: row })),
      pageInfo: { endCursor: page.length === 0 ? null : page[page.length - 1]!.cursor, hasNextPage: rows.length > first },
      totalCount: batch?.total ?? 0,
    };
  }

  private async flushEdges(): Promise<void> {
    await Promise.resolve();
    const queue = this.edgeQueue;
    this.edgeQueue = undefined;
    this.edgeFlush = undefined;
    if (queue === undefined) return;
    for (const [key, held] of queue) {
      const { edge, side, ids, args, lang } = held;
      const sql = new Sql();
      const parentColumn = side === 'from' ? 'e.from_node' : 'e.to_node';
      const otherColumn = side === 'from' ? 'e.to_node' : 'e.from_node';
      const first = clampFirst(args.first);
      const parents = sql.param([...ids], '::bigint[]');
      const kindName = sql.param(edge.name, '::text');
      const projections = edge.fields.map((field) => {
        const expr = this.edgeValueExpr(edge, field, sql, lang);
        return field.type === 'bigint' ? `${expr} AS "attr_${field.name}", (${expr})::text AS "attr_out_${field.name}"` : `${expr} AS "attr_${field.name}", ${expr} AS "attr_out_${field.name}"`;
      }).join(', ');
      const where = this.edgeWhere(edge, args.where, sql, lang);
      const order = this.edgeOrder(edge, args.orderBy, sql, lang);
      const afterKeys = order.keys.map((one) => ({ ...one, expr: `"${one.column}"` }));
      const after = this.afterClause(afterKeys, args.after, sql, 'id');
      const rankOrder = order.keys.length === 0 ? 'rows.id' : order.keys.map((one) => one.rank).join(', ');
      const answer = await this.tx.query<Record<string, unknown>>(
        `WITH filtered AS (
           SELECT ${parentColumn}::text AS parent, e.id, e.discriminator, n2.id::text AS other_id, n2.uid::text AS other_uid,
                  n2.key AS other_key, en2.name AS other_entity${projections === '' ? '' : `, ${projections}`}
           FROM edge e
           JOIN entity en ON en.id = e.entity_id AND en.name = ${kindName}
           JOIN node n2 ON n2.id = ${otherColumn} AND n2.context_id = 1 AND NOT n2.removed
           JOIN entity en2 ON en2.id = n2.entity_id
           WHERE ${parentColumn} = ANY(${parents}) AND e.context_id = 1${where === '' ? '' : ` AND (${where})`}
         ), counted AS (
           SELECT filtered.*, count(*) OVER (PARTITION BY parent) AS total FROM filtered
         ), rows AS (
           SELECT * FROM counted${after === '' ? '' : ` WHERE ${after}`}
         ), ranked AS (
           SELECT rows.*, row_number() OVER (PARTITION BY parent ORDER BY ${rankOrder}, rows.id) AS rn FROM rows
         )
         SELECT * FROM ranked WHERE rn <= ${sql.param(first + 1, '::int')} ORDER BY parent, rn`,
        sql.params,
      );
      const opinionRows = await this.fetchEdgeOpinions(edge, [...new Set(answer.rows.map((row) => String(row['id'])))]);
      // A relation may reach a catalogue entity: its values come from the manifest the start published.
      if (answer.rows.some((row) => String(row['other_entity']) === 'manifest.kind')) await this.catalogueData();
      const batches = new Map<string, EdgeBatch>();
      for (const row of answer.rows) {
        const parent = String(row['parent']);
        const node = this.entityFromRow({ node_id: row['other_id'], uid: row['other_uid'], key: row['other_key'], entity: row['other_entity'] }, lang);
        if (node === undefined) continue;
        const values: Record<string, unknown> = {};
        for (const attribute of edge.fields) values[fieldNameOf(attribute.name)] = row[`attr_out_${attribute.name}`] ?? null;
        const orderValues = order.keys.map((one) => row[one.column] ?? null);
        const heldBatch = batches.get(parent) ?? { rows: [], total: Number(row['total']), opinions: opinionRows };
        heldBatch.rows.push({ edgeId: String(row['id']), discriminator: String(row['discriminator']), node, values, cursor: encodeCursor({ o: orderValues, id: String(row['id']) }), ...(lang === undefined ? {} : { lang }) });
        batches.set(parent, heldBatch);
      }
      const loaded = new Map<string, EdgeBatch>();
      for (const parent of ids) loaded.set(parent, batches.get(parent) ?? { rows: [], total: 0, opinions: opinionRows });
      this.edgeCache.set(key, loaded);
    }
  }

  /** One edge attribute's agreed value in the reader's language, the newest opinion of each producer counted once. */
  private edgeValueExpr(edge: PublishedEdge, field: PublishedField, sql: Sql, lang: string | undefined): string {
    const table = this.edgeTable.get(edge.name)!;
    const wanted = lang ?? this.lang;
    const language = field.type === 'text'
      ? ` AND o.lang IS NOT DISTINCT FROM (CASE
           WHEN EXISTS (SELECT 1 FROM "${table}" y WHERE y.edge_id = e.id AND y.state = 'open' AND y.context_id = 1 AND y."${field.name}" IS NOT NULL AND y.lang = ${sql.param(wanted, '::text')}) THEN ${sql.param(wanted, '::text')}
           WHEN EXISTS (SELECT 1 FROM "${table}" y WHERE y.edge_id = e.id AND y.state = 'open' AND y.context_id = 1 AND y."${field.name}" IS NOT NULL AND y.lang = ${sql.param(this.fallbackLang, '::text')}) THEN ${sql.param(this.fallbackLang, '::text')}
           ELSE NULL END)`
      : '';
    return `(SELECT CASE WHEN count(DISTINCT o."${field.name}") = 1 THEN (array_agg(o."${field.name}") FILTER (WHERE o."${field.name}" IS NOT NULL))[1] END
      FROM "${table}" o WHERE o.edge_id = e.id AND o.state = 'open' AND o.context_id = 1${language})`;
  }

  /** The operators a `<Edge>EdgeWhere` gives one attribute. */
  private edgeWhere(edge: PublishedEdge, where: Readonly<Record<string, unknown>> | undefined, sql: Sql, lang: string | undefined): string {
    if (where === undefined || where === null) return '';
    const clauses: string[] = [];
    for (const [name, filter] of Object.entries(where)) {
      const attribute = edge.fields.find((field) => fieldNameOf(field.name) === name);
      if (attribute === undefined || filter === null || typeof filter !== 'object') continue;
      const expr = this.edgeValueExpr(edge, attribute, sql, lang);
      for (const [operator, value] of Object.entries(filter as Record<string, unknown>)) {
        const clause = compareClause(expr, attribute.type, operator, value, sql);
        if (clause !== undefined) clauses.push(clause);
      }
    }
    return clauses.join(' AND ');
  }

  /** The edge record's connection order: its attributes, then its id. */
  private edgeOrder(edge: PublishedEdge, orderBy: readonly Readonly<Record<string, unknown>>[] | undefined, sql: Sql, lang: string | undefined): { keys: { expr: string; column: string; rank: string; direction: 'ASC' | 'DESC'; nulls: 'FIRST' | 'LAST'; type: FieldType }[] } {
    const keys: { expr: string; column: string; rank: string; direction: 'ASC' | 'DESC'; nulls: 'FIRST' | 'LAST'; type: FieldType }[] = [];
    for (const one of orderBy ?? []) {
      const field = edge.fields.find((held) => fieldNameOf(held.name) === one['field']);
      if (field === undefined) continue;
      const direction = one['direction'] === 'DESC' ? 'DESC' : 'ASC';
      const nulls = one['nulls'] === 'FIRST' ? 'FIRST' : 'LAST';
      keys.push({ expr: this.edgeValueExpr(edge, field, sql, lang), column: `attr_${field.name}`, rank: `rows."attr_${field.name}" ${direction} NULLS ${nulls}`, direction, nulls, type: field.type });
    }
    return { keys };
  }

  /** The opinions of a batch of edges, one statement for all of them. */
  private async fetchEdgeOpinions(edge: PublishedEdge, ids: readonly string[]): Promise<Map<string, OpinionRow[]>> {
    const out = new Map<string, OpinionRow[]>();
    if (ids.length === 0) return out;
    const table = this.edgeTable.get(edge.name)!;
    const select = edge.fields.map((field) => (field.type === 'bigint' ? `"${field.name}"::text AS "${field.name}"` : `"${field.name}" AS "${field.name}"`)).join(', ');
    const rows = await this.tx.query<Record<string, unknown>>(
      `SELECT edge_id::text AS holder_id, id::text AS opinion_id, said_by, said_at, lang, evidence${select === '' ? '' : `, ${select}`}
       FROM "${table}" WHERE edge_id = ANY($1::bigint[]) AND state = 'open' AND context_id = 1 ORDER BY id`,
      [ids],
    );
    for (const row of rows.rows) {
      const values: Record<string, unknown> = {};
      for (const field of edge.fields) values[fieldNameOf(field.name)] = row[field.name];
      const holder = String(row['holder_id']);
      const list = out.get(holder) ?? [];
      list.push(rowOf(row, values));
      out.set(holder, list);
    }
    for (const [id, list] of out) {
      const held = this.edgeOpinions.get(id) ?? [];
      this.edgeOpinions.set(id, held.length === 0 ? list : held);
    }
    return out;
  }

  private edgeField(edge: EdgeRow, name: string): unknown {
    if (name === 'id') return edge.edgeId;
    if (name === 'discriminator') return edge.discriminator;
    if (name === 'node') return edge.node;
    if (name === 'opinions') return (this.edgeOpinions.get(edge.edgeId) ?? []).slice(-50).reverse().map((row) => opinionOfAll(row));
    if (name in edge.values) return edge.values[name];
    const opinions = /^(.*)Opinions$/u.exec(name);
    if (opinions !== null) {
      return this.edgeOpinionsOf(edge, opinions[1]!).slice(0, 50).map((row) => opinionOf(row, opinions[1]!));
    }
    const count = /^(.*)OpinionsCount$/u.exec(name);
    if (count !== null) return this.edgeOpinionsOf(edge, count[1]!).length;
    return null;
  }

  /** One edge attribute's opinions in the reader's language, newest first. */
  private edgeOpinionsOf(edge: EdgeRow, field: string): OpinionRow[] {
    const rows = (this.edgeOpinions.get(edge.edgeId) ?? []).filter((row) => row.values[field] !== null && row.values[field] !== undefined);
    const wanted = edge.lang ?? this.lang;
    const inLang = rows.filter((row) => row.lang === wanted);
    const chosen = inLang.length > 0 ? inLang : rows.filter((row) => row.lang === this.fallbackLang);
    const held = chosen.length > 0 ? chosen : rows.filter((row) => row.lang === null);
    return (held.length > 0 ? held : []).slice().reverse();
  }

  // ---- reference inverses ------------------------------------------------------------------------------------

  /** The vertices whose reference field names this vertex, as a connection; every target of the level is one statement. */
  private async referenceInverse(target: EntityValue, source: PublishedKind, field: PublishedField, args: ConnectionArgs): Promise<unknown> {
    if (target.typeName === 'CatalogueEntity') return emptyConnection();
    const key = `${source.name}\u0000${field.name}\u0000${JSON.stringify(args)}\u0000${target.lang ?? ''}`;
    this.inverseQueue ??= new Map();
    const held = this.inverseQueue.get(key) ?? { source, field, targets: new Map<string, EntityValue>(), args, lang: target.lang };
    held.targets.set(target.nodeId, target);
    this.inverseQueue.set(key, held);
    this.inverseFlush ??= scheduled(() => this.flushInverseReferences());
    await this.inverseFlush;
    const page = this.inverseCache.get(key)?.get(target.nodeId) ?? { rows: [], cursors: [], total: 0 };
    const first = clampFirst(args.first);
    const rows = page.rows.slice(0, first);
    return {
      edges: rows.map((node, at) => ({ cursor: page.cursors[at]!, node })),
      pageInfo: { endCursor: rows.length === 0 ? null : page.cursors[rows.length - 1]!, hasNextPage: page.rows.length > first },
      totalCount: page.total,
    };
  }

  private async flushInverseReferences(): Promise<void> {
    await Promise.resolve();
    const queue = this.inverseQueue;
    this.inverseQueue = undefined;
    this.inverseFlush = undefined;
    if (queue === undefined) return;
    for (const [key, held] of queue) {
      const { source, field, targets, args, lang } = held;
      const sql = new Sql();
      const sourceKind = sql.param(source.name, '::text');
      const targetIds = sql.param([...targets.keys()], '::bigint[]');
      const targetKind = sql.param(field.reference ?? '', '::text');
      const where = this.vertexWhere(source, args.where, sql, 'n', lang);
      const order = this.vertexOrder(source, args.orderBy, sql, 'n', lang);
      const first = clampFirst(args.first);
      const selectOrder = order.keys.map((one) => `${one.expr} AS "order_${String(one.at)}"`).join(', ');
      const afterKeys = order.keys.map((one) => ({ ...one, expr: `"order_${String(one.at)}"` }));
      const after = this.afterClause(afterKeys, args.after, sql, 'node_id::bigint');
      const rankOrder = order.keys.length === 0 ? 'rows.node_id::bigint' : order.keys.map((one) => `rows."order_${String(one.at)}" ${one.direction} NULLS ${one.nulls}`).join(', ');
      const table = this.vertexTable.get(source.name)!;
      // A reference in the key lives in `node.key`; one stated as a field is the value its opinions agree on.
      const reference = source.key.includes(field.name)
        ? `(n.key->'${field.name}')`
        : `(SELECT CASE WHEN count(DISTINCT o."${field.name}") = 1 THEN (array_agg(o."${field.name}") FILTER (WHERE o."${field.name}" IS NOT NULL))[1] END FROM "${table}" o WHERE o.node_id = n.id AND o.state = 'open' AND o.context_id = 1)`;
      const answer = await this.tx.query<Record<string, unknown>>(
        `WITH filtered AS (
           SELECT tn.id::text AS target, n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity${selectOrder === '' ? '' : `, ${selectOrder}`}
           FROM node n
           JOIN entity en ON en.id = n.entity_id
           JOIN node tn ON tn.id = ANY(${targetIds}) AND tn.context_id = 1 AND NOT tn.removed
                       AND tn.entity_id = (SELECT id FROM entity WHERE name = ${targetKind})
                       AND tn.key = ${reference}->'key'
           WHERE en.name = ${sourceKind} AND n.context_id = 1 AND NOT n.removed
             AND ${reference}->>'kind' = ${targetKind}${where === '' ? '' : ` AND (${where})`}
         ), counted AS (
           SELECT filtered.*, count(*) OVER (PARTITION BY target) AS total FROM filtered
         ), rows AS (
           SELECT * FROM counted${after === '' ? '' : ` WHERE ${after}`}
         ), ranked AS (
           SELECT rows.*, row_number() OVER (PARTITION BY target ORDER BY ${rankOrder}, rows.node_id::bigint) AS rn FROM rows
         )
         SELECT * FROM ranked WHERE rn <= ${sql.param(first + 1, '::int')} ORDER BY target, rn`,
        sql.params,
      );
      const cache = new Map<string, { rows: EntityValue[]; cursors: string[]; total: number }>();
      for (const target of targets.keys()) cache.set(target, { rows: [], cursors: [], total: 0 });
      for (const row of answer.rows) {
        const target = String(row['target']);
        const node = this.entityFromRow(row, lang);
        if (node === undefined) continue;
        const heldPage = cache.get(target)!;
        heldPage.rows.push(node);
        heldPage.cursors.push(encodeCursor({ o: order.keys.map((one) => row[`order_${String(one.at)}`] ?? null), id: node.nodeId }));
        heldPage.total = Number(row['total']);
      }
      this.inverseCache.set(key, cache);
    }
  }



  /**
   * One entity's neighbourhood at a depth, for a rendered diagram (decision 0036, sections 7 and 8): the graph read layer
   * both ways per level, one snapshot, and every relation's field name as the schema answers it. A page folds what it shows
   * by kind above its bound; this step answers the whole neighbourhood it read, so the same graph revision gives the same
   * picture. A relation is read once per end and once per edge: the pair and its relation name decide the dedup.
   */
  async diagramNeighbourhood(id: string, depth: number, lang: string | undefined, first = 200): Promise<DiagramNeighbourhood | undefined> {
    const root = entityOf(await this.root('entity', { id, ...(lang === undefined ? {} : { lang }) }));
    if (root === undefined) return undefined;
    const nodes = new Map<string, EntityValue>([[root.uid, root]]);
    const links: DiagramLink[] = [];
    const seenEdges = new Set<string>();
    const edgeKey = (from: string, to: string, relation: string): string => `${from}\u0000${to}\u0000${relation}`;
    let truncated = false;
    let frontier: EntityValue[] = [root];
    for (let level = 0; level < Math.max(depth, 1); level += 1) {
      const next: EntityValue[] = [];
      for (const entity of frontier) {
        for (const side of ['out', 'in'] as const) {
          const answer = await this.links(entity, { first }, side) as { edges?: readonly { node?: { relation?: unknown; from?: unknown; to?: unknown } }[]; pageInfo?: { hasNextPage?: unknown }; totalCount?: unknown };
          if (answer.pageInfo?.hasNextPage === true || (typeof answer.totalCount === 'number' && answer.totalCount > (answer.edges?.length ?? 0))) truncated = true;
          for (const edge of answer.edges ?? []) {
            const relation = typeof edge.node?.relation === 'string' ? edge.node.relation : '';
            const other = entityOf(side === 'out' ? edge.node?.to : edge.node?.from);
            if (other === undefined || relation === '') continue;
            const from = side === 'out' ? entity.uid : other.uid;
            const to = side === 'out' ? other.uid : entity.uid;
            // The edge and its inverse are one row: the same pair and the same field, read from either end.
            const key = edgeKey(from, to, relation);
            if (seenEdges.has(key)) continue;
            seenEdges.add(key);
            links.push({ from, to, relation });
            if (!nodes.has(other.uid)) {
              nodes.set(other.uid, other);
              next.push(other);
            }
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    const labels = new Map<string, string>();
    for (const [uid, entity] of nodes) labels.set(uid, await this.labelOf(entity));
    return { entity: root, nodes, links, labels, truncated };
  }

  // ---- links both ways ---------------------------------------------------------------------------------------

  private async backlinks(entity: EntityValue, args: ConnectionArgs): Promise<unknown> {
    return await this.links(entity, args, 'in');
  }

  private async outgoing(entity: EntityValue, args: ConnectionArgs): Promise<unknown> {
    return await this.links(entity, args, 'out');
  }

  /**
   * One entity's relations, both ways (section 3): `in` is the row of every edge that ends at it and of every
   * reference that points at it — the inverse field's name is the relation — and `out` is the row of every edge that
   * starts at it. A page draws them as one picture: the same edge seen from either end.
   */
  private async links(entity: EntityValue, args: ConnectionArgs, direction: 'in' | 'out'): Promise<unknown> {
    const key = `${direction}\u0000${entity.nodeId}`;
    this.linkQueue ??= new Map();
    this.linkQueue.set(key, { entity, direction });
    this.linkFlush ??= scheduled(() => this.flushLinks());
    await this.linkFlush;
    const rows = this.linkCache.get(key) ?? [];
    const first = clampFirst(args.first);
    const cursor = decodeCursor(args.after) as { relation?: string; id?: string } | undefined;
    const ordered = [...rows].sort((left, right) => byCodePoint(left.relation, right.relation) || Number(left.id) - Number(right.id));
    const after = cursor?.relation === undefined
      ? ordered
      : ordered.filter((row) => row.relation > cursor.relation! || (row.relation === cursor.relation && Number(row.id) > Number(cursor.id ?? 0)));
    const page = after.slice(0, first);
    const nodeOf = (row: { relation: string; other: EntityValue }): unknown =>
      direction === 'in' ? { relation: row.relation, from: row.other } : { relation: row.relation, to: row.other };
    return {
      edges: page.map((row) => ({ cursor: encodeCursor({ relation: row.relation, id: row.id }), node: nodeOf(row) })),
      pageInfo: { endCursor: page.length === 0 ? null : encodeCursor({ relation: page[page.length - 1]!.relation, id: page[page.length - 1]!.id }), hasNextPage: after.length > first },
      totalCount: this.linkTotals.get(`${direction}\u0000${entity.nodeId}`) ?? ordered.length,
    };
  }

  private async flushLinks(): Promise<void> {
    await Promise.resolve();
    const queue = this.linkQueue;
    this.linkQueue = undefined;
    this.linkFlush = undefined;
    if (queue === undefined) return;
    // Targets of one type, one direction and one reader language share a statement; the other end carries that language on.
    const byType = new Map<string, { ids: string[]; entity: EntityValue; direction: 'in' | 'out' }>();
    for (const held of queue.values()) {
      const key = `${held.direction}\u0000${held.entity.typeName}\u0000${held.entity.lang ?? ''}`;
      const bucket = byType.get(key) ?? { ids: [], entity: held.entity, direction: held.direction };
      bucket.ids.push(held.entity.nodeId);
      byType.set(key, bucket);
    }
    for (const [, held] of byType) {
      const sql = new Sql();
      const ids = sql.param(held.ids, '::bigint[]');
      const parts: string[] = [
        held.direction === 'in'
          ? `SELECT e.to_node AS target, en.name AS relation, e.id::text AS source_id, e.from_node AS other
         FROM edge e JOIN entity en ON en.id = e.entity_id WHERE e.to_node = ANY(${ids}) AND e.context_id = 1`
          : `SELECT e.from_node AS target, en.name AS relation, e.id::text AS source_id, e.to_node AS other
         FROM edge e JOIN entity en ON en.id = e.entity_id WHERE e.from_node = ANY(${ids}) AND e.context_id = 1`,
      ];
      for (const [inverseField, inverse] of held.direction === 'out' ? [] : (this.referenceInverseByType.get(held.entity.typeName) ?? new Map())) {
        const targetKind = sql.param(held.entity.kind, '::text');
        const relation = sql.param(inverseField, '::text');
        const sourceKind = sql.param(inverse.source.name, '::text');
        const table = this.vertexTable.get(inverse.source.name)!;
        // A reference in the key stands in `node.key`; one stated as a field is its opinions' agreed value.
        if (inverse.source.key.includes(inverse.field.name)) {
          parts.push(`SELECT tn.id AS target, ${relation} AS relation, n.id::text AS source_id, n.id AS other
            FROM node n
            JOIN entity en ON en.id = n.entity_id AND en.name = ${sourceKind}
            JOIN node tn ON tn.id = ANY(${ids}) AND tn.context_id = 1 AND NOT tn.removed
                        AND tn.entity_id = (SELECT id FROM entity WHERE name = ${targetKind})
                        AND tn.key = n.key->'${inverse.field.name}'->'key'
            WHERE n.context_id = 1 AND NOT n.removed AND n.key->'${inverse.field.name}'->>'kind' = ${targetKind}`);
        } else {
          const agreed = `(SELECT CASE WHEN count(DISTINCT o."${inverse.field.name}") = 1 THEN (array_agg(o."${inverse.field.name}") FILTER (WHERE o."${inverse.field.name}" IS NOT NULL))[1] END FROM "${table}" o WHERE o.node_id = n.id AND o.state = 'open' AND o.context_id = 1)`;
          parts.push(`SELECT tn.id AS target, ${relation} AS relation, n.id::text AS source_id, n.id AS other
            FROM "${table}" t
            JOIN node n ON n.id = t.node_id
            JOIN entity en ON en.id = n.entity_id AND en.name = ${sourceKind}
            JOIN node tn ON tn.id = ANY(${ids}) AND tn.context_id = 1 AND NOT tn.removed
                        AND tn.entity_id = (SELECT id FROM entity WHERE name = ${targetKind})
                        AND tn.key = ${agreed}->'key' AND t."${inverse.field.name}"->>'kind' = ${targetKind}
            WHERE t.state = 'open' AND t.context_id = 1 AND n.context_id = 1 AND NOT n.removed`);
        }
      }
      const rows = await this.tx.query<Record<string, unknown>>(
        `WITH links AS (${parts.join(' UNION ALL ')}), distinct_links AS (
           SELECT DISTINCT target, relation, source_id, other FROM links
         ), ranked AS (
           SELECT distinct_links.*, row_number() OVER (PARTITION BY target ORDER BY relation, source_id) AS rn,
                  count(*) OVER (PARTITION BY target) AS total
           FROM distinct_links
         )
         SELECT * FROM ranked ORDER BY target, rn`,
        sql.params,
      );
      const others = [...new Set(rows.rows.map((row) => String(row['other'])))];
      const nodes = others.length === 0 ? [] : (await this.tx.query<Record<string, unknown>>(
        `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity FROM node n JOIN entity en ON en.id = n.entity_id WHERE n.id = ANY($1::bigint[])`,
        [others],
      )).rows;
      const byId = new Map<string, EntityValue>();
      for (const row of nodes) {
        const node = this.entityFromRow(row, held.entity.lang);
        if (node !== undefined) byId.set(node.nodeId, node);
      }
      const lists = new Map<string, { relation: string; other: EntityValue; id: string }[]>();
      for (const row of rows.rows) {
        const target = String(row['target']);
        const other = byId.get(String(row['other']));
        if (other === undefined) continue;
        const relationName = held.direction === 'in' ? this.backlinkRelation(String(row['relation'])) : fieldNameOf(String(row['relation']));
        const list = lists.get(target) ?? [];
        list.push({ relation: relationName, other, id: String(row['source_id']) });
        lists.set(target, list);
        this.linkTotals.set(`${held.direction}\u0000${target}`, Number(row['total']));
      }
      for (const id of held.ids) this.linkCache.set(`${held.direction}\u0000${id}`, lists.get(id) ?? []);
    }
  }

  /** The relation name an inverse field gives a backlink: the edge's `<edge>Of` name, or the reference's `<field>Of<Type>`. */
  private backlinkRelation(relation: string): string {
    const edge = this.published.edges.find((one) => one.name === relation);
    return edge === undefined ? relation : `${fieldNameOf(edge.name)}Of`;
  }

  // ---- roots -------------------------------------------------------------------------------------------------

  private async root(field: string, args: Record<string, unknown>): Promise<unknown> {
    const lang = typeof args['lang'] === 'string' ? args['lang'] : undefined;
    if (field === 'entity') {
      const id = typeof args['id'] === 'string' ? args['id'] : '';
      if (id === '') return null;
      const rows = await this.tx.query<Record<string, unknown>>(
        `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity
         FROM node n JOIN entity en ON en.id = n.entity_id WHERE n.uid = $1::uuid AND n.context_id = 1 AND NOT n.removed LIMIT 1`,
        [id],
      );
      if (rows.rows[0] === undefined) return null;
      if (String(rows.rows[0]['entity']) === 'manifest.kind') await this.catalogueData();
      return this.entityFromRow(rows.rows[0], lang) ?? null;
    }
    const kind = this.kindByRoot.get(field);
    if (kind !== undefined) return this.listOfKind(kind, args as ConnectionArgs, lang);
    if (field === 'catalogueEntity') {
      const value = (await this.catalogueData()).byName.get(typeof args['name'] === 'string' ? args['name'] : '');
      return value === undefined ? null : this.catalogueEntityValue(value, lang);
    }
    if (field === 'allCatalogueEntity') return this.allCatalogue(args as ConnectionArgs, lang);
    if (field === 'home') return this.home(lang);
    if (field === 'search') return this.search(args, lang);
    if (field === 'bootstrap') return this.bootstrap();
    return null;
  }

  /** One page of a kind's vertices, filtered and ordered in SQL over the agreed values; the total is before the cursor. */
  private async listOfKind(kind: PublishedKind, args: ConnectionArgs, lang: string | undefined): Promise<unknown> {
    const sql = new Sql();
    const kindName = sql.param(kind.name, '::text');
    const where = this.vertexWhere(kind, args.where, sql, 'n', lang);
    const order = this.vertexOrder(kind, args.orderBy, sql, 'n', lang);
    const first = clampFirst(args.first);
    const selectOrder = order.keys.map((one) => `${one.expr} AS "order_${String(one.at)}"`).join(', ');
    const afterKeys = order.keys.map((one) => ({ ...one, expr: `"order_${String(one.at)}"` }));
    const after = this.afterClause(afterKeys, args.after, sql, 'node_id::bigint');
    const rankOrder = order.keys.length === 0 ? 'rows.node_id::bigint' : order.keys.map((one) => `rows."order_${String(one.at)}" ${one.direction} NULLS ${one.nulls}`).join(', ');
    const answer = await this.tx.query<Record<string, unknown>>(
      `WITH filtered AS (
         SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity${selectOrder === '' ? '' : `, ${selectOrder}`}
         FROM node n JOIN entity en ON en.id = n.entity_id
         WHERE en.name = ${kindName} AND n.context_id = 1 AND NOT n.removed${where === '' ? '' : ` AND (${where})`}
       ), rows AS (
         SELECT * FROM filtered${after === '' ? '' : ` WHERE ${after}`}
       ), ranked AS (
         SELECT rows.*, row_number() OVER (ORDER BY ${rankOrder}, rows.node_id::bigint) AS rn,
                (SELECT count(*) FROM filtered) AS total
         FROM rows
       )
       SELECT * FROM ranked WHERE rn <= ${sql.param(first + 1, '::int')} ORDER BY rn`,
      sql.params,
    );
    const values = answer.rows.map((row) => this.entityFromRow(row, lang)).filter((one): one is EntityValue => one !== undefined);
    const total = answer.rows.length === 0 ? 0 : Number(answer.rows[0]!['total']);
    const page = values.slice(0, first);
    const cursorOf = (at: number, node: EntityValue): string => encodeCursor({ o: order.keys.map((one) => answer.rows[at]![`order_${String(one.at)}`] ?? null), id: node.nodeId });
    return {
      edges: page.map((node, at) => ({ cursor: cursorOf(at, node), node })),
      pageInfo: { endCursor: page.length === 0 ? null : cursorOf(page.length - 1, page[page.length - 1]!), hasNextPage: values.length > first },
      totalCount: total,
    };
  }

  private async home(lang: string | undefined): Promise<unknown> {
    const kind = homeKind(this.manifest);
    if (kind === undefined) return null;
    const rows = await this.tx.query<Record<string, unknown>>(
      `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity
       FROM node n JOIN entity en ON en.id = n.entity_id WHERE en.name = $1 AND n.context_id = 1 AND NOT n.removed ORDER BY n.id LIMIT 1`,
      [kind.name],
    );
    if (rows.rows[0] === undefined) return null;
    if (String(rows.rows[0]['entity']) === 'manifest.kind') await this.catalogueData();
    return this.entityFromRow(rows.rows[0], lang) ?? null;
  }

  /** Search over labels and text fields, one union of every kind's text; the total is before the cursor. */
  private async search(args: Record<string, unknown>, lang: string | undefined): Promise<unknown> {
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    const wanted = Array.isArray(args['kinds']) ? new Set((args['kinds'] as unknown[]).filter((one): one is string => typeof one === 'string')) : undefined;
    const sql = new Sql();
    const pattern = sql.param(`%${text}%`, '::text');
    const parts: string[] = [];
    for (const kind of this.published.kinds) {
      if (wanted !== undefined && !wanted.has(kind.name) && !wanted.has(typeNameOf(kind.name))) continue;
      const kindParam = sql.param(kind.name, '::text');
      for (const field of kind.fields) {
        if (field.type !== 'text') continue;
        const expr = this.fieldExpr(kind, field, 'n', sql, lang);
        parts.push(`SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity, (${expr})::text AS value
          FROM node n JOIN entity en ON en.id = n.entity_id
          WHERE en.name = ${kindParam} AND n.context_id = 1 AND NOT n.removed AND (${expr})::text ILIKE ${pattern}`);
      }
    }
    if (parts.length === 0) return { edges: [], pageInfo: { endCursor: null, hasNextPage: false }, totalCount: 0 };
    const first = clampFirst(typeof args['first'] === 'number' ? args['first'] : null);
    const cursor = decodeCursor(typeof args['after'] === 'string' ? args['after'] : null) as { k?: string; id?: string } | undefined;
    const after = cursor?.k === undefined ? '' : `WHERE entity > ${sql.param(cursor.k, '::text')} OR (entity = ${sql.param(cursor.k, '::text')} AND node_id::bigint > ${sql.param(cursor.id ?? '0', '::bigint')})`;
    const answer = await this.tx.query<Record<string, unknown>>(
      `WITH hits AS (${parts.join(' UNION ALL ')}), dedup AS (
         SELECT DISTINCT node_id, uid, key, entity FROM hits
       ), rows AS (
         SELECT * FROM dedup${after === '' ? '' : ` ${after}`}
       ), ranked AS (
         SELECT rows.*, row_number() OVER (ORDER BY entity, node_id::bigint) AS rn,
                (SELECT count(*) FROM dedup) AS total
         FROM rows
       )
       SELECT * FROM ranked WHERE rn <= ${sql.param(first + 1, '::int')} ORDER BY rn`,
      sql.params,
    );
    const values = answer.rows.map((row) => this.entityFromRow(row, lang)).filter((one): one is EntityValue => one !== undefined);
    const total = answer.rows.length === 0 ? 0 : Number(answer.rows[0]!['total']);
    const page = values.slice(0, first);
    const cursorOf = (at: number, node: EntityValue): string => encodeCursor({ k: answer.rows[at]!['entity'], id: node.nodeId });
    return {
      edges: page.map((node, at) => ({ cursor: cursorOf(at, node), node })),
      pageInfo: { endCursor: page.length === 0 ? null : cursorOf(page.length - 1, page[page.length - 1]!), hasNextPage: values.length > first },
      totalCount: total,
    };
  }

  private async bootstrap(): Promise<unknown> {
    const home = entityOf(await this.home(undefined));
    return {
      structureRevision: this.structure,
      home: home === undefined ? null : { id: home.uid, kind: home.kind, template: this.templateOf(home, home.kind) },
      catalogueTemplate: this.productTemplates.catalogue,
      templates: this.productTemplates.templates,
      recordTemplates: [...this.productTemplates.records.entries()]
        .map(([kind, template]) => ({ kind, template }))
        .sort((left, right) => byCodePoint(left.kind, right.kind)),
      ownTemplates: [...this.productTemplates.own.entries()]
        .map(([id, template]) => ({ id, template }))
        .sort((left, right) => byCodePoint(left.id, right.id)),
      roles: [...this.manifest.roles.keys()].sort(byCodePoint),
    };
  }

  // ---- catalogue ---------------------------------------------------------------------------------------------

  private async allCatalogue(args: ConnectionArgs, lang: string | undefined): Promise<unknown> {
    const data = await this.catalogueData();
    return this.catalogueConnection([...data.byName.values()], args, lang);
  }

  private async catalogueData(): Promise<{ byName: Map<string, CatalogueValue>; byId: Map<string, CatalogueValue> }> {
    if (this.catalogueRead !== undefined) return this.catalogueRead;
    const byName = new Map<string, CatalogueValue>();
    const byId = new Map<string, CatalogueValue>();
    const kindTable = generatedTableName('manifest.kind', 'vertex');
    const fieldTable = generatedTableName('manifest.field', 'vertex');
    const dependencyTable = generatedTableName('manifest.dependency', 'vertex');
    const kinds = await this.tx.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (n.id) n.id::text AS node_id, n.uid::text AS uid, n.key->>'name' AS name, p.declaration AS declaration
       FROM "${kindTable}" p
       JOIN node n ON n.id = p.node_id
       WHERE p.state = 'open' AND p.context_id = 1 AND split_part(p.said_by, '@', 1) = 'manifest' AND n.context_id = 1 AND NOT n.removed
       ORDER BY n.id, p.id DESC`,
    );
    const fieldRows = await this.tx.query<Record<string, unknown>>(
      `SELECT p.declaration AS declaration FROM "${fieldTable}" p
       JOIN node n ON n.id = p.node_id
       WHERE p.state = 'open' AND p.context_id = 1 AND split_part(p.said_by, '@', 1) = 'manifest' AND n.context_id = 1 AND NOT n.removed`,
    );
    const dependencies = await this.tx.query<Record<string, unknown>>(
      `SELECT p.declaration AS declaration FROM "${dependencyTable}" p
       JOIN node n ON n.id = p.node_id
       WHERE p.state = 'open' AND p.context_id = 1 AND split_part(p.said_by, '@', 1) = 'manifest' AND n.context_id = 1 AND NOT n.removed`,
    );
    const fieldsByKind = new Map<string, CatalogueFieldValue[]>();
    for (const row of fieldRows.rows) {
      const declaration = row['declaration'] as Record<string, unknown> | undefined;
      if (declaration === undefined || typeof declaration['kind'] !== 'string') continue;
      const list = fieldsByKind.get(declaration['kind']) ?? [];
      list.push({
        name: String(declaration['name'] ?? ''),
        type: String(declaration['type'] ?? ''),
        nullable: declaration['nullable'] === true,
        reference: typeof declaration['reference'] === 'string' ? declaration['reference'] : null,
        producers: Array.isArray(declaration['producers']) ? (declaration['producers'] as unknown[]).filter((one): one is string => typeof one === 'string') : [],
      });
      fieldsByKind.set(declaration['kind'], list);
    }
    const derives = new Map<string, string[]>();
    const derivedBy = new Map<string, string[]>();
    for (const row of dependencies.rows) {
      const declaration = row['declaration'] as Record<string, unknown> | undefined;
      if (declaration === undefined || declaration['via'] !== 'derives-from' || declaration['workflow'] !== undefined) continue;
      const from = String(declaration['from'] ?? '');
      const to = String(declaration['to'] ?? '');
      if (from === '' || to === '') continue;
      derives.set(to, [...(derives.get(to) ?? []), from]);
      derivedBy.set(from, [...(derivedBy.get(from) ?? []), to]);
    }
    for (const row of kinds.rows) {
      const name = String(row['name'] ?? '');
      const declaration = (row['declaration'] ?? {}) as Record<string, unknown>;
      const entry = (declaration['catalog'] ?? declaration) as Record<string, unknown>;
      const value: CatalogueValue = {
        nodeId: String(row['node_id']),
        uid: String(row['uid']),
        name,
        entry,
        taken: declaration['taken'] === true,
        plugins: Array.isArray(declaration['plugins']) ? (declaration['plugins'] as unknown[]).filter((one): one is string => typeof one === 'string') : [],
        fields: fieldsByKind.get(name) ?? [],
        derivesFrom: derives.get(name) ?? [],
        derivedBy: derivedBy.get(name) ?? [],
      };
      byName.set(name, value);
      byId.set(value.nodeId, value);
    }
    this.catalogueRead = { byName, byId };
    return this.catalogueRead;
  }

  private async catalogueField(value: CatalogueValue, name: string, args: ConnectionArgs, lang: string | undefined): Promise<unknown> {
    if (name === 'id') return value.uid;
    if (name === 'kind') return 'catalogue';
    if (name === 'label' || name === 'title') return this.catalogueTitle(value, lang);
    if (name === 'template') return this.productTemplates.catalogue;
    if (name === 'contested') return [];
    if (name === 'backlinks') return this.backlinks({ nodeId: value.nodeId, uid: value.uid, kind: 'catalogue', key: {}, typeName: 'CatalogueEntity', catalogue: value }, args);
    if (name === 'outgoing') return this.outgoing({ nodeId: value.nodeId, uid: value.uid, kind: 'catalogue', key: {}, typeName: 'CatalogueEntity', catalogue: value }, args);
    if (name === 'name') return value.name;
    if (name === 'definition') return this.catalogueDefinition(value, lang);
    if (name === 'group') return String(value.entry['area'] ?? '');
    if (name === 'subgroup') return String(value.entry['subgroup'] ?? '');
    if (name === 'purpose') return typeof value.entry['purpose'] === 'string' ? value.entry['purpose'] : null;
    if (name === 'status') return typeof value.entry['status'] === 'string' ? value.entry['status'] : null;
    if (name === 'audience') return Array.isArray(value.entry['audience']) ? value.entry['audience'] : [];
    if (name === 'standards') return Array.isArray(value.entry['sources']) ? value.entry['sources'] : [];
    if (name === 'taken') return value.taken;
    if (name === 'plugins') return value.plugins;
    if (name === 'fields') return value.fields;
    if (name === 'instances') return this.catalogueInstances(value, args, lang);
    if (name === 'derivesFrom') return this.catalogueLinks(value.derivesFrom, args, lang);
    if (name === 'derivedBy') return this.catalogueLinks(value.derivedBy, args, lang);
    const relation = this.relationByType.get('CatalogueEntity')?.get(name);
    if (relation !== undefined) return this.relation({ nodeId: value.nodeId, uid: value.uid, kind: 'catalogue', key: {}, typeName: 'CatalogueEntity', catalogue: value, ...(lang === undefined ? {} : { lang }) }, relation.edge, relation.side, args);
    const inverse = this.referenceInverseByType.get('CatalogueEntity')?.get(name);
    if (inverse !== undefined) return this.referenceInverse({ nodeId: value.nodeId, uid: value.uid, kind: 'catalogue', key: {}, typeName: 'CatalogueEntity', catalogue: value, ...(lang === undefined ? {} : { lang }) }, inverse.source, inverse.field, args);
    return null;
  }

  /** The entity a catalogue entry completes as. */
  private catalogueEntityValue(value: CatalogueValue, lang: string | undefined): EntityValue {
    return { nodeId: value.nodeId, uid: value.uid, kind: 'catalogue', key: {}, typeName: 'CatalogueEntity', catalogue: value, ...(lang === undefined ? {} : { lang }) };
  }

  /** The records of the kind this catalogue entry declares: the entities of that kind, one page of them. */
  private async catalogueInstances(value: CatalogueValue, args: ConnectionArgs, lang: string | undefined): Promise<unknown> {
    const kind = this.published.kinds.find((one) => one.name === value.name);
    if (kind === undefined) return { edges: [], pageInfo: { endCursor: null, hasNextPage: false }, totalCount: 0 };
    return await this.listOfKind(kind, args, lang);
  }

  private async catalogueLinks(names: readonly string[], args: ConnectionArgs, lang: string | undefined): Promise<unknown> {
    const data = await this.catalogueData();
    const values = names.map((name) => data.byName.get(name)).filter((one): one is CatalogueValue => one !== undefined);
    return this.catalogueConnection(values, args, lang);
  }

  private catalogueTitle(value: CatalogueValue, lang: string | undefined): string {
    const labels = value.entry['labels'] as Record<string, { one?: unknown }> | undefined;
    const inLang = labels?.[lang ?? this.lang]?.one;
    if (typeof inLang === 'string' && inLang !== '') return inLang;
    const fallback = labels?.[this.fallbackLang]?.one;
    if (typeof fallback === 'string' && fallback !== '') return fallback;
    return value.name;
  }

  private catalogueDefinition(value: CatalogueValue, lang: string | undefined): string | null {
    const descriptions = (value.entry['descriptions'] ?? value.entry['definitions']) as Record<string, unknown> | undefined;
    const inLang = descriptions?.[lang ?? this.lang];
    if (typeof inLang === 'string' && inLang !== '') return inLang;
    const fallback = descriptions?.[this.fallbackLang];
    if (typeof fallback === 'string' && fallback !== '') return fallback;
    return typeof value.entry['definition'] === 'string' ? value.entry['definition'] : null;
  }

  /** The catalogue's own filter and order, over the entries the graph holds (a bounded set of declarations). */
  private catalogueConnection(values: readonly CatalogueValue[], args: ConnectionArgs, lang: string | undefined): unknown {
    let rows = [...values];
    if (args.where !== undefined && args.where !== null) rows = rows.filter((one) => this.catalogueMatches(one, args.where!));
    const orders = (args.orderBy ?? []).filter((one) => typeof one['field'] === 'string');
    rows.sort((left, right) => {
      for (const order of orders) {
        const field = String(order['field']);
        const compared = compareCatalogue(describeCatalogue(left, field), describeCatalogue(right, field), order['direction'] === 'DESC' ? 'DESC' : 'ASC');
        if (compared !== 0) return compared;
      }
      return Number(left.nodeId) - Number(right.nodeId);
    });
    const first = clampFirst(args.first);
    const cursor = decodeCursor(args.after) as { o?: unknown[]; id?: string } | undefined;
    const after = cursor?.id === undefined ? rows : rows.filter((row) => {
      const values = orders.map((order) => describeCatalogue(row, String(order['field'])));
      const compared = compareCatalogueValues(values, (cursor.o ?? []) as unknown[], orders.map((order) => order['direction'] === 'DESC' ? 'DESC' : 'ASC'));
      // The id is the tie-breaker every list uses: two entries with equal order values still page apart.
      return compared !== 0 ? compared > 0 : Number(row.nodeId) > Number(cursor.id);
    });
    const page = after.slice(0, first);
    const cursorOf = (row: CatalogueValue): string => encodeCursor({ o: orders.map((order) => describeCatalogue(row, String(order['field']))), id: row.nodeId });
    return {
      edges: page.map((one) => ({ cursor: cursorOf(one), node: this.catalogueEntityValue(one, lang) })),
      pageInfo: { endCursor: page.length === 0 ? null : cursorOf(page[page.length - 1]!), hasNextPage: after.length > first },
      totalCount: rows.length,
    };
  }

  private catalogueMatches(value: CatalogueValue, where: Readonly<Record<string, unknown>>): boolean {
    for (const [field, filter] of Object.entries(where)) {
      if (filter === null || typeof filter !== 'object') continue;
      const held = describeCatalogue(value, field);
      for (const [operator, wanted] of Object.entries(filter as Record<string, unknown>)) {
        if (!matchesOperator(held, operator, wanted)) return false;
      }
    }
    return true;
  }

  // ---- SQL over vertices -------------------------------------------------------------------------------------

  /** One field's agreed value as a SQL expression: the vertex's key, or the one value every open opinion states. */
  private fieldExpr(kind: PublishedKind, field: PublishedField, alias: string, sql: Sql, lang: string | undefined): string {
    if (kind.key.includes(field.name)) {
      const raw = `(${alias}.key->>'${field.name}')`;
      switch (field.type) {
        case 'text': return raw;
        case 'integer': return `${raw}::integer`;
        case 'bigint': return `${raw}::bigint`;
        case 'boolean': return `${raw}::boolean`;
        case 'timestamp': return `${raw}::timestamptz`;
        case 'json': return `(${alias}.key->'${field.name}')`;
      }
    }
    const table = this.vertexTable.get(kind.name)!;
    const value = `(array_agg(o."${field.name}") FILTER (WHERE o."${field.name}" IS NOT NULL))[1]`;
    // The same choice the field resolver makes: the reader's language when that field states one there, else the
    // product's, else the opinions that state no language; never a neutral opinion beside a translated one.
    const language = field.type === 'text'
      ? ` AND o.lang IS NOT DISTINCT FROM (CASE
           WHEN EXISTS (SELECT 1 FROM "${table}" y WHERE y.node_id = ${alias}.id AND y.state = 'open' AND y.context_id = 1 AND y."${field.name}" IS NOT NULL AND y.lang = ${sql.param(lang ?? this.lang, '::text')}) THEN ${sql.param(lang ?? this.lang, '::text')}
           WHEN EXISTS (SELECT 1 FROM "${table}" y WHERE y.node_id = ${alias}.id AND y.state = 'open' AND y.context_id = 1 AND y."${field.name}" IS NOT NULL AND y.lang = ${sql.param(this.fallbackLang, '::text')}) THEN ${sql.param(this.fallbackLang, '::text')}
           ELSE NULL END)`
      : '';
    return `(SELECT CASE WHEN count(DISTINCT o."${field.name}") = 1 THEN ${value} END FROM "${table}" o WHERE o.node_id = ${alias}.id AND o.state = 'open' AND o.context_id = 1${language})`;
  }

  /** The `<Type>Where` of one kind, as SQL over the agreed values. */
  private vertexWhere(kind: PublishedKind, where: Readonly<Record<string, unknown>> | undefined, sql: Sql, alias: string, lang: string | undefined): string {
    if (where === undefined || where === null) return '';
    const type = typeNameOf(kind.name);
    const clauses: string[] = [];
    for (const [name, filter] of Object.entries(where)) {
      const field = this.fieldsByType.get(type)?.get(name);
      if (field === undefined || filter === null || typeof filter !== 'object') continue;
      const expr = this.fieldExpr(kind, field, alias, sql, lang);
      for (const [operator, value] of Object.entries(filter as Record<string, unknown>)) {
        const clause = compareClause(expr, field.type, operator, value, sql);
        if (clause !== undefined) clauses.push(clause);
      }
    }
    return clauses.join(' AND ');
  }

  /** The `<Type>Order` of one kind: the agreed value of each named field then the vertex's id. */
  private vertexOrder(kind: PublishedKind, orderBy: readonly Readonly<Record<string, unknown>>[] | undefined, sql: Sql, alias: string, lang: string | undefined): { keys: { at: number; expr: string; direction: 'ASC' | 'DESC'; nulls: 'FIRST' | 'LAST'; type: FieldType }[] } {
    const type = typeNameOf(kind.name);
    const keys: { at: number; expr: string; direction: 'ASC' | 'DESC'; nulls: 'FIRST' | 'LAST'; type: FieldType }[] = [];
    for (const one of orderBy ?? []) {
      const field = this.fieldsByType.get(type)?.get(String(one['field']));
      if (field === undefined) continue;
      keys.push({ at: keys.length, expr: this.fieldExpr(kind, field, alias, sql, lang), direction: one['direction'] === 'DESC' ? 'DESC' : 'ASC', nulls: one['nulls'] === 'FIRST' ? 'FIRST' : 'LAST', type: field.type });
    }
    return { keys };
  }

  /**
   * The keyset condition of an `after` cursor: for every order key its own comparison under the key's nulls rule,
   * each earlier key equal, and the id as the last tie-breaker. A null cursor in `NULLS LAST` order has only null
   * rows after it; in `NULLS FIRST` order every non-null row follows it.
   */
  private afterClause(keys: readonly { expr: string; direction: 'ASC' | 'DESC'; nulls?: 'FIRST' | 'LAST'; type: FieldType }[], after: string | null | undefined, sql: Sql, idExpr: string): string {
    const cursor = decodeCursor(after) as { o?: unknown[]; id?: string } | undefined;
    if (cursor?.o === undefined || !Array.isArray(cursor.o) || cursor.id === undefined) return '';
    const equals: string[] = [];
    const conditions: string[] = [];
    for (const [at, key] of keys.entries()) {
      if (at >= cursor.o.length) break;
      const placeholder = sql.param(cursor.o[at], castOf(key.type));
      const value = key.expr;
      const nulls = key.nulls ?? 'LAST';
      const greater = key.direction === 'ASC' ? `${value} > ${placeholder}` : `${value} < ${placeholder}`;
      let condition: string;
      if (cursor.o[at] === null || cursor.o[at] === undefined) {
        // After a null: in NULLS FIRST order every non-null row follows, and the null rows are the id tie-break's.
        condition = nulls === 'FIRST' ? `(${value} IS NOT NULL)` : 'FALSE';
      } else {
        condition = nulls === 'LAST'
          ? `((${value} IS NOT NULL AND ${greater}) OR ${value} IS NULL)`
          : `(${value} IS NOT NULL AND ${greater})`;
      }
      conditions.push(conditions.length === 0 ? `(${condition})` : `(${equals.join(' AND ')} AND ${condition})`);
      equals.push(`${value} IS NOT DISTINCT FROM ${placeholder}`);
    }
    const id = sql.param(cursor.id, '::bigint');
    const tail = equals.length === 0 ? `${idExpr} > ${id}` : `${equals.join(' AND ')} AND ${idExpr} > ${id}`;
    return `(${[...conditions, tail].join(' OR ')})`;
  }

  /** One entity from a node row, the catalogue's own entries included. */
  private entityFromRow(row: Record<string, unknown>, lang?: string): EntityValue | undefined {
    const nodeId = String(row['node_id']);
    const uid = String(row['uid']);
    const key = row['key'] as Record<string, unknown>;
    const entityName = String(row['entity']);
    if (entityName === 'manifest.kind') {
      const catalogue = this.catalogueRead?.byId.get(nodeId);
      return catalogue === undefined ? undefined : { nodeId, uid, kind: 'catalogue', key, typeName: 'CatalogueEntity', catalogue, ...(lang === undefined ? {} : { lang }) };
    }
    const typeName = typeNameOf(entityName);
    if (!this.kindByType.has(typeName)) return undefined;
    return { nodeId, uid, kind: entityName, key, typeName, ...(lang === undefined ? {} : { lang }) };
  }
}

/** The `<field>Where` operators, as a SQL clause over one expression. */
function compareClause(expr: string, type: FieldType, operator: string, value: unknown, sql: Sql): string | undefined {
  const cast = castOf(type);
  if (operator === '_eq') return `${expr} IS NOT DISTINCT FROM ${sql.param(value, cast)}`;
  if (operator === '_neq') return `${expr} IS DISTINCT FROM ${sql.param(value, cast)}`;
  if (operator === '_in') return Array.isArray(value) ? `${expr} = ANY(${sql.param(value, `${cast}[]`)})` : undefined;
  if (operator === '_nin') return Array.isArray(value) ? `NOT (${expr} = ANY(${sql.param(value, `${cast}[]`)}))` : undefined;
  if (operator === '_contains' && type === 'text') return `(${expr} ILIKE '%' || ${sql.param(value, '::text')} || '%')`;
  if (operator === '_like' && type === 'text') return `(${expr} LIKE ${sql.param(value, '::text')})`;
  if (operator === '_lt') return `${expr} < ${sql.param(value, cast)}`;
  if (operator === '_lte') return `${expr} <= ${sql.param(value, cast)}`;
  if (operator === '_gt') return `${expr} > ${sql.param(value, cast)}`;
  if (operator === '_gte') return `${expr} >= ${sql.param(value, cast)}`;
  if (operator === '_is_null') return value === true ? `${expr} IS NULL` : value === false ? `${expr} IS NOT NULL` : undefined;
  return undefined;
}

/** The value one catalogue field shows to a filter or an order. */
function describeCatalogue(value: CatalogueValue, field: string): unknown {
  switch (field) {
    case 'name': return value.name;
    case 'title': return value.entry['labels'] === undefined ? null : catalogueTitleOf(value);
    case 'definition': return typeof value.entry['definition'] === 'string' ? value.entry['definition'] : null;
    case 'group': return typeof value.entry['area'] === 'string' ? value.entry['area'] : null;
    case 'subgroup': return typeof value.entry['subgroup'] === 'string' ? value.entry['subgroup'] : null;
    case 'purpose': return typeof value.entry['purpose'] === 'string' ? value.entry['purpose'] : null;
    case 'status': return typeof value.entry['status'] === 'string' ? value.entry['status'] : null;
    case 'taken': return value.taken;
    default: return null;
  }
}

/** A catalogue entry's title in English, for a comparison: the reader's language has no meaning in a filter. */
function catalogueTitleOf(value: CatalogueValue): string | null {
  const labels = value.entry['labels'] as Record<string, { one?: unknown }> | undefined;
  const one = labels?.['en']?.one ?? labels?.['ru']?.one;
  return typeof one === 'string' ? one : null;
}

/** The operators a catalogue field takes, in memory. */
function matchesOperator(held: unknown, operator: string, wanted: unknown): boolean {
  if (operator === '_eq') return JSON.stringify(held) === JSON.stringify(wanted ?? null);
  if (operator === '_neq') return JSON.stringify(held) !== JSON.stringify(wanted ?? null);
  if (operator === '_in') return Array.isArray(wanted) && wanted.some((one) => JSON.stringify(one) === JSON.stringify(held));
  if (operator === '_nin') return Array.isArray(wanted) && !wanted.some((one) => JSON.stringify(one) === JSON.stringify(held));
  if (operator === '_contains') return typeof held === 'string' && typeof wanted === 'string' && held.toLowerCase().includes(wanted.toLowerCase());
  if (operator === '_like') {
    if (typeof held !== 'string' || typeof wanted !== 'string') return false;
    const pattern = wanted.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/%/gu, '.*').replace(/_/gu, '.');
    return new RegExp(`^${pattern}$`, 'u').test(held);
  }
  if (operator === '_is_null') return wanted === true ? held === null || held === undefined : held !== null && held !== undefined;
  if (operator === '_lt' || operator === '_lte' || operator === '_gt' || operator === '_gte') {
    if (held === null || wanted === null || held === undefined || wanted === undefined) return false;
    const comparison = typeof held === 'number' && typeof wanted === 'number' ? held - wanted : String(held).localeCompare(String(wanted));
    return operator === '_lt' ? comparison < 0 : operator === '_lte' ? comparison <= 0 : operator === '_gt' ? comparison > 0 : comparison >= 0;
  }
  return false;
}

/** One catalogue order comparison: nulls last, then the direction. */
function compareCatalogue(left: unknown, right: unknown, direction: 'ASC' | 'DESC'): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  const comparison = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
  return direction === 'ASC' ? comparison : -comparison;
}

/** A lexicographic cursor comparison over catalogue order values: at most -1, 0 or 1. */
function compareCatalogueValues(left: readonly unknown[], right: readonly unknown[], directions: readonly ('ASC' | 'DESC')[]): number {
  for (const [at, direction] of directions.entries()) {
    const compared = compareCatalogue(left[at], right[at], direction);
    if (compared !== 0) return compared;
  }
  return 0;
}

/** The empty connection a relation that cannot apply answers. */
function emptyConnection(): unknown {
  return { edges: [], pageInfo: { endCursor: null, hasNextPage: false }, totalCount: 0 };
}
