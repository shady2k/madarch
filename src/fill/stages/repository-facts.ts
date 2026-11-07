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
import { StringDecoder } from 'node:string_decoder';
import * as languages from 'linguist-languages';
import { withSpan } from '../../obs/trace.js';
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import type { SnapshotSource } from '../snapshot.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage, type StageExecutionResult, type StageGraphReader, type StagePlan, type StageUnit } from '../stage.js';
import type { HistoryCommit, HistoryPublish, RecordCounts, TreeFile, TreeGitlink, TreePublish } from '../../graph/index.js';

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

/** The most bytes of git's standard error one failure may name; the rest is cut and said to be cut. */
const GIT_ERROR_BYTES = 4_000;

/**
 * Runs one git command in a checkout and hands its standard output to `onChunk`
 * as it arrives, so a history of a million entries is read once and never stands
 * in memory whole. The span names the command, its arguments and the bytes it
 * answered; it never holds those bytes.
 */
async function gitStream(root: string, args: readonly string[], onChunk: (chunk: Uint8Array) => void, options: { readonly input?: string } = {}): Promise<number> {
  return await withSpan('process.git', {
    'process.command': 'git',
    'process.args': [...args],
    'process.cwd': root,
  }, async (span) => {
    let process_: ReturnType<typeof Bun.spawn>;
    try {
      process_ = Bun.spawn(['git', ...args], {
        cwd: root,
        stdin: options.input === undefined ? 'ignore' : new TextEncoder().encode(options.input),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
      });
    } catch (error) {
      throw new Error(`the repository at ${root} could not run "git ${args.join(' ')}": ${error instanceof Error ? error.message : String(error)} (src/fill/stages/repository-facts.ts)`);
    }
    const errors: Uint8Array[] = [];
    const drained = (async () => { for await (const chunk of process_.stderr as ReadableStream<Uint8Array>) errors.push(chunk); })();
    let bytes = 0;
    for await (const chunk of process_.stdout as ReadableStream<Uint8Array>) {
      bytes += chunk.byteLength;
      onChunk(chunk);
    }
    await drained;
    const code = await process_.exited;
    span.setAttribute('process.outputBytes', bytes);
    span.setAttribute('process.exitCode', code);
    if (code !== 0) {
      const message = Buffer.concat(errors.map((one) => Buffer.from(one))).toString('utf8').trim();
      throw new Error(`the repository at ${root} could not run "git ${args.join(' ')}": git exited ${String(code)}${message === '' ? '' : `: ${message.slice(0, GIT_ERROR_BYTES)}${message.length > GIT_ERROR_BYTES ? ' (cut)' : ''}`} (src/fill/stages/repository-facts.ts)`);
    }
    return bytes;
  });
}

/** One git answer as text, for the small answers (a commit's tree id, a yes or a no). */
async function gitText(root: string, args: readonly string[]): Promise<string> {
  const parts: Buffer[] = [];
  await gitStream(root, args, (chunk) => parts.push(Buffer.from(chunk)));
  return Buffer.concat(parts).toString('utf8');
}

/**
 * A NUL-separated stream, split as it arrives: the decoder keeps a character
 * that arrived in two chunks whole, and the remainder keeps a record that is
 * not finished yet.
 */
function nullSplit(): { push(chunk: Uint8Array): string[]; done(): string[] } {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  return {
    push(chunk: Uint8Array): string[] {
      const text = rest + decoder.write(Buffer.from(chunk));
      const parts = text.split('\u0000');
      rest = parts.pop() ?? '';
      return parts;
    },
    done(): string[] {
      const text = rest + decoder.end();
      rest = '';
      return text === '' ? [] : text.split('\u0000');
    },
  };
}

