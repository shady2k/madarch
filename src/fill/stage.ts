/**
 * The fill's stage contract (decision 0027): what one stage of the fill
 * declares, and the shape madarch calls it through. A stage is one module
 * plus registration in the registry (`src/fill/registry.ts`): it declares
 * its id and version, the capabilities it consumes (required ones gate the
 * stage graph, optional ones are read when present), the fact kinds it
 * produces with schema version and ownership scope, an optional ordering
 * beside the capability-derived edges, a configuration schema with its
 * defaults (enabled, concurrency, the bounded unit limits, and the stage's own
 * default configuration), a `plan` that
 * reads the graph to name its units, an `execute` that runs one unit and
 * returns a draft, a split or a block, and a `validate` that judges a
 * draft before publication.
 *
 * The context a stage runs in gives it tracked graph reads, private draft
 * writes, progress and cancellation — never a database. Every declaration
 * here is pure data: nothing reads the clock, the file system or the
 * network, so the registry can derive the stage graph and a run can
 * snapshot the resolved configuration from these values alone.
 */
import { type TSchema } from 'typebox';
import type { AcpMcpServer } from './acp.js';

/** How much of the product one capability or fact kind is about. */
export type CapabilityScope = 'product' | 'repository' | 'package' | 'cluster' | 'file';

/**
 * What freshness a consumed capability needs: `any` accepts the last
 * published facts of any age, `current` asks the publication to recheck
 * what the unit read (decision 0027, staleness from tracked reads).
 */
export type CapabilityFreshness = 'any' | 'current';

/** One capability a stage consumes, with the scope and freshness it needs. */
export interface StageConsumes {
  /** The capability's name, the graph's own vocabulary (for example `product-graph`). */
  capability: string;
  /** The scope the stage reads the capability at. */
  scope: CapabilityScope;
  /** The freshness the stage needs, `any` where it is left out. */
  freshness?: CapabilityFreshness;
}

/** One fact kind a stage produces, with its schema version and ownership scope. */
export interface StageProduces {
  /** The fact kind's name, in the fill's own namespace, never a registry kind's. */
  kind: string;
  /** The schema version the kind's facts are written in. */
  schemaVersion: number;
  /** The ownership scope the stage writes: publication replaces only this stage's facts. */
  scope: CapabilityScope;
}

/** The bounded unit limits of one stage (decision 0026 and 0027's numbers). */
export interface StageLimits {
  /** The unit's context window in tokens: 272_000, never a million. */
  contextTokens: number;
  /** The fraction of the window where the unit is told to wrap up: 0.7. */
  wrapAtFraction: number;
  /** The fraction where the unit is stopped hard: 0.8, the rest for reasoning and the answer. */
  stopAtFraction: number;
  /** The most turns one unit may take: about 30. */
  maxTurns: number;
  /** The most wall-clock time one unit may take: about 10 minutes. */
  maxDurationMs: number;
  /** The most output one unit may write: 16_000 tokens. */
  maxOutputTokens: number;
}

/** The limits decision 0026 and 0027 fix for every agent stage. */
export const DEFAULT_STAGE_LIMITS: StageLimits = {
  contextTokens: 272_000,
  wrapAtFraction: 0.7,
  stopAtFraction: 0.8,
  maxTurns: 30,
  maxDurationMs: 10 * 60 * 1000,
  maxOutputTokens: 16_000,
};

/** A stage's own defaults, before the product's configuration speaks. */
export interface StageDefaults {
  /** Whether the stage runs when the product's configuration says nothing. */
  enabled: boolean;
  /** How many units of the stage may run at once. */
  concurrency: number;
  /** The stage's unit limits; the defaults above are the agent stages' own. */
  limits: StageLimits;
  /**
   * The stage's own default configuration, which the product's
   * `fill.stages.<id>.config` replaces whole rather than field by field. It is
   * a JSON value, judged against the stage's `configSchema` like a written one,
   * and `{}` where the stage has nothing to configure: a stage whose schema
   * requires a setting declares it here, since a run that found no
   * configuration would otherwise hand the stage a value its own schema
   * refuses. `undefined` is refused rather than read: a stage that declared
   * nothing would run with a configuration its own declaration never stated.
   */
  config: unknown;
}

