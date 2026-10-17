/**
 * The fill's stage registry and the stage graph derived from it (decision
 * 0027). A stage is registered once by its module; the registry holds the
 * declared stages and nothing else. The graph is never declared: it is
 * derived from the stages' capabilities, a required consume drawing an edge
 * from every enabled stage that produces the capability to the consumer,
 * and an `after` naming an optional ordering beside them.
 *
 * The derivation refuses what it must name exactly: a cycle names its own
 * path (`a → b → a`), a starved consumer names the exact path
 * consumer → capability → producer, distinguishing a capability no stage
 * produces from one whose only producers the product's configuration
 * disabled, and a declaration or a configuration that does not read names
 * its file, line and path. A full registry whose required capabilities are
 * produced plans cleanly, in a deterministic topological order (code point
 * order breaking ties), and every stage carries its resolved configuration —
 * the stage's defaults with the product's `fill.stages.<id>` spoken over
 * them — so a run can snapshot what it resolved.
 */
import { Value } from 'typebox/value';
import { canonicalJsonDigest } from '../model/canonical.js';
import { byCodePoint } from '../model/order.js';
import { lineOf, lineOfIndex, MANIFEST_FILE } from '../product/manifest.js';
import { jsonPointerToSegments, segmentsToPath, type PathSegment } from '../model/yaml-position.js';
import { readFillStageConfiguration, type FillConfigError, type FillStageConfigurationEntry, type FillStageConfigurationRead } from './config.js';
import { DEFAULT_STAGE_LIMITS, type FillStage, type ResolvedStageConfiguration } from './stage.js';

// ---- the registry ----------------------------------------------------------

/** Holds the declared stages of the fill, each registered once by its module. */
export class StageRegistry {
  private readonly stages = new Map<string, FillStage>();

  /** Registers one stage module; a second registration of one id is a defect and is refused. */
  register(stage: FillStage): this {
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

/** A stage's declaration or its own configuration that does not read. */
export interface StageProblem {
  /** The stage the problem is about. */
  stage: string;
  /** The file the fault stands in; absent for a fault of the stage's own module declaration. */
  file?: string;
  /** The 1-based line in that file; absent with the file. */
  line?: number;
  /** The field's path from the file's top (`fill.stages.inventory.config.size`), or the declaration's field. */
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
    /** The product configuration's own refusals, each naming its file, line and path; empty when it read. */
    config: readonly FillConfigError[];
    /** Every stage whose own configuration or ordering does not read, each named where it stands. */
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
  const configRead = configuration ?? { ok: true, stages: {}, lines: {} };
  const stages = registry.all();

  // A fault is reported, never thrown: the whole graph is refused with every
  // fault named at once. The stages' own declarations are judged first, since
  // they hold whatever the product's configuration says; a configuration that
  // does not read refuses the graph before anything is derived from it, its
  // defaults standing for nothing the product agreed to.
  const problems: StageProblem[] = [];
  for (const stage of stages) problems.push(...declarationProblems(registry, stage));
  if (!configRead.ok) return { ok: false, config: configRead.errors, problems, cycles: [], starvation: [] };

  // Each stage's resolved configuration, and every fault its own configuration
  // holds: a stage's configuration is judged whether or not the stage runs,
  // because a field nobody reads is a field nobody fixed.
  const resolved = new Map<string, ResolvedStageConfiguration>();
  for (const stage of stages) {
    const entry = configRead.stages[stage.id];
    resolved.set(stage.id, resolveStageConfiguration(stage, entry));
    problems.push(...configurationProblems(stage, entry, configRead.lines[stage.id] ?? 1));
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

  // The edges: every enabled consumer's required capability draws an edge
  // from each of its enabled producers; a capability no enabled stage
  // produces starves the consumer, named by its exact path. A stage that
  // consumes the capability it produces reads what its own earlier run
  // published, so no edge runs from it to itself.
  const edges: StageGraphEdge[] = [];
  const starvation: StarvationPath[] = [];
  for (const stage of stages) {
    if (!enabled.has(stage.id)) continue;
    for (const consume of stage.consumes.required) {
      const all = producers.get(consume.capability) ?? [];
      const running = all.filter((id) => enabled.has(id) && id !== stage.id);
      if (running.length > 0) {
        for (const producer of running) {
          edges.push({ from: producer, to: stage.id, via: consume.capability });
        }
        continue;
      }
      if (all.length === 0) {
        starvation.push({
          consumer: stage.id,
          capability: consume.capability,
          reason: 'no-producer',
          path: `${stage.id} → ${consume.capability} → no producer`,
        });
      } else if (!all.every((id) => id === stage.id)) {
        // Every producer is disabled (or the only one is this stage, which
        // does not stand as its own producer): the path names each of them.
        for (const producer of all.filter((id) => id !== stage.id)) {
          starvation.push({
            consumer: stage.id,
            capability: consume.capability,
            producer,
            reason: 'producer-disabled',
            path: `${stage.id} → ${consume.capability} → ${producer} (disabled)`,
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
 * product's `fill.stages.<id>` spoken over them. Its own `config` is passed
 * through as written; `deriveStageGraph` is what judges it against the
 * stage's `configSchema`.
 */
export function resolveStageConfiguration(stage: FillStage, entry?: FillStageConfigurationEntry): ResolvedStageConfiguration {
  return {
    id: stage.id,
    version: stage.version,
    enabled: entry?.enabled ?? stage.defaults.enabled,
    concurrency: entry?.concurrency ?? stage.defaults.concurrency,
    limits: { ...DEFAULT_STAGE_LIMITS, ...stage.defaults.limits, ...entry?.limits },
    config: entry?.config,
  };
}

/** The run's snapshot of what it resolved: the configurations' canonical digest. */
export function snapshotStageConfigurations(stages: readonly ResolvedStageConfiguration[]): string {
  return canonicalJsonDigest(stages.map((stage) => ({
    id: stage.id,
    version: stage.version,
    enabled: stage.enabled,
    concurrency: stage.concurrency,
    limits: stage.limits,
    config: stage.config ?? null,
  })));
}

// ---- faults of one stage's declaration and configuration -------------------

/**
 * What the stage's own module declares and the graph cannot hold: an `after`
 * naming a stage the registry does not hold, or the stage itself. Both are
 * refused rather than ignored: a silently dropped ordering runs a stage too
 * early, which no later check can notice.
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
 * What the stage's own `config`, as the product wrote it, fails against the
 * stage's `configSchema`: one problem per failing field, at the field's own
 * line and path (`fill.stages.<id>.config.<field>`).
 */
function configurationProblems(stage: FillStage, entry: FillStageConfigurationEntry | undefined, entryLine: number): StageProblem[] {
  if (entry?.config === undefined) return [];
  const problems: StageProblem[] = [];
  for (const error of Value.Errors(stage.configSchema, entry.config)) {
    const segments = jsonPointerToSegments(error.instancePath);
    const inside = segmentsToPath(segments);
    problems.push({
      stage: stage.id,
      file: MANIFEST_FILE,
      line: lineAlong(entry.config, segments, entryLine),
      path: inside === '' ? `fill.stages.${stage.id}.config` : `fill.stages.${stage.id}.config.${inside}`,
      message: error.message,
    });
  }
  return problems;
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
