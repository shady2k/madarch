/**
 * The repository pages of the wiki, read from this step's graph (madarch-8bdc.2.5,
 * items 2 and 3): the repository, a folder, a file and a commit, from the record
 * tables and nothing else. The page models are the store's own answers — the
 * wiki holds no fact of its own — and every one of them says the commit it is
 * true at.
 *
 * A page whose step has not run is not built: a store without a tree has no
 * folder and no file, and a store without a history has no commit. The caller
 * answers with the step named rather than an empty page.
 */
import { commitWithPaths, fileFacts, fileHistory, folderChildrenOf, folderFiles, listDirectories, listFiles, listRepositories, repositoryFacts, type FileDate, type FileRecord } from '../graph/index.js';
import { withSpan } from '../obs/trace.js';
import { byCodePoint } from '../model/order.js';
import type { RepositoryCounts } from './model.js';

/** The store the pages read: the graph store's own owner, as the reads name it. */
type RecordOwner = Parameters<typeof listFiles>[0];

/** One file as a page shows it. */
interface PageFile {
  readonly path: string;
  readonly mode: string | null;
  readonly blob: string | null;
  readonly bytes: number | null;
  readonly lines: number | null;
  readonly form: 'text' | 'binary' | null;
  readonly language: string | null;
  readonly candidates: readonly string[];
}

/** One commit of a file's history. */
interface PageHistoryRow {
  readonly commit: string;
  readonly change: string;
  readonly added: number | null;
  readonly removed: number | null;
  readonly previousPath: string | null;
  /** The author's clock with its offset, as `git log %aI` writes it. */
  readonly date: string;
  /** The offset `date` stands at, in minutes east of UTC. */
  readonly offsetMin: number;
  readonly subject: string;
  readonly walk: number;
}

/** The repository as its page states it. */
export interface RepositoryPageModel {
  readonly repository: string;
  readonly url: string;
  readonly defaultBranch: string | null;
  readonly asIsCommit: string | null;
  readonly counts: RepositoryCounts;
  readonly gaps: readonly { readonly what: string; readonly reason: string }[];
  /** The steps of this fill that have run, as the store says. */
  readonly steps: { readonly tree: boolean; readonly history: boolean };
}

/**
 * The repository a page is about: the one the caller named when it named one
 * this store holds, and the first in code point order otherwise. A repository
 * the store does not hold answers null, which the caller states by name.
 */
export async function repositoryOf(owner: RecordOwner, named: string | null): Promise<string | null> {
  const held = await listRepositories(owner);
  if (named !== null && held.some((one) => one.name === named)) return named;
  return held.length === 0 ? null : held[0]!.name;
}

/** One repository's page, or null when the store holds it not. */
export async function repositoryPage(owner: RecordOwner, repository: string): Promise<RepositoryPageModel | null> {
  return await withSpan('wiki.repositoryPage', { 'wiki.repository': repository }, async () => {
    const facts = await repositoryFacts(owner, repository);
    if (facts === null) return null;
    return {
      repository: facts.name,
      url: facts.url,
      defaultBranch: facts.defaultBranch,
      asIsCommit: facts.asIsCommit,
      counts: { files: facts.fileCount, commits: facts.commitCount, folders: facts.directoryCount },
      gaps: facts.gaps.map((gap) => ({ what: gap.what, reason: gap.reason })),
      steps: { tree: facts.asIsCommit !== null, history: facts.commitCount > 0 },
    };
  });
}

/** One folder's page: its own subfolders and one page of its own files. */
export interface FolderPageModel {
  readonly repository: string;
  readonly asIsCommit: string | null;
  readonly folder: string;
  readonly parent: string | null;
  readonly folders: readonly string[];
  readonly files: readonly PageFile[];
  readonly next: string | null;
}

/** The files a folder page may hold at once; the page states its own bound. */
const FOLDER_PAGE_FILES = 100;

/** One folder's page, or null when the store holds no such folder or no tree at all. */
export async function folderPage(owner: RecordOwner, repository: string, folder: string, after: string | undefined, limit = FOLDER_PAGE_FILES): Promise<FolderPageModel | null> {
  return await withSpan('wiki.folderPage', { 'wiki.folder': folder }, async () => {
    const facts = await repositoryFacts(owner, repository);
    if (facts === null || facts.asIsCommit === null) return null;
    if (folder !== '') {
      const directories = await listDirectories(owner, repository);
      if (!directories.some((one) => one.path === folder)) return null;
      const parent = directories.find((one) => one.path === folder)?.parent ?? '';
      const page = await folderFiles(owner, { repository, folder, limit, ...(after === undefined ? {} : { after }) });
      return {
        repository: facts.name, asIsCommit: facts.asIsCommit, folder,
        parent: parent === '' ? null : parent,
        folders: [...(await folderChildrenOf(owner, repository, folder))].sort(byCodePoint),
        files: page.rows.map(pageFileOf), next: page.next,
      };
    }
    const page = await folderFiles(owner, { repository, folder, limit, ...(after === undefined ? {} : { after }) });
    return {
      repository: facts.name, asIsCommit: facts.asIsCommit, folder,
      parent: null,
      folders: [...(await folderChildrenOf(owner, repository, ''))].sort(byCodePoint),
      files: page.rows.map(pageFileOf), next: page.next,
    };
  });
}

function pageFileOf(file: FileRecord): PageFile {
  return {
    path: file.path, mode: file.mode, blob: file.blob, bytes: file.bytes, lines: file.lines,
    form: file.form, language: file.language, candidates: [...file.candidates],
  };
}

/** One path the store holds, as the kind `code.file` lists it: the file of one repository, and no fact of its page. */
interface RecordedFile {
  readonly path: string;
  readonly repository: string;
}

