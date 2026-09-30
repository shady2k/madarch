/**
 * The server's data folder: one SQLite history file per source, named
 * after the source safely (no path separator or other unsafe byte ever
 * reaches the file system), with a small JSON sidecar beside each history
 * file recording the source's name and its current head — the newest
 * commit by commit time, code-point tie-break — so a restart knows every
 * file's source and `GET /sources` can answer without opening a history.
 *
 * The file name is derived by percent-encoding every byte the file system
 * should not see — the upper-case letters included, so a file name never
 * depends on letter case and two names that differ only in case never
 * share one file on a case-insensitive volume. The encoding is injective
 * (two sources never share a file, `a/b` and `a%2Fb` included) and
 * reversible, but the sidecar, not the name, is what a restart reads the
 * source's identity from.
 *
 * The folder is the server's own store: at start, every `<stem>.json` must
 * have its `<stem>.sqlite` beside it and the other way round, every
 * sidecar must name the same source its file name decodes to, and anything
 * else is refused with the file named. Files that are neither a history
 * nor a sidecar (`README.md`, a leftover `.json.tmp` from an interrupted
 * sidecar write) are ignored.
 *
 * One `createSourceStores` per folder; a second instance on the same
 * folder is not supported. Not multi-process safe: the sidecar is written
 * after the history's own transaction has committed, so a crash between
 * the two can leave a history file without its sidecar, which the next
 * start refuses until the folder is repaired by hand.
 */
import { join } from 'node:path';
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { createSqliteHistory } from '../adapters/sqlite-history.js';
import type { Clock, HistoryStore, StoreInput, StoreResult } from '../history/types.js';
import { byCodePoint } from '../model/order.js';

/** The bytes that may appear in a file name as they are: the lower-case unreserved bytes of RFC 3986 minus `~` (kept out on purpose; it encodes fine). Upper-case letters encode too, so a stem never depends on case; a stem holding a raw upper-case letter, or a lower-case `%xx` escape, was not written by this server. */
const UNRESERVED = /^[a-z0-9._-]$/;

/**
 * The longest encoded file-name stem the server accepts, in bytes: three
 * bytes per unsafe character must stay far under any file system's
 * 255-byte name limit once the `.sqlite`/`.json` suffixes are added. A
 * source whose name encodes longer is refused, naming the field and the
 * limit — never truncated (a truncated name could collide with another).
 */
export const MAX_ENCODED_STEM_BYTES = 200;

export interface SourceStoresOptions {
  /** The folder the histories and their sidecars live in; it must exist. */
  dataFolder: string;
  /** Supplies recorded time's "now" for the histories and the heads; tests inject a fake clock. */
  clock: Clock;
}

/** One source's current head: the newest version stored for it, by commit order. */
export interface SourceHead {
  source: string;
  commit: string;
  /** The commit's time, UTC epoch milliseconds. */
  committedAt: number;
  /** When that version was stored, UTC epoch milliseconds. */
  storedAt: number;
}

/** What one store against a source's history did, and whether the commit was new to it. */
export interface SourceStoreResult {
  result: StoreResult;
  wasNew: boolean;
}

export interface SourceStores {
  /** The source's history, opening (and creating) its file on first use. */
  historyOf(source: string): HistoryStore;
  /**
   * Stores one version in the source's history and, when the store
   * succeeded, brings the sidecar to the source's head — on every store,
   * new or already stored, so a sidecar write that failed after the
   * commit was stored is healed by storing that commit again: the
   * history, not the sidecar, is the truth. `input` must first pass
   * `sourceNameProblem` (the HTTP layer validates every field before
   * calling); a store reached with a name that fails it is a caller
   * defect and throws.
   */
  store(input: StoreInput): SourceStoreResult;
  /** Every source's head, in code point order of the names. */
  heads(): SourceHead[];
  /** Closes every open history. */
  close(): void;
}

/**
 * What is wrong with a source name a request carries, for the caller to
 * refuse with; `undefined` when the name is usable. Most strings are
 * encodable — separators, dots, non-ASCII letters — so besides
 * emptiness and the encoded-length limit, only a control character can
 * be wrong.
 */
export function sourceNameProblem(source: unknown): string | undefined {
  if (typeof source !== 'string') {
    return `"source" must be a string naming the source the model belongs to, like "github.com/shady2k/nocx"`;
  }
  if (source.length === 0) {
    return `"source" is empty: the source's name is required, like "github.com/shady2k/nocx"`;
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(source)) {
    return `"source" must not hold a control character, but ${JSON.stringify(source)} does: a control character could split the log line the request is written to; use a name without them, like "github.com/shady2k/nocx"`;
  }
  const encoded = encodeSourceName(source);
  if (Buffer.byteLength(encoded) > MAX_ENCODED_STEM_BYTES) {
    return `"source" is too long: the name ${JSON.stringify(source.slice(0, 64))}… encodes to a file name past the ${MAX_ENCODED_STEM_BYTES}-byte limit; use a shorter source name`;
  }
  return undefined;
}

