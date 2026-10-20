/**
 * Stage 12 of the fill, the modules understood bottom-up (decision 0026, "stage 12
 * module understanding bottom-up (leaves first, parents from children's summaries)";
 * madarch-tzte.24.5), on the agent-stage shape of `src/fill/stages/agent-stage.ts`.
 *
 * **One unit per module, leaves first.** The plan (`moduleUnits`) reads the module
 * tree the deterministic stages published — one `module` fact per cluster, its
 * parent named in its own value — and names one unit per module, ordered deepest
 * first: a leaf is planned before its parent, so the run admits the leaves first
 * and a parent finds its children's work in the graph. A unit's scope is its
 * repository: a module's members stand in it, and its claims cite their bytes.
 *
 * **A parent waits for its children's publication.** The ordering is the
 * orchestrator's own dependency mechanism (decision 0027): a unit whose module has
 * child modules splits into them before it reads anything — the split seals the
 * children, the unit stands down at `waiting_children`, and the run joins it only
 * when every sealed child has published and is fresh. The join is what tells the
 * unit to run: the attempt that follows it finds the sealed set in its context
 * (`StageContext.sealedChildren`), sees that nothing of its scope is left
 * unsealed, and only then builds its packet — whose `childrenSummaries` section
 * reads the `summarizes` claim each child published. No attempt before the join
 * reads those claims: a read is recorded as the generation's dependency, and an
 * empty answer that a child's later publication turns non-empty would refuse this
 * unit's own publication for good (0027's staleness rechecks every read the
 * generation ever recorded). The children are named by the split, never
 * discovered by a read that moves.
 *
 * **What a module gets.** One `summarizes` claim whose text is the module's bounded
 * summary — the ~2K tokens its parent reads instead of reading it again;
 * `responsible-for` claims for its responsibilities; a `serves-as` claim for its
 * role; and `rule` facts for the business rules its code carries, each with the
 * evidence span of the lines that carry it. Every write is an agent's reading:
 * 0005's `inferred` layer, always `proposed`, at self-filling's `meaning` level.
 *
 * **The two bounds 0026 fixes, held twice.** A summary is bounded at
 * `resolvedScale`'s `summaryTokens` (~2K) when the packet's section reads it, and
 * the fan-in is bounded at its `fanIn` (~50): the plan refuses a module whose
 * children stand past the bound — the tree's grouping is the deterministic stages'
 * own (the modules stage groups a wide folder's children into `part-1`, `part-2`
 * clusters by the same rule of 0026's "Scale") — and the packet's section holds at
 * most the bound's rows, any further cut named in the packet's marker. A parent of
 * many children reads groups, whose units are modules like any other and are
 * planned bottom-up with the rest.
 */
import { byCodePoint } from '../../model/order.js';
import {
  DEFAULT_GRAPH_READ_LIMITS,
  factsOfRows,
  graphReadsOver,
  readText,
  type GraphReadContext,
} from '../graph-reads.js';
import type { Fact } from '../facts.js';
import { raise } from '../fsm-core.js';
import { estimateOfMembers } from '../agent-packet.js';
import { unitIdFor } from '../orchestrator.js';
import { writeScope } from '../checked-writes.js';
import type { FillStage, StageContext, StageExecutionResult, StageGraphReader, StagePlan, StageUnit } from '../stage.js';
import {
  SPLIT_CHILDREN,
  createAgentStage,
  memberPlaces,
  resolvedScale,
  type AgentStageDeclaration,
  type AgentStageWiring,
} from './agent-stage.js';
import type { AgentPacketSection, AgentSectionRequest } from '../agent-packet.js';

/** The stage's id, as it is registered. */
export const UNDERSTANDING_STAGE_ID = 'understanding';

/** The stage's own version, bumped when what it plans, runs or writes changes. */
export const UNDERSTANDING_STAGE_VERSION = 1;

/**
 * The fact kinds a unit of this stage may write: the claims a module's summary,
 * responsibilities and role are, and the business rules its code carries. The
 * coverage every unit leaves behind is the shape's own
 * (`src/fill/stages/agent-stage.ts`).
 */
export const UNDERSTANDING_KINDS: readonly string[] = ['claim', 'rule'];

/**
 * The predicate a module's own summary claim carries: the one claim of a module its
 * parent reads as the child's bounded summary (0026: "Summaries are bounded (~2K
 * tokens)"). The stage's other claims name their predicates in the fixed part;
 * this one is the contract between a child unit and its parent's packet.
 */
export const UNDERSTANDING_SUMMARY_PREDICATE = 'summarizes';

