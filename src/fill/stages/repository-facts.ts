/**
 * The two passes of step 1 (madarch-8bdc.2.5): the tree and the history of one
 * repository, read from git, side by side and sharing nothing.
 *
 * The tree pass answers what the tree holds at one commit: every path, its mode,
 * its blob, its size, git's own answer about text or binary and its line count,
 * the language the dataset names and the gitlinks. The history pass answers every
 * commit: its parents, its author (folded through .mailmap), its two dates with
 * their offsets, its subject and the paths it touched, with what happened and how
 * many lines moved. Neither pass reads the other's answer, and neither keeps a
 * tree: one unit per repository per pass, because both walks are one git call
 * each over the whole repository and a unit per file would pay a lease, a work
 * item and a publication for every path of a tree one statement listed.
 */
import * as languages from 'linguist-languages';
import { gitStream, gitText, blobContents } from '../../plugin/git-bytes.js';
import { raise } from '../../model/raise.js';
import { Type } from 'typebox';
import { log } from '../../obs/log.js';
import { byCodePoint } from '../../model/order.js';
import type { SnapshotSource } from '../../plugin/repository-snapshot.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage, type StageExecutionResult, type StagePlan, type StageUnit } from '../stage.js';
import type { DeclaredKinds, HistoryCommit, HistoryPublish, RecordCounts, TreeFile, TreeGitlink, TreePublish } from '../../graph/index.js';

/** The stage ids of the two passes, as a later step registers them. */
export const REPOSITORY_TREE_STAGE_ID = 'repository-tree';
export const REPOSITORY_HISTORY_STAGE_ID = 'repository-history';

/** One repository as a pass reads it: the name the product gives it and the checkout git answers in. */
export interface RepositoryAt {
  readonly repository: string;
  readonly root: string;
  readonly commit: string;
  readonly url: string;
  readonly defaultBranch?: string;
}

/**
 * A NUL-separated byte stream, split as it arrives: the records are the bytes between
 * two NULs. A record is decoded only where it is text, so a path or a subject git wrote
 * in bytes that are no UTF-8 is seen as the bytes it is, never as a replacement character
 * nothing can tell from a real one.
 */
function byteSplit(): { push(chunk: Uint8Array): Buffer[]; done(): Buffer[] } {
  let rest = Buffer.alloc(0);
  return {
    push(chunk: Uint8Array): Buffer[] {
      const all = rest.length === 0 ? Buffer.from(chunk) : Buffer.concat([rest, Buffer.from(chunk)]);
      const parts: Buffer[] = [];
      let from = 0;
      for (;;) {
        const at = all.indexOf(0, from);
        if (at < 0) break;
        parts.push(all.subarray(from, at));
        from = at + 1;
      }
      rest = Buffer.from(all.subarray(from));
      return parts;
    },
    done(): Buffer[] {
      const held = rest;
      rest = Buffer.alloc(0);
      return held.length === 0 ? [] : [held];
    },
  };
}

