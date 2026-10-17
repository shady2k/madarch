/**
 * Persistence for the fill's state machines (decision 0027), through the narrow
 * slice of the process's database owner this module needs.
 *
 * Three row sets — `fill_chain`, `fill_run`, `fill_unit` with its
 * `fill_unit_generation` and `fill_unit_lease` — and one journal,
 * `fill_transition`, which records every step taken. A generation's fencing
 * token lives in its `fence` column and is the authority: it is loaded into the
 * machine's context, every step names the token it acts under, and the machine's
 * `fence-current` guard refuses a step that names an older one. The `context`
 * column carries the rest of a generation's context as JSON, and a write sets
 * both in one statement.
 *
 * The database owner is madarch-tzte.19.1's: one owner per process, borrowed
 * here through `FillStateDatabase`. Until that lands, `test/fill-fsm-pglite.ts`
 * opens its own PGlite behind this same interface — the note for
 * madarch-tzte.19.5 is in `docs/changes/madarch-fill-fsm/change.md`.
 * The store never opens a connection, never runs outside a transaction of the
 * owner and never closes the owner.
 */
import type { SqlExecutor } from '../query/sql-driver.js';
import { raise } from './fsm-core.js';
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
import type {
  ChainContext,
  ChainEvent,
  ChainState,
  RunContext,
  RunEvent,
  RunState,
  UnitContext,
  UnitEvent,
  UnitState,
} from './fsm.js';

/** The narrow slice of the process's one database owner that this store borrows (madarch-tzte.19.1). */
export interface FillStateDatabase {
  /** Runs work in one transaction of the owner and commits on success, rolls back on a thrown error. */
  transaction<T>(kind: 'snapshot' | 'write', work: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

/** The tables this store owns; `createFillStateSchema` creates them and every error names the one it touched. */
export const FILL_STATE_TABLES = ['fill_chain', 'fill_run', 'fill_unit', 'fill_unit_generation', 'fill_unit_lease', 'fill_transition'] as const;

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
    run_id text NOT NULL,
    stage_id text NOT NULL,
    scope_key text NOT NULL,
    generation integer NOT NULL,
    created_at bigint NOT NULL,
    UNIQUE (product, stage_id, scope_key)
  )`,
  `CREATE TABLE IF NOT EXISTS fill_unit_generation (
    unit_id text NOT NULL,
    generation integer NOT NULL,
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
];

/** Creates the store's tables and indexes; safe to run on every start of the process's owner. */
export async function createFillStateSchema(database: FillStateDatabase): Promise<void> {
  await run(database, 'createFillStateSchema', async (executor) => {
    for (const statement of SCHEMA) await executor.query(statement);
  }, 'write');
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
  readonly lease: UnitLeaseRecord | null;
}

/** One journal entry: the step a machine took, with the state it left and the one it entered. */
export interface TransitionRecord {
  readonly seq: number;
  readonly subjectKind: 'chain' | 'run' | 'unit';
  readonly subjectId: string;
  readonly generation: number | null;
  readonly transitionId: string;
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly fence: number | null;
  readonly at: number;
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

/** Runs one store operation, naming it and the storage when it fails. A refusal is never an error. */
async function run<R>(
  database: FillStateDatabase,
  operation: string,
  work: (executor: SqlExecutor) => Promise<R>,
  kind: 'snapshot' | 'write' = 'write',
): Promise<R> {
  try {
    return await database.transaction(kind, work);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('/')) throw error;
    raise(`${operation} failed on ${FILL_STATE_TABLES.join(', ')}: ${(error as Error).message}`);
  }
}

interface ChainRow extends Record<string, unknown> { product: string; state: string; context: unknown; updated_at: unknown }
interface RunRow extends Record<string, unknown> { run_id: string; product: string; state: string; context: unknown; created_at: unknown; updated_at: unknown }
interface UnitRow extends Record<string, unknown> { unit_id: string; product: string; run_id: string; stage_id: string; scope_key: string; generation: unknown; created_at: unknown }
interface GenerationRow extends Record<string, unknown> { unit_id: string; generation: unknown; state: string; inputs_digest: string; fence: unknown; context: unknown; published_at: unknown; stale_at: unknown; updated_at: unknown }
interface LeaseRow extends Record<string, unknown> { attempt: unknown; fence: unknown; holder: string; issued_at: unknown; expires_at: unknown; revoked_at: unknown }
interface TransitionRow extends Record<string, unknown> { seq: unknown; subject_kind: string; subject_id: string; generation: unknown; transition_id: string; from_state: string; to_state: string; event: string; fence: unknown; at: unknown }

function requireState<State extends string>(states: readonly State[], value: string, table: string, key: string): State {
  if (!(states as readonly string[]).includes(value)) raise(`table ${table}, row ${key}: state "${value}" is not one of ${states.join(', ')}`);
  return value as State;
}

function chainRecord(row: ChainRow): ChainRecord {
  return {
    product: row.product,
    state: requireState(CHAIN_STATES, row.state, 'fill_chain', row.product),
    context: parseJson<ChainContext>(row.context),
    updatedAt: millis(row.updated_at),
  };
}

function runRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    product: row.product,
    state: requireState(RUN_STATES, row.state, 'fill_run', row.run_id),
    context: parseJson<RunContext>(row.context),
    createdAt: millis(row.created_at),
    updatedAt: millis(row.updated_at),
  };
}

