/**
 * What one agent unit is told before it reads (decision 0026, "Agent input",
 * madarch-tzte.22.3): a **fixed part** — the unit's role, its rules, its limits,
 * the shape of the answer it must give and the tools it has — and a **per-unit
 * packet** assembled from the graph without an agent: the scope and its place,
 * the members it holds ranked and without their bodies, the edges that touch it,
 * its data and its entry points, the relations that reach it, the product's history
 * that touches it, the kinds it may write, and the task itself. No file content is
 * pasted: the only read that carries bytes is the unit's own `evidence_span`, one
 * bounded span at a time, and this module never makes one. The next paragraph says
 * why the graph's own intent, questions and coverage are not in the packet.
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
import { FACT_EDGE_KINDS, type Fact, type FactEdgeKind, type FactKind } from './facts.js';
import { writeScope, type WriteScope } from './checked-writes.js';
import { UNIT_TOOLS } from './unit-tools.js';
import { raise } from './fsm-core.js';
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
  /** The scope's node, as the graph answers it; absent for a unit of the whole product, which no node stands for. */
  readonly scope?: PacketNode;
  /** The scope's members, ranked, as far as the packet holds them; none for a unit of the whole product. */
  readonly members: readonly UnitMember[];
  /**
   * Where the unit stands: the repository its run pinned for it and, where it names
   * one, the path inside it — or, for a unit of the whole product, every repository
   * the run pinned at its commit (0026's hierarchy, `product`).
   */
  readonly place: UnitPacketPlace;
}

/** Where one unit stands: one repository of the product, or the product's every repository (0026's `product` level). */
export type UnitPacketPlace =
  | { readonly repository: string; readonly path?: string; readonly commit: string }
  | { readonly product: true; readonly repositories: readonly UnitPacketRepository[] };

/** One repository the product pins, as a unit of the whole product is told it: its name, its commit and its form. */
export interface UnitPacketRepository {
  readonly repository: string;
  readonly commit: string;
  readonly form: string;
}

/** One section a stage declares for its own packet: a read of the graph, and what its rows are for. */
export interface AgentPacketSection {
  /**
   * The section's key in the packet: unique in the packet, and never one of the shape's own (`unit`, `place`,
   * `scope`, `members`, `entryPoints`, `data`, `relations`, `history`, `writes`, `marker`) — the packet refuses a
   * section that would replace a list it already holds (0026's "no silently smaller result").
   */
  readonly name: string;
  /** What the section is, for the words of a cut (`the modules of the product`). */
  readonly what: string;
  /** The most rows the section holds before its own bound cuts it (`MAX_SECTION_ROWS` by default). */
  readonly max?: number;
  /**
   * Whether this unit's packet holds the section: a stage whose own sections describe a level of 0026's hierarchy
   * declares them for the units of that level, and the units of the levels below read the shape's own sections.
   */
  when?(request: AgentSectionRequest): boolean;
  /** The section's rows, read through the unit's own reader, in the order the section holds them. */
  rows(request: AgentSectionRequest): Promise<readonly unknown[]> | readonly unknown[];
}

/** The keys a packet always holds, and the keys of the sections the shape itself writes for a unit with a scope node. */
const PACKET_KEYS: readonly string[] = ['unit', 'place', 'scope', 'members', 'entryPoints', 'data', 'relations', 'history', 'writes', 'marker'];

/** What one declared section is read in: the unit, the graph read the packet makes, and the reader it records through. */
export interface AgentSectionRequest {
  /** The unit the packet is for: its id and the scope text it covers. */
  readonly unit: { readonly id: string; readonly scope: string };
  /** The scope the unit covers, as the write path reads it: one repository and a path, or the product's every repository. */
  readonly scope: WriteScope;
  /** The unit's own reader (`graphReadsOver`): every read a section makes is recorded as its dependency. */
  readonly reads: GraphReadContext;
  /** The reader itself, for a stage that asks it in its own words. */
  readonly graph: StageGraphReader;
}

