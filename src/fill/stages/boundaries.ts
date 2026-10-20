/**
 * Stage 9 of the fill, the module-boundary refinement (decision 0026, "9
 * module-boundary refinement"; madarch-tzte.24.2), on the agent-stage shape of
 * `src/fill/stages/agent-stage.ts`.
 *
 * **One unit per repository, and per top-level module when a repository does not
 * fit.** The modules stage (stage 5, madarch-tzte.21.7) is what this stage reads,
 * so a unit covers one repository's clustering — the module tree a reader of that
 * repository would refine together, because a boundary change to one module is a
 * change to the tree it stands in. The plan names one unit per repository that
 * holds modules (estimated at the members stage 5 counted, 0026's own measure);
 * a repository whose estimate is past 0026's planned size is planned at the
 * level below, one unit per top-level module, whose scope is the folder the
 * module's own files stand in — 0026's hierarchy "repository → package/build
 * target → cluster", and the seeds the clustering itself grew from. A repository
 * past the plan's unit bound stands as one unit, as every scope the bound
 * cannot enumerate does. A unit that cannot finish splits into its places, which
 * are the modules of its scope; a child covers one module's folder, and so
 * splits no further than its own sub-clusters.
 *
 * **What it reads.** The clustering and nothing else as its own sections — the
 * scope's modules with the members stage 5 counted and the importance its
 * PageRank gave them, and the `contains` tree that holds the clustering together
 * (which files stand in which module, and which modules nest in which). That is
 * 0026's "Agent input" for this stage: the packet names the modules, their
 * members and the tree's edges, and the unit reads further through its tools
 * (`evidence_span` for the code a boundary follows). No `dependency` edge joins
 * two modules today (madarch-tzte.21.7 left the rollup out), so the tree is the
 * edges there are, and a boundary the imports would move is the unit's to read
 * out of the files the packet names.
 *
 * **What it writes.** Proposed modules — `module` facts at 0005's `inferred`
 * layer, always `proposed`, each carrying the `proposal` the schema gives stage
 * 9 (madarch-tzte.24.2): the change asked for (`merge`, `split` or `rename`) and
 * the modules of the clustering it would replace — and questions, where the
 * clustering does not say enough for a boundary to be proposed at all. The
 * proposal never rewrites the modules it replaces: they stand beside it until a
 * person decides (0005: an acceptance is a record beside the facts), so nothing
 * this stage writes is accepted by anything automatically. The level of its
 * statements is `meaning` (self-filling's outcome 4: "meaning (only assumed)"):
 * a boundary is an assumption read out of the code, never a fact.
 */
import { byCodePoint } from '../../model/order.js';
import {
  estimateOfMembers,
  plannedTokens,
  type AgentPacketSection,
  type AgentSectionRequest,
} from '../agent-packet.js';
import {
  factsOfRows,
  graphReadsOver,
  type GraphReadContext,
} from '../graph-reads.js';
import type { Fact } from '../facts.js';
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
export const BOUNDARIES_STAGE_ID = 'boundaries';

/** The stage's own version, bumped when what it plans, runs or writes changes. */
export const BOUNDARIES_STAGE_VERSION = 1;

/**
 * The fact kinds a unit of this stage may write: the boundary change is a
 * proposed module (the schema gives the `module` kind to stage 9 beside stage 5,
 * `src/fill/facts.ts`), and a question where the clustering does not say enough.
 * The coverage every unit leaves behind is the shape's own
 * (`src/fill/stages/agent-stage.ts`).
 */
export const BOUNDARIES_KINDS: readonly string[] = ['module', 'question'];

/** The most modules one packet's `clustering` section holds, its cut named like every section's. */
export const BOUNDARIES_MODULE_ROWS = 60;

/** The most rows the `moduleMembers` section holds: the tree the clustering holds, bounded and its cut named. */
export const BOUNDARIES_MEMBER_ROWS = 200;

/**
 * One module of the scope's clustering, as this stage reads it: the fact, its
 * own files, and the folder they stand in. The row is assembled as the reads
 * answer (`files` and `folder` are filled by the `contains` tree), so they are
 * not read-only here; a caller outside this module sees the finished rows.
 */
interface ModuleRow {
  /** The module fact itself. */
  readonly fact: Fact;
  /** The module's name inside its parent, as `ModuleValue.name` carries it. */
  readonly name: string;
  /** The parent module's fact id, when the module nests in one. */
  readonly parent?: string;
  /** The modules whose `parent` names this one, by their own ids. */
  children: string[];
  /** The files the module itself holds (its children hold their own), by id and path, in code point order. */
  files: { id: string; path: string }[];
  /** The common folder of the module's own files: `""` when the files name no folder or the module holds none. */
  folder: string;
}

