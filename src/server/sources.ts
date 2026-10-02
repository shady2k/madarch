/**
 * The server's data folder: one SQLite history file per source, named
 * after the source safely (no path separator or other unsafe byte ever
 * reaches the file system), with a small JSON sidecar beside each history
 * file recording the source's name, its id — assigned by the server on the
 * source's first send, an opaque string the name plays no part in — and
 * its current head — the newest commit by commit time, code-point
 * tie-break — so a restart knows every file's source and `GET /sources`
 * can answer without opening a history.
 *
 * A renamed source keeps its id: the rename claim moves the history and
 * its sidecar to the new name and keeps the old name among the sidecar's
 * former names, in code point order. A former name is retired, never a
 * source of its own again: a store reached with one is refused naming
 * the rename, so one repository never grows a second id under its old
 * name, whatever restarts come between.
 *
 * The file name is derived by percent-encoding every byte the file system
 * should not see — the upper-case letters included, so a file name never
 * depends on letter case and two names that differ only in case never
 * share one file on a case-insensitive volume. The encoding is injective
 * (two sources never share a file, `a/b` and `a%2Fb` included) and
 * reversible, but the sidecar, not the name, is what a restart reads the
 * source's identity from.
 *
 * The folder is the server's own store, and the history is its truth: at
 * start every history is opened and its sidecar brought to the head the
 * history itself holds — a sidecar that went missing or was left stale
 * by an interrupted write is repaired from the history (its one source
 * name, its head by the history's own commit order) and the repair is
 * logged. What cannot be named is refused with the file named: a sidecar
 * without its history, a history holding no source or more than one, a
 * sidecar and a history that disagree about the source, a stem this
 * server never wrote. Files that are neither a history nor a sidecar
 * (`README.md`, a leftover `.json.tmp` from an interrupted sidecar
 * write) are ignored.
 *
 * One `createSourceStores` per folder; a second instance on the same
 * folder is not supported. Not multi-process safe: the sidecar is
 * written after the history's own transaction has committed, so a crash
 * between the two can leave a history file without its sidecar or with
 * a stale one — which the next start repairs from the history, since
 * the history, not the sidecar, is the truth.
 */
import { join } from 'node:path';
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  /** Where startup repair lines go; standard output by default. */
  log?: (line: string) => void;
}

/** One source's current head: the newest version stored for it, by commit order. */
export interface SourceHead {
  source: string;
  /** The id the server assigned the source on its first send; an opaque string kept across sends and restarts, never derived from the name. */
  id: string;
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
   * `sourceNameProblem`, and must name a source that exists — never one
   * a rename retired (the HTTP layer refuses both before calling); a
   * store reached with a name failing either is a caller defect and
   * throws, naming what must be refused.
   */
  store(input: StoreInput): SourceStoreResult;
  /**
   * Records a rename claim: binds the new name to the id, moving the
   * history and its sidecar to the new name and retiring the old one —
   * the id, the head and every stored commit stay exactly as they were.
   * The HTTP layer refuses an unknown id, and a new name another source
   * holds or retired, before calling; a rename reached with either is a
   * caller defect and throws, naming what must be refused. Renaming a
   * source to one of its own former names is a claim like any other.
   */
  rename(id: string, to: string): { formerSource: string };
  /** The head of the source a retired name used to name, or `undefined` when no rename gave the name up. */
  retiredHead(name: string): SourceHead | undefined;
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
    // Cut at the 64th code point, never inside one: the name is counted
    // the way the code-point rules count it, so an astral character is
    // one unit, never a surrogate half. Only the first 64 code points
    // are read — a name can be as long as the body limit allows, so no
    // copy of the whole of it is made just to echo a cut of it.
    let echoed = '';
    let codePoints = 0;
    for (const each of source) {
      if (codePoints === 64) break;
      echoed += each;
      codePoints += 1;
    }
    return `"source" is too long: the name ${JSON.stringify(echoed)}… encodes to a file name past the ${MAX_ENCODED_STEM_BYTES}-byte limit; use a shorter source name`;
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
  /** Absent in a sidecar an older server wrote; present, an array of non-empty strings — every name the source gave up, its current name never among them. */
  formerNames: unknown;
  /** Absent in a sidecar an older server wrote; present, a non-empty string. */
  id: unknown;
  commit: unknown;
  committedAt: unknown;
  storedAt: unknown;
}