/** What one packet is asked for. */
export interface UnitPacketRequest {
  /** The unit the packet is for: the stage's own id and the scope it covers. */
  readonly unit: { readonly id: string; readonly scope: string };
  /**
   * The scope node's fact id: what `describe_scope`, `neighbors` and `claims_about` are asked about, and what the
   * packet's `scope`, `members`, `entryPoints`, `data`, `relations` and `history` sections are read for. Absent for
   * a unit of the whole product, which no single node of the graph stands for: that unit's packet is the sections its
   * stage declares (`sections`) beside the `unit` and `place` ones.
   */
  readonly scopeId?: string;
  /** The repository the scope stands in, as the product names it; absent for a unit of the whole product. */
  readonly repository?: string;
  /** The path inside the repository the scope covers; absent for a whole repository. */
  readonly path?: string;
  /** The commit the run pinned, which a write cites as its evidence; absent for a unit of the whole product. */
  readonly commit?: string;
  /** Every repository the product pins, for a unit of the whole product: where its writes may cite bytes. */
  readonly product?: readonly UnitPacketRepository[];
  /** The stage's own sections, between the packet's own and the kinds it may write. */
  readonly sections?: readonly AgentPacketSection[];
  /** The role this stage's units are told, in the fixed part: the fill's own words when it names none. */
  readonly role?: string;
  /** The stage's own rules, after the shape's own, in the fixed part. */
  readonly rules?: readonly string[];
  /** The answer this stage's units give, in the fixed part: the fill's own when it names none. */
  readonly answer?: AgentAnswer;
  /** The level of the fill's three (outcome 4) this stage's statements stand at: `meaning` when it names none. */
  readonly level?: AgentFixedLevel;
  /** 0026's scale the stage's units are part of: where they stand in its hierarchy and the two bounds it fixes. */
  readonly scale?: AgentScaleWords;
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
 * One field of the answer a stage's units are told to give (0026, "Agent input":
 * "a fixed part (role, rules, limits, answer schema with an example …)").
 */
export interface AgentAnswerField {
  /** The field's name, as the answer's JSON object spells it. */
  readonly name: string;
  /**
   * How the field is read: a `status` is `done` or `partial`; `places` is a list of
   * the places of the unit's scope; `text` is one string.
   */
  readonly type: 'status' | 'places' | 'text';
  /**
   * Whether a valid answer must name the field. A field a stage leaves optional is
   * read when it is there; an absent optional field is no refusal.
   */
  readonly required?: boolean;
}

/** The answer one stage's units give: the JSON sketch, how each field is read, the example, and the fields. */
export interface AgentAnswer {
  /** The JSON sketch the unit is told, as one line of the prompt (`{"status":"done"|"partial",…}`). */
  readonly shape: string;
  /** How the fields are read, one sentence a line, as the unit is told them. */
  readonly reading: readonly string[];
  /** One example of the object, as JSON: 0026's "answer schema with an example". */
  readonly example: string;
  /** The fields, as the shape's own reader judges an answer against them. */
  readonly fields: readonly AgentAnswerField[];
}

/** The role every agent unit of the fill is told, where its stage names none. */
export const UNIT_ROLE = 'You are one unit of madarch\'s fill: you read one scope of one product\'s pinned code through the tools of this session and write what you establish into the product graph.';

/**
 * The rules the shape holds every agent unit to, whatever its stage (0026's "no
 * file content is pasted", its bounded tools and its scope; 0027's recorded reads).
 * A stage's own rules stand after them.
 */
