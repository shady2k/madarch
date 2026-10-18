/**
 * The crash-injection suite's own fixture (madarch-tzte.19.6): the scratch folder
 * a run stands in, the three seams the suite moves by hand (the clock, the pinned
 * graph and the named inputs), the product manifest its fill configuration is
 * read from, and the driver process one phase of the suite is.
 *
 * The driver (`test/fill-crash-driver.ts`, built with `bun build --compile`) has
 * the contract this module holds to: each phase reads the spec file it was given,
 * prints one JSON object on a line of its own and exits 0 — or prints
 * `{"event":"crash",…}` and kills itself, or `{"event":"pause",…}` and waits for a
 * byte on its standard input. Nothing here asserts: the test files hold what they
 * expect and take it from the task and the decisions.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pgliteAssetFiles } from '../scripts/pglite-assets.js';
import type { DriverPhase, DriverSpec, Interrupt } from './fill-crash-driver.js';

/** The driver's own source, as the build takes it. */
export const DRIVER_SOURCE = 'test/fill-crash-driver.ts';

/** Builds the driver into one compiled binary inside `folder` and answers its path. */
export function buildCrashBinary(folder: string, cwd: string): string {
  const binary = join(folder, 'fill-crash');
  const build = spawnSync('bun', [
    'build', '--compile', join(cwd, DRIVER_SOURCE),
    ...pgliteAssetFiles().flatMap((file) => ['--asset', file]),
    '--outfile', binary,
  ], { encoding: 'utf8', cwd });
  const said = `${build.stdout ?? ''}${build.stderr ?? ''}`.trim();
  if (build.status !== 0) {
    throw new Error(`the crash suite's binary could not be built (exit ${String(build.status)}, cwd ${cwd}): ${said}`);
  }
  return binary;
}

/** One JSON line a phase printed. */
export interface PhaseLine {
  readonly event: string;
  readonly [key: string]: unknown;
}

/** One finished phase: what it printed and how it ended. */
export interface PhaseRun {
  readonly code: number | null;
  readonly signal: string | null;
  readonly lines: readonly PhaseLine[];
  readonly stderr: string;
}

/** The options a test names for one phase, beside the phase itself. */
export interface PhaseOptions {
  readonly interrupt?: Interrupt;
  readonly limits?: Record<string, unknown>;
  readonly runId?: string;
  readonly product?: string;
  /** One PostgreSQL server and schema to run against; left out, the suite's own PGlite folder. */
  readonly postgres?: { readonly connectionString: string; readonly schema: string; readonly queueSchema: string };
}

/** What a test does to the world between phases: the seams, the manifest and the spec. */
export class CrashFixture {
  private readonly specs: string[] = [];
  private clockAt = 1_700_000_000_000;
  private specCount = 0;
  private readonly graph: Record<string, readonly unknown[]> = {
    files: [{ id: 'src', scope: 'src' }, { id: 'docs', scope: 'docs' }],
    'symbols:src': [{ symbol: 'a' }, { symbol: 'b' }],
    'symbols:docs': [{ symbol: 'c' }],
    'summaries:the repository': [{ module: 'root' }],
    'summaries:the left half': [{ module: 'left' }],
    'summaries:the right half': [{ module: 'right' }],
    'product-facts': [{ product: 'the fixture' }],
  };
  private inputs: Record<string, Record<string, string>> = { '*': { commit: 'c1' } };

  constructor(readonly folder: string, readonly binary: string) {
    mkdirSync(join(folder, 'product'), { recursive: true });
    mkdirSync(join(folder, 'database'), { recursive: true });
    this.write('clock', String(this.clockAt));
    this.write('graph.json', JSON.stringify(this.graph, null, 1));
    this.write('inputs.json', JSON.stringify(this.inputs, null, 1));
  }

  private write(name: string, text: string): string {
    const file = join(this.folder, name);
    writeFileSync(file, text);
    return file;
  }

  /** The epoch milliseconds every phase's clock answers. */
  clock(): number {
    return this.clockAt;
  }

  /** Sets the suite's clock: a lease expires and a retry comes due by moving this, never by waiting. */
  setClock(at: number): void {
    this.clockAt = at;
    this.write('clock', String(at));
  }

  /** Moves the suite's clock forward. */
  advanceClock(by: number): void {
    this.setClock(this.clockAt + by);
  }

  /** Sets one query's rows in the pinned graph; the rows of a query left out stay as they stand. */
  setGraph(query: string, rows: readonly unknown[]): void {
    this.graph[query] = rows;
    this.write('graph.json', JSON.stringify(this.graph, null, 1));
  }

  /** Replaces what one unit's facts stand on, which moves that unit's named inputs. */
  setInputs(unitId: string, inputs: Record<string, string>): void {
    this.inputs = { ...this.inputs, [unitId]: inputs };
    this.write('inputs.json', JSON.stringify(this.inputs, null, 1));
  }

