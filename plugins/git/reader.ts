/** Git history parsing is owned by the git plugin. */
import { gitStream, gitText } from './git-bytes.js';
export interface RepositoryAt { readonly repository: string; readonly root: string; readonly commit: string; readonly url?: string; readonly defaultBranch?: string }
export interface HistoryCommit {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  /** ISO 8601 with its offset, as `git log %aI` writes it. */
  readonly authorDate: string;
  readonly commitDate: string;
  readonly subject: string;
  readonly touched: readonly {
    readonly path: string;
    readonly change: 'added' | 'modified' | 'deleted' | 'renamed';
    readonly added: number | null;
    readonly removed: number | null;
    readonly previousPath?: string;
  }[];
}

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
export async function readRepositoryHistory(pin: RepositoryAt): Promise<{ repository: { name: string }; commits: readonly HistoryCommit[]; gaps: readonly RepositoryGap[] }> {
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

