/**
 * The repository records (madarch-8bdc.2.11, decision 0034 and its amendment of 2026-11-10): the
 * graph the fill's two passes write, in the one schema of `one-graph.ts`.
 *
 * **Identity only in `node`, and the key on the vertex.** A vertex is a row of `node` with its
 * entity and its key; a file's key is its repository and its path, a commit's its hash. The key
 * fields are named here exactly as the contract declares them, and they are no columns of the
 * entity's table.
 *
 * **Every value is an opinion.** The table of a kind holds one row per opinion (A3): the tree pass
 * and the history pass each state theirs, the language dataset states its own, and every opinion
 * carries the producer and its version, the evidence it was read at and the language of a text
 * value. A rerun of the same reading writes nothing; a changed value closes the producer's open
 * opinion and opens a new one.
 *
 * **A relation stands once, as an `edge` row.** `contains`, `as-is`, `history`, `parent`,
 * `touched`, `authored` and `renamed-from` are edges; an edge kind's own values stand in its
 * opinion table keyed by `edge_id` (`touched`, `history`, `parent_position`).
 *
 * **A deleted path keeps its vertex and its history.** A tree publication reconciles the
 * `contains` edges of the current tree: a path that left the tree loses that edge and nothing else;
 * its `touched` and `renamed-from` edges stand.
 *
 * **Change detection.** A publication compares what the store holds with what the pass read, by key
 * and by blob, writes only what differs, in bounded batches, interns every dictionary value, and
 * reads a page with keyset pagination.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { OuterTransaction } from '../history-types.js';
import { withSpan } from '../obs/trace.js';
import { withManifestContract } from './manifest-contract.js';
import { raise } from '../model/raise.js';
import { createOneGraphSchema, FILE_BLOB_TABLE, FILE_ENTRY_TABLE, FILE_PATH_TABLE } from './one-graph.js';
import { GIT_CONTRACT, GIT_KINDS, GIT_TABLES } from '../fill/stages/git-contract.js';
import type { EvidenceDraft, EvidenceEntry, GraphContract } from './contract.js';
import { ensureEdge, ensureEdges, ensureEdgesWithOpinions, ensureVertex, ensureVertices, flushJournalIfFull, journalFor, journalOn, publishEdgeOpinion, publishFileEntries, publishOpinion, publishOpinions, removeEdgeById, removeEntity, writeJournal } from './write.js';

/** The producers of this store's opinions, and the version each states with them. */
const TREE_PRODUCER = 'git-tree';
const HISTORY_PRODUCER = 'git-history';
const LANGUAGE_PRODUCER = 'language-attribution';
const TREE_VERSION = '1';
const HISTORY_VERSION = '1';
const LANGUAGE_VERSION = 'linguist-9.5.0+json-1';

/** The key of a referenced entity, as the writer canonically states it: the kind and that entity's key values. */
const KEY_REF = (alias: string, field: string, inner: string): string => `(${alias}.key->'${field}'->'key'->>'${inner}')`;

/** A file's, folder's or gitlink's repository key, and the path key beside it. */
const REPOSITORY_OF = (alias: string): string => KEY_REF(alias, 'repository', 'name');
const PATH_OF = (alias: string): string => `(${alias}.key->>'path')`;

/** Creates the one graph's tables and the kinds the fill writes; a second call changes nothing. */
export async function createRecordSchema(owner: DatabaseOwner, contract: GraphContract = GIT_CONTRACT): Promise<void> {
  await createOneGraphSchema(owner, withManifestContract(contract));
}

// ---- what one pass read ----------------------------------------------------

/** One file of a tree, as the tree pass read it: everything an opinion holds. */
export interface TreeFile {
  readonly path: string;
  readonly mode: '100644' | '100755' | '120000';
  readonly blob: string;
  readonly bytes: number;
  /** Git's own answer: `-` in `--numstat` is a binary blob, a number of added lines is text. */
  readonly form: 'text' | 'binary';
  readonly lines: number | null;
  /** A text file's bytes as text, stored once per blob; null for a binary blob, whose bytes are kept nowhere. */
  readonly content: string | null;
  /** The dataset's language, or `ambiguous` with its candidates: the opinion stores the candidates, never the word. */
  readonly language: string;
  readonly candidates: readonly string[];
}

/** One gitlink of a tree: a submodule's repository and the commit it stands at. */
export interface TreeGitlink {
  readonly path: string;
  readonly otherRepository: string;
  readonly commit: string;
}

/** What the tree pass read of one repository, at one commit. */
/** The graph kinds a publication may write: the vertices and the edges the product's manifest declares. */
export interface DeclaredKinds {
  readonly vertex: readonly string[];
  readonly edge: readonly string[];
}

export interface TreePublish {
  readonly repository: { readonly name: string; readonly url: string; readonly defaultBranch?: string };
  readonly commit: string;
  readonly files: readonly TreeFile[];
  readonly gitlinks: readonly TreeGitlink[];
  /**
   * The repository paths this publication covers, as prefixes; the whole tree when it is left out. A scoped
   * publication touches its scope only: a file or folder outside it is not this publication's to delete.
   */
  readonly scope?: readonly string[];
  /**
   * The code entities this publication may write, by graph kind: mechanism entries (`file_entry`) are written whatever
   * it says, and an entity kind the product's manifest does not declare is simply not written (madarch-hsqs stage C:
   * an engine must never publish an entity the manifest does not declare). False writes the tree as mechanism state
   * only; left out, every kind is written, as callers that hold the whole git contract have always done.
   */
  readonly kinds?: false | DeclaredKinds;
}

/** One commit the history pass read, with the paths it changed. */
export interface HistoryCommit {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  /** ISO 8601 with its offset, as `git log %aI` writes it. */
  readonly authorDate: string;
  readonly commitDate: string;
  readonly subject: string;
  readonly touched: readonly {
    readonly path: string;
    readonly change: 'added' | 'modified' | 'deleted' | 'renamed';
    readonly added: number | null;
    readonly removed: number | null;
    readonly previousPath?: string;
  }[];
}

/** What the history pass read of one repository. */
export interface HistoryPublish {
  readonly repository: { readonly name: string };
  readonly commits: readonly HistoryCommit[];
  /** Whether the clone the pass read is shallow: a fact about its input, stated as the producer's opinion of the repository. */
  readonly shallow?: boolean;
  /** The code entities this publication may write, as `TreePublish.kinds` says. */
  readonly kinds?: false | DeclaredKinds;
}

/** What one publish wrote: the rows that changed, and the rows that were already right. */
export interface RecordCounts {
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
  readonly unchanged: number;
}

/** The counts of one publish, added. */
function sum(a: RecordCounts, b: RecordCounts): RecordCounts {
  return { inserted: a.inserted + b.inserted, updated: a.updated + b.updated, deleted: a.deleted + b.deleted, unchanged: a.unchanged + b.unchanged };
}

/** Every graph kind of the git contract: what a publication writes when its caller names no set. */
const ALL_GIT_KINDS: DeclaredKinds = { vertex: GIT_CONTRACT.vertex.map((kind) => kind.name), edge: GIT_CONTRACT.edge.map((kind) => kind.name) };

/** Whether one publication writes a kind: all when its caller names none, none when it says false, the named ones otherwise. */
function writesOf(kinds: false | DeclaredKinds | undefined): (name: string, sort: 'vertex' | 'edge') => boolean {
  if (kinds === false) return () => false;
  const held = kinds ?? ALL_GIT_KINDS;
  return (name, sort) => (sort === 'vertex' ? held.vertex : held.edge).includes(name);
}

/** The statement bound one publish writes per batch, the store's own constant. */
const BATCH = 500;

/** Runs one write transaction and lends it the batch writer. */
async function write<T>(owner: DatabaseOwner, work: (tx: OuterTransaction) => Promise<T>): Promise<T> {
  return await owner.transaction('write', work);
}

/** The id of every entity this module reads, by name. */
async function entityIds(tx: OuterTransaction): Promise<Map<string, string>> {
  const found = await tx.query<{ id: string; name: string }>('SELECT id::text AS id, name FROM entity');
  return new Map(found.rows.map((row) => [row.name, row.id]));
}

/** A hash's algorithm, from the length git writes it at: 40 hex digits is SHA-1, 64 is SHA-256. */
function hashAlgorithmOf(hash: string): 'sha1' | 'sha256' {
  if (hash.length === 40) return 'sha1';
  if (hash.length === 64) return 'sha256';
  raise(`the object ${JSON.stringify(hash)} is neither a 40-digit SHA-1 nor a 64-digit SHA-256 hash (src/graph/records.ts)`);
}

/** A Postgres array literal of text values, quoted and escaped so any path survives it. */
function sqlText(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`).join(',')}}`;
}

/** A Postgres array literal of texts, with `NULL` where a row's text is absent. */
function sqlTexts(values: readonly (string | null)[]): string {
  return `{${values.map((value) => (value === null ? 'NULL' : `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`)).join(',')}}`;
}

/** A Postgres array literal of ids, with `NULL` where a row's id is absent. */
function sqlIds(values: readonly (string | null)[]): string {
  return `{${values.map((value) => (value === null ? 'NULL' : value)).join(',')}}`;
}

/** Runs `work` over the rows in statements of at most `BATCH` rows each. */
async function inBatches<T>(rows: readonly T[], work: (chunk: readonly T[]) => Promise<void>): Promise<void> {
  for (let at = 0; at < rows.length; at += BATCH) await work(rows.slice(at, at + BATCH));
}

/** The folder one path stands in: the path's own text without its last leg, or '' for a top-level path. */
function folderOfPath(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}
/** One commit as a reader sees it. */
export interface CommitRecord {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly author: { readonly name: string; readonly email: string };
  /** The author's clock with its offset, as `git log %aI` writes it. */
  readonly authorDate: string;
  /** The offset `authorDate` stands at, in minutes east of UTC: the same number `authorDate` carries. */
  readonly authorOffsetMin: number;
  /** The committer's clock with its offset, as `git log %aI` writes it. */
  readonly commitDate: string;
  /** The offset `commitDate` stands at, in minutes east of UTC: the same number `commitDate` carries. */
  readonly commitOffsetMin: number;
  readonly subject: string;
}

/**
 * One git date as `git log %aI` writes it: the clock the author wrote, and the offset it stood at.
 *
 * The store keeps git's two numbers apart — the clock as it stood and the minutes east of UTC — and
 * a reader that gets the clock back must put the offset beside it, never convert the clock to UTC
 * and keep the offset.
 */
