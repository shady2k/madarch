/**
 * The pages stage of the fill (decision 0026, "Pages"; madarch-tzte.25.1), on the
 * agent-stage shape of `src/fill/stages/agent-stage.ts`: bounded agent units write a
 * page's narrative text in order of importance, each sentence tied to fact or claim
 * ids, stored as Markdown in the product's git with status proposed.
 *
 * **One unit per page.** The plan walks the page-worthy nodes of every repository the
 * run pins, most important first (stage 5's PageRank, ties in code point order), cut
 * from one whole product-wide list, and names one unit per node whose page no
 * published `narrative` fact stands behind at its unit's current generation. The
 * budget (`NARRATIVE_PAGES_PER_RUN`) holds the run to the most important pages; the
 * rest are a later run's, once the earlier pages stand published and their units are
 * reused.
 *
 * **What a unit reads.** The shape's own packet of its node — the node, its ranked
 * members, its edges, what reaches it, its repository's history — and one section of
 * its own: the claims and rules the graph already holds about the node, each with its
 * id, so a sentence can name what it stands on. No file content is pasted.
 *
 * **What a unit writes.** Through the checked write path, one fact of the kind
 * `narrative` (`src/fill/facts.ts`): the page's sentences, each tied to the ids of
 * the facts it stands on, `about` the node, and the product repository the page's
 * file stands in. The write is checked at once like every write — the ids a sentence
 * names must stand in the graph, the bytes the write cites must be read at the pinned
 * commit — and lands in the unit's draft set. The page's Markdown in the product's
 * git is rendered from the published fact by `renderNarrativePage`
 * (`src/fill/narrative-text.ts`), and committed by the outbox step the run's host
 * drives after a run (`commitNarrativePages`, `src/fill/narrative-outbox.ts`) —
 * decision 0027: "Git commits of pages are a separate idempotent outbox step."
 *
 * **What a unit never does.** It writes no accepted fact, no question and no edge:
 * 25.2's worker adds open questions and the next step to these same pages, and a
 * person's answer and acceptance are that stage's. The level of the stage's
 * statements is `meaning` (self-filling's outcome 4: "meaning (only assumed)"), and
 * every page shows its text marked unverified.
 */
import { byCodePoint } from '../../model/order.js';
import { scopeText } from '../checked-writes.js';
import { estimateOfMembers, type AgentPacketSection, type AgentSectionRequest } from '../agent-packet.js';
import { FACT_ID_PATTERN, type Fact, type FactKind } from '../facts.js';
import { factsOfRows, graphReadsOver, type GraphReadContext } from '../graph-reads.js';
import type { FillStage, StageGraphReader, StagePlan, StageUnitScope } from '../stage.js';
import { raise } from '../fsm-core.js';
import {
  MAX_PLAN_UNITS,
  repositoriesOf,
  repositoryNameOf,
  type AgentPlace,
  type AgentPlaceSet,
  type AgentStageDeclaration,
  type AgentStageWiring,
  type AgentUnitContext,
} from './agent-stage.js';
import { createAgentStage } from './agent-stage.js';

/** The stage's id, as it is registered. */
export const NARRATIVE_STAGE_ID = 'narrative';

/** The stage's own version, bumped when what it plans, runs or writes changes. */
export const NARRATIVE_STAGE_VERSION = 1;

/**
 * The fact kinds a unit of this stage may write: the page's narrative fact itself.
 * The coverage every unit leaves behind is the shape's own
 * (`src/fill/stages/agent-stage.ts`).
 */
export const NARRATIVE_KINDS: readonly string[] = ['narrative'];

/** The most rows the packet's statements section holds; the cut is named in the packet like every other section's. */
export const NARRATIVE_STATEMENT_ROWS = 40;

/**
 * How many pages one run narrates (0026's run budgets: "Run budgets (calls, time, tokens) are what
 * the owner authorizes; within them, important scopes go first and the rest is shown as not
 * covered"): the plan names the most important pages the product holds no current page of, up to
 * this budget, and the rest are a later run's — a run that narrated its budget's pages plans the
 * next ones, and a page whose own facts moved stands before any new one. The budget is the stage's
 * own because a page's unit is one agent session: without it, a run of a large product spends the
 * owner's tokens on every page at once.
 */