/** One UTF-8 decoder that refuses invalid bytes: a byte sequence no text can hold is no text. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** One record as text, or undefined where its bytes are not UTF-8: nothing is replaced in silence. */
function textOf(bytes: Uint8Array): string | undefined {
  try {
    return UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * One record's bytes as a text a reader can read back exactly: printable ASCII stands,
 * and every other byte is written `\xNN` (a backslash is doubled, so the form is
 * unambiguous). A path or subject that is no UTF-8 is named this way in a gap row,
 * never dropped in silence and never replaced by a character no byte named.
 */
function escapedOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    if (byte === 0x5c) out += '\\\\';
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/**
 * The empty tree's id per object format: the base `git diff` compares a commit against, git's own answer, kept once
 * per format. A repository of another object format (sha256 beside sha1) has another empty tree, so the id is keyed
 * by the format git reports for the repository, never shared across formats.
 */
const emptyTrees = new Map<string, Promise<string>>();
async function emptyTreeOf(root: string): Promise<string> {
  const format = (await gitText(root, ['rev-parse', '--show-object-format'])).trim();
  const held = emptyTrees.get(format);
  if (held !== undefined) return await held;
  const made = gitText(root, ['hash-object', '-t', 'tree', '/dev/null']).then((text) => text.trim());
  emptyTrees.set(format, made);
  // A read that failed leaves no id behind: the next repository of this format asks git again.
  made.catch(() => { if (emptyTrees.get(format) === made) emptyTrees.delete(format); });
  return await made;
}

// ---- the language dataset --------------------------------------------------

/**
 * The dataset's reverse index, built once: an extension or a file name to the languages the
 * dataset gives it. Nothing here is a table of ours — `linguist-languages` (MIT, pinned in
 * package.json at an exact version) is the one source, and a key it does not name is unknown.
 */
let datasetIndex: { extensions: Map<string, string[]>; names: Map<string, string[]> } | undefined;
function indexOfDataset(): { extensions: Map<string, string[]>; names: Map<string, string[]> } {
  if (datasetIndex !== undefined) return datasetIndex;
  const extensions = new Map<string, string[]>();
  const names = new Map<string, string[]>();
  for (const [name, data] of Object.entries(languages as unknown as Record<string, { extensions?: readonly string[]; filenames?: readonly string[] }>)) {
    for (const extension of data.extensions ?? []) {
      const key = extension.toLowerCase();
      extensions.set(key, [...(extensions.get(key) ?? []), name]);
    }
    for (const filename of data.filenames ?? []) names.set(filename.toLowerCase(), [...(names.get(filename.toLowerCase()) ?? []), name]);
  }
  for (const map of [extensions, names]) for (const [key, held] of map) map.set(key, [...new Set(held)].sort(byCodePoint));
  datasetIndex = { extensions, names };
  return datasetIndex;
}

/**
 * The language one path's name answers: the dataset's file name first, then its longest extension
 * (`h.in` before `in`), and `unknown` where the dataset names neither. Several candidates are the
 * ambiguity itself: `ambiguous` with them, never one of them picked. Where the dataset
 * has no match and text is supplied, a successful JSON parse identifies JSON without
 * inferring a language from an unrecognised suffix.
 */
export function languageOfPath(path: string, content?: string): { language: string; candidates: readonly string[] } {
  const index = indexOfDataset();
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const held = index.names.get(name);
  if (held !== undefined) return held.length === 1 ? { language: held[0]!, candidates: held } : { language: 'ambiguous', candidates: held };
  let best: string[] | undefined;
  let bestLength = -1;
  for (let at = name.indexOf('.'); at >= 0; at = name.indexOf('.', at + 1)) {
    const extension = name.slice(at);
    const found = index.extensions.get(extension);
    if (found !== undefined && extension.length > bestLength) { best = found; bestLength = extension.length; }
  }
  if (best === undefined) {
    if (content !== undefined) {
      try {
        JSON.parse(content);
        return { language: 'JSON', candidates: ['JSON'] };
      } catch { /* Not JSON: the parser supplies no language opinion. */ }
    }
    return { language: 'unknown', candidates: ['unknown'] };
  }
  return best.length === 1 ? { language: best[0]!, candidates: best } : { language: 'ambiguous', candidates: best };
}



/** The `linguist-language` overrides one tree states, read by git's own attribute parser in one call. */
async function languageOverridesAt(root: string, commit: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const split = byteSplit();
  const parts: Buffer[] = [];
  await gitStream(root, ['check-attr', '--stdin', '-z', `--source=${commit}`, 'linguist-language'], (chunk) => { for (const part of split.push(chunk)) parts.push(part); }, { input: `${paths.join('\u0000')}\u0000` });
  for (const part of split.done()) parts.push(part);
  for (let at = 0; at + 2 < parts.length; at += 3) {
    const path = textOf(parts[at]!);
    const value = textOf(parts[at + 2]!);
    if (path === undefined || value === undefined || path === '') continue;
    if (value !== 'unspecified' && value !== 'unset') out.set(path, value);
  }
  return out;
}

// ---- the tree pass ---------------------------------------------------------

/** One entry of `git ls-tree -r -l -z`: its mode, its type, its blob and its size. */
interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly blob: string;
  readonly size: number | null;
  readonly path: string;
}

/** One record of `git ls-tree -r -l -z`, or a path this reader cannot name: git wrote bytes that are no UTF-8. */
type TreeRecord = { readonly entry: TreeEntry } | { readonly unreadable: string };

/** One record of `git ls-tree -r -l -z`: its meta fields, and the path the record's bytes name. */
function treeRecordOf(record: Buffer): TreeRecord | undefined {
  if (record.length === 0) return undefined;
  const tab = record.indexOf(0x09);
  if (tab < 0) return undefined;
  const meta = record.subarray(0, tab).toString('latin1');
  const pathBytes = record.subarray(tab + 1);
  const path = textOf(pathBytes);
  if (path === undefined) return { unreadable: escapedOf(pathBytes) };
  const [mode, type, blob, size] = meta.split(/\s+/);
  if (mode === undefined || type === undefined || blob === undefined) return undefined;
  return { entry: { mode, type, blob, size: size === '-' || size === undefined ? null : Number(size), path } };
}

/**
 * A remote's address with any user name and password cut from it. `git remote get-url origin` answers what the
 * checkout was cloned with, and a remote written `https://user:token@host/...` names a credential: the graph stores
 * the address without it, never the original. A remote that is no URL (git's scp-like `user@host:path`, a local path)
 * carries no userinfo a URL parser reads, and stands as git states it.
 */
function remoteAddressOf(remote: string): string {
  try {
    const parsed = new URL(remote);
    if (parsed.username === '' && parsed.password === '') return remote;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return remote;
  }
}

/** Reads one repository's tree at one commit: `ls-tree -r -l` for the entries, one `diff --numstat` for text, lines and sizes. */
/** What one pass could not read: a problem for a person, said in the run's log and trace (stage 3: `gap` is gone). */
export interface ReadGap {
  readonly what: string;
  readonly reason: 'non-utf8-path' | 'shallow-history' | 'unreadable';
}

/** What the tree pass read, and what it could not read. The publisher takes the tree; the gaps stay the run's. */
export interface RepositoryTreeRead extends TreePublish {
  readonly gaps: readonly ReadGap[];
}

/** What the history pass read, what it could not read, and whether its clone was shallow. */
export interface RepositoryHistoryRead extends HistoryPublish {
  readonly gaps: readonly ReadGap[];
}

export async function readRepositoryTree(pin: RepositoryAt): Promise<RepositoryTreeRead> {
  const gaps: ReadGap[] = [];
  const entries: TreeEntry[] = [];
  const treeSplit = byteSplit();
  const takeTree = (record: Buffer): void => {
    const held = treeRecordOf(record);
    if (held === undefined) return;
    if ('unreadable' in held) {
      gaps.push({ what: `path ${held.unreadable}`, reason: 'non-utf8-path' });
      return;
    }
    entries.push(held.entry);
  };
  await gitStream(pin.root, ['ls-tree', '-r', '-l', '-z', pin.commit], (chunk) => {
    for (const record of treeSplit.push(chunk)) takeTree(record);
  });
  for (const record of treeSplit.done()) takeTree(record);
  // Git's own text-or-binary answer and its line count, in one call over the whole tree against the
  // empty tree: the added count is the file's own line count, and `-` is a blob git calls binary.
  const countsByKey = new Map<string, { added: number | null; removed: number | null }>();
  /** The key a numstat record names: the path's text, or the bytes no text can hold (which no file row holds either). */
  const keyOf = (pathBytes: Uint8Array): string => textOf(pathBytes) ?? `\u0000${escapedOf(pathBytes)}`;
  /** One `added\tremoved\tpath` record's counts, or undefined where the record is no such line. */
  const countsOf = (record: Buffer): { added: number | null; removed: number | null; pathBytes: Buffer } | undefined => {
    if (record.length === 0) return undefined;
    const counted = entryWithoutNewline(record);
    const line = counted.toString('latin1');
    const first = line.indexOf('\t');
    const second = first < 0 ? -1 : line.indexOf('\t', first + 1);
    if (second < 0) return undefined;
    const added = line.slice(0, first);
    const removed = line.slice(first + 1, second);
    return { added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed), pathBytes: counted.subarray(second + 1) };
  };
  const numstatRecords: Buffer[] = [];
  const numstatSplit = byteSplit();
  await gitStream(pin.root, ['diff', '--numstat', '--no-renames', '-z', await emptyTreeOf(pin.root), pin.commit], (chunk) => {
    for (const record of numstatSplit.push(chunk)) numstatRecords.push(record);
  });
  for (const record of numstatSplit.done()) numstatRecords.push(record);
  for (let at = 0; at < numstatRecords.length; at += 1) {
    const held = countsOf(numstatRecords[at]!);
    if (held === undefined) continue;
    if (held.pathBytes.length > 0) {
      countsByKey.set(keyOf(held.pathBytes), { added: held.added, removed: held.removed });
      continue;
    }
    // A rename's numstat names no path on its own line and the old and new paths in the next two records;
    // only the new one carries the counts.
    const newPath = numstatRecords[at + 2];
    if (newPath !== undefined && newPath.length > 0) countsByKey.set(keyOf(newPath), { added: held.added, removed: held.removed });
    at += 2;
  }
  const blobs = entries.filter((entry) => entry.type === 'blob');
  const overrides = await languageOverridesAt(pin.root, pin.commit, blobs.map((entry) => entry.path));
  const files: TreeFile[] = [];
  const gitlinks: TreeGitlink[] = [];
  for (const entry of entries) {
    if (entry.type === 'commit') {
      const other = /^\.\.\/(.+)$/.exec(entry.path);
      gitlinks.push({ path: entry.path, otherRepository: other === null ? entry.path : other[1]!, commit: entry.blob });
      continue;
    }
    if (entry.type !== 'blob') continue;
    const held = countsByKey.get(entry.path);
    const form = held?.added === null || held?.added === undefined ? 'binary' : 'text';
    const language = overrides.get(entry.path) ?? languageOfPath(entry.path);
    files.push({
      path: entry.path,
      mode: entry.mode === '100755' ? '100755' : entry.mode === '120000' ? '120000' : '100644',
      blob: entry.blob,
      bytes: entry.size ?? 0,
      form,
      lines: form === 'text' ? (held?.added ?? 0) : null,
      content: null,
      language: typeof language === 'string' ? language : language.language,
      candidates: typeof language === 'string' ? [language] : language.candidates,
    });
  }
  // The text files' bytes, once per blob: two files with the same bytes share one row in the store (item 9).
  const contents = await blobContents(pin.root, files.filter((file) => file.form === 'text').map((file) => file.blob));
  for (const file of files) if (file.form === 'text') {
    const content = contents.get(file.blob) ?? null;
    (file as { content: string | null }).content = content;
    if (file.language === 'unknown' && content !== null && !overrides.has(file.path)) {
      const parsed = languageOfPath(file.path, content);
      Object.assign(file, parsed);
    }
  }
  files.sort((left, right) => byCodePoint(left.path, right.path));
  gitlinks.sort((left, right) => byCodePoint(left.path, right.path));
  // The repository's web address is its remote, read here (the files producer alone reads the source filesystem): a
  // repository a person connected declares a local path, and the pages link to the host the remote names. A remote
  // carrying a user and a password keeps neither: the graph is read by everyone, the credential is not stored.
  const remote = remoteAddressOf((await gitText(pin.root, ['remote', 'get-url', 'origin']).catch(() => '')).trim());
  return { repository: { name: pin.repository, url: remote === '' ? pin.url : remote, ...(pin.defaultBranch === undefined ? {} : { defaultBranch: pin.defaultBranch }) }, commit: pin.commit, files, gitlinks, gaps };
}

