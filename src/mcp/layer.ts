/**
 * The working-tree layer of a served graph (madarch-ztyq.10): the facts the
 * extraction reads from the files git says the working tree changed since HEAD,
 * held beside the base graph and preferred to it.
 *
 * Why a layer and not a refill: the base graph is the graph of a commit, and a
 * commit is the only thing the driver writes (decision 0030). An engineer's
 * checkout, though, is edited between commits, and an answer that described the
 * commit while the file on disk says otherwise would be stale. So the same
 * extractor that built the graph reads the changed files of the working tree,
 * and the reads of the answers go through this layer first: a fact about a
 * changed file is the working tree's, and every fact the base graph holds about
 * that file is hidden.
 *
 * The layer is exact about the files it reads and honest about its edge: a
 * symbol declared in a changed file is the working tree's, and so is every edge
 * whose site stands in one of those files. An edge whose *other* end is declared
 * in an unchanged file is re-derived only when the same extraction run could
 * resolve it, and the whole tree is not re-read for one edit — that is the
 * trade a per-file re-extraction makes, and `revision.reextracted` names what
 * was read.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExtractedEdge, ExtractedNode, ExtractionGap, TreeReader } from '../extract/records.js';
import { extractCodeWithFacts } from '../extract/code/index.js';
import type { GraphEntity, GraphReader, NeighborEdge, NeighborGroup } from '../knowledge/graph-read.js';
import type { GraphView } from '../writer/view.js';
import { byCodePoint } from '../model/order.js';
import { readWorkingFile, workingTree, type Revision } from './git.js';

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

const isManifest = (path: string): boolean => path === 'package.json' || path === 'go.mod' || path === 'tsconfig.json';

const isMarkdown = (path: string): boolean => {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
};

/** What one refresh read: the files it re-extracted, and the gaps the extractor reported. */
export interface LayerRefresh {
  readonly reextracted: readonly string[];
  readonly gaps: readonly ExtractionGap[];
}

/** The facts of one working tree, as the answers read them beside the base graph. */
export class WorkingLayer {
  /** The files whose HEAD facts the layer hides: everything git says the working tree changed. */
  private touched = new Set<string>();
  private nodes = new Map<string, ExtractedNode>();
  private edges: ExtractedEdge[] = [];
  private edgeSites: string[] = [];
  private extracted = new Map<string, string>();
  private gaps: readonly ExtractionGap[] = [];
  private markdown: string[] | undefined;

  constructor(readonly repository: string) {}

  /** The paths whose facts come from the working tree. */
  get dirtyPaths(): readonly string[] {
    return [...this.touched].sort(byCodePoint);
  }

  /** Whether the base graph's facts about a path are hidden by this layer. */
  hides(path: string | undefined): boolean {
    return path !== undefined && this.touched.has(path);
  }

  /** Whether a key's own path stands among the changed files, so the base graph's node of it is not the truth. */
  hidesKey(key: string): boolean {
    const path = pathOfKey(key);
    return path !== null && this.touched.has(path);
  }

  /** The entity the working tree declares under a key, when it declares one. */
  entity(key: string): GraphEntity | undefined {
    const node = this.nodes.get(key);
    if (node === undefined) return undefined;
    return {
      key: node.key,
      kind: node.kind,
      label: node.label,
      properties: { ...node.properties, recordKey: node.key, uncommitted: true },
      nodeIds: [],
      scope: '',
      ...(node.span === undefined ? {} : { span: node.span }),
    };
  }

  /** Every node the layer holds, in key order. */
  get held(): readonly ExtractedNode[] {
    return [...this.nodes.values()].sort((left, right) => byCodePoint(left.key, right.key));
  }

  /** The working tree's version of a document list: the base list with the changed files put right. */
  async documentPaths(base: readonly string[]): Promise<string[]> {
    if (this.touched.size === 0) return [...base];
    if (this.markdown === undefined) this.markdown = workingTree(this.repository).paths.filter(isMarkdown);
    const merged = new Set<string>([...base.filter((path) => !this.touched.has(path)), ...this.markdown]);
    return [...merged].sort(byCodePoint);
  }