export function shapeRules(): readonly string[] {
  return [
    `You have no file, shell, network or terminal tools. Code is read only through \`evidence_span\`, about ${String(DEFAULT_GRAPH_READ_LIMITS.spanLines)} lines at a time, and the graph only through the reads below. A tool answer is at most ${String(DEFAULT_GRAPH_READ_LIMITS.answerTokens)} tokens; one that was cut says so.`,
    '- Every fact you write cites the bytes it stands on: the repository, the file and the lines, at the commit the packet names. A write is checked at once and lands in your unit\'s draft set, visible to other units as a draft, never published by you.',
    '- Write facts, not prose: a claim states one thing about one node; a rule states one rule; a state names one state of one machine; a link joins two nodes the graph already holds.',
    '- Stay inside your scope. A write about a place outside it is refused. When something you need is outside your scope, raise a question about it instead.',
    '- Read the graph before you write: `describe_scope` and `coverage` answer what this scope is and what earlier passes read of it, `claims_about` answers the intent already established about it, and `neighbors`, `references` and `evidence_span` answer what stands around it and what the code says. The packet below is where you start, not everything the graph holds.',
    '- Your own file tools are off on purpose: nothing you do may depend on this machine.',
  ];
}

/** The answer an agent unit gives where its stage names none: the status of its reading, the places, and a summary. */
export const UNIT_ANSWER: AgentAnswer = {
  shape: '{"status":"done"|"partial","covered":["<path inside your scope>"],"remaining":["<path inside your scope>"],"summary":"<one sentence>"}',
  reading: [
    '`covered` names every place of your scope you read to the end; `remaining` names the places you did not. A `done` answer whose `remaining` is not empty is read as `partial`: nothing you leave out is reported as covered.',
  ],
  example: '{"status":"done","covered":["src/order.ts","src/cart.ts"],"remaining":[],"summary":"The checkout total is the cart total plus tax"}',
  fields: [
    { name: 'status', type: 'status', required: true },
    { name: 'covered', type: 'places', required: true },
    { name: 'remaining', type: 'places', required: true },
    { name: 'summary', type: 'text' },
  ],
};

/**
 * The level of the fill's three (self-filling's outcome 4) a stage's statements stand
 * at: the `fact` level is the deterministic stages' own, `intent` is what people
 * recorded, and `meaning` is what an agent reads into the code — assumed, never fact.
 */
export type AgentFixedLevel = 'meaning' | 'intent';

/**
 * 0026's "Scale", as a unit is told it: the level of the hierarchy the stage's units
 * stand at, the level below it, and the two bounds the decision fixes — "summaries are
 * bounded (~2K tokens) and fan-in is bounded (~50 children, else an intermediate
 * grouping level), so every level, the product overview included, fits a unit".
 */
export interface AgentScaleWords {
  readonly level: string;
  readonly child: string;
  readonly summaryTokens: number;
  readonly fanIn: number;
}

/** What one unit's fixed part is told: its stage's role, rules, answer and level, and the limits and kinds of this run. */
export interface UnitFixedPartOptions {
  /** The stage's resolved limits: the window, the two thresholds, the turns, the time and the output. */
  readonly limits: StageLimits;
  /** The fact kinds this unit may write, as the stage declares what it produces. */
  readonly kinds: readonly string[];
  /** The role this stage's units are told; the fill's own words when it names none. */
  readonly role?: string;
  /** The level of the fill's three this stage's statements stand at; `meaning` when the stage names none. */
  readonly level?: AgentFixedLevel;
  /** The stage's own rules, after the shape's own. */
  readonly rules?: readonly string[];
  /** The answer this stage's units give; the fill's own when it names none. */
  readonly answer?: AgentAnswer;
  /** 0026's scale the stage's units are part of: where they stand in its hierarchy and the two bounds it fixes. */
  readonly scale?: AgentScaleWords;
}

/**
 * The fixed part of every unit's prompt: the role, the rules 0026 and 0027 hold a
 * unit to, its own limits with their numbers, the answer it must give with an
 * example, and the tools it has. Every number here comes from the stage's
 * resolved limits, every tool from the catalogue the unit's server answers
 * (`UNIT_TOOLS`) and every word of the role, the rules and the answer from the
 * stage's own declaration, so the words and the behaviour cannot disagree.
 */