/** The most rows the children's summaries hold: the fan-in bound, as the section's own cap. */
export const UNDERSTANDING_SUMMARY_ROWS = 50;

/** One child module of the unit's module, as the ordering and the packet read it. */
export interface ChildModule {
  /** The child module's fact id: a sealed child unit is named by it (0026: ids carry no run). */
  readonly id: string;
  /** The child's name, as the tree spelled it (`checkout-payment`). */
  readonly name: string;
  /** How many files and symbols the child holds, as the tree counted them. */
  readonly members: number;
  /** The importance the tree's ranking gave the child, for the order a cut reads in. */
  readonly importance: number;
}

/** The summary of one child, as its parent's packet holds it. */
export interface ChildSummary {
  /** The child module's fact id: the row names what the summary is about. */
  readonly module: string;
  /** The child's name. */
  readonly name: string;
  /** The child's summary text, or `null` when it published none: a missing summary is a child that did not finish, never an empty one. */
  readonly summary: string | null;
}

/** The text of the read that names a module's child modules: `{"read":"facts-with","kind":"module","field":"parent","value":"<id>"}`. */
function childrenRead(moduleId: string): string {
  return readText({ read: 'facts-with', kind: 'module', field: 'parent', value: moduleId });
}

/** One module fact as the tree reads it: its id, name, parent, member count and importance. */
function moduleOf(fact: Fact): { readonly id: string; readonly name: string; readonly parent: string | undefined; readonly members: number; readonly importance: number } {
  const value = (fact.value ?? {}) as { name?: unknown; parent?: unknown; members?: unknown; importance?: unknown };
  if (typeof value.name !== 'string' || value.name === '') {
    raise(`the module fact ${fact.id} carries the name ${String(value.name)}: a module is named by its own value, and a unit is planned per named module`);
  }
  return {
    id: fact.id,
    name: value.name,
    parent: typeof value.parent === 'string' ? value.parent : undefined,
    members: typeof value.members === 'number' && Number.isFinite(value.members) && value.members >= 0 ? value.members : 1,
    importance: typeof value.importance === 'number' && Number.isFinite(value.importance) ? value.importance : 0,
  };
}

/** The child modules one read named, in code point order of their ids: the list a split and a packet both read. */
function childrenOfFacts(facts: readonly Fact[], read: unknown): readonly ChildModule[] {
  return facts.map((fact) => {
    const value = (fact.value ?? {}) as { repository?: unknown };
    if (typeof value.repository !== 'string') {
      raise(`the read ${String(read)} answered the module fact ${fact.id}, which names no repository: a child module is read as a fact of the schema, and the schema's module value names its repository`);
    }
    return moduleOf(fact);
  }).sort((left, right) => byCodePoint(left.id, right.id));
}

/**
 * The child modules of one module, read through the unit's own reader: one tracked
 * read whose membership is the tree's own and never moves while the run runs (the
 * deterministic stages published the tree, and nothing of a run republishes it).
 * An answer that holds a row that is no module fact is raised, never skipped: the
 * list a split and a packet read is the tree's own, and a smaller silent list
 * would leave a child no unit names (0026's "no silently smaller result").
 */
export async function childModulesOf(reads: GraphReadContext, moduleId: string): Promise<readonly ChildModule[]> {
  const read = { read: 'facts-with' as const, kind: 'module' as const, field: 'parent', value: moduleId };
  const rows = await reads.read(read);
  const facts = factsOfRows(rows, read);
  if (facts.length !== rows.length) {
    raise(`the read ${childrenRead(moduleId)} answered ${String(rows.length)} rows and ${String(facts.length)} facts: a child read answers facts of one kind, and a duplicate id is a store defect, not a smaller tree`);
  }
  return childrenOfFacts(facts, read);
}

/** The bound one summary is read at, in code points, as the fill's own estimate counts them. */
export function summaryCodePoints(): number {
  return resolvedScale({ level: 'cluster', child: 'place' }).summaryTokens * DEFAULT_GRAPH_READ_LIMITS.charactersPerToken;
}

/** One summary as a row holds it: cut to the bound, the cut marked with an ellipsis a reader sees. */
export function boundSummary(text: string): string {
  const points = [...text];
  const limit = summaryCodePoints();
  if (points.length <= limit) return text;
  return points.slice(0, limit - 1).join('') + '…';
}

