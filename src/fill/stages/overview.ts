/**
 * Stage 8 of the fill, the product's overview hypothesis (decision 0026, "Stage 8
 * overview hypothesis"; madarch-tzte.24.1), on the agent-stage shape of
 * `src/fill/stages/agent-stage.ts`.
 *
 * **One unit per product.** The overview is the top of 0026's hierarchy — "so every
 * level, the product overview included, fits a unit" — so the plan names one unit for
 * the whole product (`productUnits`), whose scope is every repository the run pins
 * (`PRODUCT_SCOPE`, `src/fill/checked-writes.ts`) and whose places are those
 * repositories. A unit that cannot finish splits into them, one child per repository,
 * and its coverage says which of them it read.
 *
 * **What it reads.** The repository-level graph the deterministic stages built, and
 * nothing else: the product's repositories, its modules with the importance stage 5's
 * PageRank gave them, its entry points, its packages and its documents' sections (each
 * a read of the graph, recorded as the unit's dependency, and never a file's bytes).
 * That is 0026's "Agent input" for this stage — the scope, the place, the ranked
 * members, the entry points and the data of the whole product — with the intent the
 * graph already holds left to the unit's own `claims_about` tool (see the packet's own
 * rule in `src/fill/agent-packet.ts`).
 *
 * **What it writes.** Claims — 0004's atom at 0005's `inferred` layer, always
 * `proposed` — about the product and its parts, and questions where the graph does
 * not say enough. The level of its statements is `meaning` (self-filling's outcome 4:
 * "meaning (only assumed)"), so nothing it writes is a fact a reader may take as
 * confirmed, and its coverage is what tells a reader which repositories it read.
 */
import { byCodePoint } from '../../model/order.js';
import { isProductScope } from '../checked-writes.js';
import { estimateOfMembers, type AgentPacketSection, type AgentSectionRequest } from '../agent-packet.js';
import {
  factsOfRows,
  graphReadsOver,
  type GraphReadContext,
} from '../graph-reads.js';
import type { Fact } from '../facts.js';
import type { FillStage } from '../stage.js';
import { raise } from '../fsm-core.js';
import { createAgentStage, productUnits, repositoriesOf, repositoryNameOf, type AgentPlaceSet, type AgentStageDeclaration, type AgentStageWiring } from './agent-stage.js';

/** The stage's id, as it is registered. */
export const OVERVIEW_STAGE_ID = 'overview';

/** The stage's own version, bumped when what it plans, runs or writes changes. */
export const OVERVIEW_STAGE_VERSION = 1;

/**
 * The fact kinds a unit of this stage may write: the overview hypothesis is a claim,
 * and a question where the graph does not say enough to make one. The coverage every
 * unit leaves behind is the shape's own (`src/fill/stages/agent-stage.ts`).
 */
export const OVERVIEW_KINDS: readonly string[] = ['claim', 'question'];

/** The most modules one packet holds: the ranked top of the product, and the cut named when there are more. */
export const OVERVIEW_MODULE_ROWS = 80;

/** The most rows the packet's other lists hold, each bounded and its cut named like every other section's. */
export const OVERVIEW_SECTION_ROWS = 40;

/** One repository, module, entry point, package, document or section, as the packet names it. */
function rowOf(fact: Fact, fields: readonly string[]): Record<string, unknown> {
  const value = (fact.value ?? {}) as unknown as Record<string, unknown>;
  const row: Record<string, unknown> = { id: fact.id, kind: fact.kind };
  for (const field of fields) if (value[field] !== undefined) row[field] = value[field];
  return row;
}

/**
 * The facts of one kind the product's pinned repositories hold, read one repository
 * at a time: the grammar filters facts by one value field exactly, and a stage's own
 * reads are its dependencies, so a section that read every repository's modules says
 * so in its recorded reads.
 */
async function factsOfKind(reads: GraphReadContext, kind: string, repositories: readonly string[]): Promise<readonly Fact[]> {
  const held = new Map<string, Fact>();
  for (const repository of repositories) {
    const read = { read: 'facts-with' as const, kind: kind as 'module', field: 'repository', value: repository };
    for (const fact of factsOfRows(await reads.read(read), read)) held.set(fact.id, fact);
  }
  return [...held.values()];
}

/** The importance stage 5's PageRank gave one fact, for the order a section ranks by: `0` where it gave none. */
function importanceOf(fact: Fact): number {
  const importance = (fact.value as { importance?: unknown }).importance;
  return typeof importance === 'number' && Number.isFinite(importance) ? importance : 0;
}