/** The shallow-clone gap of one history, read by git's own answer. */
export async function shallowGapOf(pin: RepositoryAt): Promise<{ what: string; reason: 'shallow-history' } | null> {
  return (await gitText(pin.root, ['rev-parse', '--is-shallow-repository'])).trim() === 'true'
    ? { what: `${pin.repository} at ${pin.commit}`, reason: 'shallow-history' }
    : null;
}

// ---- the history pass ------------------------------------------------------

/** The format one commit's header takes in the log stream, its fields separated by 0x1f. */
const LOG_FORMAT = '%x1f%H%x1f%P%x1f%aN%x1f%aE%x1f%aI%x1f%cI%x1f%s';

/** One commit's header, as the stream states it. */
interface LogHeader {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  commitDate: string;
  subject: string;
}

/** One gap one pass names: what it could not read, and why. */
type RepositoryGap = { what: string; reason: 'non-utf8-path' | 'shallow-history' | 'unreadable' };


/**
 * One commit header's fields, in order: the first six are cut at their 0x1f, and the subject is the rest of the
 * record — git separates the fields with 0x1f, and a subject holding that byte is the subject as git states it,
 * never truncated into extra fields. Fewer than seven fields is no header, and answers the parts it read.
 */
function headerFields(bytes: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let from = 0;
  while (parts.length < 6) {
    const at = bytes.indexOf(0x1f, from);
    if (at < 0) return parts;
    parts.push(bytes.subarray(from, at));
    from = at + 1;
  }
  parts.push(bytes.subarray(from));
  return parts;
}

