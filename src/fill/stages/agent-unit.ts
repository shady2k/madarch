/**
 * The fill's agent unit, as a stage of the shared shape (madarch-tzte.22.3 on the
 * shape of madarch-tzte.24.1; decisions 0026 and 0027): one unit reads one scope of
 * one product's pinned code through its own MCP server, writes what it establishes
 * into the product graph as a draft, and answers within 0026's "Units and limits".
 *
 * **What this module is now.** The landed stage of madarch-tzte.22.3, kept as the
 * shape's own reference declaration: `src/fill/stages/agent-stage.ts` runs the shape
 * every agent stage of 0026's stages 8 to 13 is built from, and this file states the
 * generic unit in its terms — a unit per repository and per member place, the answer
 * shape of 0026's unit contract, and the kinds an agent unit may write. The six stages
 * of the fill declare themselves in their own modules (`overview.ts` is stage 8), and
 * a run registers those, not this one: this stage would read the same scopes a second
 * time and spend the owner's caps on a claim set no stage of 0026 asks for.
 *
 * **What one unit is.** A scope in the graph's own terms, and the unit's id is the
 * scope node's fact id — never a run, a time or an attempt (0026, "Updates"). The
 * plan names one unit per repository; a repository whose estimate is past 0026's
 * planned size is planned as its member places, one level at a time and within a
 * bound, because "split until a unit's estimate (computed from the graph) fits" is
 * what the plan's recursion is for.
 *
 * **What a unit that reaches a limit does.** It returns what it has with its coverage:
 * the facts it wrote stay in its draft set, a `coverage` fact says which places of the
 * scope it read and which it did not — a `budget` gap, every gap counted — and the unit
 * answers `split` with the places it did not cover as its children. The orchestrator
 * seals the child set with the parent's checkpoint and runs the parts (0027); the
 * parent joins when they published, and its own next attempt starts from the graph
 * they filled.
 *
 * **What this stage does not decide.** The limits are the product's and 0027's
 * (`context.config.limits`); the split bounds (depth, children, work) are the
 * orchestrator's (`OrchestratorLimits`); the agent is the run's wiring. Nothing here
 * re-decides them.
 */
import type { FillStage } from '../stage.js';
import { readAgentAnswer, UNIT_ANSWER, UNIT_ROLE } from '../agent-packet.js';
import { planUnits } from './agent-stage.js';
import {
  agentIdentity,
  createAgentStage,
  memberPlaces,
  type AgentStageDeclaration,
  type AgentStageWiring,
} from './agent-stage.js';
export { agentIdentity };

/** The stage's id, as it is registered: one agent unit per scope, decision 0026's stages 8 to 13. */
export const AGENT_UNIT_STAGE_ID = 'agent-unit';

/** The stage's own version, bumped when what it plans, runs or writes changes. */
export const AGENT_UNIT_STAGE_VERSION = 2;

/**
 * The fact kinds one agent unit may write: a claim (0004's atom at 0005's inferred
 * layer), a rule, a state of a machine, an entity a document could be about, a
 * question for a person, the coverage every stage of the fill reports in, and the
 * two edges an agent stage draws — `interaction` (one element uses another) and
 * `transition` (one state goes to another). The edges are here because 0026 makes
 * `link` one of the unit's tools: a kind the stage did not declare would be refused
 * after the unit had done its work, and the refusal would spend the unit's draft.
 * A link that names the unit's own scope node as an end does move the packet's own
 * edge counts, which costs one replacement generation (the change record names it).
 */
export const AGENT_UNIT_KINDS: readonly string[] = [
  'claim', 'coverage', 'entity-proposal', 'interaction', 'question', 'rule', 'state', 'transition',
];

/** The task the unit's own prompt carries: what an agent unit is for, in one sentence. */
export const AGENT_UNIT_TASK = 'Read the scope you are given, understand it, and write what you establish as facts of the graph, cited to the bytes you read.';