/**
 * The sections this stage adds to the shape's packet: the product's repositories, its
 * modules ranked by importance, its entry points, its packages, and its documents and
 * their sections. Each is a read of the graph through the unit's own reader — the
 * product's repositories first, then one read per repository and kind — so every one
 * of them is a recorded dependency, and each is bounded with its cut named in the
 * packet's own marker.
 */
export function overviewSections(): readonly AgentPacketSection[] {
  /** 0026's levels: the sections below describe the product, and a unit of the repository level reads the shape's own. */
  const product = (request: AgentSectionRequest): boolean => isProductScope(request.scope);
  /** The product's repositories, in code point order of their names: what every section of this stage reads. */
  const names = async (request: AgentSectionRequest): Promise<readonly string[]> =>
    (await repositoriesOf(request.reads)).map((fact) => repositoryNameOf(fact)).sort(byCodePoint);
  /** The rows of one kind, ordered by `order`: the sections differ in what they rank by and what they show. */
  const section = (kind: string, what: string, max: number, fields: readonly string[], order: (left: Fact, right: Fact) => number): AgentPacketSection => ({
    name: kind === 'entry-point' ? 'entryPoints' : `${kind}s`,
    what,
    max,
    when: product,
    rows: async (request) => [...await factsOfKind(request.reads, kind, await names(request))]
      .sort((left, right) => order(left, right) || byCodePoint(left.id, right.id))
      .map((fact) => rowOf(fact, fields)),
  });
  /** A fact's value field as the sections order by it, as text. */
  const text = (fact: Fact, field: string): string => String((fact.value as unknown as Record<string, unknown>)[field] ?? '');
  /** The order two facts of one repository stand in: their repository, then the field that names them. */
  const byRepositoryThen = (field: string) => (left: Fact, right: Fact): number => byCodePoint(text(left, 'repository'), text(right, 'repository')) || byCodePoint(text(left, field), text(right, field));
  return [
    {
      name: 'repositories',
      what: 'the repositories of the product',
      max: OVERVIEW_SECTION_ROWS,
      when: product,
      rows: async (request) => [...await repositoriesOf(request.reads)]
        .sort((left, right) => byCodePoint(repositoryNameOf(left), repositoryNameOf(right)) || byCodePoint(left.id, right.id))
        .map((fact) => rowOf(fact, ['repository', 'form'])),
    },
    {
      name: 'modules',
      what: 'the modules of the product',
      max: OVERVIEW_MODULE_ROWS,
      when: product,
      // 0026's ranking: the modules PageRank made most important first, so a cut list holds the product's top; ties
      // in code point order of the repository, the name and the id, never the graph's own order.
      rows: async (request) => [...await factsOfKind(request.reads, 'module', await names(request))]
        .sort((left, right) => importanceOf(right) - importanceOf(left)
          || byCodePoint(text(left, 'repository'), text(right, 'repository'))
          || byCodePoint(text(left, 'name'), text(right, 'name'))
          || byCodePoint(left.id, right.id))
        .map((fact) => rowOf(fact, ['repository', 'name', 'parent', 'seed', 'members', 'importance'])),
    },
    section('entry-point', 'the entry points of the product', OVERVIEW_SECTION_ROWS, ['repository', 'name', 'form', 'file'], byRepositoryThen('name')),
    section('package', 'the packages and build targets of the product', OVERVIEW_SECTION_ROWS, ['repository', 'name', 'form', 'manifest'], byRepositoryThen('name')),
    section('document', 'the documents of the product', OVERVIEW_SECTION_ROWS, ['repository', 'path', 'title', 'mediaType'], byRepositoryThen('path')),
    section('section', "the sections of the product's documents", OVERVIEW_SECTION_ROWS, ['repository', 'document', 'anchor', 'heading', 'level'], (left, right) => byCodePoint(text(left, 'repository'), text(right, 'repository')) || byCodePoint(text(left, 'document'), text(right, 'document')) || byCodePoint(text(left, 'anchor'), text(right, 'anchor'))),
  ];
}

/**
 * The answer stage 8's units give: how far the unit read the product, the repositories
 * it covered and those it did not, and one sentence on the overview it wrote. The
 * claims themselves are the unit's writes, checked one at a time by the unit's own
 * server (0026, "Writing"), never a list in the answer.
 */
const OVERVIEW_ANSWER = {
  shape: '{"status":"done"|"partial","covered":["<a repository of the product>"],"remaining":["<a repository of the product>"],"summary":"<one sentence on the overview you wrote>"}',
  reading: [
    '`covered` names every repository of the product you read to the end — through the graph its packet points at and the spans `evidence_span` gives you; `remaining` names the repositories you did not read. A `done` answer whose `remaining` is not empty is read as `partial`, and the repositories you leave out are planned as units of their own.',
  ],
  example: '{"status":"done","covered":["orders-api","payments-api"],"remaining":[],"summary":"The product takes an order through checkout and settles it through the payments service"}',
  fields: [
    { name: 'status', type: 'status' as const, required: true },
    { name: 'covered', type: 'places' as const, required: true },
    { name: 'remaining', type: 'places' as const, required: true },
    { name: 'summary', type: 'text' as const },
  ],
};