export const NARRATIVE_PAGES_PER_RUN = 24;

/**
 * The page-worthy kinds a unit's plan enumerates: the kinds a page exists for
 * (`PAGE_KINDS`, `src/fill/page-changes.ts`) whose value names the repository it
 * stands in, which is the one field the read grammar filters a kind by. The three
 * page kinds whose value names no repository — `api-endpoint` (its value names a
 * contract), `environment-variable` (a name) and `rule` (a statement) — are not
 * enumerated yet, and no page of theirs is narrated by this stage; they join when
 * their values name their repository or the grammar gains a read that reaches them.
 */
export const NARRATED_KINDS: readonly FactKind[] = [
  'entity-proposal',
  'entry-point',
  'module',
  'package',
  'question',
  'repository',
  'state',
  'symbol',
  'table',
  'column',
  'deploy-unit',
  'test',
].sort(byCodePoint) as readonly FactKind[];

/** The importance stage 5's PageRank gave one fact, for the order a page is written in: `0` where it gave none. */
function importanceOf(fact: Fact): number {
  const importance = (fact.value as { importance?: unknown }).importance;
  return typeof importance === 'number' && Number.isFinite(importance) ? importance : 0;
}

/** The file inside the repository one page's node stands at, where its value or its provenance names one. */
function fileOf(fact: Fact): string | undefined {
  const value = (fact.value ?? {}) as unknown as Record<string, unknown>;
  for (const field of ['file', 'path', 'manifest']) {
    const named = value[field];
    if (typeof named === 'string' && named !== '') return named;
  }
  const file = fact.provenance.place?.file;
  return file === undefined ? undefined : String(file);
}

/** The scope text one page's unit covers: the file its node stands at, or its repository whole. */
function scopeOfNode(repository: string, fact: Fact): string {
  const file = fileOf(fact);
  return file === undefined ? repository : `${repository}:${file}`;
}

/** One page of one repository: the node, and the unit scope and place its page's unit carries. */
interface PageNode {
  readonly fact: Fact;
  readonly unit: StageUnitScope;
}

/** The page-worthy nodes of one repository the graph holds, most important first, ties in code point order. */
async function pageNodes(reads: GraphReadContext, repository: string, narrated: ReadonlySet<string>): Promise<readonly PageNode[]> {
  const pages = new Map<string, PageNode>();
  for (const kind of NARRATED_KINDS) {
    const read = { read: 'facts-with' as const, kind, field: 'repository', value: repository };
    for (const fact of factsOfRows(await reads.read(read), read)) {
      if (narrated.has(fact.id)) continue;
      const scope = scopeOfNode(repository, fact);
      pages.set(fact.id, { fact, unit: { id: fact.id, scope, estimatedTokens: estimateOfMembers(1) } });
    }
  }
  return [...pages.values()].sort((left, right) =>
    importanceOf(right.fact) - importanceOf(left.fact)
    || byCodePoint(left.fact.kind, right.fact.kind)
    || byCodePoint(left.fact.id, right.fact.id));
}

/**
 * The pages a published narrative fact stands behind, whose holding is the holding
 * unit's own current generation: the pages that stand narrated now, which the plan
 * plans no unit for. A page whose unit was replaced — its facts moved — stands
 * behind no *current* page, and is planned again; a page another generation still
 * holds is 0027's own stale record, and is replanned the same way.
 *
 * The read is the store's own SQL through the plan's reader, as the history stage's
 * own queries are: the holdings and the units' generations are the orchestrator's
 * records, which no read of the grammar answers. The plan reads no product name, so
 * the answer spans the store's products — two fills of one code hold pages of one
 * id, and one current page stands for both.
 */
async function currentPageNodes(graph: StageGraphReader): Promise<ReadonlySet<string>> {
  const rows = await graph.query(`SELECT DISTINCT f.value->>'about' AS about
    FROM fill_fact f
    JOIN fill_fact_holding h ON h.id = f.id
    JOIN fill_unit u ON u.unit_id = h.unit_id AND u.generation = h.generation
   WHERE f.kind = 'narrative'`);
  const current = new Set<string>();
  for (const row of rows) {
    const about = (row as { about?: unknown }).about;
    if (typeof about === 'string') current.add(about);
  }
  return current;
}

