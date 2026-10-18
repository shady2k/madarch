/**
 * The fill's stage registry and the stage graph derived from it (decision
 * 0027). A stage is registered once by its module; the registry holds the
 * declared stages and nothing else. The graph is never declared: it is
 * derived from the stages' capabilities: every consume, required or optional,
 * draws an edge from each enabled stage that produces the capability to the
 * consumer, and an `after` names an optional ordering beside them. An optional
 * consume starves nothing — a capability nothing enabled produces is read as
 * absent, which is what "read when present" means — but where a producer runs
 * the consumer waits for it, so the presence it reads is the one of this run.
 *
 * The derivation refuses what it must name exactly: a cycle names its own
 * path (`a → b → a`), a starved consumer names the exact path
 * consumer → capability → producer, distinguishing a capability no stage
 * produces from one whose only producers the product's configuration
 * disabled, and a fault names what it is about. A fault of the product's
 * configuration names the manifest's full path, the 1-based line and the
 * field's path; a fault of a stage's own declaration names the stage and the
 * declared field, since a declaration is a module and not a file of the
 * product. A stage's own configuration is judged wherever its value came from:
 * the product writes one, or the stage's declared default stands, and a schema
 * neither satisfies refuses the graph before the stage could run unconfigured.
 * A full registry whose required capabilities are produced plans cleanly, in a
 * deterministic topological order (code point order breaking ties), and every
 * stage carries its resolved configuration — the stage's defaults with the
 * product's `fill.stages.<id>` spoken over them — so a run can snapshot what it
 * resolved, in the code point order of the stages whatever order the caller
 * holds them in.
 */
import { Value } from 'typebox/value';
import { canonicalJsonDigest } from '../model/canonical.js';
import { byCodePoint } from '../model/order.js';
import { lineOf, lineOfIndex } from '../product/manifest.js';
import { jsonPointerToSegments, segmentsToPath, type PathSegment } from '../model/yaml-position.js';
import { readFillStageConfiguration, type FillConfigError, type FillStageConfigurationRead } from './config.js';
import {
  DEFAULT_STAGE_LIMITS, STAGE_ID_PATTERN,
  type FillStage, type FillStageConfigurationEntry, type ResolvedStageConfiguration, type StageLimitOverrides, type StageLimits,
} from './stage.js';

// ---- the registry ----------------------------------------------------------

/** Holds the declared stages of the fill, each registered once by its module. */
export class StageRegistry {
  private readonly stages = new Map<string, FillStage>();

  /**
   * Registers one stage module. A second registration of one id and an id a
   * product's configuration could never name are both defects of the module,
   * refused where they are made rather than at the first plan.
   */
  register(stage: FillStage): this {
    if (!STAGE_ID_PATTERN.test(stage.id)) {
      throw new Error(`the stage id ${JSON.stringify(stage.id)} is not a stage id: a stage id starts with a letter and carries letters, digits, ".", "_" or "-"`);
    }
    const held = this.stages.get(stage.id);
    if (held !== undefined) {
      throw new Error(`the stage "${stage.id}" is registered twice (versions ${held.version} and ${stage.version}): each stage is registered once`);
    }
    this.stages.set(stage.id, stage);
    return this;
  }

  /** The stage registered under the id, or `undefined` when none is. */
  get(id: string): FillStage | undefined {
    return this.stages.get(id);
  }

  /** Every registered stage, in code point order of their ids. */
  all(): readonly FillStage[] {
    return [...this.stages.values()].sort((left, right) => byCodePoint(left.id, right.id));
  }
}

// ---- what deriving the stage graph gives -----------------------------------

/** One starved consumer, named by its exact path. */
export interface StarvationPath {
  /** The enabled stage that needs the capability. */
  consumer: string;
  /** The required capability nothing enabled provides. */
  capability: string;
  /** The stage that produces the capability and does not run; absent when no stage produces it at all. */
  producer?: string;
  /** `no-producer` when no stage produces the capability, `producer-disabled` when every producer is disabled. */
  reason: 'no-producer' | 'producer-disabled';
  /** The path itself, in the diagnostic's own words: `consumer → capability → producer`. */
  path: string;
}

/** One derived edge: the producer (or the earlier stage of an ordering) runs before the consumer. */
export interface StageGraphEdge {
  from: string;
  to: string;
  /** The capability the edge serves, or `after` for an ordering edge. */
  via: string;
}

