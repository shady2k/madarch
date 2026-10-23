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
  | { type: 'stop' };

export interface UnitSummary {
  unit: string;
  status: 'written' | 'failed' | 'not-written';
  writeAttempts: number;
  calls: number;
  refusals: { line: number; rule: string; message: string }[];
  domains: DomainDeclaration[];
}

export type FromWorker =
  | { type: 'pins'; pins: RepositoryPin[] }
  | { type: 'pin'; pin: RepositoryPin }
  | { type: 'progress'; repository: string; commit: number; commits: number }
  /** A phase of the fill begins: the last commit's code is read first, then the history of every commit. */
  | { type: 'phase'; repository: string; phase: 'code' | 'history' | 'points'; commits: number; newCommits: number }
  | { type: 'snapshot'; seq: number }
  | { type: 'fill'; state: 'done'; gaps: number }
  | { type: 'fill'; state: 'stopped' }
  | { type: 'fill'; state: 'failed'; message: string }
  | { type: 'agent-wanted' }
  | { type: 'unit-start'; unit: string; path: string }
  | { type: 'unit'; id: string; prompt: string; definitions: ToolDefinition[] }
  | { type: 'tool-result'; callId: number; answer: unknown; finished: boolean }
  | { type: 'unit-outcome'; outcome: UnitSummary }
  | { type: 'page'; path: string }
  | { type: 'writer'; state: 'done'; message?: string }
  | { type: 'writer'; state: 'failed'; message: string }
  | { type: 'log'; line: string };

/** Reads a line as a message; the error names the line it could not read. */
export function parseMessage<T>(line: string, who: string): T {
  try {
    return JSON.parse(line) as T;
  } catch (error) {
    throw new Error(`src/knowledge/fill-protocol.ts: ${who} sent a line that is no JSON (${(error as Error).message}): ${JSON.stringify(line.slice(0, 200))}`);
  }
}