/**
 * Splits one log stream into its commits as it arrives: a header record, then the diff entries the next header
 * ends. The records are bytes, and a path is kept exactly as git wrote it — git puts one newline in front of an
 * entry's *first* record (its status or its counts), and a path that begins with a newline is that path. A field or
 * a path in bytes no UTF-8 can hold is escaped into its field and named in a gap, so a reader sees the exact bytes
 * and never a replacement character that hides them.
 */
function logStreams(gaps: RepositoryGap[]): { push(chunk: Uint8Array): void; done(): { header: LogHeader; entries: Buffer[] }[] } {
  const split = byteSplit();
  const out: { header: LogHeader; entries: Buffer[] }[] = [];
  const take = (record: Buffer): void => {
    // A header may carry git's entry newline in front of it; anything else is an entry record, kept as it stands.
    const leading = record[0] === 0x0a ? record.subarray(1) : record;
    if (leading[0] === 0x1f) {
      const fields = headerFields(leading.subarray(1));
      if (fields.length < 7) return;
      const hash = textOf(fields[0]!) ?? escapedOf(fields[0]!);
      const field = (value: Buffer, name: string): string => {
        const text = textOf(value);
        if (text !== undefined) return text;
        // A field git wrote in bytes no UTF-8 can hold: its bytes are escaped into the field, and a gap names them,
        // so the commit stands with what git states and no character stands in for a byte nothing read.
        gaps.push({ what: `commit ${hash} ${name} ${escapedOf(value)}`, reason: 'unreadable' });
        return escapedOf(value);
      };
      const parents = field(fields[1]!, 'parents');
      out.push({
        header: {
          hash,
          parents: parents.trim() === '' ? [] : parents.split(' ').filter((one) => one !== ''),
          authorName: field(fields[2]!, 'author name'),
          authorEmail: field(fields[3]!, 'author email'),
          authorDate: field(fields[4]!, 'author date'),
          commitDate: field(fields[5]!, 'commit date'),
          subject: field(fields[6]!, 'subject'),
        },
        entries: [],
      });
      return;
    }
    if (record.length === 0 || out.length === 0) return;
    out[out.length - 1]!.entries.push(record);
  };
  return {
    push(chunk: Uint8Array): void { for (const record of split.push(chunk)) take(record); },
    done(): { header: LogHeader; entries: Buffer[] }[] { for (const record of split.done()) take(record); return out; },
  };
}

