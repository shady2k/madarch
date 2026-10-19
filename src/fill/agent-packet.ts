/**
 * What one agent unit is told before it reads (decision 0026, "Agent input",
 * madarch-tzte.22.3): a **fixed part** — the unit's role, its rules, its limits,
 * the shape of the answer it must give and the tools it has — and a **per-unit
 * packet** assembled from the graph without an agent: the scope and its place,
 * the members it holds ranked and without their bodies, the edges that reach it
 * and the ones it draws, its data and its entry points, the product's history
 * that touches it, what the graph already says about it (the intent so far, the
 * open questions, the coverage earlier stages recorded), the drafts other units
 * of the run hold about it, and the task itself. No file content is pasted: the
 * two reads that carry bytes (`evidence_span`, a span read) are the unit's own to
 * make, one bounded span at a time, and this module never makes one.
 *
 * 0026 fixes the size: "a starting packet of at most 20K tokens". The cap is
 * counted the fill's own way (`estimateTokens`, four code points a token, the
 * same estimate the tool answers are cut by), over the whole prompt — the fixed
 * part and the packet together — because that prompt is what the unit starts
 * with. A packet that cannot hold everything is cut *by list*, and every cut is
 * named in the packet's own `marker`, so a unit never reads a short packet as a
 * short scope.
 *
 * **What it reads, and what it deliberately does not.** The packet holds what the
 * deterministic stages published about the scope — its node, what it holds, the
 * edges that touch it, its members (ranked, without bodies), its data and entry
 * points, the product's history — and it never reads a kind an agent unit writes
 * (a claim, a rule, a state, an entity, a question, a coverage). The reason is
 * 0027's staleness rule: every read the packet makes is recorded as the unit's
 * dependency and rechecked after the unit publishes, so a packet that read the
 * claims about the unit's own scope would see its own claim arrive and be replaced
 * by a generation that publishes the same facts — one wasted agent run per unit.
 * The graph's intent so far, its open questions and what earlier passes covered are
 * therefore read by the unit through its MCP tools (`claims_about`, `coverage`,
 * `describe_scope`), and the fixed part tells it so. The same rule is why a unit
 * that reads a region it later writes is a known cost of the landed read layer,
 * which excludes a unit's own drafts (madarch-tzte.22.2) but not its own published
 * facts: it is named in this change's open points.
 *
 * Two properties this module is built for:
 *
 * - **Everything in it is a tracked read.** The packet's reads go through the
 *   unit's own reader (`StageContext.graph`, `graphReadsOver`), so each is
 *   recorded as the generation's dependency and a graph that moved under the
 *   packet makes the publication stale rather than published (0027).
 * - **The same graph gives the same prompt.** Sections are ordered, lists are in
 *   code point order of their labels and ids after their kind's rank, and nothing
 *   here reads a clock, a random value or a machine path: two packets of one
 *   generation over one graph are one text, which is what makes the unit's own
 *   cache key (0026, "Updates") meaningful.
 *
 * The task's own size rule comes from 0026 too: a unit plans for about 50% of its
 * window (`plannedTokens`), and one member of a scope costs about one bounded
 * span read — 0026's ~200 lines — which is what the plan's estimate counts.
 */
import { byCodePoint } from '../model/order.js';
import {
  DEFAULT_GRAPH_READ_LIMITS,
  endsOf,
  estimateTokens,
  factsOfRows,
  graphReadsOver,
  labelOf,
  neighbors,
  readText,
  type GraphNodeRef,
  type GraphReadContext,
  type NeighborRow,
} from './graph-reads.js';
import type { Fact, FactEdgeKind, FactKind } from './facts.js';
import { UNIT_TOOLS } from './unit-tools.js';
import { here, raise } from './fsm-core.js';
import type { StageGraphReader, StageLimits } from './stage.js';

/** 0026's cap on the prompt a unit starts with: "at most 20K tokens". */
export const PACKET_TOKENS = 20_000;

/**
 * 0026's planned size: "planned size ~50%" of the window. It is not one of the
 * limits a product configures (0027's `limits` name the window, the two
 * thresholds, the turns and the time), so it stands here as the decision's own
 * reading of what a unit should be handed.
 */
