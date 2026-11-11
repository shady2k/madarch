/**
 * Persistence for the fill's state machines (decision 0027), through the narrow
 * slice of the process's database owner this module needs.
 *
 * Three row sets — `fill_chain`, `fill_run`, `fill_unit` with its
 * `fill_unit_generation` and `fill_unit_lease` — and one journal,
 * `fill_transition`, which records every step taken, including the creation of a
 * unit and the opening of a replacement generation. A generation's fencing token
 * lives in its `fence` column and is the authority: it is loaded into the
 * machine's context, every step names the generation and the token it acts
 * under, and the machine's `generation-current` and `fence-current` guards refuse
 * a step naming an older one. The token grows across the unit's generations, so a
 * replacement generation never reuses the token its predecessor issued. The
 * `context` column carries the rest of a generation's context as JSON, and a
 * write sets both in one statement.
 *
 * The database owner is madarch-tzte.19.1's: one owner per process, borrowed
 * here through `FillStateDatabase`, which is the owner's own `transaction` and
 * nothing else. The store never opens a connection, never runs outside a
 * transaction of the owner and never closes the owner: the process's one owner
 * is created by its caller (the background server, the CLI or a test), the
 * history, the query projection, the queue and these tables all answer from it,
 * and a step taken through `…In` joins the caller's transaction.
 *
 * Two shapes of operation, both of them the owner's transactions, none of them
 * their own: the plain form opens one transaction for one step
 * (`advanceUnit`), and the `…In` form takes the executor of a transaction the
 * caller already opened (`advanceUnitIn`), so the decision's publication step —
 * the generation's `published` state, the publication record and the effects that
 * are storage, in one short transaction — is expressible. A refusal is never an
 * error: it is a value, and a refused step writes nothing. This store's own
 * refusal codes are `fill-store/<what>` and its own journal step ids
 * `fill-store/…-->…`, kept apart from the machines' `fill-unit/…`, `fill-run/…`
 * and `fill-chain/…` codes.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { SqlExecutor, SqlTransactionKind } from '../sql-driver.js';
import { byCodePoint } from '../model/order.js';
import { here, raise, withLocation } from './fsm-core.js';
import type { Refusal } from './fsm-core.js';
import {
  CHAIN_STATES,
  RUN_STATES,
  UNIT_STATES,
  chainMachine,
  newChainContext,
  newRunContext,
  newUnitContext,
  runMachine,
  unitMachine,
} from './fsm.js';
import { createSchemaOnce } from '../adapters/schema-stamp.js';
import type {
  ChainContext,
  ChainEvent,
  ChainState,
  RunContext,
  RunEvent,
  RunState,
  UnitAdvanceEvent,
  UnitContext,
  UnitEvent,
  UnitLeaseEvent,
  UnitState,
} from './fsm.js';

/**
 * The narrow slice of the process's one database owner that this store borrows
 * (madarch-tzte.19.1): the owner's `transaction`, and nothing else. An owner is
 * what a caller passes here; nothing of an adapter's stands between the two, so
 * a step of the state machines joins whatever transaction of the owner its
 * caller holds.
 */
export type FillStateDatabase = Pick<DatabaseOwner, 'transaction'>;

/** The tables this store owns; `createFillStateSchema` creates them and every error names the ones it touched. */
export const FILL_STATE_TABLES = ['fill_chain', 'fill_run', 'fill_unit', 'fill_unit_generation', 'fill_unit_lease', 'fill_transition'] as const;

/** The store's own step ids: no machine declares them, and their prefix keeps them apart from the tables'. */
export const FILL_STORE_STEPS = {
  createUnit: 'fill-store/unit--create-->planned',
  openGeneration: 'fill-store/generation--open-->planned',
  retryGeneration: 'fill-store/generation--retry-->planned',
} as const;

/**
 * The unit states a new run may take up again: the generation published nothing, so there is no work to inherit,
 * and the run that spent its attempts has ended. A published generation is replaced only when its cache key moved
 * (`replaceStaleGeneration`), and a generation of a run that has not ended is another run's, not a retry.
 */
