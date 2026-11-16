/**
 * The machine's logs as one read (madarch-64o5.88, part 3): every log madarch keeps — the server's and the
 * fill's structured records, each plugin's standard error, the agent units' exchanges, the store's PostgreSQL
 * log and the run's spans — parsed into one entry shape, filtered and paged by one answer.
 *
 * Where each source stands (all under the product's store, `<store>`, unless it says otherwise):
 *
 * - `server`: `<knowledge root>/traces/server-<pid>.log.jsonl`, the records of every served process;
 * - `fill`: `<store>/traces/<run>.log.jsonl`, the fill's own records, one file per run;
 * - `plugin`: `<store>/traces/<run>.plugins/<unit>.log`, the tail of one plugin run's standard error, kept with
 *   the run (the host bounds it to 64 KiB when it writes it);
 * - `agent`: `<store>/traces/<run>.agents/<unit>.json`, the ACP exchange madarch recorded for one agent unit;
 * - `store`: `<store>/postgres.log`, the PostgreSQL server's own log;
 * - `trace`: `<store>/traces/<run>.jsonl`, one line per span of a run, so a run's stages and their time are read
 *   from the same place as its errors.
 *
 * What is never read: a field whose name speaks of a token, a secret, a password, a key or a cookie is dropped from
 * an entry's context, and no file madarch keeps a token in is opened at all (the daemon's state file is not a log).
 * A record's own texts are its message and its stack, and neither is cut silently: an entry whose detail was cut says
 * so with `cut`.
 *
 * The read is bounded: each file is read from its tail (`MAX_FILE_BYTES`), one answer scans at most `MAX_ENTRIES`
 * and returns at most `MAX_PAGE` of them. Every bound crossed is said — `truncated` for the files, `more` for the
 * entries the page left out — so a reader is never shown less than the logs hold without being told.
 */
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { byCodePoint } from '../model/order.js';
import { withSpanSync } from '../obs/trace.js';

/** The logs one answer may draw from. */
export const LOG_SOURCES = ['engine', 'fill', 'plugin', 'agent', 'store', 'trace'] as const;
export type LogSourceName = (typeof LOG_SOURCES)[number];

/** The levels an entry may have, from the quietest to the loudest. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The sources a read takes when it is not told which: every log, and the spans only when they are asked for — one run's
 * trace is hundreds of spans, and a reader who wants them says so.
 */
export const DEFAULT_LOG_SOURCES: readonly LogSourceName[] = ['engine', 'fill', 'plugin', 'agent', 'store'];

/** One entry of one log, as a reader of every log reads it. */
export interface LogEntry {
  /** Stable across reads: the source, the file and the line's number in it. */
  readonly id: string;
  /** When it happened, in epoch milliseconds; null for a log whose writer recorded no time (a plugin's raw lines). */
  readonly at: number | null;
  readonly level: LogLevel;
  readonly source: LogSourceName;
  /** The run the entry belongs to: a fill run's id, a server process's trace, a run's id for its plugins and agents. */
  readonly run: string | null;
  /** The unit of the run the entry belongs to, when the log names one. */
  readonly unit: string | null;
  readonly message: string;
  /**
   * The engine's own event, when the message is one: a code the page words in the reader's language, and the
   * message's arguments. Null for text madarch did not write — a plugin's standard error, the store's log, an agent's
   * own words — which stands as it was written and is marked `quoted`.
   */
  readonly code: string | null;
  readonly arguments: Readonly<Record<string, string>>;
  /** Whether the message is verbatim text the page must not word: outside text, or an engine message with no code. */
  readonly quoted: boolean;
  /** The place an error stands at: the file, its line and the full path of the thing it failed on. */
  readonly file: string | null;
  readonly line: number | null;
  readonly path: string | null;
  /** The entry's full text when it has more than its message: a stack, a plugin's raw output, an answer. */
  readonly detail: string | null;
  /** Whether the detail was cut at `MAX_DETAIL_CHARACTERS`. */
  readonly cut: boolean;
  /** The record's own context, with a field that could hold a secret left out. */
  readonly fields: Readonly<Record<string, string>>;
}