export function createSourceStores(options: SourceStoresOptions): SourceStores {
  const { dataFolder, clock } = options;
  const log = options.log ?? ((line: string) => console.log(line));

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
  if (problems.length > 0) throw new Error(problems.join('; '));

  const heads = new Map<string, SourceHead>();
  const histories = new Map<string, HistoryStore>();
  /** Every source's former names, its current name left out, in code point order — what the sidecar holds and a restart reads back. */
  const formerNames = new Map<string, string[]>();
  /** A retired name — one a rename gave up — and the head of the source it used to name: a store reached with it is refused, so the old name never grows a second id. */
  const retired = new Map<string, SourceHead>();

  /** Opens one history file, refusing with the file named when SQLite cannot. */
  function openHistory(stem: string): HistoryStore {
    try {
      return createSqliteHistory({ path: join(dataFolder, `${stem}.sqlite`), clock });
    } catch (error) {
      throw new Error(`the history file "${stem}.sqlite" cannot be opened: ${(error as Error).message}`, { cause: error });
    }
  }

  /** The head a history itself holds: the newest of its commits by the history's own commit order. */
  function newestCommit(source: string, id: string, history: HistoryStore): SourceHead {
    const commits = history.commits(source);
    const last = commits[commits.length - 1]!;
    return { source, id, commit: last.commit, committedAt: last.committedAt, storedAt: last.storedAt };
  }

  /** Whether the two heads say the same thing about the same version: the version fields only, never the id. */
  function sameHead(a: SourceHead, b: Pick<SourceHead, 'commit' | 'committedAt' | 'storedAt'>): boolean {
    return a.commit === b.commit && a.committedAt === b.committedAt && a.storedAt === b.storedAt;
  }

  for (const stem of jsonStems) {
    const path = join(dataFolder, `${stem}.json`);
    let file: SidecarFile;
    try {
      file = JSON.parse(readFileSync(path, 'utf8')) as SidecarFile;
    } catch (error) {
      throw new Error(`the sidecar "${path}" is not valid JSON: ${(error as Error).message}`, { cause: error });
    }
    const sidecarHead = headOfSidecar(file, path);
    const sidecarId = idOfSidecar(file, path);
    const sidecarNames = formerNamesOfSidecar(file, path, sidecarHead.source);
    const decoded = decodeSourceName(stem);
    if (decoded === undefined) {
      throw new Error(`the sidecar "${path}" has a file name that does not decode to a source name; the folder was not written by this server`);
    }
    const history = openHistory(stem);
    const held = history.sources();
    if (held.length !== 1) {
      history.close();
      if (decoded !== sidecarHead.source) {
        throw new Error(`the sidecar "${path}" names its source "${sidecarHead.source}" but its file name decodes to "${decoded}": the sidecar and the file name disagree`);
      }
      const holds = held.length === 0 ? 'no source' : `the sources ${held.join(', ')}`;
      throw new Error(`the history file "${stem}.sqlite" holds ${holds}, but its sidecar "${stem}.json" names "${sidecarHead.source}": the sidecar and the history disagree`);
    }
    const source = held[0]!;
    const persisted = history.registry(source);
    if (decoded !== source || (sidecarHead.source !== source && persisted === undefined)) {
      history.close();
      if (decoded !== sidecarHead.source) {
        throw new Error(`the sidecar "${path}" names its source "${sidecarHead.source}" but its file name decodes to "${decoded}": the sidecar and the file name disagree`);
      }
      throw new Error(`the history file "${stem}.sqlite" holds the sources ${source}, but its sidecar "${stem}.json" names "${sidecarHead.source}": the sidecar and the history disagree`);
    }
    const id = persisted?.id ?? sidecarId ?? randomUUID();
    const names = persisted?.formerNames ?? sidecarNames;
    const trueHead = newestCommit(source, id, history);
    history.setRegistry(source, id, names);
    const namesDiffer = sidecarNames.length !== names.length || sidecarNames.some((name, index) => name !== names[index]);
    if (sidecarHead.source !== source || !sameHead(trueHead, sidecarHead) || persisted === undefined || sidecarId !== id || namesDiffer) {
      writeSidecar(stem, trueHead, names);
      log(sidecarId === undefined
        ? `assigned the source id ${JSON.stringify(id)} to "${source}" and repaired the sidecar from history`
        : `repaired the sidecar "${stem}.json" from history for source "${source}"`);
    }
    heads.set(source, trueHead);
    histories.set(source, history);
    formerNames.set(source, names);
  }

  for (const stem of sqliteStems) {
    if (jsonStems.has(stem)) continue;
    const history = openHistory(stem);
    const names = history.sources();
    if (names.length !== 1) {
      history.close();
      const holds = names.length === 0 ? 'no source it could be named from' : `the sources ${names.join(', ')}`;
      throw new Error(`the data folder holds the history file "${stem}.sqlite" but no "${stem}.json" beside it, and the history holds ${holds}: a history one sidecar is to name must hold exactly that one source`);
    }
    const source = names[0]!;
    const decoded = decodeSourceName(stem);
    if (decoded === undefined || decoded !== source) {
      history.close();
      throw new Error(`the data folder holds the history file "${stem}.sqlite" but no "${stem}.json" beside it, and the file name does not decode to the history's source "${source}": the folder was not written by this server`);
    }
    const registry = history.registry(source);
    if (registry === undefined) {
      history.close();
      throw new Error(`the data folder holds the history file "${stem}.sqlite" but no "${stem}.json" beside it, and the history has no persisted source id or former names to rebuild identity faithfully`);
    }
    const head = newestCommit(source, registry.id, history);
    writeSidecar(stem, head, registry.formerNames);
    log(`repaired the data folder: the history file "${stem}.sqlite" had no sidecar beside it; it holds the source "${source}" at its head ${JSON.stringify(head.commit)} at ${new Date(head.committedAt).toISOString()}`);
    heads.set(source, head);
    histories.set(source, history);
    formerNames.set(source, registry.formerNames);

  }

  // Every former name a sidecar holds becomes retired: it maps to the
  // head of the source that gave it up, so a request under it is refused
  // naming the rename, and one repository never grows a second id under
  // an old name. A name two sources hold — both current, one current and
  // one former, or both former — is a folder nothing wrote, refused
  // naming both sides.
  const ids = new Map<string, string>();
  for (const head of heads.values()) {
    const previous = ids.get(head.id);
    if (previous !== undefined) {
      const [first, second] = [previous, head.source].sort(byCodePoint);
      throw new Error(`the sidecars of "${first}" and "${second}" hold the same source id ${JSON.stringify(head.id)}: every source has one distinct id`);
    }
    ids.set(head.id, head.source);
  }
  for (const [source, names] of formerNames) {
    const head = heads.get(source)!;
    for (const name of names) {
      const holder = heads.get(name);
      if (holder !== undefined) {
        throw new Error(`the sidecar "${join(dataFolder, `${encodeSourceName(source)}.json`)}" holds "formerNames" naming "${name}", but "${name}" is the current name of the source beside it (id "${holder.id}"): a name one source gave up is no other source's name`);
      }
      const other = retired.get(name);
      if (other !== undefined) {
        const [first, second] = [source, other.source].sort(byCodePoint);
        throw new Error(`the sidecars of "${first}" and "${second}" both hold "${name}" among their "formerNames": a name one source gave up is no other source's name`);
      }
      retired.set(name, head);
    }
  }

  function historyOf(source: string): HistoryStore {
    let history = histories.get(source);
    if (history === undefined) {
      history = createSqliteHistory({ path: join(dataFolder, `${encodeSourceName(source)}.sqlite`), clock });
      histories.set(source, history);
    }
    return history;
  }


  function writeSidecar(stem: string, head: SourceHead, names: string[]): void {
    // Write beside the target and rename: an interrupted write leaves a
    // `.json.tmp` the next start ignores, never a half-written sidecar.
    const tmp = join(dataFolder, `${stem}.json.tmp`);
    writeFileSync(tmp, JSON.stringify({ ...head, formerNames: names }));
    renameSync(tmp, join(dataFolder, `${stem}.json`));
  }

  function store(input: StoreInput): SourceStoreResult {
    const problem = sourceNameProblem(input.source);
    if (problem !== undefined) throw new Error(`the store was called with a source that must be refused first: ${problem}`);
    const renamedTo = retired.get(input.source);
    if (renamedTo !== undefined) {
      throw new Error(`the store was called with a source that must be refused first: the name ${JSON.stringify(input.source)} was renamed to ${JSON.stringify(renamedTo.source)}`);
    }

    const history = historyOf(input.source);
    const identity = history.registry(input.source);
    const id = heads.get(input.source)?.id ?? identity?.id ?? randomUUID();
    const former = formerNames.get(input.source) ?? identity?.formerNames ?? [];
    const wasNew = !history.hasCommit(input.source, input.commit);
    const result = history.store(input, { id, formerNames: former });

    if (result.errors.length === 0) {
      // Reconcile from the history's commit order, not the possibly stale
      // in-memory head: a prior sidecar write may have failed.
      const latest = history.latestCommit(input.source)!;
      const candidate: SourceHead = {
        source: input.source,
        id,
        commit: latest.commit,
        committedAt: latest.committedAt,
        storedAt: latest.storedAt,
      };
      heads.set(input.source, candidate);
      writeSidecar(encodeSourceName(input.source), candidate, [...former]);
    }
    return { result, wasNew };
  }

  function headsInOrder(): SourceHead[] {
    return [...heads.values()].sort((a, b) => byCodePoint(a.source, b.source));
  }

  /**
   * Move the history and sidecar to the new filename, commit the new name
   * and registry in the history transaction, then update memory and write
   * the derived sidecar. A sidecar-write failure after commit is repaired
   * by retrying the same rename from the authoritative history.
   */
  function rename(id: string, to: string): { formerSource: string } {
    const problem = sourceNameProblem(to);
    if (problem !== undefined) throw new Error(`the rename was called with a name that must be refused first: ${problem}`);
    const head = [...heads.values()].find((each) => each.id === id);
    if (head === undefined) {
      throw new Error(`the rename was called with an id that must be refused first: no source has the id ${JSON.stringify(id)}`);
    }
    const from = head.source;
    if (from === to) {
      const history = historyOf(from);
      const registry = history.registry(from);
      if (registry === undefined || registry.id !== id) {
        throw new Error(`the history for "${from}" does not hold the source id ${JSON.stringify(id)} needed to repair its sidecar`);
      }
      const current = newestCommit(from, id, history);
      heads.set(from, current);
      formerNames.set(from, registry.formerNames);
      writeSidecar(encodeSourceName(from), current, registry.formerNames);
      return { formerSource: from };
    }
    const holder = heads.get(to);
    if (holder !== undefined) {
      throw new Error(`the rename was called with a name that must be refused first: the name ${JSON.stringify(to)} is already the name of the source with id ${JSON.stringify(holder.id)}`);
    }
    const retiredHolder = retired.get(to);
    if (retiredHolder !== undefined && retiredHolder.id !== id) {
      throw new Error(`the rename was called with a name that must be refused first: the name ${JSON.stringify(to)} was renamed away from the source with id ${JSON.stringify(retiredHolder.id)} to ${JSON.stringify(retiredHolder.source)}`);
    }

    const newHead: SourceHead = { ...head, source: to };
    const history = historyOf(from);
    const former = [...new Set([...(formerNames.get(from) ?? []), from])].filter((name) => name !== to).sort(byCodePoint);
    history.close();
    let sqliteMoved = false;
    let sidecarMoved = false;
    let renamedHistory: HistoryStore | undefined;
    try {
      renameSync(join(dataFolder, `${encodeSourceName(from)}.sqlite`), join(dataFolder, `${encodeSourceName(to)}.sqlite`));
      sqliteMoved = true;
      renameSync(join(dataFolder, `${encodeSourceName(from)}.json`), join(dataFolder, `${encodeSourceName(to)}.json`));
      sidecarMoved = true;
      renamedHistory = openHistory(encodeSourceName(to));
      renamedHistory.renameSource(from, to, { id: newHead.id, formerNames: former });
    } catch (error) {
      renamedHistory?.close();
      if (sidecarMoved) renameSync(join(dataFolder, `${encodeSourceName(to)}.json`), join(dataFolder, `${encodeSourceName(from)}.json`));
      if (sqliteMoved) renameSync(join(dataFolder, `${encodeSourceName(to)}.sqlite`), join(dataFolder, `${encodeSourceName(from)}.sqlite`));
      histories.set(from, openHistory(encodeSourceName(from)));
      throw error;
    }
    histories.delete(from);
    histories.set(to, renamedHistory!);
    formerNames.delete(from);
    formerNames.set(to, former);
    heads.delete(from);
    heads.set(to, newHead);
    for (const [name, target] of [...retired]) {
      if (target.source === from) retired.set(name, newHead);
    }
    retired.set(from, newHead);
    retired.delete(to);
    writeSidecar(encodeSourceName(to), newHead, former);
    return { formerSource: from };
  }

  function retiredHead(name: string): SourceHead | undefined {
    return retired.get(name);
  }

  function close(): void {
    for (const history of histories.values()) history.close();
    histories.clear();
  }

  return { historyOf, store, rename, retiredHead, heads: headsInOrder, close };
}

