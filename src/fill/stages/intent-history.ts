/**
 * Stage 11 of the fill, the intent the comments and commits state (decision 0026,
 * "Stages": "11 intent from comments and commits"; madarch-tzte.24.4), on the
 * agent-stage shape of `src/fill/stages/agent-stage.ts`.
 *
 * **One unit per module.** The intent of a product lives where its own words live:
 * the comments its code carries and the commits its history records. Stage 5's
 * clustering already divided the code into modules, and intent is read where the
 * code is, so the plan names one unit per module fact (`planIntentUnits`), at
 * 0026's cluster level. A module whose estimate is past 0026's planned size is
 * planned as its member files, one level down — the estimate is the count stage 5
 * itself wrote into the module fact (`ModuleValue.members`), or the graph's own
 * held count where the fact carries none — and a file never plans deeper: it
 * stands as one unit and splits at run time, never a shorter plan. The one bound
 * the plan shares with the shape is `MAX_PLAN_UNITS`. A module unit's scope text
 * is its repository (a module is a cluster of files and no one path of them), so
 * its checked writes cite bytes anywhere in that repository; the places it covers,
 * and the children a split names, are its own member files (`memberPlaces`, the
 * shape's own reader).
 *
 * **What it reads.** The graph the deterministic stages built, and nothing else:
 * the `comment` facts stage 3 published standing in the module's files, and the
 * `commit` facts and `task-key` edges stage 7 published for the repository — the
 * commits whose changed files the module's files hold, each with the task keys its
 * message names. Both are the stage's own packet sections (`comments`, `commits`),
 * each a read of the graph recorded as the unit's dependency. A comment's *words*
 * are the file's bytes, and 0026 pastes no file content, so the section names
 * where each comment stands — its file, its line, its form — and the unit reads
 * the words with `evidence_span`, the one read that carries bytes. The comments
 * read is the stage's own SQL through the reader seam (`commentsRead`, over the
 * `fact` view `src/fill/stage-reads.ts` creates before a run), because a comment
 * carries no repository in its value: where it stands is its provenance, which the
 * JSON read grammar cannot filter by. The SQL names a repository the stage checks
 * against `ID_PATTERN` and file paths `repositoryPath` checked, never a value a
 * product did not write.
 *
 * **What it writes.** Claims and questions, at the `intent` level (self-filling's
 * outcome 4: what people recorded, as the comments and the commits state it) —
 * 0004's claim atom at 0005's `inferred` layer, always `proposed`. A claim's
 * predicate tells intent from rationale (`intent`, `why`), and every claim cites
 * the bytes its words stand in: a comment's file and lines, or a file the commit
 * changed. Behaviour the commits or the code show that no comment explains is not
 * a claim — it is a question of type `undocumented-behaviour` (the open-question
 * type self-filling's outcome 5 names), about the node whose behaviour it is.
 */
import { byCodePoint } from '../../model/order.js';
import { ID_PATTERN } from '../../model/schema.js';
import { estimateOfMembers, plannedTokens, MAX_TEXT_CODE_POINTS, type AgentPacketSection, type AgentSectionRequest } from '../agent-packet.js';
import {
  factsOfRows,
  graphReadsOver,
  type GraphReadContext,
} from '../graph-reads.js';
import { FACT_ID_PATTERN, repositoryPath, type CommentForm, type Fact } from '../facts.js';
import {
  DEFAULT_STAGE_LIMITS,
  type FillStage,
  type StageGraphReader,
  type StagePlan,
  type StageUnitScope,
} from '../stage.js';
import {
  createAgentStage,
  MAX_PLAN_UNITS,
  memberPlaces,
  placeMembers,
  repositoriesOf,
  repositoryNameOf,
  type AgentStageDeclaration,
  type AgentStageWiring,
} from './agent-stage.js';

/** The stage's id, as it is registered. */
export const INTENT_HISTORY_STAGE_ID = 'intent-history';

/** The stage's own version, bumped when what it plans, runs or writes changes. */
export const INTENT_HISTORY_STAGE_VERSION = 1;