/** The importance stage 5's PageRank gave a module, `0` where it gave none. */
function importanceOf(fact: Fact): number {
  const importance = (fact.value as { importance?: unknown }).importance;
  return typeof importance === 'number' && Number.isFinite(importance) ? importance : 0;
}

/** The members stage 5 counted for a module, `undefined` where it wrote none. */
function membersOf(fact: Fact): number | undefined {
  const members = (fact.value as { members?: unknown }).members;
  return typeof members === 'number' && Number.isInteger(members) && members >= 0 ? members : undefined;
}

/** The common folder of file paths, at a `/` leg: the folder a module's own files stand in. */
function commonFolder(paths: readonly string[]): string {
  const folders = paths.map((path) => path.split('/').slice(0, -1));
  if (folders.length === 0) return '';
  let prefix = folders[0]!;
  for (const legs of folders.slice(1)) {
    let at = 0;
    while (at < prefix.length && at < legs.length && prefix[at] === legs[at]) at += 1;
    prefix = prefix.slice(0, at);
    if (prefix.length === 0) return '';
  }
  return prefix.join('/');
}

/** Whether the path stands inside the scope's folder, when the scope names one. */
function underScope(scope: WriteScope, path: string): boolean {
  return scope.path === undefined || path === scope.path || path.startsWith(`${scope.path}/`);
}

/**
 * The clustering of one scope: every module of the repository whose own files
 * stand in the scope's folder — the whole repository when the scope names none —
 * with the files each holds (the `contains` tree stage 5 wrote, one read per
 * module) and the folder each stands at. A module that holds no file of its own
 * (a grouping level) is in the scope when one of the modules it nests is, which
 * the tree decides bottom-up; the order of the answer is the packet's own — most
 * important first, then name, then id, never the order a read answered.
 */
async function clusteringOf(reads: GraphReadContext, scope: WriteScope): Promise<readonly ModuleRow[]> {
  const read = { read: 'facts-with' as const, kind: 'module' as const, field: 'repository', value: scope.repository };
  const facts = factsOfRows(await reads.read(read), read);
  const rows = new Map<string, ModuleRow>();
  for (const fact of facts) {
    const value = fact.value as { name?: unknown; parent?: unknown };
    rows.set(fact.id, {
      fact,
      name: String(value.name ?? ''),
      ...(typeof value.parent === 'string' ? { parent: value.parent } : {}),
      children: [],
      files: [],
      folder: '',
    });
  }
  for (const row of rows.values()) {
    if (row.parent !== undefined && rows.has(row.parent)) rows.get(row.parent)!.children.push(row.fact.id);
  }
  // The files of the scope's repository, by id: what a `contains` edge names and
  // what a module's folder is read from. One read of the repository, whatever
  // the scope, so the tree below is one recording and not one per module.
  const filesRead = { read: 'facts-with' as const, kind: 'file' as const, field: 'repository', value: scope.repository };
  const paths = new Map<string, string>();
  for (const fact of factsOfRows(await reads.read(filesRead), filesRead)) {
    const path = (fact.value as { path?: unknown }).path;
    if (typeof path === 'string' && path !== '') paths.set(fact.id, path);
  }
  // The `contains` tree, one read per module (the grammar filters by one value
  // field exactly): the module's own files. Each read is recorded as the unit's
  // dependency, like every read a packet section makes.
  for (const row of rows.values()) {
    const containsRead = { read: 'facts-with' as const, kind: 'contains' as const, field: 'from', value: row.fact.id };
    const edges = factsOfRows(await reads.read(containsRead), containsRead);
    const files: { id: string; path: string }[] = [];
    for (const edge of edges) {
      const to = (edge.value as { to?: unknown }).to;
      if (typeof to !== 'string') continue;
      const path = paths.get(to);
      if (path !== undefined) files.push({ id: to, path });
    }
    files.sort((left, right) => byCodePoint(left.path, right.path) || byCodePoint(left.id, right.id));
    row.files = files;
    row.folder = commonFolder(files.map((file) => file.path));
  }
  // In the scope, or not: a module whose own files all stand in the scope's
  // folder is; one that holds no file of its own follows its children; and the
  // whole clustering is in a scope that names no folder. A child is decided
  // after its own children, so a parent follows the tree and not the order the
  // read answered; a module whose parent names nothing the read answered stands
  // on its own files.
  const inScope = new Map<string, boolean>();
  const decide = (id: string, seen: ReadonlySet<string>): boolean => {
    if (inScope.has(id)) return inScope.get(id)!;
    const row = rows.get(id);
    if (row === undefined || seen.has(id)) return false;
    if (scope.path === undefined) {
      inScope.set(id, true);
      return true;
    }
    const childSeen = new Set([...seen, id]);
    const childIn = row.children.some((child) => decide(child, childSeen));
    const value = row.files.length > 0
      ? row.files.every((file) => underScope(scope, file.path))
      : childIn;
    inScope.set(id, value);
    return value;
  };
  for (const id of rows.keys()) decide(id, new Set());
  return [...rows.values()]
    .filter((row) => inScope.get(row.fact.id) === true)
    .sort((left, right) => importanceOf(right.fact) - importanceOf(left.fact)
      || byCodePoint(left.name, right.name)
      || byCodePoint(left.fact.id, right.fact.id));
}

