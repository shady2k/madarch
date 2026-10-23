/**
 * The extract driver of decisions 0028 and 0030: it reads the default
 * branch's first-parent history of one repository path, parses the code of
 * the last commit only, reads the history facts from `git log`, and parses
 * the code of earlier commits only at the points the caller chose. Every
 * extractor's `Extraction` is published into the graph store (src/graph) as
 * one complete publication — producer the extraction's own producer, scope
 * the repository node.
 *
 * What is read when (0030).
 * - The tip: the trees extractors run over the last commit once. Their
 *   records are valid from that commit's effective time (0028: `max(raw,
 *   parent effective + 1 µs)`, strictly increasing along the first parent)
 *   and stay open-ended until a later fill moves the tip: the next fill ends
 *   what the new tip does not repeat at the new tip's effective time. When
 *   the new tip is more than one commit after the old one, the old tip's
 *   records first end at the effective time of the commit that followed it,
 *   so the graph never claims the old state for commits nobody read.
 * - The history: the history extractor reads every first-parent commit from
 *   `git log` without parsing code, and publishes once at the tip's time
 *   under its own producer. Per-commit times are the commit records' own
 *   `committedAt` and `effectiveAt` properties.
 * - Chosen points (`points`): the trees extractors also run over each chosen
 *   commit, and publish records valid exactly from that commit's effective
 *   time to the effective time of the next first-parent commit (the tree is
 *   that commit's, until the next one). A point inside a range other records
 *   of the producer already cover is refused, naming both.
 *
 * Generations. A tree publication of the commit at place `n` on the line is
 * generation `2n`; the publication that ends a tip's records early is
 * generation `2n + 1`. A generation already published with the same input
 * digest is skipped whole, which is what makes a second fill write no row; an
 * unpublished one is re-leased and published (a fill that was interrupted
 * resumes). A generation published with another input digest means the
 * history changed under a fixed generation number, and the fill refuses
 * rather than rewrite what the store already believes.
 *
 * A file's logical key is its path, so a rename is a new key. The driver
 * keeps one identity across git's rename detection (`-M`, R100 here) by
 * remapping the new key onto the old node's identity, as 0028's identity
 * section says; a later fill applies the renames of every commit between the
 * old tip and the new one, and a chosen point finds the identity of a record
 * by following the renames after it forward.
 *
 * Every node version carries its record's logical key as the `recordKey`
 * property, so a refill recovers the key-to-identity map from the store
 * instead of minting second identities for the same records.
 *
 * Extractor-schema keys (under `code.`) are registered through
 * `registerCodeSchema` as they first appear. A relation type the driver
 * registers is declared discriminated, because the driver cannot see whether
 * a later commit emits parallel relations of it and an encoding is never
 * redeclared; `code.occurrence` keeps the store's own positioned declaration,
 * and every other record carries its reading site as the `span` property
 * rather than a position (0028: occurrences are positioned edges, semantic
 * edges aggregate their sites).
 *
 * The extractors this driver runs are wired in `extractors.ts`.
 */
import type { DatabaseOwner } from '../../adapters/database-owner.js';
import type { GraphId, GraphStore } from '../../graph/index.js';
import { sha256Hex } from '../../graph/index.js';
import type { GraphRegistry } from '../../graph/vocabulary.js';
import type { Extraction, SourceSpan, TreeReader } from '../records.js';
import { commitTree, resolvePoint, walkDefaultBranch, type CommitFact, type FillPoint } from './git.js';

