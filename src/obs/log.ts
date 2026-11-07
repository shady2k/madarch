/**
 * One structured logger (madarch-8bdc.2.5, item 1): one JSON line per record,
 * beside the run's trace in `<store>/traces/<run>.log.jsonl`, carrying the
 * trace id and the span id of the work that wrote it, so a log line leads to
 * its span.
 *
 * A level is a level: `debug` is the work's own detail, `info` what a person
 * watching the run wants, `warn` something answered short of what was asked,
 * `error` something that failed. An error record names its file, line and full
 * path; the fill path writes through these calls instead of `console.*`.
 *
 * Nothing here accepts a source line, a document, a prompt or the values a
 * statement was given. A caller that has such text has nothing to log with.
 */
import { appendFileSync } from 'node:fs';
import { currentSpan, currentTrace } from './trace.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const minimum: LogLevel = 'info';

function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

/** One record, as the line and as the console says it. */
function write(level: LogLevel, message: string, fields: LogFields, error?: unknown): void {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(minimum)) return;
  const span = currentSpan();
  const run = currentTrace();
  const context = span?.spanContext();
  const record: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    message,
    ...(context === undefined || context.traceId === '' ? {} : { traceId: context.traceId, spanId: context.spanId }),
    ...fields,
  };
  if (error !== undefined) record['error'] = error instanceof Error
    ? { name: error.name, message: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) }
    : { message: printable(error) };
  if (run !== undefined && !run.closed) {
    try { appendFileSync(run.logFile, `${JSON.stringify(record)}\n`, 'utf8'); } catch { /* the log is evidence, not the work */ }
  }
  if (run?.console === true || (run === undefined && (level === 'warn' || level === 'error'))) {
    const extras = Object.entries(fields).map(([key, value]) => `${key}=${printable(value)}`).join(' ');
    const line = `${level} ${message}${extras === '' ? '' : ` ${extras}`}${error === undefined ? '' : `: ${error instanceof Error ? error.message : printable(error)}`}`;
    (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  }
}

/** The logger the fill path uses. */
export const log = {
  debug: (message: string, fields: LogFields = {}): void => write('debug', message, fields),
  info: (message: string, fields: LogFields = {}): void => write('info', message, fields),
  warn: (message: string, fields: LogFields = {}): void => write('warn', message, fields),
  /**
   * A failure: its message, its file, its line and the full path of the thing it
   * failed on, in the record's own fields.
   */
  error: (message: string, fields: LogFields = {}, error?: unknown): void => write('error', message, fields, error),
};
