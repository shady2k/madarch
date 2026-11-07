/**
 * The repository records (madarch-8bdc.2.5, step 1 of the staged fill): the graph
 * the owner asked for — as-is only, one value stands once, one layer — in tables
 * beside the temporal ones this module does not own.
 *
 * **One graph, many kinds.** Every vertex is a `node`: an identity, its kind from
 * the `kind` dictionary, the repository it belongs to, and the key that names it
 * inside that repository. A kind's own columns stand in a table keyed by
 * `node_id`, so a later fact — a symbol, a task, a document section — links to a
 * file or a commit by the node id it already has, and the vocabulary grows by a
 * kind row and a table, never by a second graph.
 *
 * **A relation stands once, as an `edge` row.** `contains`, `as-is`, `authored`
 * and `parent` are edges like every other relation; `position` orders a commit's
 * parents. No relation is also a foreign key, so nothing can disagree with
 * itself. `touched` is the one relation that is not an edge, because its end may
 * be a path no file holds (a deleted path), and an edge needs a node.
 *
 * **Dictionaries.** `kind`, `path`, `language`, `blob` and `gap` hold each value
 * once and are referenced by `bigint`; a `repository` is a node of its own kind
 * with `repository_fact` beside it, so `node.repository_id` names a repository
 * node and every other vertex names the repository it was read in.
 *
 * **No versioning.** No row here carries a valid or recorded column and no read
 * takes a lens: a repository's rows are the as-is state. A publish compares what
 * the store holds with what the pass read, by key and by blob, and writes only
 * the rows that differ; a second run at the same commit writes nothing, and a row
 * a path no longer has is deleted.
 *
 * **The expand step.** The temporal tables of decision 0028 (`node_identity`,
 * `node_version`, `edge_identity`, `edge_version`, `node_kind`, `relation_type`,
 * `publication_scope`, `work_item`) and the code that reads and writes them stay
 * in place, untouched, and out of the fill's path: every stage still registered
 * uses them, and this module neither creates them nor reads them. A stage that
 * comes back in a later step moves to these tables; the temporal code is deleted
 * when the last one has moved, and not before.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { OuterTransaction } from '../history/types.js';

/** The tables this module owns, in code point order. */
export const RECORD_TABLES = [
  'author',
  'blob',
  'commit_fact',
  'directory',
  'edge',
  'file',
  'gap',
  'gitlink',
  'kind',
  'language',
  'node',
  'path',
  'repository_fact',
  'touched',
] as const;

