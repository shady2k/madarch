/**
 * Stage 13 of the fill, the system recovered and reconciled with the intended one
 * (decision 0026, "Stages": "13 system recovery and reconciliation (recovered
 * architecture beside the intended one with the mapping between them)";
 * madarch-tzte.24.6), on the agent-stage shape of `src/fill/stages/agent-stage.ts`.
 *
 * **One unit per product.** The recovery stands at 0026's top level, beside the
 * overview: it states what the product's system is once every lower reading has
 * landed. The plan is the shape's own `productUnits` — one unit whose scope is
 * every repository the run pins (`PRODUCT_SCOPE`) and whose places are those
 * repositories — and a unit that cannot finish splits into them, one child per
 * repository, as stage 8's does.
 *
 * **What it reads.** What the earlier agent stages established, and the model the
 * product declares:
 *
 * - `moduleSummaries` — one row per module of the product, holding the module's
 *   own `summarizes` claim (stage 12's contract predicate) cut to the summary
 *   bound, or `null` where the module published none: a missing summary is a
 *   module that did not finish, never an empty one.
 * - `intent` — the intent claims stages 10 and 11 declare: what the documents
 *   state (`states`, `promises`, `requires`) and what the comments and commits
 *   state (`intent`, `why`).
 * - `overview` — the rest of the claims whose subject is a node of the graph: the
 *   overview hypothesis among them, with the responsibilities and roles stage 12
 *   wrote. The three sections read the claim set once between them, each through
 *   its own reads, so no claim is held twice.
 * - `intendedModel` — the files of the product repository's `madarch/` folder
 *   (decision 0002), where the product declares the architecture it meant. A
 *   product that declares none holds no rows: the unit recovers without a model,
 *   and its coverage says what it read. The files' bytes are never pasted; the
 *   unit reads them with `evidence_span`, at the pinned commit.
 *
 * **How it is ordered.** The stage declares `after` the stages whose reading its
 * packet opens: `overview`, `intent-history` and `understanding`. It cannot name
 * `doc-intent`: that stage consumes the claims every agent stage writes, so an
 * edge from it to this stage and this stage's own edge into it (through the same
 * consume) would close a cycle the registry refuses for every product — the cycle
 * madarch-tzte.26.1 removed from stage 8. The intent claims stage 10 writes are
 * therefore read as they stand when the unit runs, and a publication that lands
 * after the unit's own makes its recorded read stale: 0027's staleness marks the
 * generation and plans its replacement, which is the run's own repair, never a
 * silent gap.
 *
 * **What it writes.** Claims — 0004's atom at 0005's `inferred` layer, always
 * `proposed` — stating the recovered architecture; `interaction` links for how two
 * recovered components relate (their ends are the deploy units or symbols the
 * graph holds); a `maps-to` claim for each recovered part an intended element
 * answers to, cited to the model bytes that declare it; and a question of type
 * `contradiction` for every mismatch — a recovered part no intended element names,
 * or an intended element nothing recovered answers to. The level of its statements
 * is `meaning` (self-filling's outcome 4): an agent's reading, never a fact a
 * reader may take as confirmed, and never the intended model's own words.
 */
import { byCodePoint } from '../../model/order.js';
import { isProductScope } from '../checked-writes.js';
import { estimateOfMembers, type AgentPacketSection, type AgentSectionRequest } from '../agent-packet.js';
import {
  factsOfRows,
  graphReadsOver,
  type GraphReadContext,
} from '../graph-reads.js';
import type { Fact, FactTerm } from '../facts.js';
import { raise } from '../fsm-core.js';
import type { FillStage, StageGraphReader, StagePlan } from '../stage.js';
import {
  createAgentStage,
  productUnits,
  repositoriesOf,
  repositoryNameOf,
  type AgentPlaceSet,
  type AgentStageDeclaration,
  type AgentStageWiring,
  type AgentUnitContext,
} from './agent-stage.js';
import { CONTRADICTION_QUESTION_TYPE } from './doc-intent.js';
import { UNDERSTANDING_SUMMARY_PREDICATE, boundSummary } from './understanding.js';

/** The stage's id, as it is registered. */
export const RECOVERY_STAGE_ID = 'recovery';

/** The stage's own version, bumped when what it plans, runs or writes changes. */
export const RECOVERY_STAGE_VERSION = 1;