/** One entry record without git's entry newline: the first record of an entry carries it, a path never does. */
function entryWithoutNewline(record: Buffer): Buffer {
  return record[0] === 0x0a ? record.subarray(1) : record;
}

/**
 * Reads one repository's history from one commit: every commit, its parents, its author, its dates
 * and what it touched.
 *
 * `--name-status` and `--numstat` cannot be asked in one stream: git 2.43 keeps one of the two
 * (measured here: `--name-status` alone answers with the statuses, `--numstat` alone with the
 * counts), so the two walks are one git call each, with the same format, joined by the commit and
 * the path. Both are git's own answers; nothing here parses source text.
 */
export async function readRepositoryHistory(pin: RepositoryAt): Promise<RepositoryHistoryRead> {
  type Touched = HistoryCommit['touched'][number];
  const gaps: RepositoryGap[] = [];
  const shallow = await shallowGapOf(pin);
  if (shallow !== null) gaps.push(shallow);
  const statusParser = logStreams(gaps);
  await gitStream(pin.root, ['log', '--diff-merges=first-parent', '--name-status', '-M', '--use-mailmap', '-z', `--format=${LOG_FORMAT}`, pin.commit], (chunk) => statusParser.push(chunk));
  const statuses = statusParser.done();
  // The counts stream repeats the headers the status stream already read: its own gaps are the status stream's.
  const countParser = logStreams([]);
  await gitStream(pin.root, ['log', '--diff-merges=first-parent', '--numstat', '-M', '--use-mailmap', '-z', `--format=${LOG_FORMAT}`, pin.commit], (chunk) => countParser.push(chunk));
  const counts = countParser.done();
  const countByKey = new Map<string, { added: number | null; removed: number | null }>();
  /** The key a record names: the path's text, or a marker no touched row holds where the path is no text. */
  const keyOf = (pathBytes: Uint8Array): string => textOf(pathBytes) ?? `\u0000${escapedOf(pathBytes)}`;
  /** One `added\tremoved\tpath` record's counts, and the bytes after its second tab. */
  const countsOf = (record: Buffer): { added: number | null; removed: number | null; pathBytes: Buffer } | undefined => {
    if (record.length === 0) return undefined;
    const counted = entryWithoutNewline(record);
    const line = counted.toString('latin1');
    const first = line.indexOf('\t');
    const second = first < 0 ? -1 : line.indexOf('\t', first + 1);
    if (second < 0) return undefined;
    const added = line.slice(0, first);
    const removed = line.slice(first + 1, second);
    return { added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed), pathBytes: counted.subarray(second + 1) };
  };
  for (const stream of counts) {
    for (let at = 0; at < stream.entries.length; at += 1) {
      const held = countsOf(stream.entries[at]!);
      if (held === undefined) continue;
      if (held.pathBytes.length > 0) {
        countByKey.set(`${stream.header.hash}\u0000${keyOf(held.pathBytes)}`, { added: held.added, removed: held.removed });
        continue;
      }
      // A rename's numstat names the old path and the new one in the next two entries.
      const newPath = stream.entries[at + 2];
      if (newPath !== undefined && newPath.length > 0) countByKey.set(`${stream.header.hash}\u0000${keyOf(newPath)}`, { added: held.added, removed: held.removed });
      at += 2;
    }
  }
  const commits: HistoryCommit[] = [];
  for (const stream of statuses) {
    const touched: Touched[] = [];
    for (let at = 0; at < stream.entries.length; at += 1) {
      const entry = stream.entries[at]!;
      const status = /^([ACDMRT])(\d*)$/.exec(entryWithoutNewline(entry).toString('latin1'));
      if (status === null) continue;
      const change = (status[1] === 'A' ? 'added' : status[1] === 'D' ? 'deleted' : status[1] === 'R' ? 'renamed' : 'modified') as Touched['change'];
      if (change === 'renamed') {
        const previousBytes = stream.entries[at + 1] ?? Buffer.alloc(0);
        const pathBytes = stream.entries[at + 2] ?? Buffer.alloc(0);
        at += 2;
        const path = textOf(pathBytes);
        const previousPath = textOf(previousBytes);
        if (path === undefined || previousPath === undefined) {
          gaps.push({ what: `commit ${stream.header.hash} path ${escapedOf(path === undefined ? pathBytes : previousBytes)}`, reason: 'non-utf8-path' });
          continue;
        }
        const held = countByKey.get(`${stream.header.hash}\u0000${path}`) ?? { added: null, removed: null };
        touched.push({ path, change, added: held.added, removed: held.removed, previousPath });
        continue;
      }
      const pathBytes = stream.entries[at + 1] ?? Buffer.alloc(0);
      at += 1;
      const path = textOf(pathBytes);
      if (path === undefined) {
        gaps.push({ what: `commit ${stream.header.hash} path ${escapedOf(pathBytes)}`, reason: 'non-utf8-path' });
        continue;
      }
      const held = countByKey.get(`${stream.header.hash}\u0000${path}`) ?? { added: null, removed: null };
      touched.push({ path, change, added: held.added, removed: held.removed });
    }
    commits.push({ ...stream.header, touched });
  }
  // The stream's own order: the first commit is the tip, so a commit's index is its walk from the
  // tip, which is the order `git log --follow` answers a file's history in.
  return { repository: { name: pin.repository }, commits, gaps };
}

