/**
 * The repository records (madarch-8bdc.2.11, decision 0034): the graph the fill's
 * two passes write, in the one schema of `one-graph.ts`.
 *
 * **Identity only.** A vertex is a row of `node` with its kind; a kind's own
 * columns stand in a table keyed by `node_id`, and the natural key of the kind is
 * unique there: a repository's name, a directory's or a file's repository and
 * path, a commit's hash, a signature's name and email.
 *
 * **A relation stands once, as an `edge` row.** `contains`, `as-is`, `history`,
 * `parent`, `touched`, `authored` and `renamed-from` are edges; an edge kind's
 * own attributes stand in its table keyed by `edge_id` (`touched`, `history`,
 * `parent_position`). Belonging to a repository is an edge only.
 *
 * **A claim carries its source.** A file's language is a claim whose producer is
 * the language dataset; an ambiguous answer is the claim's candidates, never the
 * word `ambiguous` as a value. Every claim is kept, and a reader shows the newest.
 *
 * **A deleted path keeps its vertex and its history.** A tree publication
 * reconciles the `contains` edges of the current tree: a path that left the tree
 * loses that edge and nothing else; its `touched` and `renamed-from` edges stand.
 *
 * **Change detection.** A publication compares what the store holds with what the
 * pass read, by key and by blob, writes only what differs, in bounded batches,
 * interns every dictionary value, and reads a page with keyset pagination.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { OuterTransaction } from '../history-types.js';
import { withSpan } from '../obs/trace.js';
import { raise } from '../model/raise.js';
import { createOneGraphSchema } from './one-graph.js';
import { createHash } from 'node:crypto';
import { GIT_CONTRACT, GIT_KINDS, GIT_TABLES } from '../fill/stages/git-contract.js';
import type { GraphContract } from './contract.js';

/** Madarch's UUIDv5 namespace: a node's uid is the same on every machine for the same kind and key. */
const UID_NAMESPACE = Buffer.from('6f1d9a2e4b8c5d7e9f012a3b4c5d6e7f', 'hex');

