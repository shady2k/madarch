/**
 * The writer's resumability, on the orchestrator's own state (decision 0027; madarch-ztyq.4).
 *
 * A writer unit is a unit of the fill's unit tables: `writer.<kind>` is its stage id, its scope key
 * is the entity or the page it covers, and its inputs digest is what it read and what it was told
 * (`writerUnitDigest`, `graph.ts`). The machine is the landed one — planned, ready, leased,
 * running, draft, validating, published — and nothing here decides a state of its own:
 *
 * - `begin` opens the unit at its first run (`createUnit`), takes its lease and starts it; a unit an
 *   earlier run left `ready` is leased again, and one it left `blocked` is resolved by name and
 *   admitted (`unblock`), because a writer's refusal is an attempt that produced nothing, not a
 *   budget that is spent;
 * - `publish` walks the generation to `published` in the orchestrator's own steps, which is what a
 *   later run reads to keep the unit's page instead of writing it again;
 * - `blocked` leaves the generation blocked with the reason it carries, so the run after it can
 *   take the unit up again.
 *
 * An interrupted run therefore leaves every finished unit published and every unfinished one
 * blocked or leased-but-lapsed: the next run reads what is published (with the same inputs digest,
 * which is what makes the page the page of *this* graph and this language) and runs the rest.
 *
 * The writer opens no run of its own in `fill_run` and takes no chain step: the pages are the agent
 * stage of the fill run a person started, and a second run record for the same work would be a run
 * the fill's progress counted twice. What the writer needs of 0027's state is the unit, its
 * generation and its publication, and those it uses as they stand.
 */
import type { FillStateDatabase } from '../fill/state-store.js';
import {
  advanceUnit,
  createFillStateSchema,
  createUnit,
  leaseUnit,
  readProductUnits,
  replaceStaleGeneration,
  revokeUnitLease,
} from '../fill/state-store.js';
import type { UnitRecord } from '../fill/state-store.js';
import { byCodePoint } from '../model/order.js';
import { writerStageId, type WriterUnitKindName } from './graph.js';

/** What opening a unit's generation answered: whether an attempt is open, and whether it recovered an interrupted one. */
export interface WriterAttempt {
  /** True when this run holds an attempt to publish into; false when the page already holds what the run would write. */
  readonly opened: boolean;
  /**
   * True when the generation this attempt replaced was an attempt that never ended (leased, running, drafting or
   * validating) under exactly these inputs: the page it left on disk is this unit's page, and the run publishes it.
   */
  readonly recovered: boolean;
}

/** One unit as the writer records it: what it is, what it covers and what it read. */
export interface WriterUnitRecord {
  /** The unit's stable id (`<kind>:<scope>`, `writerUnitId`). */
  readonly unit: string;
  readonly kind: WriterUnitKindName;
  /** What the unit covers: an entity's identity, a page's id, or the product's name. */
  readonly scope: string;
  /** The digest of what the unit read and was told (`writerUnitDigest`). */
  readonly digest: string;
}

/** Where a unit is kept between runs (decision 0027's state store), or nothing where a caller keeps none. */
export interface WriterState {
  /** The units the product's earlier runs published, by unit id. */
  published(): Promise<ReadonlyMap<string, WriterUnitRecord>>;
  /**
   * Opens a unit's generation for this run. `opened` is true when an attempt is open to publish into, and false when
   * the unit's page already holds what this run would write (published under the same inputs) — nothing to do.
   * `recovered` is true when the generation this attempt replaced was an attempt that never ended with exactly these
   * inputs: a page that attempt left on disk is this unit's page, and the run publishes it instead of writing it again.
   * A generation in a terminal state (`failed`, `cancelled`) answers no authority at all, and the run refuses to run
   * the unit rather than write a page nobody can publish.
   */
  begin(record: WriterUnitRecord, at: number): Promise<WriterAttempt>;
  /** Records a unit as published: from here on a run with the same digest keeps what it produced. */
  publish(record: WriterUnitRecord, at: number): Promise<void>;
  /** Records a unit that ended without its content, with the reason: the next run takes it up again. */
  blocked(record: WriterUnitRecord, reason: string, at: number): Promise<void>;
}