/** A fault of a stage's declaration or of its configuration in the product. */
export interface StageProblem {
  /** The stage the problem is about. */
  stage: string;
  /** The manifest's full path; absent for a fault of the stage's own module declaration. */
  file?: string;
  /** The 1-based line in that file; absent with the file. */
  line?: number;
  /** The field's path: `fill.stages.inventory.config.size` in the manifest, `after[1]` in a declaration. */
  path: string;
  message: string;
}

/** A cycle of the derived graph, named by its path: first and last stage the same. */
export type StageCycle = readonly string[];

/** The derived graph a run plans from: every stage's resolved configuration, the enabled order and the edges. */
export interface DerivedStageGraph {
  /**
   * Every registered stage's resolved configuration and version, disabled
   * ones included with `enabled: false`, in code point order of their ids:
   * the run snapshots exactly what the product's configuration said.
   */
  stages: readonly ResolvedStageConfiguration[];
  /** The enabled stages in a deterministic topological order; work is admitted in this order. */
  order: readonly string[];
  /** The derived edges, producer → consumer, in code point order. */
  edges: readonly StageGraphEdge[];
}

/** What deriving the stage graph gave: a clean graph, or every refusal named. */
export type StageGraphRead =
  | { ok: true; graph: DerivedStageGraph }
  | {
    ok: false;
    /** The fill configuration's own refusals, each naming its file, line and path; empty when it read. */
    config: readonly FillConfigError[];
    /** Every stage whose declaration or own configuration does not read, each named where it stands. */
    problems: readonly StageProblem[];
    /** Every cycle found, each named by its own path, first and last the same stage. */
    cycles: readonly StageCycle[];
    /** Every starved consumer, each named by its exact path. */
    starvation: readonly StarvationPath[];
  };

/**
 * Derives the stage graph from the registry's declared stages and the
 * product's fill configuration. Leaving the configuration out reads as a
 * product that configures no stage: every stage's own defaults hold.
 */
