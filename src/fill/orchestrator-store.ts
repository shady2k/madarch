/**
 * The orchestrator's own tables and the one publication of a unit generation
 * (decision 0027). Four row sets, all of them the orchestrator's and none of
 * them the state machines' (`state-store.ts`) or the queue's (`queue.ts`):
 *
 * - `fill_unit_read`: every tracked read a generation made, with the digest of
 *   the rows the read answered. The digest covers the membership, so a row
 *   added, removed or changed moves it, and an empty answer digests as an empty
 *   list rather than as nothing — decision 0027 rechecks these at publication,
 *   empty results included.
 * - `fill_unit_draft`: the draft set a generation's stage wrote, recorded when
 *   the machine's `record-draft` effect runs and retracted by `retract-draft`;
 *   its writes stand in `fill_unit_draft_part`, a few hundred to a row (a row
 *   written before the parts existed keeps them in its own `writes`).
 * - `fill_unit_split`: the child set a split sealed, so a waiting parent knows
 *   exactly which child generations its join is for.
 * - `fill_publication`: one row per unit generation, uniquely constrained, with
 *   the digest of what it published. A repeated request with the same identity
 *   and digest answers the existing record; a different digest is refused.
 *
 * `publishUnit` is the decision's publication: one short transaction of the
 * process's one database owner that checks the generation, the fence, the run's
 * control and the cancellation intent, rechecks every recorded read, applies the
 * unit's fact set within its ownership scope through the caller's `apply`, takes
 * the machine's own `publish` step — the generation enters `published` inside
 * the same transaction — and inserts the publication record. The caller may do
 * its own work in that same transaction (the queue's settlement, for one) by
 * using `publishUnitIn` inside a transaction it opened.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { canonicalJsonDigest } from '../model/canonical.js';
import { byCodePoint } from '../model/order.js';
import type { FillRun } from '../product/fill-runtime.js';
import type { SqlExecutor } from '../query/sql-driver.js';
import { here, raise, withLocation } from './fsm-core.js';
import { FACT_RANK_FIELDS } from './facts.js';
import { advanceUnitIn, type UnitRecord } from './state-store.js';
import type { StageDraftWrite } from './stage.js';

/** The orchestrator's own tables; `createOrchestratorSchema` creates them and every error names the ones it touched. */
export const ORCHESTRATOR_TABLES = [
  'fill_run_configuration', 'fill_run_stage', 'fill_unit_plan', 'fill_unit_read', 'fill_unit_draft', 'fill_unit_draft_part', 'fill_unit_split', 'fill_publication', 'fill_event',
] as const;

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS fill_run_configuration (
    run_id text PRIMARY KEY,
    digest text NOT NULL,
    snapshot jsonb NOT NULL,
    recorded_at bigint NOT NULL
  )`,
  // The stages of one run that have planned (madarch-tzte.26.3): a stage whose
  // producers have settled inside the run plans then, so the record of which
  // stages planned is the run's resume point — a run that crashed between a
  // producer's publication and its consumer's planning plans the consumer when
  // it is driven again, and never plans a stage twice.
  `CREATE TABLE IF NOT EXISTS fill_run_stage (
    run_id text NOT NULL,
    stage_id text NOT NULL,
    planned_at bigint NOT NULL,
    units integer NOT NULL,
    publications integer NOT NULL,
    PRIMARY KEY (run_id, stage_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_unit_plan (
    unit_id text NOT NULL,
    generation integer NOT NULL,
    run_id text NOT NULL,
    stage_id text NOT NULL,
    stage_unit_id text NOT NULL,
    scope text NOT NULL,
    stage_position integer NOT NULL,
    plan_position integer NOT NULL,
    planned_at bigint NOT NULL,
    PRIMARY KEY (unit_id, generation)
  )`,
  'CREATE INDEX IF NOT EXISTS fill_unit_plan_run ON fill_unit_plan (run_id)',
  `CREATE TABLE IF NOT EXISTS fill_event (
    run_id text NOT NULL,
    seq integer NOT NULL,
    at bigint NOT NULL,
    stage text NOT NULL,
    unit_id text NOT NULL,
    generation integer,
    kind text NOT NULL,
    summary text NOT NULL,
    PRIMARY KEY (run_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_unit_read (
    unit_id text NOT NULL,
    generation integer NOT NULL,
    query_digest text NOT NULL,
    query text NOT NULL,
    membership text NOT NULL,
    members integer NOT NULL,
    read_seq integer NOT NULL,
    at bigint NOT NULL,
    PRIMARY KEY (unit_id, generation, query_digest)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_unit_draft (
    unit_id text NOT NULL,
    generation integer NOT NULL,
    digest text NOT NULL,
    writes jsonb NOT NULL,
    recorded_at bigint NOT NULL,
    retracted_at bigint,
    PRIMARY KEY (unit_id, generation)
  )`,
  // A draft set's writes, in parts of `DRAFT_PART_WRITES` (madarch-tzte.21.11): one jsonb value of a
  // repository-wide unit's whole set — 34 MB for the modules stage over the madarch tree — took the
  // embedded store's memory up by about 490 MB for good, where the same bytes in parts took it up by
  // nothing measurable.
  `CREATE TABLE IF NOT EXISTS fill_unit_draft_part (
    unit_id text NOT NULL,
    generation integer NOT NULL,
    part integer NOT NULL,
    writes jsonb NOT NULL,
    PRIMARY KEY (unit_id, generation, part)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_unit_split (
    parent_unit_id text NOT NULL,
    parent_generation integer NOT NULL,
    child_unit_id text NOT NULL,
    child_generation integer NOT NULL,
    sealed_at bigint NOT NULL,
    PRIMARY KEY (parent_unit_id, parent_generation, child_unit_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_publication (
    unit_id text NOT NULL,
    generation integer NOT NULL,
    digest text NOT NULL,
    facts integer NOT NULL,
    published_at bigint NOT NULL,
    PRIMARY KEY (unit_id, generation)
  )`,
];

/**
 * The column a build before madarch-tzte.26.1 did not write: the versions that decided what a unit
 * reads and answers when it was planned — its stage's `id@version` and the stage's own prompt,
 * answer-schema and model versions — recorded with the plan, so a run that resolves another names the
 * one that moved instead of two digests. A plan row that holds none was written before it existed.
 */
const CACHE_VERSIONS_COLUMN = 'ALTER TABLE fill_unit_plan ADD COLUMN IF NOT EXISTS cache_versions jsonb';

/**
 * The schema's one key, for the lock that keeps two processes from adding the column at once: the
 * crash suite starts several executor processes beside the server, and concurrent `ALTER TABLE` on
 * one table answers "tuple concurrently updated" to whichever loses. The lock is the transaction's,
 * so it is held for exactly the statement it guards.
 */
const CACHE_VERSIONS_LOCK = 724_913_556;

/** Creates the orchestrator's tables and indexes; safe to run on every start of the process's owner. */
export async function createOrchestratorSchema(database: OrchestratorDatabase): Promise<void> {
  const at = here();
  await run(at, database, 'createOrchestratorSchema', ORCHESTRATOR_TABLES, async (executor) => {
    for (const statement of SCHEMA) await executor.query(statement);
    // The column is added under the lock and only where it is missing: the check first, so a store a
    // previous build filled and this build opened pays one query and no DDL at all.
    await executor.query('SELECT pg_advisory_xact_lock($1)', [CACHE_VERSIONS_LOCK]);
    const { rows } = await executor.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_name = 'fill_unit_plan' AND column_name = 'cache_versions') AS present`,
    );
    if (rows[0]?.present === true) return;
    await executor.query(CACHE_VERSIONS_COLUMN);
  }, 'write');
}

/** The narrow slice of the process's one database owner these tables borrow: the owner's `transaction`. */
export type OrchestratorDatabase = Pick<DatabaseOwner, 'transaction'>;

const json = (value: unknown): string => JSON.stringify(value);

/** Epoch milliseconds from a `bigint` column, which PostgreSQL drivers answer as a string. */
const millis = (value: unknown): number => (typeof value === 'number' ? value : Number(value));

/** Runs one operation, naming it and the tables it touches when the database failed. */
async function run<R>(
  site: string,
  database: OrchestratorDatabase,
  operation: string,
  tables: readonly string[],
  work: (executor: SqlExecutor) => Promise<R>,
  kind: 'snapshot' | 'write',
): Promise<R> {
  return await withLocation(site, operation, tables, async () => await database.transaction(kind, work));
}

/**
 * One read answer's value as the membership digest can hold it: a `Date` is its
 * instant in ISO text, a `Uint8Array` its bytes in hex, a `bigint` its decimal
 * text, an array or a plain object is taken field by field, and a value no
 * digest can tell from another — a function, a symbol, a `Map` — is refused by
 * name rather than collapsed to `{}`. The owner hands timestamps back as `Date`
 * objects, and a digest that reads them as `{}` would call two different
 * instants one membership, which is a moved read nothing could see.
 */
function membershipValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'undefined') return { absent: true };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? { invalid: 'date' } : value.toISOString();
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map((entry, index) => membershipValue(entry, `${path}[${index}]`));
  if (typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(fields).sort(byCodePoint)) {
      if (RANK_FIELD_NAMES.has(key)) continue;
      out[key] = membershipValue(fields[key], `${path}.${key}`);
    }
    return out;
  }
  raise(`a read answered ${typeof value} at ${path}, which no membership digest can hold: a query answers rows of plain values, and a value two digests cannot tell apart would hide a read that moved`);
}

/**
 * The fields a fact's own value holds as one measurement of the whole graph
 * rather than as an observation of the node (`FACT_RANK_FIELDS`, madarch-tzte.21.7):
 * the rank stage 5's PageRank measures over a repository. A read that answered
 * one of them is not stale because the measurement moved — the read was about the
 * node, not about the number a later run gave it — so the membership digest
 * leaves these names out, and a re-ranking makes no unit that read a file or a
 * symbol out of date. Only a rank is left out: a module's `members` moves when
 * the tree moves, which is what a read of that module is about. The names come
 * from the schema, so the kinds that declare a rank are the one place that says
 * which names are ranks; the digest sees plain rows and not facts, so it reads
 * the name.
 */
const RANK_FIELD_NAMES: ReadonlySet<string> = new Set(Object.values(FACT_RANK_FIELDS).flatMap((fields) => [...(fields ?? [])]));

/**
 * The digest of one read's answer: the membership of the rows it answered, in a
 * canonical order of its own, so a row added, removed or changed moves it and a
 * graph that answers the same rows in another order does not. An empty answer is
 * the empty list, which is a value of its own — "nothing here yet" is a statement
 * a later read can turn false, and decision 0027 rechecks it like any other.
 */
export function readMembership(rows: readonly unknown[]): string {
  // Each row is serialized into its digest once and the digests decide the order (madarch-tzte.21.11):
  // a read of a whole repository answers tens of thousands of rows, and a comparator that serialized its
  // two sides again on every comparison did it O(n log n) times — gigabytes of transient strings for the
  // modules stage's read of 28 392 symbols — where one pass is a digest per row. The order is the same
  // one the comparator gave (equal digests are equal rows, and a stable sort keeps their order), so a
  // membership recorded before this change still equals the one this computes.
  const members = rows.map((row) => membershipValue(row, 'row'));
  const ordered = members
    .map((row) => ({ row, digest: canonicalJsonDigest(row) }))
    .sort((left, right) => byCodePoint(left.digest, right.digest));
  return canonicalJsonDigest(ordered.map((entry) => entry.row));
}

/** One tracked read of a unit generation, as it is persisted. */
export interface TrackedRead {
  readonly unitId: string;
  readonly generation: number;
  /** The query's own digest, the row's key: a query is remembered once per generation, whatever it says. */
  readonly queryDigest: string;
  readonly query: string;
  /** The digest of the rows the read answered, empty answers included. */
  readonly membership: string;
  /** How many rows the read answered. */
  readonly members: number;
  readonly seq: number;
  readonly at: number;
}

/** The digest a query is remembered by; two texts that differ at all are two reads. */
export const queryDigest = (query: string): string => canonicalJsonDigest({ query });

interface ReadRow extends Record<string, unknown> { unit_id: string; generation: unknown; query_digest: string; query: string; membership: string; members: unknown; read_seq: unknown; at: unknown }

function readRecord(row: ReadRow): TrackedRead {
  return {
    unitId: row.unit_id,
    generation: millis(row.generation),
    queryDigest: row.query_digest,
    query: row.query,
    membership: row.membership,
    members: millis(row.members),
    seq: millis(row.read_seq),
    at: millis(row.at),
  };
}

/**
 * Records one tracked read of a unit generation, replacing what the same query
 * answered before in this generation: the read set is the queries with their
 * latest membership, which is what publication rechecks.
 */
export async function recordUnitRead(
  database: OrchestratorDatabase,
  options: { readonly unitId: string; readonly generation: number; readonly query: string; readonly rows: readonly unknown[]; readonly at: number; readonly membership?: string },
): Promise<TrackedRead> {
  const at = here();
  return run(at, database, `recordUnitRead(${options.unitId}/${options.generation})`, ['fill_unit_read'], async (executor) => recordUnitReadIn(executor, options), 'write');
}

/** Records one tracked read inside a transaction the caller already opened. */
export async function recordUnitReadIn(
  executor: SqlExecutor,
  options: { readonly unitId: string; readonly generation: number; readonly query: string; readonly rows: readonly unknown[]; readonly at: number; readonly membership?: string },
): Promise<TrackedRead> {
  const digest = queryDigest(options.query);
  // The membership the caller read the answer under, or — where it names none — the digest of the rows as they
  // stand. A span read names its own (`answerMembership`, `graph-reads.ts`): its bytes are its membership, and the
  // commit they were read at is not.
  const membership = options.membership ?? readMembership(options.rows);
  // The generation's own row is taken first: on a PostgreSQL owner two units' reads can run at once, and
  // two reads of one generation must not take the same sequence number.
  await executor.query('SELECT unit_id FROM fill_unit_generation WHERE unit_id = $1 AND generation = $2 FOR UPDATE', [options.unitId, options.generation]);
  const { rows: counted } = await executor.query<{ next: unknown }>(
    'SELECT COALESCE(MAX(read_seq), 0) + 1 AS next FROM fill_unit_read WHERE unit_id = $1 AND generation = $2',
    [options.unitId, options.generation],
  );
  const seq = millis(counted[0]?.next ?? 1);
  await executor.query(
    `INSERT INTO fill_unit_read (unit_id, generation, query_digest, query, membership, members, read_seq, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (unit_id, generation, query_digest) DO UPDATE
       SET query = EXCLUDED.query, membership = EXCLUDED.membership, members = EXCLUDED.members,
           read_seq = EXCLUDED.read_seq, at = EXCLUDED.at`,
    [options.unitId, options.generation, digest, options.query, membership, options.rows.length, seq, options.at],
  );
  return { unitId: options.unitId, generation: options.generation, queryDigest: digest, query: options.query, membership, members: options.rows.length, seq, at: options.at };
}

/** Every tracked read of one unit generation, in the order they were made. */
export async function readUnitReads(database: OrchestratorDatabase, unitId: string, generation: number): Promise<readonly TrackedRead[]> {
  const at = here();
  return run(at, database, `readUnitReads(${unitId}/${generation})`, ['fill_unit_read'], async (executor) => {
    const { rows } = await executor.query<ReadRow>(
      'SELECT unit_id, generation, query_digest, query, membership, members, read_seq, at FROM fill_unit_read WHERE unit_id = $1 AND generation = $2 ORDER BY read_seq ASC',
      [unitId, generation],
    );
    return rows.map(readRecord);
  }, 'snapshot');
}

/** One unit generation's draft set, as it is persisted. */
export interface DraftRecord {
  readonly unitId: string;
  readonly generation: number;
  readonly digest: string;
  readonly writes: readonly StageDraftWrite[];
  readonly recordedAt: number;
  readonly retractedAt: number | null;
}

interface DraftRow extends Record<string, unknown> { unit_id: string; generation: unknown; digest: string; writes: unknown; recorded_at: unknown; retracted_at: unknown }

function draftRecord(row: DraftRow): DraftRecord {
  const writes = typeof row.writes === 'string' ? JSON.parse(row.writes) : row.writes;
  if (!Array.isArray(writes)) raise(`table fill_unit_draft, row ${row.unit_id}/${String(row.generation)}: the writes are not a list`);
  return {
    unitId: row.unit_id,
    generation: millis(row.generation),
    digest: row.digest,
    writes: writes as StageDraftWrite[],
    recordedAt: millis(row.recorded_at),
    retractedAt: row.retracted_at === null || row.retracted_at === undefined ? null : millis(row.retracted_at),
  };
}

/**
 * What a published generation's draft set holds afterwards: nothing. The facts it published are the
 * store's own rows (`fill_fact_holding`, by unit and generation), the row keeps the digest a repeated
 * request of that generation is judged by, and its `writes` — a unit's whole fact set as JSON, the
 * largest second copy of what the publication wrote — are dropped (madarch-tzte.21.11).
 */
export const PUBLISHED_DRAFT_WRITES = '[]';

/** The digest of one draft set: what a publication names, so the same draft published twice is one publication. */
export function draftDigest(writes: readonly StageDraftWrite[]): string {
  return canonicalJsonDigest(writes);
}

/** Records the draft set a unit generation's stage wrote, replacing an earlier one of the same generation. */
export async function recordUnitDraft(
  database: OrchestratorDatabase,
  options: { readonly unitId: string; readonly generation: number; readonly writes: readonly StageDraftWrite[]; readonly at: number },
): Promise<DraftRecord> {
  const at = here();
  return run(at, database, `recordUnitDraft(${options.unitId}/${options.generation})`, ['fill_unit_draft', 'fill_unit_draft_part'], async (executor) => recordUnitDraftIn(executor, options), 'write');
}

/** Records a draft set inside a transaction the caller already opened. */
export async function recordUnitDraftIn(
  executor: SqlExecutor,
  options: { readonly unitId: string; readonly generation: number; readonly writes: readonly StageDraftWrite[]; readonly at: number },
): Promise<DraftRecord> {
  const digest = draftDigest(options.writes);
  // The row holds the digest and the times; the writes are its parts, replaced whole, so a set recorded
  // again is the new set and nothing of the one before it.
  await executor.query(
    `INSERT INTO fill_unit_draft (unit_id, generation, digest, writes, recorded_at, retracted_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NULL)
     ON CONFLICT (unit_id, generation) DO UPDATE
       SET digest = EXCLUDED.digest, writes = EXCLUDED.writes, recorded_at = EXCLUDED.recorded_at, retracted_at = NULL`,
    [options.unitId, options.generation, digest, EMPTY_WRITES, options.at],
  );
  await executor.query('DELETE FROM fill_unit_draft_part WHERE unit_id = $1 AND generation = $2', [options.unitId, options.generation]);
  for (let at = 0, part = 0; at < options.writes.length; at += DRAFT_PART_WRITES, part += 1) {
    await executor.query(
      'INSERT INTO fill_unit_draft_part (unit_id, generation, part, writes) VALUES ($1, $2, $3, $4::jsonb)',
      [options.unitId, options.generation, part, json(options.writes.slice(at, at + DRAFT_PART_WRITES))],
    );
  }
  return { unitId: options.unitId, generation: options.generation, digest, writes: options.writes, recordedAt: options.at, retractedAt: null };
}

/** The draft set of one unit generation, or null when it holds none. */
export async function readUnitDraft(database: OrchestratorDatabase, unitId: string, generation: number): Promise<DraftRecord | null> {
  const at = here();
  return run(at, database, `readUnitDraft(${unitId}/${generation})`, ['fill_unit_draft', 'fill_unit_draft_part'], async (executor) => readUnitDraftIn(executor, unitId, generation), 'snapshot');
}

/** The draft set of one unit generation inside a transaction the caller already opened. */
export async function readUnitDraftIn(executor: SqlExecutor, unitId: string, generation: number): Promise<DraftRecord | null> {
  const { rows } = await executor.query<DraftRow>('SELECT unit_id, generation, digest, writes, recorded_at, retracted_at FROM fill_unit_draft WHERE unit_id = $1 AND generation = $2', [unitId, generation]);
  if (rows[0] === undefined) return null;
  const [whole] = await withDraftParts(executor, [rows[0]]);
  return draftRecord(whole as DraftRow);
}

/**
 * How many writes one part of a draft set holds: a part is one statement's
 * parameter and one jsonb value, and a few hundred writes keep both a few hundred
 * kilobytes however large the unit's set is.
 */
export const DRAFT_PART_WRITES = 500;

/** The `writes` a draft row holds itself: none — its writes are its parts (`fill_unit_draft_part`). */
const EMPTY_WRITES = '[]';

/**
 * What a publication's transaction is: one snapshot, from its first statement to
 * its commit. A publication rechecks the tracked reads its unit was planned on
 * (`fill-orchestrator/staleness`), and a read is asked a page at a time
 * (`READ_PAGE_ROWS`), so at the READ COMMITTED level the owner's write
 * transaction opens at, a fact another unit committed between two pages of one
 * read would stand outside the recheck's answer while the recorded membership
 * still matched — a publication on a graph that moved. The statement is issued
 * before anything else runs in that transaction, which is the only moment
 * PostgreSQL accepts a transaction's isolation level being set.
 */
export const PUBLICATION_SNAPSHOT = 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ';

/**
 * Draft rows with their whole set of writes: the row's own `writes` (a row
 * recorded before the parts existed holds them there) followed by its parts in
 * order. Every reader of a draft set's writes reads them through this, in the
 * transaction it holds; the parts are asked for in one statement per call.
 */
export async function withDraftParts<R extends { readonly unit_id: unknown; readonly generation: unknown; readonly writes: unknown }>(
  executor: SqlExecutor,
  rows: readonly R[],
): Promise<readonly R[]> {
  if (rows.length === 0) return rows;
  const { rows: parts } = await executor.query<{ unit_id: string; generation: unknown; writes: unknown }>(
    `SELECT p.unit_id, p.generation, p.writes
       FROM fill_unit_draft_part p
       JOIN unnest($1::text[], $2::integer[]) AS k(unit_id, generation) ON k.unit_id = p.unit_id AND k.generation = p.generation
      ORDER BY p.unit_id, p.generation, p.part`,
    [rows.map((row) => String(row.unit_id)), rows.map((row) => Number(row.generation))],
  );
  const byKey = new Map<string, unknown[]>();
  for (const part of parts) {
    const key = `${part.unit_id}\u0000${String(Number(part.generation))}`;
    const writes = typeof part.writes === 'string' ? JSON.parse(part.writes) : part.writes;
    if (!Array.isArray(writes)) raise(`table fill_unit_draft_part, row ${part.unit_id}/${String(part.generation)}: the writes are not a list`);
    const held = byKey.get(key) ?? [];
    for (const write of writes) held.push(write);
    byKey.set(key, held);
  }
  return rows.map((row) => {
    const extra = byKey.get(`${String(row.unit_id)}\u0000${String(Number(row.generation))}`);
    if (extra === undefined) return row;
    const own = typeof row.writes === 'string' ? JSON.parse(row.writes) : row.writes;
    return { ...row, writes: Array.isArray(own) ? [...own, ...extra] : own };
  });
}

/** What a draft set is judged by, without its writes: the digest, and when it was recorded and retracted. */
export interface DraftHead {
  readonly unitId: string;
  readonly generation: number;
  readonly digest: string;
  readonly recordedAt: number;
  readonly retractedAt: number | null;
}

interface DraftHeadRow extends Record<string, unknown> { unit_id: string; generation: unknown; digest: string; recorded_at: unknown; retracted_at: unknown }

/**
 * The head of one unit generation's draft set inside a transaction the caller
 * already opened, or null when it holds none: its digest and its times, and not
 * its writes. A publication judges a draft by its digest; reading a whole unit's
 * fact set back as JSON to learn it is the copy madarch-tzte.21.11 measured as
 * the largest allocation of a repository-wide unit's publication.
 */
export async function readUnitDraftHeadIn(executor: SqlExecutor, unitId: string, generation: number): Promise<DraftHead | null> {
  const { rows } = await executor.query<DraftHeadRow>('SELECT unit_id, generation, digest, recorded_at, retracted_at FROM fill_unit_draft WHERE unit_id = $1 AND generation = $2', [unitId, generation]);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    unitId: row.unit_id,
    generation: millis(row.generation),
    digest: row.digest,
    recordedAt: millis(row.recorded_at),
    retractedAt: row.retracted_at === null || row.retracted_at === undefined ? null : millis(row.retracted_at),
  };
}