/** The empty tree's id, the base `git diff` compares a commit against: git's own answer, once per process. */
let emptyTree: Promise<string> | undefined;
function emptyTreeOf(root: string): Promise<string> {
  emptyTree ??= gitText(root, ['hash-object', '-t', 'tree', '/dev/null']).then((text) => text.trim());
  return emptyTree;
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
 * ambiguity itself: `ambiguous` with them, never one of them picked.
 */
export function languageOfPath(path: string): { language: string; candidates: readonly string[] } {
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
  if (best === undefined) return { language: 'unknown', candidates: ['unknown'] };
  return best.length === 1 ? { language: best[0]!, candidates: best } : { language: 'ambiguous', candidates: best };
}

/** The `linguist-language` overrides one tree states, read by git's own attribute parser in one call. */
async function languageOverridesAt(root: string, commit: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const split = nullSplit();
  const parts: string[] = [];
  await gitStream(root, ['check-attr', '--stdin', '-z', `--source=${commit}`, 'linguist-language'], (chunk) => { for (const part of split.push(chunk)) parts.push(part); }, { input: `${paths.join('\u0000')}\u0000` });
  for (const part of split.done()) parts.push(part);
  for (let at = 0; at + 2 < parts.length; at += 3) {
    const path = parts[at]!;
    const value = parts[at + 2]!;
    if (path !== '' && value !== 'unspecified' && value !== 'unset') out.set(path, value);
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

/** One entry of `git ls-tree -r -l -z`, or nothing where the record is not one. */
function treeEntryOf(chunk: string): TreeEntry | undefined {
  if (chunk === '') return undefined;
  const tab = chunk.indexOf('\t');
  if (tab < 0) return undefined;
  const [mode, type, blob, size] = chunk.slice(0, tab).split(/\s+/);
  if (mode === undefined || type === undefined || blob === undefined) return undefined;
  return { mode, type, blob, size: size === '-' || size === undefined ? null : Number(size), path: chunk.slice(tab + 1) };
}

/** Reads one repository's tree at one commit: `ls-tree -r -l` for the entries, one `diff --numstat` for text, lines and sizes. */
export async function readRepositoryTree(pin: RepositoryAt): Promise<TreePublish> {
  const gaps: { what: string; reason: 'non-utf8-path' | 'shallow-history' | 'unreadable' }[] = [];
  const entries: TreeEntry[] = [];
  const treeSplit = nullSplit();
  await gitStream(pin.root, ['ls-tree', '-r', '-l', '-z', pin.commit], (chunk) => {
    for (const part of treeSplit.push(chunk)) {
      const entry = treeEntryOf(part);
      if (entry !== undefined) entries.push(entry);
    }
  });
  for (const part of treeSplit.done()) {
    const entry = treeEntryOf(part);
    if (entry !== undefined) entries.push(entry);
  }
  // Git's own text-or-binary answer and its line count, in one call over the whole tree against the
  // empty tree: the added count is the file's own line count, and `-` is a blob git calls binary.
  const text = new Map<string, { added: number | null; removed: number | null }>();
  const numstatSplit = nullSplit();
  const takeNumstat = (chunk: string): void => {
    if (chunk === '') return;
    const parts = chunk.split('\t');
    if (parts.length < 3) return;
    text.set(parts[2]!, { added: parts[0] === '-' ? null : Number(parts[0]), removed: parts[1] === '-' ? null : Number(parts[1]) });
  };
  await gitStream(pin.root, ['diff', '--numstat', '--no-renames', '-z', await emptyTreeOf(pin.root), pin.commit], (chunk) => {
    for (const part of numstatSplit.push(chunk)) takeNumstat(part);
  });
  for (const part of numstatSplit.done()) takeNumstat(part);
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
    const held = text.get(entry.path);
    const form = held?.added === null || held?.added === undefined ? 'binary' : 'text';
    const language = overrides.get(entry.path) ?? languageOfPath(entry.path);
    files.push({
      path: entry.path,
      mode: entry.mode === '100755' ? '100755' : entry.mode === '120000' ? '120000' : '100644',
      blob: entry.blob,
      bytes: entry.size ?? 0,
      form,
      lines: form === 'text' ? (held?.added ?? 0) : null,
      language: typeof language === 'string' ? language : language.language,
      candidates: typeof language === 'string' ? [language] : language.candidates,
    });
  }
  files.sort((left, right) => byCodePoint(left.path, right.path));
  gitlinks.sort((left, right) => byCodePoint(left.path, right.path));
  return { repository: { name: pin.repository, url: pin.url, ...(pin.defaultBranch === undefined ? {} : { defaultBranch: pin.defaultBranch }) }, commit: pin.commit, files, gitlinks, gaps };
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

/**
 * Splits one log stream into its commits as it arrives: a header block, then the
 * diff entries the next block ends. The stream is read once — the parser keeps
 * the commits' headers and entries, never a second copy of git's own bytes.
 */
function logStreams(): { push(chunk: Uint8Array): void; done(): { header: LogHeader; entries: string[] }[] } {
  const split = nullSplit();
  const out: { header: LogHeader; entries: string[] }[] = [];
  const take = (chunk: string): void => {
    const part = chunk.startsWith('\n') ? chunk.slice(1) : chunk;
    if (part.startsWith('\u001f')) {
      const fields = part.slice(1).split('\u001f');
      if (fields.length < 7) return;
      out.push({ header: { hash: fields[0]!, parents: fields[1] === '' ? [] : fields[1]!.split(' '), authorName: fields[2]!, authorEmail: fields[3]!, authorDate: fields[4]!, commitDate: fields[5]!, subject: fields[6]! }, entries: [] });
      return;
    }
    if (part === '' || out.length === 0) return;
    out[out.length - 1]!.entries.push(part);
  };
  return {
    push(chunk: Uint8Array): void { for (const part of split.push(chunk)) take(part); },
    done(): { header: LogHeader; entries: string[] }[] { for (const part of split.done()) take(part); return out; },
  };
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
export async function readRepositoryHistory(pin: RepositoryAt): Promise<HistoryPublish> {
  type Touched = HistoryCommit['touched'][number];
  const gaps: { what: string; reason: 'non-utf8-path' | 'shallow-history' | 'unreadable' }[] = [];
  const shallow = await shallowGapOf(pin);
  if (shallow !== null) gaps.push(shallow);
  const statusParser = logStreams();
  await gitStream(pin.root, ['log', '--diff-merges=first-parent', '--name-status', '-M', '--use-mailmap', '-z', `--format=${LOG_FORMAT}`, pin.commit], (chunk) => statusParser.push(chunk));
  const statuses = statusParser.done();
  const countParser = logStreams();
  await gitStream(pin.root, ['log', '--diff-merges=first-parent', '--numstat', '-M', '--use-mailmap', '-z', `--format=${LOG_FORMAT}`, pin.commit], (chunk) => countParser.push(chunk));
  const counts = countParser.done();
  const countByKey = new Map<string, { added: number | null; removed: number | null }>();
  for (const stream of counts) {
    for (let at = 0; at < stream.entries.length; at += 1) {
      const entry = stream.entries[at]!;
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(entry);
      if (match === null) continue;
      const added = match[1] === '-' ? null : Number(match[1]);
      const removed = match[2] === '-' ? null : Number(match[2]);
      if (match[3] !== '') { countByKey.set(`${stream.header.hash}\u0000${match[3]}`, { added, removed }); continue; }
      // A rename's numstat names the old path and the new one in the next two entries.
      const oldPath = stream.entries[at + 1] ?? '';
      const newPath = stream.entries[at + 2] ?? '';
      countByKey.set(`${stream.header.hash}\u0000${newPath}`, { added, removed });
      void oldPath;
      at += 2;
    }
  }
  const commits: HistoryCommit[] = [];
  for (const stream of statuses) {
    const touched: Touched[] = [];
    for (let at = 0; at < stream.entries.length; at += 1) {
      const entry = stream.entries[at]!;
      const status = /^([ACDMRT])(\d*)$/.exec(entry);
      if (status === null) continue;
      const change = (status[1] === 'A' ? 'added' : status[1] === 'D' ? 'deleted' : status[1] === 'R' ? 'renamed' : 'modified') as Touched['change'];
      if (change === 'renamed') {
        const previousPath = stream.entries[at + 1] ?? '';
        const path = stream.entries[at + 2] ?? '';
        at += 2;
        const held = countByKey.get(`${stream.header.hash}\u0000${path}`) ?? { added: null, removed: null };
        touched.push({ path, change, added: held.added, removed: held.removed, previousPath });
        continue;
      }
      const path = stream.entries[at + 1] ?? '';
      at += 1;
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
  readonly publishTree: (input: TreePublish) => Promise<RecordCounts>;
  readonly publishHistory: (input: HistoryPublish) => Promise<RecordCounts>;
  /** The repository paths this fill covers, as prefixes (`src/` covers everything under it); the whole tree when left out. */
  readonly paths?: readonly string[];
}

/** The unit id of one repository's pass: `repository:<name>`, the same for both passes of it. */
export function repositoryUnitId(repository: string): string {
  return `repository:${repository}`;
}

/** The repository a unit id names, refused by name where it names none. */
export function repositoryOfUnit(unitId: string): string {
  const match = /^repository:(.+)$/.exec(unitId);
  if (match === null || match[1] === '') throw new Error(`the unit id ${JSON.stringify(unitId)} is not one of the repository passes, which are "repository:<name>" (src/fill/stages/repository-facts.ts)`);
  return match[1]!;
}

/** The pin one repository's unit reads, refused where the run pins no such repository. */
async function pinOf(sources: SnapshotSource, repository: string): Promise<RepositoryAt> {
  const pins = await sources.pins();
  const pin = pins.find((entry) => entry.id === repository);
  if (pin === undefined) throw new Error(`the run pins no repository ${JSON.stringify(repository)}: its pins are ${pins.map((entry) => JSON.stringify(entry.id)).join(', ') || 'none'} (src/fill/stages/repository-facts.ts)`);
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
      const covered = wiring.paths === undefined ? read : {
        ...read,
        files: read.files.filter((file) => wiring.paths!.some((prefix) => file.path === prefix || file.path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))),
        gitlinks: read.gitlinks.filter((link) => wiring.paths!.some((prefix) => link.path === prefix || link.path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))),
      };
      const counts = await wiring.publishTree(covered);
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
      const counts = await wiring.publishHistory(read);
      context.progress(`${pin.repository}: ${String(read.commits.length)} commits, ${String(counts.inserted)} rows written`, 1);
      return { outcome: 'draft' };
    },
    validate: () => ({ ok: true }),
  };
}