/** What one read asks for. */
export interface LogQuery {
  /** The sources to read: all of them when left out. */
  readonly sources?: readonly LogSourceName[];
  /** The quietest level to answer: `warn` answers warnings and errors. */
  readonly level?: LogLevel;
  /** One run's entries only: a fill run's id, or a server trace's. */
  readonly run?: string;
  /** A text every entry must contain, in its message or its detail (case-insensitive). */
  readonly q?: string;
  /** Only entries after this moment, for a live tail. */
  readonly from?: number;
  /** Only entries before this moment, for the older page of a list. */
  readonly before?: number;
  readonly limit?: number;
}

/** One page of one read. */
export interface LogPage {
  /** The entries the page holds, oldest first. */
  readonly entries: readonly LogEntry[];
  /** Whether entries older than the page's first stand behind it. */
  readonly more: boolean;
  /** How many entries the read kept before the page was cut (`MAX_ENTRIES`). */
  readonly scanned: number;
  /** Whether any file was read from its tail only, so older lines of it are not in this answer. */
  readonly truncated: boolean;
}

/** How much of one file is read: the tail, since a log is read for what it ended with. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** How many entries one read keeps. */
export const MAX_ENTRIES = 20_000;
/** The most entries one page answers with, and its default. */
export const MAX_PAGE = 1_000;
export const DEFAULT_PAGE = 200;
/** The characters an entry's detail or message holds before it is cut. */
export const MAX_DETAIL_CHARACTERS = 8_000;
/** The characters one plugin log line holds. */
const MAX_LINE_CHARACTERS = 4_000;
/** The fields whose name speaks of a secret, which no answer carries. */
function secretField(name: string): boolean {
  const folded = [...name].map((character) => character === 'ſ' ? 's' : character === 'K' ? 'k'
    : character >= 'A' && character <= 'Z' ? character.toLowerCase() : character).join('');
  return ['token', 'secret', 'password', 'passwd', 'authorization', 'apikey', 'api-key', 'api_key', 'cookie', 'credential']
    .some((word) => folded.includes(word));
}

/** The whole number a value is, or the fallback. */
function whole(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** The text of a value, cut at a bound, saying whether it was cut. */
function cutText(value: string, characters = MAX_DETAIL_CHARACTERS): { text: string; cut: boolean } {
  return value.length <= characters ? { text: value, cut: false } : { text: value.slice(0, characters), cut: true };
}

/** A record's fields as an entry's context: values as text, a field that could hold a secret left out. */
function contextOf(record: Readonly<Record<string, unknown>>, skip: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort(byCodePoint)) {
    if (skip.has(key) || secretField(key)) continue;
    const value = record[key];
    if (value === undefined) continue;
    const text = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value) ?? String(value); } catch { return String(value); } })();
    const held = cutText(text, 2_000);
    out[key] = held.cut ? `${held.text}…` : held.text;
  }
  return out;
}

