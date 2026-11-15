/**
 * Where one run's own records stand beside its trace (madarch-64o5.88): a folder per run, named by the run id's stem,
 * holding one file per agent unit's exchange and one per plugin run's standard error. The trace's trimming takes the
 * folders with the trace, and the logs page reads them from the same place the trace stands under.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { traceStem } from '../obs/trace.js';

/** One run's agent exchanges: one JSON file per agent unit. */
export function agentExchangeFolder(tracesFolder: string, run: string): string {
  return join(tracesFolder, `${traceStem(run)}.agents`);
}

/** One run's plugin logs: one text file per unit, the tail of what the plugin wrote on standard error. */
export function pluginLogFolder(tracesFolder: string, run: string): string {
  return join(tracesFolder, `${traceStem(run)}.plugins`);
}

/**
 * The file one unit's record is kept in, under one run's folder: its unit id made a file name, and a digest so that two
 * unit ids which differ only in a character a file name cannot hold stay two files.
 */
export function recordFileName(unit: string, extension: string): string {
  const stem = [...unit].map((character) =>
    (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
    (character >= '0' && character <= '9') || '._-'.includes(character) ? character : '-').join('');
  return `${stem}-${createHash('sha256').update(unit).digest('hex').slice(0, 8)}.${extension}`;
}