export type { CommitFact, FillPoint } from './git.js';

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
  /**
   * Node ownership: each kind named here has exactly one owning producer, the
   * only one that publishes versions of nodes of that kind. Another producer's
   * node of the kind is dropped by the driver and its edges end at the owner's
   * node; see `publishExtraction`. The owners publish first within a commit,
   * in the order this list holds them (an owner of a later kind may name an
   * earlier owner's nodes). Kinds not named have no owner and publish as before.
   */
  readonly owners?: Readonly<Record<string, string>>;
  /** The history records, published once, at the last commit, under their own producer. */
  readonly history?: HistoryExtractor;
  /** The snapshots the caller pins, each name to the revision it pins; handed to the history extractor. */
  readonly snapshots?: Readonly<Record<string, string>>;
  /**
   * The points whose code structure is read besides the last commit's (0030):
   * release tags or dates. Each is a revision on the first-parent line or a
   * `{ date }`; a point equal to the last commit adds nothing. Filled after the
   * tip and the history, in the order of their place on the line.
   */
  readonly points?: readonly FillPoint[];
  /** The clock the lease's end is read from; the real clock by default. */
  readonly now?: () => Date;
  /**
   * Told once the walk is read and the repository node exists, before the
   * code is read: the repository node and how many commits the walk holds. A
   * caller that shows the fill as it goes (the wiki) learns from it which node
   * is this repository.
   */
  readonly onStart?: (start: { readonly repositoryNode: GraphId; readonly commits: number; readonly head: string }) => void | Promise<void>;
  /**
   * Told when a phase begins (added by 0030, so nothing renames): `code` reads
   * the last commit's code, `history` reads the git log of every first-parent
   * commit (`commits` of them; `newCommits` since the last filled tip) and
   * `points` reads the chosen points' code.
   */
  readonly onPhase?: (phase: { readonly phase: 'code' | 'history' | 'points'; readonly commits: number; readonly newCommits: number }) => void | Promise<void>;
  /**
   * Told once the last commit's code is published, with its place in the walk
   * (`index` is the walk's length: the last commit is the one whose code is
   * read). The caller may throw to stop the fill here: what is published
   * stays published, and a refill resumes.
   */
  readonly onCommit?: (done: CommitFill, place: { readonly index: number; readonly commits: number }) => void | Promise<void>;
  /** Told after each chosen point's code is published, with the point's place on the line. */
  readonly onPoint?: (done: CommitFill, place: { readonly index: number; readonly commits: number }) => void | Promise<void>;
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
  /** The commits whose code this fill read: the last commit, which a fill that finds it already filled leaves with no publication. */
  readonly commits: readonly CommitFill[];
  /** The chosen points whose code this fill read, in their order on the line. */
  readonly points: readonly CommitFill[];
  /** First-parent commits after the last tip an earlier fill published (all of them on the first fill). */
  readonly newCommits: number;
  /** First-parent commits the history reading covered. */
  readonly historyCommits: number;
  /** Where the time went, by phase. */
  readonly phases: { readonly codeMs: number; readonly historyMs: number; readonly pointsMs: number };
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
 * The key of a renamed record: the old path occurs in it as one whole record
 * part — before it the kind's `:` or the `#` that opens a following part, so
 * the match begins a part and never sits inside a longer path; after it a
 * `/`, a `#`, or the key's end — and that part is replaced by the new path.
 * A path that only occurs inside another path
 * (`vendor/services/orders/src/order.go` while `services/orders/src/order.go`
 * is renamed) is not a match: an unchanged file keeps its identity.
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
    const bounded = (before === ':' || before === '#') && (after === '' || after === '/' || after === '#');
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