export const RETRYABLE_UNIT_STATES: readonly UnitState[] = ['failed', 'blocked', 'cancelled'];

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS fill_chain (
    product text PRIMARY KEY,
    state text NOT NULL,
    context jsonb NOT NULL,
    updated_at bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fill_run (
    run_id text PRIMARY KEY,
    product text NOT NULL,
    state text NOT NULL,
    context jsonb NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS fill_run_product ON fill_run (product, created_at)',
  `CREATE TABLE IF NOT EXISTS fill_unit (
    unit_id text PRIMARY KEY,
    product text NOT NULL,
    stage_id text NOT NULL,
    scope_key text NOT NULL,
    generation integer NOT NULL,
    created_at bigint NOT NULL,
    UNIQUE (product, stage_id, scope_key)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_unit_generation (
    unit_id text NOT NULL,
    generation integer NOT NULL,
    run_id text NOT NULL,
    state text NOT NULL,
    inputs_digest text NOT NULL,
    fence integer NOT NULL,
    context jsonb NOT NULL,
    published_at bigint,
    stale_at bigint,
    updated_at bigint NOT NULL,
    PRIMARY KEY (unit_id, generation)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_unit_lease (
    unit_id text NOT NULL,
    generation integer NOT NULL,
    attempt integer NOT NULL,
    fence integer NOT NULL,
    holder text NOT NULL,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    revoked_at bigint,
    PRIMARY KEY (unit_id, generation, attempt)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_transition (
    seq bigserial PRIMARY KEY,
    subject_kind text NOT NULL,
    subject_id text NOT NULL,
    generation integer,
    transition_id text NOT NULL,
    from_state text NOT NULL,
    to_state text NOT NULL,
    event text NOT NULL,
    fence integer,
    at bigint NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS fill_transition_subject ON fill_transition (subject_kind, subject_id)',
  // Every pass reads a run's units several times, and admission counts them under the run's lock: without this
  // index each read scans every generation the store holds, which grows with every run a product ever planned.
  'CREATE INDEX IF NOT EXISTS fill_unit_generation_run ON fill_unit_generation (run_id)',
];

/**
 * Creates the store's tables and indexes; safe to run on every start of the process's owner.
 *
 * A schema that stands is not made again (madarch-8bdc.9): `CREATE INDEX IF NOT EXISTS` takes the table's `ShareLock`
 * even when the index is there, and a process opening a store while another runs a fill deadlocked with it — PostgreSQL's
 * own detail (CI run for ddaefd9b, the fill-crash check; reproduced here):
 *
 *     Process 407868 waits for ShareLock on relation 35538 (fill_unit_generation); blocked by 407862.
 *     Process 407862 waits for RowExclusiveLock on relation 35568 (fill_transition); blocked by 407868.
 *       407868: CREATE INDEX IF NOT EXISTS fill_unit_generation_run ON fill_unit_generation (run_id)
 *       407862: INSERT INTO fill_transition (...)
 *
 * — the creator's index holds `fill_unit_generation` while it waits for `fill_transition`, and the run's transaction
 * holds `fill_transition` while it waits for `fill_unit_generation`. `createSchemaOnce` takes the store's schema lock
 * first and then makes nothing at all when the stamp it left stands, so opening a store that has its schema takes no
 * lock on a table a run writes.
 */
/** The foreign keys the fill's own rows must satisfy: a generation belongs to a unit and a run, and a lease to a generation. */
const FOREIGN_KEYS: readonly { readonly table: string; readonly name: string; readonly columns: string; readonly ref: string; readonly refColumns: string }[] = [
  { table: 'fill_unit_generation', name: 'fill_unit_generation_unit_fk', columns: 'unit_id', ref: 'fill_unit', refColumns: 'unit_id' },
  { table: 'fill_unit_lease', name: 'fill_unit_lease_generation_fk', columns: 'unit_id, generation', ref: 'fill_unit_generation', refColumns: 'unit_id, generation' },
];

/** The statement that adds one foreign key where it does not stand yet; `NOT VALID` keeps an older store's rows while new ones are checked. */
const foreignKeySql = (key: (typeof FOREIGN_KEYS)[number]): string =>
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${key.name}') THEN ALTER TABLE ${key.table} ADD CONSTRAINT ${key.name} FOREIGN KEY (${key.columns}) REFERENCES ${key.ref} (${key.refColumns}) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID; END IF; END $$`;

export async function createFillStateSchema(database: FillStateDatabase): Promise<void> {
  const at = here();
  await withLocation(at, 'createFillStateSchema', FILL_STATE_TABLES, async () => {
    await createSchemaOnce(database, {
      name: 'fill-state',
      parts: [...SCHEMA, ...FOREIGN_KEYS.map(foreignKeySql)],
      tables: FILL_STATE_TABLES,
      create: async (executor) => {
        for (const statement of SCHEMA) await executor.query(statement);
        for (const key of FOREIGN_KEYS) await executor.query(foreignKeySql(key));
      },
    });
  });
}

/** One row of `fill_unit_lease`: the lease an attempt took, and the token it acts under. */
export interface UnitLeaseRecord {
  readonly attempt: number;
  readonly fence: number;
  readonly holder: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

/** A product's chain of runs as it is persisted. */
export interface ChainRecord {
  readonly product: string;
  readonly state: ChainState;
  readonly context: ChainContext;
  readonly updatedAt: number;
}

/** One fill run as it is persisted. */
export interface RunRecord {
  readonly runId: string;
  readonly product: string;
  readonly state: RunState;
  readonly context: RunContext;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One unit's current generation as it is persisted, with the lease it holds, if any. */
export interface UnitRecord {
  readonly unitId: string;
  readonly product: string;
  /** The run that planned this generation. */
  readonly runId: string;
  readonly stageId: string;
  readonly scopeKey: string;
  /** The generation in force; older generations stay as their own records. */
  readonly generation: number;
  readonly state: UnitState;
  readonly inputsDigest: string;
  readonly context: UnitContext;
  readonly publishedAt: number | null;
  readonly staleAt: number | null;
  readonly updatedAt: number;
  /** The lease the generation holds — the one carrying its current fencing token — or null when it holds none. */
  readonly lease: UnitLeaseRecord | null;
}


/** What a step did: the new record and the effects the caller must perform, or why the machine refused it. */
export type StoreStep<Record, State extends string> =
  | { readonly ok: true; readonly record: Record; readonly transition: string; readonly effects: readonly string[] }
  | { readonly ok: false; readonly refusal: Refusal<State>; readonly record: Record };

const json = (value: unknown): string => JSON.stringify(value);

function parseJson<T>(value: unknown): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      raise(`a stored context is not JSON: ${(error as Error).message}`);
    }
  }
  return value as T;
}

/** Epoch milliseconds from a `bigint` column, which PostgreSQL drivers answer as a string. */
const millis = (value: unknown): number => (typeof value === 'number' ? value : Number(value));
const maybeMillis = (value: unknown): number | null => (value === null || value === undefined ? null : millis(value));

/**
 * Runs one store operation, naming it and the tables it touches when it fails.
 * A refusal is never an error. The raise happens one frame above this wrapper, so
 * the message names the line of the operation, not of the shared wrapper.
 */
async function run<R>(
  site: string,
  database: FillStateDatabase,
  operation: string,
  tables: readonly string[],
  work: (executor: SqlExecutor) => Promise<R>,
  kind: SqlTransactionKind,
): Promise<R> {
  return await withLocation(site, operation, tables, async () => await database.transaction(kind, work));
}

interface ChainRow extends Record<string, unknown> { product: string; state: string; context: unknown; updated_at: unknown }
interface RunRow extends Record<string, unknown> { run_id: string; product: string; state: string; context: unknown; created_at: unknown; updated_at: unknown }
interface UnitRow extends Record<string, unknown> { unit_id: string; product: string; stage_id: string; scope_key: string; generation: unknown; created_at: unknown }
interface GenerationRow extends Record<string, unknown> { unit_id: string; generation: unknown; run_id: string; state: string; inputs_digest: string; fence: unknown; context: unknown; published_at: unknown; stale_at: unknown; updated_at: unknown }
interface LeaseRow extends Record<string, unknown> { attempt: unknown; fence: unknown; holder: string; issued_at: unknown; expires_at: unknown; revoked_at: unknown }

function requireState<State extends string>(states: readonly State[], value: string, table: string, key: string): State {
  if (!(states as readonly string[]).includes(value)) raise(`table ${table}, row ${key}: state "${value}" is not one of ${states.join(', ')}`);
  return value as State;
}

const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/** A stored context is plain data the guards read: a row that does not hold it is a corruption, named by its key. */
function requireChainContext(value: unknown, product: string): ChainContext {
  const stored = parseJson<Partial<ChainContext>>(value);
  if (stored === null || typeof stored !== 'object') raise(`table fill_chain, row ${product}: the context is not an object`);
  if (stored.activeRunId !== null && typeof stored.activeRunId !== 'string') raise(`table fill_chain, row ${product}: activeRunId is neither null nor a string`);
  return { activeRunId: stored.activeRunId ?? null };
}

function requireRunContext(value: unknown, runId: string): RunContext {
  const stored = parseJson<Partial<RunContext>>(value);
  if (stored === null || typeof stored !== 'object') raise(`table fill_run, row ${runId}: the context is not an object`);
  if (!isInteger(stored.planningEpoch) || stored.planningEpoch < 0) raise(`table fill_run, row ${runId}: planningEpoch is not a whole number of epochs`);
  if (typeof stored.planningClosed !== 'boolean') raise(`table fill_run, row ${runId}: planningClosed is not a boolean`);
  return { planningEpoch: stored.planningEpoch, planningClosed: stored.planningClosed };
}

function requireUnitContext(value: unknown, key: string, generation: number, fence: number): UnitContext {
  const stored = parseJson<Partial<UnitContext>>(value);
  if (stored === null || typeof stored !== 'object') raise(`table fill_unit_generation, row ${key}: the context is not an object`);
  if (!isInteger(stored.attempt) || stored.attempt < 0) raise(`table fill_unit_generation, row ${key}: attempt is not a whole number of attempts`);
  if (!isInteger(stored.retriesLeft) || stored.retriesLeft < 0) raise(`table fill_unit_generation, row ${key}: retriesLeft is not a whole number of retries`);
  if (stored.retryAt !== null && typeof stored.retryAt !== 'number') raise(`table fill_unit_generation, row ${key}: retryAt is neither null nor epoch milliseconds`);
  if (stored.replacedBy !== null && !isInteger(stored.replacedBy)) raise(`table fill_unit_generation, row ${key}: replacedBy is neither null nor a generation number`);
  if (!isInteger(fence) || fence < 0) raise(`table fill_unit_generation, row ${key}: fence is not a whole fencing token`);
  // The columns are the authority for the generation and its fencing token; the JSON carries the rest.
  return {
    generation,
    fence,
    attempt: stored.attempt,
    retriesLeft: stored.retriesLeft,
    retryAt: stored.retryAt ?? null,
    replacedBy: stored.replacedBy ?? null,
  };
}

function chainRecord(row: ChainRow): ChainRecord {
  return {
    product: row.product,
    state: requireState(CHAIN_STATES, row.state, 'fill_chain', row.product),
    context: requireChainContext(row.context, row.product),
    updatedAt: millis(row.updated_at),
  };
}

function runRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    product: row.product,
    state: requireState(RUN_STATES, row.state, 'fill_run', row.run_id),
    context: requireRunContext(row.context, row.run_id),
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

function unitRecord(unit: UnitRow, generation: GenerationRow, lease: LeaseRow | undefined): UnitRecord {
  const generationNumber = millis(generation.generation);
  const key = `${unit.unit_id}/${generationNumber}`;
  return {
    unitId: unit.unit_id,
    product: unit.product,
    runId: generation.run_id,
    stageId: unit.stage_id,
    scopeKey: unit.scope_key,
    generation: generationNumber,
    state: requireState(UNIT_STATES, generation.state, 'fill_unit_generation', key),
    inputsDigest: generation.inputs_digest,
    context: requireUnitContext(generation.context, key, generationNumber, millis(generation.fence)),
    publishedAt: maybeMillis(generation.published_at),
    staleAt: maybeMillis(generation.stale_at),
    updatedAt: millis(generation.updated_at),
    lease: lease === undefined ? null : {
      attempt: millis(lease.attempt),
      fence: millis(lease.fence),
      holder: lease.holder,
      issuedAt: millis(lease.issued_at),
      expiresAt: millis(lease.expires_at),
      revokedAt: maybeMillis(lease.revoked_at),
    },
  };
}

async function recordTransition(
  executor: SqlExecutor,
  entry: { subjectKind: 'chain' | 'run' | 'unit'; subjectId: string; generation: number | null; transitionId: string; from: string; to: string; event: string; fence: number | null; at: number },
): Promise<void> {
  await executor.query(
    'INSERT INTO fill_transition (subject_kind, subject_id, generation, transition_id, from_state, to_state, event, fence, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [entry.subjectKind, entry.subjectId, entry.generation, entry.transitionId, entry.from, entry.to, entry.event, entry.fence, entry.at],
  );
}

/** Opens a product's chain at `idle`, or answers the one it already has. */
export async function openChain(database: FillStateDatabase, options: { readonly product: string; readonly at: number }): Promise<ChainRecord> {
  const at = here();
  return run(at, database, `openChain(${options.product})`, ['fill_chain'], async (executor) => {
    await executor.query(
      'INSERT INTO fill_chain (product, state, context, updated_at) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (product) DO NOTHING',
      [options.product, 'idle', json(newChainContext()), options.at],
    );
    const { rows } = await executor.query<ChainRow>('SELECT product, state, context, updated_at FROM fill_chain WHERE product = $1', [options.product]);
    const row = rows[0];
    if (row === undefined) raise(`table fill_chain: no chain for product ${options.product} after opening it`);
    return chainRecord(row);
  }, 'write');
}

/** Answers a product's chain, or null when the product's chain was never opened. */
export async function readChain(database: FillStateDatabase, product: string): Promise<ChainRecord | null> {
  const at = here();
  return run(at, database, `readChain(${product})`, ['fill_chain'], async (executor) => {
    const { rows } = await executor.query<ChainRow>('SELECT product, state, context, updated_at FROM fill_chain WHERE product = $1', [product]);
    return rows[0] === undefined ? null : chainRecord(rows[0]);
  }, 'snapshot');
}

/** Takes one step on a product's chain: a refused step writes nothing. */
export async function advanceChain(database: FillStateDatabase, options: { readonly product: string; readonly event: ChainEvent }): Promise<StoreStep<ChainRecord, ChainState>> {
  const at = here();
  return run(at, database, `advanceChain(${options.product}, ${options.event.type})`, ['fill_chain', 'fill_transition'], async (executor) => {
    const { rows } = await executor.query<ChainRow>('SELECT product, state, context, updated_at FROM fill_chain WHERE product = $1 FOR UPDATE', [options.product]);
    const row = rows[0];
    if (row === undefined) raise(`table fill_chain: no chain for product ${options.product}`);
    const current = chainRecord(row);
    const step = chainMachine.step({ state: current.state, context: current.context }, options.event);
    if (!step.ok) return { ok: false, refusal: step.refusal, record: current } as const;
    await executor.query('UPDATE fill_chain SET state = $2, context = $3::jsonb, updated_at = $4 WHERE product = $1', [current.product, step.state, json(step.context), options.event.at]);
    await recordTransition(executor, { subjectKind: 'chain', subjectId: current.product, generation: null, transitionId: step.transition, from: current.state, to: step.state, event: options.event.type, fence: null, at: options.event.at });
    return { ok: true, record: { ...current, state: step.state, context: step.context, updatedAt: options.event.at }, transition: step.transition, effects: step.effects } as const;
  }, 'write');
}

/** Creates one run in `created`. */
export async function createRun(database: FillStateDatabase, options: { readonly runId: string; readonly product: string; readonly at: number }): Promise<RunRecord> {
  const at = here();
  return run(at, database, `createRun(${options.runId})`, ['fill_run'], async (executor) => {
    await executor.query(
      'INSERT INTO fill_run (run_id, product, state, context, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $5)',
      [options.runId, options.product, 'created', json(newRunContext()), options.at],
    );
    return { runId: options.runId, product: options.product, state: 'created', context: newRunContext(), createdAt: options.at, updatedAt: options.at };
  }, 'write');
}

/**
 * A cheap stamp of what a store's answers stand on (madarch-8bdc.9): how many publications it holds, the last of them,
 * and the graph's own repositories with the commit each is as-is at. An api role that did not run the fill reads it
 * before each answer and reads the store's numbers again when it moved — one row of counting, not the numbers
 * themselves. The repositories come from the graph, never from a pin table of the fill's (stage 3: `knowledge_fill` is
 * gone).
 */
export async function readStoreStamp(database: FillStateDatabase): Promise<string> {
  const at = here();
  return await run(at, database, 'readStoreStamp', ['fill_publication', 'node', 'edge', 'entity'], async (executor) => {
    const { rows } = await executor.query<{ stamp: string }>(
      `SELECT (SELECT count(*)::text || ':' || coalesce(max(published_at)::text, '-') FROM fill_publication)
              || ':' || (SELECT coalesce(string_agg(name || '=' || coalesce(commit_hash, ''), ',' ORDER BY name), '-')
                           FROM (SELECT (n.key->>'name') AS name,
                                        (SELECT (c.key->>'hash') FROM edge e JOIN entity ek ON ek.id = e.entity_id AND ek.name = 'as-is' JOIN node c ON c.id = e.to_node WHERE e.from_node = n.id AND e.context_id = 1 LIMIT 1) AS commit_hash
                                   FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = 'repository'
                                  WHERE n.context_id = 1 AND NOT n.removed) r) AS stamp`,
    );
    return rows[0]?.stamp ?? '0:-:-';
  }, 'snapshot');
}

/**
 * The newest run of a store that is under way, or null: a fill a *different* process runs is this store's own state
 * (madarch-8bdc.9), and an api role that did not press it still answers how it is.
 */
export async function readLiveRun(database: FillStateDatabase): Promise<RunRecord | null> {
  const at = here();
  return await run(at, database, 'readLiveRun', ['fill_run'], async (executor) => {
    const { rows } = await executor.query<RunRow>(
      `SELECT run_id, product, state, context, created_at, updated_at FROM fill_run
       WHERE state IN ('created', 'planning', 'running', 'pausing', 'cancelling')
       ORDER BY created_at DESC, run_id DESC LIMIT 1`,
    );
    return rows[0] === undefined ? null : runRecord(rows[0]);
  }, 'snapshot');
}

/** Answers one run, or null when it was never created. */
export async function readRun(database: FillStateDatabase, runId: string): Promise<RunRecord | null> {
  const at = here();
  return run(at, database, `readRun(${runId})`, ['fill_run'], async (executor) => {
    const { rows } = await executor.query<RunRow>('SELECT run_id, product, state, context, created_at, updated_at FROM fill_run WHERE run_id = $1', [runId]);
    return rows[0] === undefined ? null : runRecord(rows[0]);
  }, 'snapshot');
}

/**
 * The newest run one product holds, or null when it never ran: the run a person
 * watches in the fill progress (madarch-tzte.26.2). A run's own `created_at`
 * orders them, and the run id breaks a tie — two runs created in one millisecond
 * are two runs, and the answer is still one of them, never an arbitrary one of
 * two reads.
 */
export async function readLatestRun(database: FillStateDatabase, product: string): Promise<RunRecord | null> {
  const at = here();
  return run(at, database, `readLatestRun(${product})`, ['fill_run'], async (executor) => {
    const { rows } = await executor.query<RunRow>(
      'SELECT run_id, product, state, context, created_at, updated_at FROM fill_run WHERE product = $1 ORDER BY created_at DESC, run_id DESC LIMIT 1',
      [product],
    );
    return rows[0] === undefined ? null : runRecord(rows[0]);
  }, 'snapshot');
}

/** Takes one step on a run: a refused step writes nothing. */
export async function advanceRun(database: FillStateDatabase, options: { readonly runId: string; readonly event: RunEvent }): Promise<StoreStep<RunRecord, RunState>> {
  const at = here();
  return run(at, database, `advanceRun(${options.runId}, ${options.event.type})`, ['fill_run', 'fill_transition'], async (executor) => {
    const { rows } = await executor.query<RunRow>('SELECT run_id, product, state, context, created_at, updated_at FROM fill_run WHERE run_id = $1 FOR UPDATE', [options.runId]);
    const row = rows[0];
    if (row === undefined) raise(`table fill_run: no run ${options.runId}`);
    const current = runRecord(row);
    const step = runMachine.step({ state: current.state, context: current.context }, options.event);
    if (!step.ok) return { ok: false, refusal: step.refusal, record: current } as const;
    await executor.query('UPDATE fill_run SET state = $2, context = $3::jsonb, updated_at = $4 WHERE run_id = $1', [current.runId, step.state, json(step.context), options.event.at]);
    await recordTransition(executor, { subjectKind: 'run', subjectId: current.runId, generation: null, transitionId: step.transition, from: current.state, to: step.state, event: options.event.type, fence: null, at: options.event.at });
    return { ok: true, record: { ...current, state: step.state, context: step.context, updatedAt: options.event.at }, transition: step.transition, effects: step.effects } as const;
  }, 'write');
}

/**
 * Creates one unit and its first generation in `planned`, with the retries this
 * generation may spend, and journals the creation. A unit's identity is
 * `(product, stage_id, scope_key)`: a second planning epoch of the same scope
 * answers the unit that identity already has, its current generation as it
 * stands, instead of raising on the unique key or opening a generation behind the
 * store's back — a resume continues the unit, and only `replaceStaleGeneration`
 * and the machine's own steps open generations.
 */
export async function createUnit(database: FillStateDatabase, options: UnitCreateOptions): Promise<UnitRecord> {
  const at = here();
  return run(at, database, `createUnit(${options.unitId})`, ['fill_unit', 'fill_unit_generation', 'fill_transition'], async (executor) => createUnitIn(executor, options), 'write');
}

/** What one unit is created with. */
export interface UnitCreateOptions {
  readonly unitId: string;
  readonly product: string;
  readonly runId: string;
  readonly stageId: string;
  readonly scopeKey: string;
  readonly inputsDigest: string;
  readonly retries: number;
  readonly at: number;
}

/**
 * Creates one unit and its first generation inside a transaction the caller
 * already opened. This is the form a split uses (madarch-tzte.19.5): the
 * children of one split and the parent's own checkpoint land together or not at
 * all, which is what decision 0027's "splits atomically persist the parent's
 * checkpoint and a sealed child set" asks for.
 */
export async function createUnitIn(executor: SqlExecutor, options: UnitCreateOptions): Promise<UnitRecord> {
    const context = newUnitContext({ generation: 1, retries: options.retries });
    const inserted = await executor.query<UnitRow>(
      'INSERT INTO fill_unit (unit_id, product, stage_id, scope_key, generation, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (product, stage_id, scope_key) DO NOTHING RETURNING unit_id, product, stage_id, scope_key, generation, created_at',
      [options.unitId, options.product, options.stageId, options.scopeKey, 1, options.at],
    );
    if (inserted.rows.length === 0) {
      // The identity already has a unit. Answer it as it stands: no generation opened, no journal entry.
      const existing = await executor.query<UnitRow>(
        'SELECT unit_id, product, stage_id, scope_key, generation, created_at FROM fill_unit WHERE product = $1 AND stage_id = $2 AND scope_key = $3 FOR UPDATE',
        [options.product, options.stageId, options.scopeKey],
      );
      const row = existing.rows[0];
      if (row === undefined) raise(`table fill_unit: identity (${options.product}, ${options.stageId}, ${options.scopeKey}) was refused as a duplicate, yet no row holds it`);
      const snapshot = await loadUnit(executor, row.unit_id, true);
      if (snapshot === null) raise(`table fill_unit: unit ${row.unit_id} vanished between its insert and its read`);
      return snapshot.record;
    }
    await executor.query(
      'INSERT INTO fill_unit_generation (unit_id, generation, run_id, state, inputs_digest, fence, context, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)',
      [options.unitId, 1, options.runId, 'planned', options.inputsDigest, context.fence, json(context), options.at],
    );
    await recordTransition(executor, { subjectKind: 'unit', subjectId: options.unitId, generation: 1, transitionId: FILL_STORE_STEPS.createUnit, from: '(none)', to: 'planned', event: 'create', fence: 0, at: options.at });
    return {
      unitId: options.unitId,
      product: options.product,
      runId: options.runId,
      stageId: options.stageId,
      scopeKey: options.scopeKey,
      generation: 1,
      state: 'planned',
      inputsDigest: options.inputsDigest,
      context,
      publishedAt: null,
      staleAt: null,
      updatedAt: options.at,
      lease: null,
    };
}

interface UnitSnapshot { readonly unit: UnitRow; readonly generation: GenerationRow; readonly record: UnitRecord }

/** Loads a unit, its current generation and that generation's lease; null when the unit does not exist. */
async function loadUnit(executor: SqlExecutor, unitId: string, lock: boolean): Promise<UnitSnapshot | null> {
  const units = await executor.query<UnitRow>(
    `SELECT unit_id, product, stage_id, scope_key, generation, created_at FROM fill_unit WHERE unit_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [unitId],
  );
  const unit = units.rows[0];
  if (unit === undefined) return null;
  const generations = await executor.query<GenerationRow>(
    `SELECT unit_id, generation, run_id, state, inputs_digest, fence, context, published_at, stale_at, updated_at FROM fill_unit_generation WHERE unit_id = $1 AND generation = $2${lock ? ' FOR UPDATE' : ''}`,
    [unitId, millis(unit.generation)],
  );
  const generation = generations.rows[0];
  if (generation === undefined) raise(`table fill_unit_generation: unit ${unitId} names generation ${String(unit.generation)}, which has no row`);
  const leases = await executor.query<LeaseRow>(
    'SELECT attempt, fence, holder, issued_at, expires_at, revoked_at FROM fill_unit_lease WHERE unit_id = $1 AND generation = $2 AND fence = $3',
    [unitId, millis(generation.generation), millis(generation.fence)],
  );
  return { unit, generation, record: unitRecord(unit, generation, leases.rows[0]) };
}

/**
 * One unit's named generation, whether or not it is the one in force, with the
 * lease it holds. A parent's join reads its sealed children this way: the split
 * sealed a generation, and a child that has since opened a replacement must not
 * be read as if it were the one the split sealed.
 */
export async function readUnitGeneration(database: FillStateDatabase, unitId: string, generation: number): Promise<UnitRecord | null> {
  const at = here();
  return run(at, database, `readUnitGeneration(${unitId}/${generation})`, ['fill_unit', 'fill_unit_generation', 'fill_unit_lease'], async (executor) => {
    const units = await executor.query<UnitRow>('SELECT unit_id, product, stage_id, scope_key, generation, created_at FROM fill_unit WHERE unit_id = $1', [unitId]);
    const unit = units.rows[0];
    if (unit === undefined) return null;
    const generations = await executor.query<GenerationRow>(
      'SELECT unit_id, generation, run_id, state, inputs_digest, fence, context, published_at, stale_at, updated_at FROM fill_unit_generation WHERE unit_id = $1 AND generation = $2',
      [unitId, generation],
    );
    const row = generations.rows[0];
    if (row === undefined) return null;
    const leases = await executor.query<LeaseRow>(
      'SELECT attempt, fence, holder, issued_at, expires_at, revoked_at FROM fill_unit_lease WHERE unit_id = $1 AND generation = $2 AND fence = $3',
      [unitId, generation, millis(row.fence)],
    );
    return unitRecord(unit, row, leases.rows[0]);
  }, 'snapshot');
}

/**
 * Every unit whose current generation names this run, in code point order of
 * their ids. The orchestrator (madarch-tzte.19.5) reads the units a run planned
 * this way: admission needs the ones a slot may still take, and the run's own
 * evidence counts the ones runnable, in flight and waiting.
 */
export async function readRunUnits(database: FillStateDatabase, runId: string): Promise<readonly UnitRecord[]> {
  const at = here();
  return run(at, database, `readRunUnits(${runId})`, ['fill_unit', 'fill_unit_generation', 'fill_unit_lease'], async (executor) => {
    // One join and not one query per row: a run of a few thousand units read this way costs three
    // round trips per unit, which the walk of madarch-tzte.21.8 measured at 1.7–3.4 s per call — and
    // the orchestrator makes this read several times a pass, so a pass spent seconds reading what it
    // already knew. A generation's lease is the one its row's fence names, and a unit's generation is
    // the one its own row names, so the join answers the same records as the per-row reads did.
    const rows = await executor.query<UnitRow & GenerationRow & LeaseRow>(
      `SELECT u.unit_id, u.product, u.stage_id, u.scope_key, u.created_at,
              g.unit_id AS generation_unit_id, g.generation, g.run_id, g.state, g.inputs_digest, g.fence, g.context,
              g.published_at, g.stale_at, g.updated_at,
              l.attempt, l.fence AS lease_fence, l.holder, l.issued_at, l.expires_at, l.revoked_at, l.unit_id AS lease_unit_id
         FROM fill_unit u LEFT JOIN fill_unit_generation g ON g.unit_id = u.unit_id AND g.generation = u.generation
         LEFT JOIN fill_unit_lease l ON l.unit_id = u.unit_id AND l.generation = g.generation AND l.fence = g.fence
        WHERE g.run_id = $1`,
      [runId],
    );
    const records: UnitRecord[] = [];
    // Every row here names a generation the run holds — the join is on the run's
    // own generations — so a unit whose row names a generation the store does not
    // hold is no unit of this run and is not answered as one.
    for (const row of rows.rows) {
      const lease: LeaseRow | undefined = row.lease_unit_id === null || row.lease_unit_id === undefined
        ? undefined
        : { ...row, attempt: row.attempt, fence: row.lease_fence, holder: row.holder, issued_at: row.issued_at, expires_at: row.expires_at, revoked_at: row.revoked_at };
      records.push(unitRecord(row, row, lease));
    }
    // The database's collation is not the code point order this repository's listing promises, so the
    // order is taken here, exactly as `readUnitGenerations` takes it by generation number.
    return records.sort((left, right) => byCodePoint(left.unitId, right.unitId));
  }, 'snapshot');
}

/**
 * Every unit of one product whose generation in force stands in the named state, in code point order of
 * their ids. The orchestrator reads the product's published generations this way when it propagates what
 * a commit moved (decision 0026, "Updates"): a unit's own row names the generation in force, so a replaced
 * one is answered once, at the generation that replaced it.
 */
export async function readProductUnits(database: FillStateDatabase, options: { readonly product: string; readonly state: UnitState }): Promise<readonly UnitRecord[]> {
  const at = here();
  return run(at, database, `readProductUnits(${options.product}/${options.state})`, ['fill_unit', 'fill_unit_generation', 'fill_unit_lease'], async (executor) => {
    const rows = await executor.query<UnitRow & GenerationRow & LeaseRow>(
      `SELECT u.unit_id, u.product, u.stage_id, u.scope_key, u.created_at,
              g.unit_id AS generation_unit_id, g.generation, g.run_id, g.state, g.inputs_digest, g.fence, g.context,
              g.published_at, g.stale_at, g.updated_at,
              l.attempt, l.fence AS lease_fence, l.holder, l.issued_at, l.expires_at, l.revoked_at, l.unit_id AS lease_unit_id
         FROM fill_unit u JOIN fill_unit_generation g ON g.unit_id = u.unit_id AND g.generation = u.generation
         LEFT JOIN fill_unit_lease l ON l.unit_id = u.unit_id AND l.generation = g.generation AND l.fence = g.fence
        WHERE u.product = $1 AND g.state = $2`,
      [options.product, options.state],
    );
    return rows.rows.map((row) => unitRecord(row, row, row.lease_unit_id === null || row.lease_unit_id === undefined ? undefined : row))
      .sort((left, right) => byCodePoint(left.unitId, right.unitId));
  }, 'snapshot');
}

/**
 * Revokes the lease of one fencing token on a unit generation: the storage half
 * of the machine's `suspend-parent` effect, whose words are "the orchestrator
 * releases the parent's lease while its children run". The lease row stays as
 * the record of the attempt, marked revoked at this moment, so a late worker of
 * that attempt is refused by the machine's own `fence-current` guard and by this
 * revocation alike. The fencing token is not touched: it belongs to the
 * generation, not to the attempt that held it. Answers the lease as it stands
 * afterwards, or null when the generation held no lease under that token.
 */
export async function revokeUnitLease(database: FillStateDatabase, options: { readonly unitId: string; readonly generation: number; readonly fence: number; readonly at: number }): Promise<UnitLeaseRecord | null> {
  const at = here();
  return run(at, database, `revokeUnitLease(${options.unitId}/${options.generation})`, ['fill_unit_lease'], async (executor) => {
    await executor.query(
      'UPDATE fill_unit_lease SET revoked_at = COALESCE(revoked_at, $4) WHERE unit_id = $1 AND generation = $2 AND fence = $3',
      [options.unitId, options.generation, options.fence, options.at],
    );
    const { rows } = await executor.query<LeaseRow>(
      'SELECT attempt, fence, holder, issued_at, expires_at, revoked_at FROM fill_unit_lease WHERE unit_id = $1 AND generation = $2 AND fence = $3',
      [options.unitId, options.generation, options.fence],
    );
    const row = rows[0];
    return row === undefined ? null : {
      attempt: millis(row.attempt),
      fence: millis(row.fence),
      holder: row.holder,
      issuedAt: millis(row.issued_at),
      expiresAt: millis(row.expires_at),
      revokedAt: maybeMillis(row.revoked_at),
    };
  }, 'write');
}

/** Answers one unit's current generation with the lease it holds, or null when the unit does not exist. */
export async function readUnit(database: FillStateDatabase, unitId: string): Promise<UnitRecord | null> {
  const at = here();
  return run(at, database, `readUnit(${unitId})`, ['fill_unit', 'fill_unit_generation', 'fill_unit_lease'], async (executor) => (await loadUnit(executor, unitId, false))?.record ?? null, 'snapshot');
}


/**
 * Writes one unit step: the generation's new state, fence and context, the
 * `published_at` a publication sets, the `stale_at` an invalidation sets, the
 * `revoked_at` a revocation marks on the lease in force, and the journal entry.
 */
async function persistUnitStep(
  executor: SqlExecutor,
  snapshot: UnitSnapshot,
  step: { state: UnitState; context: UnitContext; transition: string; effects: readonly string[] },
  at: number,
  event: string,
): Promise<UnitRecord> {
  const { unit, generation } = snapshot;
  const generationNumber = millis(generation.generation);
  const previousFence = millis(generation.fence);
  const publishedAt = step.state === 'published' ? at : maybeMillis(generation.published_at);
  const staleAt = step.state === 'stale' ? at : maybeMillis(generation.stale_at);
  await executor.query(
    'UPDATE fill_unit_generation SET state = $3, fence = $4, context = $5::jsonb, published_at = $6, stale_at = $7, updated_at = $8 WHERE unit_id = $1 AND generation = $2',
    [unit.unit_id, generationNumber, step.state, step.context.fence, json(step.context), publishedAt, staleAt, at],
  );
  let revokedAt: number | null = maybeMillis(snapshot.record.lease?.revokedAt ?? null);
  if (step.effects.includes('revoke-lease')) {
    revokedAt = revokedAt ?? at;
    await executor.query(
      'UPDATE fill_unit_lease SET revoked_at = COALESCE(revoked_at, $4) WHERE unit_id = $1 AND generation = $2 AND fence = $3',
      [unit.unit_id, generationNumber, previousFence, revokedAt],
    );
  }
  await recordTransition(executor, { subjectKind: 'unit', subjectId: unit.unit_id, generation: generationNumber, transitionId: step.transition, from: generation.state, to: step.state, event, fence: step.context.fence, at });
  const lease = snapshot.record.lease === null ? null : { ...snapshot.record.lease, revokedAt };
  return { ...snapshot.record, state: step.state, context: step.context, publishedAt, staleAt, updatedAt: at, lease };
}

/**
 * Takes one step on a unit's current generation: a refused step writes nothing.
 * The lease is not one of those steps — only `leaseUnitIn` issues a lease, because
 * it must write the lease row with the token it takes.
 *
 * This is the form to use from inside a transaction the caller already opened —
 * the publication step above all, where the decision requires the generation's
 * `published` state and the uniquely constrained publication record to be one
 * short transaction of the database owner (madarch-tzte.19.1 lends its executor).
 */
export async function advanceUnitIn(executor: SqlExecutor, options: { readonly unitId: string; readonly event: UnitAdvanceEvent }): Promise<StoreStep<UnitRecord, UnitState>> {
  const event = options.event as UnitEvent;
  // The run's row is taken before the unit's generation, the order every transaction of a run keeps: an event's own
  // insert checks the generation's foreign key, and a step that locked the generation first would wait for the run an
  // event holds, and the event for the generation the step holds.
  if (event.type !== 'cancel') {
    await executor.query(
      `SELECT 1 FROM fill_run r JOIN fill_unit_generation g ON g.run_id = r.run_id JOIN fill_unit u ON u.unit_id = g.unit_id AND u.generation = g.generation
       WHERE u.unit_id = $1 FOR SHARE OF r`,
      [options.unitId],
    );
  }
  const snapshot = await loadUnit(executor, options.unitId, true);
  if (snapshot === null) raise(`table fill_unit: no unit ${options.unitId}`);
  if (event.type === 'lease') {
    return {
      ok: false,
      record: snapshot.record,
      refusal: {
        code: 'fill-store/lease-not-advanced',
        reason: `fill-unit: unit "${options.unitId}" cannot take a lease from advanceUnit; leaseUnit takes it, so the lease row carries the token, its holder and its expiry`,
        state: snapshot.record.state,
        event: event.type,
        guard: null,
        guards: [],
        transitions: [],
      },
    } as const;
  }
  // The run's control, under its row's share lock and inside this step's own transaction (madarch-8bdc.2.5): a run that is
  // cancelling, cancelled or failed revoked the authority of every unit it planned (decision 0027), so no step but the
  // cancel is taken. The answer is the machine's own refusal — the one a step lands on when the cancel's write came first —
  // so a step and a cancel that race answer alike whichever write lands first. The lock holds the control still for the
  // whole step: an intent that lands while a step is under way waits for it, and a step that comes after sees it.
  if (event.type !== 'cancel') {
    const control = await executor.query<{ state: string }>(
      `SELECT r.state AS state FROM fill_run r JOIN fill_unit_generation g ON g.run_id = r.run_id
       WHERE g.unit_id = $1 AND g.generation = $2 FOR SHARE OF r`,
      [options.unitId, snapshot.record.generation],
    );
    const runState = control.rows[0]?.state;
    if (runState === 'cancelling' || runState === 'cancelled' || runState === 'failed') {
      return {
        ok: false,
        record: snapshot.record,
        refusal: {
          code: 'fill-unit/no-transition',
          reason: `fill-unit: the run of unit "${options.unitId}" generation ${String(snapshot.record.generation)} is ${runState}, which revoked the authority of the units it planned, so "${event.type}" is not taken; the cancel is the step such a run's units take`,
          state: snapshot.record.state,
          event: event.type,
          guard: null,
          guards: [],
          transitions: [],
        },
      } as const;
    }
  }
  const step = unitMachine.step({ state: snapshot.record.state, context: snapshot.record.context }, event);
  if (!step.ok) return { ok: false, refusal: step.refusal, record: snapshot.record } as const;
  const record = await persistUnitStep(executor, snapshot, step, event.at, event.type);
  return { ok: true, record, transition: step.transition, effects: step.effects } as const;
}

