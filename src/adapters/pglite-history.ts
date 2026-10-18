import type { CompiledModel } from '../model/compile.js';
import { CLASHABLE_KINDS, assembleCompiledModel, assembleSourceModel, assertionsOf, type Assertion, type AssertionKind } from '../history/assertions.js';
import type {
  AssertionChange,
  AssertionRecord,
  AssertionsInput,
  Clock,
  CommitRecord,
  HistoryError,
  HistoryStore,
  ReadInput,
  ReadResult,
  StoreInput,
  SourceRegistry,
  StoreResult,
} from '../history/types.js';
import { byCodePoint } from '../model/order.js';
import { canonicalJsonDigest } from '../model/canonical.js';
import { createPGliteDatabaseOwner, type DatabaseOwner, type OuterTransaction } from './database-owner.js';

export interface PGliteHistoryOptions {
  /** The PGlite data directory; omitted for a private in-memory database. Keep persistent paths in product-local state outside the product repository. */
  path?: string;
  /** Supplies recorded time's "now"; tests inject a fake clock. */
  clock: Clock;
  /**
   * The process's database owner to lend, opened once and shared with the
   * query database and the future queue tables (decision 0027). Omitted,
   * the history opens a PGlite of its own at `path` and closes it with
   * `close()`; lent, the history never closes it — the caller that opened
   * it does. Giving both `owner` and `path` is refused, because the path
   * could only be silently ignored.
   */
  owner?: DatabaseOwner;
}

/** A row of the `assertions` table, as read back for `store`'s own bookkeeping. */
interface AssertionRow {
  kind: AssertionKind;
  entity_id: string;
  content: string;
  valid_from: number;
  valid_to: number | null;
  opened_by: string;
  closed_by: string | null;
  recorded_from: number;
}

/**
 * A row naming another source's currently-believed assertion overlapping
 * the version being stored (the clash check now only ever queries
 * `CLASHABLE_KINDS` for this — see `selectOtherCurrentOverlapping`), or one
 * row of a `read`'s own result set.
 */
interface OtherCurrentRow {
  kind: AssertionKind;
  entity_id: string;
  content: string;
  source: string;
}

/** A row of `source_commits`, as read back to decide idempotence and ordering. */
interface CommitRow {
  committed_at: number;
  content_digest: string;
  canonical_digest: string;
}

/** A row of `source_commits`, as read back for `commits`' commit order. */
interface CommitListRow {
  commit_id: string;
  committed_at: number;
  recorded_at: number;
  canonical_digest: string;
}

/** A row naming the commit immediately after a given position in a source's commit order. */
interface SuccessorRow {
  commit_id: string;
  committed_at: number;
}

/** Thrown inside a store's own transaction to roll it back on a refusal; never escapes `store`. */
class StoreRefused extends Error {
  constructor(public readonly errors: HistoryError[]) {
    super('store refused');
  }
}