/** The head of one unit generation's draft set (`readUnitDraftHeadIn`), in a snapshot of its own. */
export async function readUnitDraftHead(database: OrchestratorDatabase, unitId: string, generation: number): Promise<DraftHead | null> {
  const at = here();
  return run(at, database, `readUnitDraftHead(${unitId}/${generation})`, ['fill_unit_draft'], async (executor) => readUnitDraftHeadIn(executor, unitId, generation), 'snapshot');
}

/**
 * Retracts a unit generation's draft set: the row stays as the record of what
 * was written, and `retracted_at` marks it unpublished, so a rerun starts clean
 * and a publication refuses a draft that was retracted after it was validated.
 * It answers the set's head, never its writes: a repository-wide unit's set is
 * tens of megabytes, and a retraction changes nothing of what it holds.
 */
export async function retractUnitDraft(database: OrchestratorDatabase, options: { readonly unitId: string; readonly generation: number; readonly at: number }): Promise<DraftHead | null> {
  const at = here();
  return run(at, database, `retractUnitDraft(${options.unitId}/${options.generation})`, ['fill_unit_draft'], async (executor) => retractUnitDraftIn(executor, options), 'write');
}

/**
 * Retracts one unit generation's draft inside a transaction the caller already
 * opened, and answers its head. Nothing of the set's writes is read back: the
 * row and its parts stay as the record of what was written, every caller of this
 * retraction discards what the set held, and reading it back parsed the whole
 * set — up to 34 MB for the modules stage's repository-wide unit — at the run's
 * memory peak (madarch-tzte.21.11, the review of its publication path).
 */