/** A UUIDv5 over madarch's namespace and the kind's natural key values. */
function keyUid(kind: string, values: readonly string[]): string {
  const hash = createHash('sha1').update(UID_NAMESPACE).update(`${kind}\0${values.join('\0')}`, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The uid of a path-keyed entity: its repository's uid and the path's text, never local node ids. */
async function pathKeyUid(tx: OuterTransaction, kind: string, repositoryNode: string, pathId: string): Promise<string> {
  const found = await tx.query<{ uid: string; text: string }>(
    `SELECT n.uid::text AS uid, p.text FROM node n JOIN ${GIT_TABLES.path} p ON p.id = $2::bigint WHERE n.id = $1::bigint`,
    [repositoryNode, pathId],
  );
  const row = found.rows[0];
  if (row === undefined) raise(`the repository node ${repositoryNode} and path ${pathId} do not name a key`);
  return keyUid(kind, [row.uid, row.text]);
}

/** The language dataset's version, the producer of every language claim (package.json pins it). */
const LINGUIST_VERSION = '9.5.0';

/** Creates the one graph's tables and the kinds the fill writes; a second call changes nothing. */
export async function createRecordSchema(owner: DatabaseOwner, contract: GraphContract = GIT_CONTRACT): Promise<void> {
  await createOneGraphSchema(owner, contract);
}

// ---- what one pass read ----------------------------------------------------

/** One file of a tree, as the tree pass read it: everything a row holds. */
export interface TreeFile {
  readonly path: string;
  readonly mode: '100644' | '100755' | '120000';
  readonly blob: string;
  readonly bytes: number;
  /** Git's own answer: `-` in `--numstat` is a binary blob, a number of added lines is text. */
  readonly form: 'text' | 'binary';
  readonly lines: number | null;
  /** The dataset's language, or `ambiguous` with its candidates: the claim stores the candidates, never the word. */
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
  readonly gaps: readonly { readonly what: string; readonly reason: 'non-utf8-path' | 'shallow-history' | 'unreadable' }[];
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
  readonly gaps: readonly { readonly what: string; readonly reason: 'non-utf8-path' | 'shallow-history' | 'unreadable' }[];
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

/** The statement bound one publish writes per batch, the store's own constant. */
const BATCH = 500;

/** Runs one write transaction and lends it the batch writer. */
async function write<T>(owner: DatabaseOwner, work: (tx: OuterTransaction) => Promise<T>): Promise<T> {
  return await owner.transaction('write', work);
}

/** The id of every kind this module reads, by name. */
async function kindIds(tx: OuterTransaction): Promise<Map<string, string>> {
  const found = await tx.query<{ id: string; name: string }>('SELECT id::text AS id, name FROM kind');
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

/** One file as a reader sees it: the facts the tree pass wrote. */
export interface FileRecord {
  readonly path: string;
  readonly mode: string | null;
  readonly blob: string | null;
  readonly bytes: number | null;
  readonly form: 'text' | 'binary' | null;
  readonly lines: number | null;
  /** The accepted language, or null when the claims name candidates and no one language. */
  readonly language: string | null;
  readonly candidates: readonly string[];
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
  /** The committer's clock with its offset, as `git log %cI` writes it. */
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

/** The ids of the paths this publish names, inserting the ones the dictionary does not hold. */
async function pathIds(tx: OuterTransaction, paths: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths)];
  for (let at = 0; at < unique.length; at += BATCH) {
    await tx.query(`INSERT INTO ${GIT_TABLES.path} (text) SELECT value FROM jsonb_array_elements_text($1::jsonb) ON CONFLICT (text) DO NOTHING`, [JSON.stringify(unique.slice(at, at + BATCH))]);
  }
  const found = await tx.query<{ id: string; text: string }>(`SELECT id::text AS id, text FROM ${GIT_TABLES.path} WHERE text IN (SELECT value FROM jsonb_array_elements_text($1::jsonb))`, [JSON.stringify(unique)]);
  return new Map(found.rows.map((row) => [row.text, row.id]));
}

/** The ids of every blob the tree names, inserted or corrected in two statements. */
async function blobIdsOf(tx: OuterTransaction, files: readonly TreeFile[]): Promise<Map<string, string>> {
  const wanted = new Map<string, TreeFile>();
  for (const file of files) if (!wanted.has(file.blob)) wanted.set(file.blob, file);
  const rows = [...wanted.values()];
  await inBatches(rows, async (chunk) => {
    await tx.query(
      `INSERT INTO ${GIT_TABLES.blob} (hash, algorithm, bytes, form, lines) SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[], $4::text[], $5::bigint[])
       ON CONFLICT (hash) DO UPDATE SET bytes = EXCLUDED.bytes, form = EXCLUDED.form, lines = EXCLUDED.lines`,
      [
        sqlText(chunk.map((file) => file.blob)),
        sqlText(chunk.map((file) => hashAlgorithmOf(file.blob))),
        `{${chunk.map((file) => String(file.bytes)).join(',')}}`,
        sqlText(chunk.map((file) => file.form)),
        sqlIds(chunk.map((file) => (file.lines === null ? null : String(file.lines)))),
      ],
    );
  });
  const found = await tx.query<{ id: string; hash: string }>(`SELECT id::text AS id, hash FROM ${GIT_TABLES.blob} WHERE hash IN (SELECT value FROM jsonb_array_elements_text($1::jsonb))`, [JSON.stringify(rows.map((file) => file.blob))]);
  return new Map(found.rows.map((row) => [row.hash, row.id]));
}

// ---- the repository, its commit and its base context -----------------------

/** One repository's node id, made where the store holds none: its name is its natural key. */
async function repositoryNodeOf(tx: OuterTransaction, kinds: Map<string, string>, repository: { readonly name: string; readonly url?: string; readonly defaultBranch?: string }): Promise<{ node: string; counts: RecordCounts }> {
  const found = await tx.query<{ node_id: string; url: string; default_branch: string | null }>(`SELECT node_id::text AS node_id, url, default_branch FROM ${GIT_TABLES.repository} WHERE name = $1`, [repository.name]);
  const row = found.rows[0];
  if (row === undefined) {
    const made = await tx.query<{ id: string }>('INSERT INTO node (kind_id, uid) VALUES ($1::bigint, $2::uuid) RETURNING id::text AS id', [kinds.get(`${GIT_KINDS.repository}`)!, keyUid(GIT_KINDS.repository, [repository.name])]);
    const node = made.rows[0]!.id;
    await tx.query(`INSERT INTO ${GIT_TABLES.repository} (node_id, name, url, default_branch) VALUES ($1::bigint, $2, $3, $4)`, [node, repository.name, repository.url ?? '', repository.defaultBranch ?? null]);
    return { node, counts: { inserted: 2, updated: 0, deleted: 0, unchanged: 0 } };
  }
  const url = repository.url ?? row.url;
  const defaultBranch = repository.defaultBranch ?? row.default_branch;
  if (url !== row.url || defaultBranch !== row.default_branch) {
    await tx.query(`UPDATE ${GIT_TABLES.repository} SET url = $2, default_branch = $3 WHERE node_id = $1::bigint`, [row.node_id, url, defaultBranch]);
    return { node: row.node_id, counts: { inserted: 0, updated: 1, deleted: 0, unchanged: 0 } };
  }
  return { node: row.node_id, counts: { inserted: 0, updated: 0, deleted: 0, unchanged: 1 } };
}

/** One commit's node under a hash, made where the store holds none: a commit's hash is its natural key. */
async function commitNodeOf(tx: OuterTransaction, kinds: Map<string, string>, hash: string): Promise<{ node: string; created: boolean; counts: RecordCounts }> {
  const found = await tx.query<{ node_id: string }>(`SELECT node_id::text AS node_id FROM ${GIT_TABLES.commit} WHERE hash = $1`, [hash]);
  if (found.rows[0] !== undefined) return { node: found.rows[0].node_id, created: false, counts: { inserted: 0, updated: 0, deleted: 0, unchanged: 1 } };
  const made = await tx.query<{ id: string }>('INSERT INTO node (kind_id, uid) VALUES ($1::bigint, $2::uuid) RETURNING id::text AS id', [kinds.get(`${GIT_KINDS.commit}`)!, keyUid(GIT_KINDS.commit, [hash])]);
  const node = made.rows[0]!.id;
  await tx.query(`INSERT INTO ${GIT_TABLES.commit} (node_id, hash, algorithm) VALUES ($1::bigint, $2, $3)`, [node, hash, hashAlgorithmOf(hash)]);
  return { node, created: true, counts: { inserted: 2, updated: 0, deleted: 0, unchanged: 0 } };
}

/** One file's node under its repository and path, made where the store holds none: a file keeps its vertex when it leaves the tree. */
async function fileNodeOf(tx: OuterTransaction, kinds: Map<string, string>, repositoryNode: string, pathId: string): Promise<{ node: string; created: boolean }> {
  const found = await tx.query<{ node_id: string }>(`SELECT node_id::text AS node_id FROM ${GIT_TABLES.file} WHERE repository_node = $1::bigint AND path_id = $2::bigint`, [repositoryNode, pathId]);
  if (found.rows[0] !== undefined) return { node: found.rows[0].node_id, created: false };
  const made = await tx.query<{ id: string }>('INSERT INTO node (kind_id, uid) VALUES ($1::bigint, $2::uuid) RETURNING id::text AS id', [kinds.get(`${GIT_KINDS.file}`)!, await pathKeyUid(tx, GIT_KINDS.file, repositoryNode, pathId)]);
  const node = made.rows[0]!.id;
  await tx.query(`INSERT INTO ${GIT_TABLES.file} (node_id, repository_node, path_id) VALUES ($1::bigint, $2::bigint, $3::bigint)`, [node, repositoryNode, pathId]);
  return { node, created: true };
}

/** One signature's node under its name and email, made where the store holds none. */
async function signatureNodeOf(tx: OuterTransaction, kinds: Map<string, string>, name: string, email: string): Promise<{ node: string; created: boolean }> {
  const found = await tx.query<{ node_id: string }>(`SELECT node_id::text AS node_id FROM ${GIT_TABLES.signature} WHERE name = $1 AND email = $2`, [name, email]);
  if (found.rows[0] !== undefined) return { node: found.rows[0].node_id, created: false };
  const made = await tx.query<{ id: string }>('INSERT INTO node (kind_id, uid) VALUES ($1::bigint, $2::uuid) RETURNING id::text AS id', [kinds.get(`${GIT_KINDS.signature}`)!, keyUid(GIT_KINDS.signature, [name, email])]);
  const node = made.rows[0]!.id;
  await tx.query(`INSERT INTO ${GIT_TABLES.signature} (node_id, name, email) VALUES ($1::bigint, $2, $3)`, [node, name, email]);
  return { node, created: true };
}

/** One edge of the named kind between two nodes, made where it does not stand; `discriminator` tells a repeated kind's edges apart. */
async function edgeOf(tx: OuterTransaction, kinds: Map<string, string>, kind: string, from: string, to: string, discriminator = ''): Promise<{ id: string; created: boolean }> {
  const found = await tx.query<{ id: string }>('SELECT id::text AS id FROM edge WHERE kind_id = $1::bigint AND from_node = $2::bigint AND to_node = $3::bigint AND discriminator = $4', [kinds.get(kind)!, from, to, discriminator]);
  if (found.rows[0] !== undefined) return { id: found.rows[0].id, created: false };
  const made = await tx.query<{ id: string }>('INSERT INTO edge (kind_id, from_node, to_node, discriminator) VALUES ($1::bigint, $2::bigint, $3::bigint, $4) RETURNING id::text AS id', [kinds.get(kind)!, from, to, discriminator]);
  return { id: made.rows[0]!.id, created: true };
}

/** One evidence row for a vertex's plain columns, written once per commit that stated them. */
async function evidenceOfNode(tx: OuterTransaction, node: string, commit: string, pathId: string | null, producer: string): Promise<void> {
  await tx.query('INSERT INTO evidence (node_id, commit_or_digest, path_id, producer) VALUES ($1::bigint, $2, $3::bigint, $4)', [node, commit, pathId, producer]);
}

/** The value one language claim holds: the one language, or the candidates of an ambiguous answer, never the word. */
function languageValueOf(file: { readonly language: string; readonly candidates: readonly string[] }): Record<string, unknown> {
  return file.language === 'ambiguous' || file.candidates.length > 1 ? { candidates: [...file.candidates] } : { language: file.language, candidates: [file.language] };
}



/** Whether two JSON values say the same thing, in the order their keys were written: a claim's own value, compared. */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The language one claim's value names, or null with its candidates when it names no one language. */
function languageOfClaim(value: Record<string, unknown> | undefined): { language: string | null; candidates: readonly string[] } {
  if (value === undefined) return { language: null, candidates: [] };
  const language = value['language'];
  const candidates = Array.isArray(value['candidates']) ? value['candidates'].filter((one): one is string => typeof one === 'string') : [];
  return typeof language === 'string' ? { language, candidates: candidates.length === 0 ? [language] : candidates } : { language: null, candidates };
}

// ---- the tree pass ---------------------------------------------------------

/** One file of the store's current tree, as the diff reads it. */
interface HeldFile {
  readonly nodeId: string;
  readonly mode: string | null;
  readonly blob: string | null;
  readonly language: Record<string, unknown> | undefined;
  readonly producer: string | undefined;
  readonly producerVersion: string | undefined;
}

/** Whether a held file row already says what the pass read. */
function sameFile(held: HeldFile, file: TreeFile): boolean {
  return held.mode === file.mode && held.blob === file.blob && sameJson(held.language, languageValueOf(file));
}

/**
 * Publishes one repository's tree at one commit: its files, its gitlinks, the
 * `contains` relation of the current tree and the `as-is` relation to the commit.
 * Rows are compared by key and by blob and only what differs is written; a path
 * the tree no longer holds loses its `contains` edge and keeps its vertex, its
 * row and its history.
 */
export async function publishTree(owner: DatabaseOwner, input: TreePublish): Promise<RecordCounts> {
  const scope = input.scope;
  /** Whether one repository path stands inside the publication's scope: the whole tree when it names none. */
  const within = (path: string): boolean => scope === undefined || scope.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
  return await write(owner, async (tx) => {
    const kinds = await kindIds(tx);
    const repository = await repositoryNodeOf(tx, kinds, input.repository);
    let counts: RecordCounts = repository.counts;
    const commit = await commitNodeOf(tx, kinds, input.commit);
    counts = sum(counts, commit.counts);
    // The commit the tree stands at: one `as-is` edge per repository, and the one it held goes.
    const asIs = await edgeOf(tx, kinds, `${GIT_KINDS.asIs}`, repository.node, commit.node);
    if (asIs.created) counts = { ...counts, inserted: counts.inserted + 1 }; else counts = { ...counts, unchanged: counts.unchanged + 1 };
    const moved = await tx.query(
      `DELETE FROM edge e USING kind k WHERE e.kind_id = k.id AND k.name = '${GIT_KINDS.asIs}' AND e.from_node = $1::bigint AND e.to_node <> $2::bigint RETURNING e.id`,
      [repository.node, commit.node],
    );
    counts = { ...counts, deleted: counts.deleted + moved.rows.length };

    const files = [...input.files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const folders = new Set<string>();
    for (const path of [...files.map((file) => file.path), ...input.gitlinks.map((link) => link.path)]) {
      for (let folder = folderOfPath(path); folder !== ''; folder = folderOfPath(folder)) folders.add(folder);
    }
    const paths = await pathIds(tx, [...files.map((file) => file.path), ...input.gitlinks.map((link) => link.path), ...folders]);
    for (const file of files) if (!paths.has(file.path)) raise(`the path ${JSON.stringify(file.path)} was not given an id by the dictionary`);

    // What the store holds of this repository's files: its row, and the newest language claim.
    const held = new Map<string, HeldFile>();
    const found = await tx.query<{ path: string; node_id: string; mode: string | null; hash: string | null; language: Record<string, unknown> | null; producer: string | null; producer_version: string | null }>(
      `SELECT p.text AS path, f.node_id::text AS node_id, f.mode, b.hash,
              (SELECT c.value FROM claim c WHERE c.node_id = f.node_id AND c.attribute = 'language' ORDER BY c.id DESC LIMIT 1) AS language,
              (SELECT c.producer FROM claim c WHERE c.node_id = f.node_id AND c.attribute = 'language' ORDER BY c.id DESC LIMIT 1) AS producer,
              (SELECT c.producer_version FROM claim c WHERE c.node_id = f.node_id AND c.attribute = 'language' ORDER BY c.id DESC LIMIT 1) AS producer_version
       FROM ${GIT_TABLES.file} f JOIN ${GIT_TABLES.path} p ON p.id = f.path_id LEFT JOIN ${GIT_TABLES.blob} b ON b.id = f.blob_id
       WHERE f.repository_node = $1::bigint`,
      [repository.node],
    );
    for (const row of found.rows) held.set(row.path, { nodeId: row.node_id, mode: row.mode, blob: row.hash, language: row.language ?? undefined, producer: row.producer ?? undefined, producerVersion: row.producer_version ?? undefined });

    const toWrite = files.filter((file) => { const known = held.get(file.path); return known === undefined || !sameFile(known, file); });
    counts = { ...counts, unchanged: counts.unchanged + (files.length - toWrite.length) };
    const blobIds = toWrite.length === 0 ? new Map<string, string>() : await blobIdsOf(tx, toWrite);
    const created = toWrite.filter((file) => held.get(file.path) === undefined);
    const movedBlob = toWrite.filter((file) => held.get(file.path) !== undefined);
    const fileNodes = new Map<string, string>();
    for (const [path, known] of held) if (files.some((file) => file.path === path)) fileNodes.set(path, known.nodeId);

    // A new file gets its vertex and its row; a file whose blob moved gets its row updated.
    for (const file of created) {
      const made = await tx.query<{ id: string }>('INSERT INTO node (kind_id, uid) VALUES ($1::bigint, $2::uuid) RETURNING id::text AS id', [kinds.get(`${GIT_KINDS.file}`)!, await pathKeyUid(tx, GIT_KINDS.file, repository.node, paths.get(file.path)!)]);
      const node = made.rows[0]!.id;
      fileNodes.set(file.path, node);
      await tx.query(`INSERT INTO ${GIT_TABLES.file} (node_id, repository_node, path_id, mode, blob_id) VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5::bigint)`, [node, repository.node, paths.get(file.path)!, file.mode, blobIds.get(file.blob)!]);
    }
    counts = { ...counts, inserted: counts.inserted + created.length * 2 };
    for (const file of movedBlob) {
      const known = held.get(file.path)!;
      await tx.query(`UPDATE ${GIT_TABLES.file} SET path_id = $2::bigint, mode = $3, blob_id = $4::bigint WHERE node_id = $1::bigint`, [known.nodeId, paths.get(file.path)!, file.mode, blobIds.get(file.blob)!]);
      fileNodes.set(file.path, known.nodeId);
      counts = { ...counts, updated: counts.updated + 1 };
    }

    // The language claim: a new claim where the newest one says something else, and every source kept.
    for (const file of toWrite) {
      const node = fileNodes.get(file.path)!;
      const known = held.get(file.path);
      const value = languageValueOf(file);
      if (known !== undefined && sameJson(known.language, value)) continue;
      const made = await tx.query<{ id: string }>(
        `INSERT INTO claim (node_id, attribute, value, producer, producer_version) VALUES ($1::bigint, 'language', $2::jsonb, 'linguist', $3) RETURNING id::text AS id`,
        [node, JSON.stringify(value), LINGUIST_VERSION],
      );
      await tx.query('INSERT INTO evidence (claim_id, commit_or_digest, path_id, producer) VALUES ($1::bigint, $2, $3::bigint, $4)', [made.rows[0]!.id, input.commit, paths.get(file.path)!, 'linguist']);
      counts = { ...counts, inserted: counts.inserted + 2 };
    }

    // The plain columns git states: one evidence row per file the tree stated at this commit.
    for (const file of toWrite) await evidenceOfNode(tx, fileNodes.get(file.path)!, input.commit, paths.get(file.path)!, 'git');

    // The gitlinks: a submodule is a vertex of its own, with its repository and the commit the tree holds.
    const heldLinks = new Map((await tx.query<{ path: string; node_id: string; other_repository: string; commit_hash: string }>(
      `SELECT p.text AS path, g.node_id::text AS node_id, g.other_repository, g.commit_hash FROM ${GIT_TABLES.gitlink} g JOIN ${GIT_TABLES.path} p ON p.id = g.path_id WHERE g.repository_node = $1::bigint`,
      [repository.node],
    )).rows.map((row) => [row.path, row]));
    const linkNodes = new Map<string, string>();
    for (const link of input.gitlinks) {
      const known = heldLinks.get(link.path);
      if (known === undefined) {
        const made = await tx.query<{ id: string }>('INSERT INTO node (kind_id, uid) VALUES ($1::bigint, $2::uuid) RETURNING id::text AS id', [kinds.get(`${GIT_KINDS.gitlink}`)!, await pathKeyUid(tx, GIT_KINDS.gitlink, repository.node, paths.get(link.path)!)]);
        const node = made.rows[0]!.id;
        await tx.query(`INSERT INTO ${GIT_TABLES.gitlink} (node_id, repository_node, path_id, other_repository, commit_hash) VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5)`, [node, repository.node, paths.get(link.path)!, link.otherRepository, link.commit]);
        linkNodes.set(link.path, node);
        counts = { ...counts, inserted: counts.inserted + 2 };
      } else if (known.other_repository !== link.otherRepository || known.commit_hash !== link.commit) {
        await tx.query(`UPDATE ${GIT_TABLES.gitlink} SET other_repository = $2, commit_hash = $3 WHERE node_id = $1::bigint`, [known.node_id, link.otherRepository, link.commit]);
        linkNodes.set(link.path, known.node_id);
        counts = { ...counts, updated: counts.updated + 1 };
      } else {
        linkNodes.set(link.path, known.node_id);
        counts = { ...counts, unchanged: counts.unchanged + 1 };
      }
    }

    // The folders: one vertex per folder of the current tree, and its own row.
    const heldFolders = new Map((await tx.query<{ path: string; node_id: string }>(
      `SELECT p.text AS path, d.node_id::text AS node_id FROM ${GIT_TABLES.directory} d JOIN ${GIT_TABLES.path} p ON p.id = d.path_id WHERE d.repository_node = $1::bigint`,
      [repository.node],
    )).rows.map((row) => [row.path, row.node_id]));
    const folderNodes = new Map<string, string>();
    const missing = [...folders].sort().filter((folder) => !heldFolders.has(folder));
    for (const [folder, node] of heldFolders) if (folders.has(folder)) folderNodes.set(folder, node);
    for (const folder of missing) {
      const made = await tx.query<{ id: string }>('INSERT INTO node (kind_id, uid) VALUES ($1::bigint, $2::uuid) RETURNING id::text AS id', [kinds.get(`${GIT_KINDS.directory}`)!, await pathKeyUid(tx, GIT_KINDS.directory, repository.node, paths.get(folder)!)]);
      const node = made.rows[0]!.id;
      await tx.query(`INSERT INTO ${GIT_TABLES.directory} (node_id, repository_node, path_id) VALUES ($1::bigint, $2::bigint, $3::bigint)`, [node, repository.node, paths.get(folder)!]);
      folderNodes.set(folder, node);
      counts = { ...counts, inserted: counts.inserted + 2 };
    }
    counts = { ...counts, unchanged: counts.unchanged + (folders.size - missing.length) };

    // The current tree's `contains` edges: exactly one parent for every vertex in the tree. A child that left the tree
    // loses its edge and nothing else; a folder that lost its last file keeps its vertex and loses its edge too.
    const desired = new Map<string, { parent: string; child: string; path: string }>();
    const addDesired = (parent: string, child: string, path: string): void => { desired.set(`${parent}\u0000${child}`, { parent, child, path }); };
    for (const [folder, node] of folderNodes) addDesired(folderNodes.get(folderOfPath(folder)) ?? repository.node, node, folder);
    for (const [path, node] of fileNodes) addDesired(folderNodes.get(folderOfPath(path)) ?? repository.node, node, path);
    for (const [path, node] of linkNodes) addDesired(folderNodes.get(folderOfPath(path)) ?? repository.node, node, path);
    const heldContains = new Map((await tx.query<{ id: string; from_node: string; to_node: string; path: string }>(
      `SELECT e.id::text AS id, e.from_node::text AS from_node, e.to_node::text AS to_node, p.text AS path
       FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.contains}'
       JOIN ${GIT_TABLES.path} p ON p.id = coalesce((SELECT path_id FROM ${GIT_TABLES.file} WHERE node_id = e.to_node), (SELECT path_id FROM ${GIT_TABLES.directory} WHERE node_id = e.to_node), (SELECT path_id FROM ${GIT_TABLES.gitlink} WHERE node_id = e.to_node))
       WHERE e.to_node IN (SELECT node_id FROM ${GIT_TABLES.file} WHERE repository_node = $1::bigint UNION SELECT node_id FROM ${GIT_TABLES.directory} WHERE repository_node = $1::bigint UNION SELECT node_id FROM ${GIT_TABLES.gitlink} WHERE repository_node = $1::bigint)`,
      [repository.node],
    )).rows.map((row) => [`${row.from_node}\u0000${row.to_node}`, row]));
    for (const [key, row] of heldContains) {
      if (desired.has(key) || !within(row.path)) continue;
      await tx.query('DELETE FROM edge WHERE id = $1::bigint', [row.id]);
      counts = { ...counts, deleted: counts.deleted + 1 };
    }
    for (const [key, want] of desired) {
      if (heldContains.has(key) || !within(want.path)) continue;
      await tx.query('INSERT INTO edge (kind_id, from_node, to_node) VALUES ($1::bigint, $2::bigint, $3::bigint)', [kinds.get(`${GIT_KINDS.contains}`)!, want.parent, want.child]);
      counts = { ...counts, inserted: counts.inserted + 1 };
    }
    counts = { ...counts, unchanged: counts.unchanged + [...desired.keys()].filter((key) => heldContains.has(key)).length };

    // The tree pass retracts only the gaps it wrote: a tree published after a history keeps the history's rows.
    counts = sum(counts, await publishGaps(tx, repository.node, input.gaps, 'tree'));
    return counts;
  });
}

/** The pass that read a gap: a gap is replaced by the pass that wrote it, and by no other. */
type GapProducer = 'tree' | typeof GIT_KINDS.history;

/**
 * The gaps of one repository, as one pass read them: the rows this pass wrote are
 * written again and the pass's stale ones go, and the other pass's rows stand as
 * they are. Both passes can write `unreadable`, so the producer, never the reason,
 * says whose row it is.
 */
async function publishGaps(tx: OuterTransaction, repositoryNode: string, gaps: readonly { readonly what: string; readonly reason: string }[], producer: GapProducer): Promise<RecordCounts> {
  const held = new Map((await tx.query<{ what: string; reason: string }>('SELECT what, reason FROM gap WHERE repository_node = $1::bigint AND producer = $2', [repositoryNode, producer])).rows.map((row) => [row.what, row.reason]));
  let inserted = 0;
  let unchanged = 0;
  let deleted = 0;
  for (const gap of gaps) {
    if (held.get(gap.what) === gap.reason) { unchanged += 1; continue; }
    await tx.query('INSERT INTO gap (repository_node, what, reason, producer) VALUES ($1::bigint, $2, $3, $4) ON CONFLICT (repository_node, what) DO UPDATE SET reason = EXCLUDED.reason, producer = EXCLUDED.producer', [repositoryNode, gap.what, gap.reason, producer]);
    inserted += 1;
  }
  for (const [what] of held) {
    if (gaps.some((gap) => gap.what === what)) continue;
    await tx.query('DELETE FROM gap WHERE repository_node = $1::bigint AND what = $2 AND producer = $3', [repositoryNode, what, producer]);
    deleted += 1;
  }
  return { inserted, updated: 0, deleted, unchanged };
}

// ---- the history pass ------------------------------------------------------

/**
 * Publishes one repository's history: every commit as a vertex with its parents,
 * its signature, its two dates and its subject, the repository's `history` edge to
 * it with its walk, every path it touched as a `touched` edge, and every rename as
 * a `renamed-from` edge from the new file to the old one. A path a commit touched
 * has its file vertex even when the tree no longer holds it: a deleted path keeps
 * its history.
 */
export async function publishHistory(owner: DatabaseOwner, input: HistoryPublish): Promise<RecordCounts> {
  return await write(owner, async (tx) => {
    const kinds = await kindIds(tx);
    const repository = await repositoryNodeOf(tx, kinds, { name: input.repository.name });
    let counts: RecordCounts = repository.counts;

    // Every path the whole walk names gets its id once: one dictionary statement, not one per commit.
    const paths = await pathIds(tx, [
      ...input.commits.flatMap((commit) => commit.touched.map((entry) => entry.path)),
      ...input.commits.flatMap((commit) => commit.touched.flatMap((entry) => (entry.previousPath === undefined ? [] : [entry.previousPath]))),
    ]);

    // Every commit vertex the walk names — a commit of the walk or a parent of one — exists before a row points at it.
    const commitNodes = new Map<string, { node: string; created: boolean }>();
    const needed = new Set<string>();
    for (const commit of input.commits) {
      needed.add(commit.hash);
      for (const parent of commit.parents) needed.add(parent);
    }
    for (const hash of [...needed].sort()) {
      const made = await commitNodeOf(tx, kinds, hash);
      commitNodes.set(hash, { node: made.node, created: made.created });
      counts = sum(counts, made.counts);
    }

    const signatureNodes = new Map<string, { node: string; created: boolean }>();
    const signatureOf = async (name: string, email: string): Promise<string> => {
      const key = `${name}\u0000${email}`;
      const held = signatureNodes.get(key);
      if (held !== undefined) return held.node;
      const made = await signatureNodeOf(tx, kinds, name, email);
      signatureNodes.set(key, { node: made.node, created: made.created });
      if (made.created) counts = { ...counts, inserted: counts.inserted + 2 };
      return made.node;
    };

    // The commit's own row, its repository `history` edge and its position in the walk.
    for (const [walk, commit] of input.commits.entries()) {
      const node = commitNodes.get(commit.hash)!.node;
      const [authorDate, authorOffset] = instantOf(commit.authorDate, 'authorDate', commit.hash);
      const [commitDate, commitOffset] = instantOf(commit.commitDate, 'commitDate', commit.hash);
      const held = await tx.query<{ subject: string | null; author_date: string | null; commit_date: string | null }>(
        `SELECT subject, to_char(author_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS author_date,
                to_char(commit_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS commit_date
         FROM ${GIT_TABLES.commit} WHERE node_id = $1::bigint`, [node],
      );
      const row = held.rows[0];
      if (row === undefined) raise(`the commit ${commit.hash} has no row after its vertex was made (src/graph/records.ts)`);
      const authorClock = authorDate.endsWith('Z') ? authorDate.slice(0, -1) : authorDate;
      const commitClock = commitDate.endsWith('Z') ? commitDate.slice(0, -1) : commitDate;
      if (row.subject !== commit.subject || row.author_date !== authorClock || row.commit_date !== commitClock) {
        await tx.query(
          `UPDATE ${GIT_TABLES.commit} SET subject = $2, author_date = $3::timestamptz, author_offset_min = $4::int, commit_date = $5::timestamptz, commit_offset_min = $6::int WHERE node_id = $1::bigint`,
          [node, commit.subject, authorDate, authorOffset, commitDate, commitOffset],
        );
        counts = { ...counts, updated: counts.updated + 1 };
      } else {
        counts = { ...counts, unchanged: counts.unchanged + 1 };
      }
      const historyEdge = await edgeOf(tx, kinds, `${GIT_KINDS.history}`, repository.node, node);
      if (historyEdge.created) counts = { ...counts, inserted: counts.inserted + 1 }; else counts = { ...counts, unchanged: counts.unchanged + 1 };
      const walkHeld = await tx.query<{ walk: number }>(`SELECT walk FROM ${GIT_TABLES.history} WHERE edge_id = $1::bigint`, [historyEdge.id]);
      if (walkHeld.rows[0] === undefined) {
        await tx.query(`INSERT INTO ${GIT_TABLES.history} (edge_id, walk) VALUES ($1::bigint, $2::int)`, [historyEdge.id, walk]);
        counts = { ...counts, inserted: counts.inserted + 1 };
      } else if (Number(walkHeld.rows[0].walk) !== walk) {
        await tx.query(`UPDATE ${GIT_TABLES.history} SET walk = $2::int WHERE edge_id = $1::bigint`, [historyEdge.id, walk]);
        counts = { ...counts, updated: counts.updated + 1 };
      }
      // The commit's plain columns git states: one evidence row, written once.
      const stated = await tx.query('SELECT 1 FROM evidence WHERE node_id = $1::bigint AND commit_or_digest = $2 AND producer = $3 LIMIT 1', [node, commit.hash, 'git']);
      if (stated.rows[0] === undefined) { await evidenceOfNode(tx, node, commit.hash, null, 'git'); counts = { ...counts, inserted: counts.inserted + 1 }; }
    }

    // The parents: one edge commit -> parent, its position in `parent_position`; the ones a rewritten commit no longer has go.
    for (const commit of input.commits) {
      const node = commitNodes.get(commit.hash)!.node;
      const desired = new Map(commit.parents.map((hash, position) => [commitNodes.get(hash)!.node, position]));
      const held = await tx.query<{ id: string; to_node: string; position: number | null }>(
        `SELECT e.id::text AS id, e.to_node::text AS to_node, pp.position FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.parent}'
         LEFT JOIN ${GIT_TABLES.parent_position} pp ON pp.edge_id = e.id WHERE e.from_node = $1::bigint`, [node],
      );
      for (const row of held.rows) {
        if (desired.has(row.to_node)) continue;
        await tx.query('DELETE FROM edge WHERE id = $1::bigint', [row.id]);
        counts = { ...counts, deleted: counts.deleted + 1 };
      }
      const standing = new Map(held.rows.map((row) => [row.to_node, row]));
      for (const [parent, position] of desired) {
        const row = standing.get(parent);
        if (row === undefined) {
          const made = await edgeOf(tx, kinds, `${GIT_KINDS.parent}`, node, parent);
          await tx.query(`INSERT INTO ${GIT_TABLES.parent_position} (edge_id, position) VALUES ($1::bigint, $2::int)`, [made.id, position]);
          counts = { ...counts, inserted: counts.inserted + 2 };
        } else if (row.position === null) {
          await tx.query(`INSERT INTO ${GIT_TABLES.parent_position} (edge_id, position) VALUES ($1::bigint, $2::int)`, [row.id, position]);
          counts = { ...counts, inserted: counts.inserted + 1 };
        } else if (Number(row.position) !== position) {
          await tx.query(`UPDATE ${GIT_TABLES.parent_position} SET position = $2::int WHERE edge_id = $1::bigint`, [row.id, position]);
          counts = { ...counts, updated: counts.updated + 1 };
        } else {
          counts = { ...counts, unchanged: counts.unchanged + 1 };
        }
      }
    }

    // The signature of every commit: one `authored` edge, and a rewritten author replaces the one that stood.
    for (const commit of input.commits) {
      const node = commitNodes.get(commit.hash)!.node;
      const signature = await signatureOf(commit.authorName, commit.authorEmail);
      const held = await tx.query<{ id: string; from_node: string }>(
        `SELECT e.id::text AS id, e.from_node::text AS from_node FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.authored}' WHERE e.to_node = $1::bigint`, [node],
      );
      for (const row of held.rows) {
        if (row.from_node === signature) continue;
        await tx.query('DELETE FROM edge WHERE id = $1::bigint', [row.id]);
        counts = { ...counts, deleted: counts.deleted + 1 };
      }
      if (!held.rows.some((row) => row.from_node === signature)) {
        await edgeOf(tx, kinds, `${GIT_KINDS.authored}`, signature, node);
        counts = { ...counts, inserted: counts.inserted + 1 };
      } else {
        counts = { ...counts, unchanged: counts.unchanged + 1 };
      }
    }

    // Every path the walk touched has its file vertex, even when the current tree no longer holds it.
    const fileNodes = new Map<string, string>();
    const allPaths = [...new Set(input.commits.flatMap((commit) => commit.touched.flatMap((entry) => [entry.path, ...(entry.previousPath === undefined ? [] : [entry.previousPath])])))].sort();
    for (const path of allPaths) {
      const pathId = paths.get(path);
      if (pathId === undefined) raise(`the path ${JSON.stringify(path)} was not given an id by the dictionary`);
      const made = await fileNodeOf(tx, kinds, repository.node, pathId);
      fileNodes.set(path, made.node);
      if (made.created) counts = { ...counts, inserted: counts.inserted + 2 };
    }

    // The touched edges: commit -> file, its attribute row, and the `renamed-from` edge a rename states.
    const touchedKind = kinds.get(`${GIT_KINDS.touched}`)!;
    const desiredTouched = new Set<string>();
    const desiredRenamed = new Set<string>();
    const touchedRows: { commit: string; hash: string; file: string; path: string; change: string; added: string | null; removed: string | null; previous: string | null; previousPath: string | null }[] = [];
    for (const commit of input.commits) {
      const node = commitNodes.get(commit.hash)!.node;
      for (const entry of commit.touched) {
        const file = fileNodes.get(entry.path)!;
        desiredTouched.add(`${node}\u0000${file}`);
        touchedRows.push({ commit: node, hash: commit.hash, file, path: entry.path, change: entry.change, added: entry.added === null ? null : String(entry.added), removed: entry.removed === null ? null : String(entry.removed), previous: entry.previousPath === undefined ? null : fileNodes.get(entry.previousPath)!, previousPath: entry.previousPath ?? null });
        if (entry.previousPath !== undefined) desiredRenamed.add(`${file}\u0000${fileNodes.get(entry.previousPath)!}\u0000${commit.hash}`);
      }
    }
    await inBatches(touchedRows, async (chunk) => {
      await tx.query(
        'INSERT INTO edge (kind_id, from_node, to_node) SELECT $1::bigint, t.commit, t.file FROM unnest($2::bigint[], $3::bigint[]) AS t(commit, file) ON CONFLICT DO NOTHING',
        [touchedKind, sqlIds(chunk.map((row) => row.commit)), sqlIds(chunk.map((row) => row.file))],
      );
    });
    for (const row of touchedRows) {
      const edge = await tx.query<{ id: string }>('SELECT id::text AS id FROM edge WHERE kind_id = $1::bigint AND from_node = $2::bigint AND to_node = $3::bigint AND discriminator = \'\'', [touchedKind, row.commit, row.file]);
      const edgeId = edge.rows[0]!.id;
      const held = await tx.query<{ change: string; added: string | null; removed: string | null }>(`SELECT change, added::text AS added, removed::text AS removed FROM ${GIT_TABLES.touched} WHERE edge_id = $1::bigint`, [edgeId]);
      const was = held.rows[0];
      if (was === undefined) {
        await tx.query(`INSERT INTO ${GIT_TABLES.touched} (edge_id, change, added, removed) VALUES ($1::bigint, $2, $3::bigint, $4::bigint)`, [edgeId, row.change, row.added, row.removed]);
        counts = { ...counts, inserted: counts.inserted + 1 };
      } else if (was.change !== row.change || was.added !== row.added || was.removed !== row.removed) {
        await tx.query(`UPDATE ${GIT_TABLES.touched} SET change = $2, added = $3::bigint, removed = $4::bigint WHERE edge_id = $1::bigint`, [edgeId, row.change, row.added, row.removed]);
        counts = { ...counts, updated: counts.updated + 1 };
      } else {
        counts = { ...counts, unchanged: counts.unchanged + 1 };
      }
      if (row.previous !== null) {
        const rename = await edgeOf(tx, kinds, `${GIT_KINDS.renamedFrom}`, row.file, row.previous, row.hash);
        if (rename.created) {
          await tx.query('INSERT INTO evidence (edge_id, commit_or_digest, path_id, producer) VALUES ($1::bigint, $2, $3::bigint, $4)', [rename.id, row.path, paths.get(row.previousPath!)!, 'git']);
          counts = { ...counts, inserted: counts.inserted + 2 };
        }
      }
    }
    // A touched row the walk no longer states goes, and so does its rename; a commit that fell out of the walk keeps its vertex.
    const walkCommits = sqlIds(input.commits.map((commit) => commitNodes.get(commit.hash)!.node));
    const staleTouched = await tx.query<{ id: string; from_node: string; to_node: string }>(
      `SELECT e.id::text AS id, e.from_node::text AS from_node, e.to_node::text AS to_node FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.touched}'
       WHERE e.from_node = ANY($1::bigint[])`, [walkCommits],
    );
    for (const row of staleTouched.rows) if (!desiredTouched.has(`${row.from_node}\u0000${row.to_node}`)) { await tx.query('DELETE FROM edge WHERE id = $1::bigint', [row.id]); counts = { ...counts, deleted: counts.deleted + 1 }; }
    const staleRenamed = await tx.query<{ id: string; from_node: string; to_node: string; discriminator: string }>(
      `SELECT e.id::text AS id, e.from_node::text AS from_node, e.to_node::text AS to_node, e.discriminator FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.renamedFrom}'
       WHERE e.discriminator = ANY($1::text[])`, [sqlText(input.commits.map((commit) => commit.hash))],
    );
    for (const row of staleRenamed.rows) if (!desiredRenamed.has(`${row.from_node}\u0000${row.to_node}\u0000${row.discriminator}`)) { await tx.query('DELETE FROM edge WHERE id = $1::bigint', [row.id]); counts = { ...counts, deleted: counts.deleted + 1 }; }

    counts = sum(counts, await publishGaps(tx, repository.node, input.gaps, `${GIT_KINDS.history}`));
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

/** The file columns a page reads, with the newest language claim beside them. */
const FILE_SELECT = `SELECT p.text AS path, f.mode, b.hash AS blob, b.bytes::text AS bytes, b.form, b.lines::text AS lines,
  (SELECT c.value FROM claim c WHERE c.node_id = f.node_id AND c.attribute = 'language' ORDER BY c.id DESC LIMIT 1) AS language
  FROM ${GIT_TABLES.file} f JOIN ${GIT_TABLES.path} p ON p.id = f.path_id LEFT JOIN ${GIT_TABLES.blob} b ON b.id = f.blob_id`;

/** Whether a file stands in its repository's current tree: the `contains` edge is what places it there. */
const IN_TREE = `EXISTS (SELECT 1 FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.contains}' WHERE e.to_node = f.node_id)`;

function fileOf(row: Record<string, unknown>): FileRecord {
  const claim = (row['language'] ?? undefined) as Record<string, unknown> | undefined;
  const language = languageOfClaim(claim);
  return {
    path: String(row['path']),
    mode: row['mode'] === null || row['mode'] === undefined ? null : String(row['mode']),
    blob: row['blob'] === null || row['blob'] === undefined ? null : String(row['blob']),
    bytes: row['bytes'] === null || row['bytes'] === undefined ? null : Number(row['bytes']),
    form: row['form'] === 'binary' ? 'binary' : row['form'] === 'text' ? 'text' : null,
    lines: row['lines'] === null || row['lines'] === undefined ? null : Number(row['lines']),
    language: language.language,
    candidates: [...language.candidates],
  };
}

/** The repository's node id, or a gap when the store holds no such repository. */
async function repositoryIdOf(tx: OuterTransaction, repository: string): Promise<string> {
  const found = await tx.query<{ node_id: string }>(`SELECT node_id::text AS node_id FROM ${GIT_TABLES.repository} WHERE name = $1`, [repository]);
  const row = found.rows[0];
  if (row === undefined) throw new RecordGap(`the store holds no repository ${JSON.stringify(repository)}: the fill of this step has not run for it (src/graph/records.ts)`);
  return row.node_id;
}

/**
 * One page of a repository's current files, in code point order of the paths. The
 * prefix is a path prefix, never a pattern: a `%` or a `_` in a path is the
 * character the repository holds, and a page boundary is the path it ended on.
 */
export async function listFiles(owner: DatabaseOwner, input: { readonly repository: string; readonly prefix?: string; readonly language?: string; readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
  return await withSpan('records.listFiles', {
    'records.prefix': input.prefix ?? '',
    'records.language': input.language ?? '',
    'records.limit': input.limit,
  }, async () => await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, input.repository);
    const found = await tx.query(
      `${FILE_SELECT} WHERE f.repository_node = $1::bigint AND ${IN_TREE} AND ($2::text IS NULL OR left(p.text, length($2::text)) = $2::text)
         AND ($3::text IS NULL OR (SELECT c.value->>'language' FROM claim c WHERE c.node_id = f.node_id AND c.attribute = 'language' ORDER BY c.id DESC LIMIT 1) = $3)
         AND ($4::text IS NULL OR p.text > $4) ORDER BY p.text LIMIT $5::bigint`,
      [repositoryId, input.prefix ?? null, input.language ?? null, input.after ?? null, String(input.limit + 1)],
    );
    const rows = found.rows.map(fileOf);
    const more = rows.length > input.limit;
    const shown = more ? rows.slice(0, input.limit) : rows;
    return { rows: shown, next: more ? shown[shown.length - 1]!.path : null };
  }));
}

/** One path a commit changed, as the history pass read it. */
export interface TouchedRecord {
  readonly path: string;
  readonly change: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly added: number | null;
  readonly removed: number | null;
  readonly previousPath: string | null;
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

/** The SQL that reaches a file and every path it was renamed from, through `renamed-from` edges (new file to old). */
const RENAME_CHAIN = `WITH RECURSIVE chain(file_node) AS (
    SELECT f.node_id FROM ${GIT_TABLES.file} f WHERE f.repository_node = $1::bigint AND f.path_id = (SELECT id FROM ${GIT_TABLES.path} WHERE text = $2)
    UNION
    SELECT e.to_node FROM chain c JOIN edge e ON e.from_node = c.file_node JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.renamedFrom}'
  )`;

/**
 * A page of a file's history, newest first. `next` names the exact row the page
 * ended on — the walk and the commit — so a page boundary between two commits
 * written in the same second neither repeats a row nor skips one.
 */
export async function fileHistory(owner: DatabaseOwner, input: { readonly repository: string; readonly path: string; readonly after?: { readonly walk: number; readonly commit: string }; readonly limit: number }): Promise<{ readonly rows: readonly FileHistoryRow[]; readonly next: { readonly walk: number; readonly commit: string } | null }> {
  return await withSpan('records.fileHistory', { 'records.path': input.path, 'records.limit': input.limit }, async () => await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, input.repository);
    const found = await tx.query(
      `${RENAME_CHAIN}
       SELECT ct.hash AS commit, t.change, t.added::text AS added, t.removed::text AS removed, pp.text AS previous,
              to_char(ct.commit_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS date, ct.commit_offset_min AS offset_min, ct.subject, h.walk
       FROM chain ch JOIN edge e ON e.to_node = ch.file_node JOIN kind ek ON ek.id = e.kind_id AND ek.name = '${GIT_KINDS.touched}'
       JOIN ${GIT_TABLES.touched} t ON t.edge_id = e.id JOIN ${GIT_TABLES.commit} ct ON ct.node_id = e.from_node
       JOIN edge he ON he.from_node = $1::bigint AND he.to_node = e.from_node JOIN kind hk ON hk.id = he.kind_id AND hk.name = '${GIT_KINDS.history}' JOIN ${GIT_TABLES.history} h ON h.edge_id = he.id
       LEFT JOIN edge r ON r.from_node = ch.file_node AND r.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.renamedFrom}') AND r.discriminator = ct.hash
       LEFT JOIN ${GIT_TABLES.file} pf ON pf.node_id = r.to_node LEFT JOIN ${GIT_TABLES.path} pp ON pp.id = pf.path_id
       WHERE ($3::int IS NULL OR h.walk > $3::int OR (h.walk = $3::int AND ct.hash > $4))
       ORDER BY h.walk ASC, ct.hash ASC LIMIT $5::bigint`,
      [repositoryId, input.path, input.after?.walk ?? null, input.after?.commit ?? '', String(input.limit + 1)],
    );
    const rows = found.rows.map((row) => ({
      commit: String(row[`${GIT_KINDS.commit}`]), change: String(row['change']) as TouchedRecord['change'],
      added: row['added'] === null ? null : Number(row['added']), removed: row['removed'] === null ? null : Number(row['removed']),
      previousPath: row['previous'] === null || row['previous'] === undefined ? null : String(row['previous']),
      date: gitDateOf(String(row['date']), Number(row['offset_min'])), offsetMin: Number(row['offset_min']), subject: String(row['subject']),
      walk: Number(row['walk']),
      path: input.path,
    }));
    const more = rows.length > input.limit;
    const shown = more ? rows.slice(0, input.limit) : rows;
    const last = shown[shown.length - 1];
    return { rows: shown, next: more && last !== undefined ? { walk: last.walk, commit: last.commit } : null };
  }));
}

/** One commit with the paths it changed, or null when the store holds no such commit. */
export async function commitWithPaths(owner: DatabaseOwner, repository: string, hash: string): Promise<(CommitRecord & { readonly touched: readonly TouchedRecord[] }) | null> {
  const commit = await commitFacts(owner, repository, hash);
  if (commit === null) return null;
  const touched = await withSpan('records.commitPaths', { 'records.commit': hash }, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ path: string; change: string; added: string | null; removed: string | null; previous: string | null }>(
      `SELECT p.text AS path, t.change, t.added::text AS added, t.removed::text AS removed, pp.text AS previous
       FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.touched}' JOIN ${GIT_TABLES.touched} t ON t.edge_id = e.id
       JOIN ${GIT_TABLES.commit} ct ON ct.node_id = e.from_node JOIN ${GIT_TABLES.file} f ON f.node_id = e.to_node JOIN ${GIT_TABLES.path} p ON p.id = f.path_id
       LEFT JOIN edge r ON r.from_node = e.to_node AND r.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.renamedFrom}') AND r.discriminator = ct.hash
       LEFT JOIN ${GIT_TABLES.file} pf ON pf.node_id = r.to_node LEFT JOIN ${GIT_TABLES.path} pp ON pp.id = pf.path_id
       WHERE ct.hash = $1 ORDER BY p.text`,
      [hash],
    );
    return found.rows.map((row) => ({
      path: row.path, change: row.change as TouchedRecord['change'],
      added: row.added === null ? null : Number(row.added), removed: row.removed === null ? null : Number(row.removed),
      previousPath: row.previous,
    }));
  }));
  return { ...commit, touched };
}