function gitDateOf(localClock: string, offsetMin: number): string {
  const sign = offsetMin < 0 ? '-' : '+';
  const total = Math.abs(offsetMin);
  return `${localClock}${sign}${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** One path the walk has not read: the store says so rather than answering nothing. */
export class RecordGap extends Error {}


// ---- the dictionaries ------------------------------------------------------

/** The ids of every blob the tree names, inserted or corrected in two statements. */
async function blobIdsOf(tx: OuterTransaction, files: readonly TreeFile[]): Promise<Map<string, string>> {
  const wanted = new Map<string, TreeFile>();
  for (const file of files) if (!wanted.has(file.blob)) wanted.set(file.blob, file);
  const rows = [...wanted.values()];
  await inBatches(rows, async (chunk) => {
    await tx.query(
      `INSERT INTO ${GIT_TABLES.blob} (hash, algorithm, bytes, form, lines, content) SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[], $4::text[], $5::bigint[], $6::text[])
       ON CONFLICT (hash) DO UPDATE SET bytes = EXCLUDED.bytes, form = EXCLUDED.form, lines = EXCLUDED.lines, content = EXCLUDED.content`,
      [
        sqlText(chunk.map((file) => file.blob)),
        sqlText(chunk.map((file) => hashAlgorithmOf(file.blob))),
        `{${chunk.map((file) => String(file.bytes)).join(',')}}`,
        sqlText(chunk.map((file) => file.form)),
        sqlIds(chunk.map((file) => (file.lines === null ? null : String(file.lines)))),
        sqlTexts(chunk.map((file) => file.content)),
      ],
    );
  });
  const found = await tx.query<{ id: string; hash: string }>(`SELECT id::text AS id, hash FROM ${GIT_TABLES.blob} WHERE hash IN (SELECT value FROM jsonb_array_elements_text($1::jsonb))`, [JSON.stringify(rows.map((file) => file.blob))]);
  return new Map(found.rows.map((row) => [row.hash, row.id]));
}

// ---- the repository, its commit and the reference a file's key carries -----

/** The key a file, folder or gitlink names its repository by: the repository's own key, its name. */
function repositoryRef(name: string): { kind: string; key: { name: string } } {
  return { kind: GIT_KINDS.repository, key: { name } };
}

/** One repository's node, made where the store holds none: its name is its key, its address an opinion. */
async function repositoryNodeOf(tx: OuterTransaction, repository: { readonly name: string; readonly url?: string; readonly defaultBranch?: string }): Promise<{ node: string; counts: RecordCounts }> {
  const made = await ensureVertex(tx, GIT_CONTRACT, { kind: GIT_KINDS.repository, key: { name: repository.name } });
  let counts: RecordCounts = { inserted: made.created ? 1 : 0, updated: 0, deleted: 0, unchanged: made.created ? 0 : 1 };
  if (repository.url !== undefined) {
    const written = await publishOpinion(tx, GIT_CONTRACT, {
      kind: GIT_KINDS.repository, nodeId: made.nodeId, producer: TREE_PRODUCER, producerVersion: TREE_VERSION,
      values: { url: repository.url, default_branch: repository.defaultBranch ?? null },
    });
    counts = written ? { ...counts, inserted: counts.inserted + (made.created ? 1 : 0), updated: counts.updated + (made.created ? 0 : 1) } : counts;
  }
  return { node: made.nodeId, counts };
}

/**
 * One commit's node under a hash, made where the store holds none: a commit's hash is its key. The tree pass states what
 * git tells it at the commit — its object format — and the history pass states the rest of the commit's opinion.
 */
async function commitNodeOf(tx: OuterTransaction, hash: string, producer: 'tree' | 'none'): Promise<{ node: string; created: boolean; counts: RecordCounts }> {
  const made = await ensureVertex(tx, GIT_CONTRACT, { kind: GIT_KINDS.commit, key: { hash } });
  let counts: RecordCounts = { inserted: made.created ? 1 : 0, updated: 0, deleted: 0, unchanged: made.created ? 0 : 1 };
  if (made.created && producer === 'tree') {
    await publishOpinion(tx, GIT_CONTRACT, { kind: GIT_KINDS.commit, nodeId: made.nodeId, producer: TREE_PRODUCER, producerVersion: TREE_VERSION, values: { algorithm: hashAlgorithmOf(hash) }, evidence: [{ type: 'file', commit_or_digest: hash }] });
    counts = { ...counts, inserted: counts.inserted + 1 };
  }
  return { node: made.nodeId, created: made.created, counts };
}

/** One file's node under its repository and path; a file keeps its vertex when it leaves the tree. */
async function fileNodeOf(tx: OuterTransaction, repository: string, path: string): Promise<{ node: string; created: boolean }> {
  const made = await ensureVertex(tx, GIT_CONTRACT, { kind: GIT_KINDS.file, key: { repository: repositoryRef(repository), path } });
  return { node: made.nodeId, created: made.created };
}

/** One signature's node under its name and email, made where the store holds none, with an opinion that it stands. */
async function signatureNodeOf(tx: OuterTransaction, name: string, email: string): Promise<{ node: string; created: boolean }> {
  const made = await ensureVertex(tx, GIT_CONTRACT, { kind: GIT_KINDS.signature, key: { name, email } });
  if (made.created) await publishOpinion(tx, GIT_CONTRACT, { kind: GIT_KINDS.signature, nodeId: made.nodeId, producer: HISTORY_PRODUCER, producerVersion: HISTORY_VERSION });
  return { node: made.nodeId, created: made.created };
}

/** One edge of the named kind between two nodes, declared through the one writer with its producer's opinion. */
async function edgeOf(tx: OuterTransaction, kind: string, from: string, to: string, opinion: { readonly producer: string; readonly producerVersion: string; readonly evidence?: readonly EvidenceDraft[] }, discriminator = ''): Promise<{ id: string; created: boolean }> {
  return await ensureEdge(tx, GIT_CONTRACT, kind, from, to, discriminator, opinion);
}

/** The language opinions one file's reading states: the one language, or the candidates with no language picked. */
function languageOfFile(file: { readonly language: string; readonly candidates: readonly string[] }): { language: string | null; candidates: readonly string[] } {
  const candidates = file.language === 'ambiguous' || file.candidates.length > 1 ? [...file.candidates] : [file.language];
  return { language: file.language === 'ambiguous' ? null : file.language, candidates };
}

/** The language one file's opinion names, or null with its candidates when it names no one language. */
function languageOfOpinion(languages: unknown, lang: unknown): { language: string | null; candidates: readonly string[] } {
  const candidates = Array.isArray(languages) ? languages.filter((one): one is string => typeof one === 'string') : [];
  const language = typeof lang === 'string' ? lang : null;
  return { language, candidates: candidates.length === 0 ? (language === null ? [] : [language]) : candidates };
}

// ---- the tree pass ---------------------------------------------------------

/** One file of the store's current tree, as the diff reads it. */
interface HeldFile {
  readonly nodeId: string;
  readonly languageProducer: string | null;
  readonly mode: string | null;
  readonly blob: string | null;
  readonly languages: unknown;
  readonly language: unknown;
}

/** Whether a held file already says what the pass read, in both producers' opinions. */
function sameFile(held: HeldFile, file: TreeFile): boolean {
  const read = languageOfFile(file);
  const heldLanguage = languageOfOpinion(held.languages, held.language);
  return held.languageProducer === `${LANGUAGE_PRODUCER}@${LANGUAGE_VERSION}` && held.mode === file.mode && held.blob === file.blob && heldLanguage.language === read.language && JSON.stringify(heldLanguage.candidates) === JSON.stringify(read.candidates);
}

/** What the mechanism holds of one repository's entries: the mode and blob hash of each path. */
interface HeldTreeEntry { readonly mode: string | null; readonly hash: string | null }

async function heldTreeEntries(tx: OuterTransaction, repository: string): Promise<Map<string, HeldTreeEntry>> {
  const found = await tx.query<{ path: string; mode: string | null; hash: string | null }>(
    `SELECT p.text AS path, f.mode, b.hash FROM ${FILE_ENTRY_TABLE} f JOIN ${FILE_PATH_TABLE} p ON p.id = f.path_id
     LEFT JOIN ${FILE_BLOB_TABLE} b ON b.id = f.blob_id WHERE f.repository = $1`,
    [repository],
  );
  return new Map(found.rows.map((row) => [row.path, { mode: row.mode, hash: row.hash }] as const));
}

/** The mechanism part of a tree publication: the interned blobs of the files whose text moved or is new, and the entries. */
async function publishTreeEntries(tx: OuterTransaction, input: TreePublish, files: readonly TreeFile[]): Promise<{ counts: RecordCounts; blobIds: Map<string, string> }> {
  const held = await heldTreeEntries(tx, input.repository.name);
  const needBlob = files.filter((file) => held.get(file.path)?.hash !== file.blob);
  const interned = needBlob.length === 0 ? new Map<string, string>() : await blobIdsOf(tx, needBlob);
  const written = await publishFileEntries(tx, { repository: input.repository.name, files, blobIds: interned, ...(input.scope === undefined ? {} : { scope: input.scope }) });
  return { counts: written.counts, blobIds: written.blobIds };
}

/**
 * Publishes one repository's tree at one commit: its files, its gitlinks, the
 * `contains` relation of the current tree and the `as-is` relation to the commit.
 * Rows are compared by key and by blob and only what differs is written; a path
 * the tree no longer holds loses its `contains` edge and keeps its vertex, its
 * opinions and its history.
 */
export async function publishTree(owner: DatabaseOwner, input: TreePublish): Promise<RecordCounts> {
  const scope = input.scope;
  /** Whether one repository path stands inside the publication's scope: the whole tree when it names none. */
  const within = (path: string): boolean => scope === undefined || scope.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
  const wants = writesOf(input.kinds);
  const repository = input.repository.name;
  const evidenceOf = (path: string): EvidenceDraft => ({ type: 'file', repository, commit_or_digest: input.commit, path });
  return await write(owner, async (tx) => {
    const journal = journalFor(`${TREE_PRODUCER}@${TREE_VERSION}`);
    journalOn(tx, journal);
    const files = [...input.files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const folders = new Set<string>();
    for (const path of [...files.map((file) => file.path), ...input.gitlinks.map((link) => link.path)]) {
      for (let folder = folderOfPath(path); folder !== ''; folder = folderOfPath(folder)) folders.add(folder);
    }
    // The product repository's files are mechanism state: every publication records its entries, whatever entities the
    // product declares (madarch-hsqs stage C). A product that binds no code entity stores these rows and no entity rows;
    // the blob text is interned once per blob, and the code entities' opinions name the same blob rows.
    const entries = await publishTreeEntries(tx, input, files);
    let counts: RecordCounts = entries.counts;
    if (input.kinds === false) {
      await writeJournal(tx, journal);
      return counts;
    }
    const blobIds = entries.blobIds;
    // Only a kind the manifest declares is written: an undeclared one has no table in the product's store, and the engine
    // never publishes an entity the manifest does not declare (madarch-hsqs stage C, the owner 2026-11-11).
    const heldRepository = wants('repository', 'vertex') ? await repositoryNodeOf(tx, input.repository) : undefined;
    if (heldRepository !== undefined) counts = sum(counts, heldRepository.counts);
    const commit = wants('commit', 'vertex') ? await commitNodeOf(tx, input.commit, 'tree') : undefined;
    if (commit !== undefined) counts = sum(counts, commit.counts);
    if (wants('as-is', 'edge') && heldRepository !== undefined && commit !== undefined) {
      // The commit the tree stands at: one `as-is` edge per repository, and the one it held goes.
      const asIs = await edgeOf(tx, `${GIT_KINDS.asIs}`, heldRepository.node, commit.node, { producer: TREE_PRODUCER, producerVersion: TREE_VERSION, evidence: [{ type: 'file', repository, commit_or_digest: input.commit }] });
      counts = asIs.created ? { ...counts, inserted: counts.inserted + 1 } : { ...counts, unchanged: counts.unchanged + 1 };
      const moved = await tx.query<{ id: string }>(
        `SELECT e.id::text AS id FROM edge e JOIN entity en ON en.id = e.entity_id AND en.name = '${GIT_KINDS.asIs}' WHERE e.from_node = $1::bigint AND e.to_node <> $2::bigint AND e.context_id = 1 AND e.context_id = 1`,
        [heldRepository.node, commit.node],
      );
      for (const row of moved.rows) if (await removeEdgeById(tx, GIT_CONTRACT, `${GIT_KINDS.asIs}`, row.id)) counts = { ...counts, deleted: counts.deleted + 1 };
    }

    // What the store holds of this repository's files: their node, the tree's opinion and the dataset's.
    const fileNodes = new Map<string, string>();
    if (wants('file', 'vertex')) {
      const held = new Map<string, HeldFile>();
      const found = await tx.query<{ path: string; node_id: string; mode: string | null; hash: string | null; languages: unknown; language: string | null; language_producer: string | null }>(
        `SELECT ${PATH_OF('n')} AS path, n.id::text AS node_id, g.mode, b.hash, l.languages, l.language, l.said_by AS language_producer
         FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.file}'
         LEFT JOIN LATERAL (SELECT o."mode", o."blob_id" FROM ${GIT_TABLES.file} o WHERE o."node_id" = n.id AND o."state" = 'open' AND split_part(o."said_by", '@', 1) = '${TREE_PRODUCER}' ORDER BY o."id" DESC LIMIT 1) g ON true
         LEFT JOIN ${GIT_TABLES.blob} b ON b.id = g."blob_id"
         LEFT JOIN LATERAL (SELECT o."language", o."languages", o."said_by" FROM ${GIT_TABLES.file} o WHERE o."node_id" = n.id AND o."state" = 'open' AND split_part(o."said_by", '@', 1) IN ('${LANGUAGE_PRODUCER}', 'linguist') ORDER BY o."id" DESC LIMIT 1) l ON true
         WHERE ${REPOSITORY_OF('n')} = $1 AND NOT n.removed`,
        [repository],
      );
      for (const row of found.rows) held.set(row.path, { nodeId: row.node_id, languageProducer: row.language_producer, mode: row.mode, blob: row.hash, languages: row.languages, language: row.language });
      const toWrite = files.filter((file) => { const known = held.get(file.path); return known === undefined || !sameFile(known, file); });
      counts = { ...counts, unchanged: counts.unchanged + (files.length - toWrite.length) };
      for (const [path, known] of held) if (files.some((file) => file.path === path)) fileNodes.set(path, known.nodeId);

      // A new file gets its vertex; a file whose blob moved keeps the one it had. Each producer states its opinion; the
      // blob is the mechanism row the entries above interned.
      const opinions: Parameters<typeof publishOpinion>[2][] = [];
      const newFiles: boolean[] = [];
      for (const file of toWrite) {
        const known = held.get(file.path);
        const node = known?.nodeId ?? (await fileNodeOf(tx, repository, file.path)).node;
        fileNodes.set(file.path, node);
        if (known === undefined) counts = { ...counts, inserted: counts.inserted + 1 };
        // Retire the old dataset-only producer before the combined attribution states its answer.
        // The git-tree opinion keeps the vertex alive throughout this migration.
        if (known?.languageProducer?.startsWith('linguist@')) {
          await removeEntity(tx, GIT_CONTRACT, { kind: GIT_KINDS.file, key: { repository: { kind: GIT_KINDS.repository, key: { name: repository } }, path: file.path }, producer: 'linguist' });
        }
        const evidence = evidenceOf(file.path);
        opinions.push( { kind: GIT_KINDS.file, nodeId: node, producer: TREE_PRODUCER, producerVersion: TREE_VERSION, values: { mode: file.mode, blob_id: blobIds.get(file.blob) ?? null }, evidence: [evidence] });
        newFiles.push(known === undefined);
        const read = languageOfFile(file);
        // A file's programming language is an ordinary field of the file, stated by the dataset and JSON parser as their combined opinion: the
        // opinion's `lang` column is the natural language of a text value and stands null for a language name.
        opinions.push({ kind: GIT_KINDS.file, nodeId: node, producer: LANGUAGE_PRODUCER, producerVersion: LANGUAGE_VERSION, values: { language: read.language, languages: [...read.candidates] }, evidence: [evidence] });
        newFiles.push(known === undefined);
      }
      let offset = 0;
      await inBatches(opinions, async (chunk) => {
        const written = await publishOpinions(tx, GIT_CONTRACT, chunk);
        for (const [at, changed] of written.entries()) {
          if (!changed) continue;
          counts = newFiles[offset + at] ? { ...counts, inserted: counts.inserted + 1 } : { ...counts, updated: counts.updated + 1 };
        }
        offset += chunk.length;
      });
    }

    // The gitlinks: a submodule is a vertex of its own, with its repository and the commit the tree holds.
    const linkNodes = new Map<string, string>();
    if (wants('gitlink', 'vertex')) {
      const heldLinks = new Map((await tx.query<{ path: string; node_id: string; other_repository: string | null; commit_hash: string | null }>(
        `SELECT ${PATH_OF('n')} AS path, n.id::text AS node_id, o."other_repository", o."commit_hash"
         FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.gitlink}'
         LEFT JOIN LATERAL (SELECT g."other_repository", g."commit_hash" FROM ${GIT_TABLES.gitlink} g WHERE g."node_id" = n.id AND g."state" = 'open' AND split_part(g."said_by", '@', 1) = '${TREE_PRODUCER}' ORDER BY g."id" DESC LIMIT 1) o ON true
         WHERE ${REPOSITORY_OF('n')} = $1 AND NOT n.removed`,
        [repository],
      )).rows.map((row) => [row.path, row]));
      for (const link of input.gitlinks) {
        const known = heldLinks.get(link.path);
        if (known === undefined) {
          const made = await fileLinkNodeOf(tx, repository, link.path);
          linkNodes.set(link.path, made);
          await publishOpinion(tx, GIT_CONTRACT, { kind: GIT_KINDS.gitlink, nodeId: made, producer: TREE_PRODUCER, producerVersion: TREE_VERSION, values: { other_repository: link.otherRepository, commit_hash: link.commit }, evidence: [evidenceOf(link.path)] });
          counts = { ...counts, inserted: counts.inserted + 2 };
        } else {
          linkNodes.set(link.path, known.node_id);
          const written = await publishOpinion(tx, GIT_CONTRACT, { kind: GIT_KINDS.gitlink, nodeId: known.node_id, producer: TREE_PRODUCER, producerVersion: TREE_VERSION, values: { other_repository: link.otherRepository, commit_hash: link.commit }, evidence: [evidenceOf(link.path)] });
          counts = written ? { ...counts, updated: counts.updated + 1 } : { ...counts, unchanged: counts.unchanged + 1 };
        }
      }
    }

    // The folders: one vertex per folder of the current tree, and the tree's opinion that it stands.
    const folderNodes = new Map<string, string>();
    if (wants('directory', 'vertex')) {
      const heldFolders = new Map((await tx.query<{ path: string; node_id: string }>(
        `SELECT ${PATH_OF('n')} AS path, n.id::text AS node_id FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.directory}' WHERE ${REPOSITORY_OF('n')} = $1 AND NOT n.removed`,
        [repository],
      )).rows.map((row) => [row.path, row.node_id]));
      const missing = [...folders].sort().filter((folder) => !heldFolders.has(folder));
      for (const [folder, node] of heldFolders) if (folders.has(folder)) folderNodes.set(folder, node);
      for (const folder of missing) {
        const made = await ensureVertex(tx, GIT_CONTRACT, { kind: GIT_KINDS.directory, key: { repository: repositoryRef(repository), path: folder } });
        folderNodes.set(folder, made.nodeId);
        await publishOpinion(tx, GIT_CONTRACT, { kind: GIT_KINDS.directory, nodeId: made.nodeId, producer: TREE_PRODUCER, producerVersion: TREE_VERSION, evidence: [evidenceOf(folder)] });
        counts = { ...counts, inserted: counts.inserted + 2 };
      }
      counts = { ...counts, unchanged: counts.unchanged + (folders.size - missing.length) };
    }

    // The current tree's `contains` edges: exactly one parent for every vertex in the tree. A child that left the tree
    // loses its edge and nothing else; a folder that lost its last file keeps its vertex and loses its edge too.
    if (wants('contains', 'edge') && heldRepository !== undefined) {
      const desired = new Map<string, { parent: string; child: string; path: string }>();
      const addDesired = (parent: string, child: string, path: string): void => { desired.set(`${parent}\u0000${child}`, { parent, child, path }); };
      for (const [folder, node] of folderNodes) addDesired(folderNodes.get(folderOfPath(folder)) ?? heldRepository.node, node, folder);
      for (const [path, node] of fileNodes) addDesired(folderNodes.get(folderOfPath(path)) ?? heldRepository.node, node, path);
      for (const [path, node] of linkNodes) addDesired(folderNodes.get(folderOfPath(path)) ?? heldRepository.node, node, path);
      const heldContains = new Map((await tx.query<{ id: string; from_node: string; to_node: string; path: string }>(
        `SELECT e.id::text AS id, e.from_node::text AS from_node, e.to_node::text AS to_node, ${PATH_OF('cn')} AS path
         FROM edge e JOIN entity en ON en.id = e.entity_id AND en.name = '${GIT_KINDS.contains}'
         JOIN node cn ON cn.id = e.to_node
         WHERE ${REPOSITORY_OF('cn')} = $1 AND e.context_id = 1`,
        [repository],
      )).rows.map((row) => [`${row.from_node}\u0000${row.to_node}`, row]));
      for (const [key, row] of heldContains) {
        if (desired.has(key) || !within(row.path)) continue;
        await removeEdgeById(tx, GIT_CONTRACT, `${GIT_KINDS.contains}`, row.id);
        counts = { ...counts, deleted: counts.deleted + 1 };
      }
      const missing = [...desired].filter(([key, want]) => !heldContains.has(key) && within(want.path)).map(([, want]) => ({ from: want.parent, to: want.child, evidence: [evidenceOf(want.path)] }));
      const created = await ensureEdgesWithOpinions(tx, GIT_CONTRACT, `${GIT_KINDS.contains}`, missing, TREE_PRODUCER, TREE_VERSION);
      counts = { ...counts, inserted: counts.inserted + created };
      counts = { ...counts, unchanged: counts.unchanged + [...desired.keys()].filter((key) => heldContains.has(key)).length };
    }

    await writeJournal(tx, journal);
    return counts;
  });
}