/** The file-name stem for a source's name: every byte the file system should not see, percent-encoded. */
function encodeSourceName(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let out = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    out += UNRESERVED.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** The source name a stem decodes to, or `undefined` when the stem is not one this server wrote. */
function decodeSourceName(stem: string): string | undefined {
  const bytes: number[] = [];
  for (let i = 0; i < stem.length; i++) {
    const ch = stem[i]!;
    if (ch === '%') {
      const hex = stem.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) return undefined;
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else if (UNRESERVED.test(ch)) {
      bytes.push(ch.charCodeAt(0));
    } else {
      return undefined;
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}

/** One sidecar's content as the JSON holds it, before the head bookkeeping trusts it. */
interface SidecarFile {
  source: unknown;
  commit: unknown;
  committedAt: unknown;
  storedAt: unknown;
}

export function createSourceStores(options: SourceStoresOptions): SourceStores {
  const { dataFolder, clock } = options;

  let stat: Stats;
  try {
    stat = statSync(dataFolder);
  } catch (error) {
    throw new Error(`the data folder "${dataFolder}" cannot be read: ${(error as Error).message}; the server keeps its sources' history files there`, { cause: error });
  }
  if (!stat.isDirectory()) {
    throw new Error(`the data folder "${dataFolder}" is not a folder; the server keeps its sources' history files there`);
  }

  const jsonStems = new Set<string>();
  const sqliteStems = new Set<string>();
  for (const name of readdirSync(dataFolder)) {
    if (name.endsWith('.json')) jsonStems.add(name.slice(0, -'.json'.length));
    if (name.endsWith('.sqlite')) sqliteStems.add(name.slice(0, -'.sqlite'.length));
  }
  const problems: string[] = [];
  for (const stem of jsonStems) {
    if (!sqliteStems.has(stem)) {
      problems.push(`the data folder holds "${stem}.json" but no "${stem}.sqlite" beside it: the source's history file is missing`);
    }
  }
  for (const stem of sqliteStems) {
    if (!jsonStems.has(stem)) {
      problems.push(`the data folder holds the history file "${stem}.sqlite" but no "${stem}.json" beside it naming its source: restore the sidecar or remove the file, then start again`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '));

  const heads = new Map<string, SourceHead>();
  const histories = new Map<string, HistoryStore>();

  for (const stem of jsonStems) {
    const path = join(dataFolder, `${stem}.json`);
    let file: SidecarFile;
    try {
      file = JSON.parse(readFileSync(path, 'utf8')) as SidecarFile;
    } catch (error) {
      throw new Error(`the sidecar "${path}" is not valid JSON: ${(error as Error).message}`, { cause: error });
    }
    const head = headOfSidecar(file, path);
    const decoded = decodeSourceName(stem);
    if (decoded === undefined) {
      throw new Error(`the sidecar "${path}" has a file name that does not decode to a source name; the folder was not written by this server`);
    }
    if (decoded !== head.source) {
      throw new Error(`the sidecar "${path}" names its source "${head.source}" but its file name decodes to "${decoded}": the sidecar and the file name disagree`);
    }
    heads.set(head.source, head);
  }

  function historyOf(source: string): HistoryStore {
    let history = histories.get(source);
    if (history === undefined) {
      history = createSqliteHistory({ path: join(dataFolder, `${encodeSourceName(source)}.sqlite`), clock });
      histories.set(source, history);
    }
    return history;
  }

  /** Whether the candidate head is newer than the stored one, by commit order: time first, code-point commit id to break a tie. */
  function isNewerHead(candidate: { commit: string; committedAt: number }, stored: SourceHead): boolean {
    if (candidate.committedAt !== stored.committedAt) return candidate.committedAt > stored.committedAt;
    return byCodePoint(candidate.commit, stored.commit) > 0;
  }

  function writeSidecar(stem: string, head: SourceHead): void {
    // Write beside the target and rename: an interrupted write leaves a
    // `.json.tmp` the next start ignores, never a half-written sidecar.
    const tmp = join(dataFolder, `${stem}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(head));
    renameSync(tmp, join(dataFolder, `${stem}.json`));
  }

  function store(input: StoreInput): SourceStoreResult {
    const problem = sourceNameProblem(input.source);
    if (problem !== undefined) throw new Error(`the store was called with a source that must be refused first: ${problem}`);

    const history = historyOf(input.source);
    const wasNew = !history.hasCommit(input.source, input.commit);
    const result = history.store(input);

    if (result.errors.length === 0) {
      const candidate: SourceHead = {
        source: input.source,
        commit: input.commit,
        committedAt: input.committedAt,
        // Every opened row carries the store's own recorded moment; a
        // store that opens nothing (a model with no assertions at all)
        // falls back to the clock, the best the sidecar can say.
        storedAt: result.opened[0]?.recordedFrom ?? clock.now(),
      };
      const stored = heads.get(input.source);
      if (stored === undefined || isNewerHead(candidate, stored)) {
        writeSidecar(encodeSourceName(input.source), candidate);
        heads.set(input.source, candidate);
      }
    }
    return { result, wasNew };
  }

  function headsInOrder(): SourceHead[] {
    return [...heads.values()].sort((a, b) => byCodePoint(a.source, b.source));
  }

  function close(): void {
    for (const history of histories.values()) history.close();
    histories.clear();
  }

  return { historyOf, store, heads: headsInOrder, close };
}

/** One sidecar's content, checked field by field so a corrupt one is refused naming its file and its field. */
function headOfSidecar(file: SidecarFile, path: string): SourceHead {
  if (typeof file.source !== 'string' || file.source.length === 0) {
    throw new Error(`the sidecar "${path}" does not name a source: "source" must be a non-empty string`);
  }
  if (typeof file.commit !== 'string' || file.commit.length === 0) {
    throw new Error(`the sidecar "${path}" does not name the source's head: "commit" must be a non-empty string`);
  }
  if (typeof file.committedAt !== 'number' || !Number.isFinite(file.committedAt)) {
    throw new Error(`the sidecar "${path}" does not say when the head was committed: "committedAt" must be a number of epoch milliseconds`);
  }
  if (typeof file.storedAt !== 'number' || !Number.isFinite(file.storedAt)) {
    throw new Error(`the sidecar "${path}" does not say when the head was stored: "storedAt" must be a number of epoch milliseconds`);
  }
  return { source: file.source, commit: file.commit, committedAt: file.committedAt, storedAt: file.storedAt };
}

