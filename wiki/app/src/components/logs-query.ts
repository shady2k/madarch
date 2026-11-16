/**
 * The logs page's one read (madarch-64o5.88): one page of every log madarch keeps, asked through the product's one read
 * API (`POST /graphql`) — the page imports no route of its own, and the answer is the same shape the route and the
 * reader state.
 */
import { postQuery } from '../client.js';
import { CommandError, offlineWords } from './command.js';

/** One entry of one madarch log, as the graph answers it. */
export interface LogEntryView {
  readonly id: string;
  /** The moment in epoch milliseconds, or null for a log whose writer kept no time. */
  readonly at: number | null;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly source: string;
  readonly run: string | null;
  readonly unit: string | null;
  readonly message: string;
  /** The engine's own event code, worded by the page, or null for text shown as it was written. */
  readonly code: string | null;
  /** The event's arguments, when the code has any. */
  readonly arguments: Readonly<Record<string, string>>;
  /** Whether the message is verbatim text (a plugin's standard error, the store's log, an unwritten sentence). */
  readonly quoted: boolean;
  readonly file: string | null;
  readonly line: number | null;
  readonly path: string | null;
  readonly detail: string | null;
  readonly cut: boolean;
  readonly fields: Readonly<Record<string, string>>;
}

/** One page of every log, oldest first, and what the read kept. */
export interface LogsAnswer {
  readonly entries: readonly LogEntryView[];
  readonly more: boolean;
  readonly scanned: number;
  readonly truncated: boolean;
  readonly runs: readonly string[];
  readonly sources: readonly string[];
  readonly levels: readonly string[];
}

/** What the page asks for: the filters the kit's viewer holds. */
export interface LogsAsked {
  /** The sources, comma separated, as the viewer's filter names them. */
  readonly sources?: string;
  readonly level?: string;
  readonly run?: string;
  readonly q?: string;
  readonly from?: number;
  readonly before?: number;
  readonly limit?: number;
}

/** The logs page's operation: the graph's `logs` field answers one page of every log madarch keeps. */
const LOGS_QUERY = `query Logs($sources: [String!], $level: String, $run: String, $q: String, $from: Int, $before: Int, $limit: Int) {
  logs(sources: $sources, level: $level, run: $run, q: $q, from: $from, before: $before, limit: $limit)
}`;

/** The operation's variables: a filter the page did not ask for is null, which the schema reads as absent. */
function variablesOf(asked: LogsAsked): Record<string, unknown> {
  const sources = (asked.sources ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '');
  return {
    sources: sources.length === 0 ? null : sources,
    level: asked.level === undefined || asked.level === '' ? null : asked.level,
    run: asked.run === undefined || asked.run === '' ? null : asked.run,
    q: asked.q === undefined || asked.q === '' ? null : asked.q,
    from: asked.from ?? null,
    before: asked.before ?? null,
    limit: asked.limit ?? null,
  };
}

/** One page of every log madarch keeps: filtered by sources, the quietest level, one run, a text and a moment. */
export async function logsOf(base: string, asked: LogsAsked, signal?: AbortSignal): Promise<LogsAnswer> {
  const answer = await postQuery<{ logs: LogsAnswer | null }>(base, LOGS_QUERY, variablesOf(asked), signal);
  if (answer.offline === true) throw new CommandError(offlineWords(), 'offline');
  if (answer.errors.length > 0) throw new CommandError(answer.errors.map((error) => error.message).join('; '), answer.errors[0]?.extensions?.code ?? 'failed');
  const held = answer.data?.logs;
  if (held === null || held === undefined) throw new CommandError('the graph answered no page of the logs', 'failed');
  return held;
}