/** The file and line an error states at the head of its message (`src/x.ts:12: …`), when it states one. */
function placeOf(message: string): { file: string | null; line: number | null } {
  const absent = { file: null, line: null };
  const text = message.startsWith('the ') ? message.slice(4) : message.startsWith('a ') ? message.slice(2) : message;
  const colon = text.indexOf(':');
  if (colon < 0) return absent;
  const path = text.slice(0, colon);
  if ([...path].some((character) => character.trim() === '')) return absent;
  const file = path.slice(path.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  if (dot <= 0 || !['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yml', 'yaml', 'md', 'sh'].includes(file.slice(dot + 1))) return absent;
  const end = text.indexOf(':', colon + 1);
  const line = text.slice(colon + 1, end);
  if (end < 0 || line === '' || [...line].some((character) => character < '0' || character > '9')) return absent;
  return { file, line: Number(line) };
}

/**
 * The engine's own log messages, by the code the page words them with. A message not here and matching no family below
 * is text the page cannot word: it stands as written and is marked quoted, so a reader knows whose words they are.
 */
const ENGINE_MESSAGES: Readonly<Record<string, string>> = {
  'fill started': 'fill-started',
  'fill ended': 'fill-ended',
  'fill failed': 'fill-failed',
  'fill was refused': 'fill-refused',
  'plugin closure hashed': 'plugin-closure-hashed',
  'plugin closure copied': 'plugin-closure-copied',
  'plugin sandbox started': 'plugin-sandbox-started',
  'plugin introduced': 'plugin-introduced',
  'plugin paused': 'plugin-paused',
  'plugin resumed': 'plugin-resumed',
  'plugin cancelled': 'plugin-cancelled',
  'plugin ignored stop': 'plugin-ignored-stop',
  'the plugin was cancelled after ignoring stop': 'plugin-stop-cancelled',
  'the plugin reported an error': 'plugin-reported-error',
  'a plugin cgroup outlived its tree': 'plugin-cgroup-outlived',
  'unit extracted': 'unit-extracted',
  'plugin agent file read': 'agent-file-read',
  'plugin agent file written': 'agent-file-written',
  'plugin agent update': 'agent-update',
  'plugin agent tool refused': 'agent-tool-refused',
  'plugin agent result validated': 'agent-result-validated',
  'the sandbox cannot run here': 'sandbox-refused',
  'sandbox filter installed': 'sandbox-filter-installed',
  'the macOS sandbox bounds the tree by rlimits and its process group': 'sandbox-darwin-bounds',
};

/** The engine's messages that carry a text of their own behind a fixed opening: the opening is the code, the rest is an argument. */
const ENGINE_FAMILIES: readonly { readonly opening: string; readonly unit?: boolean; readonly exact?: boolean; readonly code: string }[] = [
  { opening: 'unit not extracted: ', code: 'unit-not-extracted' },
  { opening: 'the plugin session failed: ', code: 'plugin-session-failed' },
  { opening: 'the sandbox could not resolve a runtime dependency: ', code: 'sandbox-dependency' },
  { opening: ' failed with no retry left: ', unit: true, code: 'unit-failed-retry' },
  { opening: ' failed: ', unit: true, code: 'unit-failed' },
  { opening: ' is blocked: ', unit: true, code: 'unit-blocked' },
  { opening: ' cannot split: ', unit: true, code: 'unit-cannot-split' },
  { opening: ' waits for a resolution: a child failed', unit: true, exact: true, code: 'unit-blocked-child' },
  { opening: 'the run is blocked: ', code: 'run-blocked' },
];

/** The code and arguments of an engine message, or null for a text the page must show as it was written. */
export function engineEventOf(message: string): { readonly code: string; readonly arguments: Readonly<Record<string, string>> } | null {
  const exact = ENGINE_MESSAGES[message];
  if (exact !== undefined) return { code: exact, arguments: {} };
  for (const family of ENGINE_FAMILIES) {
    let unitEnd = 0;
    if (family.unit === true) {
      while (unitEnd < message.length && message[unitEnd]!.trim() !== '') unitEnd += 1;
      if (unitEnd === 0) continue;
    }
    const rest = message.slice(unitEnd);
    if (family.exact === true ? rest !== family.opening : !rest.startsWith(family.opening)) continue;
    const args: Record<string, string> = {};
    if (family.unit === true) args['unit'] = cutText(message.slice(0, unitEnd)).text;
    if (family.exact !== true) args['detail'] = cutText(rest.slice(family.opening.length)).text;
    return { code: family.code, arguments: args };
  }
  return null;
}

/** The level a log record states, or `info` for a level madarch does not name. */
function levelOf(value: unknown): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

/** The tail of a file, up to `MAX_FILE_BYTES`: whether it was cut and its text. */
function readTail(file: string): { text: string; cut: boolean } {
  const read = (): { text: string; cut: boolean } => {
    let size: number;
    try { size = statSync(file).size; } catch { return { text: '', cut: false }; }
    if (size <= MAX_FILE_BYTES) {
      try { return { text: readFileSync(file, 'utf8'), cut: false }; } catch { return { text: '', cut: false }; }
    }
    const descriptor = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(MAX_FILE_BYTES);
      readSync(descriptor, buffer, 0, MAX_FILE_BYTES, size - MAX_FILE_BYTES);
      const text = buffer.toString('utf8');
      // The first line of a tail is a line cut in half: it is dropped rather than shown as a broken record.
      return { text: text.slice(text.indexOf('\n') + 1), cut: true };
    } finally {
      closeSync(descriptor);
    }
  };
  return withSpanSync('logs.readTail', { 'madarch.log.file': file }, read);
}