/**
 * The source id a sidecar holds, or `undefined` when it holds none — a
 * sidecar an older server wrote gets its id assigned at start. An id that
 * is there but not a non-empty string is a corrupt sidecar, refused
 * naming its file and its field.
 */
function idOfSidecar(file: SidecarFile, path: string): string | undefined {
  if (file.id === undefined) return undefined;
  if (typeof file.id !== 'string' || file.id.length === 0) {
    throw new Error(`the sidecar "${path}" does not name the source's id: "id" must be a non-empty string`);
  }
  return file.id;
}

/**
 * A sidecar's former names, or `[]` when it holds none — a sidecar an
 * older server wrote. Anything of another shape is a corrupt sidecar,
 * refused naming its file and its field; so is a list naming a name
 * twice, or the source's own current name: the current name is never its
 * own former one.
 */
function formerNamesOfSidecar(file: SidecarFile, path: string, source: string): string[] {
  if (file.formerNames === undefined) return [];
  if (!Array.isArray(file.formerNames)) {
    throw new Error(`the sidecar "${path}" does not name the source's former names: "formerNames" must be an array of non-empty strings`);
  }
  const names: string[] = [];
  for (const each of file.formerNames) {
    if (typeof each !== 'string' || each.length === 0) {
      throw new Error(`the sidecar "${path}" does not name the source's former names: "formerNames" must be an array of non-empty strings`);
    }
    names.push(each);
  }
  if (new Set(names).size !== names.length) {
    throw new Error(`the sidecar "${path}" holds a name twice in "formerNames": a source's former names hold each name once`);
  }
  if (names.includes(source)) {
    throw new Error(`the sidecar "${path}" holds "formerNames" naming the source's own current name "${source}": a source's former names are the names it gave up`);
  }
  return names;
}

/** One sidecar's head fields, checked field by field so a corrupt one is refused naming its file and its field; the id beside them `idOfSidecar` reads. */
function headOfSidecar(file: SidecarFile, path: string): Omit<SourceHead, 'id'> {
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