  /**
   * Re-extracts the changed files when their content is not the content the
   * layer was built from, and answers what it read. An empty answer means the
   * layer already describes this working tree.
   */
  async refresh(revision: Revision): Promise<LayerRefresh> {
    const present = revision.touched.filter((path) => existsSync(resolve(this.repository, path)) && readWorkingFile(this.repository, path) !== null);
    const digests = new Map<string, string>();
    for (const path of present) {
      const bytes = readWorkingFile(this.repository, path);
      if (bytes !== null) digests.set(path, Bun.hash(bytes).toString(16));
    }
    const sameTouched = this.touched.size === revision.touched.length && revision.touched.every((path) => this.touched.has(path));
    const sameContent = this.extracted.size === digests.size && [...digests].every(([path, digest]) => this.extracted.get(path) === digest);
    if (sameTouched && sameContent) return { reextracted: [], gaps: [] };
    if (revision.touched.length === 0) {
      this.clear();
      this.touched = new Set();
      this.extracted = new Map();
      return { reextracted: [], gaps: [] };
    }
    // The extraction reads the changed files and the manifests that name a file's module, so a symbol's key is the
    // same key the base graph gives it; nothing else of the tree is read.
    const tree = workingTree(this.repository);
    const manifests = tree.paths.filter(isManifest);
    const read = [...new Set([...present, ...manifests])].sort(byCodePoint);
    const reader: TreeReader = {
      paths: read,
      read: (path: string): Uint8Array => {
        const bytes = readWorkingFile(this.repository, path);
        if (bytes === null) throw new Error(`${resolve(this.repository, path)}:1: the working tree holds no such file (src/mcp/layer.ts)`);
        return bytes;
      },
    };
    const result = await extractCodeWithFacts(reader);
    const changed = new Set(present);
    const nodes = new Map<string, ExtractedNode>();
    for (const node of result.extraction.nodes) {
      // A node is the working tree's when the file that declares it changed; the manifests' own module and package
      // nodes are read again but say the same thing, so they are kept as they are.
      if (node.span !== undefined && !changed.has(node.span.path)) continue;
      nodes.set(node.key, node);
    }
    const edges = result.extraction.edges.filter((edge) => edge.span !== undefined && changed.has(edge.span.path));
    this.nodes = nodes;
    this.edges = edges;
    this.edgeSites = edges.flatMap((edge) => (edge.span === undefined ? [] : [edge.span.path]));
    this.gaps = result.extraction.gaps;
    this.touched = new Set(revision.touched);
    this.extracted = digests;
    this.markdown = undefined;
    return { reextracted: present.sort(byCodePoint), gaps: this.gaps };
  }

  private clear(): void {
    this.nodes = new Map();
    this.edges = [];
    this.edgeSites = [];
    this.gaps = [];
    this.markdown = undefined;
  }

  /** The layer's edges of one relation at a key, in one direction. */
  edgesAt(key: string, relation: string, direction: 'out' | 'in'): { other: string; count: number; edge: ExtractedEdge }[] {
    const found: { other: string; count: number; edge: ExtractedEdge }[] = [];
    for (const edge of this.edges) {
      if (edge.type !== relation) continue;
      const from = direction === 'out' ? edge.from : edge.to;
      const to = direction === 'out' ? edge.to : edge.from;
      if (from !== key) continue;
      const count = typeof edge.properties['count'] === 'number' ? edge.properties['count'] : 1;
      const held = found.find((one) => one.other === to);
      if (held === undefined) found.push({ other: to, count, edge });
      else held.count += count;
    }
    return found.sort((left, right) => byCodePoint(left.other, right.other));
  }

  /** Every relation the layer holds at a key, in one direction, in code point order. */
  relationsAt(key: string, direction: 'out' | 'in'): string[] {
    const relations = new Set<string>();
    for (const edge of this.edges) {
      if ((direction === 'out' ? edge.from : edge.to) !== key) continue;
      relations.add(edge.type);
    }
    return [...relations].sort(byCodePoint);
  }

