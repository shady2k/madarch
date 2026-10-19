/**
 * The stage whose units are agent units (decision 0026, madarch-tzte.22.3): one
 * unit reads one scope of the product's pinned code through its own MCP server,
 * writes what it establishes into the product graph as draft, and answers within
 * 0026's "Units and limits".
 *
 * **What one unit is.** A scope in the graph's own terms, and the unit's id is the
 * scope node's fact id — never a run, a time or an attempt (0026, "Updates"). The
 * plan names one unit per repository; a repository whose estimate is past 0026's
 * planned size is planned as its member places, one level at a time and within a
 * bound, because "split until a unit's estimate (computed from the graph) fits" is
 * what the plan's recursion is for.
 *
 * **What one unit runs.** The packet (`src/fill/agent-packet.ts`: the fixed part
 * and the per-unit part assembled from the graph, at most 20K tokens, no file
 * content pasted), the ACP session with the unit's MCP server attached (0026,
 * "Agents and tools"; madarch-tzte.22.1 and 22.2), and the guard of
 * `src/fill/unit-limits.ts`: 70% of the window earns a wrap-up message as the
 * unit's next turn, 80% cancels the turn in flight, and the turn count, the wall
 * clock and the output are read at every turn's end.
 *
 * **What a unit that reaches a limit does.** It returns what it has with its
 * coverage: the facts it wrote stay in its draft set, a `coverage` fact says which
 * places of the scope it read and which it did not — a `budget` gap, every gap
 * counted — and the unit answers `split` with the places it did not cover as its
 * children, one child per place in code point order, at most `SPLIT_CHILDREN`, the
 * rest recorded in the coverage's gaps rather than dropped. The orchestrator seals
 * the child set with the parent's checkpoint and runs the parts (0027); the parent
 * joins when they published, and its own next attempt starts from the graph they
 * filled.
 *
 * **What a unit that finishes does.** Its draft set is published in one
 * transaction (0027), and its coverage says `complete` only when every place of the
 * scope was covered: an answer that says `done` while it left places out is read as
 * `partial`, which is 0026's rule that a scope's coverage is "not enough data"
 * rather than an absence.
 *
 * **What this stage does not decide.** The limits are the product's and 0027's
 * (`context.config.limits`); the split bounds (depth, children, work) are the
 * orchestrator's (`OrchestratorLimits`); the agent is the run's wiring. Nothing
 * here re-decides them: the stage plans against 0026's default window, so a product
 * that narrows it makes a unit split earlier at run time — never later, since the
 * guard reads the resolved limits.
 */
import { Type } from 'typebox';
import { canonicalJsonDigest } from '../../model/canonical.js';
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
import {
  buildUnitPacket,
  estimateOfMembers,
  PACKET_TOKENS,
  pathOfNode,
  placeText,
  plannedTokens,
  type UnitMember,
} from '../agent-packet.js';
import { scopeText, writeScope, type WriteScope } from '../checked-writes.js';
import { checkFact, FACT_KINDS, makeNodeFact, type CoverageGap, type CoverageValue, type Fact, type FactKind, type FactSource } from '../facts.js';
import {
  DEFAULT_GRAPH_READ_LIMITS,
  estimateTokens,
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
  type FillStage,
  type StageContext,
  type StageDraftSet,
  type StageDraftWrite,
  type StageExecutionResult,
  type StageGraphReader,
  type StageLimits,
  type StagePlan,
  type StageUnit,
  type StageUnitScope,
  type StageValidation,
} from '../stage.js';
import { createUnitLimitGuard, type UnitLimitCause, type UnitLimitGuard } from '../unit-limits.js';

/** The stage's id, as it is registered: one agent unit per scope, decision 0026's stages 8 to 13. */
export const AGENT_UNIT_STAGE_ID = 'agent-unit';

/** The stage's own version, bumped when what it plans, runs or writes changes. */
export const AGENT_UNIT_STAGE_VERSION = 1;