/** The names of the files in one folder, or none when the folder is not there. */
function namesIn(folder: string): string[] {
  const list = (): string[] => {
    try { return readdirSync(folder).sort(byCodePoint); } catch { return []; }
  };
  return withSpanSync('logs.list', { 'madarch.log.folder': folder }, list);
}

/** When a file was last written, in epoch milliseconds, or null when it cannot be read; inside its own span. */
function lastWritten(file: string): number | null {
  const stat = (): number | null => { try { return statSync(file).mtimeMs; } catch { return null; } };
  return withSpanSync('logs.stat', { 'madarch.log.file': file }, stat);
}

/** A whole text file, or null when it cannot be read; inside its own span. */
function wholeText(file: string): string | null {
  const read = (): string | null => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
  return withSpanSync('logs.readFile', { 'madarch.log.file': file }, read);
}

/** The stem of a trace file's name: its run id, as the trace wrote it. */
const stemOf = (name: string): string => name.endsWith('.log.jsonl') ? name.slice(0, -'.log.jsonl'.length)
  : name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name;

/** The files of one source, as the read finds them. */
function sourceFiles(paths: { store: string; knowledgeRoot: string }, source: LogSourceName, bound: number): { file: string; run: string | null; unit: string | null }[] {
  const traces = join(paths.store, 'traces');
  switch (source) {
    case 'engine':
      return namesIn(join(paths.knowledgeRoot, 'traces')).filter((name) => name.endsWith('.log.jsonl')).map((name) => ({ file: join(paths.knowledgeRoot, 'traces', name), run: stemOf(name), unit: null }));
    case 'fill':
      return namesIn(traces).filter((name) => name.endsWith('.log.jsonl')).map((name) => ({ file: join(traces, name), run: stemOf(name), unit: null }));
    case 'plugin':
      return namesIn(traces).filter((name) => name.endsWith('.plugins'))
        .flatMap((folder) => namesIn(join(traces, folder)).filter((name) => name.endsWith('.log')).map((name) => ({ file: join(traces, folder, name), run: stemOf(folder), unit: name.slice(0, -'.log'.length) })));
    case 'agent':
      return namesIn(traces).filter((name) => name.endsWith('.agents'))
        .flatMap((folder) => namesIn(join(traces, folder)).filter((name) => name.endsWith('.json')).map((name) => ({ file: join(traces, folder, name), run: stemOf(folder), unit: null })));
    case 'store':
      return [{ file: join(paths.store, 'postgres.log'), run: null, unit: null }];
    case 'trace':
      // A run named asks for its spans alone; without one the newest few traces stand, since a trace is evidence and
      // not an archive.
      return namesIn(traces).filter((name) => name.endsWith('.jsonl') && !name.endsWith('.log.jsonl'))
        .slice(-bound)
        .map((name) => ({ file: join(traces, name), run: stemOf(name), unit: null }));
  }
}

/** One structured log file (`obs/log.ts`) as entries. */
function entriesOfLogFile(file: string, run: string | null, source: 'fill' | 'engine'): { entries: LogEntry[]; cut: boolean } {
  const read = readTail(file);
  const entries: LogEntry[] = [];
  const skip = new Set(['time', 'level', 'message', 'error']);
  for (const [index, line] of read.text.split('\n').entries()) {
    if (line.trim() === '') continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (record === null || typeof record !== 'object' || typeof record['message'] !== 'string') continue;
    const time = typeof record['time'] === 'string' ? Date.parse(record['time']) : Number.NaN;
    const error = record['error'] as { name?: unknown; message?: unknown; stack?: unknown } | undefined;
    const detail = error === undefined ? null : cutText(typeof error.stack === 'string' ? error.stack : typeof error.message === 'string' ? error.message : '');
    const event = engineEventOf(record['message']);
    // An error's place stands where it is written: at the message's own head, or in the cause the event carries as an
    // argument (`the plugin session failed: src/x.ts:1: …`), which is where a family's file and line are.
    const own = placeOf(record['message']);
    const place = own.file !== null || event?.arguments['detail'] === undefined ? own : placeOf(event.arguments['detail']);
    entries.push({
      id: `${run ?? ''}:${basename(file)}:${String(index)}`,
      at: Number.isFinite(time) ? time : null,
      level: levelOf(record.level),
      source,
      run,
      unit: typeof record['unitId'] === 'string' ? record['unitId'] : null,
      message: cutText(record['message']).text,
      code: event?.code ?? null,
      arguments: event?.arguments ?? {},
      quoted: event === null,
      file: place.file,
      line: place.line,
      path: typeof record['path'] === 'string' ? record['path'] : null,
      detail: detail?.text ?? null,
      cut: detail?.cut ?? false,
      fields: contextOf(record, skip),
    });
  }
  return { entries, cut: read.cut };
}

