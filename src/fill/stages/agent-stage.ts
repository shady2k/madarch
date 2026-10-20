/**
 * The shape every agent stage of the fill is built from (decision 0026, stages 8 to
 * 13; madarch-tzte.24.1): one module per stage declares what makes it different, and
 * this module runs it.
 *
 * **What a stage declares.** 0026's "Agent input" splits a unit's prompt into a fixed
 * part and a per-unit packet, and "Scale" says what a stage's plan is for — so a
 * stage here declares exactly those four things and nothing else:
 *
 * - its **fixed part**: the role its units are told, its own rules after the shape's,
 *   and its **answer schema with an example** (`AgentAnswer`) — every unit of the
 *   stage reads the same words, and `readAgentAnswer` judges what it answers against
 *   the fields the stage declared, naming the field that was wrong;
 * - **what its per-unit packet is assembled from**: the packet's own sections come
 *   from `src/fill/agent-packet.ts` (the scope, its place, its ranked members, its
 *   relations and the product's history), and the stage adds the sections its own
 *   level of the graph needs (`sections`) — every one of them a read of the graph
 *   recorded as the unit's dependency, never a file's bytes;
 * - its **scope plan**: `plan(graph)` names the units from the graph, and `places`
 *   says what one unit covers (what its coverage counts, and the unit each of its
 *   children would be), so a unit that cannot finish splits into its own places;
 * - **what it may write**: the fact kinds (`kinds`), which the schema judges, and the
 *   level of the milestone's three (self-filling, outcome 4) its claims stand at
 *   (`level`): an agent's reading is 0005's `inferred` layer and always `proposed`,
 *   and what it says is *meaning* (assumed, never fact) or *intent* (what a person
 *   recorded). No stage writes an accepted or an extracted fact.
 *
 * **What this module runs.** One unit: the packet (at most 0026's 20K tokens), the ACP
 * session with the unit's own MCP server attached (0026, "Agents and tools"), the
 * guard of `src/fill/unit-limits.ts` (70% earns the wrap-up message, 80% cancels the
 * turn in flight, and the turns, the time and the output are read at every turn's
 * end. The clock reaches a turn that streams nothing too: every turn in flight is
 * armed on a watch of the guard's own time (`watchUnitTimeLimit`,
 * `src/fill/unit-limits.ts`), so a prompt the agent never answers is cancelled at
 * 0026's ten minutes like any other turn (madarch-tzte.38)), and then what the unit
 * hands over — a draft when it finished, or its partial draft with a `coverage` fact
 * and the places it did not cover as its children (0027's split). Every number here is
 * the run's resolved limits; nothing in this module reads a clock, a file or a network
 * of its own.
 *
 * **A unit of the whole product.** 0026's hierarchy is product → repository → package
 * → cluster, and stages 8 and 13 stand at its top: their unit covers every repository
 * the product pins, its scope is `"*"` (`PRODUCT_SCOPE`, `src/fill/checked-writes.ts`),
 * no single node of the graph stands for it, and its places are its repositories. Its
 * writes cite the bytes they read in whichever repository they stand in, and its
 * coverage is one fact per repository, saying what of the product's reading that
 * repository was.
 *
 * **What this module does not decide.** The limits are the product's and 0027's
 * (`context.config.limits`); the split bounds (depth, children, work) are the
 * orchestrator's (`OrchestratorLimits`); the agent is the run's wiring. Nothing here
 * re-decides them.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { runningVersion } from '../../product/version.js';
import {
  connectAcpAgent,
  type AcpAgentSpec,
  type AcpConnection,
  type AcpPromptResult,
  type AcpSession,
  type AcpUpdate,
} from '../acp.js';
import { estimateTokens } from '../graph-reads.js';
import {
  buildUnitPacket,
  estimateOfMembers,
  PACKET_TOKENS,
  pathOfNode,
  placeText,
  plannedTokens,
  readAgentAnswer,
  type AgentAnswer,
  type AgentFixedLevel,
  type AgentAnswerValue,
  type AgentPacketSection,
  type UnitPacket,
  type UnitPacketRepository,
} from '../agent-packet.js';
import { isProductScope, PRODUCT_SCOPE, scopeText, writeScope, type WriteScope } from '../checked-writes.js';
import { FACT_KINDS, FACT_KINDS_IN_ORDER, makeNodeFact, REPOSITORY_FORMS, type CoverageGap, type CoverageValue, type Fact, type FactKind, type FactSource, type FactStage } from '../facts.js';
import {
  DEFAULT_GRAPH_READ_LIMITS,
  factsOfRows,
  graphReadsOver,
  neighbors,
  readText,
  type GraphReadContext,
} from '../graph-reads.js';
import { raise } from '../fsm-core.js';
import type { SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  DEFAULT_STAGE_LIMITS,
  type CapabilityScope,
  type FillStage,
  type StageConsumes,
  type StageContext,
  type StageDraftSet,
  type StageDraftWrite,
  type StageExecutionResult,
  type StageGraphReader,
  type StagePlan,
  type StageUnit,
  type StageUnitScope,
  type StageValidation,
} from '../stage.js';
import { createUnitLimitGuard, PROCESS_TIMERS, watchUnitTimeLimit, type UnitLimitCause, type UnitTimers } from '../unit-limits.js';
import { checkFactDraft } from './draft.js';

// ---------------------------------------------------------------------------------------------
// What one agent stage declares
// ---------------------------------------------------------------------------------------------

/**
 * The level of the fill's three (self-filling's outcome 4: "fact", "evidence of
 * intent", "meaning") that a stage's statements stand at. Every agent stage writes
 * 0005's `inferred` layer and a `proposed` status whatever its level; the level says
 * what the stage's words are about, and the fixed part tells its units so. The words
 * are the packet's own (`AgentFixedLevel`, `src/fill/agent-packet.ts`), one declaration
 * for the fixed part and the declaration that feeds it.
 */
export type AgentLevel = AgentFixedLevel;

/**
 * The ownership scope a stage's units declare for their facts (`StageProduces.scope`):
 * the level of 0026's hierarchy they stand at, a folder or a file of a repository for a
 * unit that covers one place.
 */
export function ownershipScopeOf(level: AgentScaleLevel): CapabilityScope {
  return level === 'product' ? 'product' : level === 'repository' ? 'repository' : level === 'package' ? 'package' : level === 'cluster' ? 'cluster' : 'file';
}

/** The level of 0026's hierarchy a stage's units — or their children — stand at. */
export type AgentScaleLevel = 'product' | 'repository' | 'package' | 'cluster' | 'place';

