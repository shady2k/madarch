/**
 * The words a product's server and its fill worker say to each other
 * (madarch-m38l.4, remark 3). The fill runs in a process of its own,
 * `madarch knowledge-fill-worker`, because PGlite runs a statement on the thread
 * that owns it and a commit of the fill is seconds of statements (measured on
 * the pod: 89 % of a fill's 471 s was the graph's publication, the event loop
 * blocked for 466 s of it). The worker owns the product's primary graph store;
 * the server reads a copy of that store (a snapshot the worker makes between
 * commits), so a page never waits for a commit.
 *
 * One JSON object per line, in each direction, over the worker's standard
 * input and output; the worker's standard error is its log.
 */
import type { RefreshPlan } from '../loop/plan.js';
import type { DomainDeclaration } from '../writer/tools.js';

/** What a repository was filled to: kept in the primary store (`knowledge_fill`) and told to the server. */
export interface RepositoryPin {
  name: string;
  scope: string;
  head: string;
  /** The commit the graph holds for the repository, and the effective time it was read at. */
  commit: string;
  effectiveTime: string;
  commits: number;
  filledCommits: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The server's one request: fill these repositories, then (when asked) let the agent write the pages. */
export interface WorkerStart {
  type: 'start';
  productFolder: string;
  productName: string;
  /** The primary store's folder; the worker alone opens it while it runs. */
  graphPath: string;
  /** The folder the snapshots are made in: `<readRoot>/<seq>`. */
  readRoot: string;
  repositories: { name: string; path: string }[];
  /** Run the agent stage after the fill. */
  writer: boolean;
  language: string;
  languageChanged: boolean;
  /** The language the pages were last written in, when it is known: a translation says from which. */
  languageFrom?: string | null;
  /**
   * The task whose pages alone this run writes (madarch-m38l.14, «Поправить страницы сейчас»): the writer's plan is
   * exactly the impact of that task's grounds, computed through the graph, and no other page is given to the agent.
   */
  task?: string;
  /** The pages the reader saw in the preview and pressed to run: the worker refuses a run that writes fewer of them. */
  taskPages?: string[];
  /**
   * The remaining work of a paused run (madarch-m38l.17): the plan it had reached, and the pages it had published.
   * A resumed run writes the plan's pages that are not in `completedPages`, and never translates a completed one again.
   */
  resume?: { plan: RefreshPlan; completedPages: string[] };
  /** The least time between two snapshots, in milliseconds. */
  snapshotMs: number;
}

export type ToWorker =
  | WorkerStart
  | { type: 'agent-ready' }
  | { type: 'agent-failed'; message: string }
  /** The server's agent ended a unit; `error` when it threw. */
  | { type: 'unit-end'; id: string; error?: string }
  /** The server's agent calls a tool of the unit it is running; the worker answers with `tool-result`. */
  | { type: 'tool'; callId: number; unit: string; name: string; args: unknown }
  /**
   * A person's pause: the work in progress is finished, and the run ends at its next commit rather than at once. The
   * worker says which stage it ended in, so the server can show the run as paused and take it up again.
   */
  | { type: 'pause' }
  /** A person's stop: the work in progress ends now. */
  | { type: 'stop' };

export interface UnitSummary {
  unit: string;
  status: 'written' | 'failed' | 'not-written';
  writeAttempts: number;
  calls: number;
  refusals: { line: number; rule: string; message: string }[];
  domains: DomainDeclaration[];
  /** The ids of the questions the unit asked. */
  questions?: string[];
}

export type FromWorker =
  | {type:'rebuild'; reason:'extractors-changed'}
  | { type: 'progress'; repository: string; commit: number; commits: number }
  /** A phase of the fill begins: the last commit's code is read first, then the history of every commit. */
  | { type: 'phase'; repository: string; phase: 'code' | 'history' | 'points'; commits: number; newCommits: number }
  /** A snapshot is ready; `pins` are what the repositories were filled to in it, applied when the server reads it so source and graph agree. */
  | { type: 'snapshot'; seq: number; pins: RepositoryPin[] }
  | { type: 'fill'; state: 'done'; gaps: number }
  /** `paused` tells a person's pause from a stop and from the server's own shutdown; the run is taken up by the next fill. */
  | { type: 'fill'; state: 'stopped'; paused?: boolean }
  /** `code` names the kind of failure for the app to word in the reader's language; `message` is the engineer's detail. */
  | { type: 'fill'; state: 'failed'; message: string; code?: string }
  /** Which pages the refresh will touch and why, told before the agent is asked for its first unit. */
  | { type: 'plan'; plan: RefreshPlan }
  | { type: 'agent-wanted' }
  | { type: 'unit-start'; unit: string; path: string }
  /** How many pages the run means to write in total: before the first unit, and again when the product page declares its domains. */
  | { type: 'writer-total'; total: number }
  | { type: 'unit'; id: string; prompt: string; definitions: ToolDefinition[] }
  | { type: 'tool-result'; callId: number; answer: unknown; finished: boolean }
  | { type: 'unit-outcome'; outcome: UnitSummary }
  | { type: 'page'; path: string }
  | { type: 'writer'; state: 'done'; message?: string; asked?: number }
  | { type: 'writer'; state: 'failed'; message: string; asked?: number; code?: string }
  /** A person's pause between two pages, or a stop: the page in progress is left as it was before the run. */
  | { type: 'writer'; state: 'paused' | 'stopped'; message?: string }
  | { type: 'log'; line: string };

/** Reads a line as a message; the error names the line it could not read. */
export function parseMessage<T>(line: string, who: string): T {
  try {
    return JSON.parse(line) as T;
  } catch (error) {
    throw new Error(`src/knowledge/fill-protocol.ts: ${who} sent a line that is no JSON (${(error as Error).message}): ${JSON.stringify(line.slice(0, 200))}`);
  }
}