/** One plugin's standard error as entries: one entry per line, the time the file was last written. */
function entriesOfPluginLog(file: string, run: string | null, unit: string | null): { entries: LogEntry[]; cut: boolean } {
  const read = readTail(file);
  const at = lastWritten(file);
  const entries: LogEntry[] = [];
  for (const [index, line] of read.text.split('\n').entries()) {
    if (line.trim() === '') continue;
    const held = cutText(line, MAX_LINE_CHARACTERS);
    entries.push({
      id: `${run ?? ''}:${unit ?? ''}:${basename(file)}:${String(index)}`,
      at, level: 'info', source: 'plugin', run, unit,
      message: held.text, code: null, arguments: {}, quoted: true, file: null, line: null, path: null,
      detail: held.cut ? held.text : null, cut: held.cut, fields: {},
    });
  }
  return { entries, cut: read.cut };
}

/** One run's spans as entries: a span's name, its duration and its status, with its attributes as context. */
function entriesOfTraceFile(file: string, run: string | null): { entries: LogEntry[]; cut: boolean } {
  const read = readTail(file);
  const entries: LogEntry[] = [];
  for (const [index, line] of read.text.split('\n').entries()) {
    if (line.trim() === '') continue;
    let span: { name?: unknown; startTimeUnixNano?: unknown; endTimeUnixNano?: unknown; status?: { code?: unknown }; attributes?: { key?: unknown; value?: unknown }[] };
    try { span = JSON.parse(line) as typeof span; } catch { continue; }
    if (typeof span.name !== 'string') continue;
    const start = Number(span.startTimeUnixNano) / 1e6;
    const end = Number(span.endTimeUnixNano) / 1e6;
    const fields: Record<string, string> = {};
    for (const attribute of span.attributes ?? []) {
      if (typeof attribute.key !== 'string' || secretField(attribute.key)) continue;
      const value = attribute.value as Record<string, unknown> | undefined;
      const held = value === undefined ? '' : typeof value['stringValue'] === 'string' ? value['stringValue'] : typeof value['intValue'] === 'string' ? value['intValue'] : typeof value['boolValue'] === 'boolean' ? String(value['boolValue']) : '';
      if (held !== '') fields[attribute.key] = held;
    }
    const failed = (span.status?.code === 'STATUS_CODE_ERROR');
    entries.push({
      id: `${run ?? ''}:${basename(file)}:${String(index)}`,
      at: Number.isFinite(end) ? end : null,
      level: failed ? 'error' : 'info',
      source: 'trace', run, unit: null,
      message: `${span.name} ${Number.isFinite(start) && Number.isFinite(end) ? `${String(Math.max(0, Math.round(end - start)))} ms` : ''}`.trim(),
      code: null, arguments: {}, quoted: false,
      file: null, line: null, path: null, detail: failed ? (typeof (span.status as { message?: unknown }).message === 'string' ? (span.status as { message: string }).message : null) : null,
      cut: false, fields,
    });
  }
  return { entries, cut: read.cut };
}