/** Where a stage's units stand in 0026's hierarchy, and what the level below it is. */
export interface AgentStageScale {
  /** The level this stage's plan names its units at: `product` is one unit for every repository the run pins. */
  readonly level: AgentScaleLevel;
  /** The level a child of one of its units covers, when its units split at a limit. */
  readonly child: AgentScaleLevel;
  /**
   * The most tokens one child's summary the parent reads may cost (0026's "summaries are bounded (~2K
   * tokens)"); `AGENT_SUMMARY_TOKENS` where the stage names none.
   */
  readonly summaryTokens?: number;
  /**
   * The most children one parent reads before an intermediate grouping level stands between them (0026's
   * "fan-in is bounded (~50 children …)"); `AGENT_FAN_IN` where the stage names none.
   */
  readonly fanIn?: number;
}

/** 0026's bound on a child's summary: "summaries are bounded (~2K tokens)". */
export const AGENT_SUMMARY_TOKENS = 2_000;

/** 0026's bound on a parent's fan-in: "~50 children, else an intermediate grouping level". */
export const AGENT_FAN_IN = 50;

/** The scale a stage is held to, its own bounds where it names them and 0026's own where it does not. */
export function resolvedScale(scale: AgentStageScale): { readonly level: AgentScaleLevel; readonly child: AgentScaleLevel; readonly summaryTokens: number; readonly fanIn: number } {
  return {
    level: scale.level,
    child: scale.child,
    summaryTokens: scale.summaryTokens ?? AGENT_SUMMARY_TOKENS,
    fanIn: scale.fanIn ?? AGENT_FAN_IN,
  };
}

/**
 * One place a unit covers: what its coverage counts, what its answer names, and the
 * unit a child of it would be. A place is a path inside the unit's repository (a
 * folder or a file) or, for a unit of the whole product, one of its repositories.
 */
export interface AgentPlace {
  /** The member's fact id: a child unit covering this place is named by it (0026: ids carry no run). */
  readonly id: string;
  /** The place as the unit's coverage counts it and its answer names it. */
  readonly place: string;
  /** The scope text a child unit covering this place carries — `<repository>` or `<repository>:<path>`. */
  readonly scope: string;
  /** The repository the place's bytes stand in, which its coverage fact names. */
  readonly repository: string;
  /** The commit the run pinned that repository at. */
  readonly commit: string;
  /** 0026's estimate of what reading this place costs, in tokens: the split's own measurement. */
  readonly estimatedTokens: number;
}

/** What one unit's places are: the places, and whether the graph cut the list they were enumerated from. */
export interface AgentPlaceSet {
  /** The places, in the order a child set is named (code point order). */
  readonly places: readonly AgentPlace[];
  /**
   * Whether the list was cut by a read's own cap: a unit told that its scope holds more
   * places than it was shown can never claim it read the scope whole (0005).
   */
  readonly cut: boolean;
}

/** What one unit's places are read in: the unit, the packet the graph gave it, and its own reader. */
export interface AgentUnitContext {
  /** The unit, as the stage's plan named it. */
  readonly unit: StageUnit;
  /** The scope the unit covers, as `writeScope` reads its own text. */
  readonly scope: WriteScope;
  /** The packet the unit was sent, which is where a stage whose places are its members reads them. */
  readonly packet: UnitPacket;
  /** The unit's own reader: a read of places is recorded as its dependency like every other. */
  readonly graph: StageGraphReader;
}

/** Reads the places one unit covers, from the graph. */
export type AgentPlaceReader = (context: AgentUnitContext) => AgentPlaceSet | Promise<AgentPlaceSet>;

/** What one agent stage declares (0026's "Agent input" and "Scale"): everything that tells it from its siblings. */
export interface AgentStageDeclaration {
  /** The stage's id, as it is registered. */
  readonly id: string;
  /** The stage's own version, bumped when what it plans, runs or writes changes. */
  readonly version: number;
  /** The stage of 0026 these facts are (`8-overview` … `13-recovery`), which the kinds' own table names. */
  readonly factStage: FactStage;
  /** What level of the fill's three this stage's statements stand at (self-filling's outcome 4). */
  readonly level: AgentLevel;
  /** Where its units stand in 0026's hierarchy. */
  readonly scale: AgentStageScale;
  /** The role every unit of the stage is told, as the fixed part's first line. */
  readonly role: string;
  /** The stage's own rules, after the shape's own. */
  readonly rules: readonly string[];
  /** The task, in one sentence: what a unit of this stage is for. */
  readonly task: string;
  /** The answer the stage's units give: its shape, how it is read, and an example. */
  readonly answer: AgentAnswer;
  /** The fact kinds a unit of this stage may write through its tools; the shape adds the coverage it writes itself. */
  readonly kinds: readonly string[];
  /** The capabilities the stage consumes, as the registry's declaration takes them. */
  readonly consumes: { readonly required: readonly StageConsumes[]; readonly optional: readonly StageConsumes[] };
  /** The packet sections the stage adds to the shape's own, each a read of the graph. */
  readonly sections?: readonly AgentPacketSection[];
  /** The stage's plan: the units the graph gives it, split until each fits 0026's planned size. */
  readonly plan: (graph: StageGraphReader) => Promise<StagePlan> | StagePlan;
  /** What one unit covers: its places, and whether the graph cut the list they came from. */
  readonly places: AgentPlaceReader;
}

/** What the stage is wired with: the agent program, the clock its limits read, the run's pins, and where the agent runs. */
export interface AgentStageWiring {
  /** The agent program madarch drives over ACP (`src/fill/acp.ts`, `AcpAgentSpec`). */
  readonly agent: AcpAgentSpec;
  /** The run's pinned repositories: where a unit's commit comes from, and the evidence its facts cite. */
  readonly snapshots: SnapshotSource;
  /**
   * The clock a unit's limits read. A real run leaves it out and reads `Date.now`;
   * a test moves it by hand, so ten minutes pass without waiting (0026's time
   * limit, through a seam, never a sleep).
   */
  readonly clock?: () => number;
  /** The folder the agent process runs in; this process's own working folder when it is left out. */
  readonly cwd?: string;
  /** How long `initialize` may take, and how long `session/new` may take, in milliseconds. */
  readonly timeouts?: { readonly initializeMs?: number; readonly sessionMs?: number };
  /**
   * The timers a turn's watch is armed on (madarch-tzte.38): this process's own by
   * default, and a test's when 0026's ten minutes must pass without waiting. The clock
   * the watch reads is `clock`; the timers only say when to read it.
   */
  readonly timers?: UnitTimers;
  /** The system a coverage fact names as its reader; `madarch-fill-agent` at this build's version by default. */
  readonly source?: FactSource;
}