/**
 * Bitemporal versions of every source's compiled model, in PostgreSQL behind
 * `HistoryStore`. PGlite runs PostgreSQL in WASM in-process, and supports
 * the same file-backed database interface as the server's PostgreSQL store.
 *
 * One table, `assertions`, holds one row per element, interface, relation,
 * data entity, scenario, category, zone, environment or state a source has
 * ever asserted:
 * `valid_from`/`valid_to` bound when it was true of the world (a commit's
 * time onward, closed when a later commit stops asserting it);
 * `recorded_from`/`recorded_to` bound when the history held that belief.
 * `opened_by`/`closed_by` name the commit whose arrival gave a row its
 * `valid_from`/`valid_to`: with `valid_from`/`valid_to` alone, two commits
 * of the same source dated to the very same instant could not be told
 * apart, so `store` orders a source's commits by `(committed_at,
 * commit_id)` — time first, commit id (code point) only to break a tie,
 * never by arrival — and every place that asks "what did this source
 * believe right at this commit's position" compares that whole pair, not
 * `committed_at` alone (see `selectSuccessorCommit`, `selectStateAt`). A row's `kind`, `entity_id`,
 * `content`, `valid_from` and `opened_by` never change after it is
 * inserted; the one mutation ever applied to a row is setting
 * `recorded_to` once, to close it — the standard bitemporal correction: the
 * old belief stays exactly as it was recorded, and a new row carries the
 * corrected `valid_to`/`closed_by` forward. `source_commits` remembers
 * which commits of which source are already stored, each commit's time for
 * ordering, and a digest of what it asserted, so a commit id stored again
 * can be told apart from an identical repeat. A store never lets its own
 * recorded moment land at or before the `recorded_from` of a row it is
 * about to close (see `recordingNow`), so a clock that moves backwards, or
 * simply has not moved since that row was opened, cannot make that row's
 * `recorded_to` collide with its own `recorded_from`.
 *
 * Ordering by commit time, not arrival (the `order-by-commit` requirement):
 * storing a commit does not diff it against the source's *newest* stored
 * commit, but against whatever the history currently believes was true at
 * the *new commit's own* position in the order — empty, the first time
 * anything is stored for a position that early. Its assertions are then
 * closed at the commit immediately after it in that order (or left open if
 * there is none yet). A late-arriving commit can land inside a valid-time
 * span an earlier store already carried all the way to its own successor
 * (or open-ended, unchanged across a run of later commits that did not
 * touch that assertion): closing it at the late commit's own position would
 * silently erase what a newer, already-stored commit still asserts, so
 * whenever the row being closed reaches past the late commit's own
 * successor, a second row reopens the same old content from that
 * successor's position to the row's original end — restoring exactly what
 * the newer commit was already believed to assert, undisturbed.
 *
 * Id clash (the `sources` requirement's exclusivity): before anything is
 * written, a store is refused, and the history left exactly as it was, if
 * the new version's valid span — from its commit's time to its own
 * successor, or open-ended — overlaps another source's current assertion
 * (on either time axis: a commit dated after the clock's current "now" is
 * still seen) of an element, interface, relation, data entity or scenario
 * id it also declares (`CLASHABLE_KINDS`, still exclusive to one source; a
 * data entity and a scenario are the model's own vocabulary of things and
 * use cases, each source's exclusive claim the same way the graph's own
 * nodes and edges are). A category, zone, environment or state id
 * (`SHARED_KINDS`, shared vocabulary) is never refused for disagreeing
 * with another source, nor is the union of every source's states ever
 * refused for branching or cycling: the owner's rule (2026-09-24) is that
 * a shared id is always recorded, kept as every source's own definition,
 * never picked between or rejected — see `assembleCompiledModel` and
 * `ReadModel` for how `read` reports the disagreement instead, as a
 * `Discrepancy`, not an error.
 */
/**
 * Every statement this adapter makes runs through an owner's transaction or
 * bare executor (`OuterTransaction`): the history never opens a database of
 * its own when one is lent, and an operation given an outer transaction
 * makes all of its statements inside it (see `src/adapters/database-owner.ts`).
 */
type Executor = OuterTransaction;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message;
  return String(error);
}

function statement<Row extends object = Record<string, unknown>>(executor: Executor, sql: string) {
  let parameter = 0;
  const postgresSql = sql.replace(/\?/g, () => `$${++parameter}`);
  return {
    all: async (...params: unknown[]): Promise<Row[]> => (await executor.query<Row>(postgresSql, params)).rows,
    get: async (...params: unknown[]): Promise<Row | null> => (await executor.query<Row>(postgresSql, params)).rows[0] ?? null,
    run: async (...params: unknown[]): Promise<void> => { await executor.query(postgresSql, params); },
  };
}

async function insertAssertionRows(executor: Executor, rows: readonly unknown[][]): Promise<void> {
  const perRow = 9;
  const chunkSize = Math.floor(60_000 / perRow);
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')}, NULL)`;
    });
    await executor.query(`INSERT INTO assertions (source, kind, entity_id, content, valid_from, valid_to, opened_by, closed_by, recorded_from, recorded_to) VALUES ${tuples.join(', ')}`, values);
  }
}

/**
 * The history's own tables, created once per database the history is given
 * — its own, or the process's shared owner — before any operation runs.
 * Each statement is separate because an owner's transaction takes one
 * statement at a time (PGlite's `exec` is not part of the owner's shape).
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS assertions (
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    content TEXT NOT NULL,
    valid_from DOUBLE PRECISION NOT NULL,
    valid_to DOUBLE PRECISION,
    opened_by TEXT NOT NULL,
    closed_by TEXT,
    recorded_from DOUBLE PRECISION NOT NULL,
    recorded_to DOUBLE PRECISION
  )`,
  `CREATE INDEX IF NOT EXISTS assertions_current ON assertions (source, kind, entity_id, recorded_to)`,
  `CREATE INDEX IF NOT EXISTS assertions_time ON assertions (valid_from, valid_to, recorded_from, recorded_to)`,
  `CREATE INDEX IF NOT EXISTS assertions_other ON assertions (kind, recorded_to, source)`,
  `CREATE TABLE IF NOT EXISTS source_commits (
    source TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    committed_at DOUBLE PRECISION NOT NULL,
    content_digest TEXT NOT NULL,
    recorded_at DOUBLE PRECISION NOT NULL,
    canonical_digest TEXT NOT NULL,
    PRIMARY KEY (source, commit_id)
  )`,
  `CREATE INDEX IF NOT EXISTS source_commits_order_c ON source_commits (source, committed_at, commit_id COLLATE "C")`,
  `CREATE TABLE IF NOT EXISTS source_registry (
    source TEXT PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    former_names TEXT NOT NULL
  )`,
] as const;

/**
 * The history store over a PostgreSQL-compatible database: the owner lent in
 * `options.owner` (the process's one database, shared with the query
 * projection), or a PGlite of its own opened at `options.path` and closed by
 * `close()`. The history's tables are its own; one history per database is
 * what `renameSource` assumes (it renames the one source the history holds).
 */
