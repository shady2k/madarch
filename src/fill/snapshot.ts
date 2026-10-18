/**
 * The snapshot reader (decision 0026, stage 0): one repository pinned at one
 * commit, its tree listed as git holds it and its files' bytes read as that
 * commit holds them. Every deterministic stage reads code through this and
 * nothing else: no stage reads a checkout's working tree, and a fact's cited
 * bytes are the pinned commit's bytes whatever stands in the folder now.
 *
 * The reader answers the same tree and the same bytes as `git ls-tree -r` and
 * `git cat-file` at the commit (a test compares them), and it refuses what it
 * cannot answer, naming the repository, the commit and — wherever a path is
 * what the refusal is about — that path:
 *
 * - the repository's folder is not a git repository, or git cannot read it;
 * - the commit is not in the repository (a branch name, a short id or any other
 *   revision is resolved here, and the resolved commit is what the facts name);
 * - a path a caller asks for is not a repository path, is not in the tree at the
 *   commit, holds a directory, or holds a submodule's commit rather than this
 *   repository's bytes;
 * - the tree git listed is not a tree this reader reads: a row without a shape,
 *   an object id that is no object id, a size that is no byte count, an entry
 *   mode or object type this reader does not know.
 *
 * **A path taken from the tree is never folded, and a path a caller asks for is
 * read in the fill's own form.** Git separates with `/` on every machine, so a
 * backslash in a tree's name is a byte of that name; folding it (which
 * `repositoryPath` does for a machine path a caller writes) would name another
 * file, so the tree's path is read as it stands and a tree path that is no path
 * a fact holds is reported by `unfiled()` — named, never renamed and never
 * dropped in silence. A path a *caller* passes (`entry`, `requireEntry`, `read`)
 * is the fill's own form, where a backslash is a separator, exactly as the
 * schema reads a repository path everywhere else.
 *
 * Nothing here writes: the reader opens no index, changes no ref and touches no
 * file of the checkout it reads (`git ls-tree` and `git cat-file` are read-only
 * plumbing). A tree of any size is read once, when the reader is opened, and the
 * entries are held in the project's code point order (`byCodePoint`, the order a
 * fact's own lists are read in) — the same order git lists for every name of the
 * basic plane.
 */
import { execFile } from 'node:child_process';
import { byCodePoint } from '../model/order.js';
import { ID_PATTERN } from '../model/schema.js';
import { REPOSITORY_FORMS, repositoryPath, type RepositoryForm, type RepositoryPath } from './facts.js';

// ---- what a refusal names -------------------------------------------------

/** Why a snapshot was refused: the thing the refusal is about. */
export type SnapshotRefusal =
  /** The folder the repository stands in is no git repository, or git cannot read it. */
  | 'no-repository'
  /** The commit is not in the repository. */
  | 'no-commit'
  /** The tree git listed is not a tree this reader reads: a row without a shape, an object id that is no id, a size that is no byte count. */
  | 'unreadable-tree'
  /** The path is not a repository path: absolute, climbing out, of a machine's drive, or empty. */
  | 'not-a-repository-path'
  /** The path is not in the tree at the commit. */
  | 'not-in-tree'
  /** The path holds a submodule's commit, whose bytes stand in another repository. */
  | 'not-read-here'
  /** Git could not answer an object the tree named. */
  | 'object-unreadable'
  /** The bytes git answered are not the size the tree stated for them. */
  | 'changed-bytes'
  /** The tree holds an entry mode this reader does not know. */
  | 'unknown-mode';

/**
 * One refusal of the reader. It always names the repository and the commit it
 * was read at, and the path wherever the refusal is about one; `detail` holds
 * the refusal's own words for a caller that reports the rest itself.
 */
export class SnapshotError extends Error {
  readonly repository: string;
  /** The commit, as the reader resolved it; the pin's own text where it could not be resolved. */
  readonly commit: string;
  /** The repository path the refusal is about, where it is about one. */
  readonly path?: string;
  readonly refusal: SnapshotRefusal;
  /** The refusal's words without the repository, the commit and the path in front of them. */
  readonly detail: string;