export function unitFixedPart(options: UnitFixedPartOptions): string {
  const limits = options.limits;
  const answer = options.answer ?? UNIT_ANSWER;
  const role = options.role ?? UNIT_ROLE;
  const wrapAt = Math.floor(limits.contextTokens * limits.wrapAtFraction);
  const stopAt = Math.floor(limits.contextTokens * limits.stopAtFraction);
  const tools = UNIT_TOOLS.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n');
  return [
    role,
    '',
    // 0005 keeps how a fact was obtained apart from what it is about, and self-filling's outcome 4 names the three
    // levels a reader of the wiki sees: the unit is told which one its own statements stand at.
    (options.level ?? 'meaning') === 'intent'
      ? 'What you write is intent: what people said this product is meant to do, as the documents, the comments and the commits state it, read from the graph and cited to them.'
      : 'What you write is meaning: what this product and its parts mean, read from the code and the graph around it — an assumption, written as an inferred and proposed fact, never a fact a reader may take as confirmed.',
    // 0026's scale, in the stage's own numbers: a unit told where it stands reads a child's summary at the bound the
    // decision fixes, and knows that a wider level is grouped rather than read whole.
    ...(options.scale === undefined ? [] : ['', `The fill's scale: you stand at the ${options.scale.level} level of the hierarchy product → repository → package → cluster → place (a folder or a file inside a repository), and a unit that splits into yours covers the ${options.scale.child} level; a child's summary you read is at most ${String(options.scale.summaryTokens)} tokens, and at most ${String(options.scale.fanIn)} children stand beside one parent before an intermediate grouping level stands between them.`]),
    '',
    'Rules:',
    ...shapeRules().map((rule) => rule.startsWith('- ') ? rule : `- ${rule}`),
    ...(options.rules ?? []).map((rule) => rule.startsWith('- ') ? rule : `- ${rule}`),
    '',
    `Limits, which madarch enforces: a ${String(limits.contextTokens)}-token context window; a wrap-up message at 70% (${String(wrapAt)} tokens) — after it, stop reading new material and answer; a hard stop at 80% (${String(stopAt)} tokens), at ${String(limits.maxTurns)} turns, at ${String(Math.round(limits.maxDurationMs / 1000))} seconds and at ${String(limits.maxOutputTokens)} output tokens. A unit that reaches a limit is cancelled, and the part it covered is kept with its coverage; the rest of its scope is split into smaller units.`,
    '',
    'The packet below ends with a `marker`: when it is not null, a list in it was cut by 0026\'s 20000-token cap or by a read\'s own cap, and the marker says what was cut. A cut list is a part of your scope nobody has enumerated: read the rest of the scope through the tools, and do not report a place you were not shown as covered.',
    '',
    'Your answer: one message holding exactly this JSON object and nothing else — no prose around it, no code fence.',
    answer.shape,
    ...answer.reading,
    `Example: ${answer.example}`,
    '',
    `Facts this unit may write: ${options.kinds.join(', ')} — and nothing else: a write of a kind this unit's stage does not declare is refused when it is made, with the kinds it does declare, and never lands in its draft set. A \`link\` draws one of the schema's edge kinds this unit produces — here ${options.kinds.filter((kind) => (FACT_EDGE_KINDS as readonly string[]).includes(kind)).join(' and ') || 'none'} — and a link of a read kind another tool description names as an example (\`call\`, \`import\`, \`dependency\`) is refused the same way.'`,
    '',
    'Tools:',
    tools,
  ].join('\n');
}

/** The end of the balanced object that opens at `start`, or -1 when it never closes (a text cut by a cap). */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The places an answer's own list names: text entries, as the places of the unit's scope. */
function pathsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/** One answer as a stage's schema reads it: the status, the places and the text fields the unit wrote. */
export interface AgentAnswerValue {
  readonly status: 'done' | 'partial';
  /** The places the unit read to the end, as its answer names them. */
  readonly covered: readonly string[];
  /** The places the unit did not read. */
  readonly remaining: readonly string[];
  /** The unit's `text` fields, as it wrote them, by field name. */
  readonly texts: Readonly<Record<string, string>>;
  /** The whole object, as the unit wrote it: a stage reads its own fields from here. */
  readonly value: Readonly<Record<string, unknown>>;
}