/** One gitlink's node under its repository and path, made where the store holds none. */
async function fileLinkNodeOf(tx: OuterTransaction, repository: string, path: string): Promise<string> {
  const made = await ensureVertex(tx, GIT_CONTRACT, { kind: GIT_KINDS.gitlink, key: { repository: repositoryRef(repository), path } });
  return made.nodeId;
}

/** The distinct commits of one walk's touched rows, as the id array a standing-edges read takes. */
function walkCommitsBefore(rows: readonly { readonly commit: string }[]): string {
  return `{${[...new Set(rows.map((row) => row.commit))].join(',')}}`;
}

// ---- the history pass ------------------------------------------------------

/**
 * Publishes one repository's history: every commit as a vertex with the opinion git states of it — its parents, its
 * signature, its two dates and its subject — the repository's `history` edge to it with its walk, every path it touched
 * as a `touched` edge, and every rename as a `renamed-from` edge from the new file to the old one. A path a commit
 * touched has its file vertex even when the tree no longer holds it: a deleted path keeps its history.
 */
export async function publishHistory(owner: DatabaseOwner, input: HistoryPublish): Promise<RecordCounts> {
  const repository = input.repository.name;
  const wants = writesOf(input.kinds);
  const wantCommit = wants('commit', 'vertex');
  return await write(owner, async (tx) => {
    const journal = journalFor(`${HISTORY_PRODUCER}@${HISTORY_VERSION}`);
    journalOn(tx, journal);
    const entities = await entityIds(tx);
    const made = wants('repository', 'vertex') ? await ensureVertex(tx, GIT_CONTRACT, { kind: GIT_KINDS.repository, key: { name: repository } }) : undefined;
    let counts: RecordCounts = made === undefined ? { inserted: 0, updated: 0, deleted: 0, unchanged: 0 } : { inserted: made.created ? 1 : 0, updated: 0, deleted: 0, unchanged: made.created ? 0 : 1 };
    if (made !== undefined) {
      // A shallow clone is a fact about what the pass was given, so the pass states it as its own opinion of the
      // repository: a deeper clone states false, and every reader answers from the graph (stage 3: `gap` is gone).
      const shallowWritten = await publishOpinion(tx, GIT_CONTRACT, { kind: GIT_KINDS.repository, nodeId: made.nodeId, producer: HISTORY_PRODUCER, producerVersion: HISTORY_VERSION, values: { history_shallow: input.shallow === true }, lang: null });
      if (shallowWritten) counts = { ...counts, inserted: counts.inserted + (made.created ? 1 : 0), updated: counts.updated + (made.created ? 0 : 1) };
    }

    // Every commit vertex the walk names — a commit of the walk or a parent of one — exists before a row points at it.
    const commitNodes = new Map<string, { node: string; created: boolean }>();
    if (wantCommit) {
      const needed = new Set<string>();
      for (const commit of input.commits) {
        needed.add(commit.hash);
        for (const parent of commit.parents) needed.add(parent);
      }
      for (const hash of [...needed].sort()) {
        const commit = await commitNodeOf(tx, hash, 'none');
        commitNodes.set(hash, { node: commit.node, created: commit.created });
        counts = sum(counts, commit.counts);
      }
    }

    const signatureNodes = new Map<string, { node: string; created: boolean }>();
    const signatureOf = async (name: string, email: string): Promise<string | undefined> => {
      if (!wants('signature', 'vertex')) return undefined;
      const key = `${name}\u0000${email}`;
      const held = signatureNodes.get(key);
      if (held !== undefined) return held.node;
      const one = await signatureNodeOf(tx, name, email);
      signatureNodes.set(key, { node: one.node, created: one.created });
      if (one.created) counts = { ...counts, inserted: counts.inserted + 2 };
      return one.node;
    };

    // The commit's own opinion, its repository `history` edge and its position in the walk.
    for (const [walk, commit] of input.commits.entries()) {
      if (!wantCommit) break;
      const node = commitNodes.get(commit.hash)!.node;
      const [authorDate, authorOffset] = instantOf(commit.authorDate, 'authorDate', commit.hash);
      const [commitDate, commitOffset] = instantOf(commit.commitDate, 'commitDate', commit.hash);
      const written = await publishOpinion(tx, GIT_CONTRACT, {
        kind: GIT_KINDS.commit, nodeId: node, producer: HISTORY_PRODUCER, producerVersion: HISTORY_VERSION,
        values: { algorithm: hashAlgorithmOf(commit.hash), subject: commit.subject, author_date: authorDate, author_offset_min: authorOffset, commit_date: commitDate, commit_offset_min: commitOffset },
        evidence: [{ type: 'file', repository, commit_or_digest: commit.hash }],
      });
      if (written) counts = commitNodes.get(commit.hash)!.created ? { ...counts, inserted: counts.inserted + 1 } : { ...counts, updated: counts.updated + 1 };
      if (!wants('history', 'edge') || made === undefined) continue;
      const historyEdge = await edgeOf(tx, `${GIT_KINDS.history}`, made.nodeId, node, { producer: HISTORY_PRODUCER, producerVersion: HISTORY_VERSION, evidence: [{ type: 'file', repository, commit_or_digest: commit.hash }] });
      if (historyEdge.created) counts = { ...counts, inserted: counts.inserted + 1 }; else counts = { ...counts, unchanged: counts.unchanged + 1 };
      const walkWritten = await publishEdgeOpinion(tx, GIT_CONTRACT, `${GIT_KINDS.history}`, historyEdge.id, { values: { walk }, producer: HISTORY_PRODUCER, producerVersion: HISTORY_VERSION });
      if (walkWritten) counts = historyEdge.created ? { ...counts, inserted: counts.inserted + 1 } : { ...counts, updated: counts.updated + 1 };
      // The pass's entry is written in batches of its own loops, all in this transaction: a history whose journal grew to
      // 27 MB in one row (2 532 commits, 35 648 edges, 52 261 opinions) writes rows of a few megabytes (codex, item 7).
      await flushJournalIfFull(tx, journal);
    }

    // The parents: one edge commit -> parent, its position in the opinion table; the ones a rewritten commit no longer has go.
    if (wants('parent', 'edge') && wantCommit) {
      for (const commit of input.commits) {
        const node = commitNodes.get(commit.hash)!.node;
        const desired = new Map(commit.parents.map((hash, position) => [commitNodes.get(hash)!.node, position]));
        const held = await tx.query<{ id: string; to_node: string }>(
          `SELECT e.id::text AS id, e.to_node::text AS to_node FROM edge e JOIN entity en ON en.id = e.entity_id AND en.name = '${GIT_KINDS.parent}' WHERE e.from_node = $1::bigint AND e.context_id = 1`, [node],
        );
        for (const row of held.rows) {
          if (desired.has(row.to_node)) continue;
          await removeEdgeById(tx, GIT_CONTRACT, `${GIT_KINDS.parent}`, row.id);
          counts = { ...counts, deleted: counts.deleted + 1 };
        }
        for (const [parent, position] of desired) {
          const edge = await edgeOf(tx, `${GIT_KINDS.parent}`, node, parent, { producer: HISTORY_PRODUCER, producerVersion: HISTORY_VERSION, evidence: [{ type: 'file', repository, commit_or_digest: commit.hash }] });
          const positionWritten = await publishEdgeOpinion(tx, GIT_CONTRACT, `${GIT_KINDS.parent}`, edge.id, { values: { position }, producer: HISTORY_PRODUCER, producerVersion: HISTORY_VERSION });
          if (edge.created) counts = { ...counts, inserted: counts.inserted + 1 + (positionWritten ? 1 : 0) };
          else if (positionWritten) counts = { ...counts, updated: counts.updated + 1 };
          else counts = { ...counts, unchanged: counts.unchanged + 1 };
        }
      }
      await flushJournalIfFull(tx, journal);
    }

    // The signature of every commit: one `authored` edge, and a rewritten author replaces the one that stood.
    if (wants('authored', 'edge') && wantCommit) {
      for (const commit of input.commits) {
        const node = commitNodes.get(commit.hash)!.node;
        const signature = await signatureOf(commit.authorName, commit.authorEmail);
        if (signature === undefined) continue;
        const held = await tx.query<{ id: string; from_node: string }>(
          `SELECT e.id::text AS id, e.from_node::text AS from_node FROM edge e JOIN entity en ON en.id = e.entity_id AND en.name = '${GIT_KINDS.authored}' WHERE e.to_node = $1::bigint AND e.context_id = 1`, [node],
        );
        for (const row of held.rows) {
          if (row.from_node === signature) continue;
          await removeEdgeById(tx, GIT_CONTRACT, `${GIT_KINDS.authored}`, row.id);
          counts = { ...counts, deleted: counts.deleted + 1 };
        }
        if (!held.rows.some((row) => row.from_node === signature)) {
          await edgeOf(tx, `${GIT_KINDS.authored}`, signature, node, { producer: HISTORY_PRODUCER, producerVersion: HISTORY_VERSION, evidence: [{ type: 'file', repository, commit_or_digest: commit.hash }] });
          counts = { ...counts, inserted: counts.inserted + 1 };
        } else {
          counts = { ...counts, unchanged: counts.unchanged + 1 };
        }
      }
      await flushJournalIfFull(tx, journal);
    }

    // Every path the walk touched has its file vertex, even when the current tree no longer holds it. The oldest commit
    // that names it is the one the vertex's existence rests on.
    const fileNodes = new Map<string, string>();
    const firstSeen = new Map<string, string>();
    const wantFile = wants('file', 'vertex');
    for (const commit of [...input.commits].reverse()) {
      for (const entry of commit.touched) {
        if (!firstSeen.has(entry.path)) firstSeen.set(entry.path, commit.hash);
        if (entry.previousPath !== undefined && !firstSeen.has(entry.previousPath)) firstSeen.set(entry.previousPath, commit.hash);
      }
    }
    if (wantFile) {
      const allPaths = [...firstSeen.keys()].sort();
      const opinions: Parameters<typeof publishOpinion>[2][] = [];
      const nodes = await ensureVertices(tx, GIT_CONTRACT, GIT_KINDS.file, allPaths.map((path) => ({ repository: repositoryRef(repository), path })));
      for (const [index, path] of allPaths.entries()) {
        const one = nodes[index]!;
        fileNodes.set(path, one.nodeId);
        if (one.created) {
          opinions.push( { kind: GIT_KINDS.file, nodeId: one.nodeId, producer: HISTORY_PRODUCER, producerVersion: HISTORY_VERSION, evidence: [{ type: 'file', repository, commit_or_digest: firstSeen.get(path) ?? '', path }] });
          counts = { ...counts, inserted: counts.inserted + 2 };
          await flushJournalIfFull(tx, journal);
        }
      }
      await inBatches(opinions, async (chunk) => { await publishOpinions(tx, GIT_CONTRACT, chunk); });
    }
    // The touched edges: commit -> file, its opinion, and the `renamed-from` edge a rename states.
    if (wants('touched', 'edge') && wantCommit && wantFile) {
      const touchedEntity = entities.get(`${GIT_KINDS.touched}`)!;
      const desiredTouched = new Set<string>();
      const desiredRenamed = new Set<string>();
      const touchedRows: { commit: string; hash: string; file: string; path: string; change: string; added: number | null; removed: number | null; previous: string | null; previousPath: string | null }[] = [];
      for (const commit of input.commits) {
        const node = commitNodes.get(commit.hash)!.node;
        for (const entry of commit.touched) {
          const file = fileNodes.get(entry.path)!;
          desiredTouched.add(`${node}\u0000${file}`);
          touchedRows.push({ commit: node, hash: commit.hash, file, path: entry.path, change: entry.change, added: entry.added, removed: entry.removed, previous: entry.previousPath === undefined ? null : fileNodes.get(entry.previousPath)!, previousPath: entry.previousPath ?? null });
          if (entry.previousPath !== undefined) desiredRenamed.add(`${file}\u0000${fileNodes.get(entry.previousPath)!}\u0000${commit.hash}`);
        }
      }
      const standingTouched = new Set((await tx.query<{ from_node: string; to_node: string }>(
        `SELECT e.from_node::text AS from_node, e.to_node::text AS to_node FROM edge e WHERE e.entity_id = $1::bigint AND e.from_node = ANY($2::bigint[])`,
        [touchedEntity, walkCommitsBefore(touchedRows)],
      )).rows.map((row) => `${row.from_node}\u0000${row.to_node}`));
      await ensureEdges(tx, GIT_CONTRACT, `${GIT_KINDS.touched}`, touchedRows.map((row) => ({ from: row.commit, to: row.file })));
      for (const row of touchedRows) {
        const edge = await tx.query<{ id: string }>('SELECT id::text AS id FROM edge WHERE entity_id = $1::bigint AND from_node = $2::bigint AND to_node = $3::bigint AND discriminator = \'\'', [touchedEntity, row.commit, row.file]);
        const edgeId = edge.rows[0]!.id;
        const written = await publishEdgeOpinion(tx, GIT_CONTRACT, `${GIT_KINDS.touched}`, edgeId, {
          values: { change: row.change, added: row.added, removed: row.removed },
          evidence: [{ type: 'file', repository, commit_or_digest: row.hash, path: row.path }],
          producer: HISTORY_PRODUCER, producerVersion: HISTORY_VERSION,
        });
        const stood = standingTouched.has(`${row.commit}\u0000${row.file}`);
        if (!stood) counts = { ...counts, inserted: counts.inserted + 1 + (written ? 1 : 0) };
        else if (written) counts = { ...counts, updated: counts.updated + 1 };
        else counts = { ...counts, unchanged: counts.unchanged + 1 };
        if (row.previous !== null && wants('renamed-from', 'edge')) {
          const rename = await edgeOf(tx, `${GIT_KINDS.renamedFrom}`, row.file, row.previous, { producer: HISTORY_PRODUCER, producerVersion: HISTORY_VERSION, evidence: [{ type: 'file', repository, commit_or_digest: row.hash, path: row.previousPath ?? '' }] }, row.hash);
          if (rename.created) {
            await publishEdgeOpinion(tx, GIT_CONTRACT, `${GIT_KINDS.renamedFrom}`, rename.id, { values: {}, evidence: [{ type: 'file', repository, commit_or_digest: row.hash, path: row.previousPath ?? '' }], producer: HISTORY_PRODUCER, producerVersion: HISTORY_VERSION });
            counts = { ...counts, inserted: counts.inserted + 2 };
          }
        }
      }
      // A touched row the walk no longer states goes, and so does its rename; a commit that fell out of the walk keeps its vertex.
      const walkCommits = sqlIds(input.commits.map((commit) => commitNodes.get(commit.hash)!.node));
      const staleTouched = await tx.query<{ id: string; from_node: string; to_node: string }>(
        `SELECT e.id::text AS id, e.from_node::text AS from_node, e.to_node::text AS to_node FROM edge e JOIN entity en ON en.id = e.entity_id AND en.name = '${GIT_KINDS.touched}'
         WHERE e.from_node = ANY($1::bigint[]) AND e.context_id = 1`, [walkCommits],
      );
      for (const row of staleTouched.rows) if (!desiredTouched.has(`${row.from_node}\u0000${row.to_node}`)) { await removeEdgeById(tx, GIT_CONTRACT, `${GIT_KINDS.touched}`, row.id); counts = { ...counts, deleted: counts.deleted + 1 }; }
      if (wants('renamed-from', 'edge')) {
        const staleRenamed = await tx.query<{ id: string; from_node: string; to_node: string; discriminator: string }>(
          `SELECT e.id::text AS id, e.from_node::text AS from_node, e.to_node::text AS to_node, e.discriminator FROM edge e JOIN entity en ON en.id = e.entity_id AND en.name = '${GIT_KINDS.renamedFrom}'
           WHERE e.discriminator = ANY($1::text[]) AND e.context_id = 1`, [sqlText(input.commits.map((commit) => commit.hash))],
        );
        for (const row of staleRenamed.rows) if (!desiredRenamed.has(`${row.from_node}\u0000${row.to_node}\u0000${row.discriminator}`)) { await removeEdgeById(tx, GIT_CONTRACT, `${GIT_KINDS.renamedFrom}`, row.id); counts = { ...counts, deleted: counts.deleted + 1 }; }
      }
    }


    await writeJournal(tx, journal);

    return counts;
  });
}