  constructor(input: {
    repository: string;
    commit: string;
    refusal: SnapshotRefusal;
    detail: string;
    path?: string;
  }) {
    const where = `the repository ${JSON.stringify(input.repository)} at commit ${input.commit}`;
    const at = input.path === undefined ? '' : `, path ${JSON.stringify(input.path)}`;
    super(`${where}${at}: ${input.detail}`);
    this.name = 'SnapshotError';
    this.repository = input.repository;
    this.commit = input.commit;
    this.path = input.path;
    this.refusal = input.refusal;
    this.detail = input.detail;
  }
}

// ---- the tree the commit holds --------------------------------------------

/** The modes git writes for a tree entry: a plain file, an executable, a symbolic link, a submodule. */
export const SNAPSHOT_MODES = ['100644', '100755', '120000', '160000'] as const;
export type SnapshotMode = (typeof SNAPSHOT_MODES)[number];

/** What git holds at an entry's path: this repository's bytes, a link's target, or a submodule's commit. */
export const SNAPSHOT_ENTRY_FORMS = ['blob', 'commit', 'link'] as const;
export type SnapshotEntryForm = (typeof SNAPSHOT_ENTRY_FORMS)[number];

/** The form a mode carries: a mode this reader does not know is refused, never guessed. */
const FORM_OF_MODE: Readonly<Record<SnapshotMode, SnapshotEntryForm>> = {
  '100644': 'blob',
  '100755': 'blob',
  '120000': 'link',
  '160000': 'commit',
};

/** One entry of the tree at the pinned commit, as `git ls-tree -r` lists it. */
export interface SnapshotEntry {
  /** The path from the repository's root, never a machine path. */
  readonly path: RepositoryPath;
  readonly mode: SnapshotMode;
  readonly form: SnapshotEntryForm;
  /**
   * The object git holds at the path: a file's or a link's blob id, or the
   * commit id a submodule stands at. 40 lower-case hexadecimal digits.
   */
  readonly id: string;
  /** The object's size in bytes, as the tree states it; absent for a submodule's commit. */
  readonly bytes?: number;
}

/** Whether the reader can answer this entry's bytes: a file's or a link's, never a submodule's. */
export function isReadableEntry(entry: SnapshotEntry): boolean {
  return entry.form === 'blob' || entry.form === 'link';
}

/**
 * One entry of the tree the reader listed and cannot file: the tree's own path
 * is not one a fact can hold (a fact's paths are repository paths, separated by
 * `/`, and a name that would have to be changed to fit is never changed). It is
 * named here rather than dropped, nothing is read for it, and a stage's
 * coverage names it as what could not be read — a file the fill forgot in
 * silence would be a hole in the graph nobody can see.
 */
export interface UnfiledEntry {
  /** The path git lists, byte for byte, exactly as the tree holds it. */
  readonly path: string;
  readonly mode: SnapshotMode;
  readonly form: SnapshotEntryForm;
  readonly id: string;
  readonly bytes?: number;
  /** Why this path is no path of a fact, in the reader's own words. */
  readonly why: string;
}

// ---- the repository to pin -------------------------------------------------

/**
 * One repository this product pins: the product's own name for it, the folder
 * its commit is read from, and the commit to pin. The folder is a machine path
 * and reaches no fact; the name and the commit are what a fact carries.
 */
export interface RepositoryPin {
  /** The product's own name for the repository (a fact's `repository`), never a path or a URL. */
  readonly id: string;
  /** A code repository, or the product repository itself (decision 0021). */
  readonly form: RepositoryForm;
  /** The checkout the commit's objects are read from: a machine path, never a fact's. */
  readonly root: string;
  /** The commit to pin: a full id, or any revision git resolves to one. */
  readonly commit: string;
  /** The branch the repository was read on, when the price of a pin is not yet paid. */
  readonly defaultBranch?: string;
}