/**
 * Stage 8's declaration: the one unit of the whole product, its fixed part, the
 * sections its packet reads, and what it may write.
 */
export function overviewDeclaration(): AgentStageDeclaration {
  return {
    id: OVERVIEW_STAGE_ID,
    version: OVERVIEW_STAGE_VERSION,
    factStage: '8-overview',
    // 0026's stage 8: what the product means, assumed (self-filling's outcome 4), never a fact of the code.
    level: 'meaning',
    scale: { level: 'product', child: 'repository' },
    role: 'You are one unit of madarch\'s fill that writes the product\'s overview hypothesis: one product, read from the graph its own stages built, and written as claims about what this product is.',
    rules: [
      'Write the overview, not a summary of every file: what this product is for, which parts carry it, how they relate, and what a reader should look at first — each claim cited to bytes the packet points you at.',
      'Every claim you write is a hypothesis about this product: its subject is a node the graph holds, its predicate is one lower-case kebab token, and its object is another node of the graph or the words you state. Say how sure you are with `confidence`.',
      'The repositories of the product are your places: a repository you did not read is not one you may describe, and a claim about a part you did not read is a claim about a place outside your reading.',
      'Nothing outside the graph supports an overview claim: a tool answer that was cut says so, and the packet\'s own `marker` names every list it cut — read the rest with the tools rather than telling the reader about parts you were not shown.',
    ],
    task: 'Write the product\'s overview hypothesis from its repository-level graph: what this product is for, its parts, and how they relate, every claim cited to the bytes it stands on.',
    answer: OVERVIEW_ANSWER,
    kinds: OVERVIEW_KINDS,
    consumes: {
      // The repository-level graph this stage reads is the deterministic stages' own: what a product is made of.
      required: [
        { capability: 'repository', scope: 'repository', freshness: 'current' },
        { capability: 'module', scope: 'repository', freshness: 'any' },
      ],
      // Read where the run published them, and read as absent where it did not: a product with no documents still has
      // an overview, and its coverage says what it read.
      optional: [
        { capability: 'entry-point', scope: 'repository', freshness: 'any' },
        { capability: 'package', scope: 'repository', freshness: 'any' },
        { capability: 'document', scope: 'file', freshness: 'any' },
        { capability: 'section', scope: 'file', freshness: 'any' },
        { capability: 'claim', scope: 'repository', freshness: 'any' },
      ],
    },
    sections: overviewSections(),
    plan: (graph) => productUnits(graph),
    places: async (context): Promise<AgentPlaceSet> => {
      // A unit of the whole product covers every repository the run pins; a child unit of 0026's next level covers the
      // one repository its own scope names. Either way its places are those repositories, and the graph's own
      // repository fact is a child's id (0026: an id is a node's, never a run's).
      const reads = graphReadsOver(context.graph);
      const facts = new Map((await repositoriesOf(reads)).map((fact) => [repositoryNameOf(fact), fact.id]));
      const entries: readonly { readonly repository: string; readonly commit: string }[] = 'product' in context.packet.place
        ? context.packet.place.repositories
        : [{ repository: context.packet.place.repository, commit: context.packet.place.commit }];
      const places = [...entries]
        .sort((left, right) => byCodePoint(left.repository, right.repository))
        .map((entry) => {
          const id = facts.get(entry.repository);
          if (id === undefined) {
            raise(`stage ${OVERVIEW_STAGE_ID}'s unit "${context.unit.id}" covers the repository ${JSON.stringify(entry.repository)}, and the graph holds no repository fact of that name: a place is a node the snapshot stage published (src/fill/facts.ts)`);
          }
          return {
            id,
            place: entry.repository,
            scope: entry.repository,
            repository: entry.repository,
            commit: entry.commit,
            // One repository of a product is about as much as one bounded span of reading, 0026's own estimate.
            estimatedTokens: estimateOfMembers(1),
          };
        });
      // The repositories are read as facts of the graph, which the store answers whole: the list is no sample, so
      // nothing of this scope was left unenumerated.
      return { places, cut: false };
    },
  };
}

/**
 * Stage 8, registered over the run's wiring: one unit per product, whose plan reads the
 * product's pinned repositories from the graph.
 */
export function createOverviewStage(wiring: AgentStageWiring): FillStage {
  return createAgentStage(overviewDeclaration(), wiring);
}