/**
 * The fact kinds one agent unit may write: a claim (0004's atom at 0005's inferred
 * layer), a rule, a state of a machine, an entity a document could be about, a
 * question for a person, and the coverage every stage of the fill reports in.
 */
export const AGENT_UNIT_KINDS: readonly string[] = ['claim', 'coverage', 'entity-proposal', 'question', 'rule', 'state'];

/** The task the unit's own prompt carries: what an agent unit is for, in one sentence. */
export const AGENT_UNIT_TASK = 'Read the scope you are given, understand it, and write what you establish as facts of the graph, cited to the bytes you read.';

/** The system a fact this stage writes names as its reader where the wiring names none (0004's `plugin@version`). */
export const AGENT_UNIT_SOURCE_SYSTEM = 'madarch-fill-agent';

/**
 * How deep the plan splits a scope before it leaves the rest to the run: 0027's own
 * split depth, so a plan and a split nest alike and neither nests deeper than the
 * other.
 */
export const MAX_PLAN_DEPTH = 3;

/** The most units one plan names for one repository: past it the repository stands as one unit, split at run time. */
export const MAX_PLAN_UNITS = 256;

/**
 * The most children one split names. 0027's bound on a split is the orchestrator's
 * (`maxSplitChildren`, eight by default); a stage cannot read it, so this is the
 * number it names here, and a product that lowers the orchestrator's bound below it
 * blocks the parent with the orchestrator's own reason rather than sealing a set it
 * refuses.
 */
export const SPLIT_CHILDREN = 8;

/** What the stage is wired with: the agent program, the clock its limits read, the run's pins, and where the agent runs. */
export interface AgentUnitWiring {
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
  /** The system a coverage fact names as its reader; `madarch-fill-agent` at this build's version by default. */
  readonly source?: FactSource;
}

/** The stage's own configuration: nothing beyond 0027's limits and the stage's defaults. */
export const AGENT_UNIT_CONFIG_SCHEMA = Type.Object({});

/**
 * The agent unit stage, registered over the run's wiring. A run that wires no agent
 * registers no agent unit stage at all (`stages/index.ts`), so a product whose fill
 * has no agent never plans a unit that could read nothing.
 */
export function createAgentUnitStage(wiring: AgentUnitWiring): FillStage {
  const clock = wiring.clock ?? (() => Date.now());
  const source: FactSource = wiring.source ?? { system: AGENT_UNIT_SOURCE_SYSTEM, version: runningVersion() };
  return {
    id: AGENT_UNIT_STAGE_ID,
    version: AGENT_UNIT_STAGE_VERSION,
    usesTools: true,
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
    // Each kind's own schema version, as the schema's table states it (0027's `produces`), never a guess.
    produces: AGENT_UNIT_KINDS.map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind as 'claim'].version, scope: 'cluster' as const })),
    configSchema: AGENT_UNIT_CONFIG_SCHEMA,
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: (graph) => planUnits(graph),
    execute: (unit, context) => executeUnit({ agent: wiring.agent, snapshots: wiring.snapshots, clock, source, ...(wiring.cwd === undefined ? {} : { cwd: wiring.cwd }), ...(wiring.timeouts === undefined ? {} : { timeouts: wiring.timeouts }) }, unit, context),
    validate: (draft) => validateDraft(draft),
  };
}

// ---------------------------------------------------------------------------------------------
// The plan: the scopes the graph gives this stage, split until each fits
// ---------------------------------------------------------------------------------------------

/**
 * The reads a plan makes for the repositories of a run: the grammar reads facts
 * with one value field exactly, so the code repositories and the product repository
 * are read by the one field that tells them apart (`RepositoryValue.form`). Two
 * reads, and every repository node of the product is in one of them.
 */
