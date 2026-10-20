/**
 * Stage 10 of the fill, the intent the documents state (decision 0026, "10 intent
 * from documents"; madarch-tzte.24.3), on the agent-stage shape of
 * `src/fill/stages/agent-stage.ts`.
 *
 * **One unit per document cluster.** The document index (stage 6,
 * madarch-tzte.21.4) is what this stage reads, so a unit covers the documents of
 * one repository — the cluster of documents a reader of that repository's pages
 * would read together, because intent claims may tie one document's section to
 * the code node another names. The plan names one unit per repository that holds
 * documents (estimated at one bounded reading per document, 0026's own measure);
 * a repository whose estimate is past 0026's planned size is planned at the level
 * below, one unit per document — stage 6's own granularity ("a unit is one
 * document") — with a repository past the plan's unit bound standing as one unit,
 * as every scope the bound cannot enumerate does. A unit that cannot finish
 * splits into its places, which are the documents of its scope; a child covers
 * one document, whose scope is its own, and so splits no further.
 *
 * **What it reads.** The document index and nothing else as its own sections —
 * the scope's documents, their sections, and every end their `document-link`
 * edges name in the graph (a code file, another document, a section) with the
 * link's own place — beside the shape's own packet of the scope. That is 0026's
 * "Agent input" for this stage: the packet names the documents, the sections a
 * reader meets and the code nodes the documents name, and the unit reads further
 * through its tools (`evidence_span` for the code a link names). The ends that
 * name nothing of the graph — an address outside the repositories, a path the
 * pinned commit does not hold — are in the rows too, each as the term the document
 * wrote, so a link that promises a page nobody holds is something the unit sees
 * and asks about, never something silently dropped.
 *
 * **What it writes.** Intent claims — 0004's atom at 0005's `inferred` layer,
 * always `proposed` — whose subject is the section (or document) whose words
 * state the intent and whose object is the code node the document names or the
 * words themselves; and questions, where a document's stated intent contradicts
 * what the code says (type `contradiction`, self-filling's outcome 5) or where a
 * document names what no node of the graph holds. The level of its statements is
 * `intent` (self-filling's outcome 4: "evidence of intent — documents, code
 * comments, commits, pull requests, linked pages"): what people recorded, never
 * what the agent assumes, which is stage 8's and 12's word.
 */
import { byCodePoint } from '../../model/order.js';
import { estimateOfMembers, plannedTokens, type AgentPacketSection, type AgentSectionRequest } from '../agent-packet.js';
import {
  factsOfRows,
  graphReadsOver,
  type GraphReadContext,
} from '../graph-reads.js';
import type { Fact, FactTerm } from '../facts.js';
import type { FillStage } from '../stage.js';
import { writeScope, type WriteScope } from '../checked-writes.js';
import {
  createAgentStage,
  repositoriesOf,
  repositoryNameOf,
  MAX_PLAN_UNITS,
  type AgentPlaceSet,
  type AgentStageDeclaration,
  type AgentStageWiring,
  type AgentUnitContext,
} from './agent-stage.js';
import { DEFAULT_STAGE_LIMITS, type StageGraphReader, type StagePlan } from '../stage.js';
/** The stage's id, as it is registered. */
export const DOC_INTENT_STAGE_ID = 'doc-intent';

/** The stage's own version, bumped when what it plans, runs or writes changes. */
export const DOC_INTENT_STAGE_VERSION = 1;

/**
 * The fact kinds a unit of this stage may write: the intent a document states is a
 * claim, a contradiction between it and the code (or a document naming nothing
 * of the graph) is a question, and the answer that closes a question the moment the
 * unit finds the evidence for it (the self-filling charter's outcome 5). The coverage
 * every unit leaves behind is the shape's own (`src/fill/stages/agent-stage.ts`).
 */
export const DOC_INTENT_KINDS: readonly string[] = ['answer', 'claim', 'question'];

/** The most documents one packet's `documents` section holds, its cut named like every section's. */
export const DOC_INTENT_DOCUMENT_ROWS = 40;