/**
 * The sections this stage adds to the shape's packet: the clustering of the
 * unit's scope — its modules, and the tree that holds them together. Every one
 * is a read of the graph through the unit's own reader, so each is a recorded
 * dependency; each is bounded with its cut named in the packet's own marker.
 * Every unit of this stage has a scope node (the plan names no product unit),
 * so no section carries a `when`.
 */
export function boundariesSections(): readonly AgentPacketSection[] {
  // One unit's packet reads its clustering once: both sections answer from the
  // same rows, so the unit's recorded reads are one tree and not two (the packet
  // hands every section the same request, whose reader is the unit's own).
  const perUnit = new WeakMap<AgentSectionRequest, Promise<readonly ModuleRow[]>>();
  const clusteringOnce = (request: AgentSectionRequest): Promise<readonly ModuleRow[]> => {
    const held = perUnit.get(request);
    if (held !== undefined) return held;
    const read = clusteringOf(request.reads, request.scope);
    perUnit.set(request, read);
    return read;
  };
  return [
    {
      name: 'clustering',
      what: "the modules of the scope, with the members stage 5 counted and the importance its PageRank gave them",
      max: BOUNDARIES_MODULE_ROWS,
      rows: async (request: AgentSectionRequest) => (await clusteringOnce(request))
        .map((row) => {
          const members = membersOf(row.fact);
          return {
            id: row.fact.id,
            name: row.name,
            ...(row.parent === undefined ? {} : { parent: row.parent }),
            seed: String((row.fact.value as { seed?: unknown }).seed ?? ''),
            ...(members === undefined ? {} : { members }),
            ...(row.folder === '' ? {} : { folder: row.folder }),
            importance: importanceOf(row.fact),
          };
        }),
    },
    {
      name: 'moduleMembers',
      what: "the files and nested modules each module of the scope holds (the clustering's own tree)",
      max: BOUNDARIES_MEMBER_ROWS,
      rows: async (request: AgentSectionRequest) => {
        const rows = await clusteringOnce(request);
        const tree: { module: string; member: string; kind: 'file' | 'module'; path?: string }[] = [];
        for (const row of rows) {
          for (const file of row.files) tree.push({ module: row.fact.id, member: file.id, kind: 'file', path: file.path });
          for (const child of row.children) {
            const nested = rows.find((candidate) => candidate.fact.id === child);
            tree.push({ module: row.fact.id, member: child, kind: 'module', ...(nested === undefined || nested.folder === '' ? {} : { path: nested.folder }) });
          }
        }
        // The tree is ordered by the module that holds each row (its fact id, the
        // id the packet's own `clustering` rows carry), then files before modules,
        // then the path, then the member's id — never the order a read answered.
        return tree.sort((left, right) => byCodePoint(left.module, right.module)
          || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0)
          || byCodePoint(left.path ?? '', right.path ?? '')
          || byCodePoint(left.member, right.member));
      },
    },
  ];
}

/**
 * The answer stage 9's units give: how far the unit read its clustering, the
 * module folders it covered and those it did not, and one sentence on the
 * boundaries it proposed. The proposals themselves are the unit's writes,
 * checked one at a time by the unit's own server (0026, "Writing"), never a
 * list in the answer.
 */
