/**
 * The product repository's own files as the graph holds them (madarch-hsqs stage C): its manifest and the declaration
 * files beside it, its Markdown entities, its templates and the files of the loop. The files producer read them into the
 * graph as files of the repository named after the product; a reader of the wiki reads this set, once per graph revision,
 * and never the checkout.
 *
 * The set is the whole file index of the product repository at one revision (paths, sizes, text or binary), and the text
 * of each file this read asked for. A file the index holds but this read did not fetch is refused by name instead of
 * answering absent: a reader that forgot a file is a defect, never a smaller result.
 */
import { contentsOf } from './stored-text.js';
import type { GraphReader } from '../knowledge/graph-read.js';
import type { ProductFileSource } from './product-files.js';
import { KINDS_FILE } from '../product/manifest/kinds.js';
import { WORKFLOWS_FILE } from '../product/manifest/workflows.js';
import { PLUGINS_LOCK_FILE } from './lock.js';

/** One file of the product repository, as the graph's tree pass holds it. */
interface IndexedFile {
  readonly bytes: number | null;
  readonly form: 'text' | 'binary' | null;
}

/** The files of one product repository at one graph revision, and the text this read fetched of them. */
export class StoredProductFiles implements ProductFileSource {
  private readonly index: Map<string, IndexedFile>;
  /** The text held for each fetched path: the store's content, or null where the store holds none. Shared by a fork. */
  private readonly held: Map<string, string | null>;

  private constructor(
    private readonly reader: GraphReader,
    private readonly repository: string,
    /** The product folder, for naming a file this read forgot in its own full path. */
    private readonly folder: string,
    index: readonly { path: string; bytes: number | null; form: 'text' | 'binary' | null }[],
    held: Map<string, string | null> = new Map(),
  ) {
    this.index = new Map(index.map((file) => [file.path, { bytes: file.bytes, form: file.form }] as const));
    this.held = held;
  }

  /** The product repository's whole file index as one graph revision holds it; a store with no such repository answers none. */
  static async load(reader: GraphReader, repository: string, folder: string): Promise<StoredProductFiles> {
    const rows = await reader.fileIndex(repository);
    // A symlink is a blob whose bytes are its target, never the file it names: no read follows one (the working tree's
    // readers skipped links too), so the index is the files the tree holds and no link entry.
    return new StoredProductFiles(reader, repository, folder, rows.filter((file) => file.mode !== '120000'));
  }

  /**
   * The same index read through another reader: a page's own transaction, so a file fetched while a page is drawn is
   * read in that page's transaction and not in a nested one. The index is the revision's; the text is this read's.
   */
  withReader(reader: GraphReader): StoredProductFiles {
    const rows = [...this.index].map(([path, file]) => ({ path, bytes: file.bytes, form: file.form }));
    // The text already fetched is the revision's own and stays valid across transactions; only a new fetch must run in
    // the transaction of the page that asks for it.
    return new StoredProductFiles(reader, this.repository, this.folder, rows, this.held);
  }

  /** Fetches the text of the named paths, once each; a path the tree does not hold is held as none. */
  async ensure(paths: readonly string[]): Promise<void> {
    const fetch: string[] = [];
    for (const path of paths) {
      if (this.held.has(path)) continue;
      const file = this.index.get(path);
      if (file === undefined || file.form === 'binary') {
        this.held.set(path, null);
        continue;
      }
      fetch.push(path);
    }
    if (fetch.length === 0) return;
    // The paths as a text[] parameter, the way the storage layer binds every array.
    const contents = await contentsOf(this.reader, this.repository, fetch);
    for (const path of fetch) this.held.set(path, contents.get(path) ?? null);
  }

  /** Fetches the text of every file below a folder; an absent folder fetches nothing. */
  async ensureBelow(folder: string): Promise<void> {
    await this.ensure(this.filesBelow(folder));
  }

  /**
   * Fetches what reading the manifest reads: `madarch/kinds.yaml`, `madarch/workflows.yaml`, the plugin lock and every
   * plugin contract the tree holds. A plugin's folder is the manifest's own declaration, so the contract files are found
   * by their name in the index and never by a guess at the folder.
   */
  async ensureManifest(): Promise<void> {
    await this.ensure([
      KINDS_FILE,
      WORKFLOWS_FILE,
      PLUGINS_LOCK_FILE,
      ...this.paths().filter((path) => path.endsWith('/contract.json')),
    ]);
  }

  has(path: string): boolean {
    return this.index.has(path);
  }

  size(path: string): number | null {
    return this.index.get(path)?.bytes ?? null;
  }

  text(path: string): string | undefined {
    if (!this.held.has(path)) {
      throw new Error(`${this.folder}/${path}: the file was not read from the graph by this read of the product repository: a reader asks the stored files through the reader itself (src/plugin/product-source.ts)`);
    }
    return this.held.get(path) ?? undefined;
  }

  filesIn(folder: string): string[] {
    const prefix = folder.replace(/\/+$/, '') + '/';
    return [...this.index.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).sort();
  }

  filesBelow(folder: string): string[] {
    const prefix = folder.replace(/\/+$/, '') + '/';
    return [...this.index.keys()].filter((path) => path.startsWith(prefix)).sort();
  }

  paths(): string[] {
    return [...this.index.keys()].sort();
  }
}
