/**
 * Retention of the raw telemetry a store keeps (decision 0039, items 11 and 33): the spans and logs of a run
 * under `<store>/traces`, and the agent journal under `<store>/journal`, are raw streams and not facts — what a
 * run did that matters is in the graph. A machine's settings say how long they stand and how many bytes they may
 * take, and the oldest records go first whichever limit is reached.
 *
 * The defaults are the owner's: the most detailed logs stand three days («Пусть у нас очень подробные логи там
 * хранятся 3 дня. Можно ограничить еще по размеру, по возрасту.»). The byte budget is an explicit machine
 * setting and is not guessed here: a machine that names none is bounded by age alone. The count of runs
 * (`traceRuns`) is the older bound and stands beside them.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { trace as otelTrace } from '@opentelemetry/api';

/** How long the most detailed raw records stand when a machine names no other bound: three days. */
export const DEFAULT_RAW_DAYS = 3;

/** What one machine's settings say about the raw telemetry it keeps. */
export interface RawRetention {
  /** How long one record stands, in days: `traceRetentionDays`, three when it is left out. */
  readonly days: number;
  /** How many bytes the raw records may take together, or null for no byte bound (`traceRetentionBytes`). */
  readonly bytes: number | null;
  /** How many runs' traces stand at most (`traceRuns`, twenty when it is left out). */
  readonly runs: number;
}

/** The raw telemetry a store keeps, by the folder it stands in: spans and logs, and the agent journal. */
export const RAW_TELEMETRY_FOLDERS: readonly string[] = ['traces', 'journal'];

/** What one sweep removed, and what it kept. */
export interface RetentionSweep {
  readonly removed: readonly string[];
  readonly keptBytes: number;
  readonly keptRuns: number;
}

/**
 * Removes the raw records a machine's retention says go, oldest first: by age, then by total size, then by the
 * number of runs. Whichever bound is reached first removes the oldest records first; a record inside every bound
 * stays, and a run's log goes with its trace. Answers what it removed, so a caller can say so, and the bytes and
 * runs it kept. The whole sweep is one span: what it read, what it removed and what it left.
 */
export function sweepRawTelemetry(store: string, retention: RawRetention, now: number = Date.now()): RetentionSweep {
  const span = otelTrace.getTracer('madarch', '1.0.0').startSpan('telemetry.retention', {
    attributes: { 'madarch.store': store, 'madarch.retention.days': retention.days, 'madarch.retention.bytes': retention.bytes ?? -1, 'madarch.retention.runs': retention.runs },
  });
  const removed: string[] = [];
  let keptBytes = 0;
  let keptRuns = 0;
  try {
    const oldest = now - Math.max(0, retention.days) * 24 * 60 * 60 * 1000;
    for (const name of RAW_TELEMETRY_FOLDERS) {
      const folder = join(store, name);
      if (!existsSync(folder)) continue;
      // Every record of the folder, oldest first: a trace before its log, and code point order to break a tie.
      const records: { file: string; at: number; bytes: number; trace: boolean }[] = [];
      for (const file of readdirSync(folder)) {
        if (!file.endsWith('.jsonl')) continue;
        const path = join(folder, file);
        const stat = statSync(path);
        records.push({ file: path, at: stat.mtimeMs, bytes: stat.size, trace: !file.endsWith('.log.jsonl') });
      }
      records.sort((left, right) => left.at - right.at || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
      const traces = records.filter((record) => record.trace);
      // The count bound keeps the newest `runs` traces; a log goes with the trace it belongs to.
      const keptTraces = new Set(traces.slice(Math.max(0, traces.length - retention.runs)).map((record) => record.file));
      const gone = new Set<string>();
      let bytes = records.reduce((sum, record) => sum + record.bytes, 0);
      for (const record of records) {
        if (gone.has(record.file)) continue;
        const traceOf = record.trace ? record.file : `${record.file.slice(0, -'.log.jsonl'.length)}.jsonl`;
        const byAge = record.at < oldest;
        const byRuns = !keptTraces.has(traceOf);
        const byBytes = retention.bytes !== null && bytes > retention.bytes;
        if (!byAge && !byRuns && !byBytes) continue;
        // A trace goes with its log: the pair is one run's record, and half of it states nothing.
        const log = record.trace ? `${traceOf.slice(0, -'.jsonl'.length)}.log.jsonl` : null;
        const withLog = record.trace ? [record, records.find((other) => !other.trace && other.file === log)] : [record];
        for (const held of withLog) {
          if (held === undefined || gone.has(held.file)) continue;
          rmSync(held.file, { force: true });
          gone.add(held.file);
          removed.push(held.file);
          bytes -= held.bytes;
          // One run's own records stand beside its trace (madarch-64o5.88): its agent units' exchanges and its plugin
          // runs' standard error go with it, as its log does.
          if (held.trace) {
            const stem = held.file.slice(0, -'.jsonl'.length);
            for (const suffix of ['.agents', '.plugins']) {
              const beside = `${stem}${suffix}`;
              if (!existsSync(beside)) continue;
              rmSync(beside, { recursive: true, force: true });
              removed.push(beside);
            }
          }
        }
      }
      const standing = records.filter((record) => !gone.has(record.file));
      keptBytes += standing.reduce((sum, record) => sum + record.bytes, 0);
      keptRuns += standing.filter((record) => record.trace).length;
    }
    span.setAttribute('madarch.retention.removed', removed.length);
    span.setAttribute('madarch.retention.keptBytes', keptBytes);
    return { removed, keptBytes, keptRuns };
  } finally {
    span.end();
  }
}