/** The system a fact an agent stage writes names as its reader where the wiring names none (0004's `plugin@version`). */
export const AGENT_SOURCE_SYSTEM = 'madarch-fill-agent';

/**
 * The most units one plan splits into, every repository together. Past it a scope
 * stands as one unit — never a shorter list: the scope then splits at run time, and
 * its own coverage names every place its member list did not hold. A plan that dropped
 * the scopes past its bound would leave work no unit ever names, so a scope the bound
 * cannot enumerate is collapsed to itself instead, and the plan may name up to one
 * unit per repository more than this number.
 */
export const MAX_PLAN_UNITS = 256;

/**
 * How deep the plan splits a scope before it leaves the rest to the run: 0027's own
 * split depth, so a plan and a split nest alike and neither nests deeper than the
 * other.
 */
export const MAX_PLAN_DEPTH = 3;

/**
 * The most children one split names. 0027's bound on a split is the orchestrator's
 * (`maxSplitChildren`, eight by default); a stage cannot read it, so this is the
 * number it names here, and a product that lowers the orchestrator's bound below it
 * blocks the parent with the orchestrator's own reason rather than sealing a set it
 * refuses.
 */
export const SPLIT_CHILDREN = 8;

/**
 * The stage's declaration, as the shape reads it into a `FillStage`: the declared id,
 * version, role, rules, answer, kinds and plan, the coverage the shape adds, and the
 * one attempt this module runs.
 */
export function createAgentStage(declaration: AgentStageDeclaration, wiring: AgentStageWiring): FillStage {
  const clock = wiring.clock ?? (() => Date.now());
  const source: FactSource = wiring.source ?? { system: AGENT_SOURCE_SYSTEM, version: runningVersion() };
  // The kinds the stage's units may write, and the coverage every unit writes itself: one list, in code point order,
  // so the fixed part, the packet and the draft's own reading name the same kinds in the same order.
  const kinds = [...new Set([...declaration.kinds, 'coverage'])].sort(byCodePoint);
  // 0004's schema table says which stage writes which kind, and this is where a declaration is read: a stage that
  // declared a kind its own stage of 0026 does not write would have every write of it refused (the table's layers and
  // stages), and the refusal would land on the unit's draft set after its agent run (0026, "Writing").
  for (const kind of kinds) {
    const definition = FACT_KINDS[kind as FactKind];
    if (definition === undefined) {
      raise(`the agent stage ${JSON.stringify(declaration.id)} declares the fact kind ${JSON.stringify(kind)}, which is no kind of the schema: the schema's kinds are ${FACT_KINDS_IN_ORDER.join(', ')}`);
    }
    if (!definition.stages.includes(declaration.factStage)) {
      raise(`the agent stage ${JSON.stringify(declaration.id)} declares the fact kind ${JSON.stringify(kind)} and names 0026's stage ${JSON.stringify(declaration.factStage)}, and the schema's table writes a "${kind}" fact at ${definition.stages.join(', ')}: a stage declares the kinds its own stage of the fill writes (src/fill/facts.ts)`);
    }
  }
  const wiringOfAttempt: AttemptWiring = {
    declaration,
    agent: wiring.agent,
    snapshots: wiring.snapshots,
    clock,
    timers: wiring.timers ?? PROCESS_TIMERS,
    source,
    kinds,
    ...(wiring.cwd === undefined ? {} : { cwd: wiring.cwd }),
    ...(wiring.timeouts === undefined ? {} : { timeouts: wiring.timeouts }),
  };
  return {
    id: declaration.id,
    version: declaration.version,
    usesTools: true,
    consumes: declaration.consumes,
    // Each kind's own schema version, as the schema's table states it: never a guess.
    // The ownership scope the stage declares for its kinds: the level of 0026's hierarchy its units stand at (a fact
    // written at the product's level is the product's, one written at a repository's is that repository's).
    produces: kinds.map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind as 'claim'].version, scope: ownershipScopeOf(declaration.scale.level) })),
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: (graph) => declaration.plan(graph),
    execute: (unit, context) => executeUnit(wiringOfAttempt, unit, context),
    validate: (draft) => validateDraft(declaration, kinds)(draft),
  };
}

/**
 * Judges one unit's draft before it is published: every write is a fact of a kind the
 * stage declares — its own kinds and the coverage the shape writes — and the schema
 * reads it. The rule is the landed one (`checkFactDraft`, `draft.ts`) over the four
 * write kinds this shape's tools make — `fact`, `entity`, `link` and `question`, each
 * carrying its whole fact in `value` (0026, "Writing") — so a stage's draft is read
 * one way in the fill and not two.
 */
export function validateDraft(declaration: AgentStageDeclaration, kinds: readonly string[]): (draft: StageDraftSet) => StageValidation {
  return (draft: StageDraftSet) => checkFactDraft(declaration.id, kinds, draft, ['fact', 'entity', 'link', 'question']);
}

// ---------------------------------------------------------------------------------------------
// The plan: the scopes the graph gives a stage at 0026's repository level
// ---------------------------------------------------------------------------------------------

/**
 * The text of the read that names one form of repository:
 * `{"read":"facts-with","kind":"repository","field":"form","value":"<form>"}`. The
 * field is a path inside a fact's own `value` column (`readPath`, `graph-reads.ts`),
 * so a repository's form is read as its own field and never as `value.form`.
 */
export function repositoriesRead(form: string): string {
  return readText({ read: 'facts-with', kind: 'repository', field: 'form', value: form });
}

/** The text of the read that counts what one scope holds: `{"read":"held","id":"<scope>","via":["contains","defines"]}`. */
export function heldRead(scopeId: string): string {
  return readText({ read: 'held', id: scopeId, via: ['contains', 'defines'] });
}

/** Every repository the graph holds, by its own name then its id, with the form it was read at. */
export async function repositoriesOf(reads: GraphReadContext): Promise<readonly Fact[]> {
  const repositories = new Map<string, Fact>();
  // The grammar reads facts with one value field exactly, so the code repositories and the product repository are
  // read by the one field that tells them apart (`RepositoryValue.form`, the schema's own set of forms).
  for (const form of REPOSITORY_FORMS) {
    const read = { read: 'facts-with' as const, kind: 'repository' as const, field: 'form', value: form };
    for (const fact of factsOfRows(await reads.read(read), read)) repositories.set(fact.id, fact);
  }
  return [...repositories.values()].sort((left, right) => byCodePoint(repositoryNameOf(left), repositoryNameOf(right)) || byCodePoint(left.id, right.id));
}