export function deriveStageGraph(registry: StageRegistry, configuration?: FillStageConfigurationRead): StageGraphRead {
  const configRead = configuration ?? { ok: true as const, file: '', stages: {}, lines: {} };
  const stages = registry.all();

  // A fault is reported, never thrown: the whole graph is refused with every
  // fault named at once. The stages' own declarations are judged first, since
  // they hold whatever the product's configuration says; a configuration that
  // does not read refuses the graph before anything is derived from it, its
  // defaults standing for nothing the product agreed to.
  const problems: StageProblem[] = [];
  for (const stage of stages) problems.push(...declarationProblems(registry, stage));
  problems.push(...producedKindProblems(stages));
  if (!configRead.ok) return { ok: false, config: configRead.errors, problems, cycles: [], starvation: [] };

  // Each stage's resolved configuration, read from the product's entry for it
  // and judged whether or not the stage runs: a field nobody reads is a field
  // nobody fixed. An entry for a stage this madarch does not hold is never
  // judged, and never reaches the graph. The stage's own configuration is
  // judged too, whether the product wrote one or the stage's declared default
  // holds: a stage planned without a configuration its schema refuses would
  // fail inside `execute`, far from the manifest its author edited.
  const resolved = new Map<string, ResolvedStageConfiguration>();
  for (const stage of stages) {
    const raw = configRead.stages[stage.id];
    const at: EntryPlace | undefined = raw === undefined
      ? undefined
      : { file: configRead.file, line: configRead.lines[stage.id] ?? 1, path: `fill.stages.${stage.id}` };
    // An entry that did not read was named in `readStageConfiguration` and
    // says nothing here: the stage then stands on its own defaults, and the
    // configuration it will run with is that default, judged in its turn.
    const read = at === undefined ? undefined : readStageConfiguration(stage, raw, at, problems);
    judgeOwnConfiguration(stage, read, at, problems);
    resolved.set(stage.id, resolveStageConfiguration(stage, read?.entry));
  }
  const enabled = new Set([...resolved.values()].filter((stage) => stage.enabled).map((stage) => stage.id));

  // The capability table: which stages produce each capability, code point
  // order. Declared producers, not enabled ones: a disabled producer is what
  // a starvation path names.
  const producers = new Map<string, string[]>();
  for (const stage of stages) {
    for (const produced of stage.produces) {
      const held = producers.get(produced.kind) ?? [];
      if (!held.includes(stage.id)) held.push(stage.id);
      producers.set(produced.kind, held);
    }
  }
  for (const held of producers.values()) held.sort(byCodePoint);

  // The edges: every enabled consumer's capability draws an edge from each of
  // its enabled producers, whether the consume is required or optional — an
  // optional capability is read when a producer of this run publishes it, and
  // the consumer waiting for that producer is what makes it present. A
  // required capability no enabled stage produces starves the consumer, named
  // by its exact path; an optional one nothing produces is read as absent. A
  // stage that consumes the capability it produces reads what its own earlier
  // run published, so no edge runs from it to itself and it is not starved for
  // want of another producer.
  const edges: StageGraphEdge[] = [];
  const starvation: StarvationPath[] = [];
  for (const stage of stages) {
    if (!enabled.has(stage.id)) continue;
    // One need per capability, a required consume stating it over an optional
    // one, so a capability read twice orders the pair once.
    const needed = new Map<string, 'required' | 'optional'>();
    for (const consume of stage.consumes.required) if (!needed.has(consume.capability)) needed.set(consume.capability, 'required');
    for (const consume of stage.consumes.optional) if (!needed.has(consume.capability)) needed.set(consume.capability, 'optional');
    for (const [capability, need] of needed) {
      const all = producers.get(capability) ?? [];
      const running = all.filter((id) => enabled.has(id) && id !== stage.id);
      if (running.length > 0) {
        for (const producer of running) {
          edges.push({ from: producer, to: stage.id, via: capability });
        }
        continue;
      }
      if (need === 'optional') continue;
      if (all.length === 0) {
        starvation.push({
          consumer: stage.id,
          capability,
          reason: 'no-producer',
          path: `${stage.id} → ${capability} → no producer`,
        });
      } else if (!all.includes(stage.id)) {
        // Every producer is disabled: the path names each of them. A stage
        // that produces the capability itself is not one of them: it reads
        // what its own earlier run published.
        for (const producer of all) {
          starvation.push({
            consumer: stage.id,
            capability,
            producer,
            reason: 'producer-disabled',
            path: `${stage.id} → ${capability} → ${producer} (disabled)`,
          });
        }
      }
    }
    // The optional ordering: an edge only where both stages run. A stage
    // the product disabled orders nothing, and a pair a capability already
    // orders is not said twice.
    for (const earlier of stage.after ?? []) {
      if (earlier === stage.id || !enabled.has(earlier)) continue;
      if (edges.some((edge) => edge.from === earlier && edge.to === stage.id)) continue;
      edges.push({ from: earlier, to: stage.id, via: 'after' });
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const held = adjacency.get(edge.from) ?? [];
    held.push(edge.to);
    adjacency.set(edge.from, held);
  }
  for (const held of adjacency.values()) held.sort(byCodePoint);
  const cycles = findCycles([...enabled].sort(byCodePoint), adjacency);

  if (problems.length > 0 || cycles.length > 0 || starvation.length > 0) {
    return { ok: false, config: [], problems, cycles, starvation };
  }

  return {
    ok: true,
    graph: {
      stages: [...resolved.values()].sort((left, right) => byCodePoint(left.id, right.id)),
      order: topologicalOrder([...enabled].sort(byCodePoint), adjacency),
      edges: edges.sort((left, right) =>
        byCodePoint(left.from, right.from) || byCodePoint(left.to, right.to) || byCodePoint(left.via, right.via)),
    },
  };
}

/**
 * The stage's resolved configuration: the stage's own defaults with the
 * product's `fill.stages.<id>` spoken over them. The stage's own configuration
 * is the product's whole where it wrote one — a written `null` included, which
 * its schema then refuses — and the stage's declared default otherwise.
 */
export function resolveStageConfiguration(stage: FillStage, entry?: FillStageConfigurationEntry): ResolvedStageConfiguration {
  return {
    id: stage.id,
    version: stage.version,
    enabled: entry?.enabled ?? stage.defaults.enabled,
    concurrency: entry?.concurrency ?? stage.defaults.concurrency,
    limits: { ...DEFAULT_STAGE_LIMITS, ...stage.defaults.limits, ...entry?.limits },
    config: entry !== undefined && entry.config !== undefined ? entry.config : stage.defaults.config,
  };
}

/**
 * The run's snapshot of what it resolved: the configurations' canonical digest.
 * Canonical means the value follows the configurations and nothing else, so the
 * stages are taken in code point order of their ids whatever order the caller
 * holds them in: a publication's resolved inputs compared later must not differ
 * because a caller resolved them in another order.
 */
export function snapshotStageConfigurations(stages: readonly ResolvedStageConfiguration[]): string {
  const ordered = [...stages].sort((left, right) => byCodePoint(left.id, right.id));
  return canonicalJsonDigest(ordered.map((stage) => ({
    id: stage.id,
    version: stage.version,
    enabled: stage.enabled,
    concurrency: stage.concurrency,
    limits: stage.limits,
    config: stage.config ?? null,
  })));
}

// ---- reading one stage's configuration entry -------------------------------

/** Where an entry stands, so every fault of it names the file, the line and its path. */
interface EntryPlace {
  file: string;
  line: number;
  /** The entry's own path from the file's top: `fill.stages.<id>`. */
  path: string;
}

/** How one limit's written value is judged, and how its fault says what it wants. */
interface LimitRule {
  /** Whether the written value is a value of this limit, which is a number. */
  accepts(value: unknown): value is number;
  /** What the limit must be, as the fault says it after the field's path. */
  said: string;
}

/** A whole number of at least `least`. */
const wholeAtLeast = (least: number): LimitRule['accepts'] =>
  (value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= least;

/** A fraction strictly between 0 and 1. */
const fraction: LimitRule['accepts'] =
  (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;

/**
 * Every limit's own rule, keyed by the limit's name: a limit added to
 * `StageLimits` needs its rule here, or the compiler refuses this table, so a
 * limit can never fall into the unknown-name branch and be dropped in silence.
 */
const LIMIT_RULES: Readonly<Record<keyof StageLimits, LimitRule>> = {
  contextTokens: { accepts: wholeAtLeast(0), said: 'a whole number of 0 or more' },
  maxTurns: { accepts: wholeAtLeast(0), said: 'a whole number of 0 or more' },
  maxOutputTokens: { accepts: wholeAtLeast(0), said: 'a whole number of 0 or more' },
  maxDurationMs: { accepts: wholeAtLeast(1), said: 'a whole number of 1 or more' },
  wrapAtFraction: { accepts: fraction, said: 'a fraction between 0 and 1' },
  stopAtFraction: { accepts: fraction, said: 'a fraction between 0 and 1' },
};

/** One stage's entry as it read: what it says, and where the product wrote its own configuration. */
interface StageEntryRead {
  /** The fields the entry sets; a field that did not read is left out, its fault already named. */
  entry: FillStageConfigurationEntry;
  /** The 1-based line of the `config` field, when the product wrote one. */
  configLine?: number;
}

/**
 * Reads one stage's entry as the product wrote it, judging `enabled`,
 * `concurrency` and `limits` and each limit's own value. Every fault is pushed
 * onto `problems` at the field's own line and path; what reads is the stage's
 * configuration entry, and the line of its own `config` field so that the
 * configuration is judged where the product can see it. A field or a limit name
 * this madarch does not know is read past, the manifest's own rule for a field
 * it does not know.
 */
function readStageConfiguration(
  stage: FillStage,
  raw: unknown,
  at: EntryPlace,
  problems: StageProblem[],
): StageEntryRead | undefined {
  const fault = (line: number, path: string, message: string): void => {
    problems.push({ stage: stage.id, file: at.file, line, path, message });
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fault(at.line, at.path, `${at.path} is a mapping of the stage's configuration, not ${shown(raw)}`);
    return undefined;
  }
  const fields = raw as Record<string, unknown>;
  const entry: FillStageConfigurationEntry = {};

  const enabled = fields['enabled'];
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') {
      fault(lineOf(fields, 'enabled'), `${at.path}.enabled`, `${at.path}.enabled is true or false, not ${shown(enabled)}`);
    } else {
      entry.enabled = enabled;
    }
  }
  const concurrency = fields['concurrency'];
  if (concurrency !== undefined) {
    if (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1) {
      fault(lineOf(fields, 'concurrency'), `${at.path}.concurrency`, `${at.path}.concurrency is a whole number of 1 or more, not ${shown(concurrency)}`);
    } else {
      entry.concurrency = concurrency;
    }
  }
  const limits = fields['limits'];
  if (limits !== undefined) {
    if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
      fault(lineOf(fields, 'limits'), `${at.path}.limits`, `${at.path}.limits is a mapping of limit names to their values, not ${shown(limits)}`);
    } else {
      entry.limits = readLimitOverrides(limits as Record<string, unknown>, at, fault);
    }
  }
  if (!('config' in fields)) return { entry };
  entry.config = fields['config'];
  return { entry, configLine: lineOf(fields, 'config') };
}

