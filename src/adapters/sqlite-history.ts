import { Database, type Statement } from 'bun:sqlite';
import type { CompiledModel } from '../model/compile.js';
import { CLASHABLE_KINDS, assembleCompiledModel, assertionsOf, type Assertion, type AssertionKind } from '../history/assertions.js';
import type { Clock, HistoryError, HistoryStore, ReadInput, StoreInput, StoreResult } from '../history/types.js';

export interface SqliteHistoryOptions {
  /** The database file's path; `':memory:'` (the default) for an in-memory database, as tests use. */
  path?: string;
  /** Supplies recorded time's "now"; tests inject a fake clock. */
  clock: Clock;
}

/** A row of the `assertions` table, as read back for `store`'s own bookkeeping. */
interface AssertionRow {
  kind: AssertionKind;
  entity_id: string;
  content: string;
  valid_from: number;
}

/** A row of the `assertions` table, as read back to answer `read`. */
interface ReadRow {
  kind: AssertionKind;
  entity_id: string;
  content: string;
}

/** A row naming which other source currently declares a given (kind, id). */
interface OtherCurrentRow {
  kind: AssertionKind;
  entity_id: string;
  source: string;
}

/** Thrown inside `db.transaction` to roll it back on a refusal; never escapes `store`. */
class StoreRefused extends Error {
  constructor(public readonly errors: HistoryError[]) {
    super('store refused');
  }
}

/**
 * Bitemporal versions of every source's compiled model, in SQLite behind
 * `HistoryStore` (see design.md, "From files to answers"). Bun-specific
 * (`bun:sqlite`): this is the boundary decision 0008 draws, and the only
 * place in this module the rest of the library ever needs to cross.
 *
 * One table, `assertions`, holds one row per element, interface, relation,
 * category, zone, environment or state a source has ever asserted:
 * `valid_from`/`valid_to` bound when it was true of the world (the commit's
 * time onward, closed when a later commit stops asserting it);
 * `recorded_from`/`recorded_to` bound when the history held that belief. A
 * row's `kind`, `entity_id`, `content` and `valid_from` never change after
 * it is inserted; the one mutation ever applied to a row is setting
 * `recorded_to` once, to close it — the standard bitemporal correction: the
 * old belief stays exactly as it was recorded, and a new row carries the
 * corrected `valid_to` forward. `source_commits` remembers which commits of
 * which source are already stored, for `store`'s idempotence, and each
 * commit's time, for ordering a late-arriving commit against it.
 *
 * Ordering by commit time (the `order-by-commit` requirement): storing a
 * commit does not diff it against the source's *newest* stored commit, but
 * against whatever the history currently believes was true at the *new
 * commit's own* valid time (its `committedAt`) — empty, the first time
 * anything is stored for a valid time that early. Its assertions are then
 * closed at the next later commit already on record for that source (or
 * left open if there is none yet). Storing a commit older than the newest
 * one stored therefore fills in a valid-time gap before it, and never
 * touches the newer commit's own rows — exactly the late-arrival scenario.
 *
 * Id clash (the `sources` requirement): before anything is written, a
 * store is refused, and the history left exactly as it was, if the new
 * version declares an element, interface or relation id another source's
 * current version — as of right now, on both time axes — already
 * declares. See `CLASHABLE_KINDS` for which kinds are checked and why.
 */