/**
 * The generic unit's declaration: the shape's own words for a unit that reads one
 * scope of the pinned code and writes what it establishes. Every agent stage of
 * 0026's stages 8 to 13 differs from it in its role, its rules, its answer, its packet
 * sections, its plan and the kinds it may write, and in nothing else.
 */
export const AGENT_UNIT_DECLARATION: AgentStageDeclaration = {
  id: AGENT_UNIT_STAGE_ID,
  version: AGENT_UNIT_STAGE_VERSION,
  // The unit covers one scope of one repository and writes what it means, as an assumption (self-filling's outcome 4).
  factStage: '12-understanding',
  level: 'meaning',
  scale: { level: 'repository', child: 'place' },
  // The shape's own role: one unit that reads one scope of the pinned code and writes what it establishes.
  role: UNIT_ROLE,
  rules: [],
  task: AGENT_UNIT_TASK,
  answer: UNIT_ANSWER,
  kinds: AGENT_UNIT_KINDS,
  consumes: {
    required: [
      // A unit reads the deterministic stages' facts: the repositories and their places, the files, and what
      // those stages said they could not read.
      { capability: 'repository', scope: 'repository', freshness: 'current' },
      { capability: 'file', scope: 'file', freshness: 'current' },
      { capability: 'coverage', scope: 'repository', freshness: 'current' },
    ],
    // Read when the run has them: the modules a later clustering proposes, and the claims an earlier agent
    // pass made. A run without them reads as a run that has nothing of that kind yet.
    optional: [
      { capability: 'claim', scope: 'repository', freshness: 'any' },
      { capability: 'module', scope: 'cluster', freshness: 'any' },
    ],
  },
  plan: (graph) => planUnits(graph),
  places: (context) => memberPlaces(context),
};

/** What the stage is wired with: the agent program, the clock its limits read, the run's pins, and where the agent runs. */
export type AgentUnitWiring = AgentStageWiring;

/**
 * The agent unit stage, registered over the run's wiring. A run that wires no agent
 * registers no agent union stage at all (`stages/index.ts`), so a product whose fill
 * has no agent never plans a unit that could read nothing. The shape gives the stage its
 * cache key's version part (madarch-tzte.26.1): the prompt it sends, the answer it asks
 * for and the agent it is driven with.
 */
export function createAgentUnitStage(wiring: AgentUnitWiring): FillStage {
  return createAgentStage(AGENT_UNIT_DECLARATION, wiring);
}

/**
 * One turn's text, read as the generic unit's answer, or `undefined` when it holds
 * none: the landed signature of madarch-tzte.22.3, over the shape's own reader.
 */
export function readUnitAnswer(text: string): { readonly status: 'done' | 'partial'; readonly covered: readonly string[]; readonly remaining: readonly string[]; readonly summary?: string } | undefined {
  const read = readAgentAnswer(text, UNIT_ANSWER).answer;
  if (read === undefined) return undefined;
  return {
    status: read.status,
    covered: read.covered,
    remaining: read.remaining,
    ...(read.texts['summary'] === undefined ? {} : { summary: read.texts['summary'] }),
  };
}


export {
  MAX_PLAN_DEPTH,
  MAX_PLAN_UNITS,
  SPLIT_CHILDREN,
  coveredOf,
  childrenOfPlaces,
  placeMembers,
  planUnits,
  productUnits,
  repositoriesOf,
  repositoryNameOf,
  repositoriesRead,
  heldRead,
  memberPlaces,
  pathOfPlace,
  coverageWrites,
  validateDraft,
  type AgentPlace,
  type AgentPlaceSet,
  type AgentPlaceReader,
  type AgentScaleLevel,
  type AgentStageDeclaration,
  type AgentStageScale,
  type AgentStageWiring,
  type AgentUnitContext,
  type AgentLevel,
  type MemberPlace,
} from './agent-stage.js';