// ---- running git ----------------------------------------------------------

/** What one git call answered, whether it succeeded or not: the reader decides what a failure means. */
interface GitAnswer {
  readonly ok: boolean;
  readonly stdout: Buffer;
  readonly stderr: string;
  /** What the call itself failed with when it never answered — a buffer past this reader's own, a git that could not start. */
  readonly failure?: string;
}

/** Runs one read-only git command in the checkout; nothing here writes, so a caller cannot mutate what it reads. */
function git(root: string, args: readonly string[]): Promise<GitAnswer> {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, ...args], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8');
      const err = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
      resolve({
        ok: error === null,
        stdout: out,
        stderr: err.trim(),
        ...(error === null || error.message === '' ? {} : { failure: error.message }),
      });
    });
  });
}

/**
 * What a failed git call said, for a refusal that names it: git's own words
 * where it spoke, the call's own failure where it never answered at all (a
 * buffer past this reader's limit, a git that could not start), and "answered
 * nothing" only where neither said anything.
 */
function why(answer: GitAnswer): string {
  if (answer.stderr !== '') return `git said ${JSON.stringify(answer.stderr)}`;
  if (answer.failure !== undefined) return `the call itself failed: ${answer.failure}`;
  return 'git answered nothing';
}

// ---- the reader -----------------------------------------------------------

/** The source every fact the reader's two stages write stands on: git, at the version this machine runs. */
export interface SnapshotSourceRef {
  readonly system: string;
  readonly version: string;
}

/**
 * One repository bound to one commit: its tree, listed in code point order of
 * the paths, and its files' bytes. Open it once per repository and commit
 * (`SnapshotReader.open`) and read as many entries as needed; the tree is read
 * when the reader opens, so a lookup costs nothing and a byte read costs one
 * `git cat-file`.
 */
export class SnapshotReader {
  private readonly pin: RepositoryPin;
  private readonly resolvedCommit: string;
  private readonly treeId: string;
  private readonly held: readonly SnapshotEntry[];
  /** The entries by path: a lookup is one map read, however big the tree is. */
  private readonly byPath: ReadonlyMap<string, SnapshotEntry>;
  private readonly unfiledEntries: readonly UnfiledEntry[];
  private readonly reader: SnapshotSourceRef;
  /** The entries whose bytes this reader can answer, worked out once. */
  private filesHeld: readonly SnapshotEntry[] | undefined;

  private constructor(pin: RepositoryPin, resolvedCommit: string, treeId: string, tree: readonly SnapshotEntry[], unfiled: readonly UnfiledEntry[], reader: SnapshotSourceRef) {
    this.pin = pin;
    this.resolvedCommit = resolvedCommit;
    this.treeId = treeId;
    this.held = tree;
    this.byPath = new Map(tree.map((entry) => [entry.path, entry]));
    this.unfiledEntries = unfiled;
    this.reader = reader;
  }