/** The most rows the `sections` section holds: a document's heading tree, bounded and its cut named. */
export const DOC_INTENT_SECTION_ROWS = 80;

/** The most rows the `links` section holds: the ends the scope's documents name, bounded and its cut named. */
export const DOC_INTENT_LINK_ROWS = 80;

/** The question type self-filling's outcome 5 gives a document that contradicts the code. */
export const CONTRADICTION_QUESTION_TYPE = 'contradiction';

/** The documents of one scope: every document of the repository, cut to the scope's path where it names one. */
async function documentsOf(reads: GraphReadContext, scope: WriteScope): Promise<readonly Fact[]> {
  const read = { read: 'facts-with' as const, kind: 'document' as const, field: 'repository', value: scope.repository };
  const rows = factsOfRows(await reads.read(read), read);
  return rows.filter((fact) => {
    const path = String((fact.value as { path?: unknown }).path ?? '');
    return scope.path === undefined || path === scope.path || path.startsWith(`${scope.path}/`);
  }).sort((left, right) => byCodePoint(String((left.value as { path?: unknown }).path ?? ''), String((right.value as { path?: unknown }).path ?? '')) || byCodePoint(left.id, right.id));
}

/** The path a document fact stands at, as its own value carries it. */
function documentPathOf(fact: Fact): string {
  return String((fact.value as { path?: unknown }).path ?? '');
}

/** The sections of the scope's documents, in the order a reader meets them: document, then place, then anchor. */
async function sectionsOf(reads: GraphReadContext, scope: WriteScope, documents: readonly Fact[]): Promise<readonly Fact[]> {
  if (documents.length === 0) return [];
  const read = { read: 'facts-with' as const, kind: 'section' as const, field: 'repository', value: scope.repository };
  const held = new Set(documents.map((fact) => documentPathOf(fact)));
  return factsOfRows(await reads.read(read), read)
    .filter((fact) => held.has(String((fact.value as { document?: unknown }).document ?? '')))
    .sort((left, right) => byCodePoint(String((left.value as { document?: unknown }).document ?? ''), String((right.value as { document?: unknown }).document ?? ''))
      || (left.provenance.place?.range.startLine ?? 0) - (right.provenance.place?.range.startLine ?? 0)
      || byCodePoint(String((left.value as { anchor?: unknown }).anchor ?? ''), String((right.value as { anchor?: unknown }).anchor ?? ''))
      || byCodePoint(left.id, right.id));
}

/** One link a document holds, as the packet's `links` section names it. */
interface LinkRow {
  /** The section (or document) the link stands in, by fact id. */
  readonly from: string;
  /** The path of the document the link stands in. */
  readonly document: string;
  /** The line the link stands at, as a reader counts lines. */
  readonly line: number;
  /** The end, exactly as the document wrote it. */
  readonly to: FactTerm;
  /** What the end names in the graph, when it names a node: its kind and its path. */
  readonly end?: { readonly kind: string; readonly path?: string };
}

/** The path a node the graph holds stands at, where its own value names one (a file's, a document's, a section's). */
function nodePathOf(fact: Fact): string | undefined {
  const value = (fact.value ?? {}) as { path?: unknown; document?: unknown };
  if (typeof value.path === 'string' && value.path !== '') return value.path;
  if (typeof value.document === 'string' && value.document !== '') return value.document;
  return undefined;
}

/** The text of one end, as the row spells it, in the order rows are compared by. */
function termTextOf(term: FactTerm): string {
  if (term.form === 'node') return term.id;
  if (term.form === 'external') return term.url;
  return term.text;
}

/**
 * The `document-link` edges of the scope's documents: one read per node a link
 * can stand in (the documents and their sections — the grammar filters by one
 * value field exactly), then one read naming every node the ends stand for. Each
 * read is recorded as the unit's dependency, like every read a packet section
 * makes.
 */