/**
 * Judges the stage's own configuration against the stage's `configSchema`,
 * wherever the value it will run with came from. A value the product wrote is a
 * fault of the manifest: the fault names the manifest's full path, the line of
 * the value — the `config` field's own line where the value is the field's
 * whole — and the field's path from the file's top. A value the stage declares
 * as its default is a fault of the stage's module: it names the stage and
 * `defaults.config`, since no product's manifest can be blamed for a default
 * the stage brought itself, and the manifest's `fill.stages.<id>.config` is
 * where the product may replace that default.
 */
function judgeOwnConfiguration(
  stage: FillStage,
  read: StageEntryRead | undefined,
  at: EntryPlace | undefined,
  problems: StageProblem[],
): void {
  const written = read === undefined || read.entry.config === undefined || at === undefined
    ? undefined
    : { value: read.entry.config, at, line: read.configLine ?? at.line };
  const value = written === undefined ? stage.defaults.config : written.value;
  for (const error of Value.Errors(stage.configSchema, value)) {
    const segments = jsonPointerToSegments(error.instancePath);
    const inside = segmentsToPath(segments);
    if (written === undefined) {
      problems.push({
        stage: stage.id,
        path: inside === '' ? 'defaults.config' : `defaults.config.${inside}`,
        message: `${error.message}; the product's fill.stages.${stage.id}.config replaces the stage's default`,
      });
      continue;
    }
    const path = `${written.at.path}.config`;
    problems.push({
      stage: stage.id,
      file: written.at.file,
      line: lineAlong(written.value, segments, written.line),
      path: inside === '' ? path : `${path}.${inside}`,
      message: error.message,
    });
  }
}