  /** The site line and byte position an edge was read at, when its span names one. */
  static site(span: ExtractedEdge['span']): NeighborEdge['position'] {
    return span === undefined ? null : { start: span.byteStart, end: span.byteEnd };
  }
}

/**
 * The reads one MCP answer makes: the base graph at the filled commit, with the
 * working-tree layer preferred for every file the working tree changed. Every
 * method answers the same shape the writer's `SnapshotReads` answers, so the
 * answers of `src/writer/answers.ts` are called, never copied.
 */
export class RepositoryReads {
  private readerHeld: GraphReader | undefined;

  constructor(private readonly view: GraphView, private readonly layer: WorkingLayer) {}

  get at(): string {
    return this.view.at;
  }

  private get reader(): GraphReader {
    if (this.readerHeld === undefined) this.readerHeld = this.view.reader();
    return this.readerHeld;
  }

  /** The base graph's entity of a key, even when the working tree changed the file it stands in. */
  private async rawBaseEntity(key: string): Promise<GraphEntity | undefined> {
    const [found] = await this.reader.find(key);
    return found;
  }

  async entity(key: string): Promise<GraphEntity | undefined> {
    const held = this.layer.entity(key);
    if (held !== undefined) return held;
    // A key whose file the working tree changed and which the working tree no longer declares is a key the graph
    // must not answer for: the file on disk is the truth.
    if (this.layer.hidesKey(key)) return undefined;
    return await this.rawBaseEntity(key);
  }

  async list(kind: string, options: { q?: string; limit: number }): Promise<{ rows: GraphEntity[]; total: number }> {
    const base = await this.reader.list(kind, { ...options, limit: READ_ALL });
    return this.page(base.rows, base.total, kind, options);
  }

  async byPrefix(kind: string, prefix: string, limit: number): Promise<{ rows: GraphEntity[]; total: number }> {
    const base = await this.reader.byPrefix(kind, prefix, READ_ALL);
    return this.page(base.rows, base.total, kind, { prefix, limit });
  }

  /**
   * One page of a kind, merged from the base's rows and the layer's and filtered
   * by the same rule. The base page is read whole (`READ_ALL`), so a row the
   * working tree hides is dropped from the count as well as from the page; a
   * page the bound cut is said to be cut, and its total is the base's minus the
   * hidden rows the page held.
   */
  private page(base: readonly GraphEntity[], baseTotal: number, kind: string, options: { q?: string; prefix?: string; limit: number }): { rows: GraphEntity[]; total: number } {
    const visible = base.filter((row) => !this.layer.hidesKey(row.key));
    const hidden = base.length - visible.length;
    const merged = new Map<string, GraphEntity>();
    for (const row of visible) merged.set(row.key, row);
    for (const node of this.layer.held) {
      if (node.kind !== kind) continue;
      const entity = this.layer.entity(node.key);
      if (entity !== undefined) merged.set(entity.key, entity);
    }
    const prefix = options.prefix ?? null;
    const text = options.q === undefined || options.q.trim() === '' ? null : options.q.trim().toLowerCase();
    const rows = [...merged.values()]
      .filter((row) => (prefix === null || row.key.startsWith(prefix)) && (text === null || row.key.toLowerCase().includes(text) || row.label.toLowerCase().includes(text)))
      .sort((left, right) => byCodePoint(left.key, right.key));
    // The merged rows are the page read whole, so their count is the exact total of the filtered kind; the base's own
    // total covers the rows the read bound cut, with the hidden ones taken out.
    return { rows: rows.slice(0, options.limit), total: Math.max(rows.length, baseTotal - hidden) };
  }

  async edges(entity: GraphEntity, relation: string, direction: 'out' | 'in', limit: number): Promise<{ total: number; rows: NeighborEdge[] }> {
    const base = await this.baseEdges(entity.key, relation, direction);
    const overlay = this.layer.edgesAt(entity.key, relation, direction);
    const rows: NeighborEdge[] = [];
    const seen = new Set<string>();
    for (const one of overlay) {
      const other = await this.entity(one.other);
      if (other === undefined) continue;
      const site = one.edge.span;
      rows.push({ relation, direction, other, properties: { ...one.edge.properties }, position: WorkingLayer.site(site), ...(site === undefined ? {} : { span: site }) });
      seen.add(other.key);
    }
    for (const row of base.rows) {
      if (seen.has(row.other.key)) continue;
      rows.push(row);
      seen.add(row.other.key);
    }
    rows.sort((left, right) => byCodePoint(left.other.key, right.other.key));
    return { total: seen.size, rows: rows.slice(0, limit) };
  }