async function linksOfScope(reads: GraphReadContext, scope: WriteScope, documents: readonly Fact[], sections: readonly Fact[]): Promise<readonly LinkRow[]> {
  const paths = new Map<string, string>([
    ...documents.map((fact) => [fact.id, documentPathOf(fact)] as const),
    ...sections.map((fact) => [fact.id, String((fact.value as { document?: unknown }).document ?? '')] as const),
  ]);
  const froms = [...documents, ...sections];
  const edges: Fact[] = [];
  for (const from of froms) {
    const read = { read: 'facts-with' as const, kind: 'document-link' as const, field: 'from', value: from.id };
    for (const fact of factsOfRows(await reads.read(read), read)) edges.push(fact);
  }
  const ends = new Map<string, Fact>();
  const nodeEnds = new Set<string>();
  for (const fact of edges) {
    const term = (fact.value as { to?: FactTerm }).to;
    if (term !== undefined && term !== null && typeof term === 'object' && term.form === 'node') nodeEnds.add(term.id);
  }
  const nodeIds = [...nodeEnds].sort(byCodePoint);
  if (nodeIds.length > 0) {
    const read = { read: 'facts' as const, ids: nodeIds };
    for (const fact of factsOfRows(await reads.read(read), read)) ends.set(fact.id, fact);
  }
  const orderOf = new Map<string, number>(sections.map((fact, index) => [fact.id, index]));
  return edges
    .map((fact) => {
      const from = String((fact.value as { from?: unknown }).from ?? '');
      const to = (fact.value as { to?: FactTerm }).to as FactTerm;
      const end = ends.get(to.form === 'node' ? to.id : '');
      return {
        from,
        document: paths.get(from) ?? '',
        line: fact.provenance.place?.range.startLine ?? 0,
        to,
        ...(end === undefined
          ? {}
          : { end: { kind: end.kind, ...(nodePathOf(end) === undefined ? {} : { path: nodePathOf(end) }) } }),
      };
    })
    .sort((left, right) => byCodePoint(left.document, right.document)
      || left.line - right.line
      || (orderOf.get(left.from) ?? 0) - (orderOf.get(right.from) ?? 0)
      || byCodePoint(left.from, right.from)
      || byCodePoint(termTextOf(left.to), termTextOf(right.to)));
}

/**
 * The sections this stage adds to the shape's packet: the document index of the
 * unit's scope — its documents, their sections, and the ends their links name.
 * Every one is a read of the graph through the unit's own reader, so each is a
 * recorded dependency; each is bounded with its cut named in the packet's own
 * marker. Every unit of this stage has a scope node (the plan names no product
 * unit), so no section carries a `when`.
 */
export function docIntentSections(): readonly AgentPacketSection[] {
  return [
    {
      name: 'documents',
      what: 'the documents of the scope',
      max: DOC_INTENT_DOCUMENT_ROWS,
      rows: async (request: AgentSectionRequest) => (await documentsOf(request.reads, request.scope))
        .map((fact) => ({
          id: fact.id,
          path: documentPathOf(fact),
          ...((fact.value as { title?: unknown }).title === undefined ? {} : { title: (fact.value as { title?: unknown }).title }),
          mediaType: String((fact.value as { mediaType?: unknown }).mediaType ?? ''),
        })),
    },
    {
      name: 'sections',
      what: 'the sections of the scope\'s documents',
      max: DOC_INTENT_SECTION_ROWS,
      rows: async (request: AgentSectionRequest) => {
        const documents = await documentsOf(request.reads, request.scope);
        return (await sectionsOf(request.reads, request.scope, documents))
          .map((fact) => ({
            id: fact.id,
            document: String((fact.value as { document?: unknown }).document ?? ''),
            anchor: String((fact.value as { anchor?: unknown }).anchor ?? ''),
            heading: String((fact.value as { heading?: unknown }).heading ?? ''),
            level: (fact.value as { level?: unknown }).level,
            line: fact.provenance.place?.range.startLine,
          }));
      },
    },
    {
      name: 'links',
      what: 'the ends the scope\'s documents name, with the link\'s own place',
      max: DOC_INTENT_LINK_ROWS,
      rows: async (request: AgentSectionRequest) => {
        const documents = await documentsOf(request.reads, request.scope);
        const sections = await sectionsOf(request.reads, request.scope, documents);
        return await linksOfScope(request.reads, request.scope, documents, sections);
      },
    },
  ];
}