/** The text one summary claim states, as its object's literal or its own words. */
function summaryTextOf(claim: Fact): string | null {
  const value = (claim.value ?? {}) as { object?: { form?: unknown; text?: unknown }; text?: unknown };
  if (value.object !== undefined && typeof value.object === 'object' && value.object.form === 'literal' && typeof value.object.text === 'string') {
    return value.object.text;
  }
  return typeof value.text === 'string' ? value.text : null;
}

/**
 * The sections this stage adds to the shape's packet: the bounded summary each
 * child module published, one row per child in code point order of their ids. The
 * section belongs to the units of the module level — a unit of one repository
 * whose scope names no path — because a path unit a split sealed covers a place,
 * and a place has no child modules. Each row's reads go through the unit's own
 * reader, recorded as its dependency like every other; the section is built only
 * where the wrapper has already established that every child sealed and settled,
 * so the summaries a row reads are present and do not move again before this unit
 * publishes (0027's staleness, which rechecks every read of the generation).
 */
export function understandingSections(): readonly AgentPacketSection[] {
  /** 0026's levels: this section describes a module, and a unit of the place level reads the shape's own. */
  const moduleLevel = (request: AgentSectionRequest): boolean => request.scope.path === undefined;
  return [
    {
      name: 'childrenSummaries',
      what: 'the bounded summary each child module below this one published',
      max: UNDERSTANDING_SUMMARY_ROWS,
      when: moduleLevel,
      rows: async (request) => {
        const reads = request.reads;
        const children = await childModulesOf(reads, request.unit.id);
        const rows: ChildSummary[] = [];
        for (const child of children) {
          const claimRead = { read: 'facts-with' as const, kind: 'claim' as const, field: 'subject.id', value: child.id };
          const claims = factsOfRows(await reads.read(claimRead), claimRead);
          // The child's own summary is the one claim of the summary predicate: its responsibilities and role
          // stand beside it on its page, and its parent reads the summary alone (0026: a parent reads bounded
          // summaries, not its children's whole reading). Where a child published more than one, the first in
          // code point order of their ids is the one the row holds, and the rest are its page's.
          const summaries = claims.filter((claim) => {
            const value = (claim.value ?? {}) as { predicate?: unknown };
            return value.predicate === UNDERSTANDING_SUMMARY_PREDICATE;
          });
          const held = summaries[0];
          const text = held === undefined ? null : summaryTextOf(held);
          rows.push({ module: child.id, name: child.name, summary: text === null ? null : boundSummary(text) });
        }
        return rows;
      },
    },
  ];
}

/**
 * The answer stage 12's units give: how far the unit read its module, the members
 * it covered and those it did not, and one sentence on what it established. The
 * claims themselves are the unit's writes, checked one at a time by the unit's own
 * server (0026, "Writing"), never a list in the answer.
 */
const UNDERSTANDING_ANSWER = {
  shape: '{"status":"done"|"partial","covered":["<a member of your module>"],"remaining":["<a member of your module>"],"summary":"<one sentence on what you established>"}',
  reading: [
    '`covered` names every member of your module you read to the end — through the graph its packet points at and the spans `evidence_span` gives you; `remaining` names the members you did not read, and a child module whose summary the packet held as `null` is one you did not read either. A `done` answer whose `remaining` is not empty is read as `partial`, and what you leave out is never reported as covered.',
  ],
  example: '{"status":"done","covered":["src/checkout/index.ts"],"remaining":[],"summary":"checkout totals the cart and hands the order on"}',
  fields: [
    { name: 'status', type: 'status' as const, required: true },
    { name: 'covered', type: 'places' as const, required: true },
    { name: 'remaining', type: 'places' as const, required: true },
    { name: 'summary', type: 'text' as const },
  ],
};

/**
 * Stage 12's declaration: the fixed part of a unit that understands one module
 * bottom-up, the sections its packet reads, and what it may write.
 */