/** The limits one entry overrides, each judged by its own kind; a name this madarch does not know is left out. */
function readLimitOverrides(
  limits: Record<string, unknown>,
  at: EntryPlace,
  fault: (line: number, path: string, message: string) => void,
): StageLimitOverrides {
  const read: StageLimitOverrides = {};
  for (const name of Object.keys(limits).sort(byCodePoint)) {
    const rule = (LIMIT_RULES as Readonly<Record<string, LimitRule | undefined>>)[name];
    // A limit name this madarch does not know is the manifest's own unknown
    // field: kept out, never a refusal, so a product's configuration written
    // for a later madarch still reads.
    if (rule === undefined) continue;
    const path = `${at.path}.limits.${name}`;
    const line = lineOf(limits, name);
    const value = limits[name];
    if (!rule.accepts(value)) {
      fault(line, path, `${path} is ${rule.said}, not ${shown(value)}`);
      continue;
    }
    read[name as keyof StageLimits] = value;
  }
  return read;
}

/**
 * The line a value's field stands on, following the path into the parsed
 * document; the line of the stage's entry where the path cannot be followed
 * (a field the stage's schema imagined, not one the file wrote).
 */
function lineAlong(value: unknown, segments: readonly PathSegment[], fallback: number): number {
  let at = value;
  let line = fallback;
  for (const segment of segments) {
    if (at === null || typeof at !== 'object') return line;
    if (typeof segment === 'number') {
      if (!Array.isArray(at)) return line;
      line = lineOfIndex(at, segment);
      at = at[segment];
    } else {
      line = lineOf(at, segment);
      at = (at as Record<string, unknown>)[segment];
    }
  }
  return line;
}