/** How an extraction is published: as the tip (open-ended, sweeping what it does not repeat) or as a chosen point (bounded to the next commit). */
type PublishMode =
  | { readonly kind: 'tip'; readonly closeGap: boolean; readonly renames: boolean; readonly verifyPrior: boolean }
  | { readonly kind: 'point'; readonly bound: string };

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
  // The chosen points, resolved before anything is read so a point that names no commit stops the fill at once.
  const chosen = [...new Map((options.points ?? []).map((point) => resolvePoint(repository, walk, point)).filter((commit) => commit.hash !== last.hash).map((commit) => [commit.hash, commit])).values()].sort((a, b) => a.generation - b.generation);
  const filledPlaces = await query<{ place: string | null }>(owner, `SELECT max(generation)::text AS place FROM work_item WHERE scope_id = $1::bigint AND published_at IS NOT NULL AND generation % 2 = 0`, [repositoryNode]);
  const filledPlace = filledPlaces[0]?.place == null ? 0 : Number(filledPlaces[0].place) / 2;
  if (filledPlace > walk.length) throw new Error(`extract driver: ${repository}: the store holds a fill of the commit at place ${filledPlace} of the first-parent line, but the walk now holds ${walk.length} commits: the history changed under a fixed generation number, and what the store already believes is not rewritten`);
  /** First-parent commits after the last tip an earlier fill published. */
  const newCommits = walk.length - filledPlace;
  await options.onStart?.({ repositoryNode, commits: walk.length, head: last.hash });
  const keysOf = new Map<string, ProducerKeys>();
  /** A tree publication of the commit at place `n` is generation `2n`; the one that ends a tip early is `2n + 1` (module comment). */
  const storeGeneration = (place: number): number => 2 * place;
  /** The latest tip a producer published before a generation: its place on the line and the input digest it was published with. */
  const priorTipOf = async (producer: string, below: number): Promise<{ place: number; inputDigest: string } | undefined> => {
    const rows = await query<{ generation: string; input_digest: string }>(
      owner,
      `SELECT generation::text AS generation, input_digest FROM work_item
       WHERE producer = $1 AND scope_id = $2::bigint AND published_at IS NOT NULL AND generation % 2 = 0 AND generation < $3::bigint
       ORDER BY generation DESC LIMIT 1`,
      [producer, repositoryNode, String(below)],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const place = Number(row.generation) / 2;
    if (place > walk.length) {
      throw new Error(`extract driver: ${repository}: producer "${producer}" published the commit at place ${place} of the first-parent line, but the walk now holds ${walk.length} commits: the history changed under a fixed generation number, and what the store already believes is not rewritten`);
    }
    return { place, inputDigest: row.input_digest };
  };
  const keys = async (producer: string): Promise<ProducerKeys> => {
    let held = keysOf.get(producer);
    if (held === undefined) {
      held = new ProducerKeys(async () => {
        // The state of the producer's latest tip: the versions that hold at the tip's effective time, whether they are still open or a later fill ended them.
        const prior = await priorTipOf(producer, Number.MAX_SAFE_INTEGER);
        if (prior === undefined) return new Map();
        const rows = await query<{ id: string; key: string }>(
          owner,
          `SELECT v.node_id::text AS id, v.properties->>'recordKey' AS key FROM node_version v
           WHERE v.producer = $1 AND v.scope_id = $2::bigint AND v.recorded_to = 'infinity' AND v.valid_from <= $3::timestamptz AND v.valid_to > $3::timestamptz AND v.properties ? 'recordKey'`,
          [producer, repositoryNode, walk[prior.place - 1]!.effectiveTime],
        );
        return new Map(rows.map((row) => [row.key, row.id]));
      });
      keysOf.set(producer, held);
    }
    return held;
  };
  /**
   * The identities of a chosen point's records. Every key, stored or wanted, is
   * carried forward through the renames git detected after its place on the
   * line to the key it ends with; two keys that end alike are one thing, so a
   * file moved after the point, or moved between two points and deleted since,
   * keeps one node. A stored key stands at the place its version began.
   */
  const pointIds = async (producer: string, wanted: readonly string[], place: number): Promise<Map<string, GraphId>> => {
    if (wanted.length === 0) return new Map();
    const renameCommits = walk.filter((commit) => commit.renames.length > 0);
    const forward = (key: string, at: number): string => {
      let text = key;
      for (const commit of renameCommits) {
        if (commit.generation <= at) continue;
        for (const { from, to } of commit.renames) text = remapKey(text, from, to) ?? text;
      }
      return text;
    };
    const placeAt = (instant: string): number => {
      let low = 0;
      let high = walk.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (walk[middle]!.effectiveTime <= instant) low = middle + 1;
        else high = middle;
      }
      return Math.max(low, 1);
    };
    const rows = await query<{ id: string; key: string; valid_from: string }>(
      owner,
      `SELECT v.node_id::text AS id, v.properties->>'recordKey' AS key, to_char(v.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from FROM node_version v
       WHERE v.producer = $1 AND v.scope_id = $2::bigint AND v.recorded_to = 'infinity' AND v.properties ? 'recordKey' ORDER BY v.valid_from`,
      [producer, repositoryNode],
    );
    const ending = new Map<string, GraphId>(); // later versions overwrite earlier ones
    for (const row of rows) ending.set(forward(row.key, placeAt(row.valid_from)), row.id);
    const found = new Map<string, GraphId>();
    for (const key of wanted) {
      const id = ending.get(forward(key, place));
      if (id !== undefined) found.set(key, id);
    }
    return found;
  };
  let pointMaps = new Map<string, Map<string, GraphId>>();

  /** Registers the kinds and relation types an extraction newly emits, and the kinds of the ends it opens for another producer's keys. */
  const registerSchema = async (extraction: Extraction, extraKinds: readonly string[] = []): Promise<void> => {
    const kinds = [...new Set([...extraction.nodes.map((node) => node.kind), ...extraKinds])].filter((kind) => !knownKinds.has(kind));
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

  /**
   * Ends a producer's tip at the effective time of the commit that followed it,
   * as generation `2n + 1` of the tip's place `n`: a later fill that skips
   * commits must not leave the old tip's records standing over commits nobody
   * read. Published once; a fill that was interrupted here resumes.
   */
  const closeTip = async (producer: string, place: number): Promise<void> => {
    const old = walk[place - 1]!;
    const next = walk[place]!;
    const generation = 2 * place + 1;
    const inputDigest = sha256Hex(new TextEncoder().encode(`end\n${old.hash}\n${next.hash}`));
    const where = `ending the tip at ${old.hash} ("${old.subject}", generation ${old.generation}) of ${repository} at commit ${next.hash}`;
    const found = await query<{ input_digest: string; published: boolean }>(
      owner,
      `SELECT input_digest, published_at IS NOT NULL AS published FROM work_item WHERE producer = $1 AND scope_id = $2::bigint AND generation = $3::bigint`,
      [producer, repositoryNode, String(generation)],
    );
    const existing = found[0];
    if (existing?.published === true) {
      if (existing.input_digest !== inputDigest) throw new Error(`extract driver: ${repository}: ${where} was published for producer "${producer}" with input digest ${existing.input_digest}, but the walk now reads ${inputDigest}: the history changed under a fixed generation number, and what the store already believes is not rewritten`);
      return;
    }
    try {
      if (existing === undefined) await store.openWorkItem({ producer, scope: repositoryNode, generation, inputDigest, leaseToken, leaseUntil });
      else await store.leaseWorkItem({ producer, scope: repositoryNode, generation, leaseToken, leaseUntil, inputDigest });
      await store.publish({ producer, scope: repositoryNode, generation, leaseToken, inputDigest, nodes: [], edges: [], complete: { validTo: next.effectiveTime } });
    } catch (error) {
      throw new Error(`extract driver: ${where} failed for producer "${producer}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };

  /** Publishes one extraction as one complete publication of its producer at one instant. */
  const publishExtraction = async (extraction: Extraction, present: ReadonlyMap<string, Extraction>, place: number, effectiveTime: string, inputDigest: string, mode: PublishMode, where: string): Promise<boolean> => {
    const generation = storeGeneration(place);
    const bound = mode.kind === 'point' ? mode.bound : undefined;
    const through = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('extract driver:')) throw error;
        throw new Error(`extract driver: ${step} failed for producer "${extraction.producer}" over ${where}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    };
    // Ownership. A kind with an owning producer that took part in this commit is
    // published by that owner only: this producer's own node of the kind is
    // dropped, and its properties stay only where the owner lacks them, as a
    // node of this producer's own (`code.facet`) tied to the owner's node by a
    // `code.facet-of` edge. An edge end of such a kind is the owner's node.
    const owners = options.owners ?? {};
    const ownerNode = (owner: string, key: string) => present.get(owner)!.nodes.find((node) => node.key === key);
    /** The owner of a key whose node the owner holds in this commit; a key the owner lacks stays this producer's own reference node. */
    const ownerOf = (key: string): string | undefined => {
      const kind = key.slice(0, key.indexOf(':'));
      const owner = owners[kind];
      return owner !== undefined && owner !== extraction.producer && present.has(owner) && ownerNode(owner, key) !== undefined ? owner : undefined;
    };
    const ownedKind = (key: string): string | undefined => {
      const owner = owners[key.slice(0, key.indexOf(':'))];
      return owner !== undefined && owner !== extraction.producer && present.has(owner) ? owner : undefined;
    };
    const dangling = new Set<string>();
    for (const key of [...extraction.nodes.map((node) => node.key), ...extraction.edges.flatMap((edge) => [edge.from, edge.to])]) {
      const owner = ownedKind(key);
      if (owner !== undefined && ownerOf(key) === undefined && !dangling.has(key)) {
        dangling.add(key);
        gaps.push({ producer: extraction.producer, path: key, reason: `${key} has no node of its owner "${owner}" at this commit, so it stays a reference node of this producer` });
      }
    }
    const ownKept = extraction.nodes.filter((node) => ownerOf(node.key) === undefined);
    const facets: { node: Extraction['nodes'][number] }[] = [];
    for (const node of extraction.nodes) {
      const owner = ownerOf(node.key);
      if (owner === undefined) continue;
      const held = ownerNode(owner, node.key)!;
      const extra = Object.fromEntries(Object.entries(node.properties).filter(([name]) => !(name in held.properties)));
      for (const [name, value] of Object.entries(node.properties)) {
        if (name in held.properties && JSON.stringify(held.properties[name]) !== JSON.stringify(value)) {
          gaps.push({ producer: extraction.producer, path: node.key, reason: `property "${name}" is ${JSON.stringify(value)} here but ${JSON.stringify(held.properties[name])} in the owner "${owner}"; the owner's value stands` });
        }
      }
      if (Object.keys(extra).length === 0) continue;
      // A facet is named by the file it is about and its owner, so two producers' facets of two same-named things do not
      // read alike; its place is the place of the node it describes, where that node has one (madarch-m38l.16).
      const described = node.span ?? held.span;
      const pathOfOwner = node.key.startsWith('code.file:') ? node.key.slice('code.file:'.length) : described?.path;
      facets.push({
        node: {
          key: `code.facet:${extraction.producer}#${node.key}`,
          kind: 'code.facet',
          label: pathOfOwner === undefined ? node.label : `${node.label} · ${pathOfOwner}`,
          properties: { ...extra, ownerKey: node.key },
          ...(described === undefined ? {} : { span: described }),
        },
      });
    }
    const effective: Extraction = {
      ...extraction,
      nodes: [...ownKept, ...facets.map((facet) => facet.node)],
      edges: [...extraction.edges, ...facets.flatMap((facet) => {
        const ownerKey = String(facet.node.properties['ownerKey']);
        const path = facet.node.span?.path ?? (ownerKey.startsWith('code.file:') ? ownerKey.slice('code.file:'.length) : undefined);
        return [
          { type: 'code.facet-of' as const, from: facet.node.key, to: ownerKey, discriminator: '', properties: {} },
          ...(path === undefined ? [] : [{type: 'code.describes-file' as const, from: facet.node.key, to: `code.file:${path}`, discriminator: '', properties: {}}]),
        ];
      })],
    };
    const foreignKinds = [...new Set(effective.edges.flatMap((edge) => [edge.from, edge.to]).filter((key) => !effective.nodes.some((node) => node.key === key)).map((key) => key.slice(0, key.indexOf(':'))))].filter((kind) => kind.startsWith('code.'));
    await through('registering the extractor schema', () => registerSchema(effective, foreignKinds));
    for (const gap of extraction.gaps) gaps.push({ producer: extraction.producer, path: gap.path, reason: gap.reason });
    const wantedKeys = [...new Set([...effective.nodes.map((node) => node.key), ...effective.edges.flatMap((edge) => [edge.from, edge.to])])];
    const map = mode.kind === 'tip' ? await (await keys(extraction.producer)).current() : new Map(await pointIds(extraction.producer, wantedKeys, place));
    if (mode.kind === 'point') pointMaps.set(extraction.producer, map);
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
    if (mode.kind === 'point') {
      // A point's records stand between two commits; refuse rather than overlap what the producer already believes there.
      const clash = await query<{ valid_from: string; valid_to: string }>(
        owner,
        `SELECT to_char(v.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from, to_char(v.valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_to FROM node_version v
         WHERE v.producer = $1 AND v.scope_id = $2::bigint AND v.recorded_to = 'infinity' AND v.valid_from < $4::timestamptz AND v.valid_to > $3::timestamptz LIMIT 1`,
        [extraction.producer, repositoryNode, effectiveTime, mode.bound],
      );
      if (clash[0] !== undefined) {
        throw new Error(`extract driver: ${where}: the point stands between ${effectiveTime} and ${mode.bound}, but producer "${extraction.producer}" already holds a version valid from ${clash[0].valid_from} to ${clash[0].valid_to} inside it; a snapshot never overlaps what is already believed`);
      }
    } else {
      const prior = await priorTipOf(extraction.producer, generation);
      if (prior !== undefined && mode.verifyPrior) {
        const old = walk[prior.place - 1]!;
        const expected = sha256Hex(new TextEncoder().encode(`${old.hash}\n${old.tree}`));
        if (prior.inputDigest !== expected) {
          throw new Error(`extract driver: ${repository}: place ${prior.place} of the first-parent line was published by producer "${extraction.producer}" with input digest ${prior.inputDigest}, but the walk now reads ${expected} there: the history changed under a fixed generation number, and what the store already believes is not rewritten`);
        }
      }
      if (prior !== undefined && mode.closeGap && prior.place < place - 1) await closeTip(extraction.producer, prior.place);
      // The renames of every commit after the prior tip, up to this one, are applied only for a generation this fill publishes: a skipped generation's renames are already in the map the store recovered.
      if (prior !== undefined && mode.renames) for (const commit of walk.slice(prior.place, place)) applyRenames(map, commit.renames, where);
    }
    if (existing === undefined) {
      await through('opening the work item', () => store.openWorkItem({ producer: extraction.producer, scope: repositoryNode, generation, inputDigest, leaseToken, leaseUntil }));
    } else {
      await through('leasing the work item', () => store.leaseWorkItem({ producer: extraction.producer, scope: repositoryNode, generation, leaseToken, leaseUntil, inputDigest }));
    }
    // The record contract's keys are one space across extractors: an edge may
    // name a node another extractor owns (contracts' `code.file:` ends). A
    // publication is self-contained, so an end this producer's map does not
    // hold and this extraction does not declare is opened here as a node of
    // this producer, with the kind its key names; the same logical key may
    // then exist under two producers, which the per-producer rule above
    // already allows.
    const ownerKeyMaps = new Map<string, Map<string, GraphId>>();
    for (const owner of new Set(Object.values(owners))) if (owner !== extraction.producer && present.has(owner)) ownerKeyMaps.set(owner, mode.kind === 'tip' ? await (await keys(owner)).current() : (pointMaps.get(owner) ?? new Map()));
    const declared = new Set(effective.nodes.map((node) => node.key));
    const ownedIds = new Map<string, GraphId>();
    const foreignEnds = [...new Set(effective.edges.flatMap((edge) => [edge.from, edge.to]))]
      .filter((key) => !declared.has(key))
      .sort()
      .filter((key) => {
        const owner = ownerOf(key);
        if (owner === undefined) return true;
        const id = ownerKeyMaps.get(owner)?.get(key);
        if (id === undefined) throw new Error(`extract driver: ${where}: the owner "${owner}" holds a node for ${key} in this commit but published no identity for it`);
        ownedIds.set(key, id);
        return false;
        return true;
      });
    // Every node any extraction declared for a key, the first with a span winning: a reference node takes the place of
    // the node that named it (madarch-m38l.16).
    // The place an edge names for a node it refers to: a reference node carries it when nothing declares the node.
    const edgeSpans = new Map<string, SourceSpan>();
    for (const edge of effective.edges) {
      if (edge.span === undefined) continue;
      if (!edgeSpans.has(edge.from)) edgeSpans.set(edge.from, edge.span);
      if (!edgeSpans.has(edge.to)) edgeSpans.set(edge.to, edge.span);
    }
    const declaredNodes = new Map<string, {label: string; span?: SourceSpan}>();
    for (const node of extraction.nodes) {
      const held = declaredNodes.get(node.key);
      if (held !== undefined && held.span !== undefined) continue;
      declaredNodes.set(node.key, {...(held ?? {label: node.label}), ...(node.span === undefined ? {} : {span: node.span})});
    }
    const stubOf = (key: string) => {
      const kind = key.slice(0, key.indexOf(':'));
      if (!kind.startsWith('code.')) {
        throw new Error(`extract driver: ${where}: producer "${extraction.producer}" names the edge end ${JSON.stringify(key)}, whose kind prefix is no extractor-schema key, and no node of this extraction declares it`);
      }
      return { key, kind, label: key.slice(key.lastIndexOf('/') + 1) };
    };
    const nodes = [
      ...effective.nodes.map((node) => ({
        ...(map.has(node.key) ? { id: map.get(node.key)! } : {}),
        ref: node.key,
        kind: node.kind,
        label: node.label,
        properties: { ...node.properties, ...(node.span === undefined ? {} : { span: spanProperty(node.span) }), recordKey: node.key },
        validFrom: effectiveTime,
        ...(bound === undefined ? {} : { validTo: bound }),
      })),
      ...foreignEnds.map((key) => {
        const stub = stubOf(key);
        // A reference node names a place when any extraction declared one for the key: a file a later commit renamed
        // away has no owner node at this tip, and the history's own record of it says where it stood.
        const declared = declaredNodes.get(key);
        const place = declared?.span ?? edgeSpans.get(key);
        return {
          ...(map.has(key) ? { id: map.get(key)! } : {}),
          ref: key,
          kind: stub.kind,
          label: declared?.label ?? stub.label,
          properties: { recordKey: key, ...(place === undefined ? {} : { span: spanProperty(place) }) },
          validFrom: effectiveTime,
          ...(bound === undefined ? {} : { validTo: bound }),
        };
      }),
    ];
    // Two records of one relation between the same ends would publish as one
    // edge (the second correcting the first), which is a smaller result than
    // the extraction made; the record contract's span or discriminator has to
    // tell them apart, and a fill refuses rather than choose silently.
    const seenEdges = new Map<string, string>();
    for (const edge of effective.edges) {
      const logicalKey = edge.type === OCCURRENCE && edge.span !== undefined
        ? `${edge.type}\u0000${edge.from}\u0000${edge.to}\u0000${edge.span.byteStart}-${edge.span.byteEnd}`
        : `${edge.type}\u0000${edge.from}\u0000${edge.to}\u0000${edge.discriminator}`;
      const first = seenEdges.get(logicalKey);
      if (first !== undefined) {
        throw new Error(`extract driver: ${where}: producer "${extraction.producer}" emits ${edge.type} from ${edge.from} to ${edge.to} (discriminator ${JSON.stringify(edge.discriminator)}) twice — first span ${first}, again ${edge.span === undefined ? 'none' : `bytes ${edge.span.byteStart}-${edge.span.byteEnd} of ${edge.span.path}`}; the record contract's span or discriminator must tell parallel relations apart`);
      }
      seenEdges.set(logicalKey, edge.span === undefined ? 'none' : `bytes ${edge.span.byteStart}-${edge.span.byteEnd} of ${edge.span.path}`);
    }
    const publishedEdges = effective.edges.map((edge) => {
      if (edge.type === OCCURRENCE && edge.span === undefined) {
        throw new Error(`extract driver: ${where}: producer "${extraction.producer}" emits an occurrence edge (${edge.from} -> ${edge.to}) without the span that positions it`);
      }
      const end = (key: string) => ownedIds.has(key) ? { id: ownedIds.get(key)! } as const : (map.has(key) ? { id: map.get(key)! } as const : { ref: key } as const);
      return {
        relation: edge.type,
        src: end(edge.from),
        dst: end(edge.to),
        // An occurrence is told apart by its position, and the store declares it without a discriminator.
        ...(edge.discriminator === '' || edge.type === OCCURRENCE ? {} : { discriminator: edge.discriminator }),
        ...(edge.type === OCCURRENCE ? { position: { start: edge.span!.byteStart, end: edge.span!.byteEnd } } : {}),
        properties: { ...edge.properties, ...(edge.span === undefined || edge.type === OCCURRENCE ? {} : { span: spanProperty(edge.span) }) },
        validFrom: effectiveTime,
        ...(bound === undefined ? {} : { validTo: bound }),
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
      ...(mode.kind === 'tip' ? { complete: { validTo: effectiveTime } } : {}),
    }));
    if (!result.unchangedInput) {
      for (const [key, id] of Object.entries(result.refs)) map.set(key, id);
      if (mode.kind === 'tip') {
        const held = new Set(nodes.map((node) => node.ref));
        for (const key of [...map.keys()]) if (!held.has(key)) map.delete(key);
      }
    }
    return true;
  };

  /** Owners publish first, in the order the owners list holds them, so an edge of a later producer can end at an owner's node of the same commit. */
  const rank = (producer: string): number => {
    const at = [...new Set(Object.values(options.owners ?? {}))].indexOf(producer);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const digestOf = (commit: CommitFact): string => sha256Hex(new TextEncoder().encode(`${commit.hash}\n${commit.tree}`));
  const whereOf = (commit: CommitFact): string => `commit ${commit.hash} ("${commit.subject}", generation ${commit.generation}) of ${repository}`;

  /**
   * The driver's own record of a commit it has read is kept under a producer
   * named by the extractors that took part: a fill with another set of
   * extractors (or none, for the history alone) is a different reading and
   * runs again, publishing only what the first did not.
   */
  const readProducer = `${DRIVER_PRODUCER}/${sha256Hex(new TextEncoder().encode(`${options.extractors.map((extractor) => extractor.name).join('\n')}\n${options.history === undefined ? '' : options.history.name}`)).slice(0, 12)}`;
  /** Whether the work item of a producer at a place was published, and with which input digest. */
  const publishedAt = async (producer: string, generation: number): Promise<string | undefined> => {
    const rows = await query<{ input_digest: string }>(
      owner,
      `SELECT input_digest FROM work_item WHERE producer = $1 AND scope_id = $2::bigint AND generation = $3::bigint AND published_at IS NOT NULL`,
      [producer, repositoryNode, String(generation)],
    );
    return rows[0]?.input_digest;
  };
  /**
   * Whether every extraction of a commit was published by an earlier fill: the
   * driver publishes an empty record of its own, after the last extraction, for
   * each commit it has read, so a repeated fill does not parse the tree again.
   */
  const alreadyRead = async (commit: CommitFact): Promise<boolean> => {
    const held = await publishedAt(readProducer, storeGeneration(commit.generation));
    if (held === undefined) return false;
    if (held !== digestOf(commit)) {
      throw new Error(`extract driver: ${repository}: ${whereOf(commit)} was read with input digest ${held}, but the walk now reads ${digestOf(commit)}: the history changed under a fixed generation number, and what the store already believes is not rewritten`);
    }
    return true;
  };
  const markRead = async (commit: CommitFact, generation = storeGeneration(commit.generation), inputDigest = digestOf(commit), what = whereOf(commit)): Promise<void> => {
    const found = await query<{ id: string }>(owner, `SELECT id::text AS id FROM work_item WHERE producer = $1 AND scope_id = $2::bigint AND generation = $3::bigint`, [readProducer, repositoryNode, String(generation)]);
    try {
      if (found.length === 0) await store.openWorkItem({ producer: readProducer, scope: repositoryNode, generation, inputDigest, leaseToken, leaseUntil });
      else await store.leaseWorkItem({ producer: readProducer, scope: repositoryNode, generation, leaseToken, leaseUntil, inputDigest });
      await store.publish({ producer: readProducer, scope: repositoryNode, generation, leaseToken, inputDigest });
    } catch (error) {
      throw new Error(`extract driver: recording that ${what} was read failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };

  /** Reads one commit's code and publishes every extraction of it in the given mode; a commit an earlier fill read is not read again when `skipRead` allows. */
  const fillCode = async (commit: CommitFact, modeOf: (commit: CommitFact) => PublishMode, skipRead: boolean): Promise<{ done: CommitFill; present: ReadonlyMap<string, Extraction> }> => {
    const commitStarted = Date.now();
    if (skipRead && await alreadyRead(commit)) {
      return { done: { hash: commit.hash, generation: commit.generation, effectiveTime: commit.effectiveTime, durationMs: Date.now() - commitStarted, publications: 0, gaps: 0 }, present: new Map() };
    }
    const extractions = await runExtractors(commit, commitTree(repository, commit.hash));
    const present = new Map(extractions.map((extraction) => [extraction.producer as string, extraction]));
    pointMaps = new Map();
    let publications = 0;
    let gapCount = 0;
    for (const extraction of [...extractions].sort((a, b) => rank(a.producer) - rank(b.producer))) {
      if (await publishExtraction(extraction, present, commit.generation, commit.effectiveTime, digestOf(commit), modeOf(commit), whereOf(commit))) publications += 1;
      gapCount += extraction.gaps.length;
    }
    if (await publishedAt(readProducer, storeGeneration(commit.generation)) === undefined) await markRead(commit);
    return { done: { hash: commit.hash, generation: commit.generation, effectiveTime: commit.effectiveTime, durationMs: Date.now() - commitStarted, publications, gaps: gapCount }, present };
  };

  /** The history publication of a walk of `n` commits is recorded as generation `2n + 1` of the driver's own producer. */
  const historyGeneration = storeGeneration(walk.length) + 1;
  const historyInputDigest = sha256Hex(new TextEncoder().encode(walk.map((commit) => `${commit.hash} ${commit.committerTime} ${commit.effectiveTime}`).join('\n')));
  const phases = { codeMs: 0, historyMs: 0, pointsMs: 0 };
  const commits: CommitFill[] = [];
  const points: CommitFill[] = [];
  let lastPresent: ReadonlyMap<string, Extraction> = new Map();

  // The tree is parsed again only when the history still has to be published (it needs the tree's records to tell the owners' nodes).
  const historyPublished = options.history === undefined || await publishedAt(readProducer, historyGeneration) === historyInputDigest;
  // 1. The code of the last commit, once.
  let phaseStarted = Date.now();
  await options.onPhase?.({ phase: 'code', commits: walk.length, newCommits });
  if (options.extractors.length > 0) {
    const tip = await fillCode(last, () => ({ kind: 'tip', closeGap: true, renames: true, verifyPrior: true }), historyPublished);
    lastPresent = tip.present;
    commits.push(tip.done);
  }
  phases.codeMs = Date.now() - phaseStarted;
  if (commits[0] !== undefined) await options.onCommit?.(commits[0], { index: walk.length, commits: walk.length });

  // 2. The history: one git log over every first-parent commit, no code parsed.
  if (options.history !== undefined && !historyPublished) {
    phaseStarted = Date.now();
    await options.onPhase?.({ phase: 'history', commits: walk.length, newCommits });
    let extraction: Extraction;
    try {
      extraction = await options.history({ path: repository, snapshots: options.snapshots ?? {} });
    } catch (error) {
      throw new Error(`extract driver: the history extractor failed over ${repository} (${walk.length} first-parent commits): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const historyWhere = `the history of ${repository} (${walk.length} first-parent commits)`;
    await publishExtraction(extraction, lastPresent, walk.length, last.effectiveTime, historyInputDigest, { kind: 'tip', closeGap: false, renames: false, verifyPrior: false }, historyWhere);
    if (await publishedAt(readProducer, historyGeneration) === undefined) await markRead(last, historyGeneration, historyInputDigest, historyWhere);
    phases.historyMs = Date.now() - phaseStarted;
  }

  // 3. The chosen points' code, in their order on the line.
  if (chosen.length > 0) {
    phaseStarted = Date.now();
    await options.onPhase?.({ phase: 'points', commits: chosen.length, newCommits: chosen.length });
    for (const commit of chosen) {
      const bound = walk[commit.generation]!.effectiveTime; // a point is never the last commit, so a next commit stands
      const read = await fillCode(commit, () => ({ kind: 'point', bound }), true);
      points.push(read.done);
      await options.onPoint?.(read.done, { index: commit.generation, commits: walk.length });
    }
    phases.pointsMs = Date.now() - phaseStarted;
  }

  return { repositoryNode, commits, points, newCommits, historyCommits: options.history === undefined ? 0 : walk.length, phases, totalMs: Date.now() - started, gaps };
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

/**
 * Fills the code structure at one chosen point, a revision or a date (0030):
 * the same fill with one point. The last commit and the history are brought
 * current first, which writes nothing when they already are.
 */
export function fillSnapshot(options: Omit<FillOptions, 'points'>, point: FillPoint): Promise<FillReport> {
  return fillGraph({ ...options, points: [point] });
}