  /** Writes the product's manifest, or removes it so the product configures no stage. */
  manifest(text: string | null): void {
    if (text === null) {
      rmSync(join(this.folder, 'product', 'workspace.yaml'), { force: true });
      return;
    }
    writeFileSync(join(this.folder, 'product', 'workspace.yaml'), text);
  }

  /** Writes one phase's spec file and answers its path. */
  spec(phase: DriverPhase, options: PhaseOptions = {}): string {
    this.specCount += 1;
    const runId = options.runId ?? 'crash-run';
    const storage: DriverSpec['storage'] = options.postgres === undefined
      ? { kind: 'pglite', folder: join(this.folder, 'database') }
      : { kind: 'postgres', connectionString: options.postgres.connectionString, schema: options.postgres.schema };
    const spec: DriverSpec = {
      storage,
      queueSchema: options.postgres?.queueSchema ?? 'pgboss',
      clockFile: join(this.folder, 'clock'),
      graphFile: join(this.folder, 'graph.json'),
      inputsFile: join(this.folder, 'inputs.json'),
      product: options.product ?? 'crash-fixture',
      productFolder: join(this.folder, 'product'),
      runId,
      ...(options.limits === undefined ? {} : { limits: options.limits as DriverSpec['limits'] }),
      ...(options.interrupt === undefined ? {} : { interrupt: options.interrupt }),
      phase,
    };
    const file = this.write(`spec-${this.specCount}-${phase.kind}.json`, JSON.stringify(spec, null, 1));
    this.specs.push(file);
    return file;
  }

  /** Runs one phase to its end and answers what it printed. */
  async phase(phase: DriverPhase, options: PhaseOptions = {}): Promise<PhaseRun> {
    const driver = this.start(phase, options);
    return await driver.wait();
  }

  /** Starts one phase and answers the process, for a phase that pauses or one of several at once. */
  start(phase: DriverPhase, options: PhaseOptions = {}): CrashDriver {
    return new CrashDriver(this.binary, this.spec(phase, options));
  }
}

/** One driver process, read line by line so a phase that pauses can be driven. */
export class CrashDriver {
  private readonly process: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>;
  private readonly lines: PhaseLine[] = [];
  private readonly pending: string[] = [];
  private waiting: (() => void) | undefined;
  private buffer = '';
  private errors = '';
  private done = false;
  private readonly finished: Promise<void>;

  constructor(binary: string, specFile: string) {
    this.process = Bun.spawn([binary, specFile], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    this.finished = this.pump();
  }

  private async pump(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const end = this.buffer.indexOf('\n');
        if (end < 0) break;
        this.pending.push(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + 1);
        this.waiting?.();
      }
    }
  }

  private async stderrText(): Promise<string> {
    const decoder = new TextDecoder();
    const reader = this.process.stderr.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.errors += decoder.decode(value, { stream: true });
    }
    return this.errors;
  }

  /** The next line the phase printed, waiting for it and refusing to wait for ever. */
  async nextLine(deadlineMs = 60_000): Promise<PhaseLine> {
    const start = Date.now();
    for (;;) {
      const text = this.pending.shift();
      if (text !== undefined) {
        const line = JSON.parse(text) as PhaseLine;
        this.lines.push(line);
        return line;
      }
      if (this.done) throw new Error(`the driver printed no further line and has ended; it printed ${JSON.stringify(this.lines)} and said on stderr: ${await this.stderrText()}`);
      if (Date.now() - start > deadlineMs) throw new Error(`the driver printed no line within ${String(deadlineMs)} ms; it printed ${JSON.stringify(this.lines)} and said on stderr: ${await this.stderrText()}`);
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
        setTimeout(resolve, 25);
      });
      this.waiting = undefined;
    }
  }

  /** Writes one byte on the process's standard input, which is how a paused phase carries on. */
  send(): void {
    void this.process.stdin.write('go');
    void this.process.stdin.flush();
  }

  /**
   * Waits for the process to end and answers what it printed and how it ended.
   * A phase that hangs — one waiting for a byte nobody sends, or one waiting on a
   * lock — is killed at the deadline and named, so a test fails with what happened
   * rather than with the runner's own timeout.
   */
  async wait(deadlineMs = 120_000): Promise<PhaseRun> {
    let expired = false;
    const deadline = setTimeout(() => { expired = true; }, deadlineMs);
    const [code] = await Promise.all([this.process.exited, this.finished]);
    clearTimeout(deadline);
    if (expired) {
      this.kill();
      throw new Error(`the phase did not end within ${String(deadlineMs)} ms and was killed; it printed ${JSON.stringify(this.lines)} and said on stderr: ${this.errors}`);
    }
    this.done = true;
    await this.stderrText();
    for (const text of this.pending) this.lines.push(JSON.parse(text) as PhaseLine);
    this.pending.length = 0;
    return { code, signal: this.process.signalCode ?? null, lines: [...this.lines], stderr: this.errors };
  }

  /** Kills the process where it stands. */
  kill(): void {
    this.process.kill('SIGKILL');
  }
}