/**
 * A `%aI` instant as a timestamp text and its offset in minutes: git's own two numbers, kept apart.
 *
 * Git writes the offset as `+HH:MM` or `-HH:MM`, and — from the version whose dates are strict ISO 8601 with a
 * zero offset — as the bare `Z` every reader of `+00:00` also means. Both are one statement of the same zero
 * minutes east of UTC, so both are read here; anything else is refused by name.
 */
export function instantOf(text: string, field: string, hash: string): [string, number] {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:(Z)|([+-])(\d{2}):(\d{2}))$/u.exec(text.trim());
  if (match === null) raise(`the commit ${hash} names its ${field} as ${JSON.stringify(text)}, and a git date is YYYY-MM-DDTHH:MM:SS+HH:MM or YYYY-MM-DDTHH:MM:SSZ`);
  if (match[2] === 'Z') return [`${match[1]}Z`, 0];
  const sign = match[3] === '-' ? -1 : 1;
  return [`${match[1]}Z`, sign * (Number(match[4]) * 60 + Number(match[5]))];
}

// ---- what a reader asks ----------------------------------------------------

/**
 * One open opinion of a vertex or an edge, as the record reads hold it: its id (one sequence for the whole graph), the
 * producer and its version, the language of its text, the tagged evidence it rests on, and the field values it states.
 */