/**
 * The plan: the most important `NARRATIVE_PAGES_PER_RUN` pages the product holds no
 * current page of, one unit each, cut from one whole product-wide list sorted by
 * importance (0026: "important scopes go first"), never repository by repository; the
 * rest of the product's pages are a later run's, and a run that narrated its budget
 * plans the next. The shape's own bound (`MAX_PLAN_UNITS`) caps the budget itself.
 */
export async function narrativeUnits(graph: StageGraphReader): Promise<StagePlan> {
  const reads = graphReadsOver(graph);
  const current = await currentPageNodes(graph);
  const repositories = await repositoriesOf(reads);
  if (repositories.length === 0) return { units: [], coverage: 'nothing-found' };
  // Every page of every repository the run pins, collected whole before anything is cut: the budget
  // then cuts the one list by importance, never repository by repository, so an unimportant page of an
  // alphabetically early repository cannot spend what the most important page of a later one needs.
  const all: { readonly unit: StageUnitScope; readonly importance: number }[] = [];
  for (const repository of repositories) {
    const name = repositoryNameOf(repository);
    for (const page of await pageNodes(reads, name, current)) {
      all.push({ unit: page.unit, importance: importanceOf(page.fact) });
    }
  }
  if (all.length === 0) return { units: [], coverage: 'nothing-found' };
  const budget = Math.min(NARRATIVE_PAGES_PER_RUN, MAX_PLAN_UNITS);
  const units = all
    .sort((left, right) => right.importance - left.importance
      || byCodePoint(left.unit.id, right.unit.id))
    .slice(0, budget)
    .map((entry) => entry.unit);
  return { units, coverage: 'planned' };
}

/**
 * The sections this stage adds to the shape's packet: the claims and rules the
 * graph holds about the unit's node, each with its id, so a sentence can name the
 * facts it stands on. Every row is a read of the graph through the unit's own
 * reader, recorded as its dependency like every other.
 */
export function narrativeSections(): readonly AgentPacketSection[] {
  const rowsOfKind = async (request: AgentSectionRequest, kind: 'claim' | 'rule', field: string, fields: readonly string[]): Promise<readonly Record<string, unknown>[]> => {
    const read = { read: 'facts-with' as const, kind, field, value: request.unit.id };
    return [...factsOfRows(await request.reads.read(read), read)]
      .sort((left, right) => byCodePoint(left.id, right.id))
      .map((fact) => {
        const value = (fact.value ?? {}) as unknown as Record<string, unknown>;
        const row: Record<string, unknown> = { id: fact.id, kind: fact.kind };
        for (const name of fields) if (value[name] !== undefined) row[name] = value[name];
        return row;
      });
  };
  return [
    {
      name: 'statements',
      what: "the claims and rules the graph holds about this node, each with its id, so a sentence can name what it stands on",
      max: NARRATIVE_STATEMENT_ROWS,
      rows: async (request) => [
        ...await rowsOfKind(request, 'claim', 'subject.id', ['predicate', 'text', 'confidence']),
        ...await rowsOfKind(request, 'rule', 'subject', ['statement', 'form']),
      ],
    },
  ];
}

/**
 * The answer a narrative unit gives: whether it wrote its page, and the one
 * sentence a watching person reads. The page itself is the unit's write, checked
 * one at a time by its own server (0026, "Writing"), never a text in the answer.
 */
const NARRATIVE_ANSWER = {
  shape: '{"status":"done"|"partial","covered":["<the fact id of the page you wrote>"],"remaining":["<the fact id of the page you did not write>"],"summary":"<one sentence on the page you wrote>"}',
  reading: [
    '`covered` names the page you wrote — the fact id of the node it is about; `remaining` names the page you could not write. A `done` answer whose `remaining` is not empty is read as `partial`.',
  ],
  example: '{"status":"done","covered":["module:9f2c…"],"remaining":[],"summary":"The checkout validates the cart before payment"}',
  fields: [
    { name: 'status', type: 'status' as const, required: true },
    { name: 'covered', type: 'places' as const, required: true },
    { name: 'remaining', type: 'places' as const, required: true },
    { name: 'summary', type: 'text' as const },
  ],
};