  /**
   * The base graph's edges at a key, without the rows whose site is a file the
   * working tree changed. `total` is the count of distinct entities at the other
   * end, so the row count and the total stay one another's.
   */
  private async baseEdges(key: string, relation: string, direction: 'out' | 'in'): Promise<{ total: number; rows: NeighborEdge[] }> {
    const base = await this.rawBaseEntity(key);
    if (base === undefined) return { total: 0, rows: [] };
    const page = await this.reader.edgesOf(base, relation, direction, READ_ALL);
    if (this.layer.dirtyPaths.length === 0) return page;
    const rows = page.rows.filter((row) => !this.layer.hides(row.span?.path));
    return { total: rows.length, rows };
  }

  async neighbors(entity: GraphEntity, options: { direction: 'out' | 'in' | 'both'; limit: number }): Promise<NeighborGroup[]> {
    const base = await this.rawBaseEntity(entity.key);
    const groups = base === undefined ? [] : await this.reader.neighbors(base, options);
    if (this.layer.dirtyPaths.length === 0 && this.layer.entity(entity.key) === undefined) return groups;
    const directions: ('out' | 'in')[] = options.direction === 'out' ? ['out'] : options.direction === 'in' ? ['in'] : ['out', 'in'];
    const merged = new Map<string, NeighborGroup>();
    const put = (relation: string, direction: 'out' | 'in', total: number, edges: number, rows: NeighborGroup['rows']): void => {
      merged.set(`${direction}\u0000${relation}`, { relation, direction, total, edges, rows: rows.slice(0, options.limit) });
    };
    // Every relation the base graph groups at this key is recounted from the edges the working tree leaves.
    for (const group of groups) {
      const left = await this.baseEdges(entity.key, group.relation, group.direction);
      const sites = left.rows.reduce((sum, row) => sum + (typeof row.properties['sites'] === 'number' ? row.properties['sites'] : 1), 0);
      if (left.total === 0 && sites === 0) continue;
      put(group.relation, group.direction, left.total, sites, left.rows.map((row) => ({ entity: row.other, edges: 1 })));
    }
    // Every relation the working tree adds at this key is added to the graph's.
    for (const direction of directions) {
      for (const relation of this.layer.relationsAt(entity.key, direction)) {
        const held = merged.get(`${direction}\u0000${relation}`);
        const union = new Map<string, GraphEntity>();
        for (const row of held?.rows ?? []) union.set(row.entity.key, row.entity);
        const overlay = this.layer.edgesAt(entity.key, relation, direction);
        for (const one of overlay) {
          const other = await this.entity(one.other);
          if (other !== undefined) union.set(other.key, other);
        }
        if (union.size === 0 && held === undefined) continue;
        const added = overlay.reduce((sum, one) => sum + one.count, 0);
        put(relation, direction, union.size, (held?.edges ?? 0) + added, [...union.values()].sort((left, right) => byCodePoint(left.key, right.key)).map((one) => ({ entity: one, edges: 1 })));
      }
    }
    return [...merged.values()].sort((left, right) => byCodePoint(left.relation, right.relation) || byCodePoint(left.direction, right.direction));
  }

  async documentPaths(): Promise<string[]> {
    return await this.layer.documentPaths(await this.view.documentPaths());
  }

  async fileText(path: string): Promise<string | null> {
    if (this.layer.hides(path)) {
      const bytes = readWorkingFile(this.layer.repository, path);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    }
    return await this.view.fileText(path);
  }
}

/** A bound no answer of the seven tools reaches: every row of a kind's page, read whole to count it. */
const READ_ALL = 100_000;