/** One page of a folder's own files (not its subfolders'), in code point order of the paths. */
export async function folderFiles(owner: DatabaseOwner, input: { readonly repository: string; readonly folder: string; readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
  return await withSpan('records.folderFiles', { 'records.folder': input.folder, 'records.limit': input.limit }, async () => await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, input.repository);
    const parent = input.folder === '' ? repositoryId : (await tx.query<{ node_id: string }>(`SELECT d.node_id::text AS node_id FROM ${GIT_TABLES.directory} d JOIN ${GIT_TABLES.path} p ON p.id = d.path_id WHERE d.repository_node = $1::bigint AND p.text = $2`, [repositoryId, input.folder])).rows[0]?.node_id;
    if (parent === undefined) return { rows: [], next: null };
    const found = await tx.query(
      `${FILE_SELECT} JOIN edge e ON e.to_node = f.node_id JOIN kind ek ON ek.id = e.kind_id AND ek.name = '${GIT_KINDS.contains}'
       WHERE e.from_node = $1::bigint AND ($2::text IS NULL OR p.text > $2) ORDER BY p.text LIMIT $3::bigint`,
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
    const parent = folder === '' ? repositoryId : (await tx.query<{ node_id: string }>(`SELECT d.node_id::text AS node_id FROM ${GIT_TABLES.directory} d JOIN ${GIT_TABLES.path} p ON p.id = d.path_id WHERE d.repository_node = $1::bigint AND p.text = $2`, [repositoryId, folder])).rows[0]?.node_id;
    if (parent === undefined) return [];
    const found = await tx.query<{ path: string }>(
      `SELECT p.text AS path FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.contains}' JOIN ${GIT_TABLES.directory} d ON d.node_id = e.to_node JOIN ${GIT_TABLES.path} p ON p.id = d.path_id
       WHERE e.from_node = $1::bigint ORDER BY p.text`, [parent],
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

export async function fileFacts(owner: DatabaseOwner, repository: string, path: string): Promise<(FileRecord & { readonly created: FileDate | null; readonly modified: FileDate | null; readonly commitCount: number; readonly authors: readonly string[] }) | null> {
  return await withSpan('records.fileFacts', { 'records.path': path }, async () => await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, repository);
    const found = await tx.query(`${FILE_SELECT} WHERE f.repository_node = $1::bigint AND p.text = $2`, [repositoryId, path]);
    const row = found.rows[0];
    if (row === undefined) return null;
    const history = await tx.query<{ commit: string; date: string; offset_min: number; name: string; walk: number }>(
      `${RENAME_CHAIN}
       SELECT ct.hash AS commit, to_char(ct.commit_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS date, ct.commit_offset_min AS offset_min,
              coalesce(s.name, '') AS name, h.walk
       FROM chain ch JOIN edge e ON e.to_node = ch.file_node JOIN kind ek ON ek.id = e.kind_id AND ek.name = '${GIT_KINDS.touched}'
       JOIN ${GIT_TABLES.commit} ct ON ct.node_id = e.from_node
       JOIN edge he ON he.from_node = $1::bigint AND he.to_node = e.from_node JOIN kind hk ON hk.id = he.kind_id AND hk.name = '${GIT_KINDS.history}' JOIN ${GIT_TABLES.history} h ON h.edge_id = he.id
       LEFT JOIN edge a ON a.to_node = e.from_node AND a.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.authored}') LEFT JOIN ${GIT_TABLES.signature} s ON s.node_id = a.from_node
       WHERE $2 = $2 ORDER BY h.walk ASC, ct.hash ASC`,
      [repositoryId, path],
    );
    const commits = history.rows;
    const created = commits.reduce((deepest, entry) => (entry.walk > deepest.walk ? entry : deepest), commits[0]!);
    const last = commits[0];
    const distinct = new Map(commits.map((entry) => [entry.commit, entry]));
    const authors = [...new Set(commits.map((entry) => entry.name).filter((name) => name !== ''))].sort();
    return {
      ...fileOf(row),
      created: created === undefined ? null : { date: gitDateOf(created.date, created.offset_min), offsetMin: created.offset_min, commit: created.commit, author: created.name },
      modified: last === undefined ? null : { date: gitDateOf(last.date, last.offset_min), offsetMin: last.offset_min, commit: last.commit, author: last.name },
      commitCount: distinct.size,
      authors,
    };
  }));
}

/** Every repository the store holds, in code point order of the names. */
export async function listRepositories(owner: DatabaseOwner): Promise<readonly { readonly name: string; readonly url: string; readonly defaultBranch: string | null; readonly asIsCommit: string | null }[]> {
  return await withSpan('records.listRepositories', {}, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ name: string; url: string; default_branch: string | null; as_is: string | null }>(
      `SELECT r.name, r.url, r.default_branch, c.hash AS as_is
       FROM ${GIT_TABLES.repository} r LEFT JOIN edge e ON e.from_node = r.node_id AND e.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.asIs}')
       LEFT JOIN ${GIT_TABLES.commit} c ON c.node_id = e.to_node ORDER BY r.name`,
    );
    return found.rows.map((row) => ({ name: row.name, url: row.url, defaultBranch: row.default_branch, asIsCommit: row.as_is }));
  }));
}