function unitRecord(unit: UnitRow, generation: GenerationRow, lease: LeaseRow | undefined): UnitRecord {
  const stored = parseJson<UnitContext>(generation.context);
  const key = `${unit.unit_id}/${millis(generation.generation)}`;
  return {
    unitId: unit.unit_id,
    product: unit.product,
    runId: unit.run_id,
    stageId: unit.stage_id,
    scopeKey: unit.scope_key,
    generation: millis(generation.generation),
    state: requireState(UNIT_STATES, generation.state, 'fill_unit_generation', key),
    inputsDigest: generation.inputs_digest,
    // The columns are the authority for the generation and its fencing token; the JSON carries the rest.
    context: { ...stored, generation: millis(generation.generation), fence: millis(generation.fence) },
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
  return run(database, `openChain(${options.product})`, async (executor) => {
    await executor.query(
      'INSERT INTO fill_chain (product, state, context, updated_at) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (product) DO NOTHING',
      [options.product, 'idle', json(newChainContext()), options.at],
    );
    const { rows } = await executor.query<ChainRow>('SELECT product, state, context, updated_at FROM fill_chain WHERE product = $1', [options.product]);
    const row = rows[0];
    if (row === undefined) raise(`table fill_chain: no chain for product ${options.product} after opening it`);
    return chainRecord(row);
  });
}

/** Answers a product's chain, or null when the product's chain was never opened. */
export async function readChain(database: FillStateDatabase, product: string): Promise<ChainRecord | null> {
  return run(database, `readChain(${product})`, async (executor) => {
    const { rows } = await executor.query<ChainRow>('SELECT product, state, context, updated_at FROM fill_chain WHERE product = $1', [product]);
    return rows[0] === undefined ? null : chainRecord(rows[0]);
  }, 'snapshot');
}

/** Takes one step on a product's chain: a refused step writes nothing. */
export async function advanceChain(database: FillStateDatabase, options: { readonly product: string; readonly event: ChainEvent }): Promise<StoreStep<ChainRecord, ChainState>> {
  return run(database, `advanceChain(${options.product}, ${options.event.type})`, async (executor) => {
    const { rows } = await executor.query<ChainRow>('SELECT product, state, context, updated_at FROM fill_chain WHERE product = $1 FOR UPDATE', [options.product]);
    const row = rows[0];
    if (row === undefined) raise(`table fill_chain: no chain for product ${options.product}`);
    const current = chainRecord(row);
    const step = chainMachine.step({ state: current.state, context: current.context }, options.event);
    if (!step.ok) return { ok: false, refusal: step.refusal, record: current } as const;
    await executor.query('UPDATE fill_chain SET state = $2, context = $3::jsonb, updated_at = $4 WHERE product = $1', [current.product, step.state, json(step.context), options.event.at]);
    await recordTransition(executor, { subjectKind: 'chain', subjectId: current.product, generation: null, transitionId: step.transition, from: current.state, to: step.state, event: options.event.type, fence: null, at: options.event.at });
    return { ok: true, record: { ...current, state: step.state, context: step.context, updatedAt: options.event.at }, transition: step.transition, effects: step.effects } as const;
  });
}

/** Creates one run in `created`. */
export async function createRun(database: FillStateDatabase, options: { readonly runId: string; readonly product: string; readonly at: number }): Promise<RunRecord> {
  return run(database, `createRun(${options.runId})`, async (executor) => {
    await executor.query(
      'INSERT INTO fill_run (run_id, product, state, context, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $5)',
      [options.runId, options.product, 'created', json(newRunContext()), options.at],
    );
    return { runId: options.runId, product: options.product, state: 'created', context: newRunContext(), createdAt: options.at, updatedAt: options.at };
  });
}

/** Answers one run, or null when it was never created. */
export async function readRun(database: FillStateDatabase, runId: string): Promise<RunRecord | null> {
  return run(database, `readRun(${runId})`, async (executor) => {
    const { rows } = await executor.query<RunRow>('SELECT run_id, product, state, context, created_at, updated_at FROM fill_run WHERE run_id = $1', [runId]);
    return rows[0] === undefined ? null : runRecord(rows[0]);
  }, 'snapshot');
}

/** Takes one step on a run: a refused step writes nothing. */
export async function advanceRun(database: FillStateDatabase, options: { readonly runId: string; readonly event: RunEvent }): Promise<StoreStep<RunRecord, RunState>> {
  return run(database, `advanceRun(${options.runId}, ${options.event.type})`, async (executor) => {
    const { rows } = await executor.query<RunRow>('SELECT run_id, product, state, context, created_at, updated_at FROM fill_run WHERE run_id = $1 FOR UPDATE', [options.runId]);
    const row = rows[0];
    if (row === undefined) raise(`table fill_run: no run ${options.runId}`);
    const current = runRecord(row);
    const step = runMachine.step({ state: current.state, context: current.context }, options.event);
    if (!step.ok) return { ok: false, refusal: step.refusal, record: current } as const;
    await executor.query('UPDATE fill_run SET state = $2, context = $3::jsonb, updated_at = $4 WHERE run_id = $1', [current.runId, step.state, json(step.context), options.event.at]);
    await recordTransition(executor, { subjectKind: 'run', subjectId: current.runId, generation: null, transitionId: step.transition, from: current.state, to: step.state, event: options.event.type, fence: null, at: options.event.at });
    return { ok: true, record: { ...current, state: step.state, context: step.context, updatedAt: options.event.at }, transition: step.transition, effects: step.effects } as const;
  });
}

/** Creates one unit and its first generation in `planned`, with the retries this generation may spend. */
export async function createUnit(database: FillStateDatabase, options: {
  readonly unitId: string;
  readonly product: string;
  readonly runId: string;
  readonly stageId: string;
  readonly scopeKey: string;
  readonly inputsDigest: string;
  readonly retries: number;
  readonly at: number;
}): Promise<UnitRecord> {
  return run(database, `createUnit(${options.unitId})`, async (executor) => {
    const context = newUnitContext({ generation: 1, retries: options.retries });
    await executor.query(
      'INSERT INTO fill_unit (unit_id, product, run_id, stage_id, scope_key, generation, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [options.unitId, options.product, options.runId, options.stageId, options.scopeKey, 1, options.at],
    );
    await executor.query(
      'INSERT INTO fill_unit_generation (unit_id, generation, state, inputs_digest, fence, context, updated_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)',
      [options.unitId, 1, 'planned', options.inputsDigest, context.fence, json(context), options.at],
    );
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
  });
}

interface UnitSnapshot { readonly unit: UnitRow; readonly generation: GenerationRow; readonly lease: LeaseRow | undefined; readonly record: UnitRecord }

async function loadUnit(executor: SqlExecutor, unitId: string, lock: boolean): Promise<UnitSnapshot> {
  const units = await executor.query<UnitRow>('SELECT unit_id, product, run_id, stage_id, scope_key, generation, created_at FROM fill_unit WHERE unit_id = $1', [unitId]);
  const unit = units.rows[0];
  if (unit === undefined) raise(`table fill_unit: no unit ${unitId}`);
  const generations = await executor.query<GenerationRow>(
    `SELECT unit_id, generation, state, inputs_digest, fence, context, published_at, stale_at, updated_at FROM fill_unit_generation WHERE unit_id = $1 AND generation = $2${lock ? ' FOR UPDATE' : ''}`,
    [unitId, millis(unit.generation)],
  );
  const generation = generations.rows[0];
  if (generation === undefined) raise(`table fill_unit_generation: unit ${unitId} names generation ${String(unit.generation)}, which has no row`);
  const leases = await executor.query<LeaseRow>(
    'SELECT attempt, fence, holder, issued_at, expires_at, revoked_at FROM fill_unit_lease WHERE unit_id = $1 AND generation = $2 ORDER BY attempt DESC LIMIT 1',
    [unitId, millis(generation.generation)],
  );
  return { unit, generation, lease: leases.rows[0], record: unitRecord(unit, generation, leases.rows[0]) };
}

/** Answers one unit's current generation with its lease, or null when the unit does not exist. */
export async function readUnit(database: FillStateDatabase, unitId: string): Promise<UnitRecord | null> {
  return run(database, `readUnit(${unitId})`, async (executor) => {
    const units = await executor.query<UnitRow>('SELECT unit_id, product, run_id, stage_id, scope_key, generation, created_at FROM fill_unit WHERE unit_id = $1', [unitId]);
    if (units.rows[0] === undefined) return null;
    return (await loadUnit(executor, unitId, false)).record;
  }, 'snapshot');
}

/** Every generation of a unit, oldest first, with the lease of each. */
export async function readUnitGenerations(database: FillStateDatabase, unitId: string): Promise<readonly UnitRecord[]> {
  return run(database, `readUnitGenerations(${unitId})`, async (executor) => {
    const units = await executor.query<UnitRow>('SELECT unit_id, product, run_id, stage_id, scope_key, generation, created_at FROM fill_unit WHERE unit_id = $1', [unitId]);
    const unit = units.rows[0];
    if (unit === undefined) return [];
    const generations = await executor.query<GenerationRow>(
      'SELECT unit_id, generation, state, inputs_digest, fence, context, published_at, stale_at, updated_at FROM fill_unit_generation WHERE unit_id = $1 ORDER BY generation ASC',
      [unitId],
    );
    const records: UnitRecord[] = [];
    for (const generation of generations.rows) {
      const leases = await executor.query<LeaseRow>(
        'SELECT attempt, fence, holder, issued_at, expires_at, revoked_at FROM fill_unit_lease WHERE unit_id = $1 AND generation = $2 ORDER BY attempt DESC LIMIT 1',
        [unitId, millis(generation.generation)],
      );
      records.push(unitRecord(unit, generation, leases.rows[0]));
    }
    return records;
  }, 'snapshot');
}

async function persistUnitStep(
  executor: SqlExecutor,
  snapshot: UnitSnapshot,
  step: { state: UnitState; context: UnitContext; transition: string },
  at: number,
  event: string,
): Promise<UnitRecord> {
  const { unit, generation } = snapshot;
  const publishedAt = step.state === 'published' ? at : maybeMillis(generation.published_at);
  const staleAt = step.state === 'stale' ? at : maybeMillis(generation.stale_at);
  await executor.query(
    'UPDATE fill_unit_generation SET state = $3, fence = $4, context = $5::jsonb, published_at = $6, stale_at = $7, updated_at = $8 WHERE unit_id = $1 AND generation = $2',
    [unit.unit_id, millis(generation.generation), step.state, step.context.fence, json(step.context), publishedAt, staleAt, at],
  );
  await recordTransition(executor, { subjectKind: 'unit', subjectId: unit.unit_id, generation: millis(generation.generation), transitionId: step.transition, from: generation.state, to: step.state, event, fence: step.context.fence, at });
  return {
    ...snapshot.record,
    state: step.state,
    context: step.context,
    publishedAt,
    staleAt,
    updatedAt: at,
  };
}

/** Takes one step on a unit's current generation: a refused step writes nothing. */
export async function advanceUnit(database: FillStateDatabase, options: { readonly unitId: string; readonly event: UnitEvent }): Promise<StoreStep<UnitRecord, UnitState>> {
  return run(database, `advanceUnit(${options.unitId}, ${options.event.type})`, async (executor) => {
    const snapshot = await loadUnit(executor, options.unitId, true);
    const step = unitMachine.step({ state: snapshot.record.state, context: snapshot.record.context }, options.event);
    if (!step.ok) return { ok: false, refusal: step.refusal, record: snapshot.record } as const;
    const record = await persistUnitStep(executor, snapshot, step, options.event.at, options.event.type);
    return { ok: true, record, transition: step.transition, effects: step.effects } as const;
  });
}

/**
 * Leases a ready unit generation: the next fencing token and the next attempt are
 * issued together, the lease row records the holder and its expiry, and the
 * generation enters `leased`. A late worker that still holds an older token is
 * refused by the machine's `fence-current` guard on every later step.
 */
export async function leaseUnit(database: FillStateDatabase, options: {
  readonly unitId: string;
  readonly holder: string;
  readonly ttlMs: number;
  readonly at: number;
}): Promise<StoreStep<UnitRecord, UnitState>> {
  return run(database, `leaseUnit(${options.unitId})`, async (executor) => {
    const snapshot = await loadUnit(executor, options.unitId, true);
    const fence = snapshot.record.context.fence + 1;
    const attempt = snapshot.record.context.attempt + 1;
    const event: UnitEvent = { type: 'lease', at: options.at, fence, attempt };
    const step = unitMachine.step({ state: snapshot.record.state, context: snapshot.record.context }, event);
    if (!step.ok) return { ok: false, refusal: step.refusal, record: snapshot.record } as const;
    const lease: UnitLeaseRecord = { attempt, fence, holder: options.holder, issuedAt: options.at, expiresAt: options.at + options.ttlMs, revokedAt: null };
    await executor.query(
      'INSERT INTO fill_unit_lease (unit_id, generation, attempt, fence, holder, issued_at, expires_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)',
      [options.unitId, snapshot.record.generation, attempt, fence, options.holder, options.at, lease.expiresAt],
    );
    const record = { ...(await persistUnitStep(executor, snapshot, step, options.at, event.type)), lease };
    return { ok: true, record, transition: step.transition, effects: step.effects } as const;
  });
}

/**
 * Opens the generation that replaces a stale one: the next generation of the same
 * unit starts `planned` with a fresh retry budget and a fence of zero, and the
 * unit's current generation moves to it. Only a stale generation is replaced:
 * a cancelled generation is left as its record and its run is cancelled, and a
 * failed one stays as the record of work that spent its budget.
 */
export async function replaceStaleGeneration(database: FillStateDatabase, options: {
  readonly unitId: string;
  readonly inputsDigest: string;
  readonly retries: number;
  readonly at: number;
}): Promise<StoreStep<UnitRecord, UnitState>> {
  return run(database, `replaceStaleGeneration(${options.unitId})`, async (executor) => {
    const snapshot = await loadUnit(executor, options.unitId, true);
    const current = snapshot.record;
    if (current.state !== 'stale') {
      return {
        ok: false,
        record: current,
        refusal: {
          code: 'fill-state/unit-not-replaceable',
          reason: `fill-unit: unit "${current.unitId}" is ${current.state}; only a stale generation is replaced, and a ${current.state} one stays as its record`,
          state: current.state,
          event: 'open-generation',
          guard: null,
          transitions: [],
        },
      } as const;
    }
    // The stale generation's invalidation named its replacement; opening it here keeps the link honest.
    const generation = current.context.replacedBy ?? current.generation + 1;
    if (generation !== current.generation + 1) {
      raise(`table fill_unit_generation, row ${current.unitId}/${current.generation}: names replacement ${generation}, which is not the next generation`);
    }
    const context = newUnitContext({ generation, retries: options.retries });
    await executor.query(
      'INSERT INTO fill_unit_generation (unit_id, generation, state, inputs_digest, fence, context, updated_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)',
      [options.unitId, generation, 'planned', options.inputsDigest, context.fence, json(context), options.at],
    );
    await executor.query('UPDATE fill_unit SET generation = $2 WHERE unit_id = $1', [options.unitId, generation]);
    return {
      ok: true,
      transition: 'unit/generation--open-->planned',
      effects: [],
      record: { ...current, generation, state: 'planned', inputsDigest: options.inputsDigest, context, publishedAt: null, staleAt: null, updatedAt: options.at, lease: null },
    } as const;
  });
}

/** The journal of one subject (a unit, a run or a product's chain), oldest first. */
export async function readTransitions(database: FillStateDatabase, subject: { readonly kind: 'chain' | 'run' | 'unit'; readonly id: string }): Promise<readonly TransitionRecord[]> {
  return run(database, `readTransitions(${subject.kind} ${subject.id})`, async (executor) => {
    const { rows } = await executor.query<TransitionRow>(
      'SELECT seq, subject_kind, subject_id, generation, transition_id, from_state, to_state, event, fence, at FROM fill_transition WHERE subject_kind = $1 AND subject_id = $2 ORDER BY seq ASC',
      [subject.kind, subject.id],
    );
    return rows.map((row) => ({
      seq: millis(row.seq),
      subjectKind: row.subject_kind as 'chain' | 'run' | 'unit',
      subjectId: row.subject_id,
      generation: maybeMillis(row.generation),
      transitionId: row.transition_id,
      from: row.from_state,
      to: row.to_state,
      event: row.event,
      fence: maybeMillis(row.fence),
      at: millis(row.at),
    }));
  }, 'snapshot');
}