export function createSqliteHistory(options: SqliteHistoryOptions): HistoryStore {
  // `':memory:'` here is a documented convention, not load-bearing: an
  // empty string opens an equally private, unshared temporary database
  // under `bun:sqlite`, so there is no test that could tell the two apart
  // from the outside.
  const db = new Database(options.path ?? ':memory:');
  const clock = options.clock;

  db.run(`
    CREATE TABLE IF NOT EXISTS assertions (
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      content TEXT NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      recorded_from INTEGER NOT NULL,
      recorded_to INTEGER
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS assertions_current ON assertions (source, kind, entity_id, recorded_to)');
  db.run('CREATE INDEX IF NOT EXISTS assertions_time ON assertions (valid_from, valid_to, recorded_from, recorded_to)');
  db.run(`
    CREATE TABLE IF NOT EXISTS source_commits (
      source TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      committed_at INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (source, commit_id)
    )
  `);

  const selectCommit: Statement<{ found: number }, [string, string]> = db.query(
    'SELECT 1 as found FROM source_commits WHERE source = ? AND commit_id = ?',
  );
  const selectSuccessorCommit: Statement<{ min: number | null }, [string, number]> = db.query(
    'SELECT MIN(committed_at) as min FROM source_commits WHERE source = ? AND committed_at > ?',
  );
  const selectStateAt: Statement<AssertionRow, [string, number, number]> = db.query(
    `SELECT kind, entity_id, content, valid_from FROM assertions
     WHERE source = ? AND recorded_to IS NULL AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`,
  );
  // `CLASHABLE_KINDS` is a fixed, code-defined list (never user input), so
  // it is safe to inline into the SQL text rather than bind as parameters.
  const clashableKindsList = CLASHABLE_KINDS.map((kind) => `'${kind}'`).join(', ');
  const selectOtherCurrent: Statement<OtherCurrentRow, [string, number, number, number, number]> = db.query(
    `SELECT kind, entity_id, source FROM assertions
     WHERE source != ? AND kind IN (${clashableKindsList})
       AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
       AND recorded_from <= ? AND (recorded_to IS NULL OR recorded_to > ?)`,
  );
  const selectReadAllSources: Statement<ReadRow, [number, number, number, number]> = db.query(
    `SELECT kind, entity_id, content FROM assertions
     WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
       AND recorded_from <= ? AND (recorded_to IS NULL OR recorded_to > ?)`,
  );
  const selectReadOneSource: Statement<ReadRow, [string, number, number, number, number]> = db.query(
    `SELECT kind, entity_id, content FROM assertions
     WHERE source = ?
       AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
       AND recorded_from <= ? AND (recorded_to IS NULL OR recorded_to > ?)`,
  );
  const insertAssertion: Statement<unknown, [string, AssertionKind, string, string, number, number | null, number]> = db.query(
    `INSERT INTO assertions (source, kind, entity_id, content, valid_from, valid_to, recorded_from, recorded_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const closeAssertion: Statement<unknown, [number, string, AssertionKind, string, number]> = db.query(
    `UPDATE assertions SET recorded_to = ?
     WHERE source = ? AND kind = ? AND entity_id = ? AND valid_from = ? AND recorded_to IS NULL`,
  );
  const insertCommit: Statement<unknown, [string, string, number, number]> = db.query(
    'INSERT INTO source_commits (source, commit_id, committed_at, recorded_at) VALUES (?, ?, ?, ?)',
  );

  function slotOf(kind: AssertionKind, id: string): string {
    return `${kind}\u0000${id}`;
  }

  function store(input: StoreInput): StoreResult {
    const { source, commit, committedAt, model } = input;

    if (selectCommit.get(source, commit) !== null) {
      // Already stored: idempotent, nothing new (the `idempotent` requirement).
      return { errors: [] };
    }

    const runStore = db.transaction((): StoreResult => {
      const storingNow = clock.now();
      const newAssertions = assertionsOf(model);

      // Id clash: refused when this source's new version declares an id
      // of a clashable kind that another source's current model — as of
      // right now, on both time axes — already declares. Checked, and the
      // whole store refused, before anything is written.
      const otherCurrentBySlot = new Map<string, string>();
      for (const row of selectOtherCurrent.all(source, storingNow, storingNow, storingNow, storingNow)) {
        otherCurrentBySlot.set(slotOf(row.kind, row.entity_id), row.source);
      }
      const clashErrors: HistoryError[] = [];
      const reportedSlots = new Set<string>();
      for (const assertion of newAssertions) {
        const slot = slotOf(assertion.kind, assertion.id);
        if (reportedSlots.has(slot)) continue;
        const otherSource = otherCurrentBySlot.get(slot);
        if (otherSource === undefined) continue;
        reportedSlots.add(slot);
        clashErrors.push({
          message: `"${assertion.id}" is already declared by source "${otherSource}"`,
          id: assertion.id,
          source: otherSource,
        });
      }
      if (clashErrors.length > 0) throw new StoreRefused(clashErrors);

      // The next later commit already on record for this source, if any:
      // where this version's assertions close, open-ended otherwise.
      // `MIN(committed_at)` is an aggregate with no `GROUP BY`, so this
      // always returns exactly one row, `{ min: null }` when there is no
      // later commit yet — never no row at all.
      const validTo = selectSuccessorCommit.get(source, committedAt)!.min;

      // What the history currently believes was true at this commit's own
      // valid time — empty for a source's first commit, or for a
      // late-arriving one earlier than anything stored yet.
      const stateAtSlot = new Map<string, AssertionRow>();
      for (const row of selectStateAt.all(source, committedAt, committedAt)) {
        stateAtSlot.set(slotOf(row.kind, row.entity_id), row);
      }
      const newBySlot = new Map<string, Assertion>();
      for (const assertion of newAssertions) newBySlot.set(slotOf(assertion.kind, assertion.id), assertion);

      // Close what changed or disappeared, leave what is unchanged exactly
      // as it is (the `replace` requirement). Closing never rewrites a
      // row's own valid interval: it stops recording belief in it
      // (`recorded_to`) and a fresh row carries the same content forward
      // with its `valid_to` now finalized — so a `read` at an earlier
      // known time still sees the old, open-ended belief, unchanged.
      for (const [slot, oldRow] of stateAtSlot) {
        const stillAsserted = newBySlot.get(slot);
        if (stillAsserted !== undefined && stillAsserted.content === oldRow.content) continue;
        closeAssertion.run(storingNow, source, oldRow.kind, oldRow.entity_id, oldRow.valid_from);
        insertAssertion.run(source, oldRow.kind, oldRow.entity_id, oldRow.content, oldRow.valid_from, committedAt, storingNow);
      }

      // Open what is new.
      for (const [slot, assertion] of newBySlot) {
        const oldRow = stateAtSlot.get(slot);
        if (oldRow !== undefined && oldRow.content === assertion.content) continue;
        insertAssertion.run(source, assertion.kind, assertion.id, assertion.content, committedAt, validTo, storingNow);
      }

      insertCommit.run(source, commit, committedAt, storingNow);
      return { errors: [] };
    });

    try {
      return runStore();
    } catch (error) {
      if (error instanceof StoreRefused) return { errors: error.errors };
      return { errors: [{ message: `the history could not be updated: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }

  function read(input: ReadInput = {}): CompiledModel {
    const now = clock.now();
    const valid = input.valid ?? now;
    const known = input.known ?? now;

    const rows =
      input.source !== undefined
        ? selectReadOneSource.all(input.source, valid, valid, known, known)
        : selectReadAllSources.all(valid, valid, known, known);

    return assembleCompiledModel(rows.map((row) => ({ kind: row.kind, id: row.entity_id, content: row.content })));
  }

  return { store, read };
}
