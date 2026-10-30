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
import { extractFileSyntax } from '../fill/stages/syntax-extract.js';
import { resolveSpecifier } from '../fill/stages/syntax-facts.js';
import { codeLanguageOf } from '../extract/code/source.js';
import { treeExtractors } from '../extract/driver/extractors.js';
import type { GraphEntity, GraphReader, NeighborEdge, NeighborGroup } from '../knowledge/graph-read.js';
import type { GraphView } from '../writer/view.js';
import { byCodePoint } from '../model/order.js';
import { readWorkingFile, workingTree, type Revision } from './git.js';

/** The column of a key that names the path it was read from, for the kinds whose keys carry one. */
const PATH_PREFIXES = ['code.file:', 'code.symbol:', 'code.field:', 'code.document-section:'] as const;

/**
 * How many files the import closure of the changed files may add to a refresh. An edit is read with what it
 * imports, because a call through an unchanged file cannot be resolved without that file's declarations; the bound
 * keeps one edit in a heavily imported file from reading the tree (madarch-ztyq.10 review).
 */
const CLOSURE_LIMIT = 400;

/**
 * How many files a changed producer's own dependencies may add to a refresh. A migration that alters a table says
 * nothing about the table: `ALTER TABLE items ADD COLUMN note text` resolves only when the migrations that created
 * `items` are read with it, and the data-model producer must see the same set it would see in a fill
 * (madarch-ztyq.10 recheck).
 */
const PRODUCER_LIMIT = 400;

/** A migration the data-model producer reads: a `.sql` inside a `migrations` folder (prisma's included). */
function isMigration(path: string): boolean {
  const segments = path.split('/');
  const file = segments[segments.length - 1] ?? '';
  if (!file.endsWith('.sql')) return false;
  return segments.slice(0, -1).some((segment) => segment === 'migrations');
}

