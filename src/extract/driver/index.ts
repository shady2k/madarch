/**
 * The extract driver of decision 0028: it walks the default branch's
 * first-parent history of one repository path, runs every deterministic
 * extractor (src/extract/*) over each commit's tree, and publishes each
 * extractor's `Extraction` into the graph store (src/graph) as one complete
 * publication — producer the extraction's own producer, scope the repository
 * node, generation the commit's place on the first-parent line, valid from
 * the commit's effective time (0028: `max(raw, parent effective + 1 µs)`,
 * strictly increasing along the first parent). Records the tree no longer
 * holds are ended by the publication's `complete` sweep at that same
 * instant; unchanged records write nothing, and a tree identical to the last
 * one published publishes nothing at all.
 *
 * A file's logical key is its path, so a rename is a new key. The driver
 * keeps one identity across git's rename detection (`-M`, R100 here) by
 * remapping the new key onto the old node's identity, as 0028's identity
 * section says; the store's rename succession then keeps the old belief up
 * to the rename and opens the new one from it.
 *
 * Refill. Every node version carries its record's logical key as the
 * `recordKey` property, so a refill recovers the key-to-identity map from the
 * store instead of minting second identities for the same records. A
 * generation already published with the same input digest is skipped whole,
 * which is what makes a second fill write no row; an unpublished one is
 * re-leased and published (a fill that was interrupted resumes). A
 * generation published with another input digest means the history changed
 * under a fixed generation number, and the fill refuses rather than rewrite
 * what the store already believes.
 *
 * Extractor-schema keys (under `code.`) are registered through
 * `registerCodeSchema` as they first appear in the walk. A relation type the
 * driver registers is declared discriminated, because the driver cannot see
 * whether a later commit emits parallel relations of it and an encoding is
 * never redeclared; `code.occurrence` keeps the store's own positioned
 * declaration, and every other record carries its reading site as the `span`
 * property rather than a position (0028: occurrences are positioned edges,
 * semantic edges aggregate their sites).
 *
 * The history extractor reads the repository rather than a tree
 * (src/extract/history); the driver hands it the repository's path and the
 * caller's pinned snapshots and publishes its records at the last commit,
 * under their own producer, as one generation per walk length. The extractors
 * this driver runs are wired in `extractors.ts`.
 */
import type { DatabaseOwner } from '../../adapters/database-owner.js';
import type { GraphId, GraphStore } from '../../graph/index.js';
import { sha256Hex } from '../../graph/index.js';
import type { GraphRegistry } from '../../graph/vocabulary.js';
import type { Extraction, SourceSpan, TreeReader } from '../records.js';
import { commitTree, walkDefaultBranch, type CommitFact } from './git.js';

export type { CommitFact } from './git.js';

/** The producer of the driver's own record: the repository node. */
export const DRIVER_PRODUCER = 'code.extract.driver';

/** A tree extractor: a pure function over one commit's tree (src/extract/*); it may be async. */
export type TreeExtractor = (tree: TreeReader) => Extraction | Promise<Extraction>;

/**
 * The history extractor's shape: it reads the repository's history itself, not
 * one tree, and takes the repository's path with the snapshots the caller
 * pins, each name to the revision it pins (src/extract/history).
 */
export type HistoryExtractor = (repository: { readonly path: string; readonly snapshots: Readonly<Record<string, string>> }) => Extraction | Promise<Extraction>;

export interface FillOptions {
  readonly owner: DatabaseOwner;
  readonly store: GraphStore;
  /** The repository path the walk reads. */
  readonly repository: string;
  /** The default branch to walk; the repository's `HEAD` by default. */
  readonly ref?: string;
  readonly extractors: readonly TreeExtractor[];
  /** The history records, published once, at the last commit, under their own producer. */
  readonly history?: HistoryExtractor;
  /** The snapshots the caller pins, each name to the revision it pins; handed to the history extractor. */
  readonly snapshots?: Readonly<Record<string, string>>;
  /** The clock the lease's end is read from; the real clock by default. */
  readonly now?: () => Date;
}

