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
 * - `fill_unit_split`: the child set a split sealed, so a waiting parent knows
 *   exactly which child generations its join is for.
 * - `fill_publication`: one row per unit generation, uniquely constrained, with
 *   the digest of what it published. A repeated request with the same identity
 *   and digest answers the existing record; a different digest is refused.
 *
 * `publishUnitIn` is the decision's publication as decision 0039 item 13 amends
 * it: one short transaction of the process's one database owner that checks the
 * run's state and the cancellation intent, rechecks every recorded read, applies
 * the unit's writes through the one writer (the caller's `apply`), takes the
 * machine's own `publish` step — the generation enters `published` inside the
 * same transaction — and inserts the publication record. There is no stored
 * draft between the attempt and this transaction: the writes the stage answered
 * are applied here or refused here.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { canonicalJsonDigest } from '../model/canonical.js';
import { byCodePoint } from '../model/order.js';
import type { FillRun } from '../product/fill-runtime.js';
import type { SqlExecutor } from '../sql-driver.js';
import { here, raise, withLocation } from './fsm-core.js';
import { FACT_RANK_FIELDS } from './facts.js';
import { advanceUnitIn, assertRunWritableIn } from './state-store.js';
import type { StageWrite } from './stage.js';
import type { ProducerOutcomeDraft } from './producer-outcomes.js';
import { requireSchema } from '../adapters/store-readiness.js';

/** The orchestrator's own tables, named in operation failures. */
export const ORCHESTRATOR_TABLES = [
  'fill_run_configuration', 'fill_run_stage', 'fill_unit_plan', 'fill_unit_read', 'fill_unit_split', 'fill_publication', 'fill_event', 'fill_end',
] as const;

/** Verifies that store preparation installed the orchestrator schema. */
export async function createOrchestratorSchema(database: OrchestratorDatabase): Promise<void> {
  await requireSchema(database, 'orchestrator');
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
  // Lock separately before allocating a sequence, so a waiter reads the preceding commit.
  await executor.query('SELECT unit_id FROM fill_unit_generation WHERE unit_id = $1 AND generation = $2 FOR UPDATE', [options.unitId, options.generation]);
  return insertUnitReadIn(executor, options);
}

async function insertUnitReadIn(executor: SqlExecutor, options: Parameters<typeof recordUnitReadIn>[1]): Promise<TrackedRead> {
  const digest = queryDigest(options.query);
  // The membership the caller read the answer under, or — where it names none — the digest of the rows as they
  // stand. A span read names its own (`answerMembership`, `graph-reads.ts`): its bytes are its membership, and the
  // commit they were read at is not.
  const membership = options.membership ?? readMembership(options.rows);
  const { rows: recorded } = await executor.query<{ read_seq: unknown }>(
    `INSERT INTO fill_unit_read (unit_id, generation, query_digest, query, membership, members, read_seq, at)
     SELECT $1, $2, $3, $4, $5, $6, COALESCE(MAX(read_seq), 0) + 1, $7
       FROM fill_unit_read WHERE unit_id = $1 AND generation = $2
     ON CONFLICT (unit_id, generation, query_digest) DO UPDATE
       SET query = EXCLUDED.query, membership = EXCLUDED.membership, members = EXCLUDED.members,
           read_seq = EXCLUDED.read_seq, at = EXCLUDED.at
     RETURNING read_seq`,
    [options.unitId, options.generation, digest, options.query, membership, options.rows.length, options.at],
  );
  const seq = millis(recorded[0]!.read_seq);
  return { unitId: options.unitId, generation: options.generation, queryDigest: digest, query: options.query, membership, members: options.rows.length, seq, at: options.at };
}