/**
 * The fact kinds a unit of this stage may write: the recovered architecture and
 * its mapping to the intended model are claims, an interaction link states how
 * two recovered components relate, a mismatch is a question of its own type, and
 * the answer closes a question the moment the unit finds the evidence for it (the
 * self-filling charter's outcome 5). The coverage every unit leaves behind is
 * the shape's own (`src/fill/stages/agent-stage.ts`).
 */
export const RECOVERY_KINDS: readonly string[] = ['answer', 'claim', 'interaction', 'question'];

/** Where the stage's units stand in 0026's hierarchy: the product, a repository below it. */
export const RECOVERY_SCALE = { level: 'product', child: 'repository' } as const;

/**
 * The predicate a mapping claim carries: the one claim that names what a
 * recovered part answers to in the intended model. The mapping's subject is the
 * recovered component, its object a literal naming the intended element exactly
 * as the model spells it, and its evidence the model bytes that declare it.
 */
export const RECOVERY_MAPPING_PREDICATE = 'maps-to';

/**
 * The predicates the `intent` section reads: the intent the documents state
 * (stage 10's own words) and the intent and rationale the comments and commits
 * state (stage 11's own words), in code point order — one read each.
 */
export const RECOVERY_INTENT_PREDICATES: readonly string[] = ['intent', 'promises', 'requires', 'states', 'why'];

/** The most rows the module summaries hold; the cut is named in the packet's marker. */
export const RECOVERY_SUMMARY_ROWS = 40;

/** The most rows the intent claims hold; the cut is named in the packet's marker. */
export const RECOVERY_INTENT_ROWS = 60;

/** The most rows the overview hypothesis holds; the cut is named in the packet's marker. */
export const RECOVERY_OVERVIEW_ROWS = 60;

/** The most model files one packet names; the cut is named in the packet's marker. */
export const RECOVERY_MODEL_ROWS = 20;

/**
 * The folder of the product repository the product's own model stands in
 * (decision 0002: "The intended model is YAML in git", `src/model/load.ts` reads
 * it from `madarch/`), and the names it holds.
 */
export const RECOVERY_MODEL_FOLDER = 'madarch';

/** The read that names one kind of fact by one value field, as a section's own text. */
function factsWith(kind: string, field: string, value: string): string {
  return JSON.stringify({ read: 'facts-with', kind, field, value });
}

/** One claim's end as a packet row holds it: the node, the literal or the address it names. */
function termRow(term: FactTerm): Record<string, unknown> {
  if (term.form === 'node') return { node: term.id };
  if (term.form === 'external') return { at: term.url };
  return { literal: term.text };
}

/** The claim's value, as the schema declares it. */
function claimValueOf(fact: Fact, read: unknown): { readonly subject: FactTerm; readonly predicate: string; readonly object: FactTerm; readonly text?: string } {
  const value = (fact.value ?? {}) as unknown as Record<string, unknown>;
  const subject = value['subject'];
  const object = value['object'];
  const predicate = value['predicate'];
  if (typeof subject !== 'object' || subject === null || typeof object !== 'object' || object === null || typeof predicate !== 'string') {
    raise(`the read ${String(read)} answered the claim fact ${fact.id}, whose value is no claim: a claim names a subject, a predicate and an object (src/fill/facts.ts)`);
  }
  return {
    subject: subject as FactTerm,
    predicate,
    object: object as FactTerm,
    ...(typeof value['text'] === 'string' ? { text: value['text'] } : {}),
  };
}

/** Where a fact stands, as a packet row spells it: the repository, the file and the first line. */
function placeRow(fact: Fact): Record<string, unknown> {
  const place = fact.provenance.place;
  return {
    repository: fact.provenance.repository.id,
    ...(place === undefined ? {} : { file: place.file, line: place.range.startLine }),
  };
}

/** The facts of one kind one repository holds, read through the unit's own reader. */
async function factsOfRepository(reads: GraphReadContext, kind: string, repository: string): Promise<readonly Fact[]> {
  const read = { read: 'facts-with' as const, kind: kind as 'module', field: 'repository', value: repository };
  return factsOfRows(await reads.read(read), read);
}

/** The repositories the product pins that stand in one form, by their own names, in code point order. */
async function repositoriesOfForm(reads: GraphReadContext, form: 'code' | 'product'): Promise<readonly string[]> {
  const held = new Set<string>();
  for (const fact of await repositoriesOf(reads)) {
    if (((fact.value ?? {}) as { form?: unknown }).form !== form) continue;
    held.add(repositoryNameOf(fact));
  }
  return [...held].sort(byCodePoint);
}

