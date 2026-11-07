/**
 * The temporal graph store (decision 0028): one graph of stable identities
 * with versioned nodes and edges, two time axes and architecture states, in
 * the process's one database owner (PGlite opened with `btreeGist: true`, or
 * PostgreSQL). It lives beside today's stores and touches none of them.
 *
 * Every method takes an optional `OuterTransaction` of the owner: given, its
 * statements run inside it and the store neither commits nor rolls it back;
 * without one, a write runs in a transaction of its own and a read in a
 * snapshot.
 *
 * Recorded time comes from the store's clock, which never goes backwards and
 * never repeats within one store: two writes in the same millisecond are
 * recorded a millisecond apart, so a correction never meets its own version at
 * one instant. Tests inject the clock.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { OuterTransaction } from '../history/types.js';
import type { GraphId } from './digest.js';
import {
  leaseWorkItem, openWorkItem, publish, publishUnit,
  type LeaseInput, type PublishInput, type PublishResult, type PublishUnitInput, type PublishUnitResult, type UnitEdgeDraft, type UnitEnd, type UnitNodeDraft, type WorkItemInput,
} from './publish.js';
import {
  readAll, readByKey, readByProperty, readCallees, readCallers, readClaims, readContentBytes, readEdgesByProperty, readNode, readOutgoingDiff, readRelationsWithin, readStateChain, readTraversal, resolveLens,
  type ClaimEntry, type EdgeEntry, type GraphLens, type OutgoingDiff, type Page, type PageOptions, type StateEntry,
} from './reads.js';
import { registerCodeSchema, registerVocabulary } from './register.js';
import { createGraphSchema } from './schema.js';
import { createGraphStatistics, type GraphStatistics, type StatisticsRefresh } from './statistics.js';
import { instantMicros, microsInstant } from './time.js';
import {
  closeVersion, removeNodeVersion, correctEdgeVersion, correctNodeVersion, endEdgeVersion, endNode, newNodeIdentity, openEdgeVersion, openNodeVersion, writeMemo,
  type EdgePatch, type EndResult, type NewEdgeVersion, type NewNodeVersion, type NodePatch, type NodeVersionRow, type WriteContext,
} from './versions.js';
import type { GraphRegistry } from './vocabulary.js';

export { GraphClockBehind, GraphError } from './errors.js';
import { GraphClockBehind } from './errors.js';
export type { GraphOrigin } from './errors.js';
export { GRAPH_TABLES } from './schema.js';
export { ALL_STATES, plusMicrosecond, type Instant, type StateSpan } from './time.js';
export { CODE_NODE_KINDS, CODE_PREFIX, CODE_RELATIONS, ENGINE_NODE_KINDS, ENGINE_PREFIX, ENGINE_RELATIONS, CALLS, CONTAINS, STATE_KIND, CONTENT_KIND, CLAIM_KIND, ACCEPTANCE_KIND, type GraphRegistry, type RelationDeclaration } from './vocabulary.js';
export { claimCanonicalForm, claimDigest, sha256Hex, type ByteSpan, type ClaimContent, type EvidenceSpan, type GraphId } from './digest.js';
export type { EdgeEntry, GraphLens, OutgoingDiff, Page, PageOptions, ClaimEntry, StateEntry } from './reads.js';
export type { PublishInput, PublishNode, PublishEdge, PublishEnd, PublishResult, PublishUnitInput, PublishUnitResult, UnitEdgeDraft, UnitEnd, UnitNodeDraft, WorkItemInput, LeaseInput, NodeRef } from './publish.js';
export { outerTransactionOf, type QueryExecutor } from './transaction.js';
export type { NewNodeVersion, NewEdgeVersion, NodePatch, EdgePatch, NodeVersionRow, EdgeVersionRow, EndResult } from './versions.js';

export interface GraphStoreOptions {
  /** The wall clock; defaults to `new Date()`. */
  now?: () => Date;
}

export class GraphStore {
  /** The last recorded instant this store handed out, in microseconds since the epoch. */
  private last = 0n;

  /**
   * The planner's statistics of the version tables (`statistics.ts`): every publication counts the versions
   * it wrote, and `refreshStatistics` runs `ANALYZE` when enough of them did.
   */
  readonly statistics: GraphStatistics;