export async function retractUnitDraftIn(executor: SqlExecutor, options: { readonly unitId: string; readonly generation: number; readonly at: number }): Promise<DraftHead | null> {
  await executor.query('UPDATE fill_unit_draft SET retracted_at = COALESCE(retracted_at, $3) WHERE unit_id = $1 AND generation = $2', [options.unitId, options.generation, options.at]);
  return await readUnitDraftHeadIn(executor, options.unitId, options.generation);
}

/** One sealed child of a split, as the parent's join reads it. */
export interface SealedChild {
  readonly unitId: string;
  readonly generation: number;
  readonly sealedAt: number;
}

interface SplitRow extends Record<string, unknown> { parent_unit_id: string; parent_generation: unknown; child_unit_id: string; child_generation: unknown; sealed_at: unknown }

/**
 * Seals the child set of a split inside the caller's transaction: the parent's
 * checkpoint and every child generation land together or not at all (decision
 * 0027, "splits atomically persist the parent's checkpoint and a sealed child
 * set").
 */
export async function sealSplitIn(
  executor: SqlExecutor,
  options: { readonly parentUnitId: string; readonly parentGeneration: number; readonly children: readonly { readonly unitId: string; readonly generation: number }[]; readonly at: number },
): Promise<readonly SealedChild[]> {
  for (const child of options.children) {
    await executor.query(
      `INSERT INTO fill_unit_split (parent_unit_id, parent_generation, child_unit_id, child_generation, sealed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (parent_unit_id, parent_generation, child_unit_id) DO UPDATE SET child_generation = EXCLUDED.child_generation, sealed_at = EXCLUDED.sealed_at`,
      [options.parentUnitId, options.parentGeneration, child.unitId, child.generation, options.at],
    );
  }
  return options.children.map((child) => ({ unitId: child.unitId, generation: child.generation, sealedAt: options.at }));
}