export function understandingDeclaration(): AgentStageDeclaration {
  return {
    id: UNDERSTANDING_STAGE_ID,
    version: UNDERSTANDING_STAGE_VERSION,
    factStage: '12-understanding',
    // 0026's stage 12: what each module means, read from the code and the children's
    // summaries — assumed (self-filling's outcome 4), never a fact of the code.
    level: 'meaning',
    scale: { level: 'cluster', child: 'place' },
    role: "You are one unit of madarch's fill that understands the product's modules bottom-up: one module at a time, its leaves first, every parent from its children's bounded summaries, writing what each module is for, what it is responsible for and the business rules its code carries.",
    rules: [
      "Your understanding is bottom-up: the `childrenSummaries` section holds the bounded summary each child module below you published — read it first, and build on what the children established rather than reading their code again.",
      "Write one `summarizes` claim about this module: its subject is the module, its object is the summary itself as a literal, and its text is the bounded summary the modules above you will read instead of reading this module again — about two thousand tokens at most. A child whose summary the packet held as `null` did not finish: do not invent what it established, and answer `partial`.",
      "`responsible-for` claims state what the module is responsible for, each tied to the members and bytes that carry it; a `serves-as` claim states the module's role in one sentence: what it is for the whole.",
      "`rule` facts state the business rules you find in the code — a constraint, an invariant, a policy or a validation — each with the evidence span of the lines that carry it: a rule without a span is a guess, and the write path refuses it.",
      "Stay inside your module: your claims' subjects are this module and the nodes its members hold, and a write about another module's part is refused. When something you need stands outside your module, raise a question about it instead.",
    ],
    task: "Understand this module from the graph and its children's summaries, and write its summary, responsibilities, role and business rules as claims and rules cited to the bytes that carry them.",
    answer: UNDERSTANDING_ANSWER,
    kinds: UNDERSTANDING_KINDS,
    consumes: {
      // The module tree this stage reads is the deterministic stages' own: what the product is made of, per module.
      required: [
        { capability: 'repository', scope: 'repository', freshness: 'current' },
        { capability: 'module', scope: 'repository', freshness: 'any' },
      ],
      // The children's summaries are this stage's own earlier units' claims: the registry reads a stage's
      // consume of its own kind as what its own earlier run published, and no edge runs from it to itself.
      optional: [
        { capability: 'claim', scope: 'repository', freshness: 'any' },
      ],
    },
    sections: understandingSections(),
    plan: (graph) => moduleUnits(graph),
    places: memberPlaces,
  };
};

// ---------------------------------------------------------------------------------------------
// The plan: one unit per module, leaves first
// ---------------------------------------------------------------------------------------------

/**
 * The units the module tree gives this stage: one per module, ordered deepest
 * first — a leaf before its parent, so the run admits the leaves first — and,
 * within one depth, the more important modules first (0026: "important scopes go
 * first"), ties in code point order of the fact ids. The estimate is the tree's
 * own member count, in 0026's measure of one bounded span read each.
 *
 * The tree's own shape is verified where the plan reads it: a module whose children
 * stand past the fan-in bound refuses the plan by name, because 0026's bound ("~50
 * children, else an intermediate grouping level") is held by the tree's grouping —
 * the modules stage groups a wide folder's children into `part-1`, `part-2`
 * clusters — and a tree that skipped it would send a parent a cut list of its own
 * children, which is 0026's "no silently smaller result" in the plan itself.
 */
export async function moduleUnits(graph: StageGraphReader): Promise<StagePlan> {
  const reads = graphReadsOver(graph);
  const repositories = await repositoriesOf(reads);
  const modules = new Map<string, { readonly id: string; readonly name: string; readonly parent: string | undefined; readonly members: number; readonly importance: number; readonly repository: string }>();
  for (const repository of repositories) {
    const read = { read: 'facts-with' as const, kind: 'module' as const, field: 'repository', value: repository.repository };
    for (const fact of factsOfRows(await reads.read(read), read)) {
      const module_ = moduleOf(fact);
      const held = modules.get(module_.id);
      if (held !== undefined) {
        raise(`the module fact ${module_.id} was answered for ${repository.repository} and stands for ${held.repository}: a module fact names one repository, and the same id twice is a store defect`);
      }
      modules.set(module_.id, { ...module_, repository: repository.repository });
    }
  }
  if (modules.size === 0) return { units: [], coverage: 'nothing-found' };
  const bound = resolvedScale({ level: 'cluster', child: 'place' }).fanIn;
  const childrenOf = new Map<string, number>();
  for (const module_ of modules.values()) {
    if (module_.parent === undefined) continue;
    const parent = modules.get(module_.parent);
    if (parent === undefined) {
      raise(`the module ${module_.id} (${module_.name}) names the parent ${module_.parent}, and the graph holds no module fact of that id: a module's parent is a module fact of the same tree, and a parent that stands nowhere is a tree the modules stage did not finish`);
    }
    childrenOf.set(module_.parent, (childrenOf.get(module_.parent) ?? 0) + 1);
  }
  for (const [parentId, count] of [...childrenOf].sort((left, right) => byCodePoint(left[0], right[0]))) {
    if (count <= bound) continue;
    const parent = modules.get(parentId)!;
    raise(`the module ${parentId} (${parent.name}) of ${parent.repository} holds ${String(count)} child modules and the fan-in bound is ${String(bound)}: 0026's "else an intermediate grouping level" is the tree's own grouping — the modules stage groups a wide folder's children into part-1, part-2 clusters — and a tree that skipped it would send this parent a cut list of its own children`);
  }
  const depthOf = new Map<string, number>();
  const depth = (id: string): number => {
    const held = depthOf.get(id);
    if (held !== undefined) return held;
    const module_ = modules.get(id)!;
    const answer = module_.parent === undefined ? 0 : depth(module_.parent) + 1;
    depthOf.set(id, answer);
    return answer;
  };
  const units = [...modules.values()]
    .sort((left, right) => depth(right.id) - depth(left.id)
      || right.importance - left.importance
      || byCodePoint(left.id, right.id))
    .map((module_) => ({ id: module_.id, scope: module_.repository, estimatedTokens: estimateOfMembers(module_.members) }));
  return { units, coverage: 'planned' };
}