const BOUNDARIES_ANSWER = {
  shape: '{"status":"done"|"partial","covered":["<a folder of your scope>"],"remaining":["<a folder of your scope>"],"summary":"<one sentence on the boundaries you proposed>"}',
  reading: [
    '`covered` names every folder of your scope whose modules you read to the end — the files the packet\'s tree points at, through the spans `evidence_span` gives you; `remaining` names the folders you did not read. A place is the folder a module\'s own files stand at. A `done` answer whose `remaining` is not empty is read as `partial`, and the folders you leave out are planned as units of their own.',
  ],
  example: '{"status":"done","covered":["packages/checkout","packages/payments"],"remaining":[],"summary":"checkout and payments are one boundary: proposed as a merge, cited to the imports that tie them"}',
  fields: [
    { name: 'status', type: 'status' as const, required: true },
    { name: 'covered', type: 'places' as const, required: true },
    { name: 'remaining', type: 'places' as const, required: true },
    { name: 'summary', type: 'text' as const },
  ],
};

/**
 * Stage 9's declaration: the clustering a unit reads, its fixed part, the
 * sections its packet reads, and what it may write.
 */
export function boundariesDeclaration(): AgentStageDeclaration {
  return {
    id: BOUNDARIES_STAGE_ID,
    version: BOUNDARIES_STAGE_VERSION,
    // 0026's stage 9: the refinement of the boundaries stage 5 clustered, an assumption the code's own reading supports.
    factStage: '9-boundaries',
    level: 'meaning',
    scale: { level: 'repository', child: 'package' },
    role: 'You are one unit of madarch\'s fill that proposes how a repository\'s module boundaries should change: you read the clustering the modules stage built and write the merges, splits and renames the code\'s own reading asks for, each as a proposed module.',
    rules: [
      'Read the clustering first: the packet\'s `clustering` names every module of your scope with the members stage 5 counted and the importance its PageRank gave them, and `moduleMembers` names the files and nested modules each one holds. Read further with the tools; a module you were not shown is a boundary you did not read.',
      'A proposal is a `module` fact of your own writing: it carries `proposal.change` — `merge` when two or more modules should be one, `split` when one should be several, `rename` when one is named wrong — and `proposal.replaces`, the ids of the modules it would replace, in code point order. The module you write stands beside them: its `name` is the name the new boundary should carry inside its `parent`, its `seed` is `cluster`, and its `members` is the count the merged or split files give it.',
      'Every proposal cites the bytes that ground it: the files whose imports, calls or names tie the modules together or cut them apart, read through `evidence_span`. A boundary no cited byte supports is a guess, and a guess is a question, not a proposal.',
      'You propose; nobody accepts. Never write over the modules the clustering holds — they stand beside your proposals until a person decides — and never propose a change to a module outside your scope: a proposal that names a module your scope does not hold is refused when you make it.',
      'Where the clustering does not say enough — two modules whose tie is unclear, a boundary the tree contradicts — raise a question instead of proposing, and say what reading would settle it.',
      'Nothing outside the clustering and the tools supports a boundary: a tool answer that was cut says so, and the packet\'s own `marker` names every list it cut — read the rest with the tools rather than proposing about modules you were not shown.',
    ],
    task: 'Propose the boundary changes your scope\'s clustering asks for — merges, splits and renames of its modules — every proposal a module fact that cites the bytes it stands on, and accepted by nobody until a person says so.',
    answer: BOUNDARIES_ANSWER,
    kinds: BOUNDARIES_KINDS,
    consumes: {
      required: [
        // The scope the unit stands at: the repository the snapshot stage published.
        { capability: 'repository', scope: 'repository', freshness: 'current' },
        // The clustering this stage reads (stage 5, madarch-tzte.21.7). Without a producer of it there is no boundary
        // to refine, which is a starvation the plan names, never a silent run over an empty packet.
        { capability: 'module', scope: 'repository', freshness: 'current' },
      ],
      // The tree that holds the clustering together: the inventory\'s files and stage 5\'s containment. No consume
      // names a kind an agent stage writes: this stage\'s own proposals are what it produces, and a declared one
      // would order it after the stages that produce them (madarch-tzte.26.1\'s cycle was exactly that).
      optional: [
        // The tree's paths are read one repository whole (one read of the files the
        // repository holds), which is the breadth the consume names, as stage 5's
        // own declaration names the same read.
        { capability: 'file', scope: 'repository', freshness: 'current' },
        { capability: 'contains', scope: 'repository', freshness: 'any' },
      ],
    },
    sections: boundariesSections(),
    plan: (graph) => planBoundaryUnits(graph),
    places: (context) => boundaryPlaces(context),
  };
}

/**
 * The stage's plan: one unit per repository that holds modules — the
 * repository's clustering — estimated at the members stage 5 counted against
 * 0026's default window; a repository past the planned size is planned one unit
 * per top-level module, whose scope is the folder the module's own files stand
 * in, and a repository past the plan's unit bound stands as one unit rather than
 * a shorter list, as every scope the bound cannot enumerate does. A product the
 * graph holds no modules of is nothing found rather than a plan that failed: the
 * modules stage clustered none, and its own coverage says so (0027).
 */