/** The child set one parent generation sealed, in code point order of the unit ids. */
export async function readSealedChildren(database: OrchestratorDatabase, parentUnitId: string, parentGeneration: number): Promise<readonly SealedChild[]> {
  const at = here();
  return run(at, database, `readSealedChildren(${parentUnitId}/${parentGeneration})`, ['fill_unit_split'], async (executor) => {
    const { rows } = await executor.query<SplitRow>(
      'SELECT parent_unit_id, parent_generation, child_unit_id, child_generation, sealed_at FROM fill_unit_split WHERE parent_unit_id = $1 AND parent_generation = $2 ORDER BY child_unit_id ASC',
      [parentUnitId, parentGeneration],
    );
    return rows
      .map((row) => ({ unitId: row.child_unit_id, generation: millis(row.child_generation), sealedAt: millis(row.sealed_at) }))
      .sort((left, right) => byCodePoint(left.unitId, right.unitId));
  }, 'snapshot');
}

/**
 * The splits one child generation belongs to, in code point order of the
 * parent's unit id: a split tree is walked upwards from a child by these rows,
 * which is how the orchestrator measures how deep a nested split already is.
 */
export async function readSplitParents(database: OrchestratorDatabase, unitId: string, generation: number): Promise<readonly SealedChild[]> {
  const at = here();
  return run(at, database, `readSplitParents(${unitId}/${generation})`, ['fill_unit_split'], async (executor) => {
    const { rows } = await executor.query<SplitRow>(
      'SELECT parent_unit_id, parent_generation, child_unit_id, child_generation, sealed_at FROM fill_unit_split WHERE child_unit_id = $1 AND child_generation = $2',
      [unitId, generation],
    );
    return rows.map((row) => ({ unitId: row.parent_unit_id, generation: millis(row.parent_generation), sealedAt: millis(row.sealed_at) }))
      .sort((left, right) => byCodePoint(left.unitId, right.unitId));
  }, 'snapshot');
}

/** One generation's publication record: the one row that says it was published, and what it published. */
export interface PublicationRecord {
  readonly unitId: string;
  readonly generation: number;
  readonly digest: string;
  /** How many facts the publication applied within the unit's ownership scope. */
  readonly facts: number;
  readonly publishedAt: number;
}

interface PublicationRow extends Record<string, unknown> { unit_id: string; generation: unknown; digest: string; facts: unknown; published_at: unknown }

function publicationRecord(row: PublicationRow): PublicationRecord {
  return { unitId: row.unit_id, generation: millis(row.generation), digest: row.digest, facts: millis(row.facts), publishedAt: millis(row.published_at) };
}