// ---------------------------------------------------------------------------------------------
// One unit: a parent seals its children first; the joined attempt understands the module
// ---------------------------------------------------------------------------------------------

/**
 * Runs one unit of the stage: a module with child modules splits into them before
 * it reads anything — the orchestrator seals them and stands the unit down, and
 * the run joins it when they have all published (0027's join) — and a module
 * without children, or a unit the join has already made whole, runs the shape's
 * own attempt: the packet, the session, the limits, the coverage and the split at
 * a limit.
 *
 * The split names the children the generation has not sealed yet, at most the
 * shape's own `SPLIT_CHILDREN` at once: the orchestrator refuses a split past its
 * own bound, and the rest are named by the next attempt, whose sealed set the
 * context holds. No read of the children's claims happens before the last of
 * them: an empty read a child's later publication turns non-empty would refuse
 * this unit's publication for good (0027 rechecks every read the generation ever
 * recorded), so the ordering is carried by the sealed set and the join alone.
 */
async function executeUnderstandingUnit(stage: FillStage, stageId: string, unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  if (writeScope(unit.scope).path !== undefined) return await stage.execute(unit, context);
  const reads = graphReadsOver(context.graph);
  const children = await childModulesOf(reads, unit.id);
  if (children.length === 0) return await stage.execute(unit, context);
  const sealed = new Set((context.sealedChildren ?? []).map((child) => child.unitId));
  const remaining = children.filter((child) => !sealed.has(unitIdFor(stageId, child.id)));
  if (remaining.length === 0) return await stage.execute(unit, context);
  const named = remaining.slice(0, SPLIT_CHILDREN);
  context.progress(`${unit.id} waits for its ${String(remaining.length)} ${remaining.length === 1 ? 'child module' : 'child modules'}: ${String(named.length)} ${named.length === 1 ? 'is' : 'are'} sealed now and the rest follow when these publish`, 0);
  return {
    outcome: 'split',
    children: named.map((child) => ({ id: child.id, scope: unit.scope, estimatedTokens: estimateOfMembers(child.members) })),
  };
}

/** One repository the graph holds, by its own name: what the plan reads the tree per. */
async function repositoriesOf(reads: GraphReadContext): Promise<readonly { readonly repository: string }[]> {
  const read = { read: 'facts-with' as const, kind: 'repository' as const, field: 'form', value: 'code' as const };
  const facts = factsOfRows(await reads.read(read), read);
  const held = new Map<string, string>();
  for (const fact of facts) {
    const value = (fact.value ?? {}) as { repository?: unknown };
    if (typeof value.repository !== 'string') {
      raise(`the repository fact ${fact.id} names no repository: a repository fact is named by its own value`);
    }
    held.set(value.repository, fact.id);
  }
  return [...held.keys()].sort(byCodePoint).map((repository) => ({ repository }));
}

// The places one unit covers are the shape's own (`memberPlaces`): the members of its
// module that stand at a path, one place per folder or file the packet listed. A child
// module is a unit of its own, never a place of its parent, and a module's own files
// are the places its coverage counts and its split at a limit names.

/**
 * Stage 12, registered over the run's wiring: the shape's own stage, whose execute
 * seals a parent's children before anything is read and runs the shape's attempt
 * once the join has made the unit whole.
 */
export function createUnderstandingStage(wiring: AgentStageWiring): FillStage {
  const stage = createAgentStage(understandingDeclaration(), wiring);
  return {
    ...stage,
    execute: (unit, context) => executeUnderstandingUnit(stage, UNDERSTANDING_STAGE_ID, unit, context),
  };
}