/**
 * The fact kinds a unit of this stage may write: the intent a comment or commit
 * states is a claim, and what nobody documented is a question of its own type.
 * The coverage every unit leaves behind is the shape's own
 * (`src/fill/stages/agent-stage.ts`).
 */
export const INTENT_HISTORY_KINDS: readonly string[] = ['claim', 'question'];

/** The most comments one packet holds, each named by where it stands; the cut is named in the packet's marker. */
export const INTENT_HISTORY_COMMENT_ROWS = 60;

/** The most commits one packet holds, newest first; the cut is named in the packet's marker. */
export const INTENT_HISTORY_COMMIT_ROWS = 40;

/** The most of a commit's touched paths one row names; a commit that touched more is still one row, its list cut. */
export const INTENT_HISTORY_TOUCHED_ROWS = 20;

// ---------------------------------------------------------------------------------------------
// The stage's own reads: the comments and the task keys the JSON grammar cannot ask for
// ---------------------------------------------------------------------------------------------

/** The repository a read names, as the history stage reads its own: the product's own name, never a path or a URL. */
function repositoryName(repository: string): string {
  if (typeof repository !== 'string' || ID_PATTERN.test(repository) === false) {
    throw new Error(`intent-history: ${JSON.stringify(repository)} is no repository name: the product's own name for a repository, like "orders-api", never a path, a URL or a branch`);
  }
  return repository;
}

/** One text as the stage's own SQL holds it between quotes: its single quotes doubled, as the database reads them. */
function sqlText(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * The stage's own SQL for the comments standing in one repository's files, read
 * over the `fact` view (`STAGE_FACT_VIEW`, `src/fill/stage-reads.ts`): a
 * comment carries no repository in its value, so where it stands — the
 * provenance's repository and file — is what the read filters by. `files` are
 * the scope's own repository paths, each `repositoryPath` checked; `null` is a
 * scope whose file list nobody enumerated (a module whose member list the
 * answer's cap cut), which reads the repository's comments whole and filters in
 * code, never silently less.
 */
export function commentsRead(repository: string, files: readonly string[] | null): string {
  const name = repositoryName(repository);
  if (files === null) {
    return `SELECT id, provenance, value FROM fact WHERE kind = 'comment' AND provenance->'repository'->>'id' = '${sqlText(name)}'`;
  }
  const paths = files.map((file) => `'${sqlText(repositoryPath(file))}'`);
  return `SELECT id, provenance, value FROM fact WHERE kind = 'comment' AND provenance->'repository'->>'id' = '${sqlText(name)}' AND provenance->'place'->>'file' = ANY(ARRAY[${paths.join(', ')}])`;
}

/**
 * The stage's own SQL for the task keys of the commits one packet shows, read
 * over the same view: a task key names its commit in its value's `from`, and a
 * packet holds at most `INTENT_HISTORY_COMMIT_ROWS` commits, so the read names
 * exactly those. Every id is a fact id the graph answered, checked against the
 * schema's own pattern before it reaches the text.
 */
export function taskKeysRead(commitIds: readonly string[]): string {
  const ids = commitIds.map((id) => {
    if (typeof id !== 'string' || FACT_ID_PATTERN.test(id) === false) {
      throw new Error(`intent-history: ${JSON.stringify(id)} is no fact id: a task-key read names the commits the packet's own rows hold, each the schema's own fact id`);
    }
    return `'${sqlText(id)}'`;
  });
  return `SELECT id, value FROM fact WHERE kind = 'task-key' AND value->>'from' IN (${ids.join(', ')})`;
}

/** One comment as the stage's own read answers it: the fact id, where it stands, and the value's own form. */
interface CommentAt {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly form: CommentForm;
}

/** One task-key edge as the stage's own read answers it: the fact id, the commit it names, and the key as written. */
interface TaskKeyAt {
  readonly id: string;
  readonly from: string;
  readonly key: string;
}

/** The object a row's JSON column carries, or the refusal that names the row. */
function rowObject(row: unknown, what: string, at: string): Record<string, unknown> {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`intent-history: ${what} answered ${JSON.stringify(row)}, which is no record (${at})`);
  }
  return row as Record<string, unknown>;
}