/** What reading one turn's text against a stage's answer ended in: the answer, or why the text is none. */
export type AgentAnswerReading =
  | { readonly answer: AgentAnswerValue; readonly refusal?: undefined }
  | { readonly answer?: undefined; readonly refusal: string };

/** The words a stage's answer asks its fields in, for the refusals that name them. */
function fieldsNamed(answer: AgentAnswer): string {
  return answer.fields.map((field) => `\`${field.name}\``).join(', ');
}

/**
 * What one field of an answer holds, or why the value is none: the field's own name
 * and type in the refusal, so an agent reads which field it wrote wrong and how.
 */
function fieldReading(field: AgentAnswerField, value: unknown): { readonly ok: true } | { readonly ok: false; readonly why: string } {
  if (field.type === 'status') {
    return value === 'done' || value === 'partial'
      ? { ok: true }
      : { ok: false, why: `\`${field.name}\` is \`done\` or \`partial\`, and the answer says ${JSON.stringify(value) ?? String(value)}` };
  }
  if (field.type === 'places') {
    // A list's entries are read as its text entries (`pathsOf`): a number or a nested object in it names no place, and
    // an answer that names fewer places is read as one that covered fewer — the safe direction, never a wider scope.
    return Array.isArray(value)
      ? { ok: true }
      : { ok: false, why: `\`${field.name}\` is a list of places, and the answer says ${JSON.stringify(value) ?? String(value)}` };
  }
  return typeof value === 'string'
    ? { ok: true }
    : { ok: false, why: `\`${field.name}\` is one text, and the answer says ${JSON.stringify(value) ?? String(value)}` };
}

/**
 * Reads one turn's text against a stage's answer schema: the agent is asked for one
 * JSON object and nothing else, and an agent that wraps it in prose is read by the
 * object's own shape rather than refused — the last balanced object of the turn that
 * the schema reads is the answer. A text with no such object is no answer, and the
 * refusal names the field that was wrong or the fields the object lacked, which is
 * what the unit is told when it is asked again (inside 0026's turn limit).
 */
export function readAgentAnswer(text: string, answer: AgentAnswer): AgentAnswerReading {
  const candidates: string[] = [];
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = balancedEnd(text, start);
    if (end > start) candidates.push(text.slice(start, end + 1));
  }
  /** Why the last object this turn held is no answer: the one refusal the unit is told. */
  let refusal = `this turn holds no JSON object, and the answer is one object with the fields ${fieldsNamed(answer)}`;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidates[index]!);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const held = parsed as Record<string, unknown>;
    let problem: string | undefined;
    for (const field of answer.fields) {
      const present = Object.hasOwn(held, field.name);
      if (!present) {
        if (field.required === true) { problem = `the answer names no \`${field.name}\`, and this unit's answer is one object with the fields ${fieldsNamed(answer)}`; break; }
        continue;
      }
      const read = fieldReading(field, held[field.name]);
      if (!read.ok) { problem = read.why; break; }
    }
    if (problem !== undefined) { refusal = problem; continue; }
    const status = held['status'];
    if (status !== 'done' && status !== 'partial') {
      // A schema without a `status` field is no schema of this fill's answers: 0026's unit contract always says how
      // far it read its scope, and the coverage of the unit is read from it.
      refusal = `the answer names no \`status\`, and every unit of the fill says how far it read its scope`;
      continue;
    }
    const texts: Record<string, string> = {};
    for (const field of answer.fields) {
      if (field.type !== 'text') continue;
      const value = held[field.name];
      if (typeof value === 'string') texts[field.name] = value;
    }
    return {
      answer: {
        status,
        covered: pathsOf(held['covered']),
        remaining: pathsOf(held['remaining']),
        texts,
        value: held,
      },
    };
  }
  return { refusal };
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

