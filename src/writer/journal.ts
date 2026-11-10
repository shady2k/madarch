/**
 * The core's journal of what the writer's agent did (madarch-m38l.13).
 *
 * One JSON-lines file per run, in the machine-local store of the product
 * (never the product repository), one record per call the agent made to the
 * unit's MCP server and one per request it made that madarch refuses (an
 * unknown tool, a file or terminal request, a permission request). A record
 * carries the run, unit, agent, model and session, the tool, the full
 * arguments, the full response (cut at `MAX_RESPONSE_CHARACTERS`, with its
 * size and a flag when cut), the start time and the duration. The field names
 * follow the OpenTelemetry generative-AI conventions in `attributes`
 * (`gen_ai.tool.name`, `gen_ai.agent.name`, `gen_ai.request.model`,
 * `gen_ai.conversation.id`), so an exporter can forward the lines unchanged.
 *
 * The journal is written by the process that serves the agent's tools, so it
 * records what the agent asked and was answered, not what the worker did.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { byCodePoint } from '../model/order.js';

const JOURNAL_SCHEMA = 'madarch.agent-journal@1';
/**
 * What one call of a unit's tools read, could not resolve and produced (decision 0032, section 2): a
 * call count says how often a unit asked, and these say whether the asking did work. `sourceBytes`
 * separates the product's bytes a unit was shown from the bytes it was shown twice, so a unit that
 * rereads one file instead of asking a question is visible; `evidence` counts the distinct targets
 * (graph keys, document sections, page paths) it was shown; `unresolvedJoins` counts the joins a tool
 * was asked to make and could not (a route with no handler, a name that names several declarations,
 * an edge the graph holds no site for); `produced` counts what the unit wrote.
 */
export interface CallCounters {
  readonly sourceBytes: { readonly served: number; readonly repeated: number };
  readonly evidence: number;
  readonly unresolvedJoins: number;
  readonly produced: { readonly pages: number; readonly statements: number; readonly grounds: number; readonly links: number; readonly questions: number };
}

/** No call, and nothing produced: what a record of a refused request and an older journal line hold. */
export const NO_COUNTERS: CallCounters = Object.freeze({
  sourceBytes: Object.freeze({ served: 0, repeated: 0 }),
  evidence: 0,
  unresolvedJoins: 0,
  produced: Object.freeze({ pages: 0, statements: 0, grounds: 0, links: 0, questions: 0 }),
});

/** Two counts added, field by field: a unit's totals are the sum of its records. */
export function addCounters(left: CallCounters, right: CallCounters): CallCounters {
  return {
    sourceBytes: { served: left.sourceBytes.served + right.sourceBytes.served, repeated: left.sourceBytes.repeated + right.sourceBytes.repeated },
    evidence: left.evidence + right.evidence,
    unresolvedJoins: left.unresolvedJoins + right.unresolvedJoins,
    produced: {
      pages: left.produced.pages + right.produced.pages,
      statements: left.produced.statements + right.produced.statements,
      grounds: left.produced.grounds + right.produced.grounds,
      links: left.produced.links + right.produced.links,
      questions: left.produced.questions + right.produced.questions,
    },
  };
}


/** The whole number a record holds, and 0 for anything a line of an older or broken journal gives. */
const whole = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** The counters a journal line holds, with every field a line of an older journal lacks taken as 0. */
export function countersOf(value: unknown): CallCounters {
  if (typeof value !== 'object' || value === null) return NO_COUNTERS;
  const held = value as { sourceBytes?: unknown; evidence?: unknown; unresolvedJoins?: unknown; produced?: unknown };
  const bytes = typeof held.sourceBytes === 'object' && held.sourceBytes !== null ? held.sourceBytes as Record<string, unknown> : {};
  const produced = typeof held.produced === 'object' && held.produced !== null ? held.produced as Record<string, unknown> : {};
  return {
    sourceBytes: { served: whole(bytes['served']), repeated: whole(bytes['repeated']) },
    evidence: whole(held.evidence),
    unresolvedJoins: whole(held.unresolvedJoins),
    produced: {
      pages: whole(produced['pages']),
      statements: whole(produced['statements']),
      grounds: whole(produced['grounds']),
      links: whole(produced['links']),
      questions: whole(produced['questions']),
    },
  };
}

/** What happened to a request: it was answered, the tool refused it, the tool failed, or madarch rejected it before any tool. */
type JournalOutcome = 'ok' | 'refused' | 'failed' | 'rejected';