/** The text one row's column carries, or the refusal that names the row. */
function rowText(value: unknown, what: string, at: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`intent-history: ${what} answered ${at} of ${JSON.stringify(value)}, which is no text`);
  return value;
}

/** The comment one row of the comments read holds, checked at every field the section shows. */
function commentOfRow(row: unknown): CommentAt {
  const at = 'a row of the comments read';
  const record = rowObject(row, 'the comments read', at);
  const id = rowText(record['id'], 'the comments read', `${at}'s id`);
  if (FACT_ID_PATTERN.test(id) === false) throw new Error(`intent-history: the comments read answered the id ${JSON.stringify(id)}, which is no fact id of the schema`);
  const provenance = rowObject(record['provenance'], 'the comments read', `${at} ${id}'s provenance`);
  const repository = rowObject(provenance['repository'], 'the comments read', `${at} ${id}'s provenance repository`);
  rowText(repository['id'], 'the comments read', `${at} ${id}'s repository`);
  const place = rowObject(provenance['place'], 'the comments read', `${at} ${id}'s provenance place`);
  const file = rowText(place['file'], 'the comments read', `${at} ${id}'s file`);
  const range = rowObject(place['range'], 'the comments read', `${at} ${id}'s provenance range`);
  const line = range['startLine'];
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    throw new Error(`intent-history: the comments read answered ${at} ${id} at the line ${JSON.stringify(line)}, which is no line of a file`);
  }
  const value = rowObject(record['value'], 'the comments read', `${at} ${id}'s value`);
  const form = rowText(value['form'], 'the comments read', `${at} ${id}'s form`) as CommentForm;
  return { id, file, line, form };
}

/** The task key one row of the task-key read holds, checked at every field the section shows. */
function taskKeyOfRow(row: unknown): TaskKeyAt {
  const at = 'a row of the task-key read';
  const record = rowObject(row, 'the task-key read', at);
  const id = rowText(record['id'], 'the task-key read', `${at}'s id`);
  if (FACT_ID_PATTERN.test(id) === false) throw new Error(`intent-history: the task-key read answered the id ${JSON.stringify(id)}, which is no fact id of the schema`);
  const value = rowObject(record['value'], 'the task-key read', `${at} ${id}'s value`);
  const from = rowText(value['from'], 'the task-key read', `${at} ${id}'s from`);
  if (FACT_ID_PATTERN.test(from) === false) throw new Error(`intent-history: the task-key read answered ${at} ${id} naming the commit ${JSON.stringify(from)}, which is no fact id`);
  const key = rowText(value['key'], 'the task-key read', `${at} ${id}'s key`);
  return { id, from, key };
}

// ---------------------------------------------------------------------------------------------
// The packet's own sections: where the intent lives
// ---------------------------------------------------------------------------------------------

/** Whether one file stands inside one of the scope's paths: the path itself, or below it when the path is a folder. */
function inside(file: string, paths: readonly string[]): boolean {
  return paths.some((path) => file === path || file.startsWith(`${path}/`));
}

/**
 * The repository paths a section reads its comments and commits in: the scope's
 * own path when the unit covers one (a file or a folder a split named), or the
 * module's member files when the unit covers a whole module. `null` is a module
 * whose member list the read's own cap cut: the section then reads the
 * repository whole and filters in code, never silently less, and the packet's
 * own marker names the cut that caused it.
 */
async function scopeFiles(request: AgentSectionRequest): Promise<readonly string[] | null> {
  if (request.scope.path !== undefined) return [request.scope.path];
  const members = await placeMembers(request.reads, request.unit.id);
  if (members === null) return null;
  return members.filter((member) => member.kind === 'file' || member.kind === 'directory').map((member) => member.path);
}