/** One text as the packet keeps it: its first line, at most `MAX_TEXT_CODE_POINTS` code points, cut with an ellipsis. */
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
/**
 * The label a packet writes for one node. A comment's own label is its text (`labelOf`, `graph-reads.ts`) — the
 * file's bytes, and 0026 pastes no file content — so anything whose label is content is named by where it stands
 * instead. Nothing draws an edge to a comment today; this is what keeps that from becoming a hole in "no file
 * content is pasted" if one ever does.
 */
function packetLabel(node: GraphNodeRef, repository: string): string {
  if (node.kind !== 'comment') return boundedText(node.label);
  const path = pathOfNode(node);
  return boundedText(path === undefined ? node.id : placeText(repository, path));
}

function memberOf(node: GraphNodeRef, repository: string): UnitMember {
  const path = pathOfNode(node);
  return {
    kind: node.kind,
    label: packetLabel(node, repository),
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
  /** Why the list stopped short: the section's own count, or the packet's token budget. */
  let by: 'count' | 'tokens' | null = cut === 0 ? null : 'count';
  for (const [index, row] of options.rows.entries()) {
    if (index >= options.max) break;
    const rendered = options.render(row);
    // Charged in the currency the prompt is sent in: the packet is pretty-printed (`JSON.stringify(…, null, 1)`),
    // so a row costs what its own line of that text costs and not what its compact form does.
    const cost = estimateTokens(JSON.stringify(rendered, null, 1) ?? 'null', DEFAULT_GRAPH_READ_LIMITS);
    if (cost > options.budget.left) {
      cut = options.rows.length - held.length;
      by = 'tokens';
      break;
    }
    held.push(rendered);
    options.budget.left -= cost;
    taken += 1;
  }
  const cap = by === 'tokens' ? `the packet's ${String(PACKET_TOKENS)}-token cap` : `this list's own bound of ${String(options.max)} rows`;
  const marker = cut === 0 || by === null ? null : `truncated: ${options.what} holds ${String(options.rows.length)} ${options.rows.length === 1 ? 'row' : 'rows'} and ${cap} holds ${String(taken)}: ${String(cut)} ${cut === 1 ? 'row was' : 'rows were'} cut`;
  return { name: options.name, value: held, marker };
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
  const fixed = unitFixedPart({
    limits: request.limits,
    kinds: request.kinds,
    ...(request.role === undefined ? {} : { role: request.role }),
    ...(request.rules === undefined ? {} : { rules: request.rules }),
    ...(request.answer === undefined ? {} : { answer: request.answer }),
    ...(request.level === undefined ? {} : { level: request.level }),
    ...(request.scale === undefined ? {} : { scale: request.scale }),
  });
  const budget = { left: PACKET_TOKENS - estimateTokens(fixed, DEFAULT_GRAPH_READ_LIMITS) - MARKER_RESERVE };
  // A unit of the whole product stands where no single node does: its packet is the shape's own `unit` and `place`
  // sections, the sections its stage declares, and the kinds it may write (`product`).
  const product = request.product !== undefined;
  const repository = request.repository ?? '';
  if (product === (request.scopeId !== undefined)) {
    raise(`the unit "${request.unit.id}" asks for a packet of ${product ? 'the whole product and a scope node' : 'one scope node and no repository'}: a packet stands at the product level (\`product\`) or at one node of the graph (\`scopeId\`, with the repository it stands in), and never at both`);
  }

  let scopeNode: PacketNode | undefined;
  let holds: readonly { readonly kind: string; readonly count: number }[] = [];
  let edges: readonly { readonly kind: FactEdgeKind; readonly direction: 'in' | 'out'; readonly count: number }[] = [];
  let members: readonly UnitMember[] = [];
  let placed: Awaited<ReturnType<typeof neighbors>> = { tool: 'neighbors', rows: [], total: 0, truncated: false, marker: null } as unknown as Awaited<ReturnType<typeof neighbors>>;
  let reaching: Awaited<ReturnType<typeof neighbors>> = placed;
  let history: readonly Fact[] = [];

  if (request.scopeId !== undefined) {
    // The scope's own node: what the unit covers, and the place its label spells.
    const scopeRead = { read: 'fact' as const, id: request.scopeId };
    const scopeFacts = factsOfRows(await reads.read(scopeRead), scopeRead);
    const node = scopeFacts[0];
    if (node === undefined) {
      raise(`the unit "${request.unit.id}" covers the scope ${request.scopeId}, and the graph holds no fact of that id: a unit's scope is a node one of the deterministic stages published (src/fill/facts.ts)`);
    }
    scopeNode = {
      kind: node.kind,
      label: labelOf(node),
      id: node.id,
      ...(node.provenance.place === undefined ? {} : { file: node.provenance.place.file, line: node.provenance.place.range.startLine }),
    };

    // What the scope holds, counted by kind, and the edges that touch it, counted by kind and direction.
    const heldRows = await reads.read({ read: 'held', id: request.scopeId, via: ['contains', 'defines'] });
    const holds_ = heldRows.map((row) => {
      const held = row as { kind?: unknown; count?: unknown };
      const count = typeof held.count === 'number' ? held.count : Number(held.count);
      if (typeof held.kind !== 'string' || !Number.isFinite(count)) {
        raise(`the held read of ${request.scopeId} answered ${JSON.stringify(row)}, which is no count of a kind: a held read answers the kind of a node and how many of them`);
      }
      return { kind: held.kind, count };
    }).sort((left, right) => byCodePoint(left.kind, right.kind));
    holds = holds_;
    const adjacentRead = { read: 'adjacent' as const, id: request.scopeId };
    edges = countEdges(factsOfRows(await reads.read(adjacentRead), adjacentRead), request.scopeId);

    // The scope's members, ranked: what the unit works through. `contains` and `defines` place a node inside
    // another, so these are the members themselves and never a neighbourhood.
    placed = await neighbors(reads, { tool: 'neighbors', id: request.scopeId, direction: 'out', kinds: ['contains', 'defines'] });
    members = rankedMembers(placed.rows, repository);

    // What reaches the scope from outside it: the relations other nodes draw to it.
    reaching = await neighbors(reads, { tool: 'neighbors', id: request.scopeId, direction: 'in' });

    // The product's history that touches the repository, newest first: a commit's own time, never the clock.
    // The field is a path inside a fact's `value` column (`readPath`, `graph-reads.ts`), so a commit's repository
    // is read as its own field and never as `value.repository`.
    const historyRead = { read: 'facts-with' as const, kind: 'commit' as const, field: 'repository', value: repository };
    history = factsOfRows(await request.graph.query(readText(historyRead)), historyRead);
  }

  const unitPlace: UnitPacketPlace = product
    ? { product: true, repositories: [...(request.product ?? [])].sort((left, right) => byCodePoint(left.repository, right.repository)) }
    : { repository, ...(request.path === undefined ? {} : { path: request.path }), commit: request.commit ?? '' };
  // What the packet tells the agent about where it stands: the place with the scope text a write's evidence is spelled
  // in (`<repository>[:<path>]`), which is where the unit's own coverage and its answer's places are counted.
  const placeSection = product
    ? unitPlace
    : { ...unitPlace, scope: placeText(repository, request.path) };
  const head: Section[] = [
    { name: 'unit', value: { id: request.unit.id, scope: request.unit.scope, task: request.task }, marker: null },
    { name: 'place', value: placeSection, marker: null },
    ...(scopeNode === undefined ? [] : [{ name: 'scope', value: { ...renderNode(scopeNode), holds, edges }, marker: null }]),
  ];
  const tail: Section[] = [
    { name: 'writes', value: { kinds: [...request.kinds].sort(byCodePoint), note: 'Every fact you write is a fact of one of these kinds, cited to the bytes it stands on, and a write of any other kind is refused.' }, marker: null },
  ];
  // The sections whose shape does not depend on the budget are measured first, so the lists that follow are bounded
  // by what is really left of 0026's cap: a graph with very many kinds would otherwise push the prompt past it and
  // fail the unit rather than send a smaller, named packet.
  budget.left -= estimateTokens(JSON.stringify([...head, ...tail].map((section) => [section.name, section.value]), null, 1), DEFAULT_GRAPH_READ_LIMITS);
  const sections: Section[] = [...head];
  let membersHeld = 0;
  if (scopeNode !== undefined) {
    const membersSection = boundedList({ name: 'members', rows: members, render: (member) => ({ ...renderNode(member), ...(member.place === undefined ? {} : { place: member.place }) }), budget, what: `the members of ${String(request.scopeId)}`, max: MAX_MEMBER_ROWS });
    membersHeld = (membersSection.value as readonly unknown[]).length;
    sections.push(membersSection);
    // The members a unit is pointed at first, by the breadths of what it holds: the entry points it may call and the
    // data it may read are the members' own kinds, so they are named as sections of the same list.
    sections.push(boundedList({ name: 'entryPoints', rows: members.filter((member) => member.kind === 'entry-point' || member.kind === 'test'), render: renderNode, budget, what: `the entry points and tests of ${String(request.scopeId)}`, max: MAX_SECTION_ROWS }));
    sections.push(boundedList({ name: 'data', rows: members.filter((member) => DATA_KINDS.includes(member.kind as string)), render: renderNode, budget, what: `the data nodes of ${String(request.scopeId)}`, max: MAX_SECTION_ROWS }));
    sections.push(boundedList({ name: 'relations', rows: reaching.rows, render: (row: NeighborRow) => ({ kind: row.edge.kind, direction: row.direction, node: packetLabel(row.neighbor, repository), ...(row.edge.file === undefined ? {} : { file: row.edge.file }), ...(row.edge.line === undefined ? {} : { line: row.edge.line }) }), budget, what: `the relations reaching ${String(request.scopeId)}`, max: MAX_SECTION_ROWS }));
    sections.push(boundedList({ name: 'history', rows: [...history].sort((left, right) => byCodePoint(String((right.value as { committedAt?: unknown }).committedAt ?? ''), String((left.value as { committedAt?: unknown }).committedAt ?? '')) || byCodePoint(left.id, right.id)), render: (fact) => ({ commit: String((fact.value as { commit?: unknown }).commit ?? ''), committedAt: String((fact.value as { committedAt?: unknown }).committedAt ?? ''), subject: boundedText(String((fact.value as { subject?: unknown }).subject ?? '')), id: fact.id }), budget, what: `the commits of ${repository}`, max: MAX_SECTION_ROWS }));
  }
  // The stage's own sections, in the order it declares them: each read through the unit's own reader, each bounded by
  // what the cap has left, and each cut named in the packet's marker like every other list.
  const request_ = { unit: request.unit, scope: writeScope(request.unit.scope), reads, graph: request.graph };
  const declared: string[] = [];
  for (const section of request.sections ?? []) {
    // A section a stage declares for another level of 0026's hierarchy is not in this unit's packet at all.
    if (section.when !== undefined && !section.when(request_)) continue;
    // 0026's "no silently smaller result" holds inside the packet's own assembly: a section that would take a key the
    // packet already holds — one of the shape's, another stage section's, or the packet's own `marker` — is refused by
    // name rather than replacing the list that key stood for.
    const taken = [...sections.map((held_) => held_.name), 'writes', 'marker'];
    if (taken.includes(section.name)) {
      raise(`the unit "${request.unit.id}" declares the packet section ${JSON.stringify(section.name)}, a key the packet already holds: the packet's own keys are ${[...new Set([...PACKET_KEYS])].join(', ')}, and a stage's section takes a name of its own so no list it holds replaces another (0026's "no silently smaller result")`);
    }
    const rows = await section.rows(request_);
    declared.push(section.name);
    sections.push(boundedList({ name: section.name, rows, render: (row) => row, budget, what: section.what, max: section.max ?? MAX_SECTION_ROWS }));
  }

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
    ...(scopeNode === undefined ? {} : { scope: scopeNode }),
    members,
    place: unitPlace,
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