/** Takes one step on a unit's current generation in its own transaction of the owner. */
export async function advanceUnit(database: FillStateDatabase, options: { readonly unitId: string; readonly event: UnitAdvanceEvent }): Promise<StoreStep<UnitRecord, UnitState>> {
  const at = here();
  return run(at, database, `advanceUnit(${options.unitId}, ${options.event.type})`, ['fill_unit', 'fill_unit_generation', 'fill_unit_lease', 'fill_transition'], (executor) => advanceUnitIn(executor, options), 'write');
}

/**
 * Leases a ready unit generation: the next fencing token and the next attempt are
 * issued together, the lease row records the holder and its expiry, and the
 * generation enters `leased`. The token grows across the unit's generations, so a
 * late worker that still holds an older token is refused by the machine's
 * `fence-current` guard on every later step, and one that holds a token of an
 * older generation by `generation-current`.
 */
export interface UnitLeaseOptions {
  readonly unitId: string;
  readonly holder: string;
  readonly ttlMs: number;
  readonly at: number;
}

/** Leases a ready unit generation inside a transaction the caller already opened. */
async function leaseUnitIn(executor: SqlExecutor, options: UnitLeaseOptions): Promise<StoreStep<UnitRecord, UnitState>> {
  const snapshot = await loadUnit(executor, options.unitId, true);
  if (snapshot === null) raise(`table fill_unit: no unit ${options.unitId}`);
  const fence = snapshot.record.context.fence + 1;
  const attempt = snapshot.record.context.attempt + 1;
  const event: UnitLeaseEvent = { type: 'lease', at: options.at, fence, attempt };
  const step = unitMachine.step({ state: snapshot.record.state, context: snapshot.record.context }, event);
  if (!step.ok) return { ok: false, refusal: step.refusal, record: snapshot.record } as const;
  const lease: UnitLeaseRecord = { attempt, fence, holder: options.holder, issuedAt: options.at, expiresAt: options.at + options.ttlMs, revokedAt: null };
  await executor.query(
    'INSERT INTO fill_unit_lease (unit_id, generation, attempt, fence, holder, issued_at, expires_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)',
    [options.unitId, snapshot.record.generation, attempt, fence, options.holder, options.at, lease.expiresAt],
  );
  const record = { ...(await persistUnitStep(executor, snapshot, step, options.at, event.type)), lease };
  return { ok: true, record, transition: step.transition, effects: step.effects } as const;
}