  /**
   * Binds a reader to one repository at one commit, reading the tree once.
   * Everything that can be wrong with the pin is refused here: a folder git
   * cannot read as a repository, a revision the repository does not hold, a
   * tree entry whose mode this reader does not know.
   */
  static async open(pin: RepositoryPin): Promise<SnapshotReader> {
    const repository = pin.id;
    // The folder is read as a repository first: a commit that is not in a
    // folder that is no repository says the folder is the fault, not the commit.
    const held = await git(pin.root, ['rev-parse', '--git-dir']);
    if (!held.ok) {
      throw new SnapshotError({
        repository,
        commit: pin.commit,
        refusal: 'no-repository',
        detail: `${JSON.stringify(pin.root)} is no repository this reader can read: ${why(held)}`,
      });
    }
    const version = await git(pin.root, ['--version']);
    const pinned = await git(pin.root, ['rev-parse', '--verify', `${pin.commit}^{commit}`]);
    if (!pinned.ok) {
      throw new SnapshotError({
        repository,
        commit: pin.commit,
        refusal: 'no-commit',
        detail: `${JSON.stringify(pin.commit)} is not a commit of the repository read from ${JSON.stringify(pin.root)}: ${why(pinned)}`,
      });
    }
    const resolvedCommit = pinned.stdout.toString('utf8').trim();
    const listed = await git(pin.root, ['ls-tree', '-r', '-l', '-z', '--full-tree', resolvedCommit]);
    if (!listed.ok) {
      throw new SnapshotError({
        repository,
        commit: resolvedCommit,
        refusal: 'no-commit',
        detail: `the tree of ${resolvedCommit} could not be listed: ${why(listed)}`,
      });
    }
    const treeId = await git(pin.root, ['rev-parse', '--verify', `${resolvedCommit}^{tree}`]);
    if (!treeId.ok) {
      throw new SnapshotError({
        repository,
        commit: resolvedCommit,
        refusal: 'no-commit',
        detail: `the tree id of ${resolvedCommit} could not be read: ${why(treeId)}`,
      });
    }
    const tree = parseTree(listed.stdout, repository, resolvedCommit);
    return new SnapshotReader(pin, resolvedCommit, treeId.stdout.toString('utf8').trim(), tree.entries, tree.unfiled, {
      system: 'git',
      version: gitVersionOf(version.stdout.toString('utf8')),
    });
  }

  /** The product's own name for the repository. */
  get repository(): string {
    return this.pin.id;
  }

  /** Whether the repository is a code repository or the product repository itself. */
  get form(): RepositoryForm {
    return this.pin.form;
  }

  /** The checkout the commit's objects are read from: a machine path, never a fact's. */
  get root(): string {
    return this.pin.root;
  }

  /** The commit that was pinned, as git resolved it: what every fact of this reader names. */
  get commit(): string {
    return this.resolvedCommit;
  }

  /** The git tree id of the pinned commit. */
  get tree(): string {
    return this.treeId;
  }

  /** The branch the repository was pinned on, when the product named one. */
  get defaultBranch(): string | undefined {
    return this.pin.defaultBranch;
  }

  /** What the facts read here stand on: git, at this machine's version. */
  get source(): SnapshotSourceRef {
    return this.reader;
  }

  /** Every tree entry, in the project's code point order of the paths; a submodule's commit among them. */
  entries(): readonly SnapshotEntry[] {
    return this.held;
  }

  /** The entries whose bytes this reader can answer: files and symbolic links, in the same order. */
  files(): readonly SnapshotEntry[] {
    this.filesHeld ??= this.held.filter(isReadableEntry);
    return this.filesHeld;
  }

  /**
   * The tree entries the reader listed and cannot file, because the tree's own
   * path is not one a fact holds. None of them is in `entries()`: a path the
   * fill would have to change is never renamed, and it is never dropped in
   * silence either — a stage names each of them in its coverage.
   */
  unfiled(): readonly UnfiledEntry[] {
    return this.unfiledEntries;
  }

  /**
   * The entry at the path: `undefined` when the tree holds none. A path that is
   * no repository path is refused rather than looked up, since a machine path
   * must never read as "the tree does not hold it".
   */
  entry(path: string): SnapshotEntry | undefined {
    return this.byPath.get(asRepositoryPath(path, this.pin.id, this.resolvedCommit));
  }

  /** How many files (and links) the tree holds. */
  get fileCount(): number {
    return this.files().length;
  }

  /** The bytes the tree's files add up to, as the tree states their sizes. */
  get byteCount(): number {
    return this.files().reduce((total, entry) => total + (entry.bytes ?? 0), 0);
  }