/** One module fact as the summaries read it: its id, its repository and its own name. */
function moduleRowOf(fact: Fact): { readonly id: string; readonly repository: string; readonly name: string } {
  const value = (fact.value ?? {}) as { repository?: unknown; name?: unknown };
  if (typeof value.repository !== 'string' || typeof value.name !== 'string' || value.name === '') {
    raise(`the module fact ${fact.id} names the repository ${String(value.repository)} and the name ${String(value.name)}: a module is a fact of the schema, and the schema's module value names its repository and its name`);
  }
  return { id: fact.id, repository: value.repository, name: value.name };
}

/**
 * The sections this stage adds to the shape's packet. Each is a read of the
 * graph through the unit's own reader — recorded as the unit's dependency like
 * every other — bounded with its cut named in the packet's own marker. They
 * describe the product, so a unit of the repository level (a split's child)
 * reads the shape's own sections of its repository instead.
 */
export function recoverySections(): readonly AgentPacketSection[] {
  /** 0026's levels: the sections below describe the product. */
  const product = (request: AgentSectionRequest): boolean => isProductScope(request.scope);
  return [
    {
      name: 'moduleSummaries',
      what: 'the bounded summary each module of the product published (stage 12)',
      max: RECOVERY_SUMMARY_ROWS,
      when: product,
      rows: async (request) => {
        const reads = request.reads;
        // The modules of the product, one read per repository, and the summaries
        // once for all of them: the claim read answers every `summarizes` claim
        // the graph holds, and a row takes the one whose subject is the module.
        const summariesRead = { read: 'facts-with' as const, kind: 'claim' as const, field: 'predicate', value: UNDERSTANDING_SUMMARY_PREDICATE };
        const summaries = new Map<string, Fact>();
        for (const fact of factsOfRows(await reads.read(summariesRead), summariesRead)) summaries.set(fact.id, fact);
        const rows: Record<string, unknown>[] = [];
        for (const repository of [...await repositoriesOfForm(reads, 'code'), ...await repositoriesOfForm(reads, 'product')]) {
          for (const fact of await factsOfRepository(reads, 'module', repository)) {
            const module_ = moduleRowOf(fact);
            // Where a module published more than one summary, the first in code
            // point order of their ids is the one the row holds, as a parent
            // packet of stage 12 reads its children's.
            const owned = [...summaries.values()]
              .filter((claim) => ((claim.value ?? {}) as { subject?: { form?: unknown; id?: unknown } }).subject?.form === 'node'
                && (claim.value as { subject: { id: string } }).subject.id === module_.id)
              .sort((left, right) => byCodePoint(left.id, right.id));
            const held = owned[0];
            const text = held === undefined ? null : summaryTextOf(held);
            rows.push({ module: module_.id, repository: module_.repository, name: module_.name, summary: text === null ? null : boundSummary(text) });
          }
        }
        return rows.sort((left, right) => byCodePoint(String(left['module']), String(right['module'])));
      },
    },
    {
      name: 'intent',
      what: 'the intent the documents, comments and commits state (stages 10 and 11)',
      max: RECOVERY_INTENT_ROWS,
      when: product,
      rows: async (request) => {
        const reads = request.reads;
        const rows: Record<string, unknown>[] = [];
        // One read per predicate the earlier stages declare: the grammar filters
        // facts by one value field exactly, and each read is recorded as the
        // unit's dependency like every other.
        for (const predicate of RECOVERY_INTENT_PREDICATES) {
          const read = { read: 'facts-with' as const, kind: 'claim' as const, field: 'predicate', value: predicate };
          for (const fact of factsOfRows(await reads.read(read), read)) {
            const value = claimValueOf(fact, read);
            rows.push({
              id: fact.id,
              predicate: value.predicate,
              subject: termRow(value.subject),
              object: termRow(value.object),
              ...(value.text === undefined ? {} : { text: value.text }),
              ...placeRow(fact),
            });
          }
        }
        return rows.sort((left, right) => byCodePoint(String(left['predicate']), String(right['predicate'])) || byCodePoint(String(left['id']), String(right['id'])));
      },
    },
    {
      name: 'overview',
      what: "the claims the earlier stages wrote about the product's parts — the overview hypothesis among them",
      max: RECOVERY_OVERVIEW_ROWS,
      when: product,
      rows: async (request) => {
        const reads = request.reads;
        // The claims whose subject is a node of the graph, once: the read answers
        // them whole, and the rows hold the ones the other two sections do not,
        // so no claim stands twice in the packet.
        const read = { read: 'facts-with' as const, kind: 'claim' as const, field: 'subject.form', value: 'node' };
        const held = new Set([UNDERSTANDING_SUMMARY_PREDICATE, ...RECOVERY_INTENT_PREDICATES]);
        const rows: Record<string, unknown>[] = [];
        for (const fact of factsOfRows(await reads.read(read), read)) {
          const value = claimValueOf(fact, read);
          if (held.has(value.predicate)) continue;
          rows.push({
            id: fact.id,
            predicate: value.predicate,
            subject: termRow(value.subject),
            object: termRow(value.object),
            ...(value.text === undefined ? {} : { text: value.text }),
            ...placeRow(fact),
          });
        }
        return rows.sort((left, right) => byCodePoint(String(left['id']), String(right['id'])));
      },
    },
    {
      name: 'intendedModel',
      what: "the files of the product's own model, which the product repository declares",
      max: RECOVERY_MODEL_ROWS,
      when: product,
      rows: async (request) => {
        const reads = request.reads;
        const rows: Record<string, unknown>[] = [];
        for (const repository of await repositoriesOfForm(reads, 'product')) {
          for (const fact of await factsOfRepository(reads, 'file', repository)) {
            const value = (fact.value ?? {}) as { path?: unknown };
            if (typeof value.path !== 'string' || !isModelPath(value.path)) continue;
            rows.push({ id: fact.id, repository, path: value.path });
          }
        }
        return rows.sort((left, right) => byCodePoint(String(left['path']), String(right['path'])) || byCodePoint(String(left['id']), String(right['id'])));
      },
    },
  ];
}