// ---- the two passes as stages ---------------------------------------------

/** What a stage needs to publish one pass's answer: the storage module's own write, given by the wiring. */
export interface RepositoryPassWiring {
  readonly sources: SnapshotSource;
  /**
   * What the tree pass publishes through. A caller that registers the stages to read their
   * declarations (the engine's registry, a test of a stage's shape) hands none, and a unit that
   * then runs refuses by name rather than publishing nowhere.
   */
  readonly publishTree?: (input: TreePublish) => Promise<RecordCounts>;
  readonly publishHistory?: (input: HistoryPublish) => Promise<RecordCounts>;
  /** The repository paths this fill covers, as prefixes (`src/` covers everything under it); the whole tree when left out. */
  readonly paths?: readonly string[];
  /**
   * The code entities these passes may write, by graph kind. The tree is mechanism state for every product
   * (`file_entry`), and an entity kind the manifest does not declare is not written; false writes no entity at all
   * (madarch-hsqs stage C).
   */
  readonly kinds?: false | DeclaredKinds;
}

/** The unit id of one repository's pass: `repository:<name>`, the same for both passes of it. */
export function repositoryUnitId(repository: string): string {
  return `repository:${repository}`;
}

/** The repository a unit id names, refused by name where it names none. */
export function repositoryOfUnit(unitId: string): string {
  const match = /^repository:(.+)$/.exec(unitId);
  if (match === null || match[1] === '') raise(`the unit id ${JSON.stringify(unitId)} is not one of the repository passes, which are "repository:<name>"`);
  return match[1]!;
}