/**
 * The identity of what one publication publishes: the inputs the generation
 * recorded and the draft set it wrote, with the stage module's id and version.
 * A rerun under a newer stage module is therefore a different publication of the
 * same generation, which the unique record refuses rather than overwriting.
 */
export function publicationDigest(input: {
  readonly inputsDigest: string;
  readonly draft: string;
  readonly stageId: string;
  readonly stageVersion: number;
}): string {
  return canonicalJsonDigest({ inputs: input.inputsDigest, draft: input.draft, stage: { id: input.stageId, version: input.stageVersion } });
}

/** What one publication answered. */
export type PublicationOutcome =
  | { readonly outcome: 'published'; readonly record: PublicationRecord; readonly effects: readonly string[] }
  /** The same identity and the same digest were published before: the existing result, and nothing written. */
  | { readonly outcome: 'replayed'; readonly record: PublicationRecord }
  | { readonly outcome: 'refused'; readonly code: string; readonly reason: string; readonly record: PublicationRecord | null };

/** One publication request: the generation, the fence, what identifies it and how its facts are applied. */
export interface PublicationRequest {
  readonly unitId: string;
  readonly generation: number;
  readonly fence: number;
  /**
   * What the publication publishes, beside the draft set it reads inside the
   * transaction: the inputs the generation recorded and the stage module's id
   * and version. A rerun under a newer stage module is therefore a different
   * publication of the same generation, which the unique record refuses rather
   * than overwriting.
   */
  readonly identity: {
    readonly inputsDigest: string;
    readonly stageId: string;
    readonly stageVersion: number;
  };
  readonly at: number;
  /**
   * Rechecks one recorded read against the graph as it stands now: the digest of
   * the rows it answers and how many they are. A read whose membership moved
   * refuses the publication, rather than publishing facts the graph no longer
   * supports.
   */
  readonly revalidate: (read: TrackedRead, executor: SqlExecutor) => Promise<{ readonly membership: string; readonly members: number }>;
  /**
   * Applies the unit's fact set within its ownership scope, inside this same
   * transaction, and answers how many facts it applied. It runs after the
   * generation entered `published` in this transaction and before the
   * publication record is written, so a failure here — or the record's own
   * refusal — rolls back the facts, the state and the record together. The
   * database owner is the only writer; this callback is where the facts reach it.
   * It is given the digest this transaction computed, which is the one the record
   * will carry, so a caller marks what it applied with the same identity the
   * publication has.
   */
  readonly apply: (executor: SqlExecutor, writes: readonly StageDraftWrite[], digest: string) => Promise<number>;
  /**
   * The draft set the caller recorded for this generation and still holds, with
   * the digest its record answered (`recordUnitDraft`). When that digest is the
   * one the draft row carries in this transaction, these are the writes the row
   * holds, and the publication applies them rather than reading the row's JSON
   * back: a repository-wide unit's draft is tens of megabytes of JSON, and its
   * second copy, parsed in the middle of the publication, is what pushed the
   * modules stage's unit over a 4 GB pod (madarch-tzte.21.11). A digest that
   * differs — another attempt recorded a draft since — is not trusted, and the
   * row's own writes are read.
   */
  readonly held?: { readonly digest: string; readonly writes: readonly StageDraftWrite[] };
}

/**
 * Publishes one unit generation exactly once, in one transaction of the
 * caller's: the checks decision 0027 names (the generation and the fence as the
 * machine holds them, the run's control and its cancellation intent), the
 * recorded reads rechecked, the machine's own `publish` step, the facts applied
 * through `apply`, and the uniquely constrained record. A repeated request with
 * the same identity and digest answers the existing record; a different digest
 * is refused and nothing is written.
 */
export async function publishUnit(
  database: OrchestratorDatabase,
  options: PublicationRequest,
): Promise<PublicationOutcome> {
  const at = here();
  return run(at, database, `publishUnit(${options.unitId}/${options.generation})`, ['fill_publication', 'fill_unit_read', 'fill_unit_draft', 'fill_unit_draft_part', 'fill_unit', 'fill_unit_generation', 'fill_unit_lease', 'fill_run', 'fill_transition'], async (executor) => publishUnitIn(executor, options), 'write');
}

/** The statement that reads the run's control of one generation's unit; `share` takes the run row's lock. */
const controlSql = (share: boolean): string => `SELECT r.state AS state FROM fill_run r JOIN fill_unit_generation g ON g.run_id = r.run_id WHERE g.unit_id = $1 AND g.generation = $2${share ? ' FOR SHARE OF r' : ''}`;

/** The refusal a run state that revoked authority answers with, or null while the run's authority stands. */
function revokedAuthority(unitId: string, generation: number, runState: string | undefined): PublicationOutcome | null {
  if (runState === undefined) {
    return {
      outcome: 'refused',
      code: 'fill-publication/no-run',
      reason: `fill-publication: unit "${unitId}" generation ${generation} names a run that is not in fill_run, so nothing says whether its authority stands`,
      record: null,
    };
  }
  if (runState === 'cancelling' || runState === 'cancelled' || runState === 'failed') {
    return {
      outcome: 'refused',
      code: 'fill-publication/authority-revoked',
      reason: `fill-publication: the run of unit "${unitId}" generation ${generation} is ${runState}, which revoked the authority of the units it planned, so this generation publishes nothing`,
      record: null,
    };
  }
  return null;
}

/**
 * Publishes one unit generation inside a transaction the caller already opened.
 * The order is the decision's own: the generation's identity, the run's control,
 * the reads the draft stands on, the run's control again, the machine's `publish`
 * step — which takes the generation's row `FOR UPDATE`, so two publishers of one
 * generation are serialized here — the facts, and the record. A step the machine
 * refuses is a value, and it is answered before anything is applied or written.
 */