/** One agent unit's exchange as entries: what it was given, each step it streamed, and what it returned. */
function entriesOfAgentFile(file: string, run: string | null): { entries: LogEntry[]; cut: boolean } {
  const text = wholeText(file);
  if (text === null) return { entries: [], cut: false };
  let record: {
    unit?: unknown; agent?: unknown; model?: unknown; state?: unknown; failure?: unknown;
    startedAt?: unknown; endedAt?: unknown; given?: { prompt?: unknown }; steps?: { at?: unknown; kind?: unknown; title?: unknown; status?: unknown; text?: unknown; detail?: unknown }[];
    returned?: { text?: unknown } | null;
  };
  try { record = JSON.parse(text) as typeof record; } catch { return { entries: [], cut: false }; }
  if (typeof record.unit !== 'string') return { entries: [], cut: false };
  const unit = record.unit;
  const entries: LogEntry[] = [];
  const label = `${typeof record.agent === 'string' ? record.agent : 'agent'}${typeof record.model === 'string' ? ` (${record.model})` : ''}`;
  const start = typeof record.startedAt === 'string' ? Date.parse(record.startedAt) : Number.NaN;
  const end = typeof record.endedAt === 'string' ? Date.parse(record.endedAt) : Number.NaN;
  const given = cutText(typeof record.given?.prompt === 'string' ? record.given.prompt : '');
  entries.push({
    id: `${run ?? ''}:${unit}:given`, at: Number.isFinite(start) ? start : null, level: 'info', source: 'agent', run, unit,
    message: `the agent ${label} was given the unit ${unit}`, code: 'agent-given', arguments: { agent: label, unit },
    quoted: false, file: null, line: null, path: null,
    detail: given.text === '' ? null : given.text, cut: given.cut, fields: {},
  });
  for (const [index, step] of (record.steps ?? []).entries()) {
    const at = typeof step.at === 'string' ? Date.parse(step.at) : Number.NaN;
    const text = typeof step.text === 'string' ? step.text : typeof step.title === 'string' ? `${step.title}${typeof step.status === 'string' ? ` (${step.status})` : ''}` : JSON.stringify(step.detail ?? step);
    const held = cutText(text);
    const stepKind = typeof step.kind === 'string' ? step.kind : 'other';
    entries.push({
      id: `${run ?? ''}:${unit}:step:${String(index)}`, at: Number.isFinite(at) ? at : null,
      level: step.status === 'failed' || step.status === 'error' ? 'warn' : 'info', source: 'agent', run, unit,
      message: `${stepKind}: ${held.text.split('\n')[0] ?? ''}`.slice(0, MAX_LINE_CHARACTERS),
      code: `agent-${stepKind}`, arguments: { text: held.text.split('\n')[0] ?? '' }, quoted: false,
      file: null, line: null, path: null,
      detail: held.text.includes('\n') || held.cut ? held.text : null, cut: held.cut, fields: {},
    });
  }
  const failed = record.state === 'failed';
  const answer = cutText(typeof record.returned?.text === 'string' ? record.returned.text : '');
  entries.push({
    id: `${run ?? ''}:${unit}:returned`, at: Number.isFinite(end) ? end : null, level: failed ? 'error' : 'info', source: 'agent', run, unit,
    message: failed ? `the agent unit ${unit} failed: ${typeof record.failure === 'string' ? record.failure : 'no cause was recorded'}` : `the agent unit ${unit} returned ${String(typeof record.returned?.text === 'string' ? record.returned.text.length : 0)} characters`,
    code: failed ? 'agent-failed' : 'agent-returned',
    arguments: failed ? { unit, detail: cutText(typeof record.failure === 'string' ? record.failure : '').text } : { unit, characters: String(typeof record.returned?.text === 'string' ? record.returned.text.length : 0) },
    quoted: false, file: null, line: null, path: null,
    detail: failed ? (typeof record.failure === 'string' ? record.failure : null) : answer.text === '' ? null : answer.text,
    cut: failed ? false : answer.cut, fields: {},
  });
  return { entries, cut: false };
}

/** The level's rank, so a quietest-level filter reads one number. */
const rankOf = (level: LogLevel): number => LOG_LEVELS.indexOf(level);

/** The entries of one file, by its source. */
function entriesOf(file: { file: string; run: string | null; unit: string | null }, source: LogSourceName): { entries: LogEntry[]; cut: boolean } | undefined {
  if (source === 'plugin') return entriesOfPluginLog(file.file, file.run, file.unit);
  if (source === 'agent') return entriesOfAgentFile(file.file, file.run);
  if (source === 'trace') return entriesOfTraceFile(file.file, file.run);
  if (source === 'store') {
    const read = readTail(file.file);
    const entries = read.text.split('\n').filter((line) => line.trim() !== '').map((line, index): LogEntry => ({
      id: `store:${basename(file.file)}:${String(index)}`, at: null, level: 'info', source: 'store', run: null, unit: null,
      message: cutText(line, MAX_LINE_CHARACTERS).text, code: null, arguments: {}, quoted: true,
      file: null, line: null, path: null, detail: null, cut: false, fields: {},
    }));
    return { entries, cut: read.cut };
  }
  return entriesOfLogFile(file.file, file.run, source);
}

