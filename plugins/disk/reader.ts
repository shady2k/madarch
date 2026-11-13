/** Repository interpretation belongs to this shipped plugin, not to the host. */
import languages from './languages.json';
import { gitStream, gitText, blobContents } from './git-bytes.js';
const byCodePoint = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export interface RepositoryAt { readonly repository: string; readonly root: string; readonly commit: string; readonly url?: string; readonly defaultBranch?: string }
export interface TreeFile {
  readonly path: string;
  readonly mode: '100644' | '100755' | '120000';
  readonly blob: string;
  readonly bytes: number;
  /** Git's own answer: `-` in `--numstat` is a binary blob, a number of added lines is text. */
  readonly form: 'text' | 'binary';
  readonly lines: number | null;
  /** A text file's bytes as text, stored once per blob; null for a binary blob, whose bytes are kept nowhere. */
  readonly content: string | null;
  /** The dataset's language, or `ambiguous` with its candidates: the opinion stores the candidates, never the word. */
  readonly language: string;
  readonly candidates: readonly string[];
}

/** One gitlink of a tree: a submodule's repository and the commit it stands at. */
export interface TreeGitlink {
  readonly path: string;
  readonly otherRepository: string;
  readonly commit: string;
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
 * dataset gives it. The full `linguist-languages` 9.5.0 dataset is generated into languages.json
 * (see LANGUAGES.md); a key it does not name is unknown.
 */
let datasetIndex: { extensions: Map<string, string[]>; names: Map<string, string[]>; interpreters: Map<string, string> } | undefined;
function indexOfDataset(): { extensions: Map<string, string[]>; names: Map<string, string[]>; interpreters: Map<string, string> } {
  if (datasetIndex !== undefined) return datasetIndex;
  const extensions = new Map<string, string[]>();
  const names = new Map<string, string[]>();
  const interpreters = new Map<string, string[]>();
  for (const [name, data] of Object.entries(languages as unknown as Record<string, { extensions?: readonly string[]; filenames?: readonly string[]; interpreters?: readonly string[] }>)) {
    for (const extension of data.extensions ?? []) {
      const key = extension.toLowerCase();
      extensions.set(key, [...(extensions.get(key) ?? []), name]);
    }
    for (const filename of data.filenames ?? []) names.set(filename.toLowerCase(), [...(names.get(filename.toLowerCase()) ?? []), name]);
    // Several languages may name one interpreter (`node` runs JavaScript and TypeScript): the first in code point order
    // is the default, and a shebang names that one.
    for (const interpreter of data.interpreters ?? []) interpreters.set(interpreter.toLowerCase(), [...(interpreters.get(interpreter.toLowerCase()) ?? []), name]);
  }
  for (const map of [extensions, names]) for (const [key, held] of map) map.set(key, [...new Set(held)].sort(byCodePoint));
  const firstInterpreter = new Map([...interpreters].map(([key, held]) => [key, [...new Set(held)].sort(byCodePoint)[0]!] as const));
  datasetIndex = { extensions, names, interpreters: firstInterpreter };
  return datasetIndex;
}

/** The language an extension's ambiguity falls back to when its content states nothing: the dataset's own name. */
const PREFERRED: Readonly<Record<string, string>> = {
  '.ts': 'TypeScript', '.tsx': 'TSX', '.json': 'JSON', '.md': 'Markdown', '.markdown': 'Markdown',
  '.yaml': 'YAML', '.yml': 'YAML', '.html': 'HTML', '.htm': 'HTML', '.sql': 'SQL', '.txt': 'Text',
  '.h': 'C', '.hh': 'C++', '.hpp': 'C++', '.hxx': 'C++', '.m': 'Objective-C', '.mm': 'Objective-C++',
};

/** The base name of a shebang's program: `python3.12` is `python3.12`, and its version is cut only to find its language. */
function programOf(shebang: string): string | undefined {
  const words = shebang.trim().split(/\s+/);
  let at = 0;
  const base = (word: string): string => word.slice(word.lastIndexOf('/') + 1);
  if (base(words[0] ?? '') === 'env') { at = 1; while (at < words.length && words[at]!.startsWith('-')) at += 1; }
  const program = base(words[at] ?? '').toLowerCase();
  return program === '' ? undefined : program;
}

/** The language a script's first line names, through the dataset's interpreters, or undefined for no shebang. */
function shebangLanguageOf(content: string | undefined): string | undefined {
  if (content === undefined || !content.startsWith('#!')) return undefined;
  const line = content.slice(0, content.indexOf('\n') < 0 ? content.length : content.indexOf('\n'));
  const program = programOf(line.slice(2));
  if (program === undefined) return undefined;
  const interpreters = indexOfDataset().interpreters;
  return interpreters.get(program) ?? interpreters.get(program.replace(/[0-9.]+$/, ''));
}

/** Whether one of a candidate list is named by the value, for a content or a default that names no candidate. */
function named(candidates: readonly string[], language: string | undefined): string | undefined {
  return language !== undefined && candidates.includes(language) ? language : undefined;
}

/**
 * The language several candidates leave open, decided by the bytes when they say which one it is and otherwise by the
 * extension's default. Linguist's own ambiguous extensions are read the way GitHub reads them: a `.ts` that opens with
 * an XML declaration is XML and every other is TypeScript, a `.md` holding `(define_insn` is a GCC machine description,
 * and an OpenAPI document names itself. A value no candidate names is no decision, and the candidates stand.
 */
function decided(candidates: readonly string[], extension: string, content: string | undefined): string | undefined {
  const text = content ?? '';
  const preferred = named(candidates, PREFERRED[extension]);
  switch (extension) {
    case '.ts':
    case '.tsx': {
      if (/^\uFEFF?\s*<\?xml\b/u.test(text) || /<TS\b/u.test(text)) return named(candidates, 'XML');
      return preferred;
    }
    case '.md':
      return /^\s*\(define_/mu.test(text) ? named(candidates, 'GCC Machine Description') : preferred;
    case '.json': {
      let held: unknown;
      try { held = JSON.parse(text); } catch { return preferred; }
      if (held === null || typeof held !== 'object' || Array.isArray(held)) return preferred;
      const body = held as Record<string, unknown>;
      if (typeof body['openapi'] === 'string' && body['openapi'].startsWith('3')) return named(candidates, 'OASv3-json');
      if (typeof body['swagger'] === 'string' && body['swagger'].startsWith('2')) return named(candidates, 'OASv2-json');
      return preferred;
    }
    case '.yaml':
    case '.yml': {
      if (/^\s*openapi\s*:\s*['"]?3/mu.test(text)) return named(candidates, 'OASv3-yaml');
      if (/^\s*swagger\s*:\s*['"]?2/mu.test(text)) return named(candidates, 'OASv2-yaml');
      return preferred;
    }
    case '.html':
    case '.htm':
      return /<emu-[a-z]/iu.test(text) ? named(candidates, 'Ecmarkup') : preferred;
    case '.sql': {
      if (/\$\$/u.test(text) && /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/iu.test(text)) return named(candidates, 'PLpgSQL');
      if (/^\s*GO\s*$/mu.test(text) || /\[dbo\]/iu.test(text)) return named(candidates, 'TSQL');
      if (/VARCHAR2\b/iu.test(text) || /^\s*BEGIN\b[\s\S]*\bEND\s*;/mu.test(text)) return named(candidates, 'PLSQL');
      return preferred;
    }
    case '.h': {
      if (/@interface|@protocol|#import\s/iu.test(text)) return named(candidates, 'Objective-C');
      if (/^\s*(class|namespace|template\s*<)/mu.test(text) || /std::/u.test(text)) return named(candidates, 'C++');
      return preferred;
    }
    default:
      return preferred;
  }
}

/**
 * The language one path's name answers: the dataset's file name first, then its longest extension
 * (`h.in` before `in`), and `unknown` where the dataset names neither. Several candidates are decided by the bytes
 * and the extension's default; a value no candidate names stays `ambiguous` with the candidates, never one of them
 * picked in silence.
 */
export function languageOfPath(path: string, content?: string): { language: string; candidates: readonly string[] } {
  const index = indexOfDataset();
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const held = index.names.get(name);
  if (held !== undefined) return held.length === 1 ? { language: held[0]!, candidates: held } : { language: decided(held, name, content) ?? 'ambiguous', candidates: held };
  let best: string[] | undefined;
  let bestLength = -1;
  let bestExtension = name;
  for (let at = name.indexOf('.'); at >= 0; at = name.indexOf('.', at + 1)) {
    const extension = name.slice(at);
    const found = index.extensions.get(extension);
    if (found !== undefined && extension.length > bestLength) { best = found; bestLength = extension.length; bestExtension = extension; }
  }
  if (best === undefined) {
    const shebang = shebangLanguageOf(content);
    if (shebang !== undefined) return { language: shebang, candidates: [shebang] };
    if (content !== undefined) {
      try {
        JSON.parse(content);
        return { language: 'JSON', candidates: ['JSON'] };
      } catch { /* Not JSON: the parser supplies no language opinion. */ }
    }
    return { language: 'unknown', candidates: ['unknown'] };
  }
  return best.length === 1 ? { language: best[0]!, candidates: best } : { language: decided(best, bestExtension, content) ?? 'ambiguous', candidates: best };
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

/** Reads one repository's tree at one commit: `ls-tree -r -l` for the entries, one `diff --numstat` for text, lines and sizes. */
/** What one pass could not read: a problem for a person, said in the run's log and trace (stage 3: `gap` is gone). */
export interface ReadGap {
  readonly what: string;
  readonly reason: 'non-utf8-path' | 'shallow-history' | 'unreadable';
}

/** What the tree pass read, and what it could not read. The publisher takes the tree; the gaps stay the run's. */
export interface RepositoryTreeRead {
 readonly repository: { name: string; url: string; defaultBranch?: string }; readonly commit: string; readonly files: readonly TreeFile[]; readonly gitlinks: readonly TreeGitlink[];
  readonly gaps: readonly ReadGap[];
}

export async function readRepositoryTree(pin: RepositoryAt, options: { readonly fileFacts?: boolean; readonly paths?: readonly string[] } = {}): Promise<RepositoryTreeRead> {
  const gaps: ReadGap[] = [];
  const entries: TreeEntry[] = [];
  const pathspec = options.paths === undefined ? [] : ['--', ...options.paths.map(path => `:(literal)${path}`)];
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
  await gitStream(pin.root, ['ls-tree', '-r', '-l', '-z', pin.commit, ...pathspec], (chunk) => {
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
  if (options.fileFacts !== false) await gitStream(pin.root, ['diff', '--numstat', '--no-renames', '-z', await emptyTreeOf(pin.root), pin.commit, ...pathspec], (chunk) => {
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
  const selectedEntries = options.paths === undefined ? entries : entries.filter(entry => options.paths!.includes(entry.path));
  const blobs = selectedEntries.filter((entry) => entry.type === 'blob');
  const overrides = options.fileFacts === false ? new Map<string, string>() : await languageOverridesAt(pin.root, pin.commit, blobs.map((entry) => entry.path));
  const files: TreeFile[] = [];
  const gitlinks: TreeGitlink[] = [];
  for (const entry of selectedEntries) {
    if (entry.type === 'commit') {
      const other = /^\.\.\/(.+)$/.exec(entry.path);
      gitlinks.push({ path: entry.path, otherRepository: other === null ? entry.path : other[1]!, commit: entry.blob });
      continue;
    }
    if (entry.type !== 'blob') continue;
    const held = countsByKey.get(entry.path);
    const form = held?.added === null || held?.added === undefined ? 'binary' : 'text';
    const language = options.fileFacts === false ? { language: 'unknown', candidates: [] } : overrides.get(entry.path) ?? languageOfPath(entry.path);
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
  const contents = options.fileFacts === false ? new Map<string, string | null>() : await blobContents(pin.root, files.filter((file) => file.form === 'text').map((file) => file.blob));
  for (const file of files) if (file.form === 'text') {
    const content = contents.get(file.blob) ?? null;
    (file as { content: string | null }).content = content;
    // The bytes decide an ambiguous extension and name a shebang script; a git attribute still wins over both.
    if (content !== null && !overrides.has(file.path)) Object.assign(file, languageOfPath(file.path, content));
  }
  files.sort((left, right) => byCodePoint(left.path, right.path));
  gitlinks.sort((left, right) => byCodePoint(left.path, right.path));
  // The repository's web address is its remote, read here (the files producer alone reads the source filesystem): a
  // repository a person connected declares a local path, and the pages link to the host the remote names. A remote
  // carrying a user and a password keeps neither: the graph is read by everyone, the credential is not stored.
  return { repository: { name: pin.repository, url: pin.url ?? '', ...(pin.defaultBranch === undefined ? {} : { defaultBranch: pin.defaultBranch }) }, commit: pin.commit, files, gitlinks, gaps };
}

function entryWithoutNewline(record: Buffer): Buffer {
  return record[0] === 0x0a ? record.subarray(1) : record;
}