/**
 * The answer stage 10's units give: how far the unit read its documents, the
 * document paths it covered and those it did not, and one sentence on the intent
 * it wrote. The claims and questions themselves are the unit's writes, checked
 * one at a time by the unit's own server (0026, "Writing"), never a list in the
 * answer.
 */
const DOC_INTENT_ANSWER = {
  shape: '{"status":"done"|"partial","covered":["<a document path of your scope>"],"remaining":["<a document path of your scope>"],"summary":"<one sentence on the intent you wrote>"}',
  reading: [
    '`covered` names every document of your scope you read to the end — its sections and the code the links name; `remaining` names the documents you did not read. A `done` answer whose `remaining` is not empty is read as `partial`, and the documents you leave out are planned as units of their own.',
  ],
  example: '{"status":"done","covered":["README.md","docs/orders.md"],"remaining":[],"summary":"The documents promise a flat 5% tax, and the code applies 8% — raised as a contradiction"}',
  fields: [
    { name: 'status', type: 'status' as const, required: true },
    { name: 'covered', type: 'places' as const, required: true },
    { name: 'remaining', type: 'places' as const, required: true },
    { name: 'summary', type: 'text' as const },
  ],
};

/**
 * Stage 10's declaration: the document cluster a unit reads, its fixed part, the
 * document-index sections its packet reads, and what it may write.
 */
export function docIntentDeclaration(): AgentStageDeclaration {
  return {
    id: DOC_INTENT_STAGE_ID,
    version: DOC_INTENT_STAGE_VERSION,
    // 0026's stage 10: the intent the documents state, at the level of what people recorded (self-filling's outcome 4).
    factStage: '10-intent-documents',
    level: 'intent',
    scale: { level: 'repository', child: 'place' },
    role: 'You are one unit of madarch\'s fill that writes what a repository\'s documents say the system is meant to do: the intent its own documents state, read from the graph\'s document index and cited to the sections and the code nodes they name.',
    rules: [
      'Read the document index first: the packet\'s `documents`, `sections` and `links` name every document of your scope, the sections a reader meets, and the nodes of the graph their links name. Read further with the tools; a document you were not shown is a place you did not read.',
      'A claim states what a document says the system is meant to do: its subject is the section (or the document) whose words state it, its predicate is one lower-case kebab token (`states`, `promises`, `requires`), and its object is the code node the document names or the words you state. Cite the claim to the section\'s own bytes, and say how sure you are with `confidence`.',
      'Tie the intent to the code it names: when a section links to a node of the graph, read that node (code through `evidence_span`) before you claim what the document says about it.',
      `When what a document states contradicts what the code says, raise a question of type ${CONTRADICTION_QUESTION_TYPE}: its prompt names both sides — the section that states the intent and the code that says otherwise — it is about the node the contradiction concerns, and it cites the section\'s bytes.`,
      'A link whose end names no node of the graph — an address outside the repositories, or a path the pinned commit does not hold — is not evidence: raise a question about what it promises instead of citing it.',
      'Nothing outside the document index and the tools supports an intent claim: a tool answer that was cut says so, and the packet\'s own `marker` names every list it cut — read the rest with the tools rather than telling the reader about documents you were not shown.',
    ],
    task: 'Write the intent the documents of your scope state: every claim tied to the section that states it and to the code node it names, and every contradiction between a document and the code a question of type `contradiction`.',
    answer: DOC_INTENT_ANSWER,
    kinds: DOC_INTENT_KINDS,
    consumes: {
      required: [
        // The scope the unit stands at: the repository the snapshot stage published.
        { capability: 'repository', scope: 'repository', freshness: 'current' },
        // The document index this stage reads (stage 6, madarch-tzte.21.4). Without a producer of it the stage has
        // nothing to read, which is a starvation the plan names, never a silent run over an empty packet.
        { capability: 'document', scope: 'file', freshness: 'any' },
        { capability: 'section', scope: 'file', freshness: 'any' },
        { capability: 'document-link', scope: 'file', freshness: 'any' },
      ],
      // Read where the run published them, and read as absent where it did not: the claims stage 8 owns at the
      // product's level (the unit reads them through `claims_about`), and the modules stage 5 owns at the
      // repository's level, which the packet's own members name.
      optional: [
        { capability: 'claim', scope: 'product', freshness: 'any' },
        { capability: 'module', scope: 'repository', freshness: 'any' },
      ],
    },
    sections: docIntentSections(),
    plan: (graph) => planDocumentUnits(graph),
    places: async (context: AgentUnitContext): Promise<AgentPlaceSet> => {
      // A unit's places are the documents of its scope: what its coverage counts, what its answer names, and the unit
      // each of its children would be — one child per document, whose scope is the document's own path. A document
      // unit's one place is its own scope, so it splits no further.
      const scope = writeScope(context.unit.scope);
      const reads = graphReadsOver(context.graph);
      const documents = await documentsOf(reads, scope);
      const places = documents.map((fact) => {
        const path = documentPathOf(fact);
        return {
          id: fact.id,
          place: path,
          scope: `${scope.repository}:${path}`,
          repository: scope.repository,
          commit: 'product' in context.packet.place ? '' : context.packet.place.commit,
          // One document is about as much as one bounded span of reading, 0026's own estimate.
          estimatedTokens: estimateOfMembers(1),
        };
      });
      // The documents are read as facts of the graph, which the store answers whole: the list is no sample, so
      // nothing of this scope was left unenumerated.
      return { places, cut: false };
    },
  };
}