/** One bounded page of a repository's files, and the exact number of files the listing holds. */
export interface RecordedFilePage {
  readonly total: number;
  readonly rows: readonly RecordedFile[];
  readonly next: string | null;
}

/** How many paths one read of the listing holds: a page big enough that a count of a large repository is few reads. */
const RECORDED_FILE_COUNT_PAGE = 1_000;

/**
 * The number of files a repository's listing holds, filtered by a path prefix when one is given. The store's
 * `listFiles` answers a page and the path the next one starts at, and no count (the pages of a listing of two
 * thousand files are a handful of reads); a listing with no filter reads the repository's own recorded count.
 */
export async function recordedFileCount(owner: RecordOwner, repository: string, prefix?: string): Promise<number> {
  if (prefix === undefined || prefix === '') return (await repositoryFacts(owner, repository))?.fileCount ?? 0;
  let total = 0;
  let after: string | undefined;
  for (;;) {
    const page = await listFiles(owner, { repository, prefix, limit: RECORDED_FILE_COUNT_PAGE, ...(after === undefined ? {} : { after }) });
    total += page.rows.length;
    if (page.next === null) return total;
    after = page.next;
  }
}


/** The facts of one file the store holds, by the page id of the kind `code.file`: `code.file:<path>`. */
/**
 * One page of a repository's files in code-point order of their paths, and the exact number the listing holds: what
 * the wiki's kind `code.file` lists. The filter is a path prefix — a file stands at a place in a tree, and the
 * store's own listing takes a prefix, never a pattern.
 */
export async function recordedFiles(owner: RecordOwner, repository: string, options: { readonly after?: string; readonly prefix?: string; readonly limit: number }): Promise<RecordedFilePage> {
  return await withSpan('wiki.recordedFiles', { 'wiki.repository': repository }, async () => {
    const page = await listFiles(owner, { repository, limit: options.limit, ...(options.after === undefined ? {} : { after: options.after }), ...(options.prefix === undefined || options.prefix === '' ? {} : { prefix: options.prefix }) });
    return {
      total: await recordedFileCount(owner, repository, options.prefix),
      rows: page.rows.map((file) => ({ path: file.path, repository })),
      next: page.next,
    };
  });
}

/** One file's page: every fact of the file and one page of the commits that touched it. */
export interface FilePageModel {
  readonly repository: string;
  readonly asIsCommit: string | null;
  readonly file: PageFile;
  readonly created: FileDate | null;
  readonly modified: FileDate | null;
  readonly commitCount: number;
  readonly authors: readonly string[];
  readonly history: readonly PageHistoryRow[];
  readonly next: { readonly walk: number; readonly commit: string } | null;
}

/** The commits a file page holds at once. */
const FILE_PAGE_HISTORY = 50;

/** One file's page, or null when the store holds no such file or no tree at all. */
export async function filePage(owner: RecordOwner, repository: string, path: string, after: { readonly walk: number; readonly commit: string } | undefined, limit = FILE_PAGE_HISTORY): Promise<FilePageModel | null> {
  return await withSpan('wiki.filePage', { 'wiki.path': path }, async () => {
    const facts = await repositoryFacts(owner, repository);
    if (facts === null || facts.asIsCommit === null) return null;
    const file = await fileFacts(owner, repository, path);
    if (file === null) return null;
    const history = facts.commitCount === 0 ? undefined : await fileHistory(owner, { repository, path, limit, ...(after === undefined ? {} : { after }) });
    return {
      repository: facts.name, asIsCommit: facts.asIsCommit,
      file: pageFileOf(file),
      created: file.created, modified: file.modified,
      commitCount: file.commitCount, authors: [...file.authors],
      history: history?.rows.map((row) => ({
        commit: row.commit, change: row.change, added: row.added, removed: row.removed,
        previousPath: row.previousPath, date: row.date, offsetMin: row.offsetMin, subject: row.subject, walk: row.walk,
      })) ?? [],
      next: history?.next ?? null,
    };
  });
}

/** One commit's page: its facts and the paths it changed. */
export interface CommitPageModel {
  readonly repository: string;
  readonly asIsCommit: string | null;
  readonly hash: string;
  readonly author: { readonly name: string; readonly email: string };
  readonly authorDate: string;
  readonly authorOffsetMin: number;
  readonly commitDate: string;
  readonly commitOffsetMin: number;
  readonly subject: string;
  readonly parents: readonly string[];
  readonly changed: readonly { readonly path: string; readonly change: string; readonly added: number | null; readonly removed: number | null; readonly previousPath: string | null }[];
}

/** One commit's page, or null when the store holds no such commit or no history at all. */
export async function commitPage(owner: RecordOwner, repository: string, hash: string): Promise<CommitPageModel | null> {
  return await withSpan('wiki.commitPage', { 'wiki.commit': hash }, async () => {
    const facts = await repositoryFacts(owner, repository);
    if (facts === null || facts.asIsCommit === null || facts.commitCount === 0) return null;
    const commit = await commitWithPaths(owner, repository, hash);
    if (commit === null) return null;
    return {
      repository: facts.name, asIsCommit: facts.asIsCommit,
      hash: commit.hash,
      author: { name: commit.author.name, email: commit.author.email },
      authorDate: commit.authorDate, authorOffsetMin: commit.authorOffsetMin,
      commitDate: commit.commitDate, commitOffsetMin: commit.commitOffsetMin,
      subject: commit.subject, parents: [...commit.parents],
      changed: commit.touched.map((one) => ({ path: one.path, change: one.change, added: one.added, removed: one.removed, previousPath: one.previousPath })),
    };
  });
}
