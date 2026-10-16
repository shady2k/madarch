/**
 * File-backed contracts and resume primitives for the self-filling pipeline.
 * Product kinds and extraction rules are deliberately supplied by the registry.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const FILL_STATE_VERSION = 1;
export const FILL_STAGES = ['inventory', 'index', 'claims', 'code-map', 'synthesis', 'question-review'] as const;
export type FillStage = typeof FILL_STAGES[number];
export const FILL_UNIT_STATUSES = ['pending', 'running', 'complete', 'blocked', 'stale'] as const;
export type FillUnitStatus = typeof FILL_UNIT_STATUSES[number];
export type FillRunStatus = 'running' | 'paused' | 'stopped' | 'complete' | 'blocked';

/** Persisted manifest at .madarch/fill/run.json. */
export interface FillRun {
  schemaVersion: number;
  id: string;
  productSnapshot: { repository: string; defaultBranch: string; commit: string; registryHash: string };
  agentBranch: string;
  status: FillRunStatus;
  createdAt: string;
  updatedAt: string;
}
/** One stable piece of work, persisted as .madarch/fill/units/<id>.json. */
export interface FillUnit {
  id: string;
  stage: FillStage;
  inputHashes: Record<string, string>;
  status: FillUnitStatus;
  outputPaths: string[];
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  dependencies?: string[];
  agentUsage?: { elapsedMs?: number; inputTokens?: number; outputTokens?: number; estimatedCost?: number };
}
/** Normalized event consumed by the live progress view. */
export interface FillEvent {
  runId: string;
  stage: FillStage;
  unitId: string;
  seq: number;
  at: string;
  type: 'unit-started' | 'unit-progress' | 'unit-complete' | 'unit-blocked' | 'unit-stale' | 'stage-complete' | 'run-paused' | 'run-stopped';
  summary: string;
  usage?: FillUnit['agentUsage'];
}
export interface FillStageCounts { pending: number; running: number; complete: number; blocked: number; stale: number }
export interface FillRunCounts { stages: Record<FillStage, FillStageCounts>; reused: number; run: number }
export interface FillUnitPlan extends Pick<FillUnit, 'id' | 'stage' | 'inputHashes' | 'outputPaths' | 'dependencies'> {}
export interface FillUnitExecutor { execute(unit: FillUnit, signal: AbortSignal): Promise<{ outputPaths?: string[]; agentUsage?: FillUnit['agentUsage'] }> }
export interface FillOrchestrationHooks {
  /** Called after each stage drains; return hashes from the current default-branch snapshot. */
  refreshInputs?: (stage: FillStage, units: readonly FillUnit[]) => Promise<Record<string, Record<string, string>>>;
  /** Commit completed stage outputs on the isolated product branch; a human edit must return conflict. */
  commitStage?: (stage: FillStage, completed: readonly FillUnit[]) => Promise<'clean' | 'conflict'>;
  /** Receives a fully sequenced event suitable for appending to events.jsonl. */
  appendEvent?: (event: FillEvent) => Promise<void>;
}