  /**
   * The bytes of one file at the pinned commit. A path the tree does not hold,
   * a path that holds a submodule, or a path that is no repository path is
   * refused, naming the repository, the commit and the path.
   */
  async read(path: string): Promise<Uint8Array> {
    const entry = this.requireEntry(path);
    if (entry.form === 'commit') {
      throw new SnapshotError({
        repository: this.pin.id,
        commit: this.resolvedCommit,
        path: entry.path,
        refusal: 'not-read-here',
        detail: `${JSON.stringify(entry.path)} holds the commit ${entry.id} of another repository: this reader answers this repository's bytes, and a submodule's tree stands in the repository it names`,
      });
    }
    const answered = await git(this.pin.root, ['cat-file', 'blob', entry.id]);
    if (!answered.ok) {
      throw new SnapshotError({
        repository: this.pin.id,
        commit: this.resolvedCommit,
        path: entry.path,
        refusal: 'object-unreadable',
        detail: `the bytes of ${JSON.stringify(entry.path)} (blob ${entry.id}) could not be read from ${JSON.stringify(this.pin.root)}: ${why(answered)}`,
      });
    }
    if (entry.bytes !== undefined && answered.stdout.byteLength !== entry.bytes) {
      throw new SnapshotError({
        repository: this.pin.id,
        commit: this.resolvedCommit,
        path: entry.path,
        refusal: 'changed-bytes',
        detail: `the tree states ${entry.bytes} bytes for ${JSON.stringify(entry.path)} and git answered ${answered.stdout.byteLength}: the bytes of a commit do not change`,
      });
    }
    return answered.stdout;
  }

  /** The bytes of one file as text, decoded as UTF-8: what a manifest, a document or a source file is read as. */
  async readText(path: string): Promise<string> {
    return Buffer.from(await this.read(path)).toString('utf8');
  }

  /** The entry at the path, refused where the tree holds none: the read path's own lookup. */
  requireEntry(path: string): SnapshotEntry {
    const wanted = asRepositoryPath(path, this.pin.id, this.resolvedCommit);
    const entry = this.byPath.get(wanted);
    if (entry === undefined) {
      throw new SnapshotError({
        repository: this.pin.id,
        commit: this.resolvedCommit,
        path: wanted,
        refusal: 'not-in-tree',
        detail: `${JSON.stringify(wanted)} is not in the tree of this commit: no file of this repository stands there (a folder holds no bytes of its own)`,
      });
    }
    return entry;
  }
}

/** The reader's own version, as `git --version` words it: the last token it prints (`git version 2.43.0`). */
function gitVersionOf(text: string): string {
  const line = text.trim();
  const version = /(\S+)$/.exec(line);
  return version === null ? line : version[1]!;
}

/** A path read as a repository path, refused with the repository, the commit and the path the caller gave. */
function asRepositoryPath(path: string, repository: string, commit: string): RepositoryPath {
  try {
    return repositoryPath(path);
  } catch (error) {
    throw new SnapshotError({
      repository,
      commit,
      path,
      refusal: 'not-a-repository-path',
      detail: `${(error as Error).message}; a path read from the tree is the repository's own, separated by "/", from its root`,
    });
  }
}

/**
 * One `git ls-tree -r -l -z` answer, as the entries it lists and the entries it
 * cannot file. A row git does not write as this reader reads trees, an entry
 * whose mode this reader does not know, an object id that is no object id and a
 * size that is no byte count are all refused: an entry dropped in silence would
 * be a file the fill never learns about.
 *
 * A tree's path is taken exactly as git writes it, and **never folded**: git
 * separates with `/` on every machine, so a backslash in a name is a byte of
 * that name and not a separator, and a name the fill's path form cannot hold is
 * named as unfiled instead of being renamed into another file's path.
 */