/** Records concurrent reads of one attempt with one generation lock and commit. */
export async function recordUnitReads(database: OrchestratorDatabase, reads: readonly Parameters<typeof recordUnitReadIn>[1][]): Promise<readonly TrackedRead[]> {
  if (reads.length === 0) return [];
  const first = reads[0]!;
  if (reads.length === 1) return [await recordUnitRead(database, first)];
  if (reads.some((read) => read.unitId !== first.unitId || read.generation !== first.generation)) throw new Error('recordUnitReads requires one unit generation');
  return run(here(), database, `recordUnitReads(${first.unitId}/${first.generation})`, ['fill_unit_read'], async (executor) => {
    await executor.query('SELECT unit_id FROM fill_unit_generation WHERE unit_id = $1 AND generation = $2 FOR UPDATE', [first.unitId, first.generation]);
    const payload = reads.map((read, index) => ({
      ord: index + 1, query_digest: queryDigest(read.query), query: read.query,
      membership: read.membership ?? readMembership(read.rows), members: read.rows.length, at: read.at,
    }));
    const { rows } = await executor.query<{ seq: unknown }>(
      `WITH input AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($3::jsonb)
           AS r(ord integer, query_digest text, query text, membership text, members integer, at bigint)
       ), base AS MATERIALIZED (
         SELECT COALESCE(MAX(read_seq), 0) AS seq FROM fill_unit_read WHERE unit_id = $1 AND generation = $2
       ), latest AS (
         SELECT DISTINCT ON (query_digest) * FROM input ORDER BY query_digest, ord DESC
       ), saved AS (
         INSERT INTO fill_unit_read (unit_id, generation, query_digest, query, membership, members, read_seq, at)
         SELECT $1, $2, latest.query_digest, latest.query, latest.membership, latest.members, base.seq + latest.ord, latest.at
         FROM latest CROSS JOIN base WHERE true
         ON CONFLICT (unit_id, generation, query_digest) DO UPDATE
           SET query = EXCLUDED.query, membership = EXCLUDED.membership, members = EXCLUDED.members,
               read_seq = EXCLUDED.read_seq, at = EXCLUDED.at
         RETURNING read_seq
       )
       SELECT base.seq FROM base CROSS JOIN (SELECT count(*) FROM saved) AS written`,
      [first.unitId, first.generation, JSON.stringify(payload)],
    );
    const base = millis(rows[0]!.seq);
    // Every call allocates a sequence, even when a later duplicate replaces its stored row.
    return payload.map((read) => ({
      unitId: first.unitId, generation: first.generation, queryDigest: read.query_digest, query: read.query,
      membership: read.membership, members: read.members, seq: base + read.ord, at: read.at,
    }));
  }, 'write');
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

/**
 * The digest of one unit's writes: what a publication names, so the same writes
 * applied twice are one publication. The writes are the stage's answer as it
 * answered them, never the graph's rows: the digest says what the unit said.
 */
export function writesDigest(writes: readonly StageWrite[]): string {
  return canonicalJsonDigest(writes);
}

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
 * recorded and the digest of the writes it answered, with the stage module's id
 * and version. A rerun under a newer stage module is therefore a different
 * publication of the same generation, which the unique record refuses rather
 * than overwriting.
 */
export function publicationDigest(input: {
  readonly inputsDigest: string;
  readonly writes: string;
  readonly stageId: string;
  readonly stageVersion: number;
}): string {
  return canonicalJsonDigest({ inputs: input.inputsDigest, writes: input.writes, stage: { id: input.stageId, version: input.stageVersion } });
}

/** What one publication answered. */
export type PublicationOutcome =
  | { readonly outcome: 'published'; readonly record: PublicationRecord; readonly effects: readonly string[] }
  /** The same identity and the same digest were published before: the existing result, and nothing written. */
  | { readonly outcome: 'replayed'; readonly record: PublicationRecord }
  | { readonly outcome: 'refused'; readonly code: string; readonly reason: string; readonly record: PublicationRecord | null };

/** One publication request: the generation, what identifies it and how its writes are applied. */
export interface PublicationRequest {
  readonly unitId: string;
  readonly generation: number;
  /**
   * What the publication publishes: the inputs the generation recorded and the
   * digest of the writes the stage answered, with the stage module's id and
   * version. A rerun under a newer stage module is therefore a different
   * publication of the same generation, which the unique record refuses rather
   * than overwriting.
   */
  readonly identity: {
    readonly inputsDigest: string;
    readonly writesDigest: string;
    readonly stageId: string;
    readonly stageVersion: number;
  };
  /** What the producer answered of its kind, recorded on the generation with its publication. */
  readonly outcome: ProducerOutcomeDraft | null;
  /** The attempt the worker publishes under: a later attempt's publication is refused as stale. */
  readonly attempt: number;
  readonly at: number;
  /**
   * Rechecks one recorded read against the graph as it stands now: the digest of
   * the rows it answers and how many they are. A read whose membership moved
   * refuses the publication, rather than applying writes the graph no longer
   * supports.
   */
  readonly revalidate: (read: TrackedRead, executor: SqlExecutor) => Promise<{ readonly membership: string; readonly members: number }>;
  /**
   * Applies the unit's writes through the one writer, inside this same
   * transaction, and answers how many facts it wrote. It runs after the
   * generation's reads were rechecked and before the machine's `publish` step, so
   * a failure here — or the record's own refusal — rolls the writes, the state
   * and the record back together. The database owner is the only writer; this
   * callback is where the writes reach it. It is given the digest this
   * transaction computed, which is the one the record will carry.
   */
  readonly apply: (executor: SqlExecutor, digest: string) => Promise<number>;
}

/** The statement that reads the run's state of one generation's unit; `share` takes the run row's lock. */
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
 * The order is the decision's own: the run's state, the reads the writes stand
 * on, the run's state again, the writes through the one writer, the machine's
 * `publish` step — which takes the generation's row `FOR UPDATE`, so two
 * publishers of one generation are serialized here — and the record. A step the
 * machine refuses is a value, and it is answered before anything is written.
 */
export async function publishUnitIn(executor: SqlExecutor, options: PublicationRequest): Promise<PublicationOutcome> {
  // One snapshot for the whole publication, set before any statement of it runs: the rechecks below read
  // each tracked read again, and a read is asked a page at a time (`READ_PAGE_ROWS`), so at the READ
  // COMMITTED level every caller's write transaction opens at, a fact another unit committed between two
  // pages of one read would stand outside the recheck's answer while the recorded membership still
  // matched. It is the first statement of the transaction, which is the only moment PostgreSQL accepts a
  // level being set.
  await executor.query(PUBLICATION_SNAPSHOT);

  // The run's own state, inside the same transaction and under the run row's share lock: a run that is
  // cancelling or cancelled revokes the authority of everything it planned, and a failed run publishes
  // nothing. The lock is what makes the check hold for the whole transaction rather than for one instant:
  // a cancellation's own write of the run's state waits for this publication to end, so an intent that
  // lands while a publication is under way is refused here instead of racing it. A pause drains, so a
  // publication already under way is allowed to finish — the pause's settlement waits for it.
  const control = await executor.query<{ state: string }>(controlSql(true), [options.unitId, options.generation]);
  const refusedControl = revokedAuthority(options.unitId, options.generation, control.rows[0]?.state);
  if (refusedControl !== null) return refusedControl;

  // The queue's claim is the attempt's lock (decision 0039, item 12): a publication whose attempt the
  // generation already passed is refused, so a stale worker cannot write facts under a later attempt.
  const attemptHeld = await executor.query<{ attempt: unknown }>(
    `SELECT (g.context->>'attempt')::int AS attempt FROM fill_unit_generation g WHERE g.unit_id = $1 AND g.generation = $2`,
    [options.unitId, options.generation],
  );
  const currentAttempt = Number(attemptHeld.rows[0]?.attempt ?? 0);
  if (currentAttempt > options.attempt) {
    return {
      outcome: 'refused',
      code: 'fill-publication/attempt-stale',
      reason: `fill-publication: unit "${options.unitId}" generation ${options.generation} stands in attempt ${String(currentAttempt)}, and this publication is attempt ${String(options.attempt)}: the queue handed the unit out again, so the claim it belongs to ended`,
      record: null,
    };
  }

  const digest = publicationDigest({
    inputsDigest: options.identity.inputsDigest,
    writes: options.identity.writesDigest,
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

  // Every recorded read, rechecked as it stands now. An empty answer that became
  // a non-empty one refuses here like any other moved membership.
  for (const read of await readUnitReadsIn(executor, options.unitId, options.generation)) {
    const now = await options.revalidate(read, executor);
    if (now.membership !== read.membership) {
      return {
        outcome: 'refused',
        code: 'fill-publication/reads-stale',
        reason: `fill-publication: unit "${options.unitId}" generation ${options.generation} read "${read.query}" and it answered ${read.members} ${read.members === 1 ? 'row' : 'rows'} (${read.membership}), which is now ${now.members} (${now.membership}); the writes this publication would apply stand on a graph that moved`,
        record: null,
      };
    }
  }

  // The run's state once more, after the reads were rechecked and before anything is written: this reads
  // the row the share lock above was taken on, inside the transaction's one snapshot, so it answers what
  // the first read answered.
  const rechecked = await executor.query<{ state: string }>(controlSql(false), [options.unitId, options.generation]);
  const refusedSince = revokedAuthority(options.unitId, options.generation, rechecked.rows[0]?.state);
  if (refusedSince !== null) return refusedSince;

  // The writes first, then the machine's own step, then the record: a refusal of the step writes nothing
  // at all, and a failure of the writes rolls the step back with them.
  const facts = await options.apply(executor, digest);
  const step = await advanceUnitIn(executor, {
    unitId: options.unitId,
    event: { type: 'publish', at: options.at, generation: options.generation, outcome: options.outcome },
  });
  if (!step.ok) return { outcome: 'refused', code: step.refusal.code, reason: step.refusal.reason, record: null };
  await executor.query(
    'INSERT INTO fill_publication (unit_id, generation, digest, facts, published_at) VALUES ($1, $2, $3, $4, $5)',
    [options.unitId, options.generation, digest, facts, options.at],
  );
  return {
    outcome: 'published',
    record: { unitId: options.unitId, generation: options.generation, digest, facts, publishedAt: options.at },
    effects: step.effects,
  };
}

/** What a run of a fill ended with, as the process that ran it answered it (madarch-8bdc.9). */
export interface FillEnd {
  readonly runId: string;
  readonly state: string;
  readonly message?: string;
  readonly unread?: readonly { readonly repository: string; readonly path: string; readonly reason: string }[];
}

/** Records how a run ended, where the process that pressed it reads it. */
export async function writeFillEnd(database: OrchestratorDatabase, end: FillEnd): Promise<void> {
  const at = here();
  await run(at, database, `writeFillEnd(${end.runId})`, ['fill_end'], async (executor) => {
    await executor.query(
      `INSERT INTO fill_end (run_id, state, message, unread) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (run_id) DO UPDATE SET state = $2, message = $3, unread = $4::jsonb, finished_at = now()`,
      [end.runId, end.state, end.message ?? null, end.unread === undefined ? null : JSON.stringify(end.unread)],
    );
  }, 'write');
}

/** How a run ended, or null when the process that ran it has not written it yet. */
export async function readFillEnd(database: OrchestratorDatabase, runId: string): Promise<FillEnd | null> {
  const at = here();
  return await run(at, database, `readFillEnd(${runId})`, ['fill_end'], async (executor) => {
    const { rows } = await executor.query<{ state: string; message: string | null; unread: unknown }>('SELECT state, message, unread FROM fill_end WHERE run_id = $1', [runId]);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      runId,
      state: row.state,
      ...(row.message === null ? {} : { message: row.message }),
      ...(Array.isArray(row.unread) ? { unread: row.unread as { repository: string; path: string; reason: string }[] } : {}),
    };
  }, 'snapshot');
}

/** One generation's publication record inside a transaction the caller already opened. */
export async function readPublicationIn(executor: SqlExecutor, unitId: string, generation: number): Promise<PublicationRecord | null> {
  const { rows } = await executor.query<PublicationRow>('SELECT unit_id, generation, digest, facts, published_at FROM fill_publication WHERE unit_id = $1 AND generation = $2', [unitId, generation]);
  return rows[0] === undefined ? null : publicationRecord(rows[0]);
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
;

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
  options: { readonly runId: string; readonly digest: string; readonly snapshot: RunSnapshot; readonly at: number; readonly ownerToken?: string; readonly ownerAt?: number },
): Promise<RunConfigurationRecord> {
  const at = here();
  return run(at, database, `recordRunConfiguration(${options.runId})`, ['fill_run_configuration'], async (executor) => {
    await assertRunWritableIn(executor, { runId: options.runId });
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
  options: { readonly runId: string; readonly stageId: string; readonly units: number; readonly publications: number; readonly at: number; readonly ownerToken?: string; readonly ownerAt?: number },
): Promise<RunStageRecord> {
  const at = here();
  return run(at, database, `recordRunStagePlanned(${options.runId}/${options.stageId})`, ['fill_run_stage'], async (executor) => {
    await assertRunWritableIn(executor, { runId: options.runId });
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

/** Facts applied by this run's publications, not a count of publication units. */
export async function readRunPublicationFacts(database: OrchestratorDatabase, runId: string): Promise<number> {
  const at = here();
  return run(at, database, `readRunPublicationFacts(${runId})`, ['fill_publication'], async (executor) => {
    const { rows } = await executor.query<{ facts: unknown }>(
      `SELECT COALESCE(SUM(p.facts), 0) AS facts FROM fill_publication p
       JOIN fill_unit_generation g ON g.unit_id = p.unit_id AND g.generation = p.generation AND g.run_id = $1`, [runId],
    );
    return millis(rows[0]?.facts ?? 0);
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
export async function readRunPlans(database: OrchestratorDatabase, runId: string, options: { readonly history?: boolean } = {}): Promise<readonly UnitPlanRecord[]> {
  const at = here();
  return run(at, database, `readRunPlans(${runId})`, ['fill_unit_plan'], async (executor) => {
    // The generation in force only: a unit replaced inside one run has two plan rows, and the one the
    // run works is the one its own unit row names. The join also fixes the order the ids are read in.
    const { rows } = await executor.query<UnitPlanRow>(
      `SELECT p.unit_id, p.generation, p.run_id, p.stage_id, p.stage_unit_id, p.scope, p.stage_position, p.plan_position, p.planned_at, p.cache_versions
         FROM fill_unit_plan p ${options.history === true ? '' : 'JOIN fill_unit u ON u.unit_id = p.unit_id AND u.generation = p.generation'}
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
const PROGRESS_KINDS = [
  'run-planned', 'run-started', 'run-blocked', 'run-paused', 'run-resumed', 'run-cancelling', 'run-cancelled',
  'run-completed', 'run-completed-partial', 'run-failed', 'run-replanned', 'run-refused',
  'stage-found-nothing', 'stage-planned', 'kind-abstained',
  'unit-planned', 'unit-admitted', 'unit-started', 'unit-read', 'unit-progress', 'unit-written',
  'unit-published', 'unit-split', 'unit-joined', 'unit-blocked', 'unit-unblocked', 'unit-retried', 'unit-failed',
  'unit-stale', 'unit-inherited', 'unit-cancelled', 'unit-skipped', 'unit-requeued', 'unit-refused', 'run-waiting',
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
    // The run's own row is taken first: two events of one run never share a number, though the
    // owner's pool overlaps two transactions.
    await executor.query('SELECT run_id FROM fill_run WHERE run_id = $1 FOR UPDATE', [event.runId]);
    return insertProgressIn(executor, event);
  }, 'write');
}

async function insertProgressIn(executor: SqlExecutor, event: Omit<FillProgressEvent, 'seq'>): Promise<FillProgressEvent> {
  const { rows } = await executor.query<{ seq: unknown }>(
    `INSERT INTO fill_event (run_id, seq, at, stage, unit_id, generation, kind, summary)
     SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4, $5, $6, $7 FROM fill_event WHERE run_id = $1
     RETURNING seq`,
    [event.runId, event.at, event.stage, event.unitId, event.generation, event.kind, event.summary],
  );
  const seq = millis(rows[0]!.seq);
  return { ...event, seq };
}

/** Appends concurrent events of one run with one run lock and commit. */
export async function appendProgresses(database: OrchestratorDatabase, events: readonly Omit<FillProgressEvent, 'seq'>[]): Promise<readonly FillProgressEvent[]> {
  if (events.length === 0) return [];
  const first = events[0]!;
  if (events.length === 1) return [await appendProgress(database, first)];
  if (events.some((event) => event.runId !== first.runId)) throw new Error('appendProgresses requires one run');
  return run(here(), database, `appendProgresses(${first.runId})`, ['fill_event', 'fill_run'], async (executor) => {
    await executor.query('SELECT run_id FROM fill_run WHERE run_id = $1 FOR UPDATE', [first.runId]);
    const payload = events.map((event, index) => ({
      ord: index + 1, at: event.at, stage: event.stage, unit_id: event.unitId,
      generation: event.generation, kind: event.kind, summary: event.summary,
    }));
    const { rows } = await executor.query<{ seq: unknown }>(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($2::jsonb)
           AS e(ord integer, at bigint, stage text, unit_id text, generation integer, kind text, summary text)
       ), base AS (
         SELECT COALESCE(MAX(seq), 0) AS seq FROM fill_event WHERE run_id = $1
       ), saved AS (
         INSERT INTO fill_event (run_id, seq, at, stage, unit_id, generation, kind, summary)
         SELECT $1, base.seq + input.ord, input.at, input.stage, input.unit_id, input.generation, input.kind, input.summary
         FROM input CROSS JOIN base
         RETURNING seq
       )
       SELECT seq FROM saved ORDER BY seq`,
      [first.runId, JSON.stringify(payload)],
    );
    return events.map((event, index) => ({ ...event, seq: millis(rows[index]!.seq) }));
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