/** Leases a ready unit generation in its own transaction of the owner. */
export async function leaseUnit(database: FillStateDatabase, options: UnitLeaseOptions): Promise<StoreStep<UnitRecord, UnitState>> {
  const at = here();
  return run(at, database, `leaseUnit(${options.unitId})`, ['fill_unit', 'fill_unit_generation', 'fill_unit_lease', 'fill_transition'], (executor) => leaseUnitIn(executor, options), 'write');
}

/**
 * Opens the generation that replaces a stale one: the next generation of the same
 * unit starts `planned` with a fresh retry budget, the run that plans it, and a
 * fencing floor at the token the stale generation reached, so no token is reused.
 * Only the generation its invalidation named is opened, and only from `stale`:
 * a cancelled generation is left as its record and its run is cancelled, and a
 * failed one stays as the record of work that spent its budget.
 */
export async function replaceStaleGeneration(database: FillStateDatabase, options: {
  readonly unitId: string;
  readonly runId: string;
  readonly inputsDigest: string;
  readonly retries: number;
  readonly at: number;
}): Promise<StoreStep<UnitRecord, UnitState>> {
  const at = here();
  return run(at, database, `replaceStaleGeneration(${options.unitId})`, ['fill_unit', 'fill_unit_generation', 'fill_transition'], async (executor) => {
    const snapshot = await loadUnit(executor, options.unitId, true);
    if (snapshot === null) raise(`table fill_unit: no unit ${options.unitId}`);
    const current = snapshot.record;
    if (current.state !== 'stale') {
      return {
        ok: false,
        record: current,
        refusal: {
          code: 'fill-store/unit-not-replaceable',
          reason: `fill-unit: unit "${current.unitId}" is ${current.state}; only a stale generation is replaced, and a ${current.state} one stays as its record`,
          state: current.state,
          event: 'open-generation',
          guard: null,
          guards: [],
          transitions: [],
        },
      } as const;
    }
    // The stale generation's invalidation named its replacement; opening it here keeps the link honest.
    const generation = current.context.replacedBy ?? current.generation + 1;
    if (generation !== current.generation + 1) {
      raise(`table fill_unit_generation, row ${current.unitId}/${current.generation}: names replacement ${generation}, which is not the next generation`);
    }
    const context = newUnitContext({ generation, retries: options.retries, fence: current.context.fence });
    await executor.query(
      'INSERT INTO fill_unit_generation (unit_id, generation, run_id, state, inputs_digest, fence, context, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)',
      [options.unitId, generation, options.runId, 'planned', options.inputsDigest, context.fence, json(context), options.at],
    );
    await executor.query('UPDATE fill_unit SET generation = $2 WHERE unit_id = $1', [options.unitId, generation]);
    await recordTransition(executor, { subjectKind: 'unit', subjectId: options.unitId, generation, transitionId: FILL_STORE_STEPS.openGeneration, from: 'stale', to: 'planned', event: 'open-generation', fence: context.fence, at: options.at });
    return {
      ok: true,
      transition: FILL_STORE_STEPS.openGeneration,
      effects: [],
      record: { ...current, generation, runId: options.runId, state: 'planned', inputsDigest: options.inputsDigest, context, publishedAt: null, staleAt: null, updatedAt: options.at, lease: null },
    } as const;
  }, 'write');
}