export interface HeldOpinion {
  readonly id: string;
  readonly saidBy: string;
  /** The producer's name, without its version: a new version is the same producer. */
  readonly producer: string;
  readonly lang: string | null;
  readonly evidence: readonly EvidenceEntry[];
  readonly values: Readonly<Record<string, unknown>>;
}

/** One value of one field and the opinion that stated it: value-to-source is never lost. */
export interface FieldValue<T> {
  readonly value: T;
  readonly opinion: HeldOpinion;
}

/** One field as the reads answer it: every opinion's value, and the value they all agree on (null when they differ). */
export interface FieldRead<T> {
  readonly value: T | null;
  readonly contested: boolean;
  readonly values: readonly FieldValue<T>[];
}

/** The opinions one aggregate reads, from the jsonb array a page's statement builds. */
function opinionsOfJson(value: unknown, carried: readonly string[]): HeldOpinion[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const held = (entry ?? {}) as Record<string, unknown>;
    const saidBy = String(held['said_by'] ?? '');
    const at = saidBy.lastIndexOf('@');
    const values: Record<string, unknown> = {};
    for (const field of [...carried, 'lang', 'mode', 'blob_id', 'language', 'languages', 'subject', 'author_date', 'author_offset_min', 'commit_date', 'commit_offset_min', 'url', 'default_branch', 'history_shallow', 'change', 'added', 'removed', 'walk', 'position', 'other_repository', 'commit_hash', 'algorithm']) values[field] = held[field];
    return {
      id: String(held['id'] ?? ''),
      saidBy,
      producer: at < 0 ? saidBy : saidBy.slice(0, at),
      lang: held['lang'] === null || held['lang'] === undefined ? null : String(held['lang']),
      evidence: Array.isArray(held['evidence']) ? held['evidence'] as readonly EvidenceEntry[] : [],
      values,
    };
  });
}

/** One field across opinions: every value with its source, and the value they all agree on. */
export function fieldRead<T>(opinions: readonly HeldOpinion[], field: string, convert: (value: unknown) => T | null): FieldRead<T> {
  const values: FieldValue<T>[] = [];
  for (const opinion of opinions) {
    const held = convert(opinion.values[field]);
    if (held === null || held === undefined) continue;
    values.push({ value: held, opinion });
  }
  const distinct = new Set(values.map((one) => JSON.stringify(one.value)));
  return { value: distinct.size === 1 ? values[0]!.value : null, contested: distinct.size > 1, values };
}

/** A value as a text, or null where the opinion states none. */
function asText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** A value as a number, or null where the opinion states none. */
function asNumber(value: unknown): number | null {
  return value === null || value === undefined || value === '' ? null : Number(value);
}

/** Whether a file stands in its repository's current tree: the `contains` edge is what places it there. */
const IN_TREE = `EXISTS (SELECT 1 FROM edge e JOIN entity en2 ON en2.id = e.entity_id AND en2.name = '${GIT_KINDS.contains}' WHERE e.to_node = n.id)`;

/** The opinions of one file, as a jsonb array: each opinion's id, producer, language, evidence and the values it states. */
const FILE_OPINIONS = `LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence",
      'mode', o."mode", 'blob_id', o."blob_id", 'language', o."language", 'languages', o."languages",
      'blob', b."hash", 'bytes', b."bytes"::text, 'form', b."form", 'lines', b."lines"::text) ORDER BY o."id") AS opinions
    FROM ${GIT_TABLES.file} o LEFT JOIN ${GIT_TABLES.blob} b ON b.id = o."blob_id"
    WHERE o."node_id" = n.id AND o."state" = 'open' AND o."context_id" = 1) fo ON true`;

/** The file columns a page reads: its key's path, and every open opinion of it with the blob it names. */
const FILE_SELECT = `SELECT (n.key->>'path') AS path, fo.opinions
  FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.file}'
  ${FILE_OPINIONS}`;

/** One file as a reader sees it: the fields every open opinion agrees on, and the opinions themselves. */
export interface FileRecord {
  readonly path: string;
  readonly mode: string | null;
  readonly blob: string | null;
  readonly bytes: number | null;
  readonly form: 'text' | 'binary' | null;
  readonly lines: number | null;
  /** The accepted language, or null when the opinions name candidates and no one language. */
  readonly language: string | null;
  readonly candidates: readonly string[];
  /** Every open opinion about the file, with its source: a field's value is never shown without it. */
  readonly opinions?: readonly HeldOpinion[];
}

/** One file as a reader sees it: the fields every open opinion agrees on, and the opinions themselves. */
function fileOf(row: Record<string, unknown>): FileRecord {
  const opinions = opinionsOfJson(row['opinions'], ['blob', 'bytes', 'form', 'lines']);
  const mode = fieldRead(opinions, 'mode', asText);
  const blob = fieldRead(opinions, 'blob', asText);
  const languages = fieldRead(opinions, 'languages', (value) => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : null));
  const language = fieldRead(opinions, 'language', asText);
  return {
    path: String(row['path']),
    mode: mode.value,
    blob: blob.value,
    bytes: fieldRead(opinions, 'bytes', asNumber).value,
    form: fieldRead(opinions, 'form', (value) => (value === 'binary' ? 'binary' : value === 'text' ? 'text' : null)).value,
    lines: fieldRead(opinions, 'lines', asNumber).value,
    language: language.value,
    candidates: [...(languages.value ?? (language.value === null ? [] : [language.value]))],
    opinions,
  };
}

/** One page's repository id: every read of a page's folder and files asks for it, and it is read once. */
const REPOSITORY_ID_MEMO = new WeakMap<object, Map<string, Promise<string>>>();

/** The repository's node id, or a gap when the store holds no such repository: read once per transaction. */
async function repositoryIdOf(tx: OuterTransaction, repository: string): Promise<string> {
  const memo = REPOSITORY_ID_MEMO.get(tx) ?? new Map<string, Promise<string>>();
  REPOSITORY_ID_MEMO.set(tx, memo);
  const held = memo.get(repository);
  if (held !== undefined) return await held;
  const read = readRepositoryId(tx, repository);
  memo.set(repository, read);
  read.catch(() => { if (memo.get(repository) === read) memo.delete(repository); });
  return await read;
}

/** The id of one repository, in one statement. */
async function readRepositoryId(tx: OuterTransaction, repository: string): Promise<string> {
  const found = await tx.query<{ node_id: string }>(
    `SELECT n.id::text AS node_id FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.repository}' WHERE n.key @> jsonb_build_object('name', $1::text) AND n.context_id = 1 AND NOT n.removed`,
    [repository],
  );
  const row = found.rows[0];
  if (row === undefined) throw new RecordGap(`the store holds no repository ${JSON.stringify(repository)}: the fill of this step has not run for it (src/graph/records.ts)`);
  return row.node_id;
}


/** The files one page of a repository holds, paged in SQL before any opinion is loaded. */
async function filePage(tx: OuterTransaction, repository: string, where: string, extra: readonly unknown[], after: string | null, limit: number): Promise<Record<string, unknown>[]> {
  const found = await tx.query<Record<string, unknown>>(
    `SELECT (n.key->>'path') AS path, fo.opinions FROM (
       SELECT n.id FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.file}'
       WHERE (n.key->'repository'->'key'->>'name') = $1::text AND n.context_id = 1 AND NOT n.removed AND ${IN_TREE} AND ${where}
         AND ($2::text IS NULL OR (n.key->>'path') > $2) ORDER BY (n.key->>'path') LIMIT $3::bigint) p
     JOIN node n ON n.id = p.id ${FILE_OPINIONS} ORDER BY (n.key->>'path')`,
    [repository, after, String(limit + 1), ...extra],
  );
  return found.rows;
}