function parseTree(output: Buffer, repository: string, commit: string): { entries: readonly SnapshotEntry[]; unfiled: readonly UnfiledEntry[] } {
  const entries: SnapshotEntry[] = [];
  const unfiled: UnfiledEntry[] = [];
  for (const row of output.toString('utf8').split('\0')) {
    if (row === '') continue;
    const tab = row.indexOf('\t');
    const path = tab < 0 ? row : row.slice(tab + 1);
    const malformed = (detail: string): Error => new SnapshotError({ repository, commit, refusal: 'unreadable-tree', detail });
    if (tab < 0) {
      throw malformed(`git listed a tree entry without a path: ${JSON.stringify(row)}`);
    }
    const [mode, type, id, size] = row.slice(0, tab).split(/\s+/u);
    if (mode === undefined || type === undefined || id === undefined || size === undefined) {
      throw malformed(`git listed the tree entry ${JSON.stringify(row)} in a shape this reader does not know: a row is "<mode> <type> <object> <size>\\t<path>"`);
    }
    if (!(SNAPSHOT_MODES as readonly string[]).includes(mode)) {
      throw new SnapshotError({
        repository,
        commit,
        path,
        refusal: 'unknown-mode',
        detail: `git listed the mode ${JSON.stringify(mode)} for this path, and the tree's modes are ${SNAPSHOT_MODES.join(', ')}: this reader does not guess what a mode it does not know holds`,
      });
    }
    const entryMode = mode as SnapshotMode;
    const form = FORM_OF_MODE[entryMode];
    if (form !== 'commit' && type !== 'blob') {
      throw malformed(`git listed the object type ${JSON.stringify(type)} under the mode ${entryMode}, which holds a blob: this reader reads trees git wrote`);
    }
    if (!/^[0-9a-f]{40}$/u.test(id)) {
      throw malformed(`git listed the object id ${JSON.stringify(id)}, which is no object id: an object id is 40 lower-case hexadecimal digits`);
    }
    // The size is `-` for an entry whose object is no blob, and a byte count
    // for every other: a size that is neither is a row this reader misreads.
    const bytes = size === '-' ? undefined : Number(size);
    if (size !== '-' && !Number.isInteger(bytes)) {
      throw malformed(`git listed the size ${JSON.stringify(size)} for this path, which is no byte count`);
    }
    const sized = bytes === undefined ? {} : { bytes };
    const fillable = fillablePath(path);
    if ('why' in fillable) {
      unfiled.push({ path, mode: entryMode, form, id, ...sized, why: fillable.why });
      continue;
    }
    entries.push({ path: fillable.path, mode: entryMode, form, id, ...sized });
  }
  return {
    entries: entries.sort((left, right) => byCodePoint(left.path, right.path)),
    unfiled: unfiled.sort((left, right) => byCodePoint(left.path, right.path)),
  };
}

/**
 * A tree's path as the path of a fact, or why it is no such path. Git's paths
 * are `/`-separated already, so nothing here folds a separator: a backslash in
 * a name would be folded by `repositoryPath`, and folding it would name another
 * file, so such a name is refused here instead. The rest of the path's rules
 * are the schema's own, read through `repositoryPath`.
 */
function fillablePath(path: string): { path: RepositoryPath } | { why: string } {
  if (path.includes('\\')) {
    return {
      why: `the tree holds the name ${JSON.stringify(path)}, which carries a backslash: the fill's repository paths separate with "/", so this name is the name of a file the fill cannot file as it stands`,
    };
  }
  try {
    return { path: repositoryPath(path) };
  } catch (error) {
    return { why: (error as Error).message };
  }
}

// ---- the repositories a run pins ------------------------------------------

/**
 * How a stage reaches the repositories this product pins (decision 0026,
 * stage 0): the pins of the run, and one reader per repository. A stage never
 * reaches a checkout itself — the wiring names the pins, and the stage asks
 * this source for a repository's tree and bytes.
 */
export interface SnapshotSource {
  /** The repositories the run pins, in code point order of their ids. */
  pins(): Promise<readonly RepositoryPin[]>;
  /** One repository's reader, refused where this source holds no such repository. */
  open(repository: string): Promise<SnapshotReader>;
}

/** The pins of one run, or a function read when they are asked for (a run's pins are read per run). */
export type RepositoryPins = readonly RepositoryPin[] | (() => Promise<readonly RepositoryPin[]> | readonly RepositoryPin[]);