/** How one written value stands in a fault: as YAML would read it back. */
function shown(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

// ---- faults of the declared stages ----------------------------------------

/**
 * What the stage's own module declares and the graph cannot hold: an `after`
 * naming a stage the registry does not hold, or the stage itself. Both are
 * refused rather than ignored: a silently dropped ordering runs a stage too
 * early, which no later check can notice. The fault names the stage and the
 * declared field: a declaration is a module, not a file of the product.
 */
function declarationProblems(registry: StageRegistry, stage: FillStage): StageProblem[] {
  const problems: StageProblem[] = [];
  (stage.after ?? []).forEach((earlier, index) => {
    if (earlier === stage.id) {
      problems.push({
        stage: stage.id,
        path: `after[${index}]`,
        message: `the stage "${stage.id}" orders itself after "${earlier}": a stage cannot run after itself`,
      });
    } else if (registry.get(earlier) === undefined) {
      problems.push({
        stage: stage.id,
        path: `after[${index}]`,
        message: `the stage "${stage.id}" orders itself after "${earlier}", which the registry does not hold: register that stage or name one it has`,
      });
    }
  });
  return problems;
}

/**
 * What the stages declare about one fact kind and the publication cannot
 * honour: two producers of one kind at different schema versions, which
 * would mix two shapes of one kind under one name. A kind's `scope` and a
 * consume's `freshness` are judged where facts are published, not here: they
 * say what a publication replaces and what it rechecks.
 */
function producedKindProblems(stages: readonly FillStage[]): StageProblem[] {
  const versions = new Map<string, { stage: string; schemaVersion: number }[]>();
  for (const stage of stages) {
    for (const produced of stage.produces) {
      const held = versions.get(produced.kind) ?? [];
      if (!held.some((one) => one.stage === stage.id && one.schemaVersion === produced.schemaVersion)) {
        held.push({ stage: stage.id, schemaVersion: produced.schemaVersion });
      }
      versions.set(produced.kind, held);
    }
  }
  const problems: StageProblem[] = [];
  for (const kind of [...versions.keys()].sort(byCodePoint)) {
    const held = (versions.get(kind) ?? []).sort((left, right) =>
      byCodePoint(left.stage, right.stage) || left.schemaVersion - right.schemaVersion);
    const distinct = [...new Set(held.map((one) => one.schemaVersion))];
    if (distinct.length < 2) continue;
    problems.push({
      stage: held[0]!.stage,
      path: `produces.${kind}`,
      message: `the fact kind "${kind}" is produced at schema versions ${distinct.join(' and ')} `
        + `(by ${held.map((one) => `${one.stage} at ${one.schemaVersion}`).join(', ')}): one kind carries one schema version`,
    });
  }
  return problems;
}

// ---- the graph's own walks -------------------------------------------------

/**
 * Every cycle of the derived edges, deterministically: a depth-first walk in
 * code point order, where a back edge closes a cycle from the node the walk
 * is standing on. Each cycle is reported once, however many nodes reach it.
 */
function findCycles(nodes: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>): StageCycle[] {
  const cycles: StageCycle[] = [];
  const reported = new Set<string>();
  const state = new Map<string, 'open' | 'closed'>();
  const stack: string[] = [];
  const visit = (node: string): void => {
    state.set(node, 'open');
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (state.get(next) === 'open') {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const key = cycleKey(cycle);
        if (!reported.has(key)) {
          reported.add(key);
          cycles.push(cycle);
        }
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 'closed');
  };
  for (const node of nodes) {
    if (!state.has(node)) visit(node);
  }
  return cycles;
}

/** A cycle's identity: its nodes' rotation starting at their code point least. */
function cycleKey(cycle: StageCycle): string {
  const nodes = cycle.slice(0, -1);
  const least = nodes.reduce((best, node) => (byCodePoint(node, best) < 0 ? node : best), nodes[0]!);
  const at = nodes.indexOf(least);
  return [...nodes.slice(at), ...nodes.slice(0, at)].join('→');
}

/** Kahn's order over the adjacency, the ready set taken in code point order. */
function topologicalOrder(nodes: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>): string[] {
  const pending = new Map<string, number>(nodes.map((node) => [node, 0]));
  for (const node of nodes) {
    for (const next of adjacency.get(node) ?? []) {
      if (pending.has(next)) pending.set(next, (pending.get(next) ?? 0) + 1);
    }
  }
  const ready = nodes.filter((node) => pending.get(node) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort(byCodePoint);
    const node = ready.shift()!;
    order.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!pending.has(next)) continue;
      const left = (pending.get(next) ?? 0) - 1;
      pending.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  return order;
}

// Re-exported so a caller reading a product's configuration needs one import.
export { readFillStageConfiguration };