export async function listFiles(owner: DatabaseOwner, input: { readonly repository: string; readonly prefix?: string; readonly language?: string; readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
  return await withSpan('records.listFiles', {
    'records.prefix': input.prefix ?? '',
    'records.language': input.language ?? '',
    'records.limit': input.limit,
  }, async () => await owner.transaction('snapshot', async (tx) => {
    await repositoryIdOf(tx, input.repository);
    const where = `($4::text IS NULL OR left((n.key->>'path'), length($4::text)) = $4::text)
      AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM ${GIT_TABLES.file} lo WHERE lo."node_id" = n.id AND lo."state" = 'open' AND lo."context_id" = 1 AND lo."language" = $5))`;
    const found = await filePage(tx, input.repository, where, [input.prefix ?? null, input.language ?? null], input.after ?? null, input.limit);
    const rows = found.map(fileOf);
    const more = rows.length > input.limit;
    const shown = more ? rows.slice(0, input.limit) : rows;
    return { rows: shown, next: more ? shown[shown.length - 1]!.path : null };
  }));
}

/**
 * One page of a repository's current Markdown documents, in code point order of the paths. The suffix and the
 * hidden-folder rules stand in the statement, so a repository of many files answers with its documents and never with
 * the first files of the whole tree: a path a dot begins, and a path a folder a dot begins, is no document.
 */
export async function listDocuments(owner: DatabaseOwner, input: { readonly repository: string; readonly suffixes: readonly string[]; readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
  return await withSpan('records.listDocuments', {
    'records.repository': input.repository,
    'records.limit': input.limit,
  }, async () => await owner.transaction('snapshot', async (tx) => {
    // The documents are the mechanism tree's for every repository: a product that binds no code entity lists its own
    // Markdown (madarch-hsqs stage C).
    const found = await tx.query<{ path: string; mode: string | null; blob: string | null; bytes: string | null; form: string | null; lines: string | null }>(
      `SELECT p.text AS path, f.mode, b.hash AS blob, b.bytes::text AS bytes, b.form, b.lines::text AS lines
       FROM ${FILE_ENTRY_TABLE} f JOIN ${FILE_PATH_TABLE} p ON p.id = f.path_id LEFT JOIN ${FILE_BLOB_TABLE} b ON b.id = f.blob_id
       WHERE f.repository = $1
         AND left(p.text, 1) <> '.' AND position('/.' in p.text) = 0
         AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS suffix WHERE right(lower(p.text), length(suffix)) = suffix)
         AND ($3::text IS NULL OR p.text > $3) ORDER BY p.text LIMIT $4::bigint`,
      [input.repository, [...input.suffixes], input.after ?? null, String(input.limit + 1)],
    );
    const rows = found.rows.map((row) => ({
      path: row.path,
      mode: row.mode,
      blob: row.blob,
      bytes: row.bytes === null ? null : Number(row.bytes),
      form: row.form === 'binary' ? 'binary' as const : row.form === 'text' ? 'text' as const : null,
      lines: row.lines === null ? null : Number(row.lines),
      language: null,
      candidates: [],
    }));
    const more = rows.length > input.limit;
    const shown = more ? rows.slice(0, input.limit) : rows;
    return { rows: shown, next: more ? shown[shown.length - 1]!.path : null };
  }));
}

/** One path a commit changed, as the history pass read it. */
export interface TouchedRecord {
  readonly path: string;
  readonly change: 'added' | 'modified' | 'deleted' | 'renamed' | null;
  readonly added: number | null;
  readonly removed: number | null;
  readonly previousPath: string | null;
  /** Every opinion of what the commit did to the path, with its source. */
  readonly opinions?: readonly HeldOpinion[];
}

/** One row of a file's history: the commit that touched the path and what it did to it. */
export interface FileHistoryRow extends TouchedRecord {
  readonly commit: string;
  /** The author's clock with its offset, as `git log %aI` writes it. */
  readonly date: string;
  /** The offset `date` stands at, in minutes east of UTC: the same number `date` carries. */
  readonly offsetMin: number;
  readonly subject: string;
  /** The commit's position in the walk from the tip: its order in the history, not on the clock. */
  readonly walk: number;
}

/** What one commit did to a path, from the opinions that agree on it. */
function changeOf(opinions: readonly HeldOpinion[]): TouchedRecord['change'] {
  const value = fieldRead<string>(opinions, 'change', (one) => (typeof one === 'string' ? one : null)).value;
  return value === 'added' || value === 'modified' || value === 'deleted' || value === 'renamed' ? value : null;
}

/** The SQL that reaches a file and every path it was renamed from, through `renamed-from` edges (new file to old). */
const RENAME_CHAIN = `WITH RECURSIVE chain(file_node) AS (
    SELECT n.id FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.file}'
    WHERE n.key @> jsonb_build_object('repository', jsonb_build_object('kind', '${GIT_KINDS.repository}', 'key', jsonb_build_object('name', (SELECT rn.key->>'name' FROM node rn WHERE rn.id = $1::bigint))), 'path', $2::text)
    UNION
    SELECT e.to_node FROM chain c JOIN edge e ON e.from_node = c.file_node JOIN entity ek ON ek.id = e.entity_id AND ek.name = '${GIT_KINDS.renamedFrom}'
  )`;

/** The open opinions of one `touched` edge, as a jsonb array. */
const TOUCHED_OPINIONS = (edge: string): string => `(SELECT jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence", 'change', o."change", 'added', o."added", 'removed', o."removed") ORDER BY o."id") FROM ${GIT_TABLES.touched} o WHERE o."edge_id" = ${edge}.id AND o."state" = 'open' AND o."context_id" = 1)`;
/** The open opinions of one `history` edge (its walk), as a jsonb array. */
const WALK_OPINIONS = (edge: string): string => `(SELECT jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence", 'walk', o."walk") ORDER BY o."id") FROM ${GIT_TABLES.history} o WHERE o."edge_id" = ${edge}.id AND o."state" = 'open' AND o."context_id" = 1)`;
/** The open opinions of one commit, as a jsonb array. */
const COMMIT_OPINIONS = (node: string): string => `(SELECT jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence", 'subject', o."subject", 'author_date', to_char(o."author_date" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'), 'author_offset_min', o."author_offset_min", 'commit_date', to_char(o."commit_date" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'), 'commit_offset_min', o."commit_offset_min") ORDER BY o."id") FROM ${GIT_TABLES.commit} o WHERE o."node_id" = ${node}.id AND o."state" = 'open' AND o."context_id" = 1)`;

/** One commit's clock as `%aI` writes it, from the opinions that agree on it. */
function clockOf(opinions: readonly HeldOpinion[], field: 'commit_date' | 'author_date', offsetField: 'commit_offset_min' | 'author_offset_min'): { readonly date: string; readonly offsetMin: number } {
  const clock = fieldRead(opinions, field, (value) => (value instanceof Date ? value.toISOString().slice(0, 19) : typeof value === 'string' ? value.slice(0, 19) : null)).value;
  const offset = fieldRead(opinions, offsetField, asNumber).value ?? 0;
  return { date: clock === null ? '' : gitDateOf(clock, offset), offsetMin: offset };
}

/**
 * A page of a file's history, newest first. `next` names the exact row the page ended on — the walk and the commit — so
 * a page boundary between two commits written in the same second neither repeats a row nor skips one.
 */
export async function fileHistory(owner: DatabaseOwner, input: { readonly repository: string; readonly path: string; readonly after?: { readonly walk: number; readonly commit: string }; readonly limit: number }): Promise<{ readonly rows: readonly FileHistoryRow[]; readonly next: { readonly walk: number; readonly commit: string } | null }> {
  return await withSpan('records.fileHistory', { 'records.path': input.path, 'records.limit': input.limit }, async () => await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, input.repository);
    const found = await tx.query<Record<string, unknown>>(
      `${RENAME_CHAIN}
       SELECT (ct.key->>'hash') AS commit, ${TOUCHED_OPINIONS('e')} AS touched, ${COMMIT_OPINIONS('ct')} AS commit_opinions, ${WALK_OPINIONS('he')} AS walk, ${PATH_OF('pn')} AS previous
       FROM chain ch JOIN edge e ON e.to_node = ch.file_node JOIN entity ek ON ek.id = e.entity_id AND ek.name = '${GIT_KINDS.touched}'
       JOIN node ct ON ct.id = e.from_node
       JOIN edge he ON he.from_node = $1::bigint AND he.to_node = e.from_node AND he.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.history}') AND he.context_id = 1
       LEFT JOIN edge r ON r.from_node = ch.file_node AND r.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.renamedFrom}') AND r.context_id = 1 AND r.discriminator = (ct.key->>'hash')
       LEFT JOIN node pn ON pn.id = r.to_node
       WHERE ($3::int IS NULL OR (SELECT min((o.item->>'walk')::int) FROM jsonb_array_elements(${WALK_OPINIONS('he')}) AS o(item)) > $3::int OR ((SELECT min((o.item->>'walk')::int) FROM jsonb_array_elements(${WALK_OPINIONS('he')}) AS o(item)) = $3::int AND (ct.key->>'hash') > $4))
       ORDER BY (SELECT min((o.item->>'walk')::int) FROM jsonb_array_elements(${WALK_OPINIONS('he')}) AS o(item)) ASC, (ct.key->>'hash') ASC LIMIT $5::bigint`,
      [repositoryId, input.path, input.after?.walk ?? null, input.after?.commit ?? '', String(input.limit + 1)],
    );
    const rows = found.rows.map((row) => {
      const touched = opinionsOfJson(row['touched'], []);
      const commitOpinions = opinionsOfJson(row['commit_opinions'], []);
      const walk = opinionsOfJson(row['walk'], []).map((one) => Number(one.values['walk'])).sort((a, b) => a - b)[0] ?? 0;
      const clock = clockOf(commitOpinions, 'commit_date', 'commit_offset_min');
      return {
        commit: String(row['commit']), path: input.path,
        change: changeOf(touched),
        added: fieldRead(touched, 'added', asNumber).value,
        removed: fieldRead(touched, 'removed', asNumber).value,
        previousPath: row['previous'] === null || row['previous'] === undefined ? null : String(row['previous']),
        date: clock.date, offsetMin: clock.offsetMin,
        subject: fieldRead(commitOpinions, 'subject', asText).value ?? '',
        walk, opinions: touched,
      } satisfies FileHistoryRow;
    });
    const more = rows.length > input.limit;
    const shown = more ? rows.slice(0, input.limit) : rows;
    const last = shown[shown.length - 1];
    return { rows: shown, next: more && last !== undefined ? { walk: last.walk, commit: last.commit } : null };
  }));
}

/** One commit with the paths it changed, or null when the store holds no such commit. */
/** One page's commit read, bound to the page's transaction: a page asks for the same commit twice, and reads it once. */
const COMMIT_MEMO = new WeakMap<object, Map<string, Promise<(CommitRecord & { readonly touched: readonly TouchedRecord[] }) | null>>>();

/** One commit with the paths it changed, or null when the store holds no such commit; read once per transaction. */
export async function commitWithPaths(owner: DatabaseOwner, repository: string, hash: string): Promise<(CommitRecord & { readonly touched: readonly TouchedRecord[] }) | null> {
  return await withSpan('records.commitPaths', { 'records.commit': hash }, async () => await owner.transaction('snapshot', async (tx) => {
    const memo = COMMIT_MEMO.get(tx) ?? new Map<string, Promise<(CommitRecord & { readonly touched: readonly TouchedRecord[] }) | null>>();
    COMMIT_MEMO.set(tx, memo);
    const held = memo.get(hash);
    if (held !== undefined) return await held;
    const read = readCommitWithPaths(tx, repository, hash);
    memo.set(hash, read);
    read.catch(() => { if (memo.get(hash) === read) memo.delete(hash); });
    return await read;
  }));
}

