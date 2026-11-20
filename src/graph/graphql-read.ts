import { productEntityOf } from '../product/manifest.js';
/**
 * The read side of the GraphQL API (decision 0036, sections 2 to 4): one resolver layer over the store, one
 * read-only snapshot per operation, relations and fields batched per level so a list of entities costs a statement
 * per type and per edge and never one per row.
 *
 * **Values are assertions.** Typed per-source histories select the newest active value; disagreement stays visible
 * in `contested` and `<field>Assertions` exposes source, time and evidence. Selectors share the page's snapshot.
 *
 * **References are edges.** A vertex identity contains its own scalar key and declared parent edges. Relations and
 * inverses traverse only selected active edges; no attribute contains another entity's identity.
 *
 * **The catalogue is a graph too.** Every entry the product's start publishes as a `manifest.kind` vertex is a
 * catalogue entity, taken or not; its fields, the plugins that fill it, whether the product takes it and its
 * derivation relations come from those vertices, the manifest's field vertices and real dependency edges.
 */
import type { GraphQLFieldResolver } from 'graphql';
import { z } from 'zod';
import { fits, GraphRefusal } from './validation.js';
import type { OuterTransaction } from '../adapters/database-owner.js';
import { entityKindNames, assertionValueTableName, type FieldType } from '../graph/contract.js';
import { activeExistenceSql, loadAssertions, loadAssertionsBatch, type StoredAssertion } from './assertion-read.js';
import { listDisputeSlots, loadResolutionAssertion, type DisputeSlot } from './dispute-read.js';
import { contextLayers } from './context.js';
import { evidenceSupportRoles } from './evidence-support.js';
import { readEvidenceStates, type EvidenceState } from './evidence-read.js';
import { withAssertionContract } from './system-contract.js';
import { graphContractOf } from '../fill/stages/plugin-contract.js';
import { withSpan } from '../obs/trace.js';
import { byCodePoint } from '../model/order.js';
import { fileTextKind, homeKind, type KindsManifest } from '../product/manifest/kinds.js';
import { fieldNameOf, kindTypeNameOf, typeNameOf } from '../graphql/names.js';
import { publishedRelationWords, type PublishedEdge, type PublishedField, type PublishedKind, type PublishedManifest } from '../graphql/manifest.js';
import type { ProductTemplates } from './product-templates.js';
import { withManifestContract, MANIFEST_DEPENDS_ON, MANIFEST_RELATION_EDGE } from './manifest-contract.js';
import { join } from 'node:path';
import { catalogueFileTextRole } from '../knowledge/file-text-kind.js';
import { checkProductTemplates } from './template-check.js';
import type { TemplateFile } from '../page-contract/template.js';
import type { TemplateFinding } from '../page-contract/validate.js';

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
  readonly producers: readonly string[];
}

/** One aggregate a resolver answers lazily: the kind it counts, the filter over its agreed values and the reader language. */
interface AggregateValue {
  readonly kind: PublishedKind;
  readonly where: Readonly<Record<string, unknown>> | undefined;
  readonly lang: string | undefined;
  readonly __aggregate: true;
}

/** Whether the source is one of the aggregate objects the resolver answers field by field. */
function aggregateOf(source: unknown): AggregateValue | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const held = source as Partial<AggregateValue>;
  return held.__aggregate === true && held.kind !== undefined ? held as AggregateValue : undefined;
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

/** One parent's edge rows and their assertions, held for the connection that reads them. */
interface EdgeBatch {
  readonly rows: EdgeRow[];
  readonly total: number;
  readonly assertions: Map<string, StoredAssertion[]>;
}

/** The line a search row is shown by: the label, and the matched text beside it when the label is a hash. */
export function searchLine(label: string, value: string): string {
  const short = /^[0-9a-f]{7,64}$/u.test(label) ? label.slice(0, 7) : label;
  if (value === '' || value === label) return short;
  const first = value.split('\n')[0]!.trim();
  const cut = first.length > 90 ? `${first.slice(0, 90).replace(/\s+\S*$/u, '')}…` : first;
  return `${short} — ${cut}`;
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
  if (value === null || value === undefined) return undefined;
  try {
    if (value === '' || [...value].some(char => !'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'.includes(char))) throw new Error();
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
    const cursor = decoded as Record<string, unknown>;
    if (typeof cursor['id'] !== 'string' || cursor['id'] === '' || cursor['id'].startsWith('0') || [...cursor['id']].some(char => char < '0' || char > '9')) throw new Error();
    const keys = Object.keys(cursor);
    if (Array.isArray(cursor['o']) && keys.every(key => key === 'o' || key === 'id')) return cursor;
    if (typeof cursor['relation'] === 'string' && keys.every(key => key === 'relation' || key === 'id')) return cursor;
    throw new Error();
  } catch { throw new GraphRefusal('/after', 'cursor returned by this connection', value); }
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, path: string): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new GraphRefusal(path, `integer from ${min} to ${max}`, value);
  return value;
}