/** Every folder of one repository's current tree, in code point order of the paths, with the parent it hangs from. */
export async function listDirectories(owner: DatabaseOwner, repository: string): Promise<readonly { readonly path: string; readonly parent: string }[]> {
  return await withSpan('records.listDirectories', { 'records.repository': repository }, async () => await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, repository);
    const found = await tx.query<{ path: string; parent: string }>(
      `SELECT p.text AS path, coalesce(pp.text, '') AS parent
       FROM ${GIT_TABLES.directory} d JOIN ${GIT_TABLES.path} p ON p.id = d.path_id
       JOIN edge e ON e.to_node = d.node_id AND e.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.contains}')
       LEFT JOIN node pn ON pn.id = e.from_node AND pn.id <> $1::bigint LEFT JOIN ${GIT_TABLES.directory} pd ON pd.node_id = pn.id LEFT JOIN ${GIT_TABLES.path} pp ON pp.id = pd.path_id
       WHERE d.repository_node = $1::bigint ORDER BY p.text`,
      [repositoryId],
    );
    return found.rows;
  }));
}

/** One commit with its parents, its author and its dates. */
export async function commitFacts(owner: DatabaseOwner, _repository: string, hash: string): Promise<CommitRecord | null> {
  return await withSpan('records.commitFacts', { 'records.commit': hash }, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<Record<string, unknown>>(
      `SELECT c.hash, to_char(c.author_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS author_date, c.author_offset_min,
              to_char(c.commit_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS commit_date, c.commit_offset_min, c.subject,
              coalesce(s.name, '') AS author_name, coalesce(s.email, '') AS author_email
       FROM ${GIT_TABLES.commit} c LEFT JOIN edge e ON e.to_node = c.node_id AND e.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.authored}')
       LEFT JOIN ${GIT_TABLES.signature} s ON s.node_id = e.from_node WHERE c.hash = $1`,
      [hash],
    );
    const row = found.rows[0];
    if (row === undefined) return null;
    const parents = await tx.query<{ hash: string }>(
      `SELECT pc.hash FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.parent}' JOIN ${GIT_TABLES.parent_position} pp ON pp.edge_id = e.id
       JOIN ${GIT_TABLES.commit} pc ON pc.node_id = e.to_node WHERE e.from_node = (SELECT node_id FROM ${GIT_TABLES.commit} WHERE hash = $1) ORDER BY pp.position`,
      [hash],
    );
    const authorDate = row['author_date'] === null || row['author_date'] === undefined ? '' : String(row['author_date']);
    const commitDate = row['commit_date'] === null || row['commit_date'] === undefined ? '' : String(row['commit_date']);
    return {
      hash: String(row['hash']), parents: parents.rows.map((entry) => entry.hash),
      author: { name: String(row['author_name']), email: String(row['author_email']) },
      authorDate: authorDate === '' ? '' : gitDateOf(authorDate, Number(row['author_offset_min'])), authorOffsetMin: Number(row['author_offset_min'] ?? 0),
      commitDate: commitDate === '' ? '' : gitDateOf(commitDate, Number(row['commit_offset_min'])), commitOffsetMin: Number(row['commit_offset_min'] ?? 0),
      subject: String(row['subject'] ?? ''),
    };
  }));
}