/**
 * The stage's plan: one unit per repository that holds documents — the repository's
 * document cluster — estimated at one bounded reading per document against 0026's
 * default window; a repository past the planned size is planned one unit per
 * document, stage 6's own granularity, and a repository past the plan's unit bound
 * stands as one unit rather than a shorter list, as every scope the bound cannot
 * enumerate does. A product the graph holds no documents of is nothing found
 * rather than a plan that failed: the document index read none, and its own
 * coverage says so (0027).
 */
export async function planDocumentUnits(graph: StageGraphReader): Promise<StagePlan> {
  const reads = graphReadsOver(graph);
  const repositories = await repositoriesOf(reads);
  const units: { id: string; scope: string; estimatedTokens: number }[] = [];
  // One budget for the whole plan, the shape's own: a scope that would take it past `MAX_PLAN_UNITS` stands as one
  // unit instead of being enumerated, so the bound costs a split at run time and never a scope no unit names.
  let left = MAX_PLAN_UNITS;
  for (const repository of repositories) {
    const name = repositoryNameOf(repository);
    const documents = await documentsOf(reads, writeScope(name));
    if (documents.length === 0) continue;
    const estimate = estimateOfMembers(documents.length);
    if (estimate <= plannedTokens(DEFAULT_STAGE_LIMITS)) {
      left -= 1;
      units.push({ id: repository.id, scope: name, estimatedTokens: estimate });
      continue;
    }
    // One level of the plan's recursion, the shape's own accounting (`planScope`): enumerate the documents within
    // what the budget still holds, and when the bound cut the enumeration short, undo it and stand the whole
    // repository as one unit — so the plan names at least one unit for every scope it read and drops none, and a
    // later repository still holds the budget the undone enumeration did not spend.
    const before = left;
    const parts: typeof units = [];
    for (const document of documents) {
      if (left < 1) break;
      left -= 1;
      const path = documentPathOf(document);
      parts.push({ id: document.id, scope: `${name}:${path}`, estimatedTokens: estimateOfMembers(1) });
    }
    if (parts.length < documents.length) {
      left = before;
      left -= 1;
      units.push({ id: repository.id, scope: name, estimatedTokens: estimate });
    } else {
      units.push(...parts);
    }
  }
  if (units.length === 0) return { units: [], coverage: 'nothing-found' };
  return { units, coverage: 'planned' };
}

/**
 * Stage 10, registered over the run's wiring: one unit per repository's document
 * cluster, whose packet is the document index of its scope.
 */
export function createDocIntentStage(wiring: AgentStageWiring): FillStage {
  return createAgentStage(docIntentDeclaration(), wiring);
}