/** One commit's fill: what it cost and what it published. */
export interface CommitFill {
  readonly hash: string;
  readonly generation: number;
  readonly effectiveTime: string;
  readonly durationMs: number;
  readonly publications: number;
  readonly gaps: number;
}

export interface FillReport {
  readonly repositoryNode: GraphId;
  readonly commits: readonly CommitFill[];
  readonly totalMs: number;
  /** Every extraction's own gaps, per producer: what could not be read, said rather than left silent. */
  readonly gaps: readonly { readonly producer: string; readonly path: string; readonly reason: string }[];
}

const OCCURRENCE = 'code.occurrence';
const REPOSITORY_KIND = 'code.repository';

/** The reading site of a record, as one small property value. */
function spanProperty(span: SourceSpan): Record<string, unknown> {
  return { path: span.path, byteStart: span.byteStart, byteEnd: span.byteEnd, lineStart: span.lineStart, lineEnd: span.lineEnd };
}

/**
 * The key of a renamed record: the old path occurs in it as one whole path
 * part, bounded on both sides — before it the kind's `:`, a `/` between path
 * steps or a `#` before a following part; after it a `/`, a `#`, or the key's
 * end — and that part is replaced by the new path. A path that only occurs
 * inside another path (`vendor/services/orders/src/order.go` while
 * `services/orders/src/order.go` is renamed) is not a match: an unchanged
 * file keeps its identity.
 */
export function remapKey(key: string, from: string, to: string): string | null {
  let out = '';
  let at = 0;
  let changed = false;
  for (;;) {
    const found = key.indexOf(from, at);
    if (found < 0) {
      out += key.slice(at);
      break;
    }
    const end = found + from.length;
    const before = found > 0 ? key[found - 1]! : '';
    const after = end < key.length ? key[end]! : '';
    const bounded = (before === ':' || before === '/' || before === '#') && (after === '' || after === '/' || after === '#');
    if (!bounded) {
      out += key.slice(at, found + 1);
      at = found + 1;
      continue;
    }
    out += `${key.slice(at, found)}${to}`;
    at = end;
    changed = true;
  }
  return changed ? out : null;
}

/**
 * Applies one commit's renames to a producer's keys. Every key's text is
 * remapped through the whole rename list first (so a chain git detects within
 * one commit moves a key once, to its final path) and only then do the
 * entries move, so two records can never collapse onto one identity silently:
 * a collision refuses the fill, naming both.
 */
function applyRenames(map: Map<string, GraphId>, renames: readonly { readonly from: string; readonly to: string }[], where: string): void {
  if (renames.length === 0) return;
  const moved = new Map<string, GraphId[]>();
  for (const [key, id] of map) {
    let text: string = remapKey(key, renames[0]!.from, renames[0]!.to) ?? key;
    for (const { from, to } of renames.slice(1)) text = remapKey(text, from, to) ?? text;
    if (text === key) continue;
    const held = moved.get(text) ?? [];
    held.push(id);
    moved.set(text, held);
    map.delete(key);
  }
  for (const [key, ids] of moved) {
    if (ids.length > 1) throw new Error(`extract driver: ${where}: git's rename detection maps ${ids.length} records of producer onto the one key ${JSON.stringify(key)} (${ids.join(', ')}); an ambiguous match is never chosen silently`);
    if (map.has(key)) throw new Error(`extract driver: ${where}: git's rename detection moves a record onto the key ${JSON.stringify(key)} another record already holds; an ambiguous match is never chosen silently`);
    map.set(key, ids[0]!);
  }
}

/** One query through the owner, for what the store's own interface does not expose. */
async function query<Row extends object = Record<string, unknown>>(owner: DatabaseOwner, sql: string, values?: readonly unknown[]): Promise<Row[]> {
  return (await owner.run((tx) => tx.query<Row>(sql, values))).rows;
}