/**
 * Opens the next generation of a unit whose last generation published nothing and whose run has ended: a failed
 * fill is retried by the next fill, never inherited and never trapping the product. The failed generation stays as
 * its own row and its own transition; the new one starts `planned` with a fresh retry budget and this run's id,
 * exactly as a stale generation's replacement does. Only a generation of a live run — or a published one — is
 * refused by name.
 */
export async function retryGeneration(database: FillStateDatabase, options: {
  readonly unitId: string;
  readonly runId: string;
  readonly inputsDigest: string;
  readonly retries: number;
  readonly at: number;
}): Promise<StoreStep<UnitRecord, UnitState>> {
  const at = here();
  return run(at, database, `retryGeneration(${options.unitId})`, ['fill_unit', 'fill_unit_generation', 'fill_transition'], async (executor) => {
    const snapshot = await loadUnit(executor, options.unitId, true);
    if (snapshot === null) raise(`table fill_unit: no unit ${options.unitId}`);
    const current = snapshot.record;
    if (!RETRYABLE_UNIT_STATES.includes(current.state)) {
      return {
        ok: false,
        record: current,
        refusal: {
          code: 'fill-store/unit-not-retryable',
          reason: `fill-unit: unit "${current.unitId}" stands ${current.state}; a generation is retried only from ${RETRYABLE_UNIT_STATES.join(', ')}, and a ${current.state} one stays as its record`,
          state: current.state,
          event: 'retry-generation',
          guard: null,
          guards: [],
          transitions: [],
        },
      } as const;
    }
    const generation = current.generation + 1;
    const context = newUnitContext({ generation, retries: options.retries, fence: current.context.fence });
    await executor.query(
      'INSERT INTO fill_unit_generation (unit_id, generation, run_id, state, inputs_digest, fence, context, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)',
      [options.unitId, generation, options.runId, 'planned', options.inputsDigest, context.fence, json(context), options.at],
    );
    await executor.query('UPDATE fill_unit SET generation = $2 WHERE unit_id = $1', [options.unitId, generation]);
    await recordTransition(executor, { subjectKind: 'unit', subjectId: options.unitId, generation, transitionId: FILL_STORE_STEPS.retryGeneration, from: current.state, to: 'planned', event: 'retry-generation', fence: context.fence, at: options.at });
    return {
      ok: true,
      transition: FILL_STORE_STEPS.retryGeneration,
      effects: [],
      record: { ...current, generation, runId: options.runId, state: 'planned', inputsDigest: options.inputsDigest, context, publishedAt: null, staleAt: null, updatedAt: options.at, lease: null },
    } as const;
  }, 'write');
}