/** One text as the packet keeps it: its first line, at most `MAX_TEXT_CODE_POINTS` code points, cut with an ellipsis. */
function shortText(text: string): string {
  const line = text.split('\n')[0] ?? '';
  const points = [...line];
  return points.length <= MAX_TEXT_CODE_POINTS ? line : `${points.slice(0, MAX_TEXT_CODE_POINTS - 1).join('')}…`;
}

/**
 * The sections this stage adds to the shape's packet: where the comments of the
 * scope's files stand, and the commits that touched them with the task keys
 * their messages name. Each is a read of the graph through the unit's own
 * reader — the comments through the stage's own SQL (`commentsRead`, recorded
 * like every other read), the commits and their keys through the JSON grammar
 * and the task-key read (`taskKeysRead`) — and each is bounded with its cut
 * named in the packet's own marker.
 */
export function intentHistorySections(): readonly AgentPacketSection[] {
  return [
    {
      name: 'comments',
      what: "the comments standing in this scope's files, each named by where it stands — read its words with `evidence_span`",
      max: INTENT_HISTORY_COMMENT_ROWS,
      rows: async (request) => {
        const files = await scopeFiles(request);
        // A scope whose file list is empty holds no comments of its own, and an empty SQL array is no question at
        // all: the section answers nothing rather than asking the store for it.
        if (files !== null && files.length === 0) return [];
        const rows = (await request.graph.query(commentsRead(request.scope.repository, files))).map(commentOfRow)
          .filter((comment) => files === null ? true : inside(comment.file, files))
          .sort((left, right) => byCodePoint(left.file, right.file) || left.line - right.line || byCodePoint(left.id, right.id));
        return rows.map((comment) => ({ id: comment.id, form: comment.form, file: comment.file, line: comment.line }));
      },
    },
    {
      name: 'commits',
      what: "the commits that touched this scope's files, newest first, with the task keys their messages name",
      max: INTENT_HISTORY_COMMIT_ROWS,
      rows: async (request) => {
        const files = await scopeFiles(request);
        const commitsRead = { read: 'facts-with' as const, kind: 'commit' as const, field: 'repository', value: request.scope.repository };
        // A commit's own time, never the clock (the shape's own `history` section reads the same kind the same way).
        const commits = factsOfRows(await request.reads.read(commitsRead), commitsRead)
          .filter((fact) => {
            const changed = (fact.value as { files?: readonly unknown[] }).files ?? [];
            return files === null ? changed.length > 0 : changed.some((file) => typeof file === 'string' && inside(file, files));
          })
          .sort((left, right) => byCodePoint(String((right.value as { committedAt?: unknown }).committedAt ?? ''), String((left.value as { committedAt?: unknown }).committedAt ?? '')) || byCodePoint(left.id, right.id))
          .slice(0, INTENT_HISTORY_COMMIT_ROWS);
        const keysOf = new Map<string, string[]>();
        if (commits.length > 0) {
          const keys = taskKeysRead(commits.map((fact) => fact.id));
          for (const key of (await request.graph.query(keys)).map(taskKeyOfRow)) {
            const held = keysOf.get(key.from) ?? [];
            held.push(key.key);
            keysOf.set(key.from, held);
          }
        }
        return commits.map((fact) => {
          const value = fact.value as { commit?: unknown; committedAt?: unknown; subject?: unknown; files?: readonly unknown[] };
          const touched = [...new Set((value.files ?? []).filter((file): file is string => typeof file === 'string' && (files === null ? true : inside(file, files))))].sort(byCodePoint);
          return {
            id: fact.id,
            commit: String(value.commit ?? ''),
            committedAt: String(value.committedAt ?? ''),
            subject: shortText(String(value.subject ?? '')),
            touched: touched.slice(0, INTENT_HISTORY_TOUCHED_ROWS),
            taskKeys: [...(keysOf.get(fact.id) ?? [])].sort(byCodePoint),
          };
        });
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// The plan: one unit per module of 0026's cluster level
// ---------------------------------------------------------------------------------------------

/**
 * One plan's units: one per module fact of every repository the graph holds, in
 * code point order of the repository, then of the module's own id — never the
 * graph's own order. A module whose estimate is past 0026's planned size is
 * planned as its member files, one level down and within the shape's own
 * `MAX_PLAN_UNITS` budget; what the budget cannot enumerate is collapsed back
 * to the module itself, so the plan names at least one unit for every module it
 * read and drops no scope. A graph with no module at all is nothing found
 * rather than a plan that failed: the snapshot stage read no code to cluster,
 * and its own coverage says so (0027).
 */
export async function planIntentUnits(graph: StageGraphReader): Promise<StagePlan> {
  const reads = graphReadsOver(graph);
  const units: StageUnitScope[] = [];
  const budget = { left: MAX_PLAN_UNITS };
  for (const repository of await repositoriesOf(reads)) {
    const name = repositoryNameOf(repository);
    const modulesRead = { read: 'facts-with' as const, kind: 'module' as const, field: 'repository', value: name };
    for (const module of factsOfRows(await reads.read(modulesRead), modulesRead)) {
      units.push(...await moduleUnits(reads, module, name, budget));
    }
  }
  if (units.length === 0) return { units: [], coverage: 'nothing-found' };
  return { units, coverage: 'planned' };
}

/** How many units the whole plan may still name: a module whose enumeration would take it past the bound stands as one. */
interface PlanBudget {
  left: number;
}

/** How many members one module holds: the count stage 5 wrote into it, or the graph's own held count where it wrote none. */
async function membersOf(reads: GraphReadContext, module: Fact): Promise<number> {
  const written = (module.value as { members?: unknown }).members;
  if (typeof written === 'number' && Number.isInteger(written) && written >= 0) return written;
  const rows = await reads.read({ read: 'held', id: module.id, via: ['contains', 'defines'] });
  let total = 0;
  for (const row of rows) {
    const count = typeof (row as { count?: unknown }).count === 'number' ? (row as { count?: unknown }).count as number : Number((row as { count?: unknown }).count);
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`intent-history: the held read of the module ${module.id} counted ${String((row as { count?: unknown }).count)} members: a count is a whole number of no less than zero`);
    }
    total += count;
  }
  return total;
}

/** The units one module is planned as: itself while its estimate fits 0026's planned size, else its member files. */
async function moduleUnits(reads: GraphReadContext, module: Fact, repository: string, budget: PlanBudget): Promise<readonly StageUnitScope[]> {
  const estimate = estimateOfMembers(await membersOf(reads, module));
  const one = (): readonly StageUnitScope[] => {
    budget.left -= 1;
    return [{ id: module.id, scope: repository, estimatedTokens: estimate }];
  };
  if (estimate <= plannedTokens(DEFAULT_STAGE_LIMITS) || budget.left < 1) return one();
  const places = await placeMembers(reads, module.id);
  // A member list the answer's cap cut is no enumeration, and a module that holds no file is no scope to split:
  // the module stands as one unit either way, and its own coverage names what its member list did not hold.
  if (places === null || places.length === 0) return one();
  const before = budget.left;
  const units: StageUnitScope[] = places.map((place) => {
    budget.left -= 1;
    // One file of a module costs about one bounded span of reading, which is the estimate the shape's own place
    // reader gives a split child too (`memberPlaces`).
    return { id: place.id, scope: `${repository}:${place.path}`, estimatedTokens: estimateOfMembers(1) };
  });
  if (budget.left < 0) {
    // What this module's enumeration would have cost is past the bound: it is undone and the module stands as one
    // unit, so the plan names at least one unit for every module it read and drops none.
    budget.left = before;
    return one();
  }
  return units;
}

// ---------------------------------------------------------------------------------------------
// The declaration and the stage
// ---------------------------------------------------------------------------------------------

/**
 * The answer stage 11's units give: how far the unit read its module, the files it
 * covered and those it did not, and one sentence on the intent it wrote. The
 * claims themselves are the unit's writes, checked one at a time by the unit's own
 * server (0026, "Writing"), never a list in the answer.
 */
const INTENT_HISTORY_ANSWER = {
  shape: '{"status":"done"|"partial","covered":["<a file of your scope>"],"remaining":["<a file of your scope>"],"summary":"<one sentence on the intent you wrote>"}',
  reading: [
    '`covered` names every place of your scope you read to the end — the comments and commits you drew intent from included; `remaining` names the places you did not read. A `done` answer whose `remaining` is not empty is read as `partial`, and the places you leave out are planned as units of their own. Write your claims and questions with the tools before you answer.',
  ],
  example: '{"status":"done","covered":["src/payments/payment.ts"],"remaining":[],"summary":"The tracked work behind this module was to settle payments exactly once"}',
  fields: [
    { name: 'status', type: 'status' as const, required: true },
    { name: 'covered', type: 'places' as const, required: true },
    { name: 'remaining', type: 'places' as const, required: true },
    { name: 'summary', type: 'text' as const },
  ],
};

/**
 * Stage 11's declaration: one unit per module, its fixed part, the sections its
 * packet reads, and what it may write.
 */
export function intentHistoryDeclaration(): AgentStageDeclaration {
  return {
    id: INTENT_HISTORY_STAGE_ID,
    version: INTENT_HISTORY_STAGE_VERSION,
    factStage: '11-intent-history',
    // 0026's stage 11: what people recorded about the code — the intent level of the fill's three (self-filling's
    // outcome 4), the words of comments and commits, read as they stand and never invented.
    level: 'intent',
    scale: { level: 'cluster', child: 'place' },
    role: 'You are one unit of madarch\'s fill that writes the intent a module\'s own words state: what the comments in its files and the commits that touched it say the work was for and why it was done, written as claims cited to those words.',
    rules: [
      'The packet\'s `comments` section names where each comment of your scope\'s files stands, and its `commits` section the commits that touched them with the task keys their messages name; neither pastes the words. Read a comment\'s words with `evidence_span`, at the file and lines it names, before you state what it means.',
      'Write intent, not behaviour: an `intent` claim states what the people who wrote it meant the part to do; a `why` claim states why it is as it is — a rationale a comment records, a constraint it names, a choice a commit made. What the code does is no claim of yours.',
      'Tie every claim to its source. A claim from a comment cites the file and lines the comment stands at; a claim from a commit cites a file that commit changed, and names the commit and its task key in its text.',
      'A task key (like ORD-12) names tracked work: a claim that states what a commit was for names the key, so a reader can find the work behind it.',
      'Behaviour the commits or the code show that no comment explains is undocumented: raise a question of type `undocumented-behaviour` about the node whose behaviour it is, naming the behaviour in one sentence. Never state as claimed what nobody\'s words say.',
      'Your places are your module\'s own files, which the packet\'s `scope` and `members` sections name. A comment or commit outside them is another unit\'s source, and a claim about it is not yours to write; raise a question about what you can see only from outside.',
    ],
    task: 'Write the intent and the \'why\' rationale this module\'s comments and commits state, every claim cited to the words it stands on, and raise what they leave undocumented as a question.',
    answer: INTENT_HISTORY_ANSWER,
    kinds: INTENT_HISTORY_KINDS,
    consumes: {
      // The modules are the plan's own source: one unit per module of every repository the run pins.
      required: [
        { capability: 'repository', scope: 'repository', freshness: 'current' },
        { capability: 'module', scope: 'repository', freshness: 'any' },
      ],
      // Read where the run published them, and read as absent where it did not: a module whose comments or history
      // no stage published still has a unit, and its coverage says what it read.
      optional: [
        { capability: 'comment', scope: 'file', freshness: 'any' },
        { capability: 'commit', scope: 'repository', freshness: 'any' },
        { capability: 'task-key', scope: 'repository', freshness: 'any' },
      ],
    },
    sections: intentHistorySections(),
    plan: (graph) => planIntentUnits(graph),
    places: (context) => memberPlaces(context),
  };
}

/**
 * Stage 11, registered over the run's wiring: one unit per module of 0026's
 * cluster level, whose packet reads the comments and the history of its own files.
 */
export function createIntentHistoryStage(wiring: AgentStageWiring): FillStage {
  return createAgentStage(intentHistoryDeclaration(), wiring);
}