/** The page's size: 50 by default, at most 200. */
function clampFirst(first: number | null | undefined): number {
  return boundedInteger(first, 50, 0, 200, '/first');
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
/** One group of an entity's neighbours, read and counted in one statement: its relation, its kind and how many. */
export interface DiagramGroup {
  /** The edge kind the rows were read through (`code.contains`), and the direction they came from. */
  readonly relation: string;
  readonly side: 'in' | 'out';
  /** Metadata arrows keep the declaration's direction, even when the root is their target. */
  readonly canonicalLabel?: boolean;
  /** The product graph's words in the requested language and reading direction. */
  readonly label?: string;
  readonly kind: string;
  /** How many neighbours the group holds, of which at most `first` were read. */
  readonly total: number;
  /** The uids of the rows read for the group, when the group is within the fold bound. */
  readonly nodes: readonly string[];
}

export interface DiagramNeighbourhood {
  readonly entity: EntityValue;
  readonly nodes: ReadonlyMap<string, EntityValue>;
  readonly links: readonly DiagramLink[];
  /** Each entity's label, as the field resolver answers it. */
  readonly labels: ReadonlyMap<string, string>;
  /** The neighbour groups, counted in the query: a group above the fold is drawn as one node with its count. */
  readonly groups: readonly DiagramGroup[];
  /** Each kind's word in the reader's language, for the folded node's label. */
  readonly kindWords: ReadonlyMap<string, string>;
  /** Each kind's catalogue page, for the folded node's press (the list of the entities it stands for). */
  readonly kindPages: ReadonlyMap<string, string>;
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
  private readonly titles = new Map<string, string>();
  private readonly validAt: string;
  private readonly recordedAt: string;
  private contexts: readonly number[];
  private layersReady: Promise<void> | undefined;
  private disputeSlots: readonly DisputeSlot[] = [];
  private contextRecordedThrough: Readonly<Record<number, string | null>> = {};
  private static readonly scopes = new WeakMap<object, ReadContext>();
  private readonly lang: string;
  private readonly fallbackLang: string;

  /** Per kind and node: the columns fetched for that node and its open assertions. */
  private readonly fieldCache = new Map<string, Map<string, { columns: Set<string>; rows: StoredAssertion[] }>>();
  private fieldQueue: Map<string, Map<string, Set<string>>> | undefined;
  private fieldFlush: Promise<void> | undefined;

  private readonly edgeCache = new Map<string, Map<string, EdgeBatch>>();
  private edgeQueue: Map<string, { edge: PublishedEdge; side: 'from' | 'to'; ids: Set<string>; args: ConnectionArgs; lang?: string }> | undefined;
  private edgeFlush: Promise<void> | undefined;
  private readonly edgeAssertions = new Map<string, StoredAssertion[]>();

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
    /** The template files and their own findings, read from the graph: the page's diagnostics are drawn from these. */
    private readonly templateFiles: readonly TemplateFile[] = [],
    private readonly templateBodies: ReadonlyMap<string, string> = new Map(),
    private readonly templateFindings: readonly TemplateFinding[] = [],
    /**
     * The read of one file's text by the blob the graph names (decision 0037), given by the role that answers it: the api
     * role asks the store's queue, and a read that has no reader answers null.
     */
    private readonly readText?: (ask: { readonly repository: string; readonly path: string; readonly blob: string; readonly moved: boolean; readonly from: number; readonly to?: number; readonly fromColumn?: number }) => Promise<Record<string, unknown> | undefined>,
    /** One page of every log the product keeps, when the caller can read them (the logs page's own evidence). */
    private readonly logs?: (asked: Readonly<Record<string, unknown>>) => unknown,
    selectors: { readonly context?: number; readonly validAt?: string; readonly recordedAt?: string } = {},
  ) {
    this.validAt = selectors.validAt ?? new Date().toISOString();
    this.recordedAt = selectors.recordedAt ?? new Date().toISOString();
    this.contexts = [selectors.context ?? 1];
    this.published = published;
    this.lang = lang ?? manifest.language ?? 'en';
    this.fallbackLang = manifest.language ?? 'en';
    for (const kind of published.kinds) {
      if (kind.name === 'manifest.kind') continue;
      const type = kindTypeNameOf(kind.name);
      this.kindByType.set(type, kind);
      this.kindByRoot.set(`all${typeNameOf(kind.name)}`, kind);
      this.fieldsByType.set(type, new Map(kind.fields.map((field) => [fieldNameOf(field.name), field])));
      const title = manifest.kinds.get(kind.name)?.title;
      if (title !== undefined) this.titles.set(kind.name, title);
    }
    const everyType = ['CatalogueEntity', ...entityKindNames(published.kinds).map(typeNameOf)];
    for (const edge of published.edges) {
      // An `any` end stands on the Entity interface: the field answers on every entity, the catalogue's too.
      for (const from of edge.from) {
        for (const type of from === 'any' ? everyType : [from === 'manifest.kind' ? 'CatalogueEntity' : kindTypeNameOf(from)]) {
          const held = this.relationByType.get(type) ?? new Map<string, { edge: PublishedEdge; side: 'from' | 'to' }>();
          held.set(fieldNameOf(edge.name), { edge, side: 'from' });
          this.relationByType.set(type, held);
        }
      }
      for (const to of edge.to) {
        for (const type of to === 'any' ? everyType : [to === 'manifest.kind' ? 'CatalogueEntity' : kindTypeNameOf(to)]) {
          const held = this.relationByType.get(type) ?? new Map<string, { edge: PublishedEdge; side: 'from' | 'to' }>();
          held.set(`${fieldNameOf(edge.name)}Of`, { edge, side: 'to' });
          this.relationByType.set(type, held);
        }
      }
    }

  }

  /** The GraphQL resolver of one field, over whatever the parent is. */
  readonly resolve: GraphQLFieldResolver<unknown, ReadContext> = async (source, args, _context, info) => await withSpan('graph.graphql.read', { 'graphql.field': info.fieldName }, async () => {
    if (args['after'] !== undefined && args['after'] !== null) decodeCursor(args['after'] as string);
    if (args['first'] !== undefined) clampFirst(args['first'] as number);
    if (info.parentType.name === 'Query') {
      if (args['id'] !== undefined && !z.uuid().safeParse(args['id']).success) throw new GraphRefusal('/id', 'entity UUID', args['id']);
      for (const key of ['edge', 'through']) {
        if (args[key] !== undefined && !this.published.edges.some(edge => edge.name === args[key])) throw new GraphRefusal(`/${key}`, 'declared edge kind', args[key]);
      }
      if (Array.isArray(args['kinds'])) for (const [at, name] of (args['kinds'] as unknown[]).entries()) {
        if (!this.published.kinds.some(kind => kind.name === name || kindTypeNameOf(kind.name) === name)) throw new GraphRefusal(`/kinds/${at}`, 'declared kind', name);
      }
    }
    const scoped = source !== null && typeof source === 'object' ? ReadContext.scopes.get(source) : undefined;
    if (scoped !== undefined && scoped !== this) return await scoped.resolve(source, args, _context, info);
    let value: unknown;
    if (info.parentType.name === 'Query') {
      if (args['context'] !== undefined || args['validAt'] !== undefined || args['recordedAt'] !== undefined) {
        const selected = new ReadContext(this.tx, this.manifest, this.published, this.folder, this.lang, this.structure, this.productTemplates, this.templateFiles, this.templateBodies, this.templateFindings, this.readText, this.logs, {
          context: args['context'] as number | undefined,
          validAt: args['validAt'] === undefined ? this.validAt : String(args['validAt']),
          recordedAt: args['recordedAt'] === undefined ? this.recordedAt : String(args['recordedAt']),
        });
        await selected.contextLayers();
        return selected.scope(await selected.root(info.fieldName, args as Record<string, unknown>));
      }
      this.layersReady ??= this.contextLayers();
      await this.layersReady;
      value = await this.root(info.fieldName, args as Record<string, unknown>);
    } else {
      const aggregate = aggregateOf(source);
      const entity = entityOf(source);
      const edge = edgeOf(source);
      if (aggregate !== undefined) value = await this.aggregateField(aggregate, info.fieldName, args as Record<string, unknown>);
      else if (entity !== undefined) value = await this.entityField(entity, info.fieldName, args as ConnectionArgs);
      else if (edge !== undefined) value = await this.edgeField(edge, info.fieldName);
      else if (source !== null && typeof source === 'object') value = (source as Record<string, unknown>)[info.fieldName] ?? null;
      else value = null;
    }
    return this.scope(value);
  });

  /** Root selectors stay attached to every asynchronously resolved child of that root. */
  private scope(value: unknown): unknown {
    if (value !== null && typeof value === 'object') {
      ReadContext.scopes.set(value, this);
      for (const child of Object.values(value)) this.scope(child);
    }
    return value;
  }

  // ---- fields ------------------------------------------------------------------------------------------------

  private async entityField(entity: EntityValue, name: string, args: ConnectionArgs): Promise<unknown> {
    if (entity.catalogue !== undefined) return this.catalogueField(entity.catalogue, name, args, entity.lang);
    if (name === 'id') return entity.uid;
    if (name === 'kind') return entity.kind;
    if (name === 'label') return this.labelOf(entity);
    if (name === 'template') return this.templateOf(entity, entity.kind);
    if (name === 'contested') return this.contestedOf(entity);
    if (name === 'details') return this.detailsOf(entity);
    if (name === 'trail') return this.trailOf(entity);
    if (name === 'origin') return this.originOf(entity);
    if (name === 'backlinks') return this.backlinks(entity, args);
    if (name === 'outgoing') return this.outgoing(entity, args);
    if (name === 'related') return this.related({ ...args, id: entity.uid }, entity.lang);
    const field = this.fieldsByType.get(entity.typeName)?.get(name);
    if (field !== undefined) {
      const read = await this.fieldRead(entity, field);
      return read.value;
    }
    if (name.endsWith('Assertions')) {
      const held = this.fieldsByType.get(entity.typeName)?.get(name.slice(0, -'Assertions'.length));
      if (held !== undefined) return await this.fieldAssertions(entity, held);
    }
    const relation = this.relationByType.get(entity.typeName)?.get(name);
    if (relation !== undefined) return this.relation(entity, relation.edge, relation.side, args);
    return null;
  }

  private async labelOf(entity: EntityValue): Promise<string> {
    if (entity.catalogue !== undefined) return this.catalogueTitle(entity.catalogue, entity.lang);
    if (entity.kind === 'manifest.kind') {
      const catalogue = this.catalogueRead?.byId.get(entity.nodeId);
      if (catalogue !== undefined) return this.catalogueTitle(catalogue, entity.lang);
    }
    // The label is the field the manifest's `title:` names (decision 0036, section 1): a key field answers its own
    // value, any other field its agreed opinion. A kind that names no title is labelled by the first text of its key.
    const title = this.titles.get(entity.kind);
    const typeFields = this.fieldsByType.get(entity.typeName);
    const field = title === undefined ? undefined : typeFields?.get(fieldNameOf(title));
    if (field !== undefined) {
      const read = await this.fieldRead(entity, field);
      if (typeof read.value === 'string' && read.value !== '') return read.value;
      if (read.value !== null && read.value !== undefined) return String(read.value);
    }
    const kind = this.kindByType.get(entity.typeName);
    for (const name of kind?.key ?? []) {
      const keyField = typeFields?.get(fieldNameOf(name));
      if (keyField?.type !== 'text') continue;
      const read = await this.fieldRead(entity, keyField);
      if (typeof read.value === 'string' && read.value !== '') return read.value;
    }
    return entity.uid;
  }

  /**
   * The page template an entity opens with (decision 0036, section 6): its own template, else its kind's record template,
   * else the base `entity`; a catalogue entity's page is the product's catalogue template.
   */
  private templateOf(entity: EntityValue | undefined, kind: string): string {
    if (entity?.catalogue !== undefined) return this.productTemplates.catalogue;
    const own = entity === undefined ? undefined : this.productTemplates.own.get(entity.uid);
    if (own !== undefined) return own;
    // The home entity opens `home`, the product's own page: `/` is the page the home entity's template draws.
    if (entity !== undefined && homeKind(this.manifest)?.name === kind && this.productTemplates.templates.some((one) => one.name === 'home')) return 'home';
    return this.productTemplates.records.get(kind) ?? 'entity';
  }

  private async detailsOf(entity: EntityValue): Promise<unknown[]> {
    const kind = this.kindByType.get(entity.typeName);
    if (kind === undefined) return [];
    return await Promise.all([...kind.fields].sort((a, b) => byCodePoint(a.name, b.name)).map(async field => {
      const read = await this.fieldRead(entity, field);
      return { name: field.name, type: field.type, key: kind.key.includes(field.name), value: read.value,
        contested: (await this.contestedOf(entity)).includes(fieldNameOf(field.name)), assertions: await this.fieldAssertions(entity, field) };
    }));
  }

  private async originOf(entity: EntityValue): Promise<string | null> {
    const kind = this.kindByType.get(entity.typeName);
    if (kind === undefined) return null;
    await this.ensureFields(kind.name, entity.nodeId, kind.fields.map(field => field.name));
    const selected = kind.fields.flatMap(field => {
      const chosen = this.selection(this.chosenAssertions(kind.name, entity.nodeId, field, entity.lang)).selected;
      return chosen === null ? [] : this.chosenAssertions(kind.name, entity.nodeId, field, entity.lang).filter(row => row.id === chosen.id);
    }).sort((a, b) => a.recordedSequence === b.recordedSequence ? byCodePoint(a.id, b.id) : a.recordedSequence > b.recordedSequence ? -1 : 1);
    for (const assertion of selected) {
      const evidence = await this.assertionEvidence(assertion);
      const first = evidence[0];
      if (first === undefined) continue;
      const row = await this.metadataEntityRow(first.uid);
      const target = row === null ? undefined : this.entityFromRow(row, entity.lang);
      if (target !== undefined) return await this.labelOf(target);
    }
    return null;
  }

  private async trailOf(entity: EntityValue): Promise<EntityValue[]> {
    const chain: EntityValue[] = [];
    const seen = new Set([entity.nodeId]);
    let current = entity;
    for (let depth = 0; depth < 8; depth += 1) {
      const declaration = this.manifest.kinds.get(current.kind);
      const parent = declaration?.keyEdges?.[0];
      if (parent === undefined) break;
      const edge = this.published.edges.find(edge => edge.name === parent.edge);
      if (edge === undefined) break;
      const connection = await this.relation(current, edge, parent.direction, { first: 1 }) as { edges: { node: EdgeRow }[] };
      const next = connection.edges[0]?.node.node;
      if (next === undefined || seen.has(next.nodeId)) break;
      chain.push(next);
      seen.add(next.nodeId);
      current = next;
    }
    return chain.reverse();
  }

  private resolutionAssertionIds: readonly string[] = [];
  private hasMerges=false;
  private async contextLayers(): Promise<void> {
    return await withSpan('graph.context.layers', {}, async () => {
      this.hasMerges=(await this.tx.query<{present:boolean}>(`SELECT EXISTS(SELECT 1 FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.merge') AS present`)).rows[0]!.present;
      const layers = await contextLayers(this.tx, String(this.contexts[0]));
      this.contexts = layers.map((layer) => Number(layer.id));
      this.contextRecordedThrough = Object.fromEntries(layers.map((layer) => [Number(layer.id), layer.recordedThrough]));
      this.disputeSlots = await listDisputeSlots(this.tx, withAssertionContract(withManifestContract(graphContractOf(this.manifest))), {
        validAt: this.validAt, recordedAt: this.recordedAt, contexts: this.contexts, contextRecordedThrough: this.contextRecordedThrough,
      });
      this.resolutionAssertionIds = this.disputeSlots.flatMap(slot => slot.dispute.selectedAssertionUid === null ? [] : [slot.dispute.selectedAssertionUid]);
    });
  }

  private effectiveEdges():string {
    if(!this.hasMerges)return 'edge';
    return `graph_effective_edges(${this.contexts[0]},'${this.validAt}'::timestamptz,'${this.recordedAt}'::timestamptz)`;
  }
  private canonicalNode(id:string):string {
    if(!this.hasMerges)return id;
    return `graph_merge_target(${id},${this.contexts[0]},'${this.validAt}'::timestamptz,'${this.recordedAt}'::timestamptz)`;
  }
  private active(sort: 'vertex' | 'edge', alias: string): string {
    const contract = withAssertionContract(withManifestContract(graphContractOf(this.manifest)));
    const structural = contract.edge.filter((kind) => kind.capability === 'system').map((kind) => kind.name);
    return (sort==='vertex'&&this.hasMerges?`${this.canonicalNode(alias+'.id')}=${alias}.id AND `:'')+activeExistenceSql(sort, alias, contract[sort].map((kind) => kind.name), { validAt: this.validAt, recordedAt: this.recordedAt, contexts: this.contexts, contextRecordedThrough: this.contextRecordedThrough, resolvedAssertionIds: this.resolutionAssertionIds, projectMergedSubjects: this.hasMerges }, sort === 'edge' ? structural : []);
  }

  private selection(rows: readonly StoredAssertion[]) {
    const selected = rows.find(row => row.selected) ?? null;
    const candidates = rows.filter(row => row.active);
    const ids = new Set(rows.map(row => row.id));
    const contested = this.disputeSlots.some(slot => slot.dispute.state === 'OPEN' && slot.rows.some(row => ids.has(row.id)));
    const resolved = candidates.find(row => this.resolutionAssertionIds.includes(row.id));
    return { selected: resolved ?? selected, candidates, contested: resolved === undefined && contested };
  }

  private async contestedOf(entity: EntityValue): Promise<string[]> {
    const kind = this.kindByType.get(entity.typeName);
    if (kind === undefined) return [];
    const fields = kind.fields;
    await this.ensureFields(kind.name, entity.nodeId, fields.map((field) => field.name));
    return fields.filter((field) => this.selection(this.chosenAssertions(kind.name, entity.nodeId, field, entity.lang)).contested).map((field) => fieldNameOf(field.name));
  }

  private async fieldRead(entity: EntityValue, field: PublishedField): Promise<{ value: unknown; count: number }> {
    const kind = this.kindByType.get(entity.typeName);
    if (kind === undefined) return { value: null, count: 0 };
    await this.ensureFields(kind.name, entity.nodeId, [field.name]);
    const selected = this.selection(this.chosenAssertions(kind.name, entity.nodeId, field, entity.lang));
    return { value: selected.selected?.value ?? null, count: selected.candidates.length };
  }

  private async fieldAssertions(entity: EntityValue, field: PublishedField): Promise<unknown[]> {
    const kind = this.kindByType.get(entity.typeName);
    if (kind === undefined) return [];
    await this.ensureFields(kind.name, entity.nodeId, [field.name]);
    const rows = this.chosenAssertions(kind.name, entity.nodeId, field, entity.lang).filter((row) => this.contexts.includes(row.context) && Date.parse(row.recordedAt) <= Date.parse(this.recordedAt) && (this.contextRecordedThrough[row.context] == null || row.recordedSequence <= BigInt(this.contextRecordedThrough[row.context]!)));
    const selected = this.selection(rows).selected;
    return await Promise.all(rows.sort((left, right) => left.recordedSequence === right.recordedSequence ? byCodePoint(right.id, left.id) : left.recordedSequence > right.recordedSequence ? -1 : 1).map((row) => this.assertionValue(row, selected?.id === row.id, entity.lang)));
  }

  private chosenAssertions(kind: string, nodeId: string, field: PublishedField, lang: string | undefined): StoredAssertion[] {
    return this.languageAssertions((this.fieldCache.get(kind)?.get(nodeId)?.rows ?? []).filter((row) => row.property === field.name), field.type, lang);
  }

  private languageAssertions(rows: readonly StoredAssertion[], type: FieldType, lang: string | undefined): StoredAssertion[] {
    if (type !== 'text') return [...rows];
    for (const language of [lang ?? this.lang, this.fallbackLang, null]) {
      const held = rows.filter((row) => row.language === language);
      if (this.selection(held).candidates.length > 0) return held;
    }
    return [];
  }

  private readonly evidenceCache = new Map<string, { uid: string; relation: string; locator: Record<string, unknown>; state: EvidenceState }[]>();
  private readonly evidenceQueue = new Map<string, StoredAssertion>();
  private evidenceFlush: Promise<void> | undefined;

  private async assertionEvidence(row: StoredAssertion) {
    if (!this.evidenceCache.has(row.id)) {
      this.evidenceQueue.set(row.id, row);
      this.evidenceFlush ??= Promise.resolve().then(async () => {
        const rows = new Map(this.evidenceQueue);
        this.evidenceQueue.clear();
        this.evidenceFlush = undefined;
        const links = await withSpan('graph.assertion.evidence', {}, async () => await this.tx.query<{ assertion_uid: string; uid: string; discriminator: string }>(
          `SELECT assertion.uid::text AS assertion_uid,target.uid::text AS uid,lineage.discriminator FROM edge lineage
           JOIN entity kind ON kind.id=lineage.entity_id AND kind.name='system.assertion-evidence'
           JOIN node assertion ON assertion.id=lineage.from_node JOIN node target ON target.id=lineage.to_node
           WHERE assertion.uid=ANY($1::uuid[]) ORDER BY lineage.discriminator COLLATE "C"`, [[...rows.keys()]]));
        const evidence = links.rows.map(link => ({ ...link, ...JSON.parse(link.discriminator) as { relation: string; locator: Record<string, unknown> } }));
        const states = await readEvidenceStates(this.tx, withAssertionContract(withManifestContract(graphContractOf(this.manifest))),
          evidence.map(link => ({ targetUid: link.uid, locator: link.locator, assertion: rows.get(link.assertion_uid)! })),
          { validAt: this.validAt, recordedAt: this.recordedAt, contexts: this.contexts, contextRecordedThrough: this.contextRecordedThrough }, evidenceSupportRoles(this.manifest.semanticBindings));
        for (const id of rows.keys()) this.evidenceCache.set(id, []);
        evidence.forEach((link, index) => this.evidenceCache.get(link.assertion_uid)!.push({ uid: link.uid, relation: link.relation, locator: link.locator, state: states[index]! }));
      });
      await this.evidenceFlush;
    }
    return this.evidenceCache.get(row.id)!;
  }

  private readonly entityRows = new Map<string, Promise<Record<string, unknown> | null>>();
  private readonly entityQueue = new Map<string, { resolve: (row: Record<string, unknown> | null) => void; reject: (error: unknown) => void }>();
  private entityFlush: Promise<void> | undefined;

  private metadataEntityRow(uid: string): Promise<Record<string, unknown> | null> {
    let pending = this.entityRows.get(uid);
    if (pending === undefined) {
      pending = new Promise((resolve, reject) => this.entityQueue.set(uid, { resolve, reject }));
      this.entityRows.set(uid, pending);
      this.entityFlush ??= Promise.resolve().then(async () => {
        const queue = new Map(this.entityQueue);
        this.entityQueue.clear();
        this.entityFlush = undefined;
        try {
          const result = await withSpan('graph.entity.batch', {}, async () => await this.tx.query<Record<string, unknown>>(
            `SELECT alias.uid::text AS requested_uid,n.id::text AS node_id,n.uid::text AS uid,n.key,en.name AS entity
             FROM node alias JOIN node n ON n.id=${this.canonicalNode('alias.id')} JOIN entity en ON en.id=n.entity_id WHERE alias.uid=ANY($1::uuid[]) AND ${this.active('vertex', 'n')}`, [[...queue.keys()]]));
          const rows = new Map(result.rows.map(row => [String(row['requested_uid']), row]));
          for (const [id, pending] of queue) pending.resolve(rows.get(id) ?? null);
        } catch (error) {
          for (const pending of queue.values()) pending.reject(error);
        }
      });
    }
    return pending;
  }

  private async assertionValue(row: StoredAssertion, selected: boolean, lang: string | undefined, includeQuestion = true): Promise<unknown> {
    const evidencePromise = this.assertionEvidence(row);
    const entity = async (uid: string) => await this.root('entity', { id: uid, lang });
    const subject = row.subject.type === 'vertex'
      ? { __typename: 'VertexIdentity', id: row.subject.uid, entity: await entity(row.subject.uid) }
      : { __typename: 'GraphEdge', id: row.subject.id, kind: row.subject.kind, from: await entity(row.subject.from), to: await entity(row.subject.to) };
    return { id: row.id, subject, property: row.property, value: row.value,
      operation: row.operation.toUpperCase(), source: await entity(row.source), author: await entity(row.author),
      unit: row.unit === null ? null : await entity(row.unit), validFrom: row.validFrom, validTo: row.validTo,
      recordedAt: row.recordedAt, evidence: await Promise.all((await evidencePromise).map(async evidence => ({
        targetUid: evidence.uid, target: await entity(evidence.uid), relation: evidence.relation, locator: evidence.locator,
        historicalValidity: evidence.state.historicalValidity.toUpperCase(), currentApplicability: evidence.state.currentApplicability.toUpperCase(), availability: evidence.state.availability.toUpperCase(), issues: evidence.state.issues,
      }))),
      selected, question: includeQuestion ? await this.assertionQuestion(row, lang) : null };
  }

  private readonly resolutionAssertions = new Map<string, Promise<StoredAssertion | null>>();

  private async assertionQuestion(row: StoredAssertion, lang: string | undefined): Promise<unknown> {
    const slot = this.disputeSlots.find(slot => slot.rows.some(candidate => candidate.id === row.id));
    if (slot === undefined) return null;
    const { dispute } = slot;
    const contract = withAssertionContract(withManifestContract(graphContractOf(this.manifest)));
    const selectors = { validAt: this.validAt, recordedAt: this.recordedAt, contexts: this.contexts, contextRecordedThrough: this.contextRecordedThrough };
    const resolution = async (uid: string) => {
      let pending = this.resolutionAssertions.get(uid);
      if (pending === undefined) {
        pending = loadResolutionAssertion(this.tx, contract, uid, slot.rows, selectors);
        this.resolutionAssertions.set(uid, pending);
      }
      const assertion = await pending;
      if (assertion === null) throw new Error(`${import.meta.path}:1: dispute resolution ${uid} has no visible assertion lineage`);
      return await this.assertionValue(assertion, uid === dispute.resolution, lang, false);
    };
    return { id: dispute.id, state: dispute.state,
      candidates: await Promise.all(dispute.candidates.map(id => this.assertionValue(slot.rows.find(candidate => candidate.id === id)!, id === dispute.selectedAssertionUid, lang, false))),
      resolution: dispute.resolution === null ? null : await resolution(dispute.resolution),
      supersededResolutions: await Promise.all(dispute.supersededResolutions.map(resolution)),
    };
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
    const requests = [...queue].map(([kind, nodes]) => {
      const cache = this.fieldCache.get(kind) ?? new Map<string, { columns: Set<string>; rows: StoredAssertion[] }>();
      const declared = this.kindByType.get(kindTypeNameOf(kind));
      if (declared === undefined) throw new Error(`Cannot read fields of undeclared kind: ${kind}`);
      const wanted = new Set<string>();
      for (const [id, columns] of nodes) {
        const held = cache.get(id);
        for (const column of columns) wanted.add(column);
        // A node fetched again keeps every column it was fetched with: the statement replaces its rows.
        for (const column of held?.columns ?? []) wanted.add(column);
      }
      return { kind, nodes, cache, wanted, declared };
    });
    const batches = await loadAssertionsBatch(this.tx, requests.map(({ kind, nodes, wanted, declared }) => ({ sort: 'vertex', kind, properties: [...wanted], subjectIds: [...nodes.keys()].map(Number), unprojectedProperties: declared.key })), { validAt: this.validAt, recordedAt: this.recordedAt, contexts: this.contexts, contextRecordedThrough: this.contextRecordedThrough, projectMergedSubjects: this.hasMerges, resolvedAssertionIds: this.resolutionAssertionIds });
    for (const [index, { kind, nodes, cache, wanted, declared }] of requests.entries()) {
      const rows = batches[index]!;
      const byId = new Map<string, StoredAssertion[]>();
      for (const id of nodes.keys()) byId.set(id, []);
      for (const row of rows) if(!declared.key.includes(row.property)||row.originalSubjectId===row.subjectId)byId.get(String(row.subjectId))?.push(row);
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
      relationLabel: this.relationWord(edge.name, parent.lang, side === 'to'),
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
      const order = this.edgeOrder(edge, args.orderBy);
      const afterKeys = order.keys.map((one) => ({ ...one, expr: `"${one.column}"` }));
      const after = this.afterClause(afterKeys, args.after, sql, 'id');
      const rankOrder = order.keys.length === 0 ? 'rows.id' : order.keys.map((one) => one.rank).join(', ');
      const answer = await withSpan('graph.edge.batch', {}, async () => await this.tx.query<Record<string, unknown>>(
        `WITH filtered AS (
           SELECT ${parentColumn}::text AS parent, e.id, e.discriminator, n2.id::text AS other_id, n2.uid::text AS other_uid,
                  n2.key AS other_key, en2.name AS other_entity${projections === '' ? '' : `, ${projections}`}
           FROM ${this.effectiveEdges()} e
           JOIN entity en ON en.id = e.entity_id AND en.name = ${kindName}
           JOIN node n2 ON n2.id = ${otherColumn} AND ${this.active('vertex', 'n2')}
           JOIN entity en2 ON en2.id = n2.entity_id
           WHERE ${parentColumn} = ANY(${parents}) AND ${this.active('edge', 'e')}${where === '' ? '' : ` AND (${where})`}
         ), counted AS (
           SELECT filtered.*, count(*) OVER (PARTITION BY parent) AS total FROM filtered
         ), rows AS (
           SELECT * FROM counted${after === '' ? '' : ` WHERE ${after}`}
         ), ranked AS (
           SELECT rows.*, row_number() OVER (PARTITION BY parent ORDER BY ${rankOrder}, rows.id) AS rn FROM rows
         )
         SELECT * FROM ranked WHERE rn <= ${sql.param(first + 1, '::int')} ORDER BY parent, rn`,
        sql.params,
      ));
      const opinionRows = await this.fetchEdgeAssertions(edge, [...new Set(answer.rows.map((row) => String(row['id'])))]);
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
        const heldBatch = batches.get(parent) ?? { rows: [], total: Number(row['total']), assertions: opinionRows };
        heldBatch.rows.push({ edgeId: String(row['id']), discriminator: String(row['discriminator']), node, values, cursor: encodeCursor({ o: orderValues, id: String(row['id']) }), ...(lang === undefined ? {} : { lang }) });
        batches.set(parent, heldBatch);
      }
      const loaded = new Map<string, EdgeBatch>();
      for (const parent of ids) loaded.set(parent, batches.get(parent) ?? { rows: [], total: 0, assertions: opinionRows });
      this.edgeCache.set(key, loaded);
    }
  }

  /** One edge attribute's agreed value in the reader's language, the newest opinion of each producer counted once. */
  private edgeValueExpr(edge: PublishedEdge, field: PublishedField, sql: Sql, lang: string | undefined): string {
    return this.assertionExpr('edge', edge.name, field, 'e', sql, lang);
  }

  /** Same typed stream selection as the field resolver, for filters, sorts and aggregates. */
  private assertionExpr(sort: 'vertex' | 'edge', kind: string, field: PublishedField, alias: string, sql: Sql, lang: string | undefined): string {
    const table = assertionValueTableName(kind, sort, field.name);
    const attachment = sort === 'vertex'
      ? `JOIN assertion_vertex_subject av ON av.assertion_id = a.assertion_id JOIN edge se ON se.id = av.subject_edge_id`
      : `JOIN assertion_edge_subject av ON av.assertion_id = a.assertion_id`;
    const subject = sort === 'vertex' && this.hasMerges && !this.kindByType.get(kindTypeNameOf(kind))?.key.includes(field.name) ? `graph_assertion_target(se.to_node,a.assertion_id,${this.contexts[0]},'${this.validAt}'::timestamptz,'${this.recordedAt}'::timestamptz)` : sort==='vertex'?'se.to_node':'av.edge_id';
    const languages = [lang ?? this.lang, this.fallbackLang];
    const languageRank = field.type === 'text'
      ? `CASE a.language WHEN ${sql.param(languages[0], '::text')} THEN 0 WHEN ${sql.param(languages[1], '::text')} THEN 1 ELSE 2 END`
      : '0';
    const property = sql.param(field.name, '::text');
    const validAt = sql.param(this.validAt, '::timestamptz');
    const recordedAt = sql.param(this.recordedAt, '::timestamptz');
    const targetAssertions = sort === 'vertex'
      ? `SELECT attachment.assertion_id FROM edge subject_edge CROSS JOIN LATERAL (SELECT s.assertion_id FROM assertion_vertex_subject s WHERE s.subject_edge_id=subject_edge.id OFFSET 0) attachment WHERE ${sort === 'vertex' && this.hasMerges && !this.kindByType.get(kindTypeNameOf(kind))?.key.includes(field.name) ? 'TRUE' : `subject_edge.to_node=${alias}.id`}`
      : `SELECT attachment.assertion_id FROM assertion_edge_subject attachment WHERE attachment.edge_id=${alias}.id`;
    return `(WITH target_assertions AS MATERIALIZED (${targetAssertions}), eligible AS (
      SELECT a.*, an.uid, v.value, source.to_node AS source, ${sort === 'vertex' ? 'se.to_node' : 'av.edge_id'} AS original_subject, ${languageRank} AS language_rank,
        array_position(${sql.param(this.contexts, '::bigint[]')}, a.context_id) AS layer
      FROM target_assertions target CROSS JOIN LATERAL (SELECT header.* FROM assertion header WHERE header.assertion_id=target.assertion_id OFFSET 0) a JOIN node an ON an.id = a.assertion_id ${attachment}
      LEFT JOIN "${table}" v ON v.assertion_id = a.assertion_id
      JOIN edge source ON source.from_node = a.assertion_id
      JOIN entity sk ON sk.id = source.entity_id AND sk.name = 'system.assertion-source'
      WHERE ${subject} = ${alias}.id AND a.property = ${property} AND a.recorded_at <= ${recordedAt}
        ${Object.entries(this.contextRecordedThrough).filter(([, cutoff]) => cutoff !== null).map(([id, cutoff]) => `AND (a.context_id <> ${Number(id)} OR a.recorded_sequence <= ${sql.param(cutoff, '::bigint')})`).join(' ')}
        AND a.context_id = ANY(${sql.param(this.contexts, '::bigint[]')})
        ${field.type === 'text' ? `AND (a.language IS NULL OR a.language = ANY(${sql.param(languages, '::text[]')}))` : ''}
    ), layered AS (
      SELECT eligible.*, min(layer) OVER (PARTITION BY original_subject, source, language) AS nearest FROM eligible
    ), streams AS (
      SELECT DISTINCT ON (original_subject, source, language) * FROM layered
      WHERE layer = nearest AND valid_from <= ${validAt} AND (valid_to IS NULL OR valid_to > ${validAt})
      ORDER BY original_subject, source, language, recorded_sequence DESC, uid::text COLLATE "C" DESC
    ), candidates AS (
      SELECT DISTINCT ON (language) * FROM streams WHERE operation = 'assert'
      ORDER BY language,(uid = ANY(${sql.param(this.resolutionAssertionIds, '::uuid[]')})) DESC,valid_from DESC,recorded_sequence DESC,uid::text COLLATE "C" DESC
    ) SELECT value FROM candidates WHERE language_rank = (SELECT min(language_rank) FROM candidates)
      ORDER BY valid_from DESC, recorded_sequence DESC, uid::text COLLATE "C" DESC LIMIT 1)`;
  }

  /** The operators a `<Edge>EdgeWhere` gives one attribute. */
  private edgeWhere(edge: PublishedEdge, where: Readonly<Record<string, unknown>> | undefined, sql: Sql, lang: string | undefined): string {
    if (where === undefined || where === null) return '';
    const clauses: string[] = [];
    for (const [name, filter] of Object.entries(where)) {
      const attribute = edge.fields.find((field) => fieldNameOf(field.name) === name);
      if (attribute === undefined) throw new GraphRefusal(`/where/${name}`, 'declared edge field', name);
      if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) throw new GraphRefusal(`/where/${name}`, 'filter object', filter);
      const expr = this.edgeValueExpr(edge, attribute, sql, lang);
      for (const [operator, value] of Object.entries(filter as Record<string, unknown>)) {
        const clause = compareClause(expr, attribute.type, operator, value, sql);
        if (clause !== undefined) clauses.push(clause);
      }
    }
    return clauses.join(' AND ');
  }

  /** The edge record's connection order: its attributes, then its id. */
  private edgeOrder(edge: PublishedEdge, orderBy: readonly Readonly<Record<string, unknown>>[] | undefined): { keys: { expr: string; column: string; rank: string; direction: 'ASC' | 'DESC'; nulls: 'FIRST' | 'LAST'; type: FieldType }[] } {
    const keys: { expr: string; column: string; rank: string; direction: 'ASC' | 'DESC'; nulls: 'FIRST' | 'LAST'; type: FieldType }[] = [];
    for (const one of orderBy ?? []) {
      const field = edge.fields.find((held) => fieldNameOf(held.name) === one['field']);
      if (field === undefined) throw new GraphRefusal('/orderBy/field', 'declared edge field', one['field']);
      const direction = one['direction'] === 'DESC' ? 'DESC' : 'ASC';
      const nulls = one['nulls'] === 'FIRST' ? 'FIRST' : 'LAST';
      keys.push({ expr: `"attr_${field.name}"`, column: `attr_${field.name}`, rank: `rows."attr_${field.name}" ${direction} NULLS ${nulls}`, direction, nulls, type: field.type });
    }
    return { keys };
  }

  /** The assertions of a batch of edges, one statement for all of them. */
  private async fetchEdgeAssertions(edge: PublishedEdge, ids: readonly string[]): Promise<Map<string, StoredAssertion[]>> {
    const out = new Map<string, StoredAssertion[]>();
    const rows = await loadAssertions(this.tx, 'edge', edge.name, ['$exists', ...edge.fields.map((field) => field.name)], ids.map(Number), { validAt: this.validAt, recordedAt: this.recordedAt, contexts: this.contexts, contextRecordedThrough: this.contextRecordedThrough });
    for (const row of rows) {
      const id = String(row.subjectId);
      const list = out.get(id) ?? [];
      list.push(row);
      out.set(id, list);
    }
    for (const [id, rows] of out) this.edgeAssertions.set(id, rows);
    return out;
  }

  private async edgeField(edge: EdgeRow, name: string): Promise<unknown> {
    if (name === 'id') return edge.edgeId;
    if (name === 'discriminator') return edge.discriminator;
    if (name === 'node') return edge.node;
    if (name in edge.values) return edge.values[name];
    const all = this.edgeAssertions.get(edge.edgeId) ?? [];
    const field = name.endsWith('Assertions') ? name.slice(0, -'Assertions'.length) : undefined;
    const rows = field === undefined ? all : all.filter((row) => fieldNameOf(row.property) === field);
    if (name !== 'assertions' && field === undefined) return null;
    const selected = new Set<string>();
    for (const property of new Set(rows.map((row) => row.property))) {
      const candidates = this.languageAssertions(rows.filter((row) => row.property === property), 'text', edge.lang);
      const chosen = this.selection(candidates).selected;
      if (chosen !== null) selected.add(chosen.id);
    }
    return await Promise.all(rows.map((row) => this.assertionValue(row, selected.has(row.id), edge.lang)));
  }

  /**
   * One entity's neighbourhood at a depth, for a rendered diagram (decision 0036, sections 7 and 8): the graph read layer
   * both ways per level, one snapshot, and every relation's field name as the schema answers it. A page folds what it shows
   * by kind above its bound; this step answers the whole neighbourhood it read, so the same graph revision gives the same
   * picture. A relation is read once per end and once per edge: the pair and its relation name decide the dedup.
   */
  /**
   * One entity's neighbourhood as a picture reads it (decision 0036, sections 7 and 8): the root, and its neighbours
   * grouped by the relation and the kind they came through, counted in the query and sampled by a stable order. A group
   * above the fold is one node with its count and the page that lists it, so a folder of 1 300 children is a handful of
   * nodes and the layout never sees the children. Two statements: the root, and every group with its sample.
   */
  async diagramNeighbourhood(id: string, depth: number, lang: string | undefined, first = 12): Promise<DiagramNeighbourhood | undefined> {
    if (depth !== 1) throw new Error(`${import.meta.path}:1: "depth" must be 1; deeper diagram neighbourhoods are not supported`);
    const root = entityOf(await this.root('entity', { id, ...(lang === undefined ? {} : { lang }) }));
    if (root === undefined) return undefined;
    const groups = new Map<string, DiagramGroup>();
    const nodes = new Map<string, EntityValue>([[root.uid, root]]);
    const links: DiagramLink[] = [];
    const kindWords = new Map<string, string>();
    const kindPages = new Map<string, string>();
    // The catalogue answers the folded nodes' page: the kind's entry lists every entity the node stands for.
    const catalogue = await this.catalogueData().catch(() => undefined);
    const visibleEdges = withManifestContract(graphContractOf(this.manifest)).edge.map((edge) => edge.name);
    const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `WITH around AS (
         SELECT 'out' AS side, CASE WHEN en.name = '${MANIFEST_RELATION_EDGE}' THEN e.discriminator ELSE en.name END AS relation,
                en.name IN ('${MANIFEST_DEPENDS_ON}', '${MANIFEST_RELATION_EDGE}') AS metadata, e.to_node AS other
         FROM ${this.effectiveEdges()} e JOIN entity en ON en.id = e.entity_id
         WHERE e.from_node = (SELECT n.id FROM node requested JOIN node n ON n.id=${this.canonicalNode('requested.id')} WHERE requested.uid = $1::uuid AND ${this.active('vertex', 'n')}) AND ${this.active('edge', 'e')} AND en.name = ANY($3::text[])
         UNION ALL
         SELECT 'in' AS side, CASE WHEN en.name = '${MANIFEST_RELATION_EDGE}' THEN e.discriminator ELSE en.name END AS relation,
                en.name IN ('${MANIFEST_DEPENDS_ON}', '${MANIFEST_RELATION_EDGE}') AS metadata, e.from_node AS other
         FROM ${this.effectiveEdges()} e JOIN entity en ON en.id = e.entity_id
         WHERE e.to_node = (SELECT n.id FROM node requested JOIN node n ON n.id=${this.canonicalNode('requested.id')} WHERE requested.uid = $1::uuid AND ${this.active('vertex', 'n')}) AND ${this.active('edge', 'e')} AND e.from_node <> e.to_node AND en.name = ANY($3::text[])
       ), live AS (
         SELECT around.side, around.relation, around.metadata, n2.id::text AS node_id, n2.uid::text AS uid, n2.key, en2.name AS kind
         FROM around
         JOIN node n2 ON n2.id = around.other AND ${this.active('vertex', 'n2')}
         JOIN entity en2 ON en2.id = n2.entity_id
       ), counted AS (
         SELECT live.*, count(*) OVER (PARTITION BY side, relation, kind)::int AS total,
                row_number() OVER (PARTITION BY side, relation, kind ORDER BY node_id::bigint) AS rn
         FROM live
       )
       SELECT * FROM counted WHERE rn <= $2::int ORDER BY side, relation, kind, rn`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await this.tx.query<Record<string, unknown>>(statementSql, [id, Math.max(1, first), visibleEdges]);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
    const sample = new Map<string, Record<string, unknown>[]>();
    for (const row of found.rows) {
      const key = `${row['side']}\u0000${row['relation']}\u0000${row['kind']}`;
      const held = sample.get(key) ?? [];
      held.push(row);
      sample.set(key, held);
    }
    for (const [key, rows] of sample) {
      const [side, relation, kind] = key.split('\u0000') as ['in' | 'out', string, string];
      const total = Number(rows[0]?.['total'] ?? rows.length);
      groups.set(key, { relation, side, kind, total, label: this.relationWord(relation, lang, side === 'in' && rows[0]?.['metadata'] !== true), ...(rows[0]?.['metadata'] === true ? { canonicalLabel: true } : {}), nodes: rows.map((row) => String(row['uid'])) });
      const entry = catalogue?.byName.get(kind);
      if (entry !== undefined) kindPages.set(kind, `/e/catalogue/${encodeURIComponent(entry.uid)}`);
      const label = this.kindWord(kind, lang);
      kindWords.set(kind, label);
      for (const row of rows) {
        const node = this.entityFromRow({ ...row, entity: row['kind'] }, lang);
        if (node === undefined) continue;
        nodes.set(node.uid, node);
        links.push(side === 'out' ? { from: root.uid, to: node.uid, relation } : { from: node.uid, to: root.uid, relation });
      }
    }
    const labels = new Map(await Promise.all([...nodes].map(async ([uid, entity]) => [uid, await this.labelOf(entity)] as const)));
    const truncated = [...groups.values()].some((group) => group.total > (sample.get(`${group.side}\u0000${group.relation}\u0000${group.kind}`)?.length ?? 0));
    return { entity: root, nodes, links, labels, groups: [...groups.values()], kindWords, kindPages, truncated };
  }

  /**
   * The words a relation reads as, from the published catalogue alone: the edge kind's own `labels`, or the relation
   * vocabulary's for a relation no edge carries. The engine holds no product words and derives none from a key (owner's
   * decision, 2026-11-15); a relation the catalogue names no words for has none, and no key reaches a page or a diagram.
   */
  private relationWord(name: string, lang: string | undefined, inverse: boolean): string {
    return publishedRelationWords(this.published, name, lang ?? this.lang, inverse);
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
      direction === 'in'
        ? { relation: row.relation, label: this.relationWord(this.edgeNameOf(row.relation), entity.lang, true), edge: this.edgeNameOf(row.relation), inverse: true, from: row.other }
        : { relation: row.relation, label: this.relationWord(this.edgeNameOf(row.relation), entity.lang, false), edge: this.edgeNameOf(row.relation), inverse: false, to: row.other };
    return {
      edges: page.map((row) => ({ cursor: encodeCursor({ relation: row.relation, id: row.id }), node: nodeOf(row) })),
      pageInfo: { endCursor: page.length === 0 ? null : encodeCursor({ relation: page[page.length - 1]!.relation, id: page[page.length - 1]!.id }), hasNextPage: after.length > first },
      totalCount: this.linkTotals.get(`${direction}\u0000${entity.nodeId}`) ?? ordered.length,
    };
  }

  private async flushLinks(): Promise<void> {
    return await withSpan('graph.links.batch', {}, async () => {
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
        const visibleEdges = sql.param(withManifestContract(graphContractOf(this.manifest)).edge.map((edge) => edge.name), '::text[]');
        const parts: string[] = [
          held.direction === 'in'
            ? `SELECT e.to_node AS target, CASE WHEN en.name = '${MANIFEST_RELATION_EDGE}' THEN e.discriminator ELSE en.name END AS relation, e.id::text AS source_id, e.from_node AS other
           FROM ${this.effectiveEdges()} e JOIN entity en ON en.id = e.entity_id WHERE e.to_node = ANY(${ids}) AND en.name = ANY(${visibleEdges}) AND ${this.active('edge', 'e')}`
            : `SELECT e.from_node AS target, CASE WHEN en.name = '${MANIFEST_RELATION_EDGE}' THEN e.discriminator ELSE en.name END AS relation, e.id::text AS source_id, e.to_node AS other
           FROM ${this.effectiveEdges()} e JOIN entity en ON en.id = e.entity_id WHERE e.from_node = ANY(${ids}) AND en.name = ANY(${visibleEdges}) AND ${this.active('edge', 'e')}`,
        ];
        const rows = await this.tx.query<{ target: string | number; relation: string; source_id: string; other: string | number; total: string | number }>(
          `WITH links AS (${parts.join(' UNION ALL ')}), distinct_links AS (
             SELECT DISTINCT target, relation, source_id, other FROM links JOIN node link_other ON link_other.id=links.other WHERE ${this.active('vertex', 'link_other')}
           ), ranked AS (
             SELECT distinct_links.*, row_number() OVER (PARTITION BY target ORDER BY relation, source_id) AS rn,
                    count(*) OVER (PARTITION BY target) AS total
             FROM distinct_links
           )
           SELECT * FROM ranked ORDER BY target, rn`,
          sql.params,
        );
        const others = [...new Set(rows.rows.map((row) => String(row.other)))];
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
          const target = String(row.target);
          const other = byId.get(String(row.other));
          if (other === undefined) continue;
          const relationName = held.direction === 'in' ? this.backlinkRelation(String(row.relation)) : fieldNameOf(String(row.relation));
          const list = lists.get(target) ?? [];
          list.push({ relation: relationName, other, id: String(row.source_id) });
          lists.set(target, list);
          this.linkTotals.set(`${held.direction}\u0000${target}`, Number(row.total));
        }
        for (const id of held.ids) this.linkCache.set(`${held.direction}\u0000${id}`, lists.get(id) ?? []);
      }
    });
  }

  /**
   * The edge kind a relation row was read through, by the name the row carries: the field's name in camelCase, or the
   * `<field>Of` inverse of it. A reference's inverse has no edge kind and answers the name it was read by.
   */
  private edgeNameOf(relation: string): string {
    for (const name of this.manifest.catalog?.schema.relations.keys() ?? []) {
      if (fieldNameOf(name) === relation || `${fieldNameOf(name)}Of` === relation) return name;
    }
    for (const declared of this.published.relations) {
      if (fieldNameOf(declared.name) === relation || `${fieldNameOf(declared.name)}Of` === relation) return declared.name;
    }
    for (const edge of this.published.edges) {
      if (fieldNameOf(edge.name) === relation || `${fieldNameOf(edge.name)}Of` === relation) return edge.name;
    }
    return relation;
  }

  /** The relation name an inverse field gives a backlink: the edge's `<edge>Of` name, or the reference's `<field>Of<Type>`. */
  private backlinkRelation(relation: string): string {
    const edge = this.published.edges.find((one) => one.name === relation);
    return edge === undefined ? relation : `${fieldNameOf(edge.name)}Of`;
  }

  // ---- roots -------------------------------------------------------------------------------------------------

  /**
   * One file's text, read by the blob the graph names (decision 0037): the entity is found by the roles the product
   * declares, and the bytes are read by the role that answers a read — never from a working copy.
   */
  private async sourceOf(args: Record<string, unknown>): Promise<unknown> {
    return await withSpan('graph.sourceOf', {}, async () => {
      if (this.readText === undefined) return null;
      const repository = typeof args['repository'] === 'string' ? args['repository'] : '';
      const path = typeof args['path'] === 'string' ? args['path'] : '';
      if (repository === '' || path === '') return null;
      const declared = fileTextKind(this.manifest);
      const roles = declared?.fileText ?? catalogueFileTextRole();
      const kind = declared?.name ?? roles.kind;
      if (kind === undefined) return null;
      const declaration = this.published.kinds.find(one => one.name === kind);
      const blobField = declaration?.fields.find(one => one.name === roles.blob);
      const pathField = declaration?.fields.find(one => one.name === roles.path);
      if (declaration === undefined || blobField === undefined || pathField === undefined) return null;
      const parent = this.manifest.kinds.get(kind)?.keyEdges?.find(one => one.role === roles.repository);
      if (parent === undefined) return null;
      const sql = new Sql();
      const pathValue = this.fieldExpr(declaration, pathField, 'n', sql, undefined);
      const blobValue = this.fieldExpr(declaration, blobField, 'n', sql, undefined);
      const found = await this.tx.query<{ blob: unknown }>(
        `SELECT ${blobValue} AS blob FROM node n JOIN entity k ON k.id=n.entity_id
         JOIN edge e ON e.${parent.direction === 'from' ? 'from_node' : 'to_node'}=n.id JOIN entity ek ON ek.id=e.entity_id
         JOIN node repository ON repository.id=e.${parent.direction === 'from' ? 'to_node' : 'from_node'}
         WHERE k.name=${sql.param(kind, '::text')} AND ek.name=${sql.param(parent.edge, '::text')}
           AND repository.key->>'name'=${sql.param(repository, '::text')} AND ${pathValue}=${sql.param(path, '::text')}
           AND ${this.active('vertex', 'n')} AND ${this.active('vertex', 'repository')} AND ${this.active('edge', 'e')} LIMIT 1`, sql.params);
      const blob = found.rows[0]?.blob;
      if (typeof blob !== 'string' || blob === '') return null;
      // A reader's later range names the blob its first answer held: a blob that no longer stands restarts the view and
      // says so, so two revisions are never interleaved.
      const held = typeof args['blob'] === 'string' ? args['blob'] : undefined;
      const moved = held !== undefined && held !== blob;
      const integer = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
      const answer = await this.readText({
        repository, path, blob, moved,
        from: moved ? 1 : integer(args['from']) ?? 1,
        ...(integer(args['to']) === undefined || moved ? {} : { to: integer(args['to'])! }),
        ...(moved ? {} : integer(args['fromColumn']) === undefined ? {} : { fromColumn: integer(args['fromColumn'])! }),
      });
      return answer ?? null;
    });
  }

  private async root(field: string, args: Record<string, unknown>): Promise<unknown> {
    return await withSpan('graph.root.resolve', {}, async () => {
      const lang = typeof args['lang'] === 'string' ? args['lang'] : undefined;
      if (field === 'entityByKey') {
        const kind = typeof args['kind'] === 'string' ? args['kind'] : '';
        const key = args['key'];
        if (!this.published.kinds.some((one) => one.name === kind) || key === null || typeof key !== 'object' || Array.isArray(key)) return null;
        const rows = await this.tx.query<Record<string, unknown>>(
          `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity
           FROM node n JOIN entity en ON en.id=n.entity_id WHERE en.name=$1 AND n.key=$2::jsonb AND ${this.active('vertex', 'n')} LIMIT 1`,
          [kind, JSON.stringify(key)]);
        return rows.rows[0] === undefined ? null : this.entityFromRow(rows.rows[0], lang) ?? null;
      }
      if (field === 'entity') {
        const id = typeof args['id'] === 'string' ? args['id'] : '';
        if (id === '') return null;
        const row = await this.metadataEntityRow(id);
        if (row === null) return null;
        if (String(row['entity']) === 'manifest.kind') await this.catalogueData();
        return this.entityFromRow(row, lang) ?? null;
      }
      const kind = this.kindByRoot.get(field);
      if (kind !== undefined) return this.listOfKind(kind, args as ConnectionArgs, lang);
      if (field.endsWith('Aggregate') && this.kindByRoot.has(field.slice(0, -'Aggregate'.length))) {
        const held = this.kindByRoot.get(field.slice(0, -'Aggregate'.length))!;
        return this.aggregateOfKind(held, args['where'] as Readonly<Record<string, unknown>> | undefined, lang);
      }
      if (field === 'cochange') return this.cochange(args, lang);
      if (field === 'contributors') return this.contributors(args, lang);
      if (field === 'catalogueDependencies') return this.catalogueDependencies(lang);
      if (field === 'logs') return this.logs === undefined ? null : this.logs(args);
      if (field === 'related') return this.related(args, lang);
      if (field === 'catalogueEntity') {
        const value = (await this.catalogueData()).byName.get(typeof args['name'] === 'string' ? args['name'] : '');
        if (value === undefined) throw new GraphRefusal('/name', 'declared catalogue kind', args['name']);
        return this.catalogueEntityValue(value, lang);
      }
      if (field === 'allCatalogueEntity') return this.allCatalogue(args as ConnectionArgs, lang);
      if (field === 'home') return this.home(lang);
      if (field === 'source') return await this.sourceOf(args);
      if (field === 'search') return this.search(args, lang);
      if (field === 'searchGroups') return this.searchGroups(args, lang);
      if (field === 'bootstrap') return this.bootstrap();
      if (field === 'navigation') return this.navigation(lang);
      // The templates a page draws are the graph's entities (the owner's decision of 2026-11-15): their findings are read from
      // the same revision the page is read at, and no folder is opened here.
      if (field === 'templateFindings') return checkProductTemplates(this.templateFiles, this.templateBodies, this.templateFindings, this.manifest).map((finding) => ({ ...finding, file: join(this.folder, finding.file) }));
      return null;
    });
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
    const answer = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `WITH filtered AS (
         SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity${selectOrder === '' ? '' : `, ${selectOrder}`}
         FROM node n JOIN entity en ON en.id = n.entity_id
         WHERE en.name = ${kindName} AND ${this.active('vertex', 'n')}${where === '' ? '' : ` AND (${where})`}
       ), rows AS (
         SELECT * FROM filtered${after === '' ? '' : ` WHERE ${after}`}
       ), ranked AS (
         SELECT rows.*, row_number() OVER (ORDER BY ${rankOrder}, rows.node_id::bigint) AS rn,
                (SELECT count(*) FROM filtered) AS total
         FROM rows
       )
       SELECT * FROM ranked WHERE rn <= ${sql.param(first + 1, '::int')} ORDER BY rn`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await this.tx.query<Record<string, unknown>>(statementSql, sql.params);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
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
    return await withSpan('graph.home.read', {}, async () => {
      const kind = homeKind(this.manifest);
      if (kind === undefined) return null;
      const product = productEntityOf(this.folder, { home: kind }, undefined);
      if (product === undefined) return null;
      const rows = await this.tx.query<Record<string, unknown>>(
        `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity
         FROM node n JOIN entity en ON en.id = n.entity_id WHERE en.name = $1 AND n.key=$2::jsonb AND ${this.active('vertex', 'n')}`,
        [kind.name, JSON.stringify(product.key)],
      );
      if (rows.rows[0] === undefined) return null;
      if (String(rows.rows[0]['entity']) === 'manifest.kind') await this.catalogueData();
      return this.entityFromRow(rows.rows[0], lang) ?? null;
    });
  }

  /** Search over labels and text fields, one union of every kind's text; the total is before the cursor. */
  /** The entities whose label or text holds the words asked: their node, their kind, the matched value and how well. */
  private async searchHits(text: string, wanted: ReadonlySet<string> | undefined, lang: string | undefined, limit: number, grouped = false): Promise<{ nodeId: string; uid: string; key: Readonly<Record<string, unknown>>; kind: string; value: string; rank: number; total: number }[]> {
    if (text.trim() === '') return [];
    const sql = new Sql();
    const pattern = sql.param(`%${text}%`, '::text');
    const prefix = sql.param(`${text}%`, '::text');
    const parts: string[] = [];
    const names: string[] = [];
    for (const kind of this.published.kinds) {
      if (wanted !== undefined && !wanted.has(kind.name) && !wanted.has(kindTypeNameOf(kind.name))) continue;
      // Immutable content is evidence, not a search index; the declaration names its content field.
      const contentField = this.manifest.kinds.get(kind.name)?.evidence?.contentField;
      const searched = kind.fields.filter((field) => field.type === 'text' && field.name !== contentField);
      if (searched.length === 0) continue;
      names.push(kind.name);
      const kindParam = sql.param(kind.name, '::text');
      const title = this.manifest.kinds.get(kind.name)?.title;
      for (const field of searched) {
        const expr = this.fieldExpr(kind, field, 'n', sql, lang);
        // A label match ranks above a text match: the entity whose own name holds the words is what a reader means.
        const rank = field.name === title ? `CASE WHEN (${expr}) ILIKE ${prefix} THEN 0 ELSE 1 END` : '3';
        parts.push(`SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity, ${kindParam} AS kind,
            (${expr})::text AS value, ${rank} AS rank
          FROM active_vertices n JOIN entity en ON en.id = n.entity_id
          WHERE en.name = ${kindParam} AND (${expr})::text ILIKE ${pattern}`);
      }
    }
    if (parts.length === 0) return [];
    const kindNames = sql.param(names, '::text[]');
    const bound = sql.param(limit, '::int');
    const answer = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `WITH hits AS (
         WITH active_vertices AS MATERIALIZED (
           SELECT n.* FROM node n JOIN entity en ON en.id = n.entity_id
           WHERE en.name = ANY(${kindNames}) AND ${this.active('vertex', 'n')}
         )
         ${parts.join(' UNION ALL ')}
       ),
       matched AS (
         SELECT hits.*, row_number() OVER (PARTITION BY node_id ORDER BY rank, length(value), value COLLATE "C") AS match_row
         FROM hits
       ), unique_hits AS (
         SELECT node_id, uid, key, kind, value, rank FROM matched WHERE match_row = 1
       ), counted AS (
         SELECT unique_hits.*, count(*) OVER (${grouped ? 'PARTITION BY kind' : ''})::int AS total,
                row_number() OVER (${grouped ? 'PARTITION BY kind' : ''} ORDER BY rank, ${grouped ? '' : 'length(value), '}node_id::bigint) AS result_row
         FROM unique_hits
       )
       SELECT node_id, uid, key, kind, value, rank, total FROM counted
       WHERE result_row <= ${bound}
       ORDER BY rank, ${grouped ? '' : 'length(value), '}node_id::bigint`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await this.tx.query<Record<string, unknown>>(statementSql, sql.params);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
    return answer.rows.map((row) => ({
      nodeId: String(row['node_id']),
      uid: String(row['uid']),
      key: (row['key'] ?? {}) as Readonly<Record<string, unknown>>,
      kind: String(row['kind']),
      value: String(row['value'] ?? ''),
      rank: Number(row['rank'] ?? 3),
      total: Number(row['total'] ?? 0),
    }));
  }

  private async search(args: Record<string, unknown>, lang: string | undefined): Promise<unknown> {
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    const wanted = Array.isArray(args['kinds']) ? new Set((args['kinds'] as unknown[]).filter((one): one is string => typeof one === 'string')) : undefined;
    const first = clampFirst(typeof args['first'] === 'number' ? args['first'] : null);
    const hits = await this.searchHits(text, wanted, lang, Math.max(first, 1));
    const total = hits[0]?.total ?? 0;
    const values = hits.slice(0, first).map((hit) => this.entityFromRow({ node_id: hit.nodeId, uid: hit.uid, key: hit.key, entity: hit.kind }, lang)).filter((one): one is EntityValue => one !== undefined);
    return {
      edges: values.map((node) => ({ cursor: encodeCursor({ k: hits.find((hit) => hit.nodeId === node.nodeId)?.kind ?? '', id: node.nodeId }), node })),
      pageInfo: { endCursor: null, hasNextPage: total > first },
      totalCount: total,
    };
  }

  /**
   * The search's answers grouped by kind, as a reader meets them (decision 0036, section 7): each kind's word, how many
   * answers it holds and its best `perKind` rows — the row's line being the entity's label, and for an entity named by a
   * hash the matched text beside it (a commit's short hash and the first line of its message).
   */
  private async searchGroups(args: Record<string, unknown>, lang: string | undefined): Promise<unknown[]> {
    const text = typeof args['text'] === 'string' ? args['text'] : '';
    const wanted = Array.isArray(args['kinds']) ? new Set((args['kinds'] as unknown[]).filter((one): one is string => typeof one === 'string')) : undefined;
    const perKind = boundedInteger(args['perKind'], 5, 1, 20, '/perKind');
    const hits = await this.searchHits(text, wanted, lang, Math.max(perKind * 4, 40), true);
    const groups = new Map<string, { rows: Map<string, { hit: (typeof hits)[number]; best: number }> }>();
    for (const hit of hits) {
      const held = groups.get(hit.kind) ?? { rows: new Map() };
      const row = held.rows.get(hit.nodeId) ?? { hit, best: 3 };
      if (hit.rank < row.best) { row.hit = hit; row.best = hit.rank; }
      held.rows.set(hit.nodeId, row);
      groups.set(hit.kind, held);
    }
    const out: { kind: string; label: string; count: number; best: number; results: unknown[] }[] = [];
    for (const [kind, group] of groups) {
      // The rows a reader meets first: the label matches, and among them the shorter label (a path's own file before a
      // folder that holds it), then the answer's own order. Labels are read for the candidates, not for the whole kind.
      const candidates = [...group.rows.values()].sort((left, right) => left.best - right.best || Number(left.hit.nodeId) - Number(right.hit.nodeId)).slice(0, Math.max(perKind * 4, 40));
      const named: { node: EntityValue; label: string; line: string; matched: string; best: number }[] = [];
      for (const row of candidates) {
        const node = this.entityFromRow({ node_id: row.hit.nodeId, uid: row.hit.uid, key: row.hit.key, entity: row.hit.kind }, lang);
        if (node === undefined) continue;
        const label = await this.labelOf(node);
        named.push({ node, label, line: searchLine(label, row.hit.value), matched: row.hit.value, best: row.best });
      }
      named.sort((left, right) => left.best - right.best || left.label.length - right.label.length || byCodePoint(left.label, right.label));
      const results: unknown[] = named.slice(0, perKind).map((row) => ({ node: row.node, line: row.line, matched: row.matched }));
      if (results.length === 0) continue;
      out.push({ kind, label: this.kindWord(kind, lang), count: group.rows.values().next().value?.hit.total ?? 0, best: named[0]?.best ?? 3, results });
    }
    // The catalogue's own kinds answer too: a reader who types a kind's word means the kind, not only its records.
    const catalogue = await this.catalogueSearchGroup(text, wanted, lang, perKind);
    if (catalogue !== undefined) out.push(catalogue);
    // The kind whose best answer ranks highest leads; the fuller kind leads among equals.
    return out
      .sort((left, right) => left.best - right.best || right.count - left.count || byCodePoint(left.label, right.label))
      .map(({ kind, label, count, results }) => ({ kind, label, count, results }));
  }

  /** The catalogue entries whose own word or definition holds the words asked: the kinds a reader may mean. */
  private async catalogueSearchGroup(text: string, wanted: ReadonlySet<string> | undefined, lang: string | undefined, perKind: number): Promise<{ kind: string; label: string; count: number; best: number; results: unknown[] } | undefined> {
    if (wanted !== undefined && !wanted.has('catalogue')) return undefined;
    const needle = text.trim().toLowerCase();
    if (needle === '') return undefined;
    const data = await this.catalogueData();
    const rows: { best: number; label: string; line: string; matched: string; value: EntityValue }[] = [];
    for (const entry of data.byName.values()) {
      const words = this.catalogueTitle(entry, lang);
      const definition = this.catalogueDefinition(entry, lang) ?? '';
      const lower = words.toLowerCase();
      const best = lower === needle ? 0 : lower.startsWith(needle) ? 1 : lower.includes(needle) ? 2 : definition.toLowerCase().includes(needle) ? 3 : 9;
      if (best === 9) continue;
      const node = this.catalogueEntityValue(entry, lang);
      // The field the words were found in: the kind's own word, or the definition that holds them.
      const matched = best === 3 && definition !== '' ? definition : words;
      rows.push({ best, label: words, line: `${words}${definition === '' ? '' : ` — ${definition.length > 90 ? `${definition.slice(0, 90).replace(/\s+\S*$/u, '')}…` : definition}`}`, matched, value: node });
    }
    if (rows.length === 0) return undefined;
    rows.sort((left, right) => left.best - right.best || left.label.length - right.label.length || byCodePoint(left.label, right.label));
    return { kind: 'catalogue', label: 'catalogue', count: rows.length, best: rows[0]!.best, results: rows.slice(0, perKind).map((row) => ({ node: row.value, line: row.line, matched: row.matched })) };
  }

  /** The catalogue's word for a kind in the reader's language, else its English word, else the kind's name. */
  private kindWord(kind: string, lang: string | undefined): string {
    const decl = this.manifest.kinds.get(kind);
    const language = lang ?? this.lang;
    return decl?.labels?.[language]?.many ?? decl?.labels?.[this.fallbackLang]?.many ?? kind;
  }

  private async bootstrap(): Promise<unknown> {
    const home = entityOf(await this.home(undefined));
    return {
      structureRevision: this.structure,
      // The product's own language (its manifest's `language:`), so the wiki opens in it: the setting the wiki already
      // reads, and the one a first run writes (madarch-64o5.84).
      language: this.manifest.language ?? 'en',
      home: home === undefined ? null : { id: home.uid, kind: home.kind, template: this.templateOf(home, home.kind) },
      catalogueTemplate: this.productTemplates.catalogue,
      templates: this.productTemplates.templates,
      recordTemplates: [...this.productTemplates.records.entries()]
        .map(([kind, template]) => ({ kind, template }))
        .sort((left, right) => byCodePoint(left.kind, right.kind)),
      ownTemplates: [
        ...[...this.productTemplates.own.entries()].map(([id, template]) => ({ id, template })),
        // A catalogue entry's page is its kind's catalogue template, when the product names one for that kind.
        ...[...((await this.catalogueData()).byName.values())]
          .map((entry) => ({ id: entry.uid, template: this.productTemplates.catalogueOf.get(entry.name) }))
          .filter((one): one is { id: string; template: string } => one.template !== undefined),
      ].sort((left, right) => byCodePoint(left.id, right.id)),
      roles: [...this.manifest.roles.keys()].sort(byCodePoint),
      // The groups each role lists first, as the manifest declares them: the sidebar reads no manifest of its own.
      roleLeads: [...this.manifest.roles.values()]
        .sort((left, right) => byCodePoint(left.name, right.name))
        .map((role) => ({ role: role.name, lead: [...role.lead] })),
    };
  }

  /**
   * The frame's one read (decision 0036, sections 6 and 7): the product's groups in the manifest's order and every kind
   * it declares, each with the count of the entities the graph holds and the id of its catalogue entry. The sidebar is
   * drawn from this answer alone, so the app names no kind of its own.
   */
  private async navigation(lang: string | undefined): Promise<unknown> {
    const language = lang ?? this.lang;
    const counts = await this.vertexCounts();
    const catalogue = await this.catalogueData();
    // The product's own name is the home entity's label, as the top bar and the product card show it.
    const home = entityOf(await this.home(language));
    const groups = [...this.manifest.groups.values()]
      .map((group) => ({
        name: group.name,
        labels: { ...group.labels },
        short: group.short === undefined ? null : { ...group.short },
        open: group.open === true,
        parent: group.parent ?? null,
      }));
    const kinds = [...this.manifest.kinds.values()]
      .filter((kind) => kind.templatePolicy !== 'none')
      .map((kind) => ({
        kind: kind.name,
        one: kind.labels?.[language]?.one ?? kind.labels?.[this.fallbackLang]?.one ?? kind.name,
        many: kind.labels?.[language]?.many ?? kind.labels?.[this.fallbackLang]?.many ?? kind.name,
        definition: kind.descriptions?.[language] ?? kind.descriptions?.[this.fallbackLang] ?? null,
        taken: catalogue.byName.has(kind.name),
        group: kind.group ?? null,
        nav: kind.nav ?? null,
        count: counts.get(kind.name) ?? 0,
        entryId: catalogue.byName.get(kind.name)?.uid ?? null,
        purpose: kind.purpose ?? null,
        audience: kind.audience === undefined ? null : [...kind.audience],
      }));
    const purposes = [...(this.manifest.purposes?.values() ?? [])]
      .sort((left, right) => left.order - right.order || byCodePoint(left.id, right.id))
      .map((purpose) => ({ id: purpose.id, labels: { ...purpose.labels } }));
    return { product: home === undefined ? null : await this.labelOf(home), groups, kinds, purposes };
  }

  /**
   * The entities the graph holds of each kind the product takes, in one statement. A kind that records when an entity
   * left the product (a removal timestamp) counts the entities still here: a path that left the tree is history, not a
   * file, and the sidebar and the pages say the same number.
   */
  private async vertexCounts(): Promise<Map<string, number>> {
    const names = this.published.kinds.map((kind) => kind.name);
    if (names.length === 0) return new Map();
    const sql = new Sql();
    const kinds = sql.param(names, '::text[]');
    const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `SELECT en.name AS kind, count(*)::int AS n
        FROM node n JOIN entity en ON en.id = n.entity_id
        WHERE ${this.active('vertex', 'n')} AND en.name = ANY(${kinds})
        GROUP BY en.name`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await this.tx.query<Record<string, unknown>>(statementSql, sql.params);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
    return new Map(found.rows.map((row) => [String(row['kind']), Number(row['n'])]));
  }


  // ---- aggregates (decision 0036, section 4) ----------------------------------------------------------------

  /** One kind's aggregate object: its count, groups, buckets and ranking are answered field by field, each in SQL. */
  private aggregateOfKind(kind: PublishedKind, where: Readonly<Record<string, unknown>> | undefined, lang: string | undefined): AggregateValue {
    return { __aggregate: true, kind, where, lang };
  }

  /**
   * The kind's vertices under the aggregate's filter, with one field's agreed value: the one source every aggregate
   * field reads, so the filter is written once and the values are the values a page shows.
   */
  private aggregateSource(aggregate: AggregateValue, field: PublishedField | undefined): { sql: string; params: unknown[] } {
    const sql = new Sql();
    const kindName = sql.param(aggregate.kind.name, '::text');
    const where = this.vertexWhere(aggregate.kind, aggregate.where, sql, 'n', aggregate.lang);
    const value = field === undefined ? 'NULL' : this.fieldExpr(aggregate.kind, field, 'n', sql, aggregate.lang);
    return {
      sql: `SELECT n.id AS node_id, ${value} AS value
            FROM node n JOIN entity en ON en.id = n.entity_id
            WHERE en.name = ${kindName} AND ${this.active('vertex', 'n')}${where === '' ? '' : ` AND (${where})`}`,
      params: sql.params,
    };
  }

  /** One field of an aggregate, read over the kind's agreed values in one statement. */
  private async aggregateField(aggregate: AggregateValue, name: string, args: Record<string, unknown>): Promise<unknown> {
    const { kind, lang } = aggregate;
    if (name === 'count') {
      const filtered = this.aggregateSource(aggregate, undefined);
      const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
        const statementSql = `WITH v AS (${filtered.sql}) SELECT count(*)::int AS n FROM v`;
        span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
        const answer = await this.tx.query<{ n: number }>(statementSql, filtered.params);
        span.setAttribute('db.rows', answer.rows.length);
        return answer;
      });
      return Number(found.rows[0]?.n ?? 0);
    }
    const fieldName = typeof args['field'] === 'string' ? args['field'] : '';
    const field = this.fieldsByType.get(kindTypeNameOf(kind.name))?.get(fieldName);
    if (field === undefined) throw new GraphRefusal('/field', `field of ${kind.name}`, fieldName);
    if (name === 'histogram' && !['integer', 'bigint', 'timestamp'].includes(field.type)) throw new GraphRefusal('/field', 'numeric or timestamp field', fieldName);
    const filtered = this.aggregateSource(aggregate, field);
    if (name === 'groupBy') {
      const limit = boundedInteger(args['limit'], 20, 0, 20, '/limit');
      const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
        const statementSql = `WITH v AS (${filtered.sql}) SELECT to_jsonb(value) AS key, count(*)::int AS n FROM v
         GROUP BY value ORDER BY n DESC, value ASC NULLS LAST LIMIT ${String(limit)}`;
        span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
        const answer = await this.tx.query<{ key: unknown; n: number }>(statementSql, filtered.params);
        span.setAttribute('db.rows', answer.rows.length);
        return answer;
      });
      return found.rows.map((row) => ({ key: row.key, count: Number(row.n) }));
    }
    if (name === 'histogram') {
      const supplied = args['bounds'];
      if (!Array.isArray(supplied) || supplied.some((one, at) => typeof one !== 'number' || !Number.isFinite(one) || (at > 0 && one <= Number(supplied[at - 1])))) throw new GraphRefusal('/bounds', 'strictly increasing finite numeric bounds', supplied);
      const bounds = supplied as number[];
      // A timestamp's histogram counts its age in days, so a bucket says how long ago; a number's counts the value.
      const measured = field.type === 'timestamp' ? 'EXTRACT(EPOCH FROM (now() - value)) / 86400' : 'value::numeric';
      const edges: (number | null)[] = [null, ...bounds, null];
      const buckets = edges.slice(0, -1).map((from, at) => {
        const to = edges[at + 1] ?? null;
        const clause = from === null && to === null ? 'TRUE'
          : from === null ? `m < ${String(to)}` : to === null ? `m >= ${String(from)}` : `m >= ${String(from)} AND m < ${String(to)}`;
        return { clause, from, to };
      });
      const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
        const statementSql = `WITH v AS (${filtered.sql}), m AS (SELECT ${measured} AS m FROM v WHERE value IS NOT NULL),
         b AS (SELECT * FROM (VALUES ${buckets.map((_, at) => `(${String(at)})`).join(', ')}) AS t(at))
         SELECT b.at, ${buckets.map((one, at) => `count(*) FILTER (WHERE b.at = ${String(at)} AND ${one.clause})`).join(' + ')}::int AS n
         FROM m CROSS JOIN b GROUP BY b.at ORDER BY b.at`;
        span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
        const answer = await this.tx.query<{ at: number; n: number }>(statementSql, filtered.params);
        span.setAttribute('db.rows', answer.rows.length);
        return answer;
      });
      const counted = new Map(found.rows.map((row) => [Number(row.at), Number(row.n)]));
      return buckets.map((one, at) => ({ from: one.from, to: one.to, count: counted.get(at) ?? 0 }));
    }
    if (name === 'topN') {
      const n = boundedInteger(args['n'], 10, 0, 50, '/n');
      const found = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
        const statementSql = `WITH v AS (${filtered.sql}) SELECT node_id, value FROM v WHERE value IS NOT NULL
         ORDER BY value DESC NULLS LAST, node_id::bigint ASC LIMIT ${String(n)}`;
        span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
        const answer = await this.tx.query<Record<string, unknown>>(statementSql, filtered.params);
        span.setAttribute('db.rows', answer.rows.length);
        return answer;
      });
      const ids = found.rows.map((row) => String(row['node_id']));
      const nodes = ids.length === 0 ? [] : (await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
        const statementSql = `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity FROM node n JOIN entity en ON en.id = n.entity_id WHERE n.id = ANY($1::bigint[])`;
        span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
        const answer = await this.tx.query<Record<string, unknown>>(statementSql, [ids]);
        span.setAttribute('db.rows', answer.rows.length);
        return answer;
      })).rows;
      const byId = new Map(nodes.map((row) => [String(row['node_id']), this.entityFromRow(row, lang)]));
      return found.rows
        .map((row) => ({ node: byId.get(String(row['node_id'])), value: row['value'] }))
        .filter((one) => one.node !== undefined);
    }
    return null;
  }

  /**
   * The rows of one relation of one entity (decision 0036, section 3 read as a root): the entities at the other end of
   * an edge kind, ordered by their own fields — a file's commits newest first, its containers, the files that import it —
   * with each edge's count, the page's cursor and the reader's language carried to the other end.
   */
  private async related(args: Record<string, unknown>, lang: string | undefined): Promise<unknown> {
    const uid = typeof args['id'] === 'string' ? args['id'] : '';
    const edgeName = typeof args['edge'] === 'string' ? args['edge'] : '';
    const inverse = args['inverse'] === true;
    if (uid === '' || edgeName === '') return { edges: [], pageInfo: { endCursor: null, hasNextPage: false }, totalCount: 0 };
    const edge = this.published.edges.find((one) => one.name === edgeName);
    const depth = Math.trunc(Number(args['depth'] ?? 1));
    if (depth < 1 || depth > 3) throw new Error('related depth must be between 1 and 3');
    const requestedKinds = Array.isArray(args['kinds']) ? args['kinds'] as string[] : undefined;
    const kinds = requestedKinds ?? (inverse ? edge?.from : edge?.to) ?? [];
    const kind = kinds.length === 1 ? this.published.kinds.find((one) => one.name === kinds[0]) : undefined;
    if (kind === undefined && (args['where'] !== undefined && args['where'] !== null || Array.isArray(args['orderBy']) && args['orderBy'].length > 0)) {
      throw new Error('related where and orderBy require one declared target kind');
    }
    const sql = new Sql();
    const nearColumn = inverse ? 'e.to_node' : 'e.from_node';
    const otherColumn = inverse ? 'e.from_node' : 'e.to_node';
    const order = kind === undefined ? { keys: [] as { at: number; expr: string; direction: 'ASC' | 'DESC'; nulls: 'FIRST' | 'LAST'; type: FieldType }[] }
      : this.vertexOrder(kind, Array.isArray(args['orderBy']) ? (args['orderBy'] as readonly Readonly<Record<string, unknown>>[]) : undefined, sql, 'n2', lang);
    const first = clampFirst(args['first'] as number | null | undefined);
    const selectOrder = order.keys.map((one) => `${one.expr} AS "order_${String(one.at)}"`).join(', ');
    const afterKeys = order.keys.map((one) => ({ ...one, expr: `"order_${String(one.at)}"` }));
    const after = this.afterClause(afterKeys, args['after'] as string | null | undefined, sql, 'other_id::bigint');
    const rankOrder = order.keys.length === 0 ? 'rows.other_id::bigint' : order.keys.map((one) => `rows."order_${String(one.at)}" ${one.direction} NULLS ${one.nulls}`).join(', ');
    const answer = await withSpan('db.query', { 'db.system': 'postgres' }, async (span) => {
      const statementSql = `WITH RECURSIVE origin AS (
         SELECT n.id FROM node requested JOIN node n ON n.id=${this.canonicalNode('requested.id')} WHERE requested.uid = ${sql.param(uid, '::uuid')} AND ${this.active('vertex', 'n')}
       ), reach(id, level, visited) AS (
         SELECT id, 0, ARRAY[id] FROM origin
         UNION ALL
         SELECT ${otherColumn}, r.level + 1, r.visited || ${otherColumn}
         FROM reach r JOIN ${this.effectiveEdges()} e ON ${nearColumn} = r.id AND ${this.active('edge', 'e')}
         JOIN entity en ON en.id = e.entity_id AND en.name = ${sql.param(edgeName, '::text')}
         JOIN node reached ON reached.id = ${otherColumn} AND ${this.active('vertex', 'reached')}
         WHERE r.level < ${sql.param(depth, '::int')} AND NOT ${otherColumn} = ANY(r.visited)
       ), filtered AS (
         SELECT n2.id::text AS other_id, n2.id::text AS node_id, n2.uid::text AS uid, n2.key, en2.name AS entity${selectOrder === '' ? '' : `, ${selectOrder}`}
         FROM node n2 JOIN entity en2 ON en2.id = n2.entity_id
         WHERE n2.id IN (SELECT id FROM reach WHERE level > 0)
           ${requestedKinds === undefined ? '' : `AND en2.name = ANY(${sql.param(requestedKinds, '::text[]')})`}
           ${kind === undefined ? '' : (() => { const where = this.vertexWhere(kind, args['where'] as Readonly<Record<string, unknown>> | undefined, sql, 'n2', lang); return where === '' ? '' : `AND (${where})`; })()}
       ), rows AS (SELECT * FROM filtered${after === '' ? '' : ` WHERE ${after}`}), ranked AS (
         SELECT rows.*, row_number() OVER (ORDER BY ${rankOrder}, rows.node_id::bigint) AS rn,
                (SELECT count(*) FROM filtered) AS total
         FROM rows
       )
       SELECT * FROM ranked WHERE rn <= ${sql.param(first + 1, '::int')} ORDER BY rn`;
      span.setAttribute('db.sql.bytes', Buffer.byteLength(statementSql));
      const answer = await this.tx.query<Record<string, unknown>>(statementSql, sql.params);
      span.setAttribute('db.rows', answer.rows.length);
      return answer;
    });
    const values = answer.rows.map((row) => this.entityFromRow(row, lang)).filter((one): one is EntityValue => one !== undefined);
    const total = answer.rows.length === 0 ? 0 : Number(answer.rows[0]!['total']);
    const page = values.slice(0, first);
    const cursorOf = (at: number, node: EntityValue): string => encodeCursor({ o: order.keys.map((one) => answer.rows[at]![`order_${String(one.at)}`] ?? null), id: node.nodeId });
    return {
      edges: page.map((node, at) => ({ cursor: cursorOf(at, node), node })),
      pageInfo: { endCursor: page.length === 0 ? null : cursorOf(page.length - 1, page[page.length - 1]!), hasNextPage: values.length > first },
      totalCount: total,
      relationLabel: this.relationWord(edgeName, lang, inverse),
    };
  }

  private async contributors(args: Record<string, unknown>, lang: string | undefined): Promise<unknown> {
    return await withSpan('graph.contributors.read', {}, async () => {
      const uid = typeof args['id'] === 'string' ? args['id'] : '';
      const through = typeof args['through'] === 'string' ? args['through'] : '';
      const edge = typeof args['edge'] === 'string' ? args['edge'] : '';
      const first = boundedInteger(args['first'], 20, 1, 50, '/first');
      if (uid === '' || through === '' || edge === '') return [];
      const rows = await this.tx.query<Record<string, unknown>>(
        `WITH me AS (SELECT n.id FROM node requested JOIN node n ON n.id=${this.canonicalNode('requested.id')} WHERE requested.uid = $1::uuid AND ${this.active('vertex', 'n')}),
         near AS (
           SELECT e.from_node AS mid FROM ${this.effectiveEdges()} e JOIN entity en ON en.id = e.entity_id AND en.name = $2
             WHERE e.to_node = (SELECT id FROM me) AND ${this.active('edge', 'e')}
         ),
         far AS (
           SELECT e.from_node AS node FROM ${this.effectiveEdges()} e JOIN entity en ON en.id = e.entity_id AND en.name = $3
             WHERE e.to_node IN (SELECT mid FROM near) AND ${this.active('edge', 'e')}
         ),
         counted AS (SELECT node, count(*)::int AS n FROM far GROUP BY node)
         SELECT node, n FROM counted ORDER BY n DESC, node::bigint ASC LIMIT ${String(first)}`,
        [uid, through, edge],
      );
      const ids = rows.rows.map((row) => String(row['node']));
      if (ids.length === 0) return [];
      const nodes = (await this.tx.query<Record<string, unknown>>(
        `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity FROM node n JOIN entity en ON en.id = n.entity_id WHERE n.id = ANY($1::bigint[]) AND ${this.active('vertex', 'n')}`,
        [ids],
      )).rows;
      const byId = new Map(nodes.map((row) => [String(row['node_id']), this.entityFromRow(row, lang)]));
      return rows.rows.map((row) => ({ node: byId.get(String(row['node'])), count: Number(row['n']) })).filter((one) => one.node !== undefined);
    });
  }

  /**
   * The entities that changed together with one entity through an edge kind (decision 0036, section 4 over the
   * history): the other ends of the edges that share a near end with it, counted, the most shared first.
   */
  private async cochange(args: Record<string, unknown>, lang: string | undefined): Promise<unknown> {
    return await withSpan('graph.cochange.read', {}, async () => {
      const uid = typeof args['id'] === 'string' ? args['id'] : '';
      const edgeName = typeof args['edge'] === 'string' ? args['edge'] : '';
      const first = boundedInteger(args['first'], 20, 0, 50, '/first');
      if (uid === '' || edgeName === '') return [];
      const rows = await this.tx.query<Record<string, unknown>>(
        `WITH me AS (SELECT n.id FROM node requested JOIN node n ON n.id=${this.canonicalNode('requested.id')} WHERE requested.uid = $1::uuid AND ${this.active('vertex', 'n')}),
         mine AS (
           SELECT e.to_node AS node, e.from_node AS other FROM ${this.effectiveEdges()} e JOIN entity en ON en.id = e.entity_id AND en.name = $2
             WHERE e.to_node = (SELECT id FROM me) AND ${this.active('edge', 'e')}
           UNION ALL
           SELECT e.from_node AS node, e.to_node AS other FROM ${this.effectiveEdges()} e JOIN entity en ON en.id = e.entity_id AND en.name = $2
             WHERE e.from_node = (SELECT id FROM me) AND ${this.active('edge', 'e')}
         ),
         sibling AS (
           SELECT e.to_node AS node, e.from_node AS other FROM ${this.effectiveEdges()} e JOIN entity en ON en.id = e.entity_id AND en.name = $2
             WHERE e.from_node IN (SELECT other FROM mine) AND e.to_node <> (SELECT id FROM me) AND ${this.active('edge', 'e')}
           UNION ALL
           SELECT e.from_node AS node, e.to_node AS other FROM ${this.effectiveEdges()} e JOIN entity en ON en.id = e.entity_id AND en.name = $2
             WHERE e.to_node IN (SELECT other FROM mine) AND e.from_node <> (SELECT id FROM me) AND ${this.active('edge', 'e')}
         ),
         shared AS (SELECT node, count(DISTINCT other)::int AS n FROM sibling GROUP BY node)
         SELECT node, n FROM shared WHERE n >= 2 ORDER BY n DESC, node::bigint ASC LIMIT ${String(first)}`,
        [uid, edgeName],
      );
      const ids = rows.rows.map((row) => String(row['node']));
      if (ids.length === 0) return [];
      const nodes = (await this.tx.query<Record<string, unknown>>(
        `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key, en.name AS entity FROM node n JOIN entity en ON en.id = n.entity_id WHERE n.id = ANY($1::bigint[]) AND ${this.active('vertex', 'n')}`,
        [ids],
      )).rows;
      const byId = new Map(nodes.map((row) => [String(row['node_id']), this.entityFromRow(row, lang)]));
      return rows.rows
        .map((row) => ({ node: byId.get(String(row['node'])), count: Number(row['n']) }))
        .filter((one) => one.node !== undefined);
    });
  }

  // ---- catalogue ---------------------------------------------------------------------------------------------


  private async allCatalogue(args: ConnectionArgs, lang: string | undefined): Promise<unknown> {
    const data = await this.catalogueData();
    return this.catalogueConnection([...data.byName.values()], args, lang);
  }

  /** The kinds and what each needs filled first, as one compact answer for the catalogue's graph (madarch-64o5.124). */
  private async catalogueDependencies(lang: string | undefined): Promise<unknown> {
    const data = await this.catalogueData();
    const kinds = [...data.byName.values()].map((value) => ({
      name: value.name,
      label: this.catalogueTitle(value, lang),
      id: value.uid,
      derivesFrom: value.derivesFrom.map((dependency) => {
        const held = data.byName.get(dependency);
        return { name: dependency, label: held === undefined ? dependency : this.catalogueTitle(held, lang), id: held?.uid ?? dependency };
      }),
    })).sort((left, right) => byCodePoint(left.name, right.name));
    return { kinds };
  }

  private async catalogueData(): Promise<{ byName: Map<string, CatalogueValue>; byId: Map<string, CatalogueValue> }> {
    return await withSpan('graph.catalogue.read', {}, async () => {
      if (this.catalogueRead !== undefined) return this.catalogueRead;
      const byName = new Map<string, CatalogueValue>();
      const byId = new Map<string, CatalogueValue>();
      const declarations = async (kind: string) => {
        const identities = await this.tx.query<Record<string, unknown>>(
          `SELECT n.id::text AS node_id, n.uid::text AS uid, n.key->>'name' AS name
           FROM node n JOIN entity e ON e.id=n.entity_id WHERE e.name=$1 AND ${this.active('vertex', 'n')}`, [kind]);
        const assertions = await loadAssertions(this.tx, 'vertex', kind, ['declaration'], identities.rows.map((row) => Number(row['node_id'])), { validAt: this.validAt, recordedAt: this.recordedAt, contexts: this.contexts, contextRecordedThrough: this.contextRecordedThrough, projectMergedSubjects: this.hasMerges, resolvedAssertionIds: this.resolutionAssertionIds });
        return { rows: identities.rows.map((row): Record<string, unknown> => {
          const value = this.selection(assertions.filter((one) => one.subjectId === Number(row['node_id']))).selected?.value;
          return { ...row, declaration: value === undefined ? undefined : JSON.parse(String(value)) };
        }) };
      };
      const kinds = await declarations('manifest.kind');
      const fieldRows = await declarations('manifest.field');
      const dependencies = await this.tx.query<Record<string, unknown>>(
        `SELECT DISTINCT dependent.key->>'name' AS dependent, prerequisite.key->>'name' AS prerequisite
         FROM ${this.effectiveEdges()} e JOIN entity en ON en.id = e.entity_id AND en.name = '${MANIFEST_DEPENDS_ON}'
         JOIN node dependent ON dependent.id = e.from_node AND ${this.active('vertex', 'dependent')}
         JOIN node prerequisite ON prerequisite.id = e.to_node AND ${this.active('edge', 'e')} AND ${this.active('vertex', 'prerequisite')}
         WHERE ${this.active('edge', 'e')}
         ORDER BY dependent, prerequisite`,
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
          producers: Array.isArray(declaration['producers']) ? (declaration['producers'] as unknown[]).filter((one): one is string => typeof one === 'string') : [],
        });
        fieldsByKind.set(declaration['kind'], list);
      }
      const derives = new Map<string, string[]>();
      const derivedBy = new Map<string, string[]>();
      for (const row of dependencies.rows) {
        const dependent = String(row['dependent']);
        const prerequisite = String(row['prerequisite']);
        derives.set(dependent, [...(derives.get(dependent) ?? []), prerequisite]);
        derivedBy.set(prerequisite, [...(derivedBy.get(prerequisite) ?? []), dependent]);
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
    });
  }

  private async catalogueField(value: CatalogueValue, name: string, args: ConnectionArgs, lang: string | undefined): Promise<unknown> {
    if (name === 'id') return value.uid;
    if (name === 'kind') return 'catalogue';
    if (name === 'label' || name === 'title') return this.catalogueTitle(value, lang);
    if (name === 'template') return this.productTemplates.catalogue;
    if (name === 'contested') return [];
    if (name === 'related') return this.related({ ...args, id: value.uid }, lang);
    if (name === 'backlinks') return this.backlinks(this.catalogueEntityValue(value, lang), args);
    if (name === 'outgoing') return this.outgoing(this.catalogueEntityValue(value, lang), args);
    if (name === 'name') return value.name;
    if (name === 'definition') return this.catalogueDefinition(value, lang);
    if (name === 'group') return String(value.entry['area'] ?? '');
    if (name === 'subgroup') return String(value.entry['subgroup'] ?? '');
    if (name === 'purpose') return typeof value.entry['purpose'] === 'string' ? value.entry['purpose'] : null;
    if (name === 'audience') return Array.isArray(value.entry['audience']) ? value.entry['audience'] : [];
    if (name === 'standards') return Array.isArray(value.entry['sources']) ? value.entry['sources'] : [];
    if (name === 'taken') return value.taken;
    if (name === 'plugins') return value.plugins;
    if (name === 'fields') return value.fields;
    if (name === 'instances') return this.catalogueInstances(value, args, lang);
    if (name === 'instancesAggregate') {
      const kind = this.published.kinds.find((one) => one.name === value.name);
      if (kind === undefined) return { __aggregate: true, count: 0 };
      return this.aggregateOfKind(kind, args['where'] as Readonly<Record<string, unknown>> | undefined, lang);
    }
    if (name === 'derivesFrom') return this.catalogueLinks(value.derivesFrom, args, lang);
    if (name === 'derivedBy') return this.catalogueLinks(value.derivedBy, args, lang);
    const relation = this.relationByType.get('CatalogueEntity')?.get(name);
    if (relation !== undefined) return this.relation({ nodeId: value.nodeId, uid: value.uid, kind: 'catalogue', key: {}, typeName: 'CatalogueEntity', catalogue: value, ...(lang === undefined ? {} : { lang }) }, relation.edge, relation.side, args);
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
    return this.assertionExpr('vertex', kind.name, field, alias, sql, lang);
  }

  /** The `<Type>Where` of one kind, as SQL over the agreed values. */
  private vertexWhere(kind: PublishedKind, where: Readonly<Record<string, unknown>> | undefined, sql: Sql, alias: string, lang: string | undefined): string {
    if (where === undefined || where === null) return '';
    const type = kindTypeNameOf(kind.name);
    const clauses: string[] = [];
    for (const [name, filter] of Object.entries(where)) {
      const field = this.fieldsByType.get(type)?.get(name);
      if (field === undefined) throw new GraphRefusal(`/where/${name}`, `field of ${kind.name}`, name);
      if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) throw new GraphRefusal(`/where/${name}`, 'filter object', filter);
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
    const type = kindTypeNameOf(kind.name);
    const keys: { at: number; expr: string; direction: 'ASC' | 'DESC'; nulls: 'FIRST' | 'LAST'; type: FieldType }[] = [];
    for (const one of orderBy ?? []) {
      const field = this.fieldsByType.get(type)?.get(String(one['field']));
      if (field === undefined) throw new GraphRefusal('/orderBy/field', `field of ${kind.name}`, one['field']);
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
    if (cursor === undefined) return '';
    if (!Array.isArray(cursor.o) || cursor.o.length !== keys.length) throw new GraphRefusal('/after', 'cursor matching the connection order', after);
    for (const [at, key] of keys.entries()) if (cursor.o[at] !== null && !fits({ name: String(at), type: key.type }, cursor.o[at])) throw new GraphRefusal(`/after/o/${at}`, key.type, cursor.o[at]);
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
    // The catalogue's own entries are graph vertices of `manifest.kind`: they answer as catalogue entities, from the
    // entry the product's start published, and are not records of a declared kind.
    if (entityName === 'manifest.kind') {
      const catalogue = this.catalogueRead?.byId.get(nodeId);
      return catalogue === undefined ? undefined : { nodeId, uid, kind: 'catalogue', key, typeName: 'CatalogueEntity', catalogue, ...(lang === undefined ? {} : { lang }) };
    }
    const typeName = kindTypeNameOf(entityName);
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