/** The name a repository fact stands under, as its own value carries it. */
export function repositoryNameOf(fact: Fact): string {
  const value = (fact.value ?? {}) as { repository?: unknown };
  return typeof value.repository === 'string' ? value.repository : fact.provenance.repository.id;
}

/**
 * The graph's own word for the product-wide scope — the token `CoverageValue.scope`
 * documents — which is also the id of a unit that stands at 0026's top level: no node
 * of the graph stands for the whole product, so a plan cannot name such a unit by a
 * fact id, and an id that carried a run would be a second unit every run (0026,
 * "Updates"). The scope *text* is `PRODUCT_SCOPE` (`"*"`), which is the one text no
 * repository can be named by (`writeScope`); the id and a coverage's scope name the
 * concept in the graph's own words.
 */
export const PRODUCT_SCOPE_NAME = 'product';

/**
 * The unit of a whole product (0026's `product` level, stages 8 and 13): one unit
 * whose scope is every repository the run pins, named by the graph's own word for
 * that scope (`PRODUCT_SCOPE_NAME`) because no node of the graph stands for it.
 *
 * A product the graph holds no repository of is nothing found rather than a plan
 * that failed: the snapshot stage read none, and its own coverage says so (0027).
 *
 * The estimate is 0026's own measure of the places the unit covers, and it is not used
 * to split: the top of 0026's hierarchy is one unit per product ("so every level, the
 * product overview included, fits a unit"), so a product of many repositories is read
 * through its packet's bounded sections — every cut named in the packet's marker — and
 * through a split into its repositories when the unit cannot finish. Splitting the
 * product level itself would be a repository-level reading, which is what 0026's lower
 * levels are for (9's boundaries, 12's modules).
 */
export async function productUnits(graph: StageGraphReader): Promise<StagePlan> {
  const repositories = await repositoriesOf(graphReadsOver(graph));
  if (repositories.length === 0) return { units: [], coverage: 'nothing-found' };
  return {
    units: [{ id: PRODUCT_SCOPE_NAME, scope: PRODUCT_SCOPE, estimatedTokens: estimateOfMembers(repositories.length) }],
    coverage: 'planned',
  };
}

/**
 * One plan's units: one per repository, and a repository past 0026's planned size
 * planned as its member places — recursively, one level at a time, bounded by
 * `MAX_PLAN_DEPTH` and `MAX_PLAN_UNITS`. A member list the answer's cap cut is no
 * enumeration, so such a scope stands as one unit and the run's own split bounds
 * take it from there.
 *
 * The estimate is taken against 0026's default window (`DEFAULT_STAGE_LIMITS`):
 * a plan reads the graph and nothing else (0027's `plan(graph)`), so it cannot see
 * the product's resolved limits. A product that narrows its window then makes a
 * unit split earlier at run time, never later.
 */
export async function planUnits(graph: StageGraphReader): Promise<StagePlan> {
  const reads = graphReadsOver(graph);
  const ordered = await repositoriesOf(reads);
  const units: StageUnitScope[] = [];
  // One budget for the whole plan: a scope that would take it past `MAX_PLAN_UNITS` stands as one unit instead of
  // being enumerated, so the bound costs a split at run time and never a scope no unit names.
  const budget = { left: MAX_PLAN_UNITS };
  for (const repository of ordered) {
    const name = repositoryNameOf(repository);
    const planned = await planScope(reads, { scopeId: repository.id, repository: name, depth: 0 }, budget);
    units.push(...planned);
  }
  if (units.length === 0) {
    // No repository node stands in the graph: the snapshot stage found none, which is a run with nothing to fill
    // rather than a plan that failed. Its own coverage word says so (0027), so nobody reads it as "no producer".
    return { units: [], coverage: 'nothing-found' };
  }
  return { units, coverage: 'planned' };
}

/** One scope of the plan, as the recursion carries it. */
interface PlanScope {
  readonly scopeId: string;
  readonly repository: string;
  readonly path?: string;
  readonly depth: number;
}

/** How many units the whole plan may still name: a scope that would take it past the bound stands as one unit. */
interface PlanBudget {
  left: number;
}

/** One scope's units: the scope itself when it fits, its member places when it does not. */
async function planScope(reads: GraphReadContext, scope: PlanScope, budget: PlanBudget): Promise<readonly StageUnitScope[]> {
  const members = await memberCount(reads, scope.scopeId);
  const estimate = estimateOfMembers(members);
  const place = placeText(scope.repository, scope.path);
  const one = (): readonly StageUnitScope[] => {
    budget.left -= 1;
    return [{ id: scope.scopeId, scope: place, estimatedTokens: estimate }];
  };
  if (estimate <= plannedTokens(DEFAULT_STAGE_LIMITS) || scope.depth >= MAX_PLAN_DEPTH) return one();
  const places = await placeMembers(reads, scope.scopeId);
  // No enumeration of a scope whose member list the answer's cap cut, and none when the bound has no room left:
  // the scope stands as one unit either way, and its own coverage names what its member list did not hold. A plan
  // never names a shorter list than the one it read.
  // A file's members are its symbols, and a symbol is no scope a unit could be given: `placeMembers` answers no
  // place for such a scope, and enumerating nothing would name it by no unit at all. A scope whose places are not
  // an enumeration of what it holds therefore stands as one unit, like the cut case above.
  if (places === null || places.length === 0 || budget.left < 1) return one();
  const before = budget.left;
  const units: StageUnitScope[] = [];
  for (const member of places) {
    units.push(...await planScope(reads, { scopeId: member.id, repository: scope.repository, path: member.path, depth: scope.depth + 1 }, budget));
  }
  if (budget.left < 0) {
    // What this scope's enumeration would have cost is past the bound: it is undone and the scope stands as one
    // unit, so the plan names at least one unit for every scope it read and drops none.
    budget.left = before;
    return one();
  }
  return units;
}