/** The commit and its changed paths, in statements of this transaction; `commitWithPaths` shares the result per page. */
async function readCommitWithPaths(tx: OuterTransaction, repository: string, hash: string): Promise<(CommitRecord & { readonly touched: readonly TouchedRecord[] }) | null> {
  const commit = await readCommitFacts(tx, repository, hash);
  if (commit === null) return null;
  const found = await tx.query<Record<string, unknown>>(
    // The touched rows and their opinions in one pass, grouped per edge: no opinion subquery per row (the page's
    // history navigation reads a commit's 1 800 changed paths, and a query per row made that span four times main's).
    `SELECT ${PATH_OF('fn')} AS path,
            jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence", 'change', o."change", 'added', o."added", 'removed', o."removed") ORDER BY o."id") AS touched,
            ${PATH_OF('pn')} AS previous
     FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.touched}'
     JOIN node ct ON ct.id = e.from_node JOIN node fn ON fn.id = e.to_node
     LEFT JOIN ${GIT_TABLES.touched} o ON o."edge_id" = e.id AND o."state" = 'open' AND o."context_id" = 1
     LEFT JOIN edge r ON r.from_node = e.to_node AND r.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.renamedFrom}') AND r.context_id = 1 AND r.discriminator = (ct.key->>'hash')
     LEFT JOIN node pn ON pn.id = r.to_node
     WHERE (ct.key->>'hash') = $1
     GROUP BY e.id, ${PATH_OF('fn')}, ${PATH_OF('pn')}
     ORDER BY ${PATH_OF('fn')}`,
    [hash],
  );
  const touched = found.rows.map((row) => {
    const opinions = opinionsOfJson(row['touched'], []);
    return {
      path: String(row['path']),
      change: changeOf(opinions),
      added: fieldRead(opinions, 'added', asNumber).value,
      removed: fieldRead(opinions, 'removed', asNumber).value,
      previousPath: row['previous'] === null || row['previous'] === undefined ? null : String(row['previous']),
      opinions,
    };
  });
  return { ...commit, touched };
}

/** One page of a folder's own files (not its subfolders'), in code point order of the paths. */
export async function folderFiles(owner: DatabaseOwner, input: { readonly repository: string; readonly folder: string; readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
  return await withSpan('records.folderFiles', { 'records.folder': input.folder, 'records.limit': input.limit }, async () => await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, input.repository);
    const parent = input.folder === '' ? repositoryId : (await tx.query<{ node_id: string }>(`SELECT n.id::text AS node_id FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.directory}' WHERE (n.key->'repository'->'key'->>'name') = $1::text AND (n.key->>'path') = $2::text AND n.context_id = 1 AND NOT n.removed`, [input.repository, input.folder])).rows[0]?.node_id;
    if (parent === undefined) return { rows: [], next: null };
    const found = await tx.query<Record<string, unknown>>(
      `SELECT (n.key->>'path') AS path, fo.opinions FROM (
         SELECT n.id FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.file}'
         JOIN edge e ON e.to_node = n.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}')
         WHERE e.from_node = $1::bigint AND e.context_id = 1 AND NOT n.removed AND ($2::text IS NULL OR (n.key->>'path') > $2)
         ORDER BY (n.key->>'path') LIMIT $3::bigint) p
       JOIN node n ON n.id = p.id ${FILE_OPINIONS} ORDER BY (n.key->>'path')`,
      [parent, input.after ?? null, String(input.limit + 1)],
    );
    const rows = found.rows.map(fileOf);
    const more = rows.length > input.limit;
    const shown = more ? rows.slice(0, input.limit) : rows;
    return { rows: shown, next: more ? shown[shown.length - 1]!.path : null };
  }));
}

/** The immediate subfolders of one folder, in code point order; `''` is the repository's root. */
export async function folderChildrenOf(owner: DatabaseOwner, repository: string, folder: string): Promise<readonly string[]> {
  return await withSpan('records.folderChildren', { 'records.folder': folder }, async () => await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, repository);
    const parent = folder === '' ? repositoryId : (await tx.query<{ node_id: string }>(`SELECT n.id::text AS node_id FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.directory}' WHERE (n.key->'repository'->'key'->>'name') = $1::text AND (n.key->>'path') = $2::text AND n.context_id = 1 AND NOT n.removed`, [repository, folder])).rows[0]?.node_id;
    if (parent === undefined) return [];
    const found = await tx.query<{ path: string }>(
      `SELECT (dn.key->>'path') AS path FROM edge e
       JOIN node dn ON dn.id = e.to_node AND dn.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.directory}')
       WHERE e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}') AND e.from_node = $1::bigint AND e.context_id = 1
       ORDER BY (dn.key->>'path')`, [parent],
    );
    return found.rows.map((row) => row.path);
  }));
}

/** One date a file's page states: the author's clock with its offset, and the commit it belongs to. */
export interface FileDate {
  /** The author's clock with its offset, as `git log %aI` writes it. */
  readonly date: string;
  /** The offset `date` stands at, in minutes east of UTC: the same number `date` carries. */
  readonly offsetMin: number;
  readonly commit: string;
  readonly author: string;
}

export async function fileFacts(owner: DatabaseOwner, repository: string, path: string, options: { readonly history?: boolean } = {}): Promise<(FileRecord & { readonly created: FileDate | null; readonly modified: FileDate | null; readonly commitCount: number; readonly authors: readonly string[] }) | null> {
  return await withSpan('records.fileFacts', { 'records.path': path }, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<Record<string, unknown>>(`${FILE_SELECT} WHERE (n.key->'repository'->'key'->>'name') = $1::text AND (n.key->>'path') = $2::text AND n.context_id = 1 AND NOT n.removed`, [repository, path]);
    const row = found.rows[0];
    if (row === undefined) return null;
    // A product that declares no commit, touched or history kind holds no history table: the file's own facts stand,
    // and its dates and authors are absent rather than a read of a table the manifest never made (madarch-hsqs stage C).
    if (options.history === false) return { ...fileOf(row), created: null, modified: null, commitCount: 0, authors: [] };
    const repositoryId = await repositoryIdOf(tx, repository);
    const history = await tx.query<Record<string, unknown>>(
      `${RENAME_CHAIN}
       SELECT (ct.key->>'hash') AS commit, ${COMMIT_OPINIONS('ct')} AS commit_opinions, ${WALK_OPINIONS('he')} AS walk, (sn.key->>'name') AS name
       FROM chain ch JOIN edge e ON e.to_node = ch.file_node JOIN entity ek ON ek.id = e.entity_id AND ek.name = '${GIT_KINDS.touched}'
       JOIN node ct ON ct.id = e.from_node
       JOIN edge he ON he.from_node = $1::bigint AND he.to_node = e.from_node AND he.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.history}') AND he.context_id = 1
       LEFT JOIN edge a ON a.to_node = e.from_node AND a.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.authored}') AND a.context_id = 1 LEFT JOIN node sn ON sn.id = a.from_node
       WHERE $2 = $2 ORDER BY (SELECT min((o.item->>'walk')::int) FROM jsonb_array_elements(${WALK_OPINIONS('he')}) AS o(item)) ASC, (ct.key->>'hash') ASC`,
      [repositoryId, path],
    );
    const commits = history.rows.map((entry) => {
      const opinions = opinionsOfJson(entry['commit_opinions'], []);
      const clock = clockOf(opinions, 'commit_date', 'commit_offset_min');
      const walk = opinionsOfJson(entry['walk'], []).map((one) => Number(one.values['walk'])).sort((a, b) => a - b)[0] ?? 0;
      return { commit: String(entry['commit']), date: clock.date, offsetMin: clock.offsetMin, name: String(entry['name'] ?? ''), walk };
    });
    const created = commits.reduce((deepest, entry) => (entry.walk > deepest.walk ? entry : deepest), commits[0]!);
    const last = commits[0];
    const distinct = new Map(commits.map((entry) => [entry.commit, entry]));
    const authors = [...new Set(commits.map((entry) => entry.name).filter((name) => name !== ''))].sort();
    return {
      ...fileOf(row),
      created: created === undefined ? null : { date: created.date, offsetMin: created.offsetMin, commit: created.commit, author: created.name },
      modified: last === undefined ? null : { date: last.date, offsetMin: last.offsetMin, commit: last.commit, author: last.name },
      commitCount: distinct.size,
      authors,
    };
  }));
}

/** The text of many files of a repository's current tree, by path: the listing's titles read in one statement. */
/** The text of many files of a repository's current tree, by path: the listing's titles read in one statement. */
export async function storedFileTexts(owner: DatabaseOwner, repository: string, paths: readonly string[]): Promise<Map<string, string | null>> {
  const answer = new Map<string, string | null>();
  if (paths.length === 0) return answer;
  return await withSpan('records.fileContents', { 'records.repository': repository, 'records.paths': paths.length }, async () => await owner.transaction('snapshot', async (tx) => {
    // The product repository's files are mechanism state (`file_entry`): the text is the blob the entry stands in, for
    // every product, whatever entities it declares (madarch-hsqs stage C).
    const found = await tx.query<{ path: string; content: string | null }>(
      `SELECT p.text AS path, b.content FROM ${FILE_ENTRY_TABLE} f
       JOIN ${FILE_PATH_TABLE} p ON p.id = f.path_id LEFT JOIN ${FILE_BLOB_TABLE} b ON b.id = f.blob_id
       WHERE f.repository = $1 AND p.text = ANY($2::text[])`,
      [repository, [...paths]],
    );
    for (const row of found.rows) answer.set(row.path, row.content);
    return answer;
  }));
}

/** Every file of one repository's current tree as the mechanism holds it, in code point order of the paths. */
export async function repositoryFileIndex(owner: DatabaseOwner, repository: string): Promise<readonly FileRecord[]> {
  return await withSpan('records.repositoryFileIndex', { 'records.repository': repository }, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ path: string; mode: string | null; blob: string | null; bytes: string | null; form: string | null; lines: string | null }>(
      `SELECT p.text AS path, f.mode, b.hash AS blob, b.bytes::text AS bytes, b.form, b.lines::text AS lines
       FROM ${FILE_ENTRY_TABLE} f JOIN ${FILE_PATH_TABLE} p ON p.id = f.path_id LEFT JOIN ${FILE_BLOB_TABLE} b ON b.id = f.blob_id
       WHERE f.repository = $1 ORDER BY p.text`,
      [repository],
    );
    // The mechanism states no language: the language a code entity claims is an opinion of the entity's table.
    return found.rows.map((row) => ({
      path: row.path,
      mode: row.mode,
      blob: row.blob,
      bytes: row.bytes === null ? null : Number(row.bytes),
      form: row.form === 'binary' ? 'binary' as const : row.form === 'text' ? 'text' as const : null,
      lines: row.lines === null ? null : Number(row.lines),
      language: null,
      candidates: [],
    }));
  }));
}

/** The text of one file in a repository's current tree: null when the store holds none (binary, unread, or the path left the tree). */
/** The text of one file in a repository's current tree: null when the store holds none (binary, unread, or the path left the tree). */
export async function storedFileText(owner: DatabaseOwner, repository: string, path: string): Promise<string | null> {
  return await withSpan('records.fileContent', { 'records.path': path }, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ content: string | null }>(
      `SELECT b.content FROM ${FILE_ENTRY_TABLE} f
       JOIN ${FILE_PATH_TABLE} p ON p.id = f.path_id LEFT JOIN ${FILE_BLOB_TABLE} b ON b.id = f.blob_id
       WHERE f.repository = $1 AND p.text = $2 LIMIT 1`,
      [repository, path],
    );
    return found.rows[0]?.content ?? null;
  }));
}