/** The contract folder a document belongs to — `openapi`, `asyncapi` or `proto` — or undefined. */
function contractFolderOf(path: string): string | undefined {
  const segments = path.split('/');
  if (segments[0] !== 'contracts') return undefined;
  const folder = segments[1];
  return folder === 'openapi' || folder === 'asyncapi' || folder === 'proto' ? folder : undefined;
}

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
  /**
   * The files whose facts the layer re-derived beside a changed file: a changed migration's siblings, a changed
   * spec's folder. Their HEAD facts are hidden too, because what they said was derived from a file the working tree
   * changed (madarch-ztyq.10 recheck).
   */
  private derived = new Set<string>();
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
    return path !== undefined && (this.touched.has(path) || this.derived.has(path));
  }

  /**
   * Whether a key's own path stands among the changed files. The key's shape is the only thing a key says about
   * itself, so this is the marking fallback below and never the invalidation rule: a fact is hidden when the
   * provenance the base graph records for it — the span it was read at — is a changed path, whatever its key looks
   * like (madarch-ztyq.10 review). The kinds this covers err by marking more, never by marking less.
   */
  hidesKey(key: string): boolean {
    return this.hides(pathOfKey(key) ?? undefined);
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
   *
   * What one refresh reads (madarch-ztyq.10 review):
   *
   * - every changed file git names, so a fact about it is the working tree's;
   * - the **import closure** of the changed code files, because a call through a
   *   name the caller imports cannot be resolved without the callee's
   *   declarations — an edited caller used to lose its unchanged callee;
   * - the manifests that name a file's module, so a symbol's key stays the key
   *   the base graph gives it;
   * - the **dependencies of a changed non-code file**: the migrations of the
   *   schema, because an `ALTER TABLE` resolves against the migration that
   *   created the table, and the specs of the contract folder, because a
   *   document may reference another (madarch-ztyq.10 recheck);
   * - and every tree extractor the fill runs, not the code pass alone, so a
   *   migration or an OpenAPI document that changed says so (the SQL data model
   *   and the contracts are producers like the code pass is).
   *
   * Rows whose span stands in a changed file **or in one of its dependencies**
   * are kept, and the base's facts about those same files are hidden: a table's
   * column list is derived from the migration that changed, and the derivation
   * has to be the working tree's, not half of each. The import closure is read
   * to resolve, never to answer — its own base facts stand.
   */
  async refresh(revision: Revision): Promise<LayerRefresh> {
    const digests = new Map<string, string>();
    const present: string[] = [];
    for (const path of revision.touched) {
      if (!existsSync(resolve(this.repository, path))) continue;
      const bytes = this.readPresent(path);
      digests.set(path, Bun.hash(bytes).toString(16));
      present.push(path);
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
    const tree = workingTree(this.repository);
    const known = new Set(tree.paths);
    const manifests = tree.paths.filter(isManifest);
    const dirty = new Set(present);
    const seeds = present.filter((path) => codeLanguageOf(path) !== undefined);
    const closure = await this.closureOf(seeds, known);
    const dependencies = this.dependenciesOf(present, known);
    // The files whose facts the working tree owns: the changed files and the files their producers derived from.
    const scope = new Set([...present, ...dependencies]);
    const read = [...new Set([...present, ...manifests, ...closure, ...dependencies])].sort(byCodePoint);
    const reader: TreeReader = {
      paths: read,
      read: (path: string): Uint8Array => {
        const bytes = readWorkingFile(this.repository, path);
        if (bytes === null) throw new Error(`${resolve(this.repository, path)}:1: the working tree holds no such file (src/mcp/layer.ts)`);
        return bytes;
      },
    };
    const nodes = new Map<string, ExtractedNode>();
    const edgeMap = new Map<string, ExtractedEdge>();
    const gaps: ExtractionGap[] = [];
    for (const extractor of treeExtractors({ facts: false })) {
      const answered = await extractor(reader);
      const extraction = 'extraction' in answered ? answered.extraction : answered;
      for (const node of extraction.nodes) {
        if (node.span === undefined || !scope.has(node.span.path)) continue;
        nodes.set(node.key, node);
      }
      for (const edge of extraction.edges) {
        if (edge.span === undefined || !scope.has(edge.span.path)) continue;
        edgeMap.set(`${edge.type}\u0000${edge.from}\u0000${edge.to}\u0000${edge.discriminator}`, edge);
      }
      gaps.push(...extraction.gaps);
    }
    this.nodes = nodes;
    this.edges = [...edgeMap.values()];
    this.edgeSites = this.edges.flatMap((edge) => (edge.span === undefined ? [] : [edge.span.path]));
    this.gaps = gaps;
    this.touched = new Set(revision.touched);
    this.derived = new Set(dependencies.filter((path) => !this.touched.has(path)));
    this.extracted = digests;
    this.markdown = undefined;
    return { reextracted: present.sort(byCodePoint), gaps: this.gaps };
  }

  /** One changed file's bytes, with the full path on the error a directory or a broken link raises. */
  private readPresent(path: string): Uint8Array {
    try {
      const bytes = readWorkingFile(this.repository, path);
      if (bytes === null) throw new Error('the file cannot be read');
      return bytes;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${resolve(this.repository, path)}:1: the changed file ${path} could not be read: ${reason} (src/mcp/layer.ts)`);
    }
  }

  /**
   * The changed code files and the files they import, transitively, up to
   * `CLOSURE_LIMIT`: the declarations a call in a changed file is resolved
   * against. A file that cannot be parsed is left out of the walk, not an
   * error — the extraction that follows reports its own gaps.
   */
  private async closureOf(seeds: readonly string[], known: ReadonlySet<string>): Promise<string[]> {
    const out = new Set<string>();
    const queue = [...seeds];
    while (queue.length > 0 && out.size < CLOSURE_LIMIT) {
      const path = queue.shift()!;
      if (out.has(path)) continue;
      out.add(path);
      const bytes = readWorkingFile(this.repository, path);
      if (bytes === null || codeLanguageOf(path) === undefined) continue;
      let imports: readonly { readonly specifier: string }[] = [];
      try {
        imports = (await extractFileSyntax(path, bytes)).imports;
      } catch {
        continue;
      }
      for (const one of imports) {
        const target = resolveSpecifier(path, one.specifier, known);
        if (target !== undefined && !out.has(target) && codeLanguageOf(target) !== undefined) queue.push(target);
      }
    }
    return [...out];
  }

  private clear(): void {
    this.nodes = new Map();
    this.edges = [];
    this.edgeSites = [];
    this.gaps = [];
    this.markdown = undefined;
    this.derived = new Set();
  }

  /**
   * The files a changed non-code file's producer needs beside it: every migration of the tree when a migration
   * changed — an `ALTER TABLE` names a table another migration created, and the producer applies migrations in
   * order — and every document of the changed spec's contract folder, because a document may reference another.
   * Bounded by `PRODUCER_LIMIT`; a tree with more of either is read up to the bound, and the producer reports what
   * it could not resolve as its own gap rather than the layer inventing a fact.
   */
  private dependenciesOf(present: readonly string[], known: ReadonlySet<string>): string[] {
    const migrations = present.some(isMigration);
    const folders = new Set(present.map((path) => contractFolderOf(path)).filter((one): one is string => one !== undefined));
    if (!migrations && folders.size === 0) return [];
    const out: string[] = [];
    for (const path of [...known].sort(byCodePoint)) {
      if (out.length >= PRODUCER_LIMIT) break;
      if (migrations && isMigration(path)) out.push(path);
      else {
        const folder = contractFolderOf(path);
        if (folder !== undefined && folders.has(folder)) out.push(path);
      }
    }
    return out;
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

  /**
   * The entity of a key: the working tree's when it declares one, the base graph's otherwise — unless the base
   * graph's own provenance for that entity (the span it was read at) is a changed file, in which case the file on
   * disk is the truth and a base entity the working tree no longer declares is gone. The rule is the provenance,
   * not the shape of the key: SQL tables, contract operations and sections live in files whose keys do not name a
   * path (madarch-ztyq.10 review).
   */
  async entity(key: string): Promise<GraphEntity | undefined> {
    const held = this.layer.entity(key);
    if (held !== undefined) return held;
    const base = await this.rawBaseEntity(key);
    if (base !== undefined && this.layer.hides(base.span?.path)) return undefined;
    return base;
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
    const visible = base.filter((row) => !this.layer.hides(row.span?.path));
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
    // Both ends are read through the layer (madarch-ztyq.10 review): an edge whose site is a changed file is the
    // working tree's, and an edge whose *other* end stands in a changed file the working tree no longer declares is
    // no edge — a deleted callee is not the caller's callee.
    const rows: NeighborEdge[] = [];
    for (const row of page.rows) {
      if (this.layer.hides(row.span?.path)) continue;
      if (await this.entity(row.other.key) === undefined) continue;
      rows.push(row);
    }
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