export async function publishUnitIn(executor: SqlExecutor, options: PublicationRequest): Promise<PublicationOutcome> {
  // One snapshot for the whole publication, set before any statement of it runs: the rechecks below read
  // each tracked read again, and a read is asked a page at a time (`READ_PAGE_ROWS`), so at the READ
  // COMMITTED level every caller's write transaction opens at, a fact another unit committed between two
  // pages of one read would stand outside the recheck's answer while the recorded membership still
  // matched. It is the first statement of the transaction, which is the only moment PostgreSQL accepts a
  // level being set.
  await executor.query(PUBLICATION_SNAPSHOT);

  // The run's own control, inside the same transaction and under the run row's share lock: a run that is
  // cancelling or cancelled revokes the authority of everything it planned, and a failed run publishes
  // nothing. The lock is what makes the check hold for the whole transaction rather than for one instant:
  // a cancellation's own write of the run's state waits for this publication to end, so an intent that
  // lands while a publication is under way is refused here instead of racing it. A pause drains, so a
  // publication already under way is allowed to finish — the pause's settlement waits for it.
  const control = await executor.query<{ state: string }>(controlSql(true), [options.unitId, options.generation]);
  const refusedControl = revokedAuthority(options.unitId, options.generation, control.rows[0]?.state);
  if (refusedControl !== null) return refusedControl;

  // What this request would publish: the draft set as it stands in the same transaction, judged by its
  // digest; its writes are read only when they are applied, and only when the caller does not hold them.
  const draft = await readUnitDraftHeadIn(executor, options.unitId, options.generation);
  if (draft === null) {
    return {
      outcome: 'refused',
      code: 'fill-publication/no-draft',
      reason: `fill-publication: unit "${options.unitId}" generation ${options.generation} has no recorded draft set to publish`,
      record: null,
    };
  }
  const digest = publicationDigest({
    inputsDigest: options.identity.inputsDigest,
    draft: draft.digest,
    stageId: options.identity.stageId,
    stageVersion: options.identity.stageVersion,
  });

  const existing = await readPublicationIn(executor, options.unitId, options.generation);
  if (existing !== null) {
    if (existing.digest !== digest) {
      return {
        outcome: 'refused',
        code: 'fill-publication/digest-mismatch',
        reason: `fill-publication: unit "${options.unitId}" generation ${options.generation} was already published as ${existing.digest}, and this request publishes ${digest}: one generation has one publication, and a different one would replace what was published`,
        record: existing,
      };
    }
    return { outcome: 'replayed', record: existing };
  }
  if (draft.retractedAt !== null) {
    return {
      outcome: 'refused',
      code: 'fill-publication/no-draft',
      reason: `fill-publication: the draft set of unit "${options.unitId}" generation ${options.generation} was retracted at ${draft.retractedAt}; a retracted draft is not published`,
      record: null,
    };
  }

  // Every recorded read, rechecked as it stands now. An empty answer that became
  // a non-empty one refuses here like any other moved membership.
  for (const read of await readUnitReadsIn(executor, options.unitId, options.generation)) {
    const now = await options.revalidate(read, executor);
    if (now.membership !== read.membership) {
      return {
        outcome: 'refused',
        code: 'fill-publication/reads-stale',
        reason: `fill-publication: unit "${options.unitId}" generation ${options.generation} read "${read.query}" and it answered ${read.members} ${read.members === 1 ? 'row' : 'rows'} (${read.membership}), which is now ${now.members} (${now.membership}); the facts this publication would write stand on a graph that moved`,
        record: null,
      };
    }
  }

  // The run's control once more, after the reads were rechecked and before anything is written: this
  // reads the row the share lock above was taken on, inside the transaction's one snapshot, so it answers
  // what the first read answered. It is kept as the statement that says so — an intent that reached the
  // run's row before this transaction took the snapshot is refused by the first read, and one that comes
  // after it waits on the share lock and lands once this publication has ended.
  const rechecked = await executor.query<{ state: string }>(controlSql(false), [options.unitId, options.generation]);
  const refusedSince = revokedAuthority(options.unitId, options.generation, rechecked.rows[0]?.state);
  if (refusedSince !== null) return refusedSince;

  // The machine's own step first, then the facts, then the record: a refusal here writes nothing at all,
  // and a failure of the facts rolls the step back with them.
  const step = await advanceUnitIn(executor, {
    unitId: options.unitId,
    event: { type: 'publish', at: options.at, generation: options.generation, fence: options.fence, readsFresh: true },
  });
  if (!step.ok) {
    return { outcome: 'refused', code: step.refusal.code, reason: step.refusal.reason, record: null };
  }
  const writes = options.held !== undefined && options.held.digest === draft.digest
    ? options.held.writes
    : (await readUnitDraftIn(executor, options.unitId, options.generation))?.writes ?? raise(`fill-publication: the draft set of unit "${options.unitId}" generation ${options.generation} was read for its digest and is gone when its writes are read, inside one transaction`);
  const facts = await options.apply(executor, writes, digest);
  await executor.query(
    'INSERT INTO fill_publication (unit_id, generation, digest, facts, published_at) VALUES ($1, $2, $3, $4, $5)',
    [options.unitId, options.generation, digest, facts, options.at],
  );
  // A publication does not keep both copies of what it published (madarch-tzte.21.11): the facts are
  // `fill_fact_holding`'s rows for this unit and generation, and the draft set's `writes` was their input.
  // The row stays — its digest is what a repeated request for this generation is judged by, so a replay
  // still answers the existing record — and its JSON, a whole unit's fact set written twice, goes: the
  // walk over the current madarch tree measured those copies at 43 MB of a 379 MB store.
  await executor.query('UPDATE fill_unit_draft SET writes = $3::jsonb WHERE unit_id = $1 AND generation = $2', [options.unitId, options.generation, PUBLISHED_DRAFT_WRITES]);
  await executor.query('DELETE FROM fill_unit_draft_part WHERE unit_id = $1 AND generation = $2', [options.unitId, options.generation]);
  return {
    outcome: 'published',
    record: { unitId: options.unitId, generation: options.generation, digest, facts, publishedAt: options.at },
    effects: step.effects,
  };
}

/** One generation's publication record, or null when it was never published. */
export async function readPublication(database: OrchestratorDatabase, unitId: string, generation: number): Promise<PublicationRecord | null> {
  const at = here();
  return run(at, database, `readPublication(${unitId}/${generation})`, ['fill_publication'], async (executor) => readPublicationIn(executor, unitId, generation), 'snapshot');
}

/** One generation's publication record inside a transaction the caller already opened. */
export async function readPublicationIn(executor: SqlExecutor, unitId: string, generation: number): Promise<PublicationRecord | null> {
  const { rows } = await executor.query<PublicationRow>('SELECT unit_id, generation, digest, facts, published_at FROM fill_publication WHERE unit_id = $1 AND generation = $2', [unitId, generation]);
  return rows[0] === undefined ? null : publicationRecord(rows[0]);
}

/** Every publication of one unit, oldest generation first: the record of what it published and when. */
export async function readPublications(database: OrchestratorDatabase, unitId: string): Promise<readonly PublicationRecord[]> {
  const at = here();
  return run(at, database, `readPublications(${unitId})`, ['fill_publication'], async (executor) => {
    const { rows } = await executor.query<PublicationRow>('SELECT unit_id, generation, digest, facts, published_at FROM fill_publication WHERE unit_id = $1 ORDER BY generation ASC', [unitId]);
    return rows.map(publicationRecord);
  }, 'snapshot');
}

/** Every tracked read of one generation inside a transaction the caller already opened. */
async function readUnitReadsIn(executor: SqlExecutor, unitId: string, generation: number): Promise<readonly TrackedRead[]> {
  const { rows } = await executor.query<ReadRow>(
    'SELECT unit_id, generation, query_digest, query, membership, members, read_seq, at FROM fill_unit_read WHERE unit_id = $1 AND generation = $2 ORDER BY read_seq ASC',
    [unitId, generation],
  );
  return rows.map(readRecord);
}

/** The unit a publication is about, for a caller that wants the row it stepped: exported for the orchestrator's own use. */
export type { UnitRecord };

// ---------------------------------------------------------------------------------------------
// The run's snapshot and its units' place in the plan
// ---------------------------------------------------------------------------------------------

/**
 * The pinned product snapshot one run was planned against: fill-runtime's own
 * `productSnapshot` shape, kept by decision 0027 rather than written again here,
 * so the old path and the orchestrator name one snapshot the same way.
 */
export type RunSnapshot = FillRun['productSnapshot'];

/** One run's resolved configuration: the pinned snapshot and the digest of the stage configurations it planned with. */
export interface RunConfigurationRecord {
  readonly runId: string;
  /** The digest `snapshotStageConfigurations` answers for the resolved stages: what the run planned with. */
  readonly digest: string;
  readonly snapshot: RunSnapshot;
  readonly recordedAt: number;
}

interface RunConfigurationRow extends Record<string, unknown> { run_id: string; digest: string; snapshot: unknown; recorded_at: unknown }

/**
 * Records what one run resolved: the pinned product snapshot (decision 0027's
 * "each run snapshots its resolved configuration and stage versions") and the
 * digest of the resolved stage configurations. A run already recorded keeps its
 * own record: a resume plans the same snapshot, and a second record would say
 * the run planned against two products.
 */
export async function recordRunConfiguration(
  database: OrchestratorDatabase,
  options: { readonly runId: string; readonly digest: string; readonly snapshot: RunSnapshot; readonly at: number },
): Promise<RunConfigurationRecord> {
  const at = here();
  return run(at, database, `recordRunConfiguration(${options.runId})`, ['fill_run_configuration'], async (executor) => {
    await executor.query(
      'INSERT INTO fill_run_configuration (run_id, digest, snapshot, recorded_at) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (run_id) DO NOTHING',
      [options.runId, options.digest, json(options.snapshot), options.at],
    );
    const { rows } = await executor.query<RunConfigurationRow>('SELECT run_id, digest, snapshot, recorded_at FROM fill_run_configuration WHERE run_id = $1', [options.runId]);
    const row = rows[0];
    if (row === undefined) raise(`table fill_run_configuration: no configuration for run ${options.runId} after writing it`);
    const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) as RunSnapshot : row.snapshot as RunSnapshot;
    return { runId: row.run_id, digest: row.digest, snapshot, recordedAt: millis(row.recorded_at) };
  }, 'write');
}