/** Whether a file's path is one the product's own model stands at (`madarch/*.yaml`, decision 0002). */
function isModelPath(path: string): boolean {
  return path.startsWith(`${RECOVERY_MODEL_FOLDER}/`) && path.endsWith('.yaml');
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
 * The answer stage 13's units give: how far the unit read the product, the
 * repositories it covered and those it did not, and one sentence on the recovery
 * it wrote. The claims, interactions and questions themselves are the unit's
 * writes, checked one at a time by the unit's own server (0026, "Writing"),
 * never a list in the answer.
 */
const RECOVERY_ANSWER = {
  shape: '{"status":"done"|"partial","covered":["<a repository of the product>"],"remaining":["<a repository of the product>"],"summary":"<one sentence on the recovery you wrote>"}',
  reading: [
    '`covered` names every repository of the product you read to the end — through the graph its packet points at and the spans `evidence_span` gives you; `remaining` names the repositories you did not read. A `done` answer whose `remaining` is not empty is read as `partial`, and the repositories you leave out are planned as units of their own.',
  ],
  example: '{"status":"done","covered":["orders-api","payments-api"],"remaining":[],"summary":"The recovered system routes an order from checkout through payments, as the intended model maps it"}',
  fields: [
    { name: 'status', type: 'status' as const, required: true },
    { name: 'covered', type: 'places' as const, required: true },
    { name: 'remaining', type: 'places' as const, required: true },
    { name: 'summary', type: 'text' as const },
  ],
};

/**
 * Stage 13's declaration: the one unit of the whole product, its fixed part, the
 * sections its packet reads, and what it may write.
 */
export function recoveryDeclaration(): AgentStageDeclaration {
  return {
    id: RECOVERY_STAGE_ID,
    version: RECOVERY_STAGE_VERSION,
    factStage: '13-recovery',
    // 0026's stage 13: what the system is, recovered and reconciled with what the
    // product meant — assumed (self-filling's outcome 4), never a fact of the code
    // and never the model's own words.
    level: 'meaning',
    scale: RECOVERY_SCALE,
    role: `You are one unit of madarch's fill that recovers the product's system: what its parts are and how they relate, read from the graph every earlier stage built, written beside the model the product declares, with the mapping between the recovered parts and the intended ones.`,
    rules: [
      'Read the packet first: the `moduleSummaries` section holds each module\'s own bounded summary, the `intent` section what the documents, the comments and the commits state, and the `overview` section the overview hypothesis and the reading the earlier stages wrote. Build on what they established, and read further with the tools rather than reading a module\'s code again.',
      'Write the recovered architecture as claims: a claim\'s subject is a node the graph holds, its predicate is one lower-case kebab token, and its object is another node or the words you state. Cite every claim to bytes the packet points you at, and say how sure you are with `confidence`.',
      '`interaction` links state how two recovered components relate: their ends are the deploy units or symbols the graph holds, `form` is one of call, event, http, message or sql, and `via` names what carries the interaction.',
      'The `intendedModel` section names the files of the product\'s own model. Read a file\'s bytes with `evidence_span` before you map anything to it. Where the section holds no row, the product declares no model: recover without one, and raise nothing for a model that is not there.',
      `Write the mapping between the recovered architecture and the intended model as \`${RECOVERY_MAPPING_PREDICATE}\` claims: the subject is the recovered component, the object is a literal naming the intended element exactly as the model spells it, and the claim cites the model bytes that declare it. Never write the model\'s own words as claims of your own.`,
      `A recovered part no intended element answers to, and an intended element nothing recovered answers to, is a mismatch: raise a question of type ${CONTRADICTION_QUESTION_TYPE} about the node it concerns, naming both sides — the recovered part and the intended element. Never write a mapping nothing supports.`,
      'Your places are the repositories the product pins: a claim about a part whose bytes stand in a repository you did not read is outside your reading, and your coverage says what you read.',
    ],
    task: `Recover the product's architecture from the graph its stages built, write it beside the intended model the product declares, map each recovered part to the intended element it answers to, and raise every mismatch as a question.`,
    answer: RECOVERY_ANSWER,
    kinds: RECOVERY_KINDS,
    consumes: {
      // The product's parts the recovery names are the module tree's, and its own
      // scope is the snapshot's; the model files it names are the inventory's.
      required: [
        { capability: 'repository', scope: 'repository', freshness: 'current' },
        { capability: 'module', scope: 'repository', freshness: 'any' },
      ],
      // The model files the `intendedModel` section names are read as absent where
      // the inventory published none: a product that declares no model still has a
      // recovery, and its coverage says what it read. The claims the packet reads
      // are named by no consume on purpose: every agent stage of the fill writes
      // claims, and a declared consume beside the doc-intent stage's own would
      // draw this stage and that one into a cycle of claims each waiting for the
      // other's — the cycle the registry refuses for every product. The stage
      // stands `after` the stages whose reading it opens instead (see the module
      // doc), and reads what stands when its unit runs.
      optional: [
        { capability: 'file', scope: 'file', freshness: 'any' },
      ],
    },
    sections: recoverySections(),
    plan: (graph: StageGraphReader): Promise<StagePlan> | StagePlan => productUnits(graph),
    places: async (context: AgentUnitContext): Promise<AgentPlaceSet> => {
      // A unit of the whole product covers every repository the run pins; a child
      // unit of 0026's next level covers the one repository its own scope names.
      // Either way its places are those repositories, and the graph's own
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
            raise(`stage ${RECOVERY_STAGE_ID}\'s unit "${context.unit.id}" covers the repository ${JSON.stringify(entry.repository)}, and the graph holds no repository fact of that name: a place is a node the snapshot stage published (src/fill/facts.ts)`);
          }
          return {
            id,
            place: entry.repository,
            scope: entry.repository,
            repository: entry.repository,
            commit: entry.commit,
            // One repository of a product is about as much as one bounded span of
            // reading, 0026's own estimate.
            estimatedTokens: estimateOfMembers(1),
          };
        });
      // The repositories are read as facts of the graph, which the store answers
      // whole: the list is no sample, so nothing of this scope was left
      // unenumerated.
      return { places, cut: false };
    },
  };
}

/**
 * Stage 13, registered over the run's wiring: the shape's own stage, ordered
 * after the stages whose reading its packet opens. `doc-intent` cannot stand in
 * that list — it consumes the claims every agent stage writes, so naming it would
 * close the cycle the registry refuses for every product — and its claims are
 * read as they stand when the unit runs (see the module doc).
 */
export function createRecoveryStage(wiring: AgentStageWiring): FillStage {
  const stage = createAgentStage(recoveryDeclaration(), wiring);
  return { ...stage, after: ['overview', 'intent-history', 'understanding'] };
}