/** One repository as a reader sees it: its name, its url, the commit it is as-is at, its counts and its gaps. */
export async function repositoryFacts(owner: DatabaseOwner, repository: string): Promise<{ readonly nodeId: string; readonly name: string; readonly url: string; readonly defaultBranch: string | null; readonly asIsCommit: string | null; readonly fileCount: number; readonly commitCount: number; readonly directoryCount: number; readonly gaps: readonly { what: string; reason: string }[] } | null> {
  return await withSpan('records.repositoryFacts', { 'records.repository': repository }, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ node_id: string; name: string; url: string; default_branch: string | null }>(
      `SELECT node_id::text AS node_id, name, url, default_branch FROM ${GIT_TABLES.repository} WHERE name = $1`, [repository],
    );
    const row = found.rows[0];
    if (row === undefined) return null;
    const asIs = await tx.query<{ hash: string }>(
      `SELECT c.hash FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.asIs}' JOIN ${GIT_TABLES.commit} c ON c.node_id = e.to_node WHERE e.from_node = $1::bigint LIMIT 1`,
      [row.node_id],
    );
    const counts = await tx.query<{ files: string; commits: string; directories: string }>(
      `SELECT (SELECT count(*)::text FROM ${GIT_TABLES.file} f JOIN edge e ON e.to_node = f.node_id AND e.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.contains}') WHERE f.repository_node = $1::bigint) AS files,
              (SELECT count(*)::text FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.history}' WHERE e.from_node = $1::bigint) AS commits,
              (SELECT count(*)::text FROM ${GIT_TABLES.directory} d JOIN edge e ON e.to_node = d.node_id AND e.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.contains}') WHERE d.repository_node = $1::bigint) AS directories`,
      [row.node_id],
    );
    const gaps = await tx.query<{ what: string; reason: string }>('SELECT what, reason FROM gap WHERE repository_node = $1::bigint ORDER BY what', [row.node_id]);
    return {
      nodeId: row.node_id, name: row.name, url: row.url, defaultBranch: row.default_branch,
      asIsCommit: asIs.rows[0]?.hash ?? null,
      fileCount: Number(counts.rows[0]?.files ?? '0'),
      commitCount: Number(counts.rows[0]?.commits ?? '0'),
      directoryCount: Number(counts.rows[0]?.directories ?? '0'),
      gaps: gaps.rows,
    };
  }));
}