/** How many members one scope holds, as the `held` read counts them: a count, never a sample. */
async function memberCount(reads: GraphReadContext, scopeId: string): Promise<number> {
  const rows = await reads.read({ read: 'held', id: scopeId, via: ['contains', 'defines'] });
  let total = 0;
  for (const row of rows) {
    const count = (row as { count?: unknown }).count;
    const held = typeof count === 'number' ? count : Number(count);
    if (!Number.isFinite(held) || held < 0) raise(`the held read of the scope ${scopeId} counted ${String(count)} members: a count is a whole number of no less than zero`);
    total += held;
  }
  return total;
}

/** One place a scope holds: the member's fact id, its kind and its path inside the repository. */
export interface MemberPlace {
  readonly id: string;
  readonly kind: FactKind;
  readonly path: string;
}

/**
 * The places one scope holds directly, in code point order of their paths — its
 * folders and files — or `null` when the answer was cut: an answer the cap cut is no
 * enumeration, and a caller that read it as one would plan a smaller scope than the
 * graph holds. A module's own members are its place's files, which are named as
 * places when the module is not; a module fact itself stands by its id and carries
 * no path of its own.
 */
export async function placeMembers(reads: GraphReadContext, scopeId: string): Promise<readonly MemberPlace[] | null> {
  const answer = await neighbors(reads, { tool: 'neighbors', id: scopeId, direction: 'out', kinds: ['contains', 'defines'] });
  if (answer.truncated) return null;
  const places = new Map<string, MemberPlace>();
  for (const row of answer.rows) {
    const kind = row.neighbor.kind;
    if (kind !== 'directory' && kind !== 'file') continue;
    const path = pathOfNode(row.neighbor);
    if (path === undefined || path === '') continue;
    if (!places.has(path)) places.set(path, { id: row.neighbor.id, kind, path });
  }
  return [...places.values()].sort((left, right) => byCodePoint(left.path, right.path) || byCodePoint(left.id, right.id));
}

// ---------------------------------------------------------------------------------------------
// The places one unit covers
// ---------------------------------------------------------------------------------------------

/**
 * The places a unit of one repository covers, as its packet's members name them: one
 * per folder or file the packet listed, in code point order, each a child unit's own
 * scope. The list a packet could not enumerate is not a smaller scope: `cut` says so,
 * and the unit's coverage then names what nobody enumerated.
 */
export function memberPlaces(context: AgentUnitContext): AgentPlaceSet {
  const { packet, scope } = context;
  const repository = scope.repository;
  const commit = 'product' in packet.place ? '' : packet.place.commit;
  const seen = new Map<string, AgentPlace>();
  /** The member that stands at each path: a folder or a file of the scope beats a member that merely cites it. */
  const placeAt = new Map<string, boolean>();
  for (const member of packet.members) {
    if (member.file === undefined || member.file === '') continue;
    const memberIsPlace = member.kind === 'directory' || member.kind === 'file';
    // A packet's members are ranked, so an entry point or a module at a path comes before the file the path names.
    // A child of such a member would be named by a node whose own places lie outside its scope: the member that
    // stands at the place wins (madarch-tzte.22.3's rule for a split's children, now the shape's own place reader).
    if (seen.has(member.file) && (placeAt.get(member.file) === true || !memberIsPlace)) continue;
    placeAt.set(member.file, memberIsPlace);
    seen.set(member.file, {
      id: member.id,
      place: member.file,
      scope: placeText(repository, member.file),
      repository,
      commit,
      estimatedTokens: estimateOfMembers(1),
    });
  }
  const places = [...seen.values()].sort((left, right) => byCodePoint(left.place, right.place) || byCodePoint(left.id, right.id));
  return { places, cut: packet.membersCut };
}

/** What one unit's answer names, as the places of its scope it read: a place, or a place with its repository's prefix. */
function namedPlaces(named: readonly string[], repository: string): readonly string[] {
  const places: string[] = [];
  for (const entry of named) {
    const text = entry.trim();
    if (text === '') continue;
    places.push(pathOfPlace(text, repository));
  }
  return places;
}