export async function planBoundaryUnits(graph: StageGraphReader): Promise<StagePlan> {
  const reads = graphReadsOver(graph);
  const repositories = await repositoriesOf(reads);
  const units: { id: string; scope: string; estimatedTokens: number }[] = [];
  // One budget for the whole plan, the shape's own: a scope that would take it past `MAX_PLAN_UNITS` stands as one
  // unit instead of being enumerated, so the bound costs a split at run time and never a scope no unit names.
  let left = MAX_PLAN_UNITS;
  for (const repository of repositories) {
    const name = repositoryNameOf(repository);
    const clustering = await clusteringOf(reads, writeScope(name));
    const tops = clustering.filter((row) => row.parent === undefined);
    if (tops.length === 0) continue;
    // A top-level module's members count is its subtree's (madarch-tzte.21.7), so
    // the sum is the whole tree of files and symbols the repository's clustering
    // holds — the reading one unit of this stage does, in 0026's own measure.
    const members = tops.reduce((total, row) => total + (membersOf(row.fact) ?? row.files.length), 0);
    const estimate = estimateOfMembers(members);
    if (estimate <= plannedTokens(DEFAULT_STAGE_LIMITS)) {
      left -= 1;
      units.push({ id: repository.id, scope: name, estimatedTokens: estimate });
      continue;
    }
    // One level of the plan's recursion, the shape's own accounting (`planScope`): enumerate the top-level modules
    // in code point order of the folders they stand at, and when the bound cut the enumeration short, undo it and
    // stand the whole repository as one unit — so the plan names at least one unit for every scope it read and
    // drops none, and a later repository still holds the budget the undone enumeration did not spend.
    const before = left;
    const parts: typeof units = [];
    for (const top of [...tops].sort((leftRow, rightRow) => byCodePoint(leftRow.folder, rightRow.folder) || byCodePoint(leftRow.fact.id, rightRow.fact.id))) {
      if (left < 1) break;
      left -= 1;
      const scope = top.folder === '' ? name : `${name}:${top.folder}`;
      parts.push({ id: top.fact.id, scope, estimatedTokens: estimateOfMembers(membersOf(top.fact) ?? top.files.length) });
    }
    if (parts.length < tops.length) {
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
 * What one unit of this stage covers: the modules of its scope at the level
 * below it — a repository unit's places are its top-level modules, a module
 * unit's are the modules nested directly in its own — and a module with none of
 * its own stands as its one place, which no child of it covers (a child whose
 * scope is its parent's would be the same unit again). A place is the folder the
 * module's own files stand at: a module whose files name no folder is no place —
 * its scope would be the unit's own, which is no child of it, and the shape's
 * own rule for what a place is ("a file's symbols are no place") keeps it in the
 * unit's own scope, read through the packet's clustering like every other module
 * of it. A place's estimated reading is the members stage 5 counted for the
 * module, 0026's own measure.
 */
export async function boundaryPlaces(context: AgentUnitContext): Promise<AgentPlaceSet> {
  const scope = writeScope(context.unit.scope);
  const reads = graphReadsOver(context.graph);
  const clustering = await clusteringOf(reads, scope);
  const commit = 'product' in context.packet.place ? '' : context.packet.place.commit;
  const own = clustering.find((row) => row.fact.id === context.unit.id);
  const level = own === undefined
    ? clustering.filter((row) => row.parent === undefined)
    : clustering.filter((row) => row.parent === own.fact.id);
  const rows = level.length === 0 && own !== undefined ? [own] : level;
  const places = rows.filter((row) => row.folder !== '').map((row) => ({
    id: row.fact.id,
    place: row.folder,
    scope: `${scope.repository}:${row.folder}`,
    repository: scope.repository,
    commit,
    estimatedTokens: estimateOfMembers(membersOf(row.fact) ?? row.files.length),
  })).sort((left, right) => byCodePoint(left.place, right.place) || byCodePoint(left.id, right.id));
  // The modules are read as facts of the graph, which the store answers whole,
  // and a `contains` read answers a module's own files whole: the list is no
  // sample, so nothing of this scope was left unenumerated.
  return { places, cut: false };
}

/**
 * Stage 9, registered over the run's wiring: one unit per repository's
 * clustering, whose packet is the module tree of its scope.
 */
export function createBoundariesStage(wiring: AgentStageWiring): FillStage {
  return createAgentStage(boundariesDeclaration(), wiring);
}