/**
 * Every log of one product's store and of the knowledge root it stands in, as one page: filtered by source, by the
 * quietest level, by one run, by a text and by a moment, oldest first, so a live tail appends to what a reader sees.
 */
export function readLogs(paths: { readonly store: string; readonly knowledgeRoot: string }, query: LogQuery = {}): LogPage {
  const sources = query.sources === undefined || query.sources.length === 0 ? DEFAULT_LOG_SOURCES : query.sources;
  const limit = Math.min(MAX_PAGE, Math.max(1, whole(query.limit, DEFAULT_PAGE)));
  const text = (query.q ?? '').trim().toLowerCase();
  const names = [...new Set(sources)];
  const collected: LogEntry[] = [];
  let truncated = false;
  for (const source of names) {
    const perFile = Math.max(1, Math.ceil(MAX_ENTRIES / Math.max(1, names.length)));
    for (const file of sourceFiles(paths, source, 8)) {
      if (query.run !== undefined && file.run !== query.run) continue;
      const read = entriesOf(file, source);
      if (read === undefined) continue;
      truncated ||= read.cut;
      // The files of a source are read oldest first and the read keeps the newest lines: a log is read for its end.
      for (const entry of read.entries.slice(-perFile)) collected.push(entry);
    }
  }
  const filtered = collected.filter((entry) => {
    // One run's entries only: a source that belongs to no run (the store's own log) has nothing of a run to show.
    if (query.run !== undefined && entry.run !== query.run) return false;
    if (query.level !== undefined && rankOf(entry.level) < rankOf(query.level)) return false;
    if (query.from !== undefined && (entry.at === null || entry.at <= query.from)) return false;
    if (query.before !== undefined && (entry.at === null || entry.at >= query.before)) return false;
    if (text !== '' && !entry.message.toLowerCase().includes(text) && !(entry.detail ?? '').toLowerCase().includes(text)) return false;
    return true;
  });
  // An entry whose writer kept no time stands after the timed ones of its read: the sort is stable and the times it
  // cannot know are the tail of the list.
  const ordered = filtered.map((entry, position) => ({ entry, position }))
    .sort((left, right) => (left.entry.at ?? Number.MAX_SAFE_INTEGER) - (right.entry.at ?? Number.MAX_SAFE_INTEGER) || byCodePoint(left.entry.id, right.entry.id) || left.position - right.position)
    .map((held) => held.entry);
  const scanned = ordered.length;
  const page = ordered.slice(Math.max(0, ordered.length - limit));
  return { entries: page, more: ordered.length > page.length, scanned, truncated };
}

/**
 * One page of every log the product keeps, with what its filters offer: the runs behind the store's traces, the sources
 * and the levels. The page and the one read API answer the same shape (madarch-64o5.88).
 */
export function logsAnswer(paths: { readonly store: string; readonly knowledgeRoot: string }, query: LogQuery = {}): LogPage & { readonly runs: readonly string[]; readonly sources: readonly string[]; readonly levels: readonly string[] } {
  return { ...readLogs(paths, query), runs: logRuns(paths.store), sources: [...LOG_SOURCES], levels: [...LOG_LEVELS] };
}

/** The known runs' ids behind one store's traces, newest first, for a filter to offer. */
export function logRuns(store: string, limit = 50): string[] {
  const traces = join(store, 'traces');
  const names = namesIn(traces);
  const runs = new Set<string>();
  for (const name of names) {
    if (name.endsWith('.log.jsonl') || (name.endsWith('.jsonl') && !name.endsWith('.log.jsonl'))) runs.add(stemOf(name));
    else if (name.endsWith('.plugins') || name.endsWith('.agents')) runs.add(stemOf(name));
  }
  return [...runs].sort(byCodePoint).reverse().slice(0, limit);
}