/**
 * The stage's declaration: one unit per page, its fixed part, the statements its
 * packet reads, and what it may write.
 */
export function narrativeDeclaration(): AgentStageDeclaration {
  return {
    id: NARRATIVE_STAGE_ID,
    version: NARRATIVE_STAGE_VERSION,
    factStage: '14-narrative',
    // 0026's Pages: what a reader reads of a node, assumed (self-filling's outcome 4), shown unverified.
    level: 'meaning',
    scale: { level: 'place', child: 'place' },
    role: 'You are one unit of madarch\'s fill that writes one page\'s narrative text: one node of the graph, read from the graph its own stages built, written as sentences a reader reads above the facts the graph holds.',
    rules: [
      'Write your page through `assert_fact` with kind "narrative": its `about` is the fact id of your scope\'s node, and its `sentences` carry the page, one entry a sentence, in the order a reader reads them. The page stands in the product\'s git as Markdown, proposed; writing it there is madarch\'s own step, never yours.',
      'Every sentence names the facts it stands on: its `facts` list holds the fact or claim ids the sentence is about — what the packet\'s sections and your own reads answered — in code point order, each once, at least one. A sentence that names none is refused, and a page of one sentence is a page.',
      'Write what the node is and does for a reader who sees the graph below your text: not a list of every fact, and never a fact a reader could take as confirmed — your page shows marked unverified, and every sentence stands on the ids it names.',
      'Cite the bytes you read: the write\'s place is the file your node stands at, at the commit the packet names.',
      'Nothing outside the graph supports a sentence: a tool answer that was cut says so, and the packet\'s own marker names every list it cut — read the rest with the tools rather than writing about parts you were not shown.',
    ],
    task: 'Write one page\'s narrative text from the graph: what this node is and does, every sentence tied to the fact or claim ids it stands on.',
    answer: NARRATIVE_ANSWER,
    kinds: NARRATIVE_KINDS,
    consumes: {
      // The graph this stage narrates is the other stages' own: a page is written after the graph is filled.
      required: [
        { capability: 'repository', scope: 'repository', freshness: 'current' },
      ],
      // The statements a page cites are read where the run published them, and read as absent where it did
      // not: a node with no claims yet still has a page, and its sentences cite the facts it does stand
      // on. A consume is declared only for a kind the packet really reads from an earlier stage as such
      // (the sections below), so the stage graph stays a DAG however many stages produce one kind.
      optional: [
        { capability: 'claim', scope: 'repository', freshness: 'any' },
        { capability: 'rule', scope: 'repository', freshness: 'any' },
      ],
    },
    sections: narrativeSections(),
    plan: (graph) => narrativeUnits(graph),
    places: (context): AgentPlaceSet => {
      // A page's unit covers its own node and nothing else: one place, named by the node's fact id, which is also
      // what its answer's `covered` names. Its scope is the unit's own, so a page's unit is no child of itself and
      // a unit that cannot finish publishes its draft as it stands, its coverage naming the page it did not write.
      const place: AgentPlace = {
        id: context.unit.id,
        place: context.unit.id,
        scope: scopeText(context.scope),
        repository: context.scope.repository,
        commit: 'commit' in context.packet.place ? String(context.packet.place.commit) : '',
        estimatedTokens: estimateOfMembers(1),
      };
      if (!FACT_ID_PATTERN.test(context.unit.id)) {
        raise(`the narrative unit "${context.unit.id}" is no fact id: a page's unit is named by the node its page is about (0026: an id is a node's, never a run's)`);
      }
      return { places: [place], cut: false };
    },
  };
}

/**
 * The pages stage, registered over the run's wiring: one unit per page, in order of
 * importance, its plan reading the graph the other stages filled.
 */
export function createNarrativeStage(wiring: AgentStageWiring): FillStage {
  return createAgentStage(narrativeDeclaration(), wiring);
}