export const REPOSITORY_FORMS: readonly string[] = ['code', 'product'];

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
export async function planUnits(graph: StageGraphReader, limits: StageLimits = DEFAULT_STAGE_LIMITS): Promise<StagePlan> {
  const reads = graphReadsOver(graph);
  const repositories = new Map<string, Fact>();
  for (const form of REPOSITORY_FORMS) {
    const read = { read: 'facts-with' as const, kind: 'repository' as const, field: 'form', value: form };
    for (const fact of factsOfRows(await reads.read(read), read)) repositories.set(fact.id, fact);
  }
  const ordered = [...repositories.values()].sort((left, right) => byCodePoint(repositoryNameOf(left), repositoryNameOf(right)) || byCodePoint(left.id, right.id));
  const units: StageUnitScope[] = [];
  for (const repository of ordered) {
    const name = repositoryNameOf(repository);
    const planned = await planScope(reads, { scopeId: repository.id, repository: name, depth: 0, limits });
    for (const unit of planned) {
      if (units.length >= MAX_PLAN_UNITS) break;
      units.push(unit);
    }
  }
  if (units.length === 0) {
    // No repository node stands in the graph: the snapshot stage found none, which is a run with nothing to fill
    // rather than a plan that failed. Its own coverage word says so (0027), so nobody reads it as "no producer".
    return { units: [], coverage: 'nothing-found' };
  }
  return { units: units.slice(0, MAX_PLAN_UNITS), coverage: 'planned' };
}

/** The name a repository fact stands under, as its own value carries it. */
function repositoryNameOf(fact: Fact): string {
  const value = (fact.value ?? {}) as { repository?: unknown };
  return typeof value.repository === 'string' ? value.repository : fact.provenance.repository.id;
}

/** One scope of the plan, as the recursion carries it. */
interface PlanScope {
  readonly scopeId: string;
  readonly repository: string;
  readonly path?: string;
  readonly depth: number;
  readonly limits: StageLimits;
}

/** One scope's units: the scope itself when it fits, its member places when it does not. */
async function planScope(reads: GraphReadContext, scope: PlanScope): Promise<readonly StageUnitScope[]> {
  const members = await memberCount(reads, scope.scopeId);
  const estimate = estimateOfMembers(members);
  const place = placeText(scope.repository, scope.path);
  if (estimate <= plannedTokens(scope.limits) || scope.depth >= MAX_PLAN_DEPTH) {
    return [{ id: scope.scopeId, scope: place, estimatedTokens: estimate }];
  }
  const places = await placeMembers(reads, scope.scopeId);
  if (places === null) {
    // The member list was cut by the answer's cap: this scope cannot be enumerated here, so it stands as one unit
    // and the run's own split bounds decide what happens to it. Nothing is dropped silently: that unit's coverage
    // names what it did not read.
    return [{ id: scope.scopeId, scope: place, estimatedTokens: estimate }];
  }
  const units: StageUnitScope[] = [];
  for (const member of places) {
    const inner = await planScope(reads, { scopeId: member.id, repository: scope.repository, path: member.path, depth: scope.depth + 1, limits: scope.limits });
    for (const unit of inner) {
      if (units.length >= MAX_PLAN_UNITS) break;
      units.push(unit);
    }
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
// One attempt: the packet, the session, the limits, and what the unit hands over
// ---------------------------------------------------------------------------------------------

/** What the unit contract asks the agent to answer (`unitFixedPart`, `agent-packet.ts`). */
export interface UnitAnswer {
  /** `done` when the unit read its scope whole, `partial` when it left places out. */
  readonly status: 'done' | 'partial';
  /** The places of the scope the unit read to the end, as paths inside the repository. */
  readonly covered: readonly string[];
  /** The places it did not read. */
  readonly remaining: readonly string[];
  readonly summary?: string;
}

/**
 * The answer one turn's text holds, or `undefined` when it holds none: the agent is
 * asked for one JSON object and nothing else, and an agent that wraps it in prose is
 * read by the object's own shape rather than refused — the last balanced object that
 * names a status of the contract is the answer. A text with no such object is no
 * answer, and the unit is asked again (its own turn, inside the turn limit).
 */
export function readUnitAnswer(text: string): UnitAnswer | undefined {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) candidates.push(trimmed);
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = balancedEnd(text, start);
    if (end > start) candidates.push(text.slice(start, end + 1));
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidates[index]!);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const answer = parsed as Record<string, unknown>;
    const status = answer['status'];
    if (status !== 'done' && status !== 'partial') continue;
    return {
      status,
      covered: pathsOf(answer['covered']),
      remaining: pathsOf(answer['remaining']),
      ...(typeof answer['summary'] === 'string' ? { summary: answer['summary'] } : {}),
    };
  }
  return undefined;
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