/** The entities per kind of the one graph, in code point order: the catalogue's counts, the store's own. */
export async function graphKindCounts(owner: DatabaseOwner): Promise<readonly { readonly kind: string; readonly count: number }[]> {
  return await withSpan('records.graphKindCounts', {}, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ kind: string; n: string }>(
      `SELECT '${GIT_KINDS.repository}' AS kind, count(*)::text AS n FROM ${GIT_TABLES.repository}
       UNION ALL SELECT '${GIT_KINDS.directory}', count(*)::text FROM ${GIT_TABLES.directory} d JOIN edge e ON e.to_node = d.node_id AND e.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.contains}')
       UNION ALL SELECT '${GIT_KINDS.file}', count(*)::text FROM ${GIT_TABLES.file} f JOIN edge e ON e.to_node = f.node_id AND e.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.contains}')
       UNION ALL SELECT '${GIT_KINDS.gitlink}', count(*)::text FROM ${GIT_TABLES.gitlink} g JOIN edge e ON e.to_node = g.node_id AND e.kind_id = (SELECT id FROM kind WHERE name = '${GIT_KINDS.contains}')
       UNION ALL SELECT '${GIT_KINDS.commit}', count(*)::text FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.history}'
       UNION ALL SELECT '${GIT_KINDS.signature}', count(*)::text FROM ${GIT_TABLES.signature} s WHERE EXISTS (SELECT 1 FROM edge e JOIN kind k ON k.id = e.kind_id AND k.name = '${GIT_KINDS.authored}' WHERE e.from_node = s.node_id)`,
    );
    return found.rows.map((row) => ({ kind: row.kind, count: Number(row.n) })).sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0));
  }));
}