/** One run's recorded snapshot and configuration digest, or null when the run never planned. */
export async function readRunConfiguration(database: OrchestratorDatabase, runId: string): Promise<RunConfigurationRecord | null> {
  const at = here();
  return run(at, database, `readRunConfiguration(${runId})`, ['fill_run_configuration'], async (executor) => {
    const { rows } = await executor.query<RunConfigurationRow>('SELECT run_id, digest, snapshot, recorded_at FROM fill_run_configuration WHERE run_id = $1', [runId]);
    const row = rows[0];
    if (row === undefined) return null;
    const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) as RunSnapshot : row.snapshot as RunSnapshot;
    return { runId: row.run_id, digest: row.digest, snapshot, recordedAt: millis(row.recorded_at) };
  }, 'snapshot');
}

/** One stage of one run that has planned, as the run's own record holds it. */
export interface RunStageRecord {
  readonly runId: string;
  readonly stageId: string;
  /** When the stage's latest planning attempt stood. */
  readonly plannedAt: number;
  /** How many units the stage's latest attempt named. */
  readonly units: number;
  /**
   * How many publications the run had made when the attempt stood: the
   * watermark a re-planning reads the run's publications against
   * (madarch-tzte.26.3).
   */
  readonly publications: number;
}

/**
 * Records one planning attempt of one stage of one run (madarch-tzte.26.3):
 * when it stood, how many units it named, and how many publications the run
 * had made by then. A stage that planned no unit may be planned again once the
 * run has published past its attempt what a producer of its inputs makes — the
 * watermark is what that re-planning reads, and what keeps it from planning
 * the same stage twice without a publication between.
 */
export async function recordRunStagePlanned(
  database: OrchestratorDatabase,
  options: { readonly runId: string; readonly stageId: string; readonly units: number; readonly publications: number; readonly at: number },
): Promise<RunStageRecord> {
  const at = here();
  return run(at, database, `recordRunStagePlanned(${options.runId}/${options.stageId})`, ['fill_run_stage'], async (executor) => {
    await executor.query(
      `INSERT INTO fill_run_stage (run_id, stage_id, planned_at, units, publications) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (run_id, stage_id) DO UPDATE SET planned_at = EXCLUDED.planned_at, units = EXCLUDED.units, publications = EXCLUDED.publications`,
      [options.runId, options.stageId, options.at, options.units, options.publications],
    );
    return { runId: options.runId, stageId: options.stageId, plannedAt: options.at, units: options.units, publications: options.publications };
  }, 'write');
}

/** Every stage of one run that has planned, in code point order of the stage ids. */
export async function readRunStagePlans(database: OrchestratorDatabase, runId: string): Promise<readonly RunStageRecord[]> {
  const at = here();
  return run(at, database, `readRunStagePlans(${runId})`, ['fill_run_stage'], async (executor) => {
    const { rows } = await executor.query<{ stage_id: string; planned_at: unknown; units: unknown; publications: unknown }>(
      'SELECT stage_id, planned_at, units, publications FROM fill_run_stage WHERE run_id = $1 ORDER BY stage_id',
      [runId],
    );
    return rows.map((row) => ({ runId, stageId: row.stage_id, plannedAt: millis(row.planned_at), units: millis(row.units), publications: millis(row.publications) }));
  }, 'snapshot');
}

/** One stage's publications in one run, by their count. */
export interface RunPublicationStage {
  readonly stageId: string;
  readonly publications: number;
}

/**
 * The stages whose units published in one run, each with its publication count
 * (madarch-tzte.26.3): what a stage that planned no unit is re-planned against
 * — a producer that published since the stage's attempt is a producer whose
 * facts its plan may not have read.
 */
export async function readRunPublicationStages(database: OrchestratorDatabase, runId: string): Promise<readonly RunPublicationStage[]> {
  const at = here();
  return run(at, database, `readRunPublicationStages(${runId})`, ['fill_publication'], async (executor) => {
    const { rows } = await executor.query<{ stage_id: string; publications: unknown }>(
      `SELECT u.stage_id AS stage_id, COUNT(*) AS publications
         FROM fill_publication p
         JOIN fill_unit_generation g ON g.unit_id = p.unit_id AND g.generation = p.generation AND g.run_id = $1
         JOIN fill_unit u ON u.unit_id = p.unit_id
        GROUP BY u.stage_id`,
      [runId],
    );
    return rows.map((row) => ({ stageId: row.stage_id, publications: millis(row.publications) }));
  }, 'snapshot');
}

/** How many publications one run has made so far. */
export async function readRunPublicationCount(database: OrchestratorDatabase, runId: string): Promise<number> {
  const at = here();
  return run(at, database, `readRunPublicationCount(${runId})`, ['fill_publication'], async (executor) => {
    const { rows } = await executor.query<{ publications: unknown }>(
      `SELECT COUNT(*) AS publications FROM fill_publication p
         JOIN fill_unit_generation g ON g.unit_id = p.unit_id AND g.generation = p.generation AND g.run_id = $1`,
      [runId],
    );
    return millis(rows[0]?.publications ?? 0);
  }, 'snapshot');
}

/**
 * One unit generation's place in the plan that created it: which stage it
 * belongs to, where that stage stands in the derived order, where the stage's
 * plan named it, and when it was planned. Admission reads the first two as the
 * importance decision 0027 admits by and the last as the base its ageing is
 * counted from.
 */
export interface UnitPlanRecord {
  readonly unitId: string;
  readonly generation: number;
  readonly runId: string;
  /** The stage the unit belongs to, as the registry names it. */
  readonly stageId: string;
  /** The unit's own id in that stage's plan: the stage's vocabulary, never the store's namespaced id. */
  readonly stageUnitId: string;
  /** What the unit covers, in the graph's own terms, as the plan named it. */
  readonly scope: string;
  /** Where the stage stands in the run's derived order; a lower number plans earlier. */
  readonly stagePosition: number;
  /** Where the stage's own plan named this unit, most important first (the PageRank-like importance). */
  readonly planPosition: number;
  readonly plannedAt: number;
  /**
   * The versions the unit's cache key held when it was planned: the stage's `id@version` and its own prompt,
   * answer-schema and model versions (`stageCacheVersions`). Absent for a plan row a build before this recorded
   * none, which a run reports as an unknown version rather than as an unchanged one.
   */
  readonly cacheVersions?: Readonly<Record<string, string>>;
}

interface UnitPlanRow extends Record<string, unknown> { unit_id: string; generation: unknown; run_id: string; stage_id: string; stage_unit_id: string; scope: string; stage_position: unknown; plan_position: unknown; planned_at: unknown; cache_versions?: unknown }

function unitPlanRecord(row: UnitPlanRow): UnitPlanRecord {
  return {
    unitId: row.unit_id,
    generation: millis(row.generation),
    runId: row.run_id,
    stageId: row.stage_id,
    stageUnitId: row.stage_unit_id,
    scope: row.scope,
    stagePosition: millis(row.stage_position),
    planPosition: millis(row.plan_position),
    plannedAt: millis(row.planned_at),
    ...(row.cache_versions === null || row.cache_versions === undefined ? {} : { cacheVersions: (typeof row.cache_versions === 'string' ? JSON.parse(row.cache_versions) : row.cache_versions) as Record<string, string> }),
  };
}