/**
 * The source over real git checkouts: the pins given here, read fresh where the
 * caller hands a function, and one `SnapshotReader` per repository, commit and
 * folder. The pin itself is judged once, when the pins are read — a name that is
 * no repository name, a form that is no form of a repository, a folder without a
 * name, a commit without a name — and a duplicate id is refused there too: a pin
 * this reader cannot use is one no stage should plan with. Every pin is judged
 * before any is sorted, so a pin that is no pin at all is named rather than
 * thrown out of by the sort.
 *
 * A reader is held while a run fills, because a unit's `execute` must not list a
 * large tree again for every file it writes: the tree of one commit does not
 * change, so one reader answers as many units as ask it. The last few readers
 * stand (eight by default) and a new commit is a new reader; a reader whose open
 * failed is not held.
 */
export function createGitSnapshotSource(pins: RepositoryPins, options: { readonly readersHeld?: number } = {}): SnapshotSource {
  const held = new Map<string, Promise<SnapshotReader>>();
  const limit = Math.max(1, options.readersHeld ?? 8);
  const current = async (): Promise<readonly RepositoryPin[]> => {
    const read = typeof pins === 'function' ? await pins() : pins;
    const seen = new Set<string>();
    for (const pin of read) {
      const problem = pinProblem(pin);
      if (problem !== undefined) throw new Error(problem);
      if (seen.has(pin.id)) {
        throw new Error(`the repository ${JSON.stringify(pin.id)} is pinned twice: one run pins one repository once (two commits of one repository are two snapshots, not two pins)`);
      }
      seen.add(pin.id);
    }
    return [...read].sort((left, right) => byCodePoint(left.id, right.id));
  };
  return {
    pins: current,
    async open(repository: string): Promise<SnapshotReader> {
      const pins = await current();
      const pin = pins.find((candidate) => candidate.id === repository);
      if (pin === undefined) {
        const known = pins.map((candidate) => candidate.id);
        throw new Error(`the repository ${JSON.stringify(repository)} is not one this run pins: it pins ${known.length === 0 ? 'no repository' : known.map((id) => JSON.stringify(id)).join(', ')}`);
      }
      const key = `${pin.id}\u0000${pin.commit}\u0000${pin.root}`;
      const standing = held.get(key);
      if (standing !== undefined) return await standing;
      const opened = SnapshotReader.open(pin);
      held.set(key, opened);
      void opened.catch(() => held.delete(key));
      while (held.size > limit) {
        const oldest = held.keys().next().value;
        if (oldest === undefined) break;
        held.delete(oldest);
      }
      return await opened;
    },
  };
}

/** What is wrong with one pin, in the pin's own words; `undefined` when it reads. */
function pinProblem(pin: RepositoryPin): string | undefined {
  if (pin === null || typeof pin !== 'object') return `${JSON.stringify(pin)} is no pinned repository: a pin names the repository, its folder and its commit`;
  if (typeof pin.id !== 'string' || !ID_PATTERN.test(pin.id)) {
    return `${JSON.stringify(pin.id)} is no repository name: the product's own name for the repository, like "orders-api", never a path or a URL`;
  }
  if (!(REPOSITORY_FORMS as readonly string[]).includes(pin.form)) {
    return `the repository ${JSON.stringify(pin.id)} is pinned as ${JSON.stringify(pin.form)}, and a repository is one of ${REPOSITORY_FORMS.join(', ')}`;
  }
  if (typeof pin.root !== 'string' || pin.root === '') {
    return `the repository ${JSON.stringify(pin.id)} names no folder to read: a pin names the checkout its commit is read from`;
  }
  if (typeof pin.commit !== 'string' || pin.commit.trim() === '') {
    return `the repository ${JSON.stringify(pin.id)} names no commit to pin: a pin names the commit (or the revision git resolves to one)`;
  }
  if (pin.defaultBranch !== undefined && (typeof pin.defaultBranch !== 'string' || pin.defaultBranch.trim() === '')) {
    return `the repository ${JSON.stringify(pin.id)} names the default branch ${JSON.stringify(pin.defaultBranch)}, which is no branch name`;
  }
  return undefined;
}