/** The pin one repository's unit reads, refused where the run pins no such repository. */
async function pinOf(sources: SnapshotSource, repository: string): Promise<RepositoryAt> {
  const pins = await sources.pins();
  const pin = pins.find((entry) => entry.id === repository);
  if (pin === undefined) raise(`the run pins no repository ${JSON.stringify(repository)}: its pins are ${pins.map((entry) => JSON.stringify(entry.id)).join(', ') || 'none'}`);
  return { repository: pin.id, root: pin.root, commit: pin.commit, url: `file://${pin.root}`, ...(pin.defaultBranch === undefined ? {} : { defaultBranch: pin.defaultBranch }) };
}

/**
 * The tree pass as a stage: one unit per pinned repository, its whole tree in one read and one
 * publish. Its plan reads the pins and nothing else; its unit's answer is the storage module's.
 */
export function createRepositoryTreeStage(wiring: RepositoryPassWiring): FillStage {
  return {
    id: REPOSITORY_TREE_STAGE_ID,
    version: 1,
    consumes: { required: [], optional: [] },
    produces: [{ kind: 'tree', schemaVersion: 1, scope: 'repository' }],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (): Promise<StagePlan> => {
      const pins = await wiring.sources.pins();
      return { units: pins.map((pin) => ({ id: repositoryUnitId(pin.id), scope: pin.id })), coverage: pins.length === 0 ? 'nothing-found' : 'planned' };
    },
    execute: async (unit: StageUnit, context): Promise<StageExecutionResult> => {
      const pin = await pinOf(wiring.sources, repositoryOfUnit(unit.id));
      const read = await readRepositoryTree(pin);
      // A fill asked for some paths covers those and no others: the tree is read whole (one git
      // call) and the rows written are the ones under the prefixes the caller named.
      const within = (path: string): boolean => wiring.paths === undefined || wiring.paths.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
      const covered = wiring.paths === undefined ? read : {
        ...read,
        files: read.files.filter((file) => within(file.path)),
        gitlinks: read.gitlinks.filter((link) => within(link.path)),
        // The publication covers these prefixes and no others: a row outside them is not this fill's to delete
        // (madarch-8bdc.2.5, item 4b: a scoped publication touches its scope only).
        scope: [...wiring.paths],
      };
      // What the pass could not read is a problem for a person, not a graph row (stage 3: `gap` is gone): the run's log
      // and trace name each one, and an unreadable file keeps its own opinion with no blob.
      for (const gap of read.gaps) log.warn('the tree pass could not read', { repository: pin.repository, what: gap.what, reason: gap.reason });
      if (wiring.publishTree === undefined) raise(`the tree pass of ${pin.repository} was asked to run, and the run that registered it wired no record store: its publisher is the record pass of src/graph/records.ts (src/fill/stages/repository-facts.ts)`);
      const counts = await wiring.publishTree({ ...covered, ...(wiring.kinds === undefined ? {} : { kinds: wiring.kinds }) });
      context.progress(`${pin.repository} at ${pin.commit}: ${String(covered.files.length)} files, ${String(covered.gitlinks.length)} gitlinks, ${String(counts.inserted)} rows written`, 1);
      return { outcome: 'draft' };
    },
    validate: () => ({ ok: true }),
  };
}