// ---- the report a phase prints ---------------------------------------------

/** One unit as the report prints it. */
export interface ReportedUnit {
  readonly unitId: string;
  readonly stageId: string;
  readonly state: string;
  readonly generation: number;
  readonly attempt: number;
  readonly fence: number;
  readonly inputsDigest: string;
  readonly publishedAt: number | null;
  readonly staleAt: number | null;
}

/** One generation as the report prints it, older generations included. */
export interface ReportedGeneration {
  readonly unitId: string;
  readonly generation: number;
  readonly state: string;
  readonly attempt: number;
  readonly fence: number;
}

/** One publication record, one fact row and one sealed child, as the report prints them. */
export interface ReportedPublication { readonly unitId: string; readonly generation: number; readonly digest: string; readonly facts: number }
export interface ReportedFact { readonly unitId: string; readonly generation: number; readonly digest: string; readonly facts: number }
export interface ReportedSealed { readonly parentUnitId: string; readonly parentGeneration: number; readonly childUnitId: string; readonly childGeneration: number }
export interface ReportedTransition {
  readonly subject: string;
  readonly generation: number | null;
  readonly transition: string;
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly fence: number | null;
  readonly at: number;
}
export interface ReportedProgress { readonly seq: number; readonly at: number; readonly stage: string; readonly unitId: string; readonly generation: number | null; readonly kind: string; readonly summary: string }

/** The whole of one run, as the `report` phase prints it. */
export interface CrashReport {
  readonly event: 'report';
  readonly chain: { readonly product: string; readonly state: string; readonly context: Record<string, unknown> } | null;
  readonly configuration: { readonly digest: string; readonly snapshot: Record<string, unknown> } | null;
  readonly run: { readonly runId: string; readonly state: string; readonly context: Record<string, unknown> } | null;
  readonly units: readonly ReportedUnit[];
  readonly generations: readonly ReportedGeneration[];
  readonly publications: readonly ReportedPublication[];
  readonly facts: readonly ReportedFact[];
  readonly sealed: readonly ReportedSealed[];
  readonly childStates: readonly { readonly unitId: string; readonly generation: number; readonly state: string | null }[];
  readonly transitions: readonly ReportedTransition[];
  readonly progress: readonly ReportedProgress[];
  readonly queue: { readonly unfinished: number; readonly deadLetters: number };
}

/** The report one finished `report` phase printed, refusing anything else. */
export function reportOf(run: PhaseRun): CrashReport {
  const line = run.lines.find((one) => one.event === 'report');
  if (line === undefined) {
    throw new Error(`the report phase printed no report (exit ${String(run.code)}): ${run.lines.map((one) => JSON.stringify(one)).join(' ')} ${run.stderr}`);
  }
  return line as unknown as CrashReport;
}

/** The line one phase printed under its own event name, refusing anything else. */
export function lineOf(run: PhaseRun, event: string): PhaseLine {
  const line = run.lines.find((one) => one.event === event);
  if (line === undefined) {
    throw new Error(`the phase printed no "${event}" line (exit ${String(run.code)}): ${run.lines.map((one) => JSON.stringify(one)).join(' ')} ${run.stderr}`);
  }
  return line;
}

/** One unit's row in a report, raised where the report holds none. */
export function unitOf(report: CrashReport, unitId: string): ReportedUnit {
  const unit = report.units.find((one) => one.unitId === unitId);
  if (unit === undefined) throw new Error(`the report names no unit "${unitId}"; it names ${report.units.map((one) => one.unitId).join(', ')}`);
  return unit;
}

/**
 * The publications one report holds, by the unit generation they are of: a
 * generation published once is one entry, and a generation published twice is
 * two — which is what "exactly once per generation" is read from.
 */
export function publicationsByGeneration(report: CrashReport): Map<string, ReportedPublication[]> {
  const byKey = new Map<string, ReportedPublication[]>();
  for (const record of report.publications) {
    const key = `${record.unitId}/${String(record.generation)}`;
    byKey.set(key, [...(byKey.get(key) ?? []), record]);
  }
  return byKey;
}

/** The fact rows one report holds, by the unit generation they were applied for. */
export function factsByGeneration(report: CrashReport): Map<string, ReportedFact[]> {
  const byKey = new Map<string, ReportedFact[]>();
  for (const row of report.facts) {
    const key = `${row.unitId}/${String(row.generation)}`;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  return byKey;
}

/** The steps one subject took, in the order it took them. */
export function stepsOf(report: CrashReport, subject: string): string[] {
  return report.transitions.filter((step) => step.subject === subject).sort((left, right) => left.at - right.at).map((step) => step.transition);
}