/** The clock a state record is stamped with; tests inject theirs. */
export type WriterClock = () => number;

/**
 * No state: every unit runs, and nothing is remembered between runs. The default, because a caller
 * that keeps no state must not pay for a database write it never reads; the fill passes the state
 * of its own store (`fillWriterState`).
 */
export const NO_WRITER_STATE: WriterState = {
  published: async () => new Map(),
  begin: async () => ({ opened: true, recovered: false }),
  publish: async () => undefined,
  blocked: async () => undefined,
};

/** What a test (or a caller keeping its own record) reads back from `memoryWriterState()`. */
export interface MemoryWriterState extends WriterState {
  /** What is published, by unit id: the record a run resumes from. */
  readonly publishedUnits: Map<string, WriterUnitRecord>;
  /** The units that ended without their content, with the reason each carried. */
  readonly blockedUnits: Map<string, string>;
  /** The units this state was asked to open, in order: what the last run took up. */
  readonly opened: WriterUnitRecord[];
}

/** A state kept in memory: the shape of the persisted one, and what an interrupted run of a test leaves. */
export function memoryWriterState(): MemoryWriterState {
  const publishedUnits = new Map<string, WriterUnitRecord>();
  const blockedUnits = new Map<string, string>();
  const opened: WriterUnitRecord[] = [];
  return {
    publishedUnits,
    blockedUnits,
    opened,
    published: async () => new Map([...publishedUnits].sort(([left], [right]) => byCodePoint(left, right))),
    begin: async (record) => {
      // A unit published under the same inputs has nothing to open: the page this run would write is the one it holds.
      if (publishedUnits.get(record.unit)?.digest === record.digest) return { opened: false, recovered: false };
      const abandoned = opened.find((entry) => entry.unit === record.unit);
      blockedUnits.delete(record.unit);
      opened.push(record);
      return { opened: true, recovered: abandoned !== undefined && abandoned.digest === record.digest };
    },
    publish: async (record) => {
      blockedUnits.delete(record.unit);
      publishedUnits.set(record.unit, record);
    },
    blocked: async (record, reason) => { blockedUnits.set(record.unit, reason); },
  };
}

/** The stages a writer unit stands under in the fill's unit tables. */
const WRITER_STAGE_PREFIX = 'writer.';

/** The kind a stage id names, or undefined when the stage is not a writer's. */
export function writerKindOfStage(stageId: string): WriterUnitKindName | undefined {
  if (!stageId.startsWith(WRITER_STAGE_PREFIX)) return undefined;
  return stageId.slice(WRITER_STAGE_PREFIX.length) as WriterUnitKindName;
}

/** What the persisted state needs: the product the units belong to and the run that plans them. */
export interface FillWriterStateOptions {
  /** The product's slug, the key the fill's unit tables hold its units under. */
  readonly product: string;
  /** The run these units are planned in: a name of its own per writer run, never a run of `fill_run`. */
  readonly runId: string;
  /** The clock the state's rows are stamped with; `Date.now` when absent. */
  readonly clock?: WriterClock;
}

/**
 * The writer's state in the fill's own unit tables (decision 0027): the units of one product, their
 * generations, their leases and their journal, read and written through the landed store.
 */