/** The kinds this step writes, in code point order: the engine's own vocabulary under `code.`. */
export const RECORD_NODE_KINDS = ['author', 'blob', 'commit', 'directory', 'file', 'gitlink', 'repository'] as const;
export const RECORD_EDGE_KINDS = ['as-is', 'authored', 'contains', 'parent', 'touched'] as const;

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS kind (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE CHECK (name <> ''),
    sort text NOT NULL CHECK (sort IN ('node', 'edge'))
  )`,
  `CREATE TABLE IF NOT EXISTS path (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    text text NOT NULL UNIQUE
  )`,
  // A language stands once. Where the dataset gives several languages for one extension (.h, .m),
  // the row is the ambiguity itself: name 'ambiguous' with its candidates, never one of them picked.
  `CREATE TABLE IF NOT EXISTS language (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL CHECK (name <> ''),
    candidates text[] NOT NULL CHECK (array_length(candidates, 1) >= 1),
    UNIQUE (name, candidates)
  )`,
  `CREATE TABLE IF NOT EXISTS blob (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hash text NOT NULL UNIQUE CHECK (length(hash) = 40),
    bytes bigint NOT NULL CHECK (bytes >= 0),
    form text NOT NULL CHECK (form IN ('text', 'binary')),
    lines bigint CHECK (lines IS NULL OR lines >= 0),
    CHECK ((form = 'binary') = (lines IS NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS node (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind_id bigint NOT NULL REFERENCES kind (id),
    repository_id bigint NOT NULL,
    key text NOT NULL CHECK (key <> ''),
    UNIQUE (repository_id, kind_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS edge (
    from_id bigint NOT NULL REFERENCES node (id),
    to_id bigint NOT NULL REFERENCES node (id),
    kind_id bigint NOT NULL REFERENCES kind (id),
    position bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (from_id, to_id, kind_id, position)
  )`,
  `CREATE TABLE IF NOT EXISTS repository_fact (
    node_id bigint PRIMARY KEY REFERENCES node (id),
    name text NOT NULL CHECK (name <> ''),
    url text NOT NULL,
    default_branch text
  )`,
  `CREATE TABLE IF NOT EXISTS file (
    node_id bigint PRIMARY KEY REFERENCES node (id),
    path_id bigint NOT NULL REFERENCES path (id),
    mode text NOT NULL CHECK (mode IN ('100644', '100755', '120000')),
    blob_id bigint NOT NULL REFERENCES blob (id),
    language_id bigint NOT NULL REFERENCES language (id)
  )`,
  `CREATE TABLE IF NOT EXISTS directory (
    node_id bigint PRIMARY KEY REFERENCES node (id),
    path_id bigint NOT NULL REFERENCES path (id)
  )`,
  `CREATE TABLE IF NOT EXISTS gitlink (
    node_id bigint PRIMARY KEY REFERENCES node (id),
    path_id bigint NOT NULL REFERENCES path (id),
    other_repository text NOT NULL,
    commit_hash text NOT NULL CHECK (length(commit_hash) = 40)
  )`,
  `CREATE TABLE IF NOT EXISTS commit_fact (
    node_id bigint PRIMARY KEY REFERENCES node (id),
    hash text NOT NULL CHECK (length(hash) = 40),
    author_date timestamptz NOT NULL,
    author_offset_min integer NOT NULL,
    commit_date timestamptz NOT NULL,
    commit_offset_min integer NOT NULL,
    subject text NOT NULL,
    walk integer NOT NULL CHECK (walk >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS author (
    node_id bigint PRIMARY KEY REFERENCES node (id),
    name text NOT NULL,
    email text NOT NULL
  )`,
  // The one relation whose end may be a path no file holds: a deleted or renamed-away path.
  `CREATE TABLE IF NOT EXISTS touched (
    commit_node_id bigint NOT NULL REFERENCES node (id),
    path_id bigint NOT NULL REFERENCES path (id),
    change text NOT NULL CHECK (change IN ('added', 'modified', 'deleted', 'renamed')),
    added bigint,
    removed bigint,
    previous_path_id bigint REFERENCES path (id),
    PRIMARY KEY (commit_node_id, path_id)
  )`,
  `CREATE TABLE IF NOT EXISTS gap (
    repository_id bigint NOT NULL,
    what text NOT NULL CHECK (what <> ''),
    reason text NOT NULL CHECK (reason IN ('non-utf8-path', 'shallow-history', 'unreadable')),
    PRIMARY KEY (repository_id, what)
  )`,
  `CREATE INDEX IF NOT EXISTS file_path ON file (path_id)`,
  `CREATE INDEX IF NOT EXISTS file_blob ON file (blob_id)`,
  `CREATE INDEX IF NOT EXISTS edge_to ON edge (to_id, kind_id)`,
  `CREATE INDEX IF NOT EXISTS node_key ON node (repository_id, key)`,
  `CREATE INDEX IF NOT EXISTS touched_path ON touched (path_id)`,
  `CREATE INDEX IF NOT EXISTS commit_fact_hash ON commit_fact (hash)`,
];

/** Creates the record tables and the kinds they write; a second call changes nothing. */
export async function createRecordSchema(owner: DatabaseOwner): Promise<void> {
  await owner.transaction('write', async (tx) => {
    for (const statement of SCHEMA) await tx.query(statement);
    for (const name of RECORD_NODE_KINDS) await tx.query(`INSERT INTO kind (name, sort) VALUES ($1, 'node') ON CONFLICT (name) DO NOTHING`, [name]);
    for (const name of RECORD_EDGE_KINDS) await tx.query(`INSERT INTO kind (name, sort) VALUES ($1, 'edge') ON CONFLICT (name) DO NOTHING`, [name]);
  });
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
  /** The dataset's language, or `ambiguous` with its candidates: never one of them picked. */
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
   * publication touches its scope only: a file or folder outside it is not this publication's to delete, and a
   * row it holds stands (madarch-8bdc.2.5, item 4b).
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


// ---- the tree pass ---------------------------------------------------------

/** One row of the store's current tree, as the diff reads it. */
interface HeldFile {
  readonly nodeId: string;
  readonly mode: string;
  readonly blob: string;
  readonly language: string;
  readonly candidates: readonly string[];
  readonly bytes: number;
  readonly form: string;
  readonly lines: number | null;
}

/** Whether a held file row already says what the pass read. */
function sameFile(held: HeldFile, file: TreeFile): boolean {
  return held.mode === file.mode && held.blob === file.blob && held.language === file.language
    && [...held.candidates].sort().join('\u0000') === [...file.candidates].sort().join('\u0000')
    && held.bytes === file.bytes && held.form === file.form && held.lines === file.lines;
}

/**
 * The repository's own node id, created where the store holds none: a repository node's scope is
 * its own id, so the identity is reserved first and its scope set in a second statement.
 */
async function repositoryScope(tx: OuterTransaction, name: string): Promise<string> {
  const found = await tx.query<{ id: string }>(`SELECT n.id::text AS id FROM node n JOIN kind k ON k.id = n.kind_id WHERE k.name = 'repository' AND n.key = $1`, [name]);
  if (found.rows[0] !== undefined) return found.rows[0].id;
  const made = await tx.query<{ id: string }>(`INSERT INTO node (kind_id, repository_id, key) SELECT id, 0, $1 FROM kind WHERE name = 'repository' RETURNING id::text AS id`, [name]);
  const id = made.rows[0]!.id;
  await tx.query('UPDATE node SET repository_id = $2::bigint WHERE id = $1::bigint', [id, id]);
  return id;
}

/** The ids of the paths this publish names, inserting the ones the dictionary does not hold. */
async function pathIds(tx: OuterTransaction, paths: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths)];
  for (let at = 0; at < unique.length; at += BATCH) {
    await tx.query('INSERT INTO path (text) SELECT value FROM jsonb_array_elements_text($1::jsonb) ON CONFLICT (text) DO NOTHING', [JSON.stringify(unique.slice(at, at + BATCH))]);
  }
  const found = await tx.query<{ id: string; text: string }>('SELECT id::text AS id, text FROM path WHERE text IN (SELECT value FROM jsonb_array_elements_text($1::jsonb))', [JSON.stringify(unique)]);
  return new Map(found.rows.map((row) => [row.text, row.id]));
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

/** The language key one file's row stands for: the name and its candidates, as the dictionary holds them. */
function languageKeyOf(file: { readonly language: string; readonly candidates: readonly string[] }): string {
  return `${file.language}\u0000${file.candidates.join('\u0000')}`;
}

/** The dictionary ids of every language the tree names, inserted where the store holds none, in two statements. */
async function languageIdsOf(tx: OuterTransaction, files: readonly TreeFile[]): Promise<Map<string, string>> {
  const wanted = new Map<string, { language: string; candidates: readonly string[] }>();
  for (const file of files) wanted.set(languageKeyOf(file), { language: file.language, candidates: file.candidates });
  // A language's candidates are an array of its own, so a row is one statement: the tree names tens of
  // languages, never thousands, and the dictionary holds each once.
  for (const row of wanted.values()) {
    await tx.query('INSERT INTO language (name, candidates) VALUES ($1, $2::text[]) ON CONFLICT (name, candidates) DO NOTHING', [row.language, `{${row.candidates.map((candidate) => `"${candidate}"`).join(',')}}`]);
  }
  const found = await tx.query<{ id: string; name: string; candidates: string[] }>('SELECT id::text AS id, name, candidates FROM language');
  return new Map(found.rows.map((row) => [`${row.name}\u0000${row.candidates.join('\u0000')}`, row.id]));
}

/** The dictionary ids of every blob the tree names, inserted or corrected in two statements. */
async function blobIdsOf(tx: OuterTransaction, files: readonly TreeFile[]): Promise<Map<string, string>> {
  const wanted = new Map<string, TreeFile>();
  for (const file of files) if (!wanted.has(file.blob)) wanted.set(file.blob, file);
  const rows = [...wanted.values()];
  await inBatches(rows, async (chunk) => {
    await tx.query(
      `INSERT INTO blob (hash, bytes, form, lines) SELECT * FROM unnest($1::text[], $2::bigint[], $3::text[], $4::bigint[])
       ON CONFLICT (hash) DO UPDATE SET bytes = EXCLUDED.bytes, form = EXCLUDED.form, lines = EXCLUDED.lines`,
      [sqlText(chunk.map((file) => file.blob)), `{${chunk.map((file) => String(file.bytes)).join(',')}}`, sqlText(chunk.map((file) => file.form)), sqlIds(chunk.map((file) => (file.lines === null ? null : String(file.lines))))],
    );
  });
  const found = await tx.query<{ id: string; hash: string }>('SELECT id::text AS id, hash FROM blob');
  return new Map(found.rows.map((row) => [row.hash, row.id]));
}

/**
 * Publishes one repository's tree at one commit: its files, its gitlinks, the `contains`
 * relation from the repository and the `as-is` relation to the commit. Rows are compared by
 * key and by blob and only what differs is written; a path the tree no longer holds is deleted,
 * with its `contains` edge.
 *
 * The rows are written in statements of 500 rows each, not one statement a row: on a database
 * that answers a statement in-process the round trip is what a publish costs, and the trace
 * names the tens of thousands of statements one tree used to make.
 */
export async function publishTree(owner: DatabaseOwner, input: TreePublish): Promise<RecordCounts> {
  const scope = input.scope;
  /** Whether one repository path stands inside the publication's scope: the whole tree when it names none. */
  const within = (path: string): boolean => scope === undefined || scope.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
  return await write(owner, async (tx) => {
    const kinds = await kindIds(tx);
    const repositoryId = await repositoryScope(tx, input.repository.name);
    let counts: RecordCounts = { inserted: 0, updated: 0, deleted: 0, unchanged: 0 };
    const commitNode = await nodeOfCommit(tx, kinds, repositoryId, input.commit);
    const asIs = kinds.get('as-is')!;
    const edgeMade = await tx.query('INSERT INTO edge (from_id, to_id, kind_id, position) SELECT $1::bigint, $2::bigint, $3::bigint, 0 WHERE NOT EXISTS (SELECT 1 FROM edge WHERE from_id = $1::bigint AND to_id = $2::bigint AND kind_id = $3::bigint AND position = 0) RETURNING from_id', [repositoryId, commitNode, asIs]);
    if (edgeMade.rows.length > 0) counts = { ...counts, inserted: counts.inserted + 1 }; else counts = { ...counts, unchanged: counts.unchanged + 1 };
    const moved = await tx.query('DELETE FROM edge WHERE from_id = $1::bigint AND kind_id = $2::bigint AND to_id <> $3::bigint RETURNING from_id', [repositoryId, asIs, commitNode]);
    if (moved.rows.length > 0) counts = { ...counts, deleted: counts.deleted + moved.rows.length };
    counts = sum(counts, await repositoryFactRow(tx, repositoryId, input.repository));

    const files = [...input.files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const folders = new Set<string>();
    for (const path of [...files.map((file) => file.path), ...input.gitlinks.map((link) => link.path)]) {
      for (let folder = folderOfPath(path); folder !== ''; folder = folderOfPath(folder)) folders.add(folder);
    }
    const paths = await pathIds(tx, [...files.map((file) => file.path), ...input.gitlinks.map((link) => link.path), ...folders]);
    for (const file of files) {
      if (!paths.has(file.path)) throw new Error(`the path ${JSON.stringify(file.path)} was not given an id by the dictionary (src/graph/records.ts)`);
    }
    const held = new Map<string, HeldFile>();
    const found = await tx.query<{ key: string; node_id: string; mode: string; hash: string; name: string; candidates: string[]; bytes: string; form: string; lines: string | null }>(
      `SELECT n.key, n.id::text AS node_id, f.mode, b.hash, l.name, l.candidates, b.bytes::text AS bytes, b.form, b.lines::text AS lines
       FROM node n JOIN kind k ON k.id = n.kind_id JOIN file f ON f.node_id = n.id JOIN path p ON p.id = f.path_id
       JOIN blob b ON b.id = f.blob_id JOIN language l ON l.id = f.language_id
       WHERE n.repository_id = $1::bigint AND k.name = 'file'`, [repositoryId]);
    for (const row of found.rows) held.set(row.key, { nodeId: row.node_id, mode: row.mode, blob: row.hash, language: row.name, candidates: row.candidates, bytes: Number(row.bytes), form: row.form, lines: row.lines === null ? null : Number(row.lines) });
    const seen = new Set(files.map((file) => file.path));
    const fileNodes = new Map<string, string>();
    for (const [path, known] of held) if (seen.has(path)) fileNodes.set(path, known.nodeId);
    const toWrite = files.filter((file) => { const known = held.get(file.path); return known === undefined || !sameFile(known, file); });
    const unchanged = files.length - toWrite.length;
    counts = { ...counts, unchanged: counts.unchanged + unchanged };
    const blobIds = toWrite.length === 0 ? new Map<string, string>() : await blobIdsOf(tx, toWrite);
    const languageIds = toWrite.length === 0 ? new Map<string, string>() : await languageIdsOf(tx, toWrite);
    const created = toWrite.filter((file) => held.get(file.path) === undefined);
    await inBatches(created, async (chunk) => {
      const made = await tx.query<{ id: string; key: string }>(
        'INSERT INTO node (kind_id, repository_id, key) SELECT $1::bigint, $2::bigint, t.value FROM unnest($3::text[]) AS t(value) RETURNING id::text AS id, key',
        [kinds.get('file')!, repositoryId, sqlText(chunk.map((file) => file.path))],
      );
      const byKey = new Map(made.rows.map((row) => [row.key, row.id]));
      for (const file of chunk) fileNodes.set(file.path, byKey.get(file.path)!);
      await tx.query(
        'INSERT INTO file (node_id, path_id, mode, blob_id, language_id) SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::bigint[], $5::bigint[])',
        [
          sqlIds(chunk.map((file) => fileNodes.get(file.path)!)),
          sqlIds(chunk.map((file) => paths.get(file.path)!)),
          sqlText(chunk.map((file) => file.mode)),
          sqlIds(chunk.map((file) => blobIds.get(file.blob)!)),
          sqlIds(chunk.map((file) => languageIds.get(languageKeyOf(file))!)),
        ],
      );
    });
    counts = { ...counts, inserted: counts.inserted + created.length };
    // Only what moved is updated: the rows that held another blob, mode or language.
    for (const file of toWrite) {
      const known = held.get(file.path);
      if (known === undefined) continue;
      await tx.query('UPDATE file SET path_id = $2::bigint, mode = $3, blob_id = $4::bigint, language_id = $5::bigint WHERE node_id = $1::bigint', [known.nodeId, paths.get(file.path)!, file.mode, blobIds.get(file.blob)!, languageIds.get(languageKeyOf(file))!]);
      counts = { ...counts, updated: counts.updated + 1 };
    }
    for (const [path, known] of held) {
      if (seen.has(path)) continue;
      // A scoped publication covers its prefixes and no others: a file outside them is not its row to delete.
      if (!within(path)) continue;
      await tx.query('DELETE FROM edge WHERE (from_id = $1::bigint OR to_id = $1::bigint)', [known.nodeId]);
      await tx.query('DELETE FROM file WHERE node_id = $1::bigint', [known.nodeId]);
      await tx.query('DELETE FROM node WHERE id = $1::bigint', [known.nodeId]);
      counts = { ...counts, deleted: counts.deleted + 1 };
    }
    // The gitlinks: a submodule is its own vertex, named by the repository and the commit it stands at.
    const heldLinks = new Set((await tx.query<{ key: string }>(`SELECT n.key FROM node n JOIN kind k ON k.id = n.kind_id WHERE n.repository_id = $1::bigint AND k.name = 'gitlink'`, [repositoryId])).rows.map((row) => row.key));
    const linkNodes = new Map<string, string>();
    for (const link of input.gitlinks) {
      if (heldLinks.has(link.path)) {
        await tx.query(`UPDATE gitlink g SET other_repository = $2, commit_hash = $3 FROM node n WHERE n.id = g.node_id AND n.repository_id = $4::bigint AND n.key = $1`, [link.path, link.otherRepository, link.commit, repositoryId]);
        const node = (await tx.query<{ id: string }>('SELECT g.node_id::text AS id FROM gitlink g JOIN node n ON n.id = g.node_id WHERE n.repository_id = $1::bigint AND n.key = $2', [repositoryId, link.path])).rows[0]!;
        linkNodes.set(link.path, node.id);
        counts = { ...counts, unchanged: counts.unchanged + 1 };
        continue;
      }
      const made = await tx.query<{ id: string }>('INSERT INTO node (kind_id, repository_id, key) VALUES ($1::bigint, $2::bigint, $3) RETURNING id::text AS id', [kinds.get('gitlink')!, repositoryId, link.path]);
      await tx.query('INSERT INTO gitlink (node_id, path_id, other_repository, commit_hash) VALUES ($1::bigint, $2::bigint, $3, $4)', [made.rows[0]!.id, paths.get(link.path)!, link.otherRepository, link.commit]);
      linkNodes.set(link.path, made.rows[0]!.id);
      counts = { ...counts, inserted: counts.inserted + 1 };
    }
    counts = sum(counts, await publishFolders(tx, kinds, repositoryId, new Map([...fileNodes, ...linkNodes]), paths, within));
    counts = sum(counts, await publishGaps(tx, repositoryId, input.gaps));
    return counts;
  });
}

/** The folder one path stands in: the path's own text without its last leg, or '' for a top-level path. */
export function folderOfPath(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/**
 * The folder vertices and the `contains` edges of one repository: one vertex per folder any file
 * or gitlink stands in, the repository's root being the repository itself, and exactly one parent
 * for every vertex. A folder that loses its last file goes with its edge. Only what moved is
 * written: the desired parent of every vertex is compared with the edge the store holds.
 */
async function publishFolders(tx: OuterTransaction, kinds: Map<string, string>, repositoryId: string, entities: ReadonlyMap<string, string>, paths: ReadonlyMap<string, string>, within: (path: string) => boolean = () => true): Promise<RecordCounts> {
  const folders = new Set<string>();
  for (const path of entities.keys()) {
    for (let folder = folderOfPath(path); folder !== ''; folder = folderOfPath(folder)) folders.add(folder);
  }
  const heldFolders = new Map((await tx.query<{ key: string; node_id: string }>(`SELECT n.key, n.id::text AS node_id FROM node n JOIN kind k ON k.id = n.kind_id WHERE n.repository_id = $1::bigint AND k.name = 'directory'`, [repositoryId])).rows.map((row) => [row.key, row.node_id]));
  let counts: RecordCounts = { inserted: 0, updated: 0, deleted: 0, unchanged: 0 };
  const folderNodes = new Map<string, string>();
  const missing = [...folders].sort().filter((folder) => !heldFolders.has(folder));
  for (const [folder, node] of heldFolders) if (folders.has(folder)) folderNodes.set(folder, node);
  await inBatches(missing, async (chunk) => {
    const made = await tx.query<{ id: string; key: string }>(
      'INSERT INTO node (kind_id, repository_id, key) SELECT $1::bigint, $2::bigint, t.value FROM unnest($3::text[]) AS t(value) RETURNING id::text AS id, key',
      [kinds.get('directory')!, repositoryId, sqlText(chunk)],
    );
    const byKey = new Map(made.rows.map((row) => [row.key, row.id]));
    for (const folder of chunk) folderNodes.set(folder, byKey.get(folder)!);
    await tx.query('INSERT INTO directory (node_id, path_id) SELECT * FROM unnest($1::bigint[], $2::bigint[])', [sqlIds(chunk.map((folder) => folderNodes.get(folder)!)), sqlIds(chunk.map((folder) => paths.get(folder)!))]);
  });
  counts = { ...counts, inserted: counts.inserted + missing.length, unchanged: counts.unchanged + (folders.size - missing.length) };
  for (const [folder, node] of heldFolders) {
    if (folders.has(folder)) continue;
    // A folder outside a scoped publication's prefixes is not that publication's to remove.
    if (!within(folder)) continue;
    await tx.query('DELETE FROM edge WHERE from_id = $1::bigint OR to_id = $1::bigint', [node]);
    await tx.query('DELETE FROM directory WHERE node_id = $1::bigint', [node]);
    await tx.query('DELETE FROM node WHERE id = $1::bigint', [node]);
    counts = { ...counts, deleted: counts.deleted + 1 };
  }
  // The parent of every vertex: its folder, or the repository for a top-level one.
  const desired = new Map<string, string>();
  for (const [folder, node] of folderNodes) desired.set(node, folderNodes.get(folderOfPath(folder)) ?? repositoryId);
  for (const [path, node] of entities) desired.set(node, folderNodes.get(folderOfPath(path)) ?? repositoryId);
  const contains = kinds.get('contains')!;
  // The `contains` edges this publication reconciles are the ones whose child stands in its scope: an edge to a
  // file or folder outside the prefixes is not this publication's to re-parent or to delete.
  const heldEdges = new Set((await tx.query<{ from_id: string; to_id: string; key: string }>(
    `SELECT e.from_id::text AS from_id, e.to_id::text AS to_id, n.key FROM edge e JOIN node n ON n.id = e.to_id WHERE n.repository_id = $1::bigint AND e.kind_id = $2::bigint`, [repositoryId, contains],
  )).rows.filter((row) => within(row.key)).map((row) => `${row.from_id}\u0000${row.to_id}`));
  const writes: { parent: string; child: string }[] = [];
  for (const [child, parent] of desired) {
    const key = `${parent}\u0000${child}`;
    if (heldEdges.has(key)) { heldEdges.delete(key); counts = { ...counts, unchanged: counts.unchanged + 1 }; continue; }
    writes.push({ parent, child });
  }
  await inBatches(writes, async (chunk) => {
    await tx.query(
      'INSERT INTO edge (from_id, to_id, kind_id, position) SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::int[]) ON CONFLICT DO NOTHING',
      [sqlIds(chunk.map((one) => one.parent)), sqlIds(chunk.map((one) => one.child)), sqlIds(chunk.map(() => contains)), `{${chunk.map(() => '0').join(',')}}`],
    );
  });
  counts = { ...counts, inserted: counts.inserted + writes.length };
  for (const stale of heldEdges) {
    const [from, to] = stale.split('\u0000') as [string, string];
    await tx.query('DELETE FROM edge WHERE from_id = $1::bigint AND to_id = $2::bigint AND kind_id = $3::bigint AND position = 0', [from, to, contains]);
    counts = { ...counts, deleted: counts.deleted + 1 };
  }
  return counts;
}

/** The repository's own fact row: its name, its url and its default branch, written once. */
async function repositoryFactRow(tx: OuterTransaction, repositoryId: string, repository: { readonly name: string; readonly url: string; readonly defaultBranch?: string }): Promise<RecordCounts> {
  const held = await tx.query<{ url: string; default_branch: string | null }>('SELECT url, default_branch FROM repository_fact WHERE node_id = $1::bigint', [repositoryId]);
  const row = held.rows[0];
  if (row === undefined) {
    await tx.query('INSERT INTO repository_fact (node_id, name, url, default_branch) VALUES ($1::bigint, $2, $3, $4)', [repositoryId, repository.name, repository.url, repository.defaultBranch ?? null]);
    return { inserted: 1, updated: 0, deleted: 0, unchanged: 0 };
  }
  if (row.url !== repository.url || row.default_branch !== (repository.defaultBranch ?? null)) {
    await tx.query('UPDATE repository_fact SET url = $2, default_branch = $3 WHERE node_id = $1::bigint', [repositoryId, repository.url, repository.defaultBranch ?? null]);
    return { inserted: 0, updated: 1, deleted: 0, unchanged: 0 };
  }
  return { inserted: 0, updated: 0, deleted: 0, unchanged: 1 };
}

/** The gaps of one repository: the ones the pass read, and no older one. */
async function publishGaps(tx: OuterTransaction, repositoryId: string, gaps: readonly { readonly what: string; readonly reason: string }[]): Promise<RecordCounts> {
  const held = new Map((await tx.query<{ what: string; reason: string }>('SELECT what, reason FROM gap WHERE repository_id = $1::bigint', [repositoryId])).rows.map((row) => [row.what, row.reason]));
  let inserted = 0;
  let unchanged = 0;
  let deleted = 0;
  for (const gap of gaps) {
    if (held.get(gap.what) === gap.reason) { unchanged += 1; continue; }
    await tx.query('INSERT INTO gap (repository_id, what, reason) VALUES ($1::bigint, $2, $3) ON CONFLICT (repository_id, what) DO UPDATE SET reason = EXCLUDED.reason', [repositoryId, gap.what, gap.reason]);
    inserted += 1;
  }
  for (const what of held.keys()) if (!gaps.some((gap) => gap.what === what)) { await tx.query('DELETE FROM gap WHERE repository_id = $1::bigint AND what = $2', [repositoryId, what]); deleted += 1; }
  return { inserted, updated: 0, deleted, unchanged };
}

// ---- the history pass ------------------------------------------------------

/** The author key a person is folded under: git's own mailmap applied, then the lowercase email. */
export function authorKeyOf(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Publishes one repository's history: every commit as a vertex with its parents, its author, its
 * dates and its subject, and every path it touched. A commit's own row is compared with the one
 * the store holds and only a difference is written; a commit the store holds and the walk did not
 * read (a rewritten branch) is deleted with its edges and its touched rows.
 *
 * The rows of a whole history are written in statements of 500 rows each, as a tree's are: the
 * statement count is what a publish costs on an in-process database, and one row a statement made
 * 20 000 of them for one repository's history.
 */
export async function publishHistory(owner: DatabaseOwner, input: HistoryPublish): Promise<RecordCounts> {
  return await write(owner, async (tx) => {
    const kinds = await kindIds(tx);
    const repositoryId = await repositoryScope(tx, input.repository.name);
    let counts: RecordCounts = { inserted: 0, updated: 0, deleted: 0, unchanged: 0 };
    const heldCommits = new Map((await tx.query<{ key: string; node_id: string; author_date: string; commit_date: string; subject: string; author_offset_min: number; commit_offset_min: number; walk: number; author_key: string; author_name: string; author_email: string }>(
      `SELECT n.key, n.id::text AS node_id, to_char(c.author_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS author_date,
              to_char(c.commit_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS commit_date, c.subject,
              c.author_offset_min, c.commit_offset_min, c.walk, ''::text AS author_key, ''::text AS author_name, ''::text AS author_email
       FROM node n JOIN kind k ON k.id = n.kind_id JOIN commit_fact c ON c.node_id = n.id
       WHERE n.repository_id = $1::bigint AND k.name = 'commit'`, [repositoryId])).rows.map((row) => [row.key, row]));
    const heldTouched = new Map<string, { change: string; added: string | null; removed: string | null; previous: string | null }>();
    const touchedRows = await tx.query<{ key: string; path: string; change: string; added: string | null; removed: string | null; previous: string | null }>(
      `SELECT n.key, p.text AS path, t.change, t.added::text AS added, t.removed::text AS removed, pp.text AS previous
       FROM touched t JOIN node n ON n.id = t.commit_node_id JOIN path p ON p.id = t.path_id LEFT JOIN path pp ON pp.id = t.previous_path_id
       WHERE n.repository_id = $1::bigint`, [repositoryId]);
    for (const row of touchedRows.rows) heldTouched.set(`${row.key}\u0000${row.path}`, { change: row.change, added: row.added, removed: row.removed, previous: row.previous });

    // Every path the whole walk names gets its id once: one dictionary statement, not one per commit.
    const paths = await pathIds(tx, [
      ...input.commits.flatMap((commit) => commit.touched.map((entry) => entry.path)),
      ...input.commits.flatMap((commit) => commit.touched.flatMap((entry) => (entry.previousPath === undefined ? [] : [entry.previousPath]))),
    ]);

    // Every commit vertex the walk names — a commit of the walk or a parent of one — exists before a
    // row points at it, and the missing ones are made in batches.
    const needed = new Set<string>();
    for (const commit of input.commits) {
      needed.add(commit.hash);
      for (const parent of commit.parents) needed.add(parent);
    }
    const commitKind = kinds.get('commit')!;
    const commitNodes = new Map<string, string>((await tx.query<{ id: string; key: string }>(
      'SELECT id::text AS id, key FROM node WHERE repository_id = $1::bigint AND kind_id = $2::bigint', [repositoryId, commitKind],
    )).rows.map((row) => [row.key, row.id]));
    const before = new Set(commitNodes.keys());
    const missingNodes = [...needed].filter((hash) => !commitNodes.has(hash));
    await inBatches(missingNodes, async (chunk) => {
      const made = await tx.query<{ id: string; key: string }>(
        'INSERT INTO node (kind_id, repository_id, key) SELECT $1::bigint, $2::bigint, t.value FROM unnest($3::text[]) AS t(value) RETURNING id::text AS id, key',
        [commitKind, repositoryId, sqlText(chunk)],
      );
      for (const row of made.rows) commitNodes.set(row.key, row.id);
    });
    counts = { ...counts, inserted: counts.inserted + input.commits.filter((commit) => !before.has(commit.hash)).length };

    const authors = new Map<string, { name: string; email: string }>();
    for (const commit of input.commits) {
      const key = authorKeyOf(commit.authorEmail);
      if (!authors.has(key)) authors.set(key, { name: commit.authorName, email: commit.authorEmail });
    }
    const authorKind = kinds.get('author')!;
    const heldAuthors = new Map((await tx.query<{ key: string; node_id: string; name: string; email: string }>(
      `SELECT n.key, n.id::text AS node_id, a.name, a.email FROM node n JOIN kind k ON k.id = n.kind_id JOIN author a ON a.node_id = n.id WHERE n.repository_id = $1::bigint AND k.name = 'author'`, [repositoryId])).rows.map((row) => [row.key, row]));
    const authorIds = new Map<string, string>();
    for (const [key, author] of authors) {
      const known = heldAuthors.get(key);
      if (known === undefined) {
        const made = await tx.query<{ id: string }>('INSERT INTO node (kind_id, repository_id, key) VALUES ($1::bigint, $2::bigint, $3) RETURNING id::text AS id', [authorKind, repositoryId, key]);
        await tx.query('INSERT INTO author (node_id, name, email) VALUES ($1::bigint, $2, $3)', [made.rows[0]!.id, author.name, author.email]);
        authorIds.set(key, made.rows[0]!.id);
        counts = { ...counts, inserted: counts.inserted + 1 };
      } else if (known.name !== author.name) {
        await tx.query('UPDATE author SET name = $2 WHERE node_id = $1::bigint', [known.node_id, author.name]);
        authorIds.set(key, known.node_id);
        counts = { ...counts, updated: counts.updated + 1 };
      } else {
        authorIds.set(key, known.node_id);
        counts = { ...counts, unchanged: counts.unchanged + 1 };
      }
    }

    const authored = kinds.get('authored')!;
    const parent = kinds.get('parent')!;
    const newCommits: { commit: HistoryCommit; node: string; walk: number; authorDate: string; authorOffset: number; commitDate: string; commitOffset: number }[] = [];
    let updated = 0;
    let unchanged = 0;
    for (const [walk, commit] of input.commits.entries()) {
      const known = heldCommits.get(commit.hash);
      const node = commitNodes.get(commit.hash)!;
      const [authorDate, authorOffset] = instantOf(commit.authorDate, 'authorDate', commit.hash);
      const [commitDate, commitOffset] = instantOf(commit.commitDate, 'commitDate', commit.hash);
      if (known === undefined) newCommits.push({ commit, node, walk, authorDate, authorOffset, commitDate, commitOffset });
      else if (known.subject !== commit.subject || known.author_date !== authorDate || known.commit_date !== commitDate || known.walk !== walk) {
        await tx.query('UPDATE commit_fact SET author_date = $2::timestamptz, author_offset_min = $3::int, commit_date = $4::timestamptz, commit_offset_min = $5::int, subject = $6, walk = $7::int WHERE node_id = $1::bigint', [node, authorDate, authorOffset, commitDate, commitOffset, commit.subject, String(walk)]);
        updated += 1;
      } else {
        unchanged += 1;
      }
    }
    counts = { ...counts, updated: counts.updated + updated, unchanged: counts.unchanged + unchanged };
    await inBatches(newCommits, async (chunk) => {
      await tx.query(
        `INSERT INTO commit_fact (node_id, hash, author_date, author_offset_min, commit_date, commit_offset_min, subject, walk)
         SELECT * FROM unnest($1::bigint[], $2::text[], $3::timestamptz[], $4::int[], $5::timestamptz[], $6::int[], $7::text[], $8::int[])`,
        [
          sqlIds(chunk.map((one) => one.node)),
          sqlText(chunk.map((one) => one.commit.hash)),
          sqlText(chunk.map((one) => one.authorDate)),
          `{${chunk.map((one) => String(one.authorOffset)).join(',')}}`,
          sqlText(chunk.map((one) => one.commitDate)),
          `{${chunk.map((one) => String(one.commitOffset)).join(',')}}`,
          sqlText(chunk.map((one) => one.commit.subject)),
          `{${chunk.map((one) => String(one.walk)).join(',')}}`,
        ],
      );
      await tx.query(
        'INSERT INTO edge (from_id, to_id, kind_id, position) SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::int[]) ON CONFLICT DO NOTHING',
        [sqlIds(chunk.map((one) => authorIds.get(authorKeyOf(one.commit.authorEmail))!)), sqlIds(chunk.map((one) => one.node)), sqlIds(chunk.map(() => authored)), `{${chunk.map(() => '0').join(',')}}`],
      );
      const parents: { from: string; to: string; position: number }[] = [];
      for (const one of chunk) for (const [position, hash] of one.commit.parents.entries()) parents.push({ from: one.node, to: commitNodes.get(hash)!, position });
      await inBatches(parents, async (some) => {
        await tx.query(
          'INSERT INTO edge (from_id, to_id, kind_id, position) SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::int[]) ON CONFLICT DO NOTHING',
          [sqlIds(some.map((one) => one.from)), sqlIds(some.map((one) => one.to)), sqlIds(some.map(() => parent)), `{${some.map((one) => String(one.position)).join(',')}}`],
        );
      });
    });

    // Every touched row of the walk, compared with the one the store holds: only what changed is written.
    const seenTouched = new Set<string>();
    const writes: { node: string; path: string; change: string; added: string | null; removed: string | null; previous: string | null; previousPath: string | null; inserted: boolean }[] = [];
    for (const commit of input.commits) {
      const node = commitNodes.get(commit.hash)!;
      for (const entry of commit.touched) {
        const key = `${commit.hash}\u0000${entry.path}`;
        seenTouched.add(key);
        const heldRow = heldTouched.get(key);
        const previous = entry.previousPath === undefined ? null : entry.previousPath;
        const added = entry.added === null ? null : String(entry.added);
        const removed = entry.removed === null ? null : String(entry.removed);
        if (heldRow !== undefined && heldRow.change === entry.change && heldRow.added === added && heldRow.removed === removed && heldRow.previous === previous) { counts = { ...counts, unchanged: counts.unchanged + 1 }; continue; }
        writes.push({ node, path: paths.get(entry.path)!, change: entry.change, added, removed, previous: previous === null ? null : paths.get(previous)!, previousPath: previous, inserted: heldRow === undefined });
      }
    }
    await inBatches(writes, async (chunk) => {
      await tx.query(
        `INSERT INTO touched (commit_node_id, path_id, change, added, removed, previous_path_id) SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::bigint[], $5::bigint[], $6::bigint[])
         ON CONFLICT (commit_node_id, path_id) DO UPDATE SET change = EXCLUDED.change, added = EXCLUDED.added, removed = EXCLUDED.removed, previous_path_id = EXCLUDED.previous_path_id`,
        [
          sqlIds(chunk.map((one) => one.node)),
          sqlIds(chunk.map((one) => one.path)),
          sqlText(chunk.map((one) => one.change)),
          sqlIds(chunk.map((one) => one.added)),
          sqlIds(chunk.map((one) => one.removed)),
          sqlIds(chunk.map((one) => one.previous)),
        ],
      );
    });
    counts = {
      ...counts,
      inserted: counts.inserted + writes.filter((one) => one.inserted).length,
      updated: counts.updated + writes.filter((one) => !one.inserted).length,
    };
    for (const [key, heldRow] of heldTouched) {
      if (seenTouched.has(key)) continue;
      const [hash, path] = key.split('\u0000') as [string, string];
      const node = commitNodes.get(hash) ?? heldCommits.get(hash)?.node_id;
      if (node === undefined) continue;
      const pathId = (await tx.query<{ id: string }>('SELECT id::text AS id FROM path WHERE text = $1', [path])).rows[0]?.id;
      if (pathId === undefined) continue;
      await tx.query('DELETE FROM touched WHERE commit_node_id = $1::bigint AND path_id = $2::bigint', [node, pathId]);
      counts = { ...counts, deleted: counts.deleted + 1 };
      void heldRow;
    }
    counts = sum(counts, await publishGaps(tx, repositoryId, input.gaps));
    return counts;
  });
}

/** A commit's node under a hash, created where the walk has not reached it: the end of a parent edge. */
async function nodeOfCommit(tx: OuterTransaction, kinds: Map<string, string>, repositoryId: string, hash: string): Promise<string> {
  const found = await tx.query<{ id: string }>('SELECT id::text AS id FROM node WHERE repository_id = $1::bigint AND kind_id = $2::bigint AND key = $3', [repositoryId, kinds.get('commit')!, hash]);
  if (found.rows[0] !== undefined) return found.rows[0].id;
  const made = await tx.query<{ id: string }>('INSERT INTO node (kind_id, repository_id, key) VALUES ($1::bigint, $2::bigint, $3) RETURNING id::text AS id', [kinds.get('commit')!, repositoryId, hash]);
  return made.rows[0]!.id;
}

/**
 * A `%aI` instant as a timestamp text and its offset in minutes: git's own two numbers, kept apart.
 *
 * Git writes the offset as `+HH:MM` or `-HH:MM`, and — from the version whose dates are strict ISO 8601 with a
 * zero offset — as the bare `Z` every reader of `+00:00` also means (measured: git 2.43 writes `+00:00`, a newer
 * git writes `Z` for the same commit). Both are one statement of the same zero minutes east of UTC, so both are
 * read here; anything else is refused by name.
 */
export function instantOf(text: string, field: string, hash: string): [string, number] {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:(Z)|([+-])(\d{2}):(\d{2}))$/u.exec(text.trim());
  if (match === null) throw new Error(`the commit ${hash} names its ${field} as ${JSON.stringify(text)}, and a git date is YYYY-MM-DDTHH:MM:SS+HH:MM or YYYY-MM-DDTHH:MM:SSZ (src/graph/records.ts)`);
  if (match[2] === 'Z') return [`${match[1]}Z`, 0];
  const sign = match[3] === '-' ? -1 : 1;
  return [`${match[1]}Z`, sign * (Number(match[4]) * 60 + Number(match[5]))];
}

// ---- what a reader asks ----------------------------------------------------

/** One file as a reader sees it: the facts the tree pass wrote. */
export interface FileRecord {
  readonly path: string;
  readonly mode: string;
  readonly blob: string;
  readonly bytes: number;
  readonly form: 'text' | 'binary';
  readonly lines: number | null;
  readonly language: string;
  readonly candidates: readonly string[];
}

/** One commit as a reader sees it. */
export interface CommitRecord {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly author: { readonly name: string; readonly email: string };
  readonly authorDate: string;
  readonly authorOffsetMin: number;
  readonly commitDate: string;
  readonly commitOffsetMin: number;
  readonly subject: string;
}

/** One path the walk has not read: the store says so rather than answering nothing. */
export class RecordGap extends Error {}

const FILE_SELECT = `SELECT p.text AS path, f.mode, b.hash AS blob, b.bytes::text AS bytes, b.form, b.lines::text AS lines, l.name AS language, l.candidates
  FROM node n JOIN kind k ON k.id = n.kind_id JOIN file f ON f.node_id = n.id JOIN path p ON p.id = f.path_id
  JOIN blob b ON b.id = f.blob_id JOIN language l ON l.id = f.language_id`;

function fileOf(row: Record<string, unknown>): FileRecord {
  return {
    path: String(row['path']), mode: String(row['mode']), blob: String(row['blob']), bytes: Number(row['bytes']),
    form: row['form'] === 'binary' ? 'binary' : 'text',
    lines: row['lines'] === null || row['lines'] === undefined ? null : Number(row['lines']),
    language: String(row['language']), candidates: (row['candidates'] as string[] | undefined) ?? [],
  };
}

/** The repository's node id, or a gap when the store holds no such repository. */
async function repositoryIdOf(tx: OuterTransaction, repository: string): Promise<string> {
  const found = await tx.query<{ id: string }>(`SELECT n.id::text AS id FROM node n JOIN kind k ON k.id = n.kind_id WHERE k.name = 'repository' AND n.key = $1`, [repository]);
  const row = found.rows[0];
  if (row === undefined) throw new RecordGap(`the store holds no repository ${JSON.stringify(repository)}: the fill of this step has not run for it (src/graph/records.ts)`);
  return row.id;
}

/** One page of a repository's files, in code point order of the paths. */
export async function listFiles(owner: DatabaseOwner, input: { readonly repository: string; readonly prefix?: string; readonly language?: string; readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
  return await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, input.repository);
    const found = await tx.query(
      `${FILE_SELECT} WHERE n.repository_id = $1::bigint AND ($2::text IS NULL OR p.text LIKE $2 || '%') AND ($3::text IS NULL OR l.name = $3) AND ($4::text IS NULL OR p.text > $4)
       ORDER BY p.text LIMIT $5::bigint`,
      [repositoryId, input.prefix ?? null, input.language ?? null, input.after ?? null, String(input.limit + 1)],
    );
    const rows = found.rows.map(fileOf);
    const more = rows.length > input.limit;
    const shown = more ? rows.slice(0, input.limit) : rows;
    return { rows: shown, next: more ? shown[shown.length - 1]!.path : null };
  });
}

/** The commits that touched one path, following renames, newest first. */
export async function fileHistory(owner: DatabaseOwner, input: { readonly repository: string; readonly path: string; readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly { readonly commit: string; readonly change: string; readonly added: number | null; readonly removed: number | null; readonly previousPath: string | null; readonly date: string; readonly subject: string }[]; readonly next: string | null }> {
  return await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, input.repository);
    const found = await tx.query(
      `WITH RECURSIVE chain(path_id) AS (
         SELECT id FROM path WHERE text = $2
         UNION
         SELECT t.previous_path_id FROM chain c JOIN touched t ON t.path_id = c.path_id WHERE t.previous_path_id IS NOT NULL
       )
       SELECT n.key AS commit, t.change, t.added::text AS added, t.removed::text AS removed, pp.text AS previous,
              to_char((c.commit_date - make_interval(mins => c.commit_offset_min)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS date, c.subject
       FROM touched t JOIN chain ch ON ch.path_id = t.path_id JOIN node n ON n.id = t.commit_node_id
       JOIN commit_fact c ON c.node_id = n.id LEFT JOIN path pp ON pp.id = t.previous_path_id
       WHERE n.repository_id = $1::bigint AND ($3::text IS NULL OR (c.commit_date - make_interval(mins => c.commit_offset_min)) < $3::timestamptz OR ((c.commit_date - make_interval(mins => c.commit_offset_min)) = $3::timestamptz AND n.key > $4))
       ORDER BY (c.commit_date - make_interval(mins => c.commit_offset_min)) DESC, n.key DESC LIMIT $5::bigint`,
      [repositoryId, input.path, input.after ?? null, input.after ?? '', String(input.limit + 1)],
    );
    const rows = found.rows.map((row) => ({
      commit: String(row['commit']), change: String(row['change']),
      added: row['added'] === null ? null : Number(row['added']), removed: row['removed'] === null ? null : Number(row['removed']),
      previousPath: row['previous'] === null || row['previous'] === undefined ? null : String(row['previous']),
      date: String(row['date']), subject: String(row['subject']),
    }));
    const more = rows.length > input.limit;
    const shown = more ? rows.slice(0, input.limit) : rows;
    return { rows: shown, next: more ? shown[shown.length - 1]!.date : null };
  });
}

/** One file with its dates, its commit count and its authors: the dates follow the renames. */
export async function fileFacts(owner: DatabaseOwner, repository: string, path: string): Promise<(FileRecord & { readonly created: { date: string; commit: string; author: string } | null; readonly modified: { date: string; commit: string; author: string } | null; readonly commitCount: number; readonly authors: readonly string[] }) | null> {
  return await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, repository);
    const found = await tx.query(`${FILE_SELECT} WHERE n.repository_id = $1::bigint AND p.text = $2`, [repositoryId, path]);
    const row = found.rows[0];
    if (row === undefined) return null;
    const history = await tx.query<{ commit: string; date: string; name: string }>(
      `WITH RECURSIVE chain(path_id) AS (
         SELECT id FROM path WHERE text = $2
         UNION
         SELECT t.previous_path_id FROM chain c JOIN touched t ON t.path_id = c.path_id WHERE t.previous_path_id IS NOT NULL
       )
       SELECT n.key AS commit, to_char((c.commit_date - make_interval(mins => c.commit_offset_min)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS date, coalesce(a.name, '') AS name, c.walk, t.change
       FROM touched t JOIN chain ch ON ch.path_id = t.path_id JOIN node n ON n.id = t.commit_node_id
       JOIN commit_fact c ON c.node_id = n.id
       LEFT JOIN edge e ON e.from_id = n.id AND e.kind_id = (SELECT id FROM kind WHERE name = 'authored')
       LEFT JOIN author a ON a.node_id = e.to_id
       WHERE n.repository_id = $1::bigint ORDER BY c.walk ASC, n.key ASC`,
      [repositoryId, path],
    );
    // The order is the history's own, not the clock's: a commit's `walk` is its position in the
    // stream git prints from the tip, so the deepest commit in the rename chain is the creation and
    // the shallowest is the last change (madarch-8bdc.2.5: dates are not monotonic).
    const commits = history.rows as unknown as { commit: string; date: string; name: string; walk: number; change: string }[];
    const created = commits.reduce((deepest, entry) => (entry.walk > deepest.walk ? entry : deepest), commits[0]!);
    const first = created;
    const last = commits[0];
    const distinct = new Map(commits.map((entry) => [entry.commit, entry]));
    const authors = [...new Set(commits.map((entry) => entry.name).filter((name) => name !== ''))].sort();
    return {
      ...fileOf(row),
      created: first === undefined ? null : { date: first.date, commit: first.commit, author: first.name },
      modified: last === undefined ? null : { date: last.date, commit: last.commit, author: last.name },
      commitCount: distinct.size,
      authors,
    };
  });
}

/** Every repository the store holds, in code point order of the names. */
export async function listRepositories(owner: DatabaseOwner): Promise<readonly { readonly name: string; readonly url: string; readonly defaultBranch: string | null; readonly asIsCommit: string | null }[]> {
  return await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ name: string; url: string; default_branch: string | null; as_is: string | null }>(
      `SELECT r.name, r.url, r.default_branch, a.key AS as_is
       FROM node n JOIN kind k ON k.id = n.kind_id JOIN repository_fact r ON r.node_id = n.id
       LEFT JOIN edge e ON e.from_id = n.id AND e.kind_id = (SELECT id FROM kind WHERE name = 'as-is')
       LEFT JOIN node a ON a.id = e.to_id WHERE k.name = 'repository' ORDER BY r.name`,
    );
    return found.rows.map((row) => ({ name: row.name, url: row.url, defaultBranch: row.default_branch, asIsCommit: row.as_is }));
  });
}

/** Every folder of one repository, in code point order of the paths, with the parent it hangs from. */
export async function listDirectories(owner: DatabaseOwner, repository: string): Promise<readonly { readonly path: string; readonly parent: string }[]> {
  return await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, repository);
    const found = await tx.query<{ path: string; parent: string }>(
      `SELECT p.text AS path, coalesce(pp.text, '') AS parent
       FROM node n JOIN kind k ON k.id = n.kind_id JOIN directory d ON d.node_id = n.id JOIN path p ON p.id = d.path_id
       LEFT JOIN edge e ON e.to_id = n.id AND e.kind_id = (SELECT id FROM kind WHERE name = 'contains')
       LEFT JOIN node pn ON pn.id = e.from_id AND pn.id <> $1::bigint LEFT JOIN path pp ON pp.id = (SELECT d2.path_id FROM directory d2 WHERE d2.node_id = pn.id)
       WHERE n.repository_id = $1::bigint AND k.name = 'directory' ORDER BY p.text`,
      [repositoryId],
    );
    return found.rows;
  });
}

/** One commit with its parents, its author and its dates. */
export async function commitFacts(owner: DatabaseOwner, repository: string, hash: string): Promise<CommitRecord | null> {
  return await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, repository);
    const found = await tx.query<Record<string, unknown>>(
      `SELECT c.hash, to_char((c.author_date - make_interval(mins => c.author_offset_min)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS author_date, c.author_offset_min,
              to_char((c.commit_date - make_interval(mins => c.commit_offset_min)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS commit_date, c.commit_offset_min, c.subject,
              coalesce(a.name, '') AS author_name, coalesce(a.email, '') AS author_email
       FROM node n JOIN kind k ON k.id = n.kind_id JOIN commit_fact c ON c.node_id = n.id
       LEFT JOIN edge e ON e.from_id = n.id AND e.kind_id = (SELECT id FROM kind WHERE name = 'authored')
       LEFT JOIN author a ON a.node_id = e.to_id
       WHERE n.repository_id = $1::bigint AND k.name = 'commit' AND c.hash = $2`,
      [repositoryId, hash],
    );
    const row = found.rows[0];
    if (row === undefined) return null;
    const parents = await tx.query<{ key: string }>(
      `SELECT pn.key FROM node n JOIN edge e ON e.from_id = n.id AND e.kind_id = (SELECT id FROM kind WHERE name = 'parent')
       JOIN node pn ON pn.id = e.to_id WHERE n.repository_id = $1::bigint AND n.key = $2 ORDER BY e.position`,
      [repositoryId, hash],
    );
    return {
      hash: String(row['hash']), parents: parents.rows.map((entry) => entry.key),
      author: { name: String(row['author_name']), email: String(row['author_email']) },
      authorDate: String(row['author_date']), authorOffsetMin: Number(row['author_offset_min']),
      commitDate: String(row['commit_date']), commitOffsetMin: Number(row['commit_offset_min']),
      subject: String(row['subject']),
    };
  });
}

/** One repository as a reader sees it: its name, its url, the commit it is as-is at, its counts and its gaps. */
export async function repositoryFacts(owner: DatabaseOwner, repository: string): Promise<{ readonly name: string; readonly url: string; readonly defaultBranch: string | null; readonly asIsCommit: string | null; readonly fileCount: number; readonly commitCount: number; readonly directoryCount: number; readonly gaps: readonly { what: string; reason: string }[] } | null> {
  return await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ id: string; name: string; url: string; default_branch: string | null }>(
      `SELECT n.id::text AS id, r.name, r.url, r.default_branch FROM node n JOIN kind k ON k.id = n.kind_id JOIN repository_fact r ON r.node_id = n.id WHERE k.name = 'repository' AND n.key = $1`,
      [repository],
    );
    const row = found.rows[0];
    if (row === undefined) return null;
    const asIs = await tx.query<{ key: string }>(
      `SELECT cn.key FROM edge e JOIN node cn ON cn.id = e.to_id WHERE e.from_id = $1::bigint AND e.kind_id = (SELECT id FROM kind WHERE name = 'as-is') LIMIT 1`,
      [row.id],
    );
    const counts = await tx.query<{ files: string; commits: string; directories: string }>(
      `SELECT (SELECT count(*)::text FROM node n JOIN kind k ON k.id = n.kind_id WHERE n.repository_id = $1::bigint AND k.name = 'file') AS files,
              (SELECT count(*)::text FROM node n JOIN kind k ON k.id = n.kind_id JOIN commit_fact c ON c.node_id = n.id WHERE n.repository_id = $1::bigint AND k.name = 'commit') AS commits,
              (SELECT count(*)::text FROM node n JOIN kind k ON k.id = n.kind_id WHERE n.repository_id = $1::bigint AND k.name = 'directory') AS directories`,
      [row.id],
    );
    const gaps = await tx.query<{ what: string; reason: string }>('SELECT what, reason FROM gap WHERE repository_id = $1::bigint ORDER BY what', [row.id]);
    return {
      name: row.name, url: row.url, defaultBranch: row.default_branch,
      asIsCommit: asIs.rows[0]?.key ?? null,
      fileCount: Number(counts.rows[0]?.files ?? '0'),
      commitCount: Number(counts.rows[0]?.commits ?? '0'),
      directoryCount: Number(counts.rows[0]?.directories ?? '0'),
      gaps: gaps.rows,
    };
  });
}

/** Every table's bytes with its indexes and its rows, for the bytes-per-row measurement. */
export async function recordSizes(owner: DatabaseOwner): Promise<Record<string, { bytes: number; rows: number }>> {
  return await owner.transaction('snapshot', async (tx) => {
    const out: Record<string, { bytes: number; rows: number }> = {};
    for (const table of RECORD_TABLES) {
      const size = await tx.query<{ bytes: string; rows: string }>(`SELECT pg_total_relation_size($1::regclass)::text AS bytes, count(*)::text AS rows FROM ${table}`, [table]);
      out[table] = { bytes: Number(size.rows[0]?.bytes ?? '0'), rows: Number(size.rows[0]?.rows ?? '0') };
    }
    return out;
  });
}