/** One producer's current keys: what the store believes now, held open-ended. */
class ProducerKeys {
  private keys: Map<string, GraphId> | null = null;

  constructor(private readonly load: () => Promise<Map<string, GraphId>>) {}

  async current(): Promise<Map<string, GraphId>> {
    if (this.keys === null) this.keys = await this.load();
    return this.keys;
  }
}

/** Fills the graph from one repository's default branch. See the module comment for the guarantees. */
export async function fillGraph(options: FillOptions): Promise<FillReport> {
  if (options.extractors.length === 0 && options.history === undefined) throw new Error(`extract driver: ${options.repository}: no extractor and no history was given, so nothing would be published`);
  const started = Date.now();
  const repository = options.repository;
  const walk = walkDefaultBranch(repository, options.ref ?? 'HEAD');
  const last = walk[walk.length - 1]!;
  const store = options.store;
  const owner = options.owner;
  const leaseToken = `driver:${last.hash}`;
  const leaseUntil = new Date((options.now ?? (() => new Date()))().getTime() + 6 * 60 * 60 * 1000);
  const gaps: { producer: string; path: string; reason: string }[] = [];
  const knownKinds = new Set<string>((await query<{ key: string }>(owner, `SELECT key FROM node_kind`)).map((row) => row.key));
  const knownRelations = new Set<string>((await query<{ key: string }>(owner, `SELECT key FROM relation_type`)).map((row) => row.key));
  const repositoryNode = await findOrCreateRepositoryNode(owner, store, repository, walk[0]!.effectiveTime);
  const keysOf = new Map<string, ProducerKeys>();
  const keys = async (producer: string): Promise<ProducerKeys> => {
    let held = keysOf.get(producer);
    if (held === undefined) {
      held = new ProducerKeys(async () => {
        const rows = await query<{ id: string; key: string }>(
          owner,
          `SELECT v.node_id::text AS id, v.properties->>'recordKey' AS key FROM node_version v
           WHERE v.producer = $1 AND v.scope_id = $2::bigint AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity' AND v.properties ? 'recordKey'`,
          [producer, repositoryNode],
        );
        return new Map(rows.map((row) => [row.key, row.id]));
      });
      keysOf.set(producer, held);
    }
    return held;
  };

  /** Registers the kinds and relation types an extraction newly emits. */
  const registerSchema = async (extraction: Extraction): Promise<void> => {
    const kinds = [...new Set(extraction.nodes.map((node) => node.kind))].filter((kind) => !knownKinds.has(kind));
    const relations = [...new Set(extraction.edges.map((edge) => edge.type))].filter((type) => !knownRelations.has(type));
    if (kinds.length === 0 && relations.length === 0) return;
    const schema: GraphRegistry = {
      kinds: kinds.sort(),
      relations: relations.sort().map((key) => ({ key, discriminated: true })),
    };
    await store.registerCodeSchema(schema);
    for (const kind of kinds) knownKinds.add(kind);
    for (const type of relations) knownRelations.add(type);
  };

  /** Runs the extractors over one commit's tree, naming the commit and the repository when one fails. */
  const runExtractors = async (commit: CommitFact, tree: TreeReader): Promise<Extraction[]> => {
    const extractions: Extraction[] = [];
    for (const extractor of options.extractors) {
      try {
        extractions.push(await extractor(tree));
      } catch (error) {
        const name = extractor.name === '' ? 'an unnamed extractor' : `the extractor "${extractor.name}"`;
        throw new Error(`extract driver: ${name} failed over commit ${commit.hash} ("${commit.subject}", generation ${commit.generation}) of ${repository}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    return extractions;
  };

  /** Publishes one extraction as one complete publication of its producer at one instant. */
  const publishExtraction = async (extraction: Extraction, generation: number, effectiveTime: string, renames: readonly { from: string; to: string }[], inputDigest: string, where: string): Promise<boolean> => {
    const through = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('extract driver:')) throw error;
        throw new Error(`extract driver: ${step} failed for producer "${extraction.producer}" over ${where}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    };
    await through('registering the extractor schema', () => registerSchema(extraction));
    for (const gap of extraction.gaps) gaps.push({ producer: extraction.producer, path: gap.path, reason: gap.reason });
    const map = await (await keys(extraction.producer)).current();
    const found = await query<{ input_digest: string; published: boolean }>(
      owner,
      `SELECT input_digest, published_at IS NOT NULL AS published FROM work_item WHERE producer = $1 AND scope_id = $2::bigint AND generation = $3::bigint`,
      [extraction.producer, repositoryNode, String(generation)],
    );
    if (found.length > 1) throw new Error(`extract driver: ${repository}: the store holds ${found.length} work items for producer "${extraction.producer}" and generation ${generation}, where one is possible`);
    const existing = found[0];
    if (existing !== undefined && existing.published) {
      if (existing.input_digest !== inputDigest) {
        throw new Error(`extract driver: ${repository}: generation ${generation} of producer "${extraction.producer}" was published with input digest ${existing.input_digest}, but the walk now reads ${inputDigest}: the history changed under a fixed generation number, and what the store already believes is not rewritten`);
      }
      return false; // already published, exactly this input: a refill writes nothing, and the map the store recovered already knows every published rename
    }
    // The renames are applied only for a generation this fill publishes: a skipped generation's renames are already in the map the store recovered.
    applyRenames(map, renames, where);
    if (existing === undefined) {
      await through('opening the work item', () => store.openWorkItem({ producer: extraction.producer, scope: repositoryNode, generation, inputDigest, leaseToken, leaseUntil }));
    } else {
      await through('leasing the work item', () => store.leaseWorkItem({ producer: extraction.producer, scope: repositoryNode, generation, leaseToken, leaseUntil, inputDigest }));
    }
    const nodes = extraction.nodes.map((node) => ({
      ...(map.has(node.key) ? { id: map.get(node.key)! } : {}),
      ref: node.key,
      kind: node.kind,
      label: node.label,
      properties: { ...node.properties, ...(node.span === undefined ? {} : { span: spanProperty(node.span) }), recordKey: node.key },
      validFrom: effectiveTime,
    }));
    // Two records of one relation between the same ends would publish as one
    // edge (the second correcting the first), which is a smaller result than
    // the extraction made; the record contract's span or discriminator has to
    // tell them apart, and a fill refuses rather than choose silently.
    const seenEdges = new Map<string, string>();
    for (const edge of extraction.edges) {
      const logicalKey = `${edge.type}\u0000${edge.from}\u0000${edge.to}\u0000${edge.discriminator}`;
      const first = seenEdges.get(logicalKey);
      if (first !== undefined) {
        throw new Error(`extract driver: ${where}: producer "${extraction.producer}" emits ${edge.type} from ${edge.from} to ${edge.to} (discriminator ${JSON.stringify(edge.discriminator)}) twice — first span ${first}, again ${edge.span === undefined ? 'none' : `bytes ${edge.span.byteStart}-${edge.span.byteEnd} of ${edge.span.path}`}; the record contract's span or discriminator must tell parallel relations apart`);
      }
      seenEdges.set(logicalKey, edge.span === undefined ? 'none' : `bytes ${edge.span.byteStart}-${edge.span.byteEnd} of ${edge.span.path}`);
    }
    const publishedEdges = extraction.edges.map((edge) => {
      if (edge.type === OCCURRENCE && edge.span === undefined) {
        throw new Error(`extract driver: ${where}: producer "${extraction.producer}" emits an occurrence edge (${edge.from} -> ${edge.to}) without the span that positions it`);
      }
      return {
        relation: edge.type,
        src: { ref: edge.from },
        dst: { ref: edge.to },
        ...(edge.discriminator === '' ? {} : { discriminator: edge.discriminator }),
        ...(edge.type === OCCURRENCE ? { position: { start: edge.span!.byteStart, end: edge.span!.byteEnd } } : {}),
        properties: { ...edge.properties, ...(edge.span === undefined || edge.type === OCCURRENCE ? {} : { span: spanProperty(edge.span) }) },
        validFrom: effectiveTime,
      };
    });
    const result = await through('publishing', () => store.publish({
      producer: extraction.producer,
      scope: repositoryNode,
      generation,
      leaseToken,
      inputDigest,
      nodes,
      edges: publishedEdges,
      complete: { validTo: effectiveTime },
    }));
    if (!result.unchangedInput) {
      for (const [key, id] of Object.entries(result.refs)) map.set(key, id);
      const held = new Set(extraction.nodes.map((node) => node.key));
      for (const key of [...map.keys()]) if (!held.has(key)) map.delete(key);
    }
    return true;
  };

  const commits: CommitFill[] = [];
  for (const commit of walk) {
    const commitStarted = Date.now();
    const tree = commitTree(repository, commit.hash);
    const extractions = await runExtractors(commit, tree);
    let publications = 0;
    let gapCount = 0;
    for (const extraction of extractions) {
      const inputDigest = sha256Hex(new TextEncoder().encode(`${commit.hash}\n${commit.tree}`));
      const published = await publishExtraction(extraction, commit.generation, commit.effectiveTime, commit.renames, inputDigest, `commit ${commit.hash} ("${commit.subject}", generation ${commit.generation}) of ${repository}`);
      if (published) publications += 1;
      gapCount += extraction.gaps.length;
    }
    commits.push({ hash: commit.hash, generation: commit.generation, effectiveTime: commit.effectiveTime, durationMs: Date.now() - commitStarted, publications, gaps: gapCount });
  }

  if (options.history !== undefined) {
    let extraction: Extraction;
    try {
      extraction = await options.history({ path: repository, snapshots: options.snapshots ?? {} });
    } catch (error) {
      throw new Error(`extract driver: the history extractor failed over ${repository} (${walk.length} first-parent commits): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const inputDigest = sha256Hex(new TextEncoder().encode(walk.map((commit) => `${commit.hash} ${commit.committerTime} ${commit.effectiveTime}`).join('\n')));
    await publishExtraction(extraction, walk.length, last.effectiveTime, [], inputDigest, `the history of ${repository} (${walk.length} first-parent commits)`);
  }

  return { repositoryNode, commits, totalMs: Date.now() - started, gaps };
}

/** The repository node of one repository path: found by its `path` property, or made once. */
async function findOrCreateRepositoryNode(owner: DatabaseOwner, store: GraphStore, repository: string, firstEffective: string): Promise<GraphId> {
  const found = await query<{ id: string }>(
    owner,
    `SELECT v.node_id::text AS id FROM node_version v JOIN node_kind k ON k.id = v.kind_id
     WHERE k.key = $1 AND v.producer = $2 AND v.properties->>'path' = $3 AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity'
     ORDER BY v.node_id`,
    [REPOSITORY_KIND, DRIVER_PRODUCER, repository],
  );
  if (found.length > 1) throw new Error(`extract driver: ${repository}: the store holds ${found.length} repository nodes of producer "${DRIVER_PRODUCER}" with this path (${found.map((row) => row.id).join(', ')}); a repository path names one node`);
  if (found.length === 1) return found[0]!.id;
  let nodeId: GraphId;
  let opened: { nodeId: GraphId; versionId: GraphId };
  try {
    nodeId = await store.newNode();
    opened = await store.openNode({
      nodeId,
      kind: REPOSITORY_KIND,
      label: repository.slice(repository.lastIndexOf('/') + 1),
      properties: { path: repository },
      validFrom: firstEffective,
      owner: { producer: DRIVER_PRODUCER, scope: nodeId },
    });
  } catch (error) {
    throw new Error(`extract driver: making the repository node of ${repository} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return opened.nodeId;
}