export function fillWriterState(database: FillStateDatabase, options: FillWriterStateOptions): WriterState {
  const clock = options.clock ?? (() => Date.now());
  let schema: Promise<void> | undefined;
  const ready = async (): Promise<void> => {
    // The tables are the orchestrator's; a writer that runs in a process which never opened a fill
    // creates them once, and an existing set costs one round trip.
    schema ??= createFillStateSchema(database);
    await schema;
  };
  /** One step of the machine, refused loudly: a refusal here is the writer's own bookkeeping, not a unit's answer. */
  const step = async (what: string, record: WriterUnitRecord, work: () => Promise<{ ok: boolean; refusal?: { code: string; reason: string } }>): Promise<void> => {
    const done = await work();
    if (done.ok) return;
    throw new Error(`src/writer/graph-state.ts: ${what} of the unit ${JSON.stringify(record.unit)} (${JSON.stringify(record.kind)}) was refused by the fill's unit machine: ${done.refusal?.code ?? 'refused'}: ${done.refusal?.reason ?? 'no reason given'} (table fill_unit_generation, unit ${record.unit})`);
  };
  return {
    async published() {
      await ready();
      const records = await readProductUnits(database, { product: options.product, state: 'published' });
      const published = new Map<string, WriterUnitRecord>();
      for (const record of records) {
        const kind = writerKindOfStage(record.stageId);
        if (kind === undefined) continue;
        published.set(record.unitId, { unit: record.unitId, kind, scope: record.scopeKey, digest: record.inputsDigest });
      }
      return new Map([...published].sort(([left], [right]) => byCodePoint(left, right)));
    },
    async begin(record, at) {
      await ready();
      const created: UnitRecord = await createUnit(database, {
        unitId: record.unit,
        product: options.product,
        runId: options.runId,
        stageId: writerStageId(record.kind),
        scopeKey: record.scope,
        inputsDigest: record.digest,
        retries: 0,
        at,
      });
      let generation = created.generation;
      let state: UnitRecord['state'] = created.state;
      // The unit is published under exactly the inputs this run offers: nothing is opened, and the page it holds is the
      // page this run would write.
      if (state === 'published' && created.inputsDigest === record.digest) return { opened: false, recovered: false };
      if (state === 'failed' || state === 'cancelled') {
        // A generation that ended holds no authority: nothing may start it again, and a page written into it could never
        // be published. The run refuses the unit and says so rather than writing a page nobody can publish.
        throw new Error(`src/writer/graph-state.ts: the unit ${JSON.stringify(record.unit)} is ${state} in the fill's unit tables (fill_unit_generation, unit ${record.unit}, generation ${generation}): a generation that ended holds no authority, so this run does not write its page`);
      }
      // An attempt that never ended — the worker was killed between its lease and its publication — is recovered here,
      // through the persisted state: its lease is revoked, its generation goes stale, and the next generation of the same
      // inputs is opened below. No orchestrator sweep ever comes for a writer unit (it has no run of the fill's), so the
      // writer is its own sweep.
      let recovered = false;
      if (state === 'leased' || state === 'running' || state === 'draft' || state === 'validating' || state === 'waiting_children' || state === 'retry_wait') {
        recovered = created.inputsDigest === record.digest;
        if (created.lease !== null) await revokeUnitLease(database, { unitId: record.unit, generation, fence: created.lease.fence, at });
        await step('the invalidation of an attempt that never ended', record, async () => await advanceUnit(database, {
          unitId: record.unit,
          event: { type: 'invalidate', at, replacement: generation + 1, cause: `an attempt that never ended was recovered by the writer's next run: ${state}` },
        }));
        state = 'stale';
      }
      if (state === 'published' && created.inputsDigest !== record.digest) {
        // What a person read is the record of the inputs it was written from (0027): a unit whose inputs moved
        // is marked stale and replaced by its next generation, never edited in place.
        await step('the invalidation', record, async () => await advanceUnit(database, {
          unitId: record.unit,
          event: { type: 'invalidate', at, replacement: generation + 1, cause: `the unit's inputs moved: ${created.inputsDigest} is now ${record.digest}` },
        }));
        state = 'stale';
      }
      if (state === 'stale') {
        const replaced = await replaceStaleGeneration(database, { unitId: record.unit, runId: options.runId, inputsDigest: record.digest, retries: 0, at });
        if (!replaced.ok) {
          throw new Error(`src/writer/graph-state.ts: the replacement of the stale unit ${JSON.stringify(record.unit)} was refused by the fill's unit machine: ${replaced.refusal.code}: ${replaced.refusal.reason} (table fill_unit_generation, unit ${record.unit})`);
        }
        generation = replaced.record.generation;
        state = 'planned';
      }
      if (state === 'planned') {
        await step('the admission', record, async () => await advanceUnit(database, { unitId: record.unit, event: { type: 'admit', at, generation } }));
        state = 'ready';
      } else if (state === 'blocked') {
        await step('the resolution of a blocked generation', record, async () => await advanceUnit(database, { unitId: record.unit, event: { type: 'unblock', at, generation, resolution: `the writer takes the unit up again: ${record.digest}` } }));
        await step('the admission of a resolved generation', record, async () => await advanceUnit(database, { unitId: record.unit, event: { type: 'admit', at, generation } }));
        state = 'ready';
      }
      if (state !== 'ready') {
        // A generation a previous run left leased, running, drafting or validating is an attempt that never
        // ended; the orchestrator's own sweep retries such an attempt for every state it holds a lease in
        // (0027's amendment of 2026-10-18), and the writer does not advance it behind that sweep's back.
        throw new Error(`src/writer/graph-state.ts: the unit ${JSON.stringify(record.unit)} is ${state} in the fill's unit tables (fill_unit_generation, unit ${record.unit}, generation ${generation}): an attempt that never ended holds it, and the fill's own sweep retries a lapsed lease before the writer writes the unit's page again`);
      }
      const leased = await leaseUnit(database, { unitId: record.unit, holder: `writer:${options.runId}`, ttlMs: 30 * 60 * 1000, at });
      if (!leased.ok) {
        throw new Error(`src/writer/graph-state.ts: the lease of the unit ${JSON.stringify(record.unit)} was refused by the fill's unit machine: ${leased.refusal.code}: ${leased.refusal.reason} (table fill_unit_lease, unit ${record.unit})`);
      }
      await step('the start', record, async () => await advanceUnit(database, { unitId: record.unit, event: { type: 'start', at, generation, fence: leased.record.context.fence } }));
      return { opened: true, recovered };
    },
    async publish(record, at) {
      const current = (await readProductUnits(database, { product: options.product, state: 'running' })).find((unit) => unit.unitId === record.unit);
      if (current === undefined) {
        throw new Error(`src/writer/graph-state.ts: the unit ${JSON.stringify(record.unit)} is not running in the fill's unit tables, so its publication names no attempt: the run that opened it is gone (table fill_unit_generation, unit ${record.unit})`);
      }
      const generation = current.generation;
      const fence = current.context.fence;
      await step('the draft', record, async () => await advanceUnit(database, { unitId: record.unit, event: { type: 'submit-draft', at, generation, fence } }));
      await step('the validation', record, async () => await advanceUnit(database, { unitId: record.unit, event: { type: 'validate-draft', at, generation, fence } }));
      await step('the publication', record, async () => await advanceUnit(database, { unitId: record.unit, event: { type: 'publish', at, generation, fence, readsFresh: true } }));
    },
    async blocked(record, reason, at) {
      const states: UnitRecord['state'][] = ['running', 'draft', 'ready'];
      for (const state of states) {
        const current = (await readProductUnits(database, { product: options.product, state })).find((unit) => unit.unitId === record.unit);
        if (current === undefined) continue;
        await step('the block', record, async () => await advanceUnit(database, {
          unitId: record.unit,
          event: { type: 'block', at, generation: current.generation, fence: current.context.fence, reason },
        }));
        return;
      }
      // Nothing of this run's holds the unit: an earlier run's record stands, and the run says so through its
      // own report rather than writing a state it does not own.
    },
  };
}