interface JournalRecord {
  readonly schema: typeof JOURNAL_SCHEMA;
  /** Start of the request, ISO 8601 UTC. */
  readonly time: string;
  readonly durationMs: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly run: string;
  /** The unit, which is the id of the page it writes (`product:<slug>`, `domain:<slug>`). */
  readonly unit: string;
  readonly agent: string;
  readonly model: string | null;
  readonly session: string | null;
  /**
   * `tool-call` counts toward the unit's calls; `refusal` is a request madarch did not serve as a call;
   * `editorial-finding`, `revision-request`, `editorial-skip` and `editorial-warning` are the editorial pass's own records
   * (madarch-ztyq.9), so a finding, a requested revision or a skipped reading is never hidden in a log
   * of tool traffic.
   */
  readonly kind: 'tool-call' | 'refusal' | 'editorial-finding' | 'revision-request' | 'editorial-skip' | 'editorial-warning';
  /** The tool, or the protocol method of a refused request (`fs/read_text_file`, `session/request_permission`). */
  readonly tool: string;
  readonly arguments: unknown;
  readonly response: string | null;
  readonly responseBytes: number;
  readonly truncated: boolean;
  readonly isError: boolean;
  readonly outcome: JournalOutcome;
  /** For a refusal or a failure: the reason in words, with the rule and line when the page was refused. */
  readonly reason: string | null;
  /** What the call read, could not resolve and produced: not only that a call was made. */
  readonly counters: CallCounters;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface JournalContext {
  /** Guide sessions never journal untrusted source, arguments, results or protocol refusal details. */
  readonly privateGuide?: boolean;
  readonly run: string;
  readonly unit: string;
  readonly agent: string;
  readonly model: string | null;
  readonly session: string | null;
}

/** What a caller gives the journal for one request; the context fills the rest. */
export interface JournalEntry {
  readonly kind: JournalRecord['kind'];
  readonly tool: string;
  readonly arguments: unknown;
  /** The response as text; null when there was none. */
  readonly response: string | null;
  readonly isError: boolean;
  readonly outcome: JournalOutcome;
  readonly reason: string | null;
  readonly startedAt: Date;
  readonly durationMs: number;
  /** What this call read, could not resolve and produced; absent when the caller counts nothing. */
  readonly counters?: CallCounters;
}

export interface Journal {
  /** The file the run's records go to. */
  readonly file: string;
  readonly run: string;
  record(context: JournalContext, entry: JournalEntry): void;
}

/** The folder of a product's journals inside its machine-local store. */
export const journalFolder = (storeFolder: string): string => path.join(storeFolder, 'journal');


export interface JournalRead {
  readonly records: readonly JournalRecord[];
  /** Lines that could not be read, each with its file, line and the reason. */
  readonly problems: readonly string[];
}

export function readJournalFile(file: string): JournalRead {
  const records: JournalRecord[] = [];
  const problems: string[] = [];
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { records, problems: [`${file}: the journal cannot be read: ${(error as Error).message}`] };
  }
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as Partial<JournalRecord>;
      if (parsed.schema !== JOURNAL_SCHEMA || typeof parsed.unit !== 'string' || typeof parsed.tool !== 'string') throw new Error(`not a ${JOURNAL_SCHEMA} record`);
      records.push({ ...parsed, counters: countersOf(parsed.counters) } as JournalRecord);
    } catch (error) {
      problems.push(`${file}:${index + 1}: ${(error as Error).message}`);
    }
  }
  return { records, problems };
}

/** The runs of a product's journal folder, oldest first; a missing folder is no runs. */
function journalRuns(folder: string): string[] {
  try {
    return readdirSync(folder).filter((name) => /^run-[A-Za-z0-9-]+\.jsonl$/.test(name)).map((name) => name.slice(0, -'.jsonl'.length)).sort(byCodePoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`src/writer/journal.ts: the journal folder ${folder} cannot be read: ${(error as Error).message}`);
  }
}

/** What a reader sees of a page's journal: the newest run that wrote it, and every record of that run for the unit. */
export interface PageJournal {
  readonly run: string | null;
  readonly runs: readonly string[];
  readonly records: readonly JournalRecord[];
  /** The run's records added up: what the unit read twice, resolved, left unresolved and produced. */
  readonly totals: CallCounters;
  readonly problems: readonly string[];
}

export function journalOfUnit(folder: string, unit: string, wantedRun?: string): PageJournal {
  const runs = journalRuns(folder);
  const problems: string[] = [];
  const carrying: string[] = [];
  const byRun = new Map<string, JournalRecord[]>();
  for (const run of runs) {
    const read = readJournalFile(path.join(folder, `${run}.jsonl`));
    problems.push(...read.problems);
    const mine = read.records.filter((record) => record.unit === unit);
    if (mine.length > 0) { carrying.push(run); byRun.set(run, mine); }
  }
  const run = wantedRun !== undefined && byRun.has(wantedRun) ? wantedRun : (carrying[carrying.length - 1] ?? null);
  const records = run === null ? [] : byRun.get(run)!;
  return { run, runs: carrying, records, totals: records.reduce((sum, record) => addCounters(sum, countersOf(record.counters)), NO_COUNTERS), problems };
}