export const PLANNED_FRACTION = 0.5;

/**
 * What one member of a scope costs a unit, in tokens: 0026 bounds an evidence span
 * at about 200 lines, and a unit that reads about a member reads about one span of
 * it. Nothing measures a member more exactly before a unit reads it — the estimate
 * decides only where a scope is split, so an estimate too small is a split that
 * happens later, never a unit that runs past its window.
 */
export const MEMBER_ESTIMATE_TOKENS = 2_000;

/** The most tokens a unit plans for: 0026's ~50% of its window. */
export function plannedTokens(limits: StageLimits): number {
  return Math.floor(limits.contextTokens * PLANNED_FRACTION);
}

/** The tokens an estimate of the members of a scope is, in 0026's own measure. */
export function estimateOfMembers(members: number): number {
  return members * MEMBER_ESTIMATE_TOKENS;
}

/** How many the members list holds at most before the budget cuts it: a reader's bound, and the budget's own below it. */
export const MAX_MEMBER_ROWS = 400;

/** The most rows one of the packet's other lists holds. */
export const MAX_SECTION_ROWS = 20;

/** How many code points a text field in the packet keeps; the rest is cut, and the cut is counted. */
export const MAX_TEXT_CODE_POINTS = 240;

/** The tokens reserved for the markers a full packet's cuts need, so the cap holds the whole prompt. */
const MARKER_RESERVE = 512;

/** One fact as the packet names it: what it is, what a reader calls it, and where it stands. */
export interface PacketNode {
  readonly kind: FactKind | null;
  readonly label: string;
  readonly id: string;
  readonly file?: string;
  readonly line?: number;
}

/** One member of the unit's scope, as the packet ranks it: no body, never the file's bytes. */
export interface UnitMember extends PacketNode {
  /** Where the member stands, as a repository path, when the graph names one (`<repository>:<path>`). */
  readonly place?: string;
}

/** What one packet was built from and what it holds, for the unit's own report. */
export interface UnitPacket {
  /** The part every unit of the stage is told: role, rules, limits, answer shape, tools. */
  readonly fixed: string;
  /** The per-unit part, as the JSON text the agent reads. */
  readonly packet: string;
  /** What the agent is sent: the fixed part, then the packet. */
  readonly prompt: string;
  /** The prompt's own size, in the fill's estimate. */
  readonly tokens: number;
  /** The sections the packet holds, in the order it holds them. */
  readonly sections: readonly string[];
  /** The sections the cap left out or cut, each with the words of its cut. */
  readonly marker: string | null;
  /**
   * Whether the members list this packet holds is shorter than the graph's: the
   * answer cap or the packet's own cap cut it. A unit that covered every place it
   * was *shown* has not read a scope nobody enumerated, so this is what keeps its
   * coverage from claiming one (madarch-tzte.22.3).
   */
  readonly membersCut: boolean;
  /** The scope's node, as the graph answers it. */
  readonly scope: PacketNode;
  /** The scope's members, ranked, as far as the packet holds them. */
  readonly members: readonly UnitMember[];
  /** The scope's repository and, where it names one, the path inside it. */
  readonly place: { readonly repository: string; readonly path?: string; readonly commit: string };
}

/** What one packet is asked for. */
export interface UnitPacketRequest {
  /** The unit the packet is for: the stage's own id and the scope it covers. */
  readonly unit: { readonly id: string; readonly scope: string };
  /** The scope node's fact id: what `describe_scope`, `neighbors` and `claims_about` are asked about. */
  readonly scopeId: string;
  /** The repository the scope stands in, as the product names it. */
  readonly repository: string;
  /** The path inside the repository the scope covers; absent for a whole repository. */
  readonly path?: string;
  /** The commit the run pinned, which a write cites as its evidence. */
  readonly commit: string;
  /** The unit's own reader: every read the packet makes is recorded as its dependency. */
  readonly graph: StageGraphReader;
  /** The stage's resolved limits: the window, the two thresholds, the turns, the time and the output. */
  readonly limits: StageLimits;
  /** The fact kinds this unit may write, as the stage declares what it produces. */
  readonly kinds: readonly string[];
  /** The task, in one sentence: what this unit is for, as its stage states it. */
  readonly task: string;
}

