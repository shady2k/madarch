import { Database, type Statement } from 'bun:sqlite';
import type { CompiledModel } from '../model/compile.js';
import { CLASHABLE_KINDS, assembleCompiledModel, assembleSourceModel, assertionsOf, type Assertion, type AssertionKind } from '../history/assertions.js';
import type {
  AssertionChange,
  AssertionRecord,
  AssertionsInput,
  Clock,
  HistoryError,
  HistoryStore,
  ReadInput,
  ReadResult,
  StoreInput,
  StoreResult,
} from '../history/types.js';
import { byCodePoint } from '../model/order.js';

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
}

/** A row naming the commit immediately after a given position in a source's commit order. */
interface SuccessorRow {
  commit_id: string;
  committed_at: number;
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
 * still seen) of an element, interface or relation id it also declares
 * (`CLASHABLE_KINDS`, still exclusive to one source). A category, zone,
 * environment or state id (`SHARED_KINDS`, shared vocabulary) is never
 * refused for disagreeing with another source, nor is the union of every
 * source's states ever refused for branching or cycling: the owner's rule
 * (2026-09-24) is that a shared id is always recorded, kept as every
 * source's own definition, never picked between or rejected — see
 * `assembleCompiledModel` and `ReadModel` for how `read` reports the
 * disagreement instead, as a `Discrepancy`, not an error.
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
      opened_by TEXT NOT NULL,
      closed_by TEXT,
      recorded_from INTEGER NOT NULL,
      recorded_to INTEGER
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS assertions_current ON assertions (source, kind, entity_id, recorded_to)');
  db.run('CREATE INDEX IF NOT EXISTS assertions_time ON assertions (valid_from, valid_to, recorded_from, recorded_to)');
  db.run('CREATE INDEX IF NOT EXISTS assertions_other ON assertions (kind, recorded_to, source)');
  db.run(`
    CREATE TABLE IF NOT EXISTS source_commits (
      source TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      committed_at INTEGER NOT NULL,
      content_digest TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (source, commit_id)
    )
  `);
  const selectCommit: Statement<CommitRow, [string, string]> = db.query(
    'SELECT committed_at, content_digest FROM source_commits WHERE source = ? AND commit_id = ?',
  );
  const selectSuccessorCommit: Statement<SuccessorRow, [string, number, number, string]> = db.query(
    `SELECT commit_id, committed_at FROM source_commits
     WHERE source = ? AND (committed_at > ? OR (committed_at = ? AND commit_id > ?))
     ORDER BY committed_at ASC, commit_id ASC LIMIT 1`,
  );
  const selectStateAt: Statement<AssertionRow, [string, number, number, string, number, number, string]> = db.query(
    `SELECT kind, entity_id, content, valid_from, valid_to, opened_by, closed_by, recorded_from FROM assertions
     WHERE source = ? AND recorded_to IS NULL
       AND (valid_from < ? OR (valid_from = ? AND opened_by < ?))
       AND (valid_to IS NULL OR valid_to > ? OR (valid_to = ? AND closed_by > ?))`,
  );
  // `CLASHABLE_KINDS` is a fixed, code-defined list (never user input), so
  // it is safe to inline it into the SQL text rather than bind as
  // parameters. Shared kinds (`SHARED_KINDS`) are never checked here any
  // more: a shared id is never refused for disagreeing with another
  // source (the owner's rule), so `store` has nothing left to look up for
  // them ahead of time.
  const clashableKindsList = CLASHABLE_KINDS.map((kind) => `'${kind}'`).join(', ');
  const selectOtherCurrentOverlapping: Statement<OtherCurrentRow, [string, number | null, number | null, number]> = db.query(
    `SELECT kind, entity_id, content, source FROM assertions
     WHERE source != ? AND kind IN (${clashableKindsList}) AND recorded_to IS NULL
       AND (? IS NULL OR valid_from < ?)
       AND (valid_to IS NULL OR valid_to > ?)`,
  );
  const selectMaxRecordedAt: Statement<{ max_recorded: number | null }, []> = db.query('SELECT MAX(recorded_at) AS max_recorded FROM source_commits');
  const selectReadAllSources: Statement<OtherCurrentRow, [number, number, number, number]> = db.query(
    `SELECT kind, entity_id, content, source FROM assertions
     WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
       AND recorded_from <= ? AND (recorded_to IS NULL OR recorded_to > ?)`,
  );
  const selectReadOneSource: Statement<OtherCurrentRow, [string, number, number, number, number]> = db.query(
    `SELECT kind, entity_id, content, source FROM assertions
     WHERE source = ?
       AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
       AND recorded_from <= ? AND (recorded_to IS NULL OR recorded_to > ?)`,
  );
  const selectAllAssertions: Statement<
    { source: string; kind: AssertionKind; entity_id: string; content: string; valid_from: number; valid_to: number | null; recorded_from: number; recorded_to: number | null },
    [string | null, string | null]
  > = db.query(
    `SELECT source, kind, entity_id, content, valid_from, valid_to, recorded_from, recorded_to FROM assertions
     WHERE (? IS NULL OR source = ?)
     ORDER BY source, kind, entity_id, valid_from, recorded_from`,
  );
  const selectSources: Statement<{ source: string }, []> = db.query('SELECT DISTINCT source FROM source_commits');
  const insertAssertion: Statement<unknown, [string, AssertionKind, string, string, number, number | null, string, string | null, number]> = db.query(
    `INSERT INTO assertions (source, kind, entity_id, content, valid_from, valid_to, opened_by, closed_by, recorded_from, recorded_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const closeAssertion: Statement<unknown, [number, string, AssertionKind, string, number, string]> = db.query(
    `UPDATE assertions SET recorded_to = ?
     WHERE source = ? AND kind = ? AND entity_id = ? AND valid_from = ? AND opened_by = ? AND recorded_to IS NULL`,
  );
  const insertCommit: Statement<unknown, [string, string, number, string, number]> = db.query(
    'INSERT INTO source_commits (source, commit_id, committed_at, content_digest, recorded_at) VALUES (?, ?, ?, ?, ?)',
  );
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

  function store(input: StoreInput): StoreResult {
    const { source, commit, committedAt, model } = input;

    let newAssertions: Assertion[];
    let digest: string;
    try {
      newAssertions = assertionsOf(model);
      digest = digestOf(newAssertions);
    } catch (error) {
      return { errors: [{ message: `the model could not be recorded: ${error instanceof Error ? error.message : String(error)}` }], opened: [], closed: [] };
    }

    const existing = selectCommit.get(source, commit);
    if (existing !== null) {
      if (existing.committed_at === committedAt && existing.content_digest === digest) {
        // Already stored, identical: idempotent, nothing new (the `idempotent` requirement).
        return { errors: [], opened: [], closed: [] };
      }
      return {
        errors: [
          {
            message: `commit "${commit}" of source "${source}" is already stored with a different ${
              existing.committed_at !== committedAt ? 'commit time' : 'model'
            }`,
            id: commit,
            source,
          },
        ],
        opened: [],
        closed: [],
      };
    }

    const runStore = db.transaction((): StoreResult => {
      // The commit immediately after this one in the source's own order
      // (time first, commit id only to break a tie): where this version's
      // assertions close, open-ended otherwise.
      const successor = selectSuccessorCommit.get(source, committedAt, committedAt, commit);
      const ourValidTo: number | null = successor?.committed_at ?? null;

      // Everything another source currently believes, overlapping this
      // version's own valid span on either time axis — a commit dated
      // after the clock's current "now" is seen too, since only what is
      // currently believed (not "now") is checked (the `sources`
      // requirement).
      const otherCurrent = selectOtherCurrentOverlapping.all(source, ourValidTo, ourValidTo, committedAt);
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
      for (const row of selectStateAt.all(source, committedAt, committedAt, commit, committedAt, committedAt, commit)) {
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
      const historicalFloor = selectMaxRecordedAt.get()?.max_recorded ?? undefined;
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

        closeAssertion.run(storingNow, source, oldRow.kind, oldRow.entity_id, oldRow.valid_from, oldRow.opened_by);
        // Reported exactly as the row stood before this store touched it —
        // its own valid end, `oldRow.valid_to`, not the point this commit
        // now truncates it to: a caller keeping its own derived index (e.g.
        // the query engine's `update()`) must be able to remove precisely
        // the row that is gone (`source`, `kind`, `id`, `validFrom` identify
        // it) and know what it looked like a moment ago, independent of
        // whatever replaces it below.
        closed.push({ source, kind: oldRow.kind, id: oldRow.entity_id, content: oldRow.content, validFrom: oldRow.valid_from, validTo: oldRow.valid_to });

        // No empty row (`valid_from` = `valid_to`): a commit sharing
        // another's exact time, sorting immediately after it by commit id,
        // never gets a zero-width slice of its own. Otherwise, the
        // shortened replacement — same content, corrected end — is a row
        // this store wrote just as much as a brand-new one, so it belongs
        // in `opened` too (the `StoreResult.opened` contract: "every row
        // written by the store").
        if (committedAt !== oldRow.valid_from) {
          insertAssertion.run(source, oldRow.kind, oldRow.entity_id, oldRow.content, oldRow.valid_from, committedAt, oldRow.opened_by, commit, storingNow);
          opened.push({ source, kind: oldRow.kind, id: oldRow.entity_id, content: oldRow.content, validFrom: oldRow.valid_from, validTo: committedAt });
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
          insertAssertion.run(source, oldRow.kind, oldRow.entity_id, oldRow.content, ourValidTo!, oldRow.valid_to, successor.commit_id, oldRow.closed_by, storingNow);
          opened.push({ source, kind: oldRow.kind, id: oldRow.entity_id, content: oldRow.content, validFrom: ourValidTo!, validTo: oldRow.valid_to });
        }
      }

      // Open what is new — unless this commit's own span is itself empty
      // (it sorts immediately before another commit of the exact same
      // time): then it never becomes current for any duration.
      if (ourValidTo === null || ourValidTo !== committedAt) {
        for (const [slot, assertion] of newBySlot) {
          const oldRow = stateAtSlot.get(slot);
          if (oldRow !== undefined && oldRow.content === assertion.content) continue;
          insertAssertion.run(source, assertion.kind, assertion.id, assertion.content, committedAt, ourValidTo, commit, successor?.commit_id ?? null, storingNow);
          opened.push({ source, kind: assertion.kind, id: assertion.id, content: assertion.content, validFrom: committedAt, validTo: ourValidTo });
        }
      }

      insertCommit.run(source, commit, committedAt, digest, storingNow);
      return { errors: [], opened, closed };
    });

    try {
      return runStore();
    } catch (error) {
      if (error instanceof StoreRefused) return { errors: error.errors, opened: [], closed: [] };
      return { errors: [{ message: `the history could not be updated: ${error instanceof Error ? error.message : String(error)}` }], opened: [], closed: [] };
    }
  }

  function read(input: ReadInput = {}): ReadResult {
    const now = clock.now();
    const valid = input.valid ?? now;
    const known = input.known ?? now;

    if (input.source !== undefined) {
      const rows = selectReadOneSource.all(input.source, valid, valid, known, known);
      const { model, errors } = assembleSourceModel(rows.map((row) => ({ kind: row.kind, id: row.entity_id, content: row.content, source: row.source })));
      return { model, discrepancies: [], errors };
    }

    const rows = selectReadAllSources.all(valid, valid, known, known);
    return assembleCompiledModel(rows.map((row) => ({ kind: row.kind, id: row.entity_id, content: row.content, source: row.source })));
  }

  function assertions(input: AssertionsInput = {}): AssertionRecord[] {
    const rows = input.source !== undefined ? selectAllAssertions.all(input.source, input.source) : selectAllAssertions.all(null, null);
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

  function sources(): string[] {
    return selectSources.all().map((row) => row.source).sort(byCodePoint);
  }

  function hasCommit(source: string, commit: string): boolean {
    return selectCommit.get(source, commit) !== null;
  }

  function close(): void {
    db.close();
  }

  return { store, read, assertions, sources, hasCommit, close };
}