/** The defaults a stage falls back to where its declaration says nothing. */
export const DEFAULT_STAGE_DEFAULTS: StageDefaults = {
  enabled: true,
  concurrency: 1,
  limits: DEFAULT_STAGE_LIMITS,
  config: {},
};

// ---- what a stage runs in and returns --------------------------------------

/** One unit of a stage's work: a stable identity and the scope it covers. */
export interface StageUnitScope {
  /** The unit's stable id, never carrying a run id (decision 0026). */
  id: string;
  /** What the unit covers, in the graph's own terms. */
  scope: string;
  /** The unit's estimated size in tokens, when the plan can name one. */
  estimatedTokens?: number;
}

/** What a stage's `plan` returns: the units the graph gives it, split until each fits. */
export interface StagePlan {
  units: readonly StageUnitScope[];
  /**
   * The plan found a producer's inputs but nothing in them: `nothing-found`
   * distinguishes it from a plan with no units for want of any input
   * (decision 0027, "no producer" from "producer found nothing").
   */
  coverage?: 'planned' | 'nothing-found';
}

/** A tracked graph read: the query and its result membership are recorded for staleness. */
export interface StageGraphReader {
  /** Runs one read against the pinned snapshot and records it as the unit's dependency. */
  query(text: string): Promise<readonly unknown[]>;
}

/**
 * One write a unit's draft holds; every write cites what it stands on, and every
 * write carries the fact it writes in its `value` — the schema's own fact
 * (`facts.ts`), so the store a published set lands in publishes exactly what the
 * unit wrote and never has to guess a kind. An edge's ends are the fact's own
 * (`CallEdgeValue.from`, `ConsumesEdgeValue.variable`), named once: a link beside
 * a second pair of ends could state an edge whose ends nothing publishes.
 */
export type StageDraftWrite =
  | { kind: 'fact'; evidence: string; value: unknown }
  | { kind: 'entity'; evidence: string; value: unknown }
  | { kind: 'link'; evidence: string; value: unknown }
  | { kind: 'question'; evidence: string; value: unknown };

/** The draft set a unit's writes collect into while it runs. */
export interface StageDraftSet {
  writes: readonly StageDraftWrite[];
}

/** The draft writes a unit makes: private until the stage is published. */
export interface StageDraftWriter {
  /** Records one write into the unit's draft set. */
  write(entry: StageDraftWrite): void;
  /** The writes recorded so far, in the order they were made. */
  writes(): StageDraftSet;
}

/** How a stage reports its progress while a unit runs. */
export interface StageProgress {
  (note: string, fraction?: number): void;
}

/** One stage unit as `execute` runs it. */
export interface StageUnit {
  id: string;
  scope: string;
}

/** The limits a product may override on one stage, each optional. */
export type StageLimitOverrides = Partial<StageLimits>;

/**
 * One stage's entry in the product's configuration, `fill.stages.<id>`: the
 * fields the product may set, each absent where the product says nothing.
 */
export interface FillStageConfigurationEntry {
  /** Whether the stage runs; where it is left out, the stage's own default holds. */
  enabled?: boolean;
  /** How many units of the stage may run at once; where it is left out, the stage's own default holds. */
  concurrency?: number;
  /** The unit limits this product overrides; the rest keep the stage's own defaults. */
  limits?: StageLimitOverrides;
  /** The stage's own configuration, judged against the stage's `configSchema`. */
  config?: unknown;
}

/** The configuration a stage runs with, after the product's configuration spoke. */
export interface ResolvedStageConfiguration {
  id: string;
  version: number;
  enabled: boolean;
  concurrency: number;
  limits: StageLimits;
  /**
   * The stage's own configuration: the product's `fill.stages.<id>.config`
   * where it wrote one, else the stage's declared default, already judged
   * against the stage's `configSchema`.
   */
  config: unknown;
}

/**
 * The MCP server one unit's attempt runs its tools through, as the host that opened
 * it hands it over (0026, "Agents and tools"): the server a stage attaches to the
 * unit's ACP session, and the call that forgets its session when the attempt ends.
 */
