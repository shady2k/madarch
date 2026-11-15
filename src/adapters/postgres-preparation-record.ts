/**
 * The records madarch writes beside a store's data directory about its preparation, and the reading of them that every
 * caller shares. They live here, apart from the cluster's own module, so a caller that only asks "is this store being
 * prepared?" — the Windows stop, say — does not load PostgreSQL's client, its library calls and the release identity.
 *
 * `madarch.preparing` is written before an initdb is spawned and names it once it has a pid; `madarch.prepared` is
 * written once that initdb ends. A folder that holds files and neither record is no preparation of ours.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Our record of a preparation under way, beside the data directory. */
export const PREPARING_FILE = 'madarch.preparing';
/** Our record that a preparation finished, beside the data directory. */
export const PREPARED_FILE = 'madarch.prepared';

/** What `madarch.preparing` holds: who is making the cluster, and the initdb it spawned, once there is one. */
export interface PreparingRecord {
  readonly version: string;
  readonly startedAt: string;
  readonly initdb?: { readonly pid: number; readonly startTime?: string };
}

export function preparingRecordPath(dataDir: string): string { return join(dirname(dataDir), PREPARING_FILE); }
export function preparedRecordPath(dataDir: string): string { return join(dirname(dataDir), PREPARED_FILE); }

/** Whether a preparation madarch started is under way in this data directory: its record is there and no prepared one is. */
export function preparationInProgress(dataDir: string): boolean {
  return existsSync(preparingRecordPath(dataDir)) && !existsSync(preparedRecordPath(dataDir));
}

/**
 * The arguments of a command line as the program receives them: `CommandLineToArgvW`'s rules on Windows — a run of
 * backslashes before a quote is halved and the quote is literal when the run is odd, otherwise it opens or closes
 * quoting — and plain whitespace splitting elsewhere. A program's own command line is `argv` on POSIX, and this is how
 * the same question is asked of the text Windows keeps.
 */
export function commandLineArguments(commandLine: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return commandLine.split(' ').filter((part) => part !== '');
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < commandLine.length; index++) {
    const character = commandLine[index]!;
    if (character === '\\') {
      let run = 0;
      while (commandLine[index] === '\\') { run++; index++; }
      const next = commandLine[index];
      if (next === '"') {
        current += '\\'.repeat(Math.floor(run / 2));
        if (run % 2 === 1) { current += '"'; index++; } else { quoted = !quoted; index++; }
      } else { current += '\\'.repeat(run); index--; }
      started = true;
      continue;
    }
    if (character === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && (character === ' ' || character === '\t')) {
      if (started) { args.push(current); current = ''; started = false; }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

/** A path as this platform compares two of them: Windows folds case and separators, POSIX reads the real path. */
export function comparablePath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path.replace(/\//g, '\\').toLowerCase();
  try { return realpathSync(path); } catch { return path; }
}

/**
 * Whether this program is initdb or PostgreSQL running on exactly this data directory. The data directory is the one the
 * last `-D <path>`, `-D<path>` or `--pgdata=<path>` names — PostgreSQL reads the last, so `-D pgdata -D other` serves
 * `other` — and it must be that folder, never a folder whose name merely begins with it (`C:\\store\\pgdata-other` is
 * another store's server). A program with no explicit one is never ours: its `PGDATA` is not this process's to read.
 */
export function runsOnDataDir(program: string, argv: readonly string[], dataDir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!/(?:^|[\\/])(?:initdb|postgres)(?:\.exe)?$/i.test(program)) return false;
  let named: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '-D' || argument === '--pgdata') {
      if (argv[index + 1] !== undefined) { named = argv[index + 1]; index++; }
      continue;
    }
    if (argument.startsWith('-D') && argument.length > 2) { named = argument.slice(2); continue; }
    if (argument.startsWith('--pgdata=')) named = argument.slice('--pgdata='.length);
  }
  return named !== undefined && comparablePath(named, platform) === comparablePath(dataDir, platform);
}