const now = (): string => new Date().toISOString();
const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Hash a pinned Git tree entry (or blob); callers include registry and upstream-output hashes as named inputs. */
export function hashFillInput(bytes: string | Uint8Array): string { return digest(bytes); }
export function hashFillInputs(inputs: Readonly<Record<string, string | Uint8Array>>): Record<string, string> {
  return Object.fromEntries(Object.keys(inputs).sort().map((key) => [key, digest(inputs[key]!) ]));
}
export function fillInputsMatch(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(left).sort();
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/** Write JSON durably via a sibling temporary file and rename; readers never observe a partial document. */
export async function writeFillJsonAtomic<T>(file: string, value: T): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    const handle = await import('node:fs/promises').then(({ open }) => open(temporary, 'r'));
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await import('node:fs/promises').then(({ open }) => open(dirname(file), 'r'));
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await import('node:fs/promises').then(({ unlink }) => unlink(temporary).catch(() => undefined));
    throw error;
  }
}
export async function readFillJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
/** Append an event using whole-file temp+rename so a crash cannot leave a torn journal line. */
export async function appendFillEventAtomic(file: string, event: FillEvent): Promise<void> {
  let previous = '';
  try { previous = await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${previous}${JSON.stringify(event)}\n`, { flag: 'wx' });
    const handle = await import('node:fs/promises').then(({ open }) => open(temporary, 'r'));
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await import('node:fs/promises').then(({ open }) => open(dirname(file), 'r'));
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await import('node:fs/promises').then(({ unlink }) => unlink(temporary).catch(() => undefined));
    throw error;
  }
}
export function fillStatePaths(productRoot: string): { root: string; run: string; units: string; outputs: string; events: string } {
  const root = resolve(productRoot, '.madarch', 'fill');
  return { root, run: join(root, 'run.json'), units: join(root, 'units'), outputs: join(root, 'outputs'), events: join(root, 'events.jsonl') };
}
function fillFileKey(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error(`Invalid fill state id: ${JSON.stringify(id)}`);
  return id;
}
export async function persistFillRun(productRoot: string, run: FillRun): Promise<void> {
  await writeFillJsonAtomic(fillStatePaths(productRoot).run, { ...run, updatedAt: now() });
}
export async function persistFillUnit(productRoot: string, unit: FillUnit): Promise<void> {
  const paths = fillStatePaths(productRoot);
  await writeFillJsonAtomic(join(paths.units, `${fillFileKey(unit.id)}.json`), { ...unit, updatedAt: now() });
}
export function createFillRun(input: Omit<FillRun, 'schemaVersion' | 'id' | 'status' | 'createdAt' | 'updatedAt'>, id: string = randomUUID()): FillRun {
  const timestamp = now();
  return { ...input, schemaVersion: FILL_STATE_VERSION, id, status: 'running', createdAt: timestamp, updatedAt: timestamp };
}
export function createFillUnit(plan: FillUnitPlan, timestamp = now()): FillUnit {
  return { ...plan, dependencies: plan.dependencies ?? [], status: 'pending', attempt: 0, createdAt: timestamp, updatedAt: timestamp };
}
/** Completed units survive only if every declared input (including upstream outputs) is still identical. */
export function reconcileFillUnit(unit: FillUnit, currentInputHashes: Readonly<Record<string, string>>, timestamp = now()): FillUnit {
  if (unit.status === 'running') return { ...unit, status: 'pending', updatedAt: timestamp, startedAt: undefined, finishedAt: undefined, error: undefined };
  if (unit.status === 'complete' && !fillInputsMatch(unit.inputHashes, currentInputHashes)) return { ...unit, inputHashes: { ...currentInputHashes }, status: 'stale', updatedAt: timestamp };
  if (unit.status === 'stale') return { ...unit, inputHashes: { ...currentInputHashes }, status: 'pending', updatedAt: timestamp };
  return unit;
}
export function countFillUnits(units: readonly FillUnit[]): FillRunCounts {
  const stages = Object.fromEntries(FILL_STAGES.map((stage) => [stage, { pending: 0, running: 0, complete: 0, blocked: 0, stale: 0 }])) as Record<FillStage, FillStageCounts>;
  for (const unit of units) stages[unit.stage][unit.status]++;
  return { stages, reused: units.filter((unit) => unit.status === 'complete').length, run: units.filter((unit) => unit.attempt > 0).length };
}
export type FillControl = 'running' | 'paused' | 'stopped';
/** Run dependency-ready units; pause drains active work, stop aborts active work and dispatches nothing else. */
export async function orchestrateFillUnits(
  run: FillRun,
  planned: readonly FillUnitPlan[],
  existing: readonly FillUnit[],
  executor: FillUnitExecutor,
  persist: (unit: FillUnit) => Promise<void>,
  emit: (event: FillEvent) => Promise<void>,
  control: () => FillControl = () => 'running',
  hooks: FillOrchestrationHooks = {},
): Promise<FillUnit[]> {
  const records = new Map(existing.map((unit) => [unit.id, unit]));
  const stagePrerequisites: Record<FillStage, FillStage[]> = {
    inventory: [], index: ['inventory'], claims: ['index'], 'code-map': ['index'],
    synthesis: ['claims', 'code-map'], 'question-review': ['synthesis'],
  };
  const stageUnits = new Map<FillStage, string[]>();
  for (const plan of planned) stageUnits.set(plan.stage, [...(stageUnits.get(plan.stage) ?? []), plan.id]);
  const effectivePlans = planned.map((plan) => ({
    ...plan,
    dependencies: [...new Set([...(plan.dependencies ?? []), ...stagePrerequisites[plan.stage].flatMap((stage) => stageUnits.get(stage) ?? [])])],
  }));
  const plans = new Map(effectivePlans.map((plan) => [plan.id, plan]));
  const units = new Map<string, FillUnit>();
  for (const plan of effectivePlans) {
    const found = records.get(plan.id);
    const unit = found ? reconcileFillUnit({ ...found, dependencies: plan.dependencies }, plan.inputHashes) : createFillUnit(plan);
    units.set(plan.id, unit);
  }
  let sequence = 0;
  let eventQueue = Promise.resolve();
  const send = (event: Omit<FillEvent, 'runId' | 'seq' | 'at'>): Promise<void> => {
    const full: FillEvent = { ...event, runId: run.id, seq: ++sequence, at: now() };
    eventQueue = eventQueue.then(async () => { await hooks.appendEvent?.(full); await emit(full); });
    return eventQueue;
  };
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const startedStages = new Set<FillStage>();
  const finishedStages = new Set<FillStage>();
  const start = (unit: FillUnit) => {
    const controller = new AbortController();
    const started: FillUnit = { ...unit, status: 'running', attempt: unit.attempt + 1, startedAt: now(), finishedAt: undefined, error: undefined, updatedAt: now() };
    units.set(unit.id, started);
    startedStages.add(unit.stage);
    const promise = (async () => {
      await persist(started);
      await send({ stage: started.stage, unitId: started.id, type: 'unit-started', summary: 'Unit started' });
      try {
        const result = await executor.execute(started, controller.signal);
        const complete: FillUnit = { ...started, status: 'complete', outputPaths: result.outputPaths ?? started.outputPaths, agentUsage: result.agentUsage, finishedAt: now(), updatedAt: now() };
        units.set(started.id, complete);
        await persist(complete);
        await send({ stage: started.stage, unitId: started.id, type: 'unit-complete', summary: 'Unit complete', usage: complete.agentUsage });
      } catch (error) {
        const stopped = controller.signal.aborted;
        const failed: FillUnit = { ...started, status: stopped ? 'pending' : 'blocked', error: stopped ? undefined : String(error), finishedAt: stopped ? undefined : now(), updatedAt: now() };
        units.set(started.id, failed);
        await persist(failed);
        if (!stopped) await send({ stage: started.stage, unitId: started.id, type: 'unit-blocked', summary: String(error) });
      }
    })();
    active.set(unit.id, { controller, promise });
    void promise.finally(() => active.delete(unit.id));
  };
  while (true) {
    const state = control();
    if (state === 'stopped') for (const entry of active.values()) entry.controller.abort();
    if (state === 'running') {
      for (const unit of units.values()) {
        if ((unit.status !== 'pending' && unit.status !== 'stale') || active.has(unit.id) || finishedStages.has(unit.stage)) continue;
        const prerequisites = stagePrerequisites[unit.stage];
        const dependencies = unit.dependencies ?? plans.get(unit.id)?.dependencies ?? [];
        const prerequisitesComplete = prerequisites.every((stage) => (stageUnits.get(stage) ?? []).every((id) => units.get(id)?.status === 'complete'));
        if (prerequisitesComplete && dependencies.every((id) => units.get(id)?.status === 'complete')) start(unit);
      }
    }
    if (active.size === 0) {
      // At a stage boundary, check the default branch and invalidate only units declaring changed inputs.
      let boundaryChanged = false;
      for (const stage of FILL_STAGES) {
        if (!startedStages.has(stage) || finishedStages.has(stage)) continue;
        if ([...units.values()].some((unit) => unit.stage === stage && (unit.status === 'pending' || unit.status === 'running' || unit.status === 'stale'))) continue;
        const completed = [...units.values()].filter((unit) => unit.stage === stage && unit.status === 'complete');
        if (hooks.commitStage && completed.length && await hooks.commitStage(stage, completed) === 'conflict') {
          for (const unit of completed) {
            const blocked: FillUnit = { ...unit, status: 'blocked', error: 'human-edit-wins', updatedAt: now(), finishedAt: now() };
            units.set(unit.id, blocked);
            await persist(blocked);
            await send({ stage, unitId: unit.id, type: 'unit-blocked', summary: 'Human edit preserved; stage needs review' });
          }
        }
        const current = await hooks.refreshInputs?.(stage, [...units.values()]);
        if (current) for (const unit of units.values()) {
          const hashes = current[unit.id];
          if (hashes && (unit.status === 'complete' || unit.status === 'pending') && !fillInputsMatch(unit.inputHashes, hashes)) {
            const stale: FillUnit = { ...unit, inputHashes: hashes, status: 'stale', updatedAt: now() };
            units.set(unit.id, stale);
            finishedStages.delete(unit.stage);
            await persist(stale);
            await send({ stage: unit.stage, unitId: unit.id, type: 'unit-stale', summary: 'Declared inputs changed at stage boundary' });
            boundaryChanged = true;
          }
        }
        if (!boundaryChanged) {
          finishedStages.add(stage);
          await send({ stage, unitId: completed[0]?.id ?? '', type: 'stage-complete', summary: `${stage} stage complete` });
        }
      }
      const unfinished = [...units.values()].some((unit) => unit.status === 'pending' || unit.status === 'running' || unit.status === 'stale');
      if (unfinished && state === 'running' && !boundaryChanged) {
        for (const unit of units.values()) if (unit.status === 'pending' && (unit.dependencies ?? []).some((id) => units.get(id)?.status !== 'complete')) {
          const blocked: FillUnit = { ...unit, status: 'blocked', error: 'A dependency did not complete', updatedAt: now(), finishedAt: now() };
          units.set(unit.id, blocked);
          await persist(blocked);
        }
      }
      if (boundaryChanged || (state === 'running' && [...units.values()].some((unit) => (unit.status === 'pending' || unit.status === 'stale') && stagePrerequisites[unit.stage].every((stage) => (stageUnits.get(stage) ?? []).every((id) => units.get(id)?.status === 'complete')) && (unit.dependencies ?? []).every((id) => units.get(id)?.status === 'complete')))) continue;
      break;
    }
    await Promise.race([...active.values()].map((entry) => entry.promise));
  }
  if (control() === 'stopped') await send({ stage: 'inventory', unitId: '', type: 'run-stopped', summary: 'Run stopped; active work was aborted' });
  else if (control() === 'paused') await send({ stage: 'inventory', unitId: '', type: 'run-paused', summary: 'Dispatch paused after active work drained' });
  return [...units.values()];
}