export interface StageUnitTools {
  /** The server to attach to the unit's ACP session (`connection.newSession({ mcpServers })`, `src/fill/acp.ts`). */
  readonly mcpServer: AcpMcpServer;
  /**
   * What the unit's server has answered so far, in tokens, where the host counts it: 0026's
   * limits count "the session and the server", and a host that does not count answers
   * nothing here (the unit's own agent report is then the only figure above the prompts).
   */
  answered?(): number;
  /** Forgets the session: called when the attempt ends, whatever it ended with. */
  close(): void;
}

/** What a stage's `execute` runs in: never a database, never a file path. */
export interface StageContext {
  /** The unit being run. */
  unit: StageUnit;
  /**
   * The unit's own MCP server, where the stage declared `usesTools` and the run has
   * a host that opens one; absent for a stage whose units run no agent. A stage that
   * runs an agent refuses to run without it rather than starting an agent that
   * cannot read.
   */
  tools?: StageUnitTools;
  /** The stage's resolved configuration for this run. */
  config: ResolvedStageConfiguration;
  /** Tracked reads of the pinned graph. */
  graph: StageGraphReader;
  /** Private draft writes, visible to other units only as draft. */
  draft: StageDraftWriter;
  /** Progress the run's view shows. */
  progress: StageProgress;
  /** Cancelled when the run or the unit is cancelled. */
  signal: AbortSignal;
}

/** How `execute` ends: a draft to publish, a split into children, or a block. */
export type StageExecutionResult =
  | { outcome: 'draft' }
  | { outcome: 'split'; children: readonly StageUnitScope[] }
  | { outcome: 'blocked'; reason: string };

/** How `validate` judges a draft: whole, or the errors that refuse it. */
export type StageValidation =
  | { ok: true }
  | { ok: false; errors: readonly string[] };

/** The shape of a stage id: a word, the same shape a product's configuration may name. */
export const STAGE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** A stage of the fill, as one module declares it (decision 0027). */
export interface FillStage {
  /** The stage's id, unique in the registry. */
  id: string;
  /** The stage module's own version, bumped when its behaviour changes. */
  version: number;
  /** The capabilities the stage needs: required ones gate the graph, optional ones are read when present. */
  consumes: { readonly required: readonly StageConsumes[]; readonly optional: readonly StageConsumes[] };
  /** The fact kinds the stage produces, each with schema version and ownership scope. */
  produces: readonly StageProduces[];
  /** An optional ordering beside the capability-derived edges: run after these stages when they run. */
  after?: readonly string[];
  /** The schema of the stage's own configuration, as the product's configuration may set it. */
  configSchema: TSchema;
  /** The stage's defaults, before the product's configuration speaks. */
  defaults: StageDefaults;
  /**
   * Whether the stage's units read and write through the unit's own MCP server
   * (0026, "Agents and tools"). A stage that declares it is handed
   * `StageContext.tools` by the run; a stage that leaves it out is handed none, and
   * no server is opened for its units.
   */
  usesTools?: boolean;
  /**
   * The versions that decide what a stage's units read and answer beside its own: the prompt it
   * sends, the answer schema it asks for, the model it drives (decision 0026, "Updates": a unit's
   * cache key is its reads, its spans, its inputs and "the prompt, schema and model versions").
   * Recorded with every unit's plan, so a unit planned under one of them is replaced when a run
   * resolves another; a stage whose prompt cannot change names none. The values are strings a run
   * compares and never reads, and the stage's own `version` is compared beside them.
   */
  cacheVersions?(): Readonly<Record<string, string>>;
  /** Names the stage's units from the graph, without running anything. */
  plan(graph: StageGraphReader): Promise<StagePlan> | StagePlan;
  /** Runs one unit and returns its outcome; the draft writes went through the context. */
  execute(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> | StageExecutionResult;
  /** Judges a unit's draft before publication. */
  validate(draft: StageDraftSet, graph: StageGraphReader): Promise<StageValidation> | StageValidation;
}