/** The history pass as a stage: one unit per pinned repository, one log stream and one publish. */
export function createRepositoryHistoryStage(wiring: RepositoryPassWiring): FillStage {
  return {
    id: REPOSITORY_HISTORY_STAGE_ID,
    version: 1,
    consumes: { required: [], optional: [] },
    produces: [{ kind: 'history', schemaVersion: 1, scope: 'repository' }],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (): Promise<StagePlan> => {
      const pins = await wiring.sources.pins();
      return { units: pins.map((pin) => ({ id: repositoryUnitId(pin.id), scope: pin.id })), coverage: pins.length === 0 ? 'nothing-found' : 'planned' };
    },
    execute: async (unit: StageUnit, context): Promise<StageExecutionResult> => {
      const pin = await pinOf(wiring.sources, repositoryOfUnit(unit.id));
      const read = await readRepositoryHistory(pin);
      for (const gap of read.gaps) log.warn('the history pass could not read', { repository: pin.repository, what: gap.what, reason: gap.reason });
      if (wiring.publishHistory === undefined) raise(`the history pass of ${pin.repository} was asked to run, and the run that registered it wired no record store: its publisher is the record pass of src/graph/records.ts (src/fill/stages/repository-facts.ts)`);
      // A shallow clone is a fact about what the pass was given, so the pass states it as its own opinion of the
      // repository instead of a table of its own; the entity kinds the product declares come with it.
      const counts = await wiring.publishHistory({ repository: read.repository, commits: read.commits, shallow: read.gaps.some((gap) => gap.reason === 'shallow-history'), ...(wiring.kinds === undefined ? {} : { kinds: wiring.kinds }) });
      context.progress(`${pin.repository}: ${String(read.commits.length)} commits, ${String(counts.inserted)} rows written`, 1);
      return { outcome: 'draft' };
    },
    validate: () => ({ ok: true }),
  };
}