/** The places an answer's own list names: text entries, as paths inside the repository. */
function pathsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/** The path inside the repository a place names: `<repository>:<path>` read as its path. */
export function pathOfPlace(text: string, repository: string): string {
  const prefix = `${repository}:`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/**
 * The places of one scope a unit covered, as the scope's own places name them. A
 * place is covered when the unit's answer names it or something inside it, or when
 * one of the unit's own writes cites bytes that stand at it or below it: a write's
 * cited place is the fact's provenance, which is the write path's own answer for
 * what it stands on, and the answer's own list is read against the scope, so a path
 * outside the scope covers nothing here whatever the agent says.
 *
 * The list is the coverage's `read`, so it holds places and not the paths the unit
 * happened to read: a folder a unit read one file of is a folder it read.
 */
export function coveredPlaces(options: {
  readonly answer: UnitAnswer | undefined;
  readonly writes: readonly StageDraftWrite[];
  readonly places: readonly string[];
  readonly repository: string;
}): readonly string[] {
  const cited = new Set<string>();
  for (const named of options.answer?.covered ?? []) {
    const path = pathOfPlace(named, options.repository);
    if (path !== '') cited.add(path);
  }
  for (const write of options.writes) {
    const place = (write.value as { provenance?: { place?: { file?: unknown } } }).provenance?.place?.file;
    if (typeof place === 'string' && place !== '') cited.add(place);
  }
  const paths = [...cited];
  return options.places.filter((place) => paths.some((path) => path === place || path.startsWith(`${place}/`))).sort(byCodePoint);
}

/** One coverage write: the fact that says what this unit read of its scope and what it did not. */
export function coverageWrite(options: {
  readonly repository: string;
  readonly commit: string;
  readonly scopeId: string;
  readonly scope: WriteScope;
  readonly source: FactSource;
  readonly complete: boolean;
  readonly read: readonly string[];
  readonly unread: readonly CoverageGap[];
}): StageDraftWrite {
  // The fact's own identity names its reader (`FACT_KINDS.coverage`), so the same unit reading the same scope
  // again is the same coverage fact, replaced rather than added beside the last one.
  const value: CoverageValue = {
    repository: options.repository,
    scope: options.scopeId,
    complete: options.complete,
    read: [...new Set(options.read)].sort(byCodePoint),
    unread: [...options.unread].sort((left, right) => byCodePoint(left.what, right.what) || byCodePoint(left.reason, right.reason)),
  };
  const fact = makeNodeFact({
    kind: 'coverage',
    value,
    provenance: { source: options.source, repository: { id: options.repository, commit: options.commit } },
    layer: 'inferred',
  });
  return { kind: 'fact', evidence: placeText(options.repository, options.scope.path) + `@${options.commit}`, value: fact };
}

/** What one attempt is wired with, once the stage has resolved it. */
interface AttemptWiring {
  readonly agent: AcpAgentSpec;
  readonly snapshots: SnapshotSource;
  readonly clock: () => number;
  readonly source: FactSource;
  readonly cwd?: string;
  readonly timeouts?: { readonly initializeMs?: number; readonly sessionMs?: number };
}

/** The commit the run pinned one repository at, as the run's own source answers it. */
async function pinnedCommit(snapshots: SnapshotSource, repository: string): Promise<string> {
  const pins = await snapshots.pins();
  const pin = pins.find((candidate) => candidate.id === repository);
  if (pin === undefined) {
    throw new Error(`src/fill/stages/agent-unit.ts:executeUnit: the run pinned no repository named ${JSON.stringify(repository)}: this unit's scope is read at the run's own pin, and the run's pins are ${pins.map((candidate) => candidate.id).join(', ') || 'none'}`);
  }
  // The reader resolves a pin that names a branch or a short id to the commit it stands at, which is the commit
  // a unit's evidence cites (`SnapshotReader.commit`).
  const reader = await snapshots.open(repository);
  return reader.commit;
}

/**
 * Runs one unit: its packet, its ACP session with the unit's own MCP server, its
 * limits, and then what it hands over — a draft when it finished, or its partial
 * draft with the coverage and the children its scope splits into.
 */
async function executeUnit(wiring: AttemptWiring, unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  const tools = context.tools;
  if (tools === undefined) {
    // A unit that runs an agent reads and writes only through its own MCP server (0026, "Agents and tools"): a run
    // that opened none would start an agent with no way to read, which is a wiring failure and not a small unit.
    throw new Error(`src/fill/stages/agent-unit.ts:executeUnit: the agent unit "${unit.id}" (${unit.scope}) was started with no MCP server: a stage whose units run an agent declares \`usesTools\`, and the run that opens units' tools wires them (src/fill/orchestrator-host.ts)`);
  }
  const limits = context.config.limits;
  const scope = writeScope(unit.scope);
  const commit = await pinnedCommit(wiring.snapshots, scope.repository);
  const packet = await buildUnitPacket({
    unit: { id: unit.id, scope: unit.scope },
    scopeId: unit.id,
    repository: scope.repository,
    ...(scope.path === undefined ? {} : { path: scope.path }),
    commit,
    graph: context.graph,
    limits,
    kinds: AGENT_UNIT_KINDS,
    task: AGENT_UNIT_TASK,
  });
  const guard = createUnitLimitGuard({ limits, clock: wiring.clock });
  guard.sent(estimateTokens(packet.prompt, DEFAULT_GRAPH_READ_LIMITS));
  context.progress(`the packet for ${unit.scope} is ${String(packet.tokens)} tokens in ${String(packet.sections.length)} sections`, 0);
  if (packet.marker !== null) context.progress(`the packet of ${unit.scope} was cut by 0026's ${String(PACKET_TOKENS)}-token cap: ${packet.marker}`);

  const connection: AcpConnection = await connectAcpAgent(wiring.agent, {
    cwd: wiring.cwd ?? process.cwd(),
    ...(wiring.timeouts?.initializeMs === undefined ? {} : { timeoutMs: wiring.timeouts.initializeMs }),
    ...(wiring.timeouts?.sessionMs === undefined ? {} : { sessionTimeoutMs: wiring.timeouts.sessionMs }),
  });
  let stopCause: UnitLimitCause | undefined;
  let aborted = false;
  let answer: UnitAnswer | undefined;
  let lastVerdict = guard.state();
  /** Whether the session has already shown the unit past 70%: the signal goes once, as its own turn. */
  let wrapPending = false;
  let wrapSent = false;
  try {
    await connection.initialize();
    const session: AcpSession = await connection.newSession({ cwd: wiring.cwd ?? process.cwd(), mcpServers: [tools.mcpServer] });
    const opened = session;
    // A run's cancellation revokes this attempt's authority (`orchestrator.authority`): the turn in flight is
    // cancelled through the protocol, and the unit ends rather than writing a draft the machine will refuse.
    const onAbort = (): void => { aborted = true; void opened.cancel().catch(() => undefined); };
    if (context.signal.aborted) aborted = true;
    else context.signal.addEventListener('abort', onAbort, { once: true });
    let prompt = packet.prompt;
    let turns = 0;
    try {
      for (;;) {
        turns += 1;
        const result: AcpPromptResult = await session.prompt(prompt, {
          onUpdate: (update: AcpUpdate) => {
            if (update.kind !== 'usage') return;
            const judged = guard.observe({
              ...(update.contextUsed === undefined ? {} : { contextUsed: update.contextUsed }),
              ...(update.contextSize === undefined ? {} : { contextSize: update.contextSize }),
              ...(update.cost === undefined || update.contextUsed === undefined ? {} : {}),
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
              void opened.cancel().catch(() => undefined);
            }
          },
        });
        if (stopCause !== undefined || aborted) break;
        const judged = guard.observe({
          turns,
          ...(result.usage?.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
        });
        lastVerdict = judged.state;
        if (judged.kind === 'stop') { stopCause = judged.cause; break; }
        const read = readUnitAnswer(result.text);
        if (read !== undefined) { answer = read; break; }
        if ((judged.kind === 'wrap' || wrapPending || guard.warned()) && !wrapSent) {
          // Once, and as a turn of its own: the unit is told what it spent and that this is its last chance to put
          // what it has into the graph. A later turn without an answer is a nudge, not a second warning.
          wrapSent = true;
          context.progress(`the unit is told to wrap up: ${guard.describe(judged.kind === 'wrap' ? judged : { kind: 'within', state: guard.state() })}`, 0.7);
          prompt = guard.wrapUpMessage();
          continue;
        }
        // No answer and no limit: the unit is asked again, with the places its scope holds so its answer can name
        // them. This is a turn of its own, and the turn limit bounds it like any other.
        prompt = nudgeMessage(unit, packet.members);
      }
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }
  } finally {
    await connection.close();
  }

  const places = placesOfMembers(packet.members);
  const writes = context.draft.writes().writes;
  const covered = coveredPlaces({ answer, writes: [...writes], places, repository: scope.repository });
  const remaining = places.filter((place) => !covered.includes(place));
  const complete = remaining.length === 0;
  if (stopCause !== undefined) {
    // One line a watching person reads: which limit the unit stopped at, and what it had spent when it did.
    context.progress(`${unit.id} stopped: ${guard.describe({ kind: 'stop', cause: stopCause, state: guard.state() })}`, undefined);
    void lastVerdict;
  }
  if (aborted) {
    // A cancelled run: the machine has already moved this generation (`cancelRun`), so the stage hands back a
    // block whose words say what happened; the machine refuses it by name and the attempt reports that refusal.
    return { outcome: 'blocked', reason: 'cancelled: the run or the unit was cancelled while this attempt ran' };
  }

  // The coverage every unit leaves behind: what it read and what it did not, never a silent gap.
  context.draft.write(coverageWrite({
    repository: scope.repository,
    commit,
    scopeId: unit.id,
    scope,
    source: wiring.source,
    complete,
    read: covered,
    unread: remaining.map((what) => ({ what, reason: 'budget' as const })),
  }));

  if (complete) {
    // Every place of the scope is covered: this unit's set is its draft, published in one transaction (0027).
    context.progress(`${unit.scope} covered ${String(covered.length)} of ${String(places.length)} places`, 1);
    return { outcome: 'draft' };
  }
  const children = splitChildren({ scope, members: packet.members, remaining });
  if (children.length === 0) {
    // Nothing of the scope is left that could be a unit's own scope (a file's symbols are no place): the draft goes
    // as it stands, and its coverage says what was not read. A smaller scope is never claimed as a whole one.
    return { outcome: 'draft' };
  }
  context.progress(`${unit.scope} covered ${String(covered.length)} of ${String(places.length)} places; ${String(children.length)} ${children.length === 1 ? 'child is' : 'children are'} planned for the rest`, 0);
  return { outcome: 'split', children };
}

/** The places one packet's member list names, in code point order, each once: what the unit's coverage is counted over. */
export function placesOfMembers(members: readonly UnitMember[]): readonly string[] {
  const places = new Set<string>();
  for (const member of members) if (member.file !== undefined && member.file !== '') places.add(member.file);
  return [...places].sort(byCodePoint);
}

/**
 * The children a stopped unit's scope splits into: one child unit per place the unit
 * did not cover, in code point order, at most `SPLIT_CHILDREN`. A place that is no
 * file or folder of the scope (a symbol's own place is its file, which is covered or
 * not already) names no child. The places the bound leaves out are not dropped: the
 * unit's coverage names each of them as a `budget` gap, so the graph says what no
 * unit read.
 */
export function splitChildren(options: { readonly scope: WriteScope; readonly members: readonly UnitMember[]; readonly remaining: readonly string[] }): readonly StageUnitScope[] {
  const children: StageUnitScope[] = [];
  const seen = new Set<string>();
  // The member that stands at each remaining place: a child's id is that member's own fact id, so a child planned
  // twice for one place is one child. A place the member list does not hold has no id to name it by, and a child
  // whose id named nothing would be a unit of no node: it stays a coverage gap.
  const byPath = new Map<string, UnitMember>();
  for (const member of options.members) {
    if (member.file === undefined) continue;
    const held = byPath.get(member.file);
    if (held === undefined || (held.kind !== 'directory' && held.kind !== 'file' && (member.kind === 'directory' || member.kind === 'file'))) byPath.set(member.file, member);
  }
  for (const path of options.remaining) {
    if (children.length >= SPLIT_CHILDREN) break;
    const member = byPath.get(path);
    if (member === undefined || seen.has(member.id)) continue;
    seen.add(member.id);
    children.push({
      id: member.id,
      scope: placeText(options.scope.repository, path),
      // One place is about one member's work (0026's ~200-line span), which is what the run's own split bound counts.
      estimatedTokens: estimateOfMembers(1),
    });
  }
  return children;
}

/** The turn that asks a unit without an answer for one, naming the places its scope holds. */
function nudgeMessage(unit: StageUnit, members: readonly UnitMember[]): string {
  const places = placesOfMembers(members).slice(0, MAX_NUDGE_PLACES);
  const cut = placesOfMembers(members).length - places.length;
  return [
    'That was not the answer this unit contract asks for. Answer now with exactly one JSON object:',
    '{"status":"done"|"partial","covered":["<place>"],"remaining":["<place>"],"summary":"<one sentence>"}',
    places.length === 0 ? `The scope ${unit.scope} names no place of its own.` : `The places of ${unit.scope} are: ${places.join(', ')}${cut > 0 ? ` (and ${String(cut)} more, cut from this message)` : ''}.`,
    '`covered` names the places you read to the end; `remaining` names those you did not. Write what you established with the tools before you answer.',
  ].join(' ');
}

/** How many places one nudge names: a message the unit reads at 70% of its window is no second packet. */
export const MAX_NUDGE_PLACES = 40;

// ---------------------------------------------------------------------------------------------
// The draft's own reading: what a unit wrote is a fact of a kind the stage declares
// ---------------------------------------------------------------------------------------------

/**
 * Judges one unit's draft before it is published: every write is a fact of an agent
 * unit's kinds, and the schema reads it. Every error names the write's place in the
 * draft, what it cites and the fact's own path and place, so a refusal is one line a
 * reader can act on. A write of one of the four kinds the tools make (`fact`,
 * `entity`, `link`, `question`) carries its fact in `value` (0026, "Writing"), so one
 * rule reads all four.
 */
export function validateDraft(draft: StageDraftSet): StageValidation {
  const errors: string[] = [];
  draft.writes.forEach((write: StageDraftWrite, index: number) => {
    const at = `write ${String(index + 1)} (${write.evidence})`;
    if (!['fact', 'entity', 'link', 'question'].includes(write.kind)) {
      errors.push(`${at}: the agent unit's tools write facts, entities, links and questions, and a ${JSON.stringify(write.kind)} write is none of them`);
      return;
    }
    const problems = checkFact(write.value);
    const kind = write.value !== null && typeof write.value === 'object' ? (write.value as { kind?: unknown }).kind : undefined;
    if (typeof kind === 'string' && !AGENT_UNIT_KINDS.includes(kind)) {
      errors.push(`${at}: an agent unit does not write a ${JSON.stringify(kind)} fact: it writes ${AGENT_UNIT_KINDS.join(', ')}`);
    }
    if (kind === undefined) errors.push(`${at}: the write names no kind: every write carries its whole fact, kind and id included`);
    for (const problem of problems) {
      const from = problem.path === '' ? '' : `${problem.path}: `;
      const where = problem.file === undefined ? '' : `${problem.file}:${String(problem.line ?? 1)} `;
      errors.push(`${at}: ${where}${from}${problem.message}`);
    }
  });
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
