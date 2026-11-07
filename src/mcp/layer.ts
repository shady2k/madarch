/**
 * The reads the seven tools answer from (madarch-ztyq.10; madarch-8bdc.2.5, item 3):
 * the store the one fill published, read one page at a time.
 *
 * Nothing here reads a working tree, re-extracts a file or names a stage. The facts
 * are the fill's, taken at the commit the store's records name as-is, and every
 * answer's source names that commit and the paths the checkout has changed since:
 * a reader knows which files the facts predate. Editors of a file the commit did not
 * publish are told by the source, never served by a second extraction.
 */
import { byCodePoint } from '../model/order.js';
import type { GraphEntity, GraphReader, NeighborEdge, NeighborGroup } from '../knowledge/graph-read.js';
import type { GraphView } from '../writer/view.js';
import { readCommitFile } from './git.js';

/** The column of a key that names the path it was read from, for the kinds whose keys carry one. */
const PATH_PREFIXES = ['code.file:', 'code.symbol:', 'code.field:', 'code.document-section:'] as const;

/**
 * The repository path a key names, or null for a key that names no file (a
 * module, a package, a cycle, a relation). The key's own shape is the rule: the
 * path of a keyed record stands between the kind and the `#`.
 */
export function pathOfKey(key: string): string | null {
  for (const prefix of PATH_PREFIXES) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const hash = rest.indexOf('#');
    return hash < 0 ? rest : rest.slice(0, hash);
  }
  return null;
}

/** A bound no answer of the seven tools reaches: every row of a kind's page, read whole to count it. */
const READ_ALL = 100_000;

/**
 * The store's reads as one repository's answers (madarch-ztyq.10): every read is the
 * graph view's, at the commit the store was filled from, and a page the bound cut is
 * said to be cut with the total it was cut from.
 */
export class RepositoryReads {
  private readerHeld: GraphReader | undefined;

  constructor(private readonly view: GraphView, private readonly repository: string, private readonly commit: string) {}

  /** The instant the store's view reads at. */
  get at(): string {
    return this.view.at;
  }

  /** The commit the store is the graph of. */
  get filledAt(): string {
    return this.commit;
  }

  private get reader(): GraphReader {
    if (this.readerHeld === undefined) this.readerHeld = this.view.reader();
    return this.readerHeld;
  }

  /** The entity of a key, or undefined when the store holds none. */
  async entity(key: string): Promise<GraphEntity | undefined> {
    const [found] = await this.reader.find(key);
    return found;
  }

  async list(kind: string, options: { q?: string; limit: number }): Promise<{ rows: GraphEntity[]; total: number }> {
    const base = await this.reader.list(kind, { ...options, limit: READ_ALL });
    return this.page(base.rows, base.total, options);
  }

  async byPrefix(kind: string, prefix: string, limit: number): Promise<{ rows: GraphEntity[]; total: number }> {
    const base = await this.reader.byPrefix(kind, prefix, READ_ALL);
    return this.page(base.rows, base.total, { prefix, limit });
  }

  /**
   * One page of a kind: the rows the query and the prefix leave, in code point order.
   * The base page is read whole (`READ_ALL`), so the total is the exact count of the
   * filtered kind, and a page the bound cut says so by the rows it holds.
   */
  private page(base: readonly GraphEntity[], baseTotal: number, options: { q?: string; prefix?: string; limit: number }): { rows: GraphEntity[]; total: number } {
    const prefix = options.prefix ?? null;
    const text = options.q === undefined || options.q.trim() === '' ? null : options.q.trim().toLowerCase();
    const rows = [...base]
      .filter((row) => (prefix === null || row.key.startsWith(prefix)) && (text === null || row.key.toLowerCase().includes(text) || row.label.toLowerCase().includes(text)))
      .sort((left, right) => byCodePoint(left.key, right.key));
    return { rows: rows.slice(0, options.limit), total: Math.max(rows.length, baseTotal) };
  }

  async edges(entity: GraphEntity, relation: string, direction: 'out' | 'in', limit: number): Promise<{ total: number; rows: NeighborEdge[] }> {
    const page = await this.reader.edgesOf(entity, relation, direction, READ_ALL);
    return { total: page.total, rows: page.rows.slice(0, limit) };
  }

  async neighbors(entity: GraphEntity, options: { direction: 'out' | 'in' | 'both'; limit: number }): Promise<NeighborGroup[]> {
    return await this.reader.neighbors(entity, options);
  }

  async documentPaths(): Promise<string[]> {
    return await this.view.documentPaths();
  }

  /**
   * One file's text at the commit the store was filled from. The store keeps the
   * facts, not the bytes, so the commit's bytes are read from the checkout; a file the
   * commit does not hold is no text of it, and the answer says so with null.
   */
  async fileText(path: string): Promise<string | null> {
    const bytes = readCommitFile(this.repository, this.commit, path);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  }

}