// ---------------------------------------------------------------------------------------------
// The fixed part: the same words for every unit of the stage
// ---------------------------------------------------------------------------------------------

/**
 * The fixed part of every unit's prompt: the role, the rules 0026 and 0027 hold a
 * unit to, its own limits with their numbers, the answer it must give with an
 * example, and the tools it has. Every number here comes from the stage's
 * resolved limits and every tool from the catalogue the unit's server answers
 * (`UNIT_TOOLS`), so the words and the behaviour cannot disagree.
 */
export function unitFixedPart(options: { readonly limits: StageLimits; readonly kinds: readonly string[] }): string {
  const limits = options.limits;
  const wrapAt = Math.floor(limits.contextTokens * limits.wrapAtFraction);
  const stopAt = Math.floor(limits.contextTokens * limits.stopAtFraction);
  const tools = UNIT_TOOLS.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n');
  return [
    'You are one unit of madarch\'s fill: you read one scope of one product\'s pinned code through the tools of this session and write what you establish into the product graph.',
    '',
    'Rules:',
    `- You have no file, shell, network or terminal tools. Code is read only through \`evidence_span\`, about ${String(DEFAULT_GRAPH_READ_LIMITS.spanLines)} lines at a time, and the graph only through the reads below. A tool answer is at most ${String(DEFAULT_GRAPH_READ_LIMITS.answerTokens)} tokens; one that was cut says so.`,
    '- Every fact you write cites the bytes it stands on: the repository, the file and the lines, at the commit the packet names. A write is checked at once and lands in your unit\'s draft set, visible to other units as a draft, never published by you.',
    '- Write facts, not prose: a claim states one thing about one node; a rule states one rule; a state names one state of one machine; a link joins two nodes the graph already holds.',
    '- Stay inside your scope. A write about a place outside it is refused. When something you need is outside your scope, raise a question about it instead.',
    '- Read the graph before you write: `describe_scope` and `coverage` answer what this scope is and what earlier passes read of it, `claims_about` answers the intent already established about it, and `neighbors`, `references` and `evidence_span` answer what stands around it and what the code says. The packet below is where you start, not everything the graph holds.',
    '- Your own file tools are off on purpose: nothing you do may depend on this machine.',
    '',
    `Limits, which madarch enforces: a ${String(limits.contextTokens)}-token context window; a wrap-up message at 70% (${String(wrapAt)} tokens) — after it, stop reading new material and answer; a hard stop at 80% (${String(stopAt)} tokens), at ${String(limits.maxTurns)} turns, at ${String(Math.round(limits.maxDurationMs / 1000))} seconds and at ${String(limits.maxOutputTokens)} output tokens. A unit that reaches a limit is cancelled, and the part it covered is kept with its coverage; the rest of its scope is split into smaller units.`,
    '',
    'The packet below ends with a `marker`: when it is not null, a list in it was cut by 0026\'s 20000-token cap or by a read\'s own cap, and the marker says what was cut. A cut list is a part of your scope nobody has enumerated: read the rest of the scope through the tools, and do not report a place you were not shown as covered.',
    '',
    'Your answer: one message holding exactly this JSON object and nothing else — no prose around it, no code fence.',
    '{"status":"done"|"partial","covered":["<path inside your scope>"],"remaining":["<path inside your scope>"],"summary":"<one sentence>"}',
    '`covered` names every place of your scope you read to the end; `remaining` names the places you did not. A `done` answer whose `remaining` is not empty is read as `partial`: nothing you leave out is reported as covered.',
    'Example: {"status":"done","covered":["src/order.ts","src/cart.ts"],"remaining":[],"summary":"The checkout total is the cart total plus tax"}',
    '',
    `Facts this unit may write: ${options.kinds.join(', ')}.`,
    '',
    'Tools:',
    tools,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// The per-unit part: the scope, from the graph
// ---------------------------------------------------------------------------------------------

/** The kinds a reader is pointed at first, in this order: what a unit is most likely to need to understand a scope. */
const MEMBER_RANK: readonly FactKind[] = ['entry-point', 'module', 'package', 'deploy-unit', 'api-endpoint', 'table', 'column', 'environment-variable', 'test', 'document', 'section', 'file', 'directory', 'symbol', 'commit', 'comment', 'occurrence'];

/** The rank of one member kind: its place in the order above, and last for a kind the order does not name. */
function rankOf(kind: FactKind | null): number {
  const index = kind === null ? -1 : MEMBER_RANK.indexOf(kind);
  return index === -1 ? MEMBER_RANK.length : index;
}

/** One text as the packet keeps it: first line, at most `MAX_TEXT_CODE_POINTS`, cut with an ellipsis and counted. */
function boundedText(text: string): string {
  const line = text.split('\n')[0] ?? '';
  const points = [...line];
  return points.length <= MAX_TEXT_CODE_POINTS ? line : `${points.slice(0, MAX_TEXT_CODE_POINTS - 1).join('')}…`;
}

/** A place as the packet spells it: `<repository>:<path>`, never a machine path. */
export function placeText(repository: string, path?: string): string {
  return path === undefined || path === '' ? repository : `${repository}:${path}`;
}

/** One member as the packet reads a neighbour row: the node, the path it stands at, and the place that path names. */
function memberOf(node: GraphNodeRef, repository: string): UnitMember {
  const path = pathOfNode(node);
  return {
    kind: node.kind,
    // A comment's own label is its text (`labelOf`, `graph-reads.ts`): it is the file's bytes, and 0026 pastes no
    // file content, so a comment member is named by where it stands. Nothing draws a structure edge to a comment
    // today; this is what keeps that from becoming a hole in "no file content is pasted" if one ever does.
    label: node.kind === 'comment' ? (path === undefined ? node.id : placeText(repository, path)) : node.label,
    id: node.id,
    ...(path === undefined ? {} : { file: path }),
    ...(node.line === undefined ? {} : { line: node.line }),
    ...(path === undefined ? {} : { place: placeText(repository, path) }),
  };
}

/**
 * The path inside the repository a member stands at: the place its provenance
 * names, or — where the fact carries no place of its own — the path its label
 * spells. A directory's label is `<repository>:<path>/` and a file's
 * `<repository>:<path>` (`labelOf`, `graph-reads.ts`); a kind whose label names no
 * path (a module's own name, an entry point's, a test's) reads as no path, because a
 * path field that guessed would place a node where it does not stand.
 */
export function pathOfNode(node: { readonly kind: FactKind | null; readonly label: string; readonly file?: string }): string | undefined {
  const placeKinds: readonly (FactKind | null)[] = ['directory', 'file', 'document', 'symbol', 'section'];
  if (!placeKinds.includes(node.kind)) return node.file;
  // A place kind's own label spells where it stands (`<repository>:<path>`, a symbol's `<repository>:<file>#<name>`),
  // and its provenance place is where its fact was *read* — a folder's fact is read at a file inside it. The label
  // is therefore the path, and the provenance is the fallback for a row whose label names none.
  const cut = node.label.indexOf(':');
  const fromLabel = cut < 0 ? '' : (node.label.slice(cut + 1).split('#')[0] ?? '');
  const trimmed = fromLabel.endsWith('/') ? fromLabel.slice(0, -1) : fromLabel;
  if (trimmed !== '') return trimmed;
  return node.file;
}

/** One section as it is written into the packet, with the rows the budget let in and the words of what it cut. */
interface Section {
  readonly name: string;
  readonly value: unknown;
  readonly marker: string | null;
}

/**
 * One list as the budget holds it: rows are taken in order while the serialized
 * section fits what is left, and the rest are counted. The section is always
 * written — an empty list with a marker says "the cap cut this", which a missing
 * key would not.
 */
function boundedList<T>(options: {
  readonly name: string;
  readonly rows: readonly T[];
  readonly render: (row: T) => unknown;
  readonly budget: { left: number };
  readonly what: string;
  readonly max: number;
}): Section {
  const held: unknown[] = [];
  let taken = 0;
  let cut = Math.max(0, options.rows.length - options.max);
  for (const [index, row] of options.rows.entries()) {
    if (index >= options.max) break;
    const rendered = options.render(row);
    const cost = estimateTokens(JSON.stringify(rendered) ?? 'null', DEFAULT_GRAPH_READ_LIMITS);
    if (cost > options.budget.left) {
      cut = options.rows.length - held.length;
      break;
    }
    held.push(rendered);
    options.budget.left -= cost;
    taken += 1;
  }
  const marker = cut === 0 ? null : `truncated: ${options.what} holds ${String(options.rows.length)} ${options.rows.length === 1 ? 'row' : 'rows'} and the packet's ${String(PACKET_TOKENS)}-token cap holds ${String(taken)}: ${String(cut)} ${cut === 1 ? 'row was' : 'rows were'} cut`;
  return { name: options.name, value: held, marker };
}

/** One end of a claim as a reader reads it: the node it names, or the literal or address it states. */
function termText(term: { readonly label?: string; readonly id?: string; readonly url?: string; readonly text?: string }): string {
  return boundedText(term.label ?? term.id ?? term.url ?? term.text ?? '');
}

/** One node as the packet writes it: its kind, its label, its id and where it stands. */
function renderNode(node: PacketNode): Record<string, unknown> {
  return {
    kind: node.kind,
    label: boundedText(node.label),
    id: node.id,
    ...(node.file === undefined ? {} : { file: node.file }),
    ...(node.line === undefined ? {} : { line: node.line }),
  };
}

/**
 * Builds one unit's prompt from the graph. Every read goes through the unit's own
 * reader (`graphReadsOver`, `graph-reads.ts`), which records it as the
 * generation's dependency; the sections are added in the order a unit reads them,
 * each bounded by what the 20K cap has left, and the packet's `marker` names every
 * list the cap cut.
 *
 * **Why the packet reads only what the unit cannot write.** A recorded read is
 * rechecked at publication and again whenever the run sweeps what went stale
 * (0027); a unit that read a graph region its own publication then changes would
 * find its own facts had made its read move, and be replaced by a generation that
 * would publish the same facts and settle. To keep that from costing an agent run
 * per unit, this packet reads the facts the deterministic stages publish about the
 * scope — its node, what it holds, the edges that touch it, its members, the
 * product's history — and never the kinds an agent unit writes (a claim, a rule, a
 * state, an entity, a question, a coverage). The graph's own intent so far, its
 * open questions and what earlier passes covered are read by the unit through its
 * MCP tools (`claims_about`, `coverage`, `describe_scope`), which is what 0026's
 * "Agents and tools" builds them for; the fixed part tells it to.
 */
export async function buildUnitPacket(request: UnitPacketRequest): Promise<UnitPacket> {
  const reads: GraphReadContext = graphReadsOver(request.graph);
  const fixed = unitFixedPart({ limits: request.limits, kinds: request.kinds });
  const budget = { left: PACKET_TOKENS - estimateTokens(fixed, DEFAULT_GRAPH_READ_LIMITS) - MARKER_RESERVE };

  // The scope's own node: what the unit covers, and the place its label spells.
  const scopeRead = { read: 'fact' as const, id: request.scopeId };
  const scopeFacts = factsOfRows(await reads.read(scopeRead), scopeRead);
  const node = scopeFacts[0];
  if (node === undefined) {
    raise(`the unit "${request.unit.id}" covers the scope ${request.scopeId}, and the graph holds no fact of that id: a unit's scope is a node one of the deterministic stages published (src/fill/facts.ts)`);
  }
  const scopeNode: PacketNode = {
    kind: node.kind,
    label: labelOf(node),
    id: node.id,
    ...(node.provenance.place === undefined ? {} : { file: node.provenance.place.file, line: node.provenance.place.range.startLine }),
  };

  // What the scope holds, counted by kind, and the edges that touch it, counted by kind and direction.
  const heldRows = await reads.read({ read: 'held', id: request.scopeId, via: ['contains', 'defines'] });
  const holds = heldRows.map((row) => {
    const held = row as { kind?: unknown; count?: unknown };
    const count = typeof held.count === 'number' ? held.count : Number(held.count);
    if (typeof held.kind !== 'string' || !Number.isFinite(count)) {
      raise(`the held read of ${request.scopeId} answered ${JSON.stringify(row)}, which is no count of a kind: a held read answers the kind of a node and how many of them`);
    }
    return { kind: held.kind, count };
  }).sort((left, right) => byCodePoint(left.kind, right.kind));
  const adjacentRead = { read: 'adjacent' as const, id: request.scopeId };
  const edges = countEdges(factsOfRows(await reads.read(adjacentRead), adjacentRead), request.scopeId);

  // The scope's members, ranked: what the unit works through. `contains` and `defines` place a node inside
  // another, so these are the members themselves and never a neighbourhood.
  const placed = await neighbors(reads, { tool: 'neighbors', id: request.scopeId, direction: 'out', kinds: ['contains', 'defines'] });
  const members = rankedMembers(placed.rows, request.repository);

  // What reaches the scope from outside it: the relations other nodes draw to it.
  const reaching = await neighbors(reads, { tool: 'neighbors', id: request.scopeId, direction: 'in' });

  // The product's history that touches the repository, newest first: a commit's own time, never the clock.
  // The field is a path inside a fact's `value` column (`readPath`, `graph-reads.ts`), so a commit's repository
  // is read as its own field and never as `value.repository`.
  const historyRead = { read: 'facts-with' as const, kind: 'commit' as const, field: 'repository', value: request.repository };
  const history = factsOfRows(await request.graph.query(readText(historyRead)), historyRead);

  // The sections whose shape does not depend on the budget are written first and measured, so the lists that follow
  // are bounded by what is really left of 0026's cap: a graph with very many kinds would otherwise push the prompt
  // past it and fail the unit rather than send a smaller, named packet.
  const head: Section[] = [
    { name: 'unit', value: { id: request.unit.id, scope: request.unit.scope, task: request.task }, marker: null },
    { name: 'place', value: { repository: request.repository, ...(request.path === undefined ? {} : { path: request.path }), commit: request.commit, scope: placeText(request.repository, request.path) }, marker: null },
    { name: 'scope', value: { ...renderNode(scopeNode), holds, edges }, marker: null },
  ];
  const tail: Section[] = [
    { name: 'writes', value: { kinds: [...request.kinds].sort(byCodePoint), note: 'Every fact you write is a fact of one of these kinds, cited to the bytes it stands on; proposing an entity raises a draft a person accepts.' }, marker: null },
  ];
  // The sections whose shape does not depend on the budget are measured first, so the lists that follow are bounded
  // by what is really left of 0026's cap: a graph with very many kinds would otherwise push the prompt past it and
  // fail the unit rather than send a smaller, named packet.
  budget.left -= estimateTokens(JSON.stringify([...head, ...tail].map((section) => [section.name, section.value])), DEFAULT_GRAPH_READ_LIMITS);
  const sections: Section[] = [...head];
  const membersSection = boundedList({ name: 'members', rows: members, render: (member) => ({ ...renderNode(member), ...(member.place === undefined ? {} : { place: member.place }) }), budget, what: `the members of ${request.scopeId}`, max: MAX_MEMBER_ROWS });
  const membersHeld = (membersSection.value as readonly unknown[]).length;
  sections.push(membersSection);
  // The members a unit is pointed at first, by the breadths of what it holds: the entry points it may call and the
  // data it may read are the members' own kinds, so they are named as sections of the same list.
  sections.push(boundedList({ name: 'entryPoints', rows: members.filter((member) => member.kind === 'entry-point' || member.kind === 'test'), render: renderNode, budget, what: `the entry points and tests of ${request.scopeId}`, max: MAX_SECTION_ROWS }));
  sections.push(boundedList({ name: 'data', rows: members.filter((member) => DATA_KINDS.includes(member.kind as string)), render: renderNode, budget, what: `the data nodes of ${request.scopeId}`, max: MAX_SECTION_ROWS }));
  sections.push(boundedList({ name: 'relations', rows: reaching.rows, render: (row: NeighborRow) => ({ kind: row.edge.kind, direction: row.direction, node: boundedText(row.neighbor.label), ...(row.edge.file === undefined ? {} : { file: row.edge.file }), ...(row.edge.line === undefined ? {} : { line: row.edge.line }) }), budget, what: `the relations reaching ${request.scopeId}`, max: MAX_SECTION_ROWS }));
  sections.push(boundedList({ name: 'history', rows: [...history].sort((left, right) => byCodePoint(String((right.value as { committedAt?: unknown }).committedAt ?? ''), String((left.value as { committedAt?: unknown }).committedAt ?? '')) || byCodePoint(left.id, right.id)), render: (fact) => ({ commit: String((fact.value as { commit?: unknown }).commit ?? ''), committedAt: String((fact.value as { committedAt?: unknown }).committedAt ?? ''), subject: boundedText(String((fact.value as { subject?: unknown }).subject ?? '')), id: fact.id }), budget, what: `the commits of ${request.repository}`, max: MAX_SECTION_ROWS }));

  sections.push(...tail);
  // Every cut is named, the packet's own lists and the reads' own caps alike: an answer `neighbors` already cut holds
  // fewer rows than the graph does, and a packet that reported only its own bounds would read as a whole scope.
  const cuts = [
    ...[placed.marker, reaching.marker].filter((marker): marker is string => marker !== null),
    ...sections.map((section) => section.marker).filter((marker): marker is string => marker !== null),
  ];
  const marker = cuts.length === 0 ? null : [...new Set(cuts)].join('; ');
  const held = new Map<string, unknown>();
  const present: string[] = [];
  for (const section of sections) {
    held.set(section.name, section.value);
    present.push(section.name);
  }
  // The marker is part of what the agent reads: a unit told a short packet without being told the packet was cut
  // would read a short scope (0026's "no silently smaller result"). It is the last key, and `unitFixedPart`'s own
  // sentence points at it.
  held.set('marker', marker);
  const packet = JSON.stringify(Object.fromEntries(held), null, 1);
  const prompt = `${fixed}\n\n${packet}`;
  const tokens = estimateTokens(prompt, DEFAULT_GRAPH_READ_LIMITS);
  if (tokens > PACKET_TOKENS) {
    // The budget above bounds every list, so this is a defect of the bound rather than a large graph: a packet
    // over 0026's cap must never be sent, and a silent trim would be a smaller packet nobody named.
    raise(`the prompt of unit "${request.unit.id}" is ${String(tokens)} tokens, past 0026's ${String(PACKET_TOKENS)}-token starting packet: the sections' own bounds did not hold`);
  }
  return {
    fixed,
    packet,
    prompt,
    tokens,
    sections: present,
    marker,
    membersCut: placed.truncated || membersHeld < members.length,
    scope: scopeNode,
    members,
    place: { repository: request.repository, ...(request.path === undefined ? {} : { path: request.path }), commit: request.commit },
  };
}

/** The edges touching one node, counted by kind and direction, in code point order of the kind then the direction. */
function countEdges(facts: readonly Fact[], id: string): readonly { kind: FactEdgeKind; direction: 'in' | 'out'; count: number }[] {
  const counts = new Map<string, { kind: FactEdgeKind; direction: 'in' | 'out'; count: number }>();
  for (const fact of facts) {
    const ends = endsOf(fact.kind as FactEdgeKind, fact.value);
    const direction = ends.from === id ? 'out' : ends.to === id ? 'in' : undefined;
    if (direction === undefined) continue;
    const key = `${fact.kind}\u0000${direction}`;
    const held = counts.get(key);
    counts.set(key, { kind: fact.kind as FactEdgeKind, direction, count: (held?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(left.direction, right.direction));
}

/** The node kinds whose member is data a unit reads: a store's shape and the product's interfaces. */
const DATA_KINDS: readonly string[] = ['api-endpoint', 'table', 'column', 'environment-variable', 'deploy-unit', 'package'];

/**
 * The scope's members, ranked: by the kind's rank above, then by label and id in
 * code point order. The rank is a reader's: the members a unit can act on first
 * (entry points, modules, data), the symbols that fill a file last, and a kind the
 * order does not name after them. Nothing here reads a body.
 */
export function rankedMembers(rows: readonly NeighborRow[], repository: string): readonly UnitMember[] {
  const seen = new Map<string, UnitMember>();
  for (const row of rows) {
    const member = memberOf(row.neighbor, repository);
    if (!seen.has(member.id)) seen.set(member.id, member);
  }
  return [...seen.values()].sort((left, right) => rankOf(left.kind) - rankOf(right.kind)
    || byCodePoint(left.label, right.label)
    || byCodePoint(left.id, right.id));
}