  constructor(private readonly owner: DatabaseOwner, private readonly options: GraphStoreOptions = {}) {
    this.statistics = createGraphStatistics(owner);
  }

  private reading(): bigint {
    return BigInt((this.options.now ?? (() => new Date()))().getTime()) * 1000n;
  }

  /** The clock's reading, never before the last recorded instant. */
  private current(): bigint {
    const reading = this.reading();
    return reading > this.last ? reading : this.last;
  }

  private nowText(): string {
    return microsInstant(this.current());
  }

  /** The next recorded instant: strictly later than the previous one, in microseconds. */
  private tick(): string {
    const reading = this.reading();
    this.last = reading > this.last ? reading : this.last + 1n;
    return microsInstant(this.last);
  }

  /**
   * Runs a write. Recorded time is one instant for the whole transaction. When
   * another writer's clock was ahead of it (`GraphClockBehind`), the whole
   * write is retried with this store's clock moved past that instant, never
   * patched halfway; inside the caller's own transaction there is no retry.
   */
  private async write<T>(transaction: OuterTransaction | undefined, work: (ctx: WriteContext) => Promise<T>): Promise<T> {
    const context = (tx: OuterTransaction): WriteContext => ({ tx, at: this.tick(), now: () => this.nowText(), memo: writeMemo() });
    if (transaction !== undefined) return await work(context(transaction));
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.owner.transaction('write', (tx) => work(context(tx)));
      } catch (error) {
        if (!(error instanceof GraphClockBehind) || attempt >= 5) throw error;
        const behind = instantMicros(error.after) + 1n;
        if (behind > this.last) this.last = behind;
      }
    }
  }

  private async read<T>(transaction: OuterTransaction | undefined, work: (tx: OuterTransaction) => Promise<T>): Promise<T> {
    if (transaction !== undefined) return await work(transaction);
    return await this.owner.transaction('snapshot', work);
  }

  /** Creates the tables and the engine's vocabulary; a second call changes nothing. */
  async createSchema(): Promise<void> {
    await createGraphSchema(this.owner, this.tick());
  }

  /** Registers the product's kinds and relation types from the registry the caller passes. */
  registerVocabulary(registry: GraphRegistry, transaction?: OuterTransaction): Promise<{ kinds: number; relations: number }> {
    return this.write(transaction, (ctx) => registerVocabulary(ctx, registry));
  }

  /** Registers extractor-schema kinds and relation types (keys under `code.`) from what extractors emit. */
  registerCodeSchema(schema: GraphRegistry, transaction?: OuterTransaction): Promise<{ kinds: number; relations: number }> {
    return this.write(transaction, (ctx) => registerCodeSchema(ctx, schema));
  }

  /** A new node identity, which carries no knowledge until a version is opened. */
  newNode(transaction?: OuterTransaction): Promise<GraphId> {
    return this.write(transaction, (ctx) => newNodeIdentity(ctx));
  }

  openNode(input: NewNodeVersion, transaction?: OuterTransaction): Promise<{ nodeId: GraphId; versionId: GraphId }> {
    return this.write(transaction, (ctx) => openNodeVersion(ctx, input));
  }

  /** Closes the version's `recorded_to` and inserts the version now believed. */
  correctNode(versionId: GraphId, patch: NodePatch, transaction?: OuterTransaction): Promise<GraphId> {
    return this.write(transaction, (ctx) => correctNodeVersion(ctx, versionId, patch, { workItem: null, as: 'correction' }, null));
  }

  /** Ends a node's validity and closes, as recorded cascades, every edge that touches it beyond the end. */
  endNode(nodeId: GraphId, validTo: Parameters<typeof endNode>[2], transaction?: OuterTransaction): Promise<EndResult> {
    return this.write(transaction, (ctx) => endNode(ctx, nodeId, validTo, null));
  }

  openEdge(input: NewEdgeVersion, transaction?: OuterTransaction): Promise<{ edgeId: GraphId; versionId: GraphId }> {
    return this.write(transaction, (ctx) => openEdgeVersion(ctx, input));
  }

  correctEdge(versionId: GraphId, patch: EdgePatch, transaction?: OuterTransaction): Promise<GraphId> {
    return this.write(transaction, (ctx) => correctEdgeVersion(ctx, versionId, patch, { workItem: null, as: 'correction' }, null));
  }

  endEdge(versionId: GraphId, validTo: Parameters<typeof endNode>[2], transaction?: OuterTransaction): Promise<GraphId | null> {
    return this.write(transaction, (ctx) => endEdgeVersion(ctx, versionId, validTo, { workItem: null, as: 'correction' }));
  }

  /** Closes a version without replacing it: a removal that keeps the belief it held; a node's edges that lose their end are closed as recorded cascades, under the node's lock. */
  removeVersion(table: 'node_version' | 'edge_version', versionId: GraphId, transaction?: OuterTransaction): Promise<void> {
    return this.write(transaction, async (ctx) => {
      if (table === 'node_version') await removeNodeVersion(ctx, versionId, null);
      else await closeVersion(ctx, table, versionId, { workItem: null, as: 'correction' }, 'version');
    });
  }

  openWorkItem(input: WorkItemInput, transaction?: OuterTransaction): Promise<GraphId> {
    return this.write(transaction, (ctx) => openWorkItem(ctx, input));
  }

  leaseWorkItem(input: LeaseInput, transaction?: OuterTransaction): Promise<void> {
    return this.write(transaction, (ctx) => leaseWorkItem(ctx, input));
  }

  /** Publishes a unit's result in one transaction; see `publish.ts` for the fencing it enforces. */
  publish(input: PublishInput, transaction?: OuterTransaction): Promise<PublishResult> {
    return this.published(transaction, (ctx) => publish(ctx, input));
  }

  /**
   * Publishes one unit's nodes and edges: the scope its caller's key names, the
   * generation the store allocates, the publication lock, and `complete: true`,
   * all inside the caller's transaction (decision 0027's one atomic operation;
   * decision 0033, item 3). See `publishUnit` in `publish.ts`.
   */
  publishUnit(input: PublishUnitInput, transaction?: OuterTransaction): Promise<PublishUnitResult> {
    return this.published(transaction, (ctx) => publishUnit(ctx, input));
  }

  /**
   * Runs one publication, counts the versions it wrote towards the next statistics refresh, and — when this
   * store owns the transaction, so it has committed by the time `write` answers — refreshes them at once. A
   * publication inside a caller's transaction leaves the refresh to the caller, which knows when it committed
   * (`refreshStatistics`; the fill calls it when a unit's publication lands).
   */
  private async published<T extends PublishResult | PublishUnitResult>(transaction: OuterTransaction | undefined, work: (ctx: WriteContext) => Promise<T>): Promise<T> {
    const result = await this.write(transaction, work);
    const versions: PublishResult = 'publication' in result ? result.publication : result;
    this.statistics.note(versions.nodeVersionsOpened + versions.edgeVersionsOpened);
    if (transaction === undefined) await this.statistics.refresh();
    return result;
  }

  /**
   * `ANALYZE` of the version tables when the rows published since the last one make it due (`statistics.ts`),
   * or when a table that holds rows was never analyzed; null when nothing was due. A caller that published
   * inside its own transaction calls this after it commits, so the planner's estimates cover the rows that
   * publication wrote.
   */
  refreshStatistics(): Promise<StatisticsRefresh | null> {
    return this.statistics.refresh();
  }

  /** One node as the lens sees it, or null. */
  node(id: GraphId, lens?: GraphLens, transaction?: OuterTransaction): Promise<NodeVersionRow | null> {
    return this.read(transaction, async (tx) => await readNode(tx, id, await resolveLens(tx, lens, this.nowText())));
  }

  callers(node: GraphId, lens?: GraphLens, options?: PageOptions & { relation?: string }, transaction?: OuterTransaction): Promise<Page<EdgeEntry>> {
    return this.read(transaction, async (tx) => await readCallers(tx, node, await this.lens(tx, lens), options));
  }

  callees(node: GraphId, lens?: GraphLens, options?: PageOptions & { relation?: string }, transaction?: OuterTransaction): Promise<Page<EdgeEntry>> {
    return this.read(transaction, async (tx) => await readCallees(tx, node, await this.lens(tx, lens), options));
  }

  relationsWithin(repository: GraphId, relation: string, lens?: GraphLens, options?: PageOptions & { containment?: string }, transaction?: OuterTransaction): Promise<Page<EdgeEntry>> {
    return this.read(transaction, async (tx) => await readRelationsWithin(tx, repository, relation, await this.lens(tx, lens), options));
  }

  traverse(start: GraphId, relations: readonly string[], direction: 'out' | 'in', lens?: GraphLens, options?: PageOptions, transaction?: OuterTransaction): Promise<Page<NodeVersionRow>> {
    return this.read(transaction, async (tx) => await readTraversal(tx, start, relations, direction, await this.lens(tx, lens), options));
  }

  /** The as-is against to-be diff of a node's outgoing relations, whole. */
  outgoingDiff(node: GraphId, lens?: Pick<GraphLens, 'valid' | 'known'>, transaction?: OuterTransaction): Promise<OutgoingDiff> {
    return this.read(transaction, async (tx) => {
      const resolved = await resolveLens(tx, lens, this.nowText());
      return await readOutgoingDiff(tx, node, resolved);
    });
  }

  claims(lens?: GraphLens, options?: PageOptions, transaction?: OuterTransaction): Promise<Page<ClaimEntry>> {
    return this.read(transaction, async (tx) => await readClaims(tx, await this.lens(tx, lens), options));
  }

  stateChain(lens?: Pick<GraphLens, 'valid' | 'known'>, transaction?: OuterTransaction): Promise<StateEntry[]> {
    return this.read(transaction, async (tx) => {
      const resolved = await resolveLens(tx, { ...lens, state: 0 }, this.nowText());
      return await readStateChain(tx, resolved);
    });
  }

  /** The nodes whose current version carries the record key, in node id order, one bounded page. */
  byKey(key: string, options?: PageOptions, transaction?: OuterTransaction): Promise<Page<NodeVersionRow>> {
    return this.read(transaction, async (tx) => await readByKey(tx, key, await this.lens(tx, undefined), options));
  }

  /** The nodes of one kind whose current version carries `value` in the property `field`: one bounded page. */
  byProperty(kind: string, field: string, value: string, options?: PageOptions, transaction?: OuterTransaction): Promise<Page<NodeVersionRow>> {
    return this.read(transaction, async (tx) => await readByProperty(tx, kind, field, value, await this.lens(tx, undefined), options));
  }

  /** The symbols whose global name is `name`: the graph's own query by the name a reader of another file writes (0033). */
  byGlobalName(name: string, options?: PageOptions, transaction?: OuterTransaction): Promise<Page<NodeVersionRow>> {
    return this.byProperty('code.symbol', 'globalName', name, options, transaction);
  }

  /** One bounded page of the edges of one relation whose property carries a value. */
  edgesByProperty(relation: string, field: string, value: string, options?: PageOptions, transaction?: OuterTransaction): Promise<Page<EdgeEntry>> {
    return this.read(transaction, async (tx) => await readEdgesByProperty(tx, relation, field, value, await this.lens(tx, undefined), options));
  }

  /** One bounded page of the nodes reachable from `start` through `relations`, in node id order. */
  neighbourhood(start: GraphId, relations: readonly string[], direction: 'out' | 'in', options?: PageOptions, transaction?: OuterTransaction): Promise<Page<NodeVersionRow>> {
    return this.read(transaction, async (tx) => await readTraversal(tx, start, relations, direction, await this.lens(tx, undefined), options));
  }

  /** The bytes of a content node, or of a span of them, found by digest; null when no content has it. */
  contentBytes(contentSha256: string, span?: { start: number; end: number }, transaction?: OuterTransaction): Promise<Uint8Array | null> {
    return this.read(transaction, (tx) => readContentBytes(tx, contentSha256, span));
  }

  /** Every page of a paged read. */
  readAll<T>(fetch: (page: PageOptions) => Promise<Page<T>>): Promise<T[]> {
    return readAll(fetch);
  }

  private async lens(tx: OuterTransaction, lens: GraphLens | undefined) {
    return await resolveLens(tx, lens, this.nowText());
  }
}

export function createGraphStore(owner: DatabaseOwner, options: GraphStoreOptions = {}): GraphStore {
  return new GraphStore(owner, options);
}