/** Records where a planned unit stands, inside a transaction the caller already opened. */
export interface UnitPlanOptions {
  readonly unitId: string;
  readonly generation: number;
  readonly runId: string;
  readonly stageId: string;
  readonly stageUnitId: string;
  readonly scope: string;
  readonly stagePosition: number;
  readonly planPosition: number;
  readonly at: number;
  /** The versions the unit's cache key holds at this planning (`stageCacheVersions`), recorded with the plan. */
  readonly cacheVersions?: Readonly<Record<string, string>>;
}

export async function recordUnitPlanIn(executor: SqlExecutor, options: UnitPlanOptions): Promise<UnitPlanRecord> {
  await executor.query(
    `INSERT INTO fill_unit_plan (unit_id, generation, run_id, stage_id, stage_unit_id, scope, stage_position, plan_position, planned_at, cache_versions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (unit_id, generation) DO UPDATE
       SET run_id = EXCLUDED.run_id, stage_id = EXCLUDED.stage_id, stage_unit_id = EXCLUDED.stage_unit_id,
           scope = EXCLUDED.scope, stage_position = EXCLUDED.stage_position, plan_position = EXCLUDED.plan_position,
           planned_at = EXCLUDED.planned_at, cache_versions = EXCLUDED.cache_versions`,
    [options.unitId, options.generation, options.runId, options.stageId, options.stageUnitId, options.scope, options.stagePosition, options.planPosition, options.at,
      options.cacheVersions === undefined ? null : json(options.cacheVersions)],
  );
  return { ...options, plannedAt: options.at };
}

/** Records where a planned unit stands, in its own transaction of the owner. */
export async function recordUnitPlan(database: OrchestratorDatabase, options: UnitPlanOptions): Promise<UnitPlanRecord> {
  const at = here();
  return run(at, database, `recordUnitPlan(${options.unitId}/${options.generation})`, ['fill_unit_plan'], async (executor) => recordUnitPlanIn(executor, options), 'write');
}

/** One unit generation's recorded plan, or null when it holds none. */
export async function readUnitPlan(database: OrchestratorDatabase, unitId: string, generation: number): Promise<UnitPlanRecord | null> {
  const at = here();
  return run(at, database, `readUnitPlan(${unitId}/${generation})`, ['fill_unit_plan'], async (executor) => {
    const { rows } = await executor.query<UnitPlanRow>('SELECT unit_id, generation, run_id, stage_id, stage_unit_id, scope, stage_position, plan_position, planned_at, cache_versions FROM fill_unit_plan WHERE unit_id = $1 AND generation = $2', [unitId, generation]);
    return rows[0] === undefined ? null : unitPlanRecord(rows[0]);
  }, 'snapshot');
}

/** Every unit of one run with the place in the plan it was created at, in code point order of the unit ids. */
export async function readRunPlans(database: OrchestratorDatabase, runId: string): Promise<readonly UnitPlanRecord[]> {
  const at = here();
  return run(at, database, `readRunPlans(${runId})`, ['fill_unit_plan'], async (executor) => {
    // The generation in force only: a unit replaced inside one run has two plan rows, and the one the
    // run works is the one its own unit row names. The join also fixes the order the ids are read in.
    const { rows } = await executor.query<UnitPlanRow>(
      `SELECT p.unit_id, p.generation, p.run_id, p.stage_id, p.stage_unit_id, p.scope, p.stage_position, p.plan_position, p.planned_at, p.cache_versions
         FROM fill_unit_plan p JOIN fill_unit u ON u.unit_id = p.unit_id AND u.generation = p.generation
        WHERE p.run_id = $1`,
      [runId],
    );
    return rows.map(unitPlanRecord).sort((left, right) => byCodePoint(left.unitId, right.unitId));
  }, 'snapshot');
}

// ---------------------------------------------------------------------------------------------
// The durable progress events a watching person sees
// ---------------------------------------------------------------------------------------------

/** One normalized progress event, the shape fill-runtime's `FillEvent` keeps, persisted in the database. */
export interface FillProgressEvent {
  readonly runId: string;
  /** The event's own sequence within its run, from 1: a reader follows a run by it. */
  readonly seq: number;
  readonly at: number;
  /** The registry's stage id, or `''` for an event about the run itself. */
  readonly stage: string;
  /** The unit the event is about, or `''` for an event about the run or a stage. */
  readonly unitId: string;
  readonly generation: number | null;
  readonly kind: ProgressKind;
  readonly summary: string;
}

/** Every kind of progress event the orchestrator emits; the vocabulary the live view reads. */
export const PROGRESS_KINDS = [
  'run-planned', 'run-started', 'run-blocked', 'run-paused', 'run-resumed', 'run-cancelling', 'run-cancelled',
  'run-completed', 'run-completed-partial', 'run-failed', 'run-replanned', 'run-refused',
  'stage-found-nothing', 'stage-planned',
  'unit-planned', 'unit-admitted', 'unit-leased', 'unit-started', 'unit-read', 'unit-progress', 'unit-drafted', 'unit-validating',
  'unit-published', 'unit-split', 'unit-joined', 'unit-blocked', 'unit-unblocked', 'unit-retried', 'unit-failed',
  'unit-stale', 'unit-cancelled', 'unit-requeued', 'unit-refused',
] as const;
export type ProgressKind = (typeof PROGRESS_KINDS)[number];

interface EventRow extends Record<string, unknown> { run_id: string; seq: unknown; at: unknown; stage: string; unit_id: string; generation: unknown; kind: string; summary: string }

/**
 * Appends one progress event to its run's own sequence, inside its own short
 * transaction: the sequence is read and taken in the same transaction, so two
 * events of one run never share a number. The event is durable before the
 * caller hears of it, which is what a watching person reads.
 */
export async function appendProgress(database: OrchestratorDatabase, event: Omit<FillProgressEvent, 'seq'>): Promise<FillProgressEvent> {
  const at = here();
  return run(at, database, `appendProgress(${event.runId}, ${event.kind})`, ['fill_event', 'fill_run'], async (executor) => {
    // The run's own row is taken first: two events of one run never share a number, whether the owner
    // serializes its work (PGlite) or overlaps two transactions (a PostgreSQL pool).
    await executor.query('SELECT run_id FROM fill_run WHERE run_id = $1 FOR UPDATE', [event.runId]);
    const { rows } = await executor.query<{ next: unknown }>('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM fill_event WHERE run_id = $1', [event.runId]);
    const seq = millis(rows[0]?.next ?? 1);
    await executor.query(
      'INSERT INTO fill_event (run_id, seq, at, stage, unit_id, generation, kind, summary) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [event.runId, seq, event.at, event.stage, event.unitId, event.generation, event.kind, event.summary],
    );
    return { ...event, seq };
  }, 'write');
}

/** Every progress event of one run, from the first, or the newest `limit` of them. */
export async function readProgress(database: OrchestratorDatabase, runId: string, options: { readonly limit?: number } = {}): Promise<readonly FillProgressEvent[]> {
  const at = here();
  return run(at, database, `readProgress(${runId})`, ['fill_event'], async (executor) => {
    const { rows } = await executor.query<EventRow>(
      'SELECT run_id, seq, at, stage, unit_id, generation, kind, summary FROM fill_event WHERE run_id = $1 ORDER BY seq ASC',
      [runId],
    );
    const events = rows.map((row): FillProgressEvent => ({
      runId: row.run_id,
      seq: millis(row.seq),
      at: millis(row.at),
      stage: row.stage,
      unitId: row.unit_id,
      generation: row.generation === null || row.generation === undefined ? null : millis(row.generation),
      kind: row.kind as ProgressKind,
      summary: row.summary,
    }));
    return options.limit === undefined ? events : events.slice(Math.max(0, events.length - options.limit));
  }, 'snapshot');
}