/** The path inside the repository a place names: `<repository>:<path>` read as its path. */
export function pathOfPlace(text: string, repository: string): string {
  const prefix = `${repository}:`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/**
 * The places of one unit a unit covered, as the unit's own places name them. A place
 * is covered when the unit's answer names it or something inside it, or when one of
 * the unit's own writes cites bytes that stand at it or below it: a write's cited
 * place is the fact's provenance, which is the write path's own answer for what it
 * stands on, and the answer's own list is read against the places of the scope, so a
 * place outside the scope covers nothing here whatever the agent says.
 *
 * A unit of one repository counts paths; a unit of the whole product counts
 * repositories, and a write covers the repository its bytes stand in. Which one a
 * place is, the place itself says: a repository place's scope text is its repository's
 * own name, and a path place's is `<repository>:<path>`.
 *
 * The list is the coverage's `read`, so it holds places and not the paths the unit
 * happened to read: a folder a unit read one file of is a folder it read.
 */
export function coveredOf(options: {
  readonly answer: { readonly covered: readonly string[]; readonly remaining: readonly string[] } | undefined;
  readonly writes: readonly StageDraftWrite[];
  readonly places: readonly AgentPlace[];
}): readonly string[] {
  const cited = new Set<string>();
  for (const place of options.places) {
    for (const named of namedPlaces(options.answer?.covered ?? [], place.repository)) {
      if (named !== '' && (named === place.place || named.startsWith(`${place.place}/`))) cited.add(place.place);
    }
  }
  // The unit contract's own words: "a `done` answer whose `remaining` is not empty is read as `partial`". A place
  // the agent names as remaining is no place it covered, whatever the same answer's `covered` list says.
  for (const place of options.places) {
    for (const named of namedPlaces(options.answer?.remaining ?? [], place.repository)) {
      if (named !== '' && (named === place.place || named.startsWith(`${place.place}/`))) cited.delete(place.place);
    }
  }
  for (const write of options.writes) {
    const provenance = (write.value as { provenance?: { repository?: { id?: unknown }; place?: { file?: unknown } } }).provenance;
    const repository = provenance?.repository?.id;
    const file = provenance?.place?.file;
    for (const place of options.places) {
      const at = place.scope === place.repository
        ? (typeof repository === 'string' ? repository : undefined)
        : (typeof file === 'string' ? file : undefined);
      if (at !== undefined && at !== '' && (at === place.place || at.startsWith(`${place.place}/`))) cited.add(place.place);
    }
  }
  return options.places.map((place) => place.place).filter((place) => cited.has(place)).sort(byCodePoint);
}

/**
 * The children a stopped unit's scope splits into: one child unit per place the unit
 * did not cover, in code point order, at most `SPLIT_CHILDREN`. A place that is the
 * unit's own scope is no child of it — a child whose scope is its parent's would be
 * the same unit again — and the places the bound leaves out are not dropped: the
 * unit's coverage names each of them as a `budget` gap, so the graph says what no
 * unit read.
 */
export function childrenOfPlaces(options: { readonly scope: WriteScope; readonly places: readonly AgentPlace[]; readonly covered: readonly string[] }): readonly StageUnitScope[] {
  const own = scopeText(options.scope);
  const children: StageUnitScope[] = [];
  for (const place of options.places) {
    if (children.length >= SPLIT_CHILDREN) break;
    if (options.covered.includes(place.place)) continue;
    if (place.scope === own) continue;
    children.push({ id: place.id, scope: place.scope, estimatedTokens: place.estimatedTokens });
  }
  return children;
}

/**
 * One coverage write per repository the unit's places stand in: what this unit read of
 * its scope and what it did not, never a silent gap. A unit of one repository writes
 * one fact, its scope named by the node it covers (the landed shape); a unit of the
 * whole product writes one fact per repository, each saying what of the product's
 * reading that repository was — the only repository a coverage fact can name, its
 * scope `PRODUCT_SCOPE_NAME` (the graph's own word for the product-wide scope).
 *
 * The fact's own identity names its reader (`FACT_KINDS.coverage`), so the same unit
 * reading the same scope again is the same coverage fact, replaced rather than added
 * beside the last one.
 */
export function coverageWrites(options: {
  readonly unit: { readonly id: string; readonly scope: string };
  readonly scope: WriteScope;
  readonly source: FactSource;
  readonly places: readonly AgentPlace[];
  readonly covered: readonly string[];
  readonly cut: boolean;
  /**
   * The unit's own verdict on its reading: its answer's `status` was `done` and every place of its scope is covered
   * (0026's unit contract, 0005's "a complete coverage is the only ground for a claim of absence").
   */
  readonly complete: boolean;
  /** What a cut enumeration is called in the coverage's gaps, as the unit's scope names it. */
  readonly cutGap: string;
  /** The commit a unit of one repository is read at: the run's pin, which its coverage cites whether it read a place or none. */
  readonly commit?: string;
}): readonly StageDraftWrite[] {
  const unreadOf = (uncovered: readonly string[]): readonly CoverageGap[] => [...uncovered.map((what) => ({ what, reason: 'budget' as const })),
    ...(options.cut ? [{ what: options.cutGap, reason: 'budget' as const }] : [])]
    .sort((left, right) => byCodePoint(left.what, right.what) || byCodePoint(left.reason, right.reason));
  const write = (repository: string, commit: string, scope: string, complete: boolean, read: readonly string[], unread: readonly CoverageGap[]): StageDraftWrite => {
    const value: CoverageValue = {
      repository,
      scope,
      complete,
      read: [...new Set(read)].sort(byCodePoint),
      unread,
    };
    const fact = makeNodeFact({
      kind: 'coverage',
      value,
      provenance: { source: options.source, repository: { id: repository, commit } },
      layer: 'inferred',
    });
    // The evidence line is the draft's own spelling (`<repository>@<commit>:<path>`, `evidenceAt`): what the write
    // stands on, as a reader of the draft set finds it.
    const path = isProductScope(options.scope) || options.scope.repository !== repository ? undefined : options.scope.path;
    const evidence = `${repository}@${commit}${path === undefined ? '' : `:${path}`}`;
    return { kind: 'fact', evidence, value: fact };
  };
  if (!isProductScope(options.scope)) {
    const remaining = options.places.map((place) => place.place).filter((place) => !options.covered.includes(place));
    const commit = options.commit ?? options.places.find((place) => place.commit !== '')?.commit ?? '';
    return [write(options.scope.repository, commit, options.unit.id, options.complete, options.covered, unreadOf(remaining))];
  }
  // A unit of the whole product: one fact per repository place, each saying what of the product's reading it was, and
  // the gap of a cut enumeration named once, beside the first place's coverage.
  const places = [...options.places].sort((left, right) => byCodePoint(left.repository, right.repository) || byCodePoint(left.id, right.id));
  return places.map((place, index) => {
    const covered = options.covered.includes(place.place);
    const unread: CoverageGap[] = covered
      ? [...(index === 0 && options.cut ? [{ what: options.cutGap, reason: 'budget' as const }] : [])]
      : unreadOf([]).filter(() => false).concat([{ what: place.place, reason: 'budget' as const }, ...(index === 0 && options.cut ? [{ what: options.cutGap, reason: 'budget' as const }] : [])]);
    // A unit's own verdict governs every place of it: a `partial` answer, or a cut place list, is no complete coverage
    // of anything the unit was shown (0026 and 0005: a complete coverage is the only ground for a claim of absence).
    return write(place.repository, place.commit, PRODUCT_SCOPE_NAME, options.complete && covered, covered ? [place.place] : [], unread);
  });
}

// ---------------------------------------------------------------------------------------------
// One attempt: the packet, the session, the limits, and what the unit hands over
// ---------------------------------------------------------------------------------------------

/** What one attempt is wired with, once the stage has resolved it. */
interface AttemptWiring {
  readonly declaration: AgentStageDeclaration;
  readonly agent: AcpAgentSpec;
  readonly snapshots: SnapshotSource;
  readonly clock: () => number;
  readonly timers: UnitTimers;
  readonly source: FactSource;
  readonly kinds: readonly string[];
  readonly cwd?: string;
  readonly timeouts?: { readonly initializeMs?: number; readonly sessionMs?: number };
}

/** The commit the run pinned one repository at, as the run's own source answers it. */
async function pinnedCommit(snapshots: SnapshotSource, repository: string): Promise<string> {
  const pins = await snapshots.pins();
  const pin = pins.find((candidate) => candidate.id === repository);
  if (pin === undefined) {
    raise(`the run pinned no repository named ${JSON.stringify(repository)}: this unit's scope is read at the run's own pin, and the run's pins are ${pins.map((candidate) => candidate.id).join(', ') || 'none'}`);
  }
  // The reader resolves a pin that names a branch or a short id to the commit it stands at, which is the commit
  // a unit's evidence cites (`SnapshotReader.commit`).
  const reader = await snapshots.open(repository);
  return reader.commit;
}

/** Every repository the product pins, at the commit each stands at: what a unit of the whole product may write about. */
async function pinnedRepositories(snapshots: SnapshotSource): Promise<readonly UnitPacketRepository[]> {
  const pins = await snapshots.pins();
  const repositories: UnitPacketRepository[] = [];
  for (const pin of [...pins].sort((left, right) => byCodePoint(left.id, right.id))) {
    if (pin.form !== 'code' && pin.form !== 'product') continue;
    const reader = await snapshots.open(pin.id);
    repositories.push({ repository: pin.id, commit: reader.commit, form: pin.form });
  }
  return repositories;
}

/**
 * Runs one unit: its packet, its ACP session with the unit's own MCP server, its
 * limits, and then what it hands over — a draft when it finished, or its partial
 * draft with the coverage and the children its scope splits into.
 */
async function executeUnit(wiring: AttemptWiring, unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  const { declaration } = wiring;
  const tools = context.tools;
  if (tools === undefined) {
    // A unit that runs an agent reads and writes only through its own MCP server (0026, "Agents and tools"): a run
    // that opened none would start an agent with no way to read, which is a wiring failure and not a small unit.
    raise(`the agent unit "${unit.id}" (${unit.scope}) was started with no MCP server: a stage whose units run an agent declares \`usesTools\`, and the run that opens units' tools wires them (src/fill/orchestrator-host.ts)`);
  }
  const limits = context.config.limits;
  const scope = writeScope(unit.scope);
  const product = isProductScope(scope);
  const repositories = product ? await pinnedRepositories(wiring.snapshots) : undefined;
  const commit = product ? undefined : await pinnedCommit(wiring.snapshots, scope.repository);
  const packet = await buildUnitPacket({
    unit: { id: unit.id, scope: unit.scope },
    ...(product
      ? { product: repositories ?? [] }
      : { scopeId: unit.id, repository: scope.repository, ...(scope.path === undefined ? {} : { path: scope.path }), commit: commit ?? '' }),
    graph: context.graph,
    limits,
    kinds: wiring.kinds,
    task: declaration.task,
    role: declaration.role,
    rules: declaration.rules,
    answer: declaration.answer,
    // The level of the fill's three this stage's statements stand at (self-filling's outcome 4), and 0026's scale the
    // stage is one unit of: the fixed part tells every unit of both.
    level: declaration.level,
    scale: resolvedScale(declaration.scale),
    ...(declaration.sections === undefined ? {} : { sections: declaration.sections }),
  });
  // What the unit's places are, read before the session opens: the unit's own coverage counts them, a split names
  // them as its children, and a unit asked again for its answer is shown them (`places` is a graph read like any
  // other, and it is recorded as this generation's dependency).
  const placeSet = await declaration.places({ unit, scope, packet, graph: context.graph });
  const guard = createUnitLimitGuard({ limits, clock: wiring.clock });
  context.progress(`the packet for ${unit.scope} is ${String(packet.tokens)} tokens in ${String(packet.sections.length)} sections`, 0);
  if (packet.marker !== null) context.progress(`the packet of ${unit.scope} was cut by 0026's ${String(PACKET_TOKENS)}-token cap: ${packet.marker}`);

  const connection: AcpConnection = await connectAcpAgent(wiring.agent, {
    cwd: wiring.cwd ?? process.cwd(),
    ...(wiring.timeouts?.initializeMs === undefined ? {} : { timeoutMs: wiring.timeouts.initializeMs }),
    ...(wiring.timeouts?.sessionMs === undefined ? {} : { sessionTimeoutMs: wiring.timeouts.sessionMs }),
  });
  let stopCause: UnitLimitCause | undefined;
  let aborted = false;
  let answer: AgentAnswerValue | undefined;
  /** Whether the session has already shown the unit past 70%: the signal goes once, as its own turn. */
  let wrapPending = false;
  let wrapSent = false;
  /** Why the last turn was no answer, as the unit is told when it is asked again. */
  let refusal: string | undefined;
  /** How much of what the unit's own server answered has already been added to the guard's count. */
  let answeredCounted = 0;
  try {
    await connection.initialize();
    const session: AcpSession = await connection.newSession({ cwd: wiring.cwd ?? process.cwd(), mcpServers: [tools.mcpServer] });
    /** The turn in flight, whose own end is the client's: aborted here, it sends `session/cancel` and stops waiting. */
    let turnInFlight: AbortController | undefined;
    // A run's cancellation revokes this attempt's authority (`orchestrator.authority`): the turn in flight is
    // cancelled through the protocol, and the unit ends rather than writing a draft the machine will refuse.
    const onAbort = (): void => { aborted = true; turnInFlight?.abort(); };
    // Registered whatever the signal says: a cancellation that arrives after this line is sent through the protocol.
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) aborted = true;
    let prompt = packet.prompt;
    let turns = 0;
    try {
      for (;;) {
        // A cancellation that came while the packet was built or the session opened is honoured here: an attempt
        // whose authority was revoked spends no turn at all (0027: the intent revokes authority, then aborts).
        if (aborted) break;
        turns += 1;
        // What madarch itself puts into the session, counted once: the packet, the wrap-up message and every nudge
        // are each sent as one turn, and the loop counts each at the moment it sends it.
        guard.sent(estimateTokens(prompt, DEFAULT_GRAPH_READ_LIMITS));
        // 0026's clock while the turn runs: the watch reads the guard's own time, and a turn that streams nothing — the
        // one moment no update can carry — is cancelled at the unit's ten minutes like a turn that streams
        // (madarch-tzte.38). The watch is armed before the prompt and disarmed by its end, so nothing outlives the turn
        // it bounds.
        const turn = new AbortController();
        turnInFlight = turn;
        const watch = watchUnitTimeLimit({
          guard,
          timers: wiring.timers,
          onStop: (cause) => {
            // The watch's cause is the guard's own: the unit ends at that limit, and the turn in flight is cancelled.
            // A stop an update already named keeps its cause, which is the same limit either way.
            if (stopCause === undefined) stopCause = cause;
            turn.abort();
          },
          onWrap: () => { wrapPending = true; },
        });
        let result: AcpPromptResult;
        try {
          result = await session.prompt(prompt, {
            signal: turn.signal,
            onUpdate: (update: AcpUpdate) => {
              if (update.kind !== 'usage') return;
              const judged = guard.observe({
                ...(update.contextUsed === undefined ? {} : { contextUsed: update.contextUsed }),
                ...(update.contextSize === undefined ? {} : { contextSize: update.contextSize }),
              });
              if (judged.kind === 'wrap') {
                // 0026's wrap-up signal, crossed while the turn runs: ACP cannot speak into a turn in flight, so the
                // signal is remembered and sent as the unit's own next turn — unless this turn answers first.
                wrapPending = true;
              }
              if (judged.kind === 'stop' && stopCause === undefined) {
                // 0026's hard stop: the turn in flight is cancelled through the protocol, and the unit keeps what it
                // has. The prompt then ends as `cancelled`, which is not a failure of the agent.
                stopCause = judged.cause;
                turn.abort();
              }
            },
          });
        } finally {
          watch.disarm();
          turnInFlight = undefined;
        }
        if (stopCause !== undefined || aborted) break;
        // 0026 counts "the session and the server": the answers this unit's own MCP server returned are in the same
        // context, so what it has answered is added to madarch's own count before this turn is judged.
        const answered = tools.answered?.() ?? 0;
        if (answered > answeredCounted) {
          guard.sent(answered - answeredCounted);
          answeredCounted = answered;
        }
        const judged = guard.observe({
          turns,
          ...(result.usage?.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
        });
        if (judged.kind === 'stop') { stopCause = judged.cause; break; }
        // The answer, judged against the fields the stage declared: a turn that is no answer says which field was
        // wrong, and the unit is asked again with that in front of it — inside 0026's turn limit.
        const read = readAgentAnswer(result.text, declaration.answer);
        if (read.answer !== undefined) { answer = read.answer; break; }
        refusal = read.refusal;
        if ((judged.kind === 'wrap' || wrapPending || guard.warned()) && !wrapSent) {
          // Once, and as a turn of its own: the unit is told what it spent and that this is its last chance to put
          // what it has into the graph. A later turn without an answer is a nudge, not a second warning.
          wrapSent = true;
          context.progress(`the unit is told to wrap up: ${guard.describe(judged.kind === 'wrap' ? judged : { kind: 'within', state: guard.state() })}`, 0.7);
          prompt = guard.wrapUpMessage();
          continue;
        }
        // No answer and no limit: the unit is asked again, with what was wrong with its answer and the places its
        // scope holds so its answer can name them. This is a turn of its own, and the turn limit bounds it.
        prompt = nudgeMessage(declaration, scope, placeSet.places, refusal);
      }
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }
  } finally {
    await connection.close();
  }

  const writes = context.draft.writes().writes;
  const covered = coveredOf({ answer, writes: [...writes], places: placeSet.places });
  const remaining = placeSet.places.map((place) => place.place).filter((place) => !covered.includes(place));
  // A scope whose place list was cut is not a scope this unit can call read whole, whatever it covered of what it
  // was shown, and neither is a scope its own answer called `partial`: the places nobody enumerated, and the unit's
  // own word for not finishing, are what keep its coverage from claiming a whole it never read (0026 and 0005: a
  // complete coverage is the only ground for a claim of absence).
  const complete = answer?.status === 'done' && remaining.length === 0 && !placeSet.cut;
  if (stopCause !== undefined) {
    // One line a watching person reads: which limit the unit stopped at, and what it had spent when it did.
    context.progress(`${unit.id} stopped: ${guard.describe({ kind: 'stop', cause: stopCause, state: guard.state() })}`, undefined);
  }
  if (aborted) {
    // A cancelled run: the machine has already moved this generation (`cancelRun`), so the stage hands back a
    // block whose words say what happened; the machine refuses it by name and the attempt reports that refusal.
    return { outcome: 'blocked', reason: 'cancelled: the run or the unit was cancelled while this attempt ran' };
  }

  // The coverage every unit leaves behind: what it read and what it did not, never a silent gap.
  for (const write of coverageWrites({
    unit: { id: unit.id, scope: unit.scope },
    scope,
    source: wiring.source,
    places: placeSet.places,
    covered,
    cut: placeSet.cut,
    complete,
    cutGap: product
      ? `the repositories of the product its place list did not hold (the list was cut by the answer's cap)`
      : `the places of ${scopeText(scope)} its member list did not hold (the list was cut by the answer's cap)`,
    ...(commit === undefined ? {} : { commit }),
  })) {
    context.draft.write(write);
  }

  if (complete) {
    // Every place of the scope is covered: this unit's set is its draft, published in one transaction (0027).
    context.progress(`${unit.scope} covered ${String(covered.length)} of ${String(placeSet.places.length)} places`, 1);
    return { outcome: 'draft' };
  }
  const children = childrenOfPlaces({ scope, places: placeSet.places, covered });
  if (children.length === 0) {
    // Nothing of the scope is left that could be a unit's own scope (a file's symbols are no place): the draft goes
    // as it stands, and its coverage says what was not read. A smaller scope is never claimed as a whole one.
    return { outcome: 'draft' };
  }
  context.progress(`${unit.scope} covered ${String(covered.length)} of ${String(placeSet.places.length)} places; ${String(children.length)} ${children.length === 1 ? 'child is' : 'children are'} planned for the rest`, 0);
  return { outcome: 'split', children };
}

/** How many places one nudge names: a message the unit reads at 70% of its window is no second packet. */
export const MAX_NUDGE_PLACES = 40;

/**
 * The turn that asks a unit without an answer for one, naming what was wrong with the
 * last one and the places its scope holds. A refusal the answer schema made is told as
 * it stands: the field it names is what the unit has to write again.
 */
function nudgeMessage(declaration: AgentStageDeclaration, scope: WriteScope, places: readonly AgentPlace[], refusal: string | undefined): string {
  const named = [...new Set(places.map((place) => place.place))].sort(byCodePoint);
  const unique = named.slice(0, MAX_NUDGE_PLACES);
  const cut = named.length - unique.length;
  // A unit of the whole product covers repositories, and the turn that has to fix its answer names them as they are: a
  // message about "the scope *" would tell an agent its scope holds no place at all (0026's "asked again" turn).
  const scopeWords = isProductScope(scope) ? 'The repositories of the product' : `The places of ${scopeText(scope)}`;
  return [
    'That was not the answer this unit contract asks for.',
    ...(refusal === undefined ? [] : [`What was wrong with it: ${refusal}.`]),
    `Answer now with exactly one JSON object: ${declaration.answer.shape}`,
    unique.length === 0 ? `${scopeWords} are none of its own: answer with what you read of it.` : `${scopeWords} are: ${unique.join(', ')}${cut > 0 ? ` (and ${String(cut)} more, cut from this message)` : ''}.`,
    'Tick the places you read to the end in `covered` and the ones you did not in `remaining`. Write what you established with the tools before you answer.',
  ].join(' ');
}