export function createPGliteHistory(options: PGliteHistoryOptions): HistoryStore {
  if (options.owner !== undefined && options.path !== undefined) {
    throw new Error(`the history cannot be given both a database owner and the path "${options.path}": the owner already names the database it serves, so a path beside it could only be silently ignored`);
  }
  const clock = options.clock;
  const owner = options.owner ?? createPGliteDatabaseOwner({ path: options.path });
  const ownsOwner = options.owner === undefined;
  const location = owner.location;
  // The tables are created before the first operation, and the transaction
  // that creates them is queued on the owner at once — before this function
  // returns, so ahead of any later work on the owner, its close included. A
  // caller that constructs a history from inside a transaction of the same
  // owner would deadlock on that order, and is a defect this adapter does
  // not serve.
  const opened = (async () => {
    try {
      await owner.transaction('write', async (transaction) => {
        for (const statement of SCHEMA) await transaction.query(statement);
        const columns = await transaction.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'source_commits'",
        );
        if (!columns.rows.some((column) => column.column_name === 'canonical_digest')) {
          const legacyCommit = await transaction.query<{ source: string; commit_id: string }>(
            'SELECT source, commit_id FROM source_commits ORDER BY source, committed_at, commit_id LIMIT 1',
          );
          if (legacyCommit.rows.length > 0) {
            const row = legacyCommit.rows[0]!;
            throw new Error(`the history database "${location}" holds commit "${row.commit_id}" of source "${row.source}" without a canonical model digest; the stored assertions cannot faithfully recover the model's original array order, so the history must be migrated by a server that still has the original sent models`);
          }
          await transaction.query('ALTER TABLE source_commits ADD COLUMN canonical_digest TEXT');
        }
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(errorMessage(error), { cause: error });
      throw new Error(`the history directory "${location}" cannot be opened: ${errorMessage(error)}`, { cause });
    }
  })();
  // A caller observes initialization failures on its next history operation;
  // attach a handler now so a failed constructor does not become unhandled.
  void opened.catch(() => {});

  let closed = false;

  /**
   * Runs one history operation: inside the caller's transaction when one is
   * given, in a transaction of the owner's own otherwise. A lent owner
   * serializes the transactions it opens, so the history keeps no queue of
   * its own; work given an outer transaction must not wait on one, or the
   * caller's open transaction would deadlock with it.
   */
  function write<T>(outer: OuterTransaction | undefined, work: (executor: Executor) => Promise<T>): Promise<T> {
    if (outer !== undefined) return work(outer);
    return owner.transaction('write', work);
  }

  /**
   * Runs one operation with no transaction of its own: in the caller's
   * transaction when one is given, or as a bare statement of the owner's —
   * which the owner serializes against its own transactions. Every read uses
   * it, and so does `setRegistry`, whose single statement needs no more.
   */
  function bare<T>(outer: OuterTransaction | undefined, work: (executor: Executor) => Promise<T>): Promise<T> {
    if (outer !== undefined) return work(outer);
    return owner.run(work);
  }

  /** Refuses work once the history is closed, before any statement reaches the owner. */
  function guard<T>(work: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error(`the history database "${location}" is closed`));
    return work();
  }

  function statements(executor: Executor) {
    return {
      selectRegistry: statement<{ id: unknown; former_names: unknown }>(executor, 'SELECT id, former_names FROM source_registry WHERE source = ?'),
      upsertRegistry: statement(executor, 'INSERT INTO source_registry (source, id, former_names) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET id = excluded.id, former_names = excluded.former_names'),
      renameRegistry: statement(executor, 'UPDATE source_registry SET source = ? WHERE source = ?'),
      selectCommit: statement<CommitRow>(executor, 'SELECT committed_at, content_digest, canonical_digest FROM source_commits WHERE source = ? AND commit_id = ?'),
      selectSuccessorCommit: statement<SuccessorRow>(executor, `SELECT commit_id, committed_at FROM source_commits
        WHERE source = ? AND (committed_at > ? OR (committed_at = ? AND commit_id COLLATE "C" > ? COLLATE "C"))
        ORDER BY committed_at ASC, commit_id COLLATE "C" ASC LIMIT 1`),
      selectStateAt: statement<AssertionRow>(executor, `SELECT kind, entity_id, content, valid_from, valid_to, opened_by, closed_by, recorded_from FROM assertions
        WHERE source = ? AND recorded_to IS NULL
          AND (valid_from < ? OR (valid_from = ? AND opened_by COLLATE "C" < ? COLLATE "C"))
          AND (valid_to IS NULL OR valid_to > ? OR (valid_to = ? AND closed_by COLLATE "C" > ? COLLATE "C"))`),
      selectOtherCurrentOverlapping: statement<OtherCurrentRow>(executor, `SELECT kind, entity_id, content, source FROM assertions
        WHERE source != ? AND kind IN (${CLASHABLE_KINDS.map((kind) => `'${kind}'`).join(', ')}) AND recorded_to IS NULL
          AND (?::DOUBLE PRECISION IS NULL OR valid_from < ?)
          AND (valid_to IS NULL OR valid_to > ?) ORDER BY source COLLATE "C"`),
      selectMaxRecordedAt: statement<{ max_recorded: number | null }>(executor, 'SELECT MAX(recorded_at) AS max_recorded FROM source_commits'),
      selectReadAllSources: statement<OtherCurrentRow>(executor, `SELECT kind, entity_id, content, source FROM assertions
        WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
          AND recorded_from <= ? AND (recorded_to IS NULL OR recorded_to > ?)`),
      selectReadOneSource: statement<OtherCurrentRow>(executor, `SELECT kind, entity_id, content, source FROM assertions
        WHERE source = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
          AND recorded_from <= ? AND (recorded_to IS NULL OR recorded_to > ?)`),
      selectAllAssertions: statement<{ source: string; kind: AssertionKind; entity_id: string; content: string; valid_from: number; valid_to: number | null; recorded_from: number; recorded_to: number | null }>(executor, `SELECT source, kind, entity_id, content, valid_from, valid_to, recorded_from, recorded_to FROM assertions
        WHERE (?::TEXT IS NULL OR source = ?) ORDER BY source COLLATE "C", kind COLLATE "C", entity_id COLLATE "C", valid_from, recorded_from`),
      selectSources: statement<{ source: string }>(executor, 'SELECT DISTINCT source FROM source_commits'),
      selectCommits: statement<CommitListRow>(executor, 'SELECT commit_id, committed_at, recorded_at, canonical_digest FROM source_commits WHERE source = ? ORDER BY committed_at ASC, commit_id COLLATE "C" ASC'),
      selectCommitRecord: statement<CommitListRow>(executor, 'SELECT commit_id, committed_at, recorded_at, canonical_digest FROM source_commits WHERE source = ? AND commit_id = ?'),
      selectLatestCommit: statement<CommitListRow>(executor, 'SELECT commit_id, committed_at, recorded_at, canonical_digest FROM source_commits WHERE source = ? ORDER BY committed_at DESC, commit_id COLLATE "C" DESC LIMIT 1'),
      closeAssertion: statement(executor, `UPDATE assertions SET recorded_to = ?
        WHERE source = ? AND kind = ? AND entity_id = ? AND valid_from = ? AND opened_by = ? AND recorded_to IS NULL`),
      insertCommit: statement(executor, 'INSERT INTO source_commits (source, commit_id, committed_at, content_digest, recorded_at, canonical_digest) VALUES (?, ?, ?, ?, ?, ?)'),
      renameCommitSource: statement(executor, 'UPDATE source_commits SET source = ? WHERE source = ?'),
      renameAssertionSource: statement(executor, 'UPDATE assertions SET source = ? WHERE source = ?'),
    };
  }
  function slotOf(kind: AssertionKind, id: string): string {
    return `${kind}\u0000${id}`;
  }

  /**
   * The recorded moment to use for this store: the clock's own reading,
   * first floored at `historicalFloor` — the latest `recorded_at` any store
   * has ever used, across every source — and then, if this store is about
   * to close rows, clamped to strictly after `notBefore`, the latest
   * `recorded_from` among them.
   *
   * The floor keeps recorded time from running backwards even for a store
   * that only opens rows and closes nothing, but it must land *strictly
   * after* the floor when the clock's own reading needed correcting at all
   * (`now < historicalFloor`), never exactly on it: landing exactly on the
   * floor is only ever right when the clock's own reading already, and
   * genuinely, equalled it — two stores truly recorded at the very same
   * real moment (the `not-pushed-forward` case: the wall clock simply had
   * not moved since the last store, so both belong together). A clock
   * reading *behind* the floor is a different case entirely: nothing
   * connects this store's own moment to whichever earlier store last used
   * that exact floor value, so landing exactly on it would make this
   * store's own new rows indistinguishable, at every `known` boundary,
   * from that unrelated earlier store's — a `read` at the known time
   * right after that earlier store would wrongly already see this one's
   * effects too, even though nothing yet connects the two (the
   * `what-we-knew` requirement: reading at a known time in the past must
   * reproduce exactly what history held right then, no more). Landing one
   * millisecond past the floor instead keeps every corrected store its own,
   * distinguishable point in recorded time.
   *
   * The strict-after clamp for `notBefore` exists for the same reason,
   * narrowed to rows this store is about to close: a clock that has gone
   * backwards (or simply not moved since the row being closed was opened)
   * would otherwise give that row the same `recorded_to` as its own
   * `recorded_from`, making it unreadable at any known time; clamped one
   * millisecond past it instead, recorded time stays not just
   * non-decreasing but distinguishable there too. It is checked after the
   * floor (not before): a row this store closes was itself recorded no
   * earlier than the floor already in force when it was opened, so
   * `notBefore` can only ever demand landing later than the floor already
   * has, never earlier.
   */
  function recordingNow(notBefore: number | undefined, historicalFloor: number | undefined): number {
    let now = clock.now();
    if (historicalFloor !== undefined && now < historicalFloor) now = historicalFloor + 1;
    if (notBefore !== undefined && now <= notBefore) now = notBefore + 1;
    return now;
  }

  function digestOf(assertions: readonly Assertion[]): string {
    const sorted = [...assertions].sort((a, b) => byCodePoint(slotOf(a.kind, a.id), slotOf(b.kind, b.id)));
    return JSON.stringify(sorted.map((a) => [a.kind, a.id, a.content]));
  }

  async function store(input: StoreInput, registryInput?: SourceRegistry, outer?: OuterTransaction): Promise<StoreResult> {
    const { source, commit, committedAt, model } = input;

    let newAssertions: Assertion[];
    let contentDigest: string;
    let canonicalDigest: string;
    try {
      newAssertions = assertionsOf(model);
      contentDigest = digestOf(newAssertions);
      canonicalDigest = canonicalJsonDigest(model);
    } catch (error) {
      return { errors: [{ message: `the model could not be recorded: ${error instanceof Error ? error.message : String(error)}` }], opened: [], closed: [] };
    }

    try {
      await opened;
      return await write(outer, async (tx): Promise<StoreResult> => {
        const {
          selectCommit, upsertRegistry, selectSuccessorCommit, selectOtherCurrentOverlapping,
          selectStateAt, selectMaxRecordedAt, closeAssertion, insertCommit,
        } = statements(tx);
        const queuedAssertions: unknown[][] = [];
        const existing = await selectCommit.get(source, commit);
        if (existing !== null) {
          if (existing.committed_at === committedAt && existing.canonical_digest === canonicalDigest) {
            return { errors: [], opened: [], closed: [] };
          }
          return {
            errors: [{
              message: [
                ...(existing.committed_at !== committedAt ? ['a different commit time'] : []),
                ...(existing.canonical_digest !== canonicalDigest
                  ? [`stored canonical digest ${JSON.stringify(existing.canonical_digest)} differs from incoming canonical digest ${JSON.stringify(canonicalDigest)}`]
                  : []),
              ].join('; ').replace(/^/, `commit "${commit}" of source "${source}" is already stored with `),
              id: commit,
              source,
            }],
            opened: [],
            closed: [],
          };
        }
      // The commit immediately after this one in the source's own order
      // (time first, commit id only to break a tie): where this version's
      // assertions close, open-ended otherwise.
      const successor = await selectSuccessorCommit.get(source, committedAt, committedAt, commit);
      const ourValidTo: number | null = successor?.committed_at ?? null;

      // Everything another source currently believes, overlapping this
      // version's own valid span on either time axis — a commit dated
      // after the clock's current "now" is seen too, since only what is
      // currently believed (not "now") is checked (the `sources`
      // requirement).
      const otherCurrent = await selectOtherCurrentOverlapping.all(source, ourValidTo, ourValidTo, committedAt);
      const otherBySlot = new Map<string, OtherCurrentRow[]>();
      for (const row of otherCurrent) {
        const slot = slotOf(row.kind, row.entity_id);
        const list = otherBySlot.get(slot);
        if (list === undefined) otherBySlot.set(slot, [row]);
        else list.push(row);
      }

      // Only `CLASHABLE_KINDS` are ever fetched into `otherCurrent` (see
      // `selectOtherCurrentOverlapping`): a shared id is never refused for
      // disagreeing with another source any more (the owner's rule), so
      // there is nothing left to check for `category`, `zone`,
      // `environment` or `state` here at all.
      const errors: HistoryError[] = [];
      const reportedSlots = new Set<string>();
      const newBySlot = new Map<string, Assertion>();
      for (const assertion of newAssertions) newBySlot.set(slotOf(assertion.kind, assertion.id), assertion);

      for (const assertion of newAssertions) {
        const slot = slotOf(assertion.kind, assertion.id);
        const others = otherBySlot.get(slot);
        if (others === undefined || reportedSlots.has(slot)) continue;

        reportedSlots.add(slot);
        errors.push({ message: `"${assertion.id}" is already declared by source "${others[0]!.source}"`, id: assertion.id, source: others[0]!.source });
      }
      if (errors.length > 0) throw new StoreRefused(errors);

      // What this source's history currently believes was true right at
      // this commit's own position in its order — empty for a source's
      // first commit, or for a late-arriving one earlier than anything
      // stored yet.
      const stateAtSlot = new Map<string, AssertionRow>();
      for (const row of await selectStateAt.all(source, committedAt, committedAt, commit, committedAt, committedAt, commit)) {
        stateAtSlot.set(slotOf(row.kind, row.entity_id), row);
      }

      // The recorded moment used for every write this store makes: the
      // clock's own reading, floored at the latest recorded moment history
      // has ever used, and — if this store is about to close rows — also
      // clamped to strictly after the latest `recorded_from` among them
      // (see `recordingNow`).
      let notBefore: number | undefined;
      for (const [slot, oldRow] of stateAtSlot) {
        const stillAsserted = newBySlot.get(slot);
        if (stillAsserted !== undefined && stillAsserted.content === oldRow.content) continue;
        if (notBefore === undefined || oldRow.recorded_from > notBefore) notBefore = oldRow.recorded_from;
      }
      const historicalFloor = (await selectMaxRecordedAt.get())?.max_recorded ?? undefined;
      const storingNow = recordingNow(notBefore, historicalFloor);

      const opened: AssertionChange[] = [];
      const closed: AssertionChange[] = [];

      // Close what changed or disappeared, leave what is unchanged exactly
      // as it is (the `replace` requirement). Closing never rewrites a
      // row's own valid interval in place: it stops recording belief in it
      // (`recorded_to`) and a fresh row carries the same content forward
      // with `valid_to` now finalized at this commit's position — so a
      // `read` at an earlier known time still sees the old, unclosed
      // belief, unchanged.
      for (const [slot, oldRow] of stateAtSlot) {
        const stillAsserted = newBySlot.get(slot);
        if (stillAsserted !== undefined && stillAsserted.content === oldRow.content) continue;

        await closeAssertion.run(storingNow, source, oldRow.kind, oldRow.entity_id, oldRow.valid_from, oldRow.opened_by);
        // Reported exactly as the row stood before this store touched it —
        // its own valid end, `oldRow.valid_to`, not the point this commit
        // now truncates it to: a caller keeping its own derived index (e.g.
        // the query engine's `update()`) must be able to remove precisely
        // the row that is gone (`source`, `kind`, `id`, `validFrom` identify
        // it) and know what it looked like a moment ago, independent of
        // whatever replaces it below.
        closed.push({
          source,
          kind: oldRow.kind,
          id: oldRow.entity_id,
          content: oldRow.content,
          validFrom: oldRow.valid_from,
          validTo: oldRow.valid_to,
          recordedFrom: oldRow.recorded_from,
          recordedTo: storingNow,
        });

        // No empty row (`valid_from` = `valid_to`): a commit sharing
        // another's exact time, sorting immediately after it by commit id,
        // never gets a zero-width slice of its own. Otherwise, the
        // shortened replacement — same content, corrected end — is a row
        // this store wrote just as much as a brand-new one, so it belongs
        // in `opened` too (the `StoreResult.opened` contract: "every row
        // written by the store").
        if (committedAt !== oldRow.valid_from) {
          queuedAssertions.push([source, oldRow.kind, oldRow.entity_id, oldRow.content, oldRow.valid_from, committedAt, oldRow.opened_by, commit, storingNow]);
          opened.push({ source, kind: oldRow.kind, id: oldRow.entity_id, content: oldRow.content, validFrom: oldRow.valid_from, validTo: committedAt, recordedFrom: storingNow, recordedTo: null });
        }

        // The old row's own end reached past this commit's successor
        // (open-ended, or ending later): that later stretch is still what
        // the newer, already-stored commit asserts (it did not touch this
        // assertion, or it would have closed this row itself already), so
        // it is restored, not left to vanish under this late commit.
        // `oldRow` was only selected because it was still open at this
        // commit's own position, and `successor` is the very next commit
        // after it — nothing could have closed `oldRow` any earlier than
        // that, so its `valid_to` (once real) is always at or past
        // `ourValidTo`; `!==` alone tells "past" from "exactly at" (a
        // same-instant tie-break, which must not reopen a zero-width row).
        if (successor !== null && oldRow.valid_to !== ourValidTo) {
          queuedAssertions.push([source, oldRow.kind, oldRow.entity_id, oldRow.content, ourValidTo!, oldRow.valid_to, successor.commit_id, oldRow.closed_by, storingNow]);
          opened.push({ source, kind: oldRow.kind, id: oldRow.entity_id, content: oldRow.content, validFrom: ourValidTo!, validTo: oldRow.valid_to, recordedFrom: storingNow, recordedTo: null });
        }
      }

      // Open what is new — unless this commit's own span is itself empty
      // (it sorts immediately before another commit of the exact same
      // time): then it never becomes current for any duration.
      if (ourValidTo === null || ourValidTo !== committedAt) {
        for (const [slot, assertion] of newBySlot) {
          const oldRow = stateAtSlot.get(slot);
          if (oldRow !== undefined && oldRow.content === assertion.content) continue;
          queuedAssertions.push([source, assertion.kind, assertion.id, assertion.content, committedAt, ourValidTo, commit, successor?.commit_id ?? null, storingNow]);
          opened.push({ source, kind: assertion.kind, id: assertion.id, content: assertion.content, validFrom: committedAt, validTo: ourValidTo, recordedFrom: storingNow, recordedTo: null });
        }
      }

      await insertAssertionRows(tx, queuedAssertions);
      if (registryInput !== undefined) {
        await upsertRegistry.run(source, registryInput.id, JSON.stringify(registryInput.formerNames));
      }
      await insertCommit.run(source, commit, committedAt, contentDigest, storingNow, canonicalDigest);
      return { errors: [], opened, closed };
      });
    } catch (error) {
      if (error instanceof StoreRefused) return { errors: error.errors, opened: [], closed: [] };
      // A refusal is decided before the first write, so reporting it inside a
      // caller's transaction leaves nothing behind. A database or code failure
      // is not: some of this store's writes may already stand, and nothing
      // here rolls back a transaction the caller owns, so the caller must see
      // the failure and roll back rather than commit rows a report called
      // failed.
      if (outer !== undefined) {
        throw new Error(`the history could not be updated inside the caller's transaction, and the caller decides what becomes of it: ${errorMessage(error)}`, { cause: error });
      }
      return { errors: [{ message: `the history could not be updated: ${errorMessage(error)}` }], opened: [], closed: [] };
    }
  }


  async function read(input: ReadInput = {}, outer?: OuterTransaction): Promise<ReadResult> {
    await opened;
    const now = clock.now();
    const valid = input.valid ?? now;
    const known = input.known ?? now;
    const source = input.source;

    if (source !== undefined) {
      const rows = await bare(outer, async (executor) => await statements(executor).selectReadOneSource.all(source, valid, valid, known, known));
      const { model, errors } = assembleSourceModel(rows.map((row) => ({ kind: row.kind, id: row.entity_id, content: row.content, source: row.source })));
      return { model, discrepancies: [], errors };
    }

    const rows = await bare(outer, async (executor) => await statements(executor).selectReadAllSources.all(valid, valid, known, known));
    return assembleCompiledModel(rows.map((row) => ({ kind: row.kind, id: row.entity_id, content: row.content, source: row.source })));
  }

  async function assertions(input: AssertionsInput = {}, outer?: OuterTransaction): Promise<AssertionRecord[]> {
    await opened;
    const source = input.source;
    const rows = await bare(outer, async (executor) => source === undefined
      ? await statements(executor).selectAllAssertions.all(null, null)
      : await statements(executor).selectAllAssertions.all(source, source));
    return rows.map((row) => ({
      source: row.source,
      kind: row.kind,
      id: row.entity_id,
      content: row.content,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      recordedFrom: row.recorded_from,
      recordedTo: row.recorded_to,
    }));
  }

  async function sources(outer?: OuterTransaction): Promise<string[]> {
    await opened;
    return (await bare(outer, async (executor) => await statements(executor).selectSources.all())).map((row) => row.source).sort(byCodePoint);
  }

  async function renameSource(from: string, to: string, registryInput?: SourceRegistry, outer?: OuterTransaction): Promise<void> {
    // Keep validation and mutation in one transaction. Yielding between them
    // lets concurrent async callers both validate the same source.
    await opened;
    await write(outer, async (tx) => {
      const { selectSources, renameRegistry, upsertRegistry, renameCommitSource, renameAssertionSource } = statements(tx);
      const held = (await selectSources.all()).map((row) => row.source).sort(byCodePoint);
      if (held.length !== 1 || held[0] !== from) {
        const holds = held.length === 0 ? 'no source' : `the sources ${held.join(', ')}`;
        throw new Error(`the history holds ${holds}, but the rename asks to rename ${JSON.stringify(from)} to ${JSON.stringify(to)}: the one source a history holds is renamed whole, nothing beside it`);
      }
      // Keep the registry metadata and history rows under the same source name.
      await renameRegistry.run(to, from);
      if (registryInput !== undefined) {
        await upsertRegistry.run(to, registryInput.id, JSON.stringify(registryInput.formerNames));
      }
      await renameCommitSource.run(to, from);
      await renameAssertionSource.run(to, from);
    });
  }

  /** Every commit of one source, oldest first in the history's own commit order. */
  async function commits(source: string, outer?: OuterTransaction): Promise<CommitRecord[]> {
    await opened;
    return (await bare(outer, async (executor) => await statements(executor).selectCommits.all(source)))
      .map((row) => ({ commit: row.commit_id, committedAt: row.committed_at, storedAt: row.recorded_at, canonicalDigest: row.canonical_digest }));
  }

  async function commitRecord(source: string, commit: string, outer?: OuterTransaction): Promise<CommitRecord | undefined> {
    await opened;
    const row = await bare(outer, async (executor) => await statements(executor).selectCommitRecord.get(source, commit));
    return row === null ? undefined : { commit: row.commit_id, committedAt: row.committed_at, storedAt: row.recorded_at, canonicalDigest: row.canonical_digest };
  }

  async function latestCommit(source: string, outer?: OuterTransaction): Promise<CommitRecord | undefined> {
    await opened;
    const row = await bare(outer, async (executor) => await statements(executor).selectLatestCommit.get(source));
    return row === null ? undefined : { commit: row.commit_id, committedAt: row.committed_at, storedAt: row.recorded_at, canonicalDigest: row.canonical_digest };
  }

  async function hasCommit(source: string, commit: string, outer?: OuterTransaction): Promise<boolean> {
    await opened;
    return await bare(outer, async (executor) => await statements(executor).selectCommit.get(source, commit)) !== null;
  }

  async function registry(source: string, outer?: OuterTransaction): Promise<{ id: string; formerNames: string[] } | undefined> {
    await opened;
    const row = await bare(outer, async (executor) => await statements(executor).selectRegistry.get(source));
    if (row === null) return undefined;
    if (typeof row.id !== 'string' || row.id.length === 0) {
      throw new Error(`the history database "${location}" has invalid "source_registry.id" value ${JSON.stringify(row.id)}: it must be a non-empty string`);
    }
    if (typeof row.former_names !== 'string') {
      throw new Error(`the history database "${location}" has invalid "source_registry.former_names" value ${JSON.stringify(row.former_names)}: it must be a JSON array`);
    }
    let formerNames: unknown;
    try {
      formerNames = JSON.parse(row.former_names);
    } catch {
      throw new Error(`the history database "${location}" has invalid "source_registry.former_names" value ${JSON.stringify(row.former_names)}: it must be a JSON array`);
    }
    if (!Array.isArray(formerNames) || formerNames.some((name) => typeof name !== 'string' || name.length === 0)) {
      throw new Error(`the history database "${location}" has invalid "source_registry.former_names" value ${JSON.stringify(row.former_names)}: it must be an array of non-empty strings`);
    }
    const names = formerNames as string[];
    if (new Set(names).size !== names.length || names.includes(source) || names.some((name, index) => index > 0 && byCodePoint(names[index - 1]!, name) > 0)) {
      throw new Error(`the history database "${location}" has invalid "source_registry.former_names" value ${JSON.stringify(row.former_names)}: names must be unique, code-point sorted, and must not include current source ${JSON.stringify(source)}`);
    }
    return { id: row.id, formerNames: names };
  }

  async function setRegistry(source: string, id: string, formerNames: readonly string[], outer?: OuterTransaction): Promise<void> {
    await opened;
    await bare(outer, async (executor) => await statements(executor).upsertRegistry.run(source, id, JSON.stringify(formerNames)));
  }

  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    // A lent owner is the caller's to close: closing it here would take the
    // query database's connection away with the history's.
    closePromise = ownsOwner ? owner.close() : Promise.resolve();
    return closePromise;
  }

  return {
    store: (input, registryInput, transaction) => guard(() => store(input, registryInput, transaction)),
    read: (input, transaction) => guard(() => read(input, transaction)),
    assertions: (input, transaction) => guard(() => assertions(input, transaction)),
    sources: (transaction) => guard(() => sources(transaction)),
    renameSource: (from, to, registryInput, transaction) => guard(() => renameSource(from, to, registryInput, transaction)),
    registry: (source, transaction) => guard(() => registry(source, transaction)),
    setRegistry: (source, id, formerNames, transaction) => guard(() => setRegistry(source, id, formerNames, transaction)),
    hasCommit: (source, commit, transaction) => guard(() => hasCommit(source, commit, transaction)),
    commitRecord: (source, commit, transaction) => guard(() => commitRecord(source, commit, transaction)),
    latestCommit: (source, transaction) => guard(() => latestCommit(source, transaction)),
    commits: (source, transaction) => guard(() => commits(source, transaction)),
    close,
  };
}