/** Every repository the store holds, in code point order of the names. */
export async function listRepositories(owner: DatabaseOwner, declared?: ReadonlySet<string>): Promise<readonly { readonly name: string; readonly url: string; readonly defaultBranch: string | null; readonly asIsCommit: string | null }[]> {
  // A product that declares no repository kind has no repository table: its contract answers no repository, and the
  // SQL never names a table the manifest did not make (madarch-hsqs stage C). A caller that names no contract asks the
  // store's own materialized declaration first — one statement on the base entity table, never a failed read.
  if (declared !== undefined && !declared.has(GIT_KINDS.repository)) return [];
  return await withSpan('records.listRepositories', {}, async () => await owner.transaction('snapshot', async (tx) => {
    if (declared === undefined && (await tx.query<{ id: string }>("SELECT id FROM entity WHERE name = $1 LIMIT 1", [GIT_KINDS.repository])).rows.length === 0) return [];
    const found = await tx.query<{ name: string; opinions: unknown; as_is: string | null }>(
      `SELECT (n.key->>'name') AS name,
         (SELECT jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence", 'url', o."url", 'default_branch', o."default_branch") ORDER BY o."id") FROM ${GIT_TABLES.repository} o WHERE o."node_id" = n.id AND o."state" = 'open' AND o."context_id" = 1) AS opinions,
         (SELECT (c.key->>'hash') FROM edge e JOIN entity ek ON ek.id = e.entity_id AND ek.name = '${GIT_KINDS.asIs}' JOIN node c ON c.id = e.to_node WHERE e.from_node = n.id LIMIT 1) AS as_is
       FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.repository}' WHERE NOT n.removed ORDER BY (n.key->>'name')`,
    );
    return found.rows.map((row) => {
      const opinions = opinionsOfJson(row.opinions, []);
      return { name: row.name, url: fieldRead(opinions, 'url', asText).value ?? '', defaultBranch: fieldRead(opinions, 'default_branch', asText).value, asIsCommit: row.as_is };
    });
  }));
}

/** Every folder of one repository's current tree, in code point order of the paths, with the parent it hangs from. */
export async function listDirectories(owner: DatabaseOwner, repository: string): Promise<readonly { readonly path: string; readonly parent: string }[]> {
  return await withSpan('records.listDirectories', { 'records.repository': repository }, async () => await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, repository);
    const found = await tx.query<{ path: string; parent: string }>(
      `SELECT (n.key->>'path') AS path, coalesce((pn.key->>'path'), '') AS parent
       FROM node n
       JOIN edge e ON e.to_node = n.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}') AND e.context_id = 1
       LEFT JOIN node pn ON pn.id = e.from_node AND pn.id <> $1::bigint
       WHERE n.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.directory}')
         AND (n.key->'repository'->'key'->>'name') = $2::text AND n.context_id = 1 AND NOT n.removed ORDER BY (n.key->>'path')`,
      [repositoryId, repository],
    );
    return found.rows;
  }));
}

/** One commit with its parents, its author and its dates, from the opinions that agree on them. */
/** The commit's own facts in one statement each, in the transaction the caller holds. */
async function readCommitFacts(tx: OuterTransaction, _repository: string, hash: string): Promise<CommitRecord | null> {
  const found = await tx.query<{ commit: string; opinions: unknown; author_name: string; author_email: string }>(
    `SELECT (c.key->>'hash') AS commit, ${COMMIT_OPINIONS('c')} AS opinions, coalesce(sn.key->>'name', '') AS author_name, coalesce(sn.key->>'email', '') AS author_email
     FROM node c JOIN entity en ON en.id = c.entity_id AND en.name = '${GIT_KINDS.commit}'
     LEFT JOIN edge e ON e.to_node = c.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.authored}')
     LEFT JOIN node sn ON sn.id = e.from_node
     WHERE c.key @> jsonb_build_object('hash', $1::text)`,
    [hash],
  );
  const row = found.rows[0];
  if (row === undefined) return null;
  const opinions = opinionsOfJson(row.opinions, []);
  const parents = await tx.query<{ hash: string }>(
    `SELECT (pn.key->>'hash') AS hash FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.parent}'
     JOIN ${GIT_TABLES.parent_position} o ON o."edge_id" = e.id AND o."state" = 'open' AND o."context_id" = 1
     JOIN node pn ON pn.id = e.to_node WHERE e.from_node = (SELECT id FROM node WHERE key @> jsonb_build_object('hash', $1::text) AND entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.commit}')) ORDER BY o.position`,
    [hash],
  );
  const [authorDate, authorOffset] = [clockOf(opinions, 'author_date', 'author_offset_min'), fieldRead(opinions, 'author_offset_min', asNumber).value ?? 0];
  const [commitDate, commitOffset] = [clockOf(opinions, 'commit_date', 'commit_offset_min'), fieldRead(opinions, 'commit_offset_min', asNumber).value ?? 0];
  return {
    hash: row.commit, parents: parents.rows.map((entry) => entry.hash),
    author: { name: row.author_name, email: row.author_email },
    authorDate: authorDate.date, authorOffsetMin: authorOffset,
    commitDate: commitDate.date, commitOffsetMin: commitOffset,
    subject: fieldRead(opinions, 'subject', asText).value ?? '',
  };

}
/** The facts one repository page states, read once per page: its key, its address, its as-is commit and its counts. */
export interface RepositoryFacts {
  readonly nodeId: string;
  readonly name: string;
  readonly url: string;
  readonly defaultBranch: string | null;
  readonly asIsCommit: string | null;
  readonly fileCount: number;
  readonly commitCount: number;
  readonly directoryCount: number;
  /** Whether the clone the history pass read is shallow: the pass's opinion of the repository, never a table of its own. */
  readonly historyShallow: boolean | null;
}

/** One page's repository facts, bound to the page's transaction so every block of the page shares one read. */
const FACTS_MEMO = new WeakMap<object, Map<string, Promise<RepositoryFacts | null>>>();

/**
 * One page asks every block that shows a repository for the same facts: this reads them once per transaction, however
 * many readers ask (the review of stage 1c, point 15, and the CI page budget). A failed read stands no cache entry.
 */
export async function repositoryFacts(owner: DatabaseOwner, repository: string, declared?: ReadonlySet<string>): Promise<RepositoryFacts | null> {
  if (declared !== undefined && !declared.has(GIT_KINDS.repository)) return null;
  return await withSpan('records.repositoryFacts', { 'records.repository': repository }, async () => await owner.transaction('snapshot', async (tx) => {
    const memo = FACTS_MEMO.get(tx) ?? new Map<string, Promise<RepositoryFacts | null>>();
    FACTS_MEMO.set(tx, memo);
    const held = memo.get(repository);
    if (held !== undefined) return await held;
    const read = readRepositoryFacts(tx, repository, declared);
    memo.set(repository, read);
    read.catch(() => { if (memo.get(repository) === read) memo.delete(repository); });
    return await read;
  }));
}

/** The facts of one repository, read in statements of its own; the page shares the result through `repositoryFacts`. */
async function readRepositoryFacts(tx: OuterTransaction, repository: string, declared?: ReadonlySet<string>): Promise<RepositoryFacts | null> {
  // The declared contract decides: a product that declares no repository kind is answered before the table is named.
  if (declared === undefined && (await tx.query<{ id: string }>("SELECT id FROM entity WHERE name = $1 LIMIT 1", [GIT_KINDS.repository])).rows.length === 0) return null;
  // One statement for the repository row and everything a page states about it: its opinions, its as-is commit and its
  // counts (the CI page budget counts statements, not only rows).
  const found = await tx.query<{ node_id: string; opinions: unknown; as_is: string | null; files: string; commits: string; directories: string }>(

    `SELECT n.id::text AS node_id,
       (SELECT jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence", 'url', o."url", 'default_branch', o."default_branch", 'history_shallow', o."history_shallow") ORDER BY o."id") FROM ${GIT_TABLES.repository} o WHERE o."node_id" = n.id AND o."state" = 'open' AND o."context_id" = 1) AS opinions,
       (SELECT (c.key->>'hash') FROM edge e JOIN entity ek ON ek.id = e.entity_id AND ek.name = '${GIT_KINDS.asIs}' JOIN node c ON c.id = e.to_node WHERE e.from_node = n.id AND e.context_id = 1 LIMIT 1) AS as_is,
       (SELECT count(*)::text FROM node f JOIN entity fe ON fe.id = f.entity_id AND fe.name = '${GIT_KINDS.file}' JOIN edge e ON e.to_node = f.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}') AND e.context_id = 1 WHERE (f.key->'repository'->'key'->>'name') = $1::text) AS files,
       (SELECT count(*)::text FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.history}' WHERE e.from_node = n.id AND e.context_id = 1) AS commits,
       (SELECT count(*)::text FROM node d JOIN entity de ON de.id = d.entity_id AND de.name = '${GIT_KINDS.directory}' JOIN edge e ON e.to_node = d.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}') AND e.context_id = 1 WHERE (d.key->'repository'->'key'->>'name') = $1::text) AS directories
     FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.repository}' WHERE n.key @> jsonb_build_object('name', $1::text) AND n.context_id = 1 AND NOT n.removed`,
    [repository],
  );
  const row = found.rows[0];
  if (row === undefined) return null;
  const opinions = opinionsOfJson(row['opinions'], []);
  return {
    nodeId: row['node_id'], name: repository, url: fieldRead(opinions, 'url', asText).value ?? '', defaultBranch: fieldRead(opinions, 'default_branch', asText).value,
    asIsCommit: row['as_is'],
    fileCount: Number(row['files'] ?? '0'),
    commitCount: Number(row['commits'] ?? '0'),
    directoryCount: Number(row['directories'] ?? '0'),
    historyShallow: fieldRead(opinions, 'history_shallow', (value) => (typeof value === 'boolean' ? value : null)).value,
  };

}

/** The entities per kind of the one graph, in code point order: the catalogue's counts, the store's own. */
export async function graphKindCounts(owner: DatabaseOwner): Promise<readonly { readonly kind: string; readonly count: number }[]> {
  return await withSpan('records.graphKindCounts', {}, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ kind: string; n: string }>(
      `SELECT '${GIT_KINDS.repository}' AS kind, count(*)::text AS n FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.repository}' WHERE NOT n.removed
       UNION ALL SELECT '${GIT_KINDS.directory}', count(*)::text FROM node d JOIN entity de ON de.id = d.entity_id AND de.name = '${GIT_KINDS.directory}' JOIN edge e ON e.to_node = d.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}')
       UNION ALL SELECT '${GIT_KINDS.file}', count(*)::text FROM node f JOIN entity fe ON fe.id = f.entity_id AND fe.name = '${GIT_KINDS.file}' JOIN edge e ON e.to_node = f.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}')
       UNION ALL SELECT '${GIT_KINDS.gitlink}', count(*)::text FROM node g JOIN entity ge ON ge.id = g.entity_id AND ge.name = '${GIT_KINDS.gitlink}' JOIN edge e ON e.to_node = g.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}') AND e.context_id = 1
       UNION ALL SELECT '${GIT_KINDS.commit}', count(*)::text FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.history}'
       UNION ALL SELECT '${GIT_KINDS.signature}', count(*)::text FROM node s JOIN entity se ON se.id = s.entity_id AND se.name = '${GIT_KINDS.signature}' WHERE EXISTS (SELECT 1 FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.authored}' WHERE e.from_node = s.id)`,
    );
    return found.rows.map((row) => ({ kind: row.kind, count: Number(row.n) })).sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0));
  }));
}
