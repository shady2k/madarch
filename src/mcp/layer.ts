/**
 * The working-tree layer of a served graph (madarch-ztyq.10): the facts the
 * fill's static stages read from the files git says the working tree changed
 * since HEAD, held beside the base graph and preferred to it.
 *
 * Why a layer and not a refill: the base graph is the graph of a commit, and a
 * commit is the only thing a fill publishes. An engineer's checkout, though, is
 * edited between commits, and an answer that described the commit while the file
 * on disk says otherwise would be stale. So the same per-file stages that built
 * the graph read the changed files again — one file's bytes, and bounded reads of
 * the base graph for what the file means — and the reads of the answers go
 * through this layer first: a fact about a changed file is the working tree's,
 * and every fact the base graph holds about that file is hidden.
 *
 * **What a refresh reads** (decision 0033, "The file is the unit of static
 * work"):
 *
 * - every changed file git names, so a fact about it is the working tree's;
 * - the import closure of the changed code files, because a call through a name
 *   the caller imports cannot be resolved without the callee's declarations — an
 *   edited caller used to lose its unchanged callee;
 * - the manifests that name a file's module, so a symbol's key stays the key the
 *   base graph gives it;
 * - the dependencies of a changed non-code file: the migrations of the schema,
 *   because an `ALTER TABLE` resolves against the migration that created the
 *   table, and the documents of the changed spec's contract folder;
 * - and the same per-file stages the base fill runs, so a migration or a
 *   document that changed says so.
 *
 * Rows whose place stands in a changed file **or in one of its dependencies**
 * are kept, and the base's facts about those same files are hidden: a table's
 * column list is derived from the migration that changed, and the derivation
 * has to be the working tree's, not half of each. The import closure is read to
 * resolve, never to answer — its own base facts stand.
 *
 * **The two vocabularies** (decision 0033, item 7): a stage's records are
 * identified by the digest of their facts, and the answers name a file by its
 * path and a symbol by its global name, which is what `presentedKey` states. The
 * layer holds its rows under the presented keys, so an answer never tells which
 * producer wrote the base graph.
 */
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { codeLanguageOf } from '../extract/code/source.js';
import { readFileSync } from 'node:fs';
import { resolveStageConfiguration } from '../fill/registry.js';
import type { FillStage, StageContext, StageDraftSet, StageDraftWrite, StageUnit } from '../fill/stage.js';
import { createBuildConfigurationStage, manifestKindOf, manifestUnitId } from '../fill/stages/build-configuration.js';
import { createCodeFactsStage } from '../fill/stages/code-facts.js';
import { createDataModelStage } from '../fill/stages/data-model.js';
import { createDocumentIndexStage, documentUnitId, markdownMediaType } from '../fill/stages/document-index.js';
import { createOperationsLinksStage } from '../fill/stages/operations-links.js';
import { createOperationsStage } from '../fill/stages/operations.js';
import { createSemanticResolutionStage } from '../fill/stages/semantic-resolution.js';
import { createStateMachinesStage } from '../fill/stages/state-machines.js';
import {
  staticGraphReaderOf, STATIC_FILE_BYTE_LIMIT,
  type StaticGraphEdge, type StaticGraphNode, type StaticGraphReader, type StaticStageContext, type StaticStageSource,
} from '../fill/stages/static-context.js';
import { createSyntaxStage, fileUnitId } from '../fill/stages/syntax.js';
import { extractFileSyntax } from '../fill/stages/syntax-extract.js';
import { fileFactIdOf, resolveSpecifier } from '../fill/stages/syntax-facts.js';
import type { StaticEdgeDraft, StaticNodeDraft } from '../fill/stages/static-graph.js';
import type { SnapshotSource } from '../fill/snapshot.js';
import type { GraphStore } from '../graph/index.js';
import {
  presentedKey, spanFromProvenance,
  type GraphEntity, type GraphReader, type NeighborEdge, type NeighborGroup, type SourceSpan,
} from '../knowledge/graph-read.js';
import { byCodePoint } from '../model/order.js';
import type { GraphView } from '../writer/view.js';
import { readCommitFile, readWorkingFile, workingTree, type Revision } from './git.js';

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

/** The most files the working tree's own folder listing answers, as a static source's bound. */
const FOLDER_FILE_LIMIT = 4096;

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

/** One gap one of the working tree's readings named: what it could not read, and why. */
export interface LayerGap {
  readonly what: string;
  readonly reason: string;
}

/** What one refresh read: the files it re-read, and the gaps the stages reported. */
export interface LayerRefresh {
  readonly reextracted: readonly string[];
  readonly gaps: readonly LayerGap[];
}

/** One record the working tree's stages wrote: a node under its own key, with the place it stands at. */
interface LayerNode {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly properties: Record<string, unknown>;
  readonly span?: SourceSpan;
}

/** One edge the working tree's stages wrote, both ends by the key of the node they name. */
interface LayerEdge {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly discriminator?: string;
  readonly properties: Record<string, unknown>;
  readonly span?: SourceSpan;
}

/** A refusing source for the stages whose `plan` this layer never calls: a unit's bytes come from the working tree. */
const NEVER_PLANNED: SnapshotSource = {
  pins: async (): Promise<never> => {
    throw new Error('madarch mcp: the working-tree layer runs a stage\'s units and never its plan (src/mcp/layer.ts)');
  },
  open: async (): Promise<never> => {
    throw new Error('madarch mcp: the working-tree layer reads one file\'s bytes from the working tree, never a repository reader (src/mcp/layer.ts)');
  },
};

/** One stage whose unit is one file, and the unit id it gives a path — undefined where the path is not one of its units. */
interface FileStage {
  readonly stage: FillStage;
  readonly unitOf: (repository: string, path: string) => string | undefined;
}

/** The stages a refresh runs, in the order they run: the file pass, then what reads it, and the resolution last. */
function fileStages(): readonly FileStage[] {
  const file = (repository: string, path: string): string => fileUnitId(repository, path);
  return [
    { stage: createBuildConfigurationStage(NEVER_PLANNED), unitOf: (repository, path) => (manifestKindOf(path) === undefined ? undefined : manifestUnitId(repository, path)) },
    { stage: createSyntaxStage(NEVER_PLANNED), unitOf: file },
    { stage: createCodeFactsStage(NEVER_PLANNED), unitOf: file },
    { stage: createStateMachinesStage(NEVER_PLANNED), unitOf: file },
    { stage: createOperationsStage(NEVER_PLANNED), unitOf: file },
    { stage: createOperationsLinksStage(NEVER_PLANNED), unitOf: file },
    { stage: createDataModelStage(NEVER_PLANNED), unitOf: file },
    { stage: createDocumentIndexStage(NEVER_PLANNED), unitOf: (repository, path) => (markdownMediaType(path) === undefined ? undefined : documentUnitId(repository, path)) },
  ];
}

/**
 * The working tree as a static stage's source (decision 0033, "Capability
 * boundaries"): one folder's files listed once, one path's entry, one file's
 * bytes below the cap, and the path-scoped folder answers a stage's group read
 * needs. The pin's commit is HEAD's, so the facts of a file the working tree did
 * not change are the commit's own.
 */
class WorktreeSource implements StaticStageSource {
  private listingHeld: { readonly paths: readonly string[]; readonly bytes: number } | undefined;
  private readonly blobs = new Map<string, string>();

  constructor(readonly repository: string, private readonly folder: string, readonly commit: string) {}

  get form(): 'code' { return 'code'; }
  get source(): { readonly system: string; readonly version: string } { return { system: 'working-tree', version: '1' }; }
  get tree(): string { return `worktree:${this.commit}`; }

  private get listing(): { readonly paths: readonly string[]; readonly bytes: number } {
    if (this.listingHeld === undefined) {
      const paths = workingTree(this.folder).paths;
      let bytes = 0;
      for (const path of paths) {
        try { bytes += statSync(resolve(this.folder, path)).size; } catch { /* a file that left between the listing and the stat adds nothing */ }
      }
      this.listingHeld = { paths, bytes };
    }
    return this.listingHeld;
  }

  get fileCount(): number { return this.listing.paths.length; }
  get byteCount(): number { return this.listing.bytes; }

  async entry(path: string): Promise<{ readonly path: string; readonly form: 'blob'; readonly id: string; readonly bytes: number } | undefined> {
    if (!this.listing.paths.includes(path)) return undefined;
    const bytes = this.read(path);
    if (bytes === null) return undefined;
    return { path, form: 'blob', id: this.blobOf(path, bytes), bytes: bytes.byteLength };
  }

  async file(path: string): Promise<{ readonly repository: string; readonly commit: string; readonly path: string; readonly form: 'blob'; readonly id: string; readonly bytes: number; readonly content?: Uint8Array; readonly unread?: 'too-large' } | undefined> {
    const entry = await this.entry(path);
    if (entry === undefined) return undefined;
    if (entry.bytes > STATIC_FILE_BYTE_LIMIT) return { repository: this.repository, commit: this.commit, ...entry, unread: 'too-large' };
    const bytes = this.read(path);
    if (bytes === null) return undefined;
    return { repository: this.repository, commit: this.commit, ...entry, content: bytes };
  }

  async holdsDirectory(path: string): Promise<boolean> {
    const prefix = `${path}/`;
    return this.listing.paths.some((one) => one.startsWith(prefix));
  }

  async filesUnder(path: string): Promise<readonly { readonly path: string; readonly form: 'blob'; readonly id: string; readonly bytes: number }[]> {
    const prefix = path === '' ? '' : `${path}/`;
    const held = this.listing.paths.filter((one) => one.startsWith(prefix));
    if (held.length > FOLDER_FILE_LIMIT) {
      throw new Error(`the working tree's layer asked for the files under ${JSON.stringify(path)}, and the checkout holds ${String(held.length)} of them where a folder-scoped listing answers at most ${String(FOLDER_FILE_LIMIT)}: a group a unit reads together is not the repository (decision 0033, item 5; src/mcp/layer.ts)`);
    }
    const out: { path: string; form: 'blob'; id: string; bytes: number }[] = [];
    for (const one of [...held].sort(byCodePoint)) {
      const entry = await this.entry(one);
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }

  /** A file's bytes in the working tree, with the full path on the error a directory or a broken link raises. */
  private read(path: string): Uint8Array | null {
    try {
      return readWorkingFile(this.folder, path);
    } catch (error) {
      throw new Error(`${resolve(this.folder, path)}:1: the working tree's ${path} could not be read: ${error instanceof Error ? error.message : String(error)} (src/mcp/layer.ts)`);
    }
  }

  private blobOf(path: string, bytes: Uint8Array): string {
    const held = this.blobs.get(path);
    if (held !== undefined) return held;
    const id = `worktree:${Bun.hash(bytes).toString(16)}`;
    this.blobs.set(path, id);
    return id;
  }
}

/** One node of the overlay, under the id the graph's readers name it by. */
function overlayNode(draft: StaticNodeDraft): StaticGraphNode {
  return { id: `overlay:${draft.key}`, kind: draft.kind, label: draft.label, properties: { ...draft.properties, recordKey: draft.key }, producer: 'madarch-mcp-working-tree', scope: '' };
}

/**
 * The base graph and the working tree's own facts as one graph reader (decision
 * 0033, item 5): every question a stage asks is answered from the working tree's
 * reading where it read the file, from the base graph otherwise, and never from
 * a whole tree. The ends of an edge are the keys the records name.
 */
class OverlayReader implements StaticGraphReader {
  constructor(private readonly base: StaticGraphReader, readonly nodes: Map<string, StaticGraphNode>, readonly edges: readonly LayerEdge[], readonly paths: ReadonlySet<string>) {}

  /** A key's node: the overlay's where it read the file — its map is keyed by the record key — the base's otherwise, and never a base record of a file the overlay read and no longer declares. */
  private async nodeByKey(key: string): Promise<StaticGraphNode | undefined> {
    const held = this.nodes.get(key);
    if (held !== undefined) return held;
    const found = await this.base.byKey(key, { limit: 2 });
    return found.find((one) => !this.paths.has(String(one.properties['file'] ?? one.properties['path'] ?? '')));
  }

  async byKey(key: string, options?: { readonly limit?: number }): Promise<readonly StaticGraphNode[]> {
    const node = await this.nodeByKey(key);
    return node === undefined ? [] : [node].slice(0, options?.limit ?? 1);
  }

  async byGlobalName(name: string, options?: { readonly limit?: number }): Promise<readonly StaticGraphNode[]> {
    const limit = options?.limit ?? 256;
    const out: StaticGraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.kind !== 'code.symbol' || String(node.properties['globalName'] ?? '') !== name) continue;
      out.push(node);
    }
    const seen = new Set(out.map((node) => String(node.properties['recordKey'] ?? node.id)));
    for (const node of await this.base.byGlobalName(name, { limit })) {
      if (this.paths.has(String(node.properties['file'] ?? ''))) continue;
      const key = String(node.properties['recordKey'] ?? node.id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(node);
    }
    return out.slice(0, limit);
  }

  async byProperty(kind: string, field: string, value: string, options?: { readonly limit?: number; readonly after?: string }): Promise<{ readonly rows: readonly StaticGraphNode[]; readonly next: string | null }> {
    const after = options?.after ?? '';
    // A page cursor is either a stored node's id (a decimal) or an overlay node's id (`overlay:<key>`); the
    // graph reader only knows the first, so an overlay cursor asks the base for its first page and filters here.
    const decimal = /^[0-9]+$/u.test(after);
    const page = await this.base.byProperty(kind, field, value, { limit: options?.limit ?? 256, ...(decimal ? { after } : {}) });
    const rows = [...this.nodes.values()]
      .filter((node) => node.kind === kind && String(node.properties[field] ?? '') === value && node.id > after)
      .sort((left, right) => byCodePoint(left.id, right.id));
    const unique = new Map<string, StaticGraphNode>();
    for (const node of rows) unique.set(String(node.properties['recordKey'] ?? node.id), node);
    for (const node of page.rows) {
      if (this.paths.has(String(node.properties['file'] ?? node.properties['path'] ?? ''))) continue;
      const key = String(node.properties['recordKey'] ?? node.id);
      if (!unique.has(key)) unique.set(key, node);
    }
    const merged = [...unique.values()].sort((left, right) => byCodePoint(left.id, right.id));
    const limit = options?.limit ?? 256;
    const shown = merged.slice(0, limit);
    return { rows: shown, next: merged.length > limit ? shown[shown.length - 1]?.id ?? null : page.next };
  }

  async edgesByProperty(relation: string, field: string, value: string, options?: { readonly limit?: number; readonly after?: string }): Promise<{ readonly rows: readonly StaticGraphEdge[]; readonly next: string | null }> {
    const after = options?.after ?? '';
    const decimal = /^[0-9]+$/u.test(after);
    const page = await this.base.edgesByProperty(relation, field, value, { limit: options?.limit ?? 256, ...(decimal ? { after } : {}) });
    const rows = this.edges
      .filter((edge) => edge.type === relation && String(edge.properties[field] ?? '') === value)
      .map((edge) => ({
        id: `overlay:${edge.type}:${edge.from}:${edge.to}:${edge.discriminator ?? ''}`,
        relation: edge.type,
        from: { id: `overlay:${edge.from}`, kind: '', label: '', properties: {}, producer: '', scope: '' },
        to: { id: `overlay:${edge.to}`, kind: '', label: '', properties: {}, producer: '', scope: '' },
        properties: edge.properties,
        producer: 'madarch-mcp-working-tree',
      }));
    return { rows: [...rows, ...page.rows].slice(0, options?.limit ?? 256), next: page.next };
  }

  async neighbourhood(nodeId: string, options: { readonly relations: readonly string[]; readonly direction: 'out' | 'in'; readonly limit?: number; readonly after?: string }): Promise<{ readonly rows: readonly StaticGraphNode[]; readonly next: string | null }> {
    if (!nodeId.startsWith('overlay:')) return await this.base.neighbourhood(nodeId, options);
    const key = nodeId.slice('overlay:'.length);
    const limit = options?.limit ?? 256;
    const after = options?.after ?? '';
    const found: string[] = [];
    for (const edge of this.edges) {
      if (!options.relations.includes(edge.type)) continue;
      if ((options.direction === 'out' ? edge.from : edge.to) !== key) continue;
      found.push(options.direction === 'out' ? edge.to : edge.from);
    }
    const keys = [...new Set(found)].sort(byCodePoint).filter((one) => one > after);
    const rows: StaticGraphNode[] = [];
    for (const one of keys.slice(0, limit)) {
      const node = await this.nodeByKey(one);
      if (node !== undefined) rows.push(node);
    }
    const more = keys.length > limit;
    return { rows, next: more ? keys[limit - 1] ?? null : null };
  }
}

/** One unit's draft, collected as the stage writes it. */
class Collector {
  readonly writes: StageDraftWrite[] = [];
  readonly writer = {
    write: (entry: StageDraftWrite): void => { this.writes.push(entry); },
    writes: (): StageDraftSet => ({ writes: this.writes }),
  };
}

/** The tracked graph reads a stage's `execute` may make: none, refused by name, since a static unit reads through its own context. */
const NO_TRACKED_READS = {
  query: async (): Promise<never> => {
    throw new Error('madarch mcp: a working-tree stage unit asked for a tracked read, and its bounded static context is the only graph it reads (src/mcp/layer.ts)');
  },
};

/** The overlay one refresh collects: nodes by the key an edge names them by, and the edges with both ends as keys. */
interface Overlay {
  readonly nodes: Map<string, StaticGraphNode>;
  readonly edges: LayerEdge[];
  readonly paths: Set<string>;
}

/** What one stage's unit wrote, added to the overlay; a coverage's gaps are kept with it. */
function harvest(writes: readonly StageDraftWrite[], repository: string, path: string, overlay: Overlay, gaps: LayerGap[]): void {
  for (const write of writes) {
    if (write.kind !== 'node' && write.kind !== 'edge') {
      throw new Error(`madarch mcp: the working tree's reading of ${path} of ${repository} wrote a ${write.kind}, and a static stage writes graph nodes and edges (src/mcp/layer.ts)`);
    }
    if (write.kind === 'node') {
      const node = write.value as StaticNodeDraft;
      overlay.nodes.set(node.key, overlayNode(node));
      if (node.kind === 'code.coverage') {
        const unread = node.properties['unread'];
        if (Array.isArray(unread)) for (const gap of unread) {
          const held = gap as { what?: unknown; reason?: unknown };
          if (typeof held.what === 'string' && typeof held.reason === 'string') gaps.push({ what: held.what, reason: held.reason });
        }
      }
      continue;
    }
    const edge = write.value as StaticEdgeDraft;
    const end = (value: StaticEdgeDraft['from']): string => {
      if ('id' in value) {
        throw new Error(`madarch mcp: an edge of ${path} of ${repository} names its end by graph id ${String(value.id)}, and the working tree's layer joins ends by record key: a static stage writes ends as keys (src/mcp/layer.ts)`);
      }
      return value.key;
    };
    overlay.edges.push({
      type: edge.relation,
      from: end(edge.from),
      to: end(edge.to),
      ...(edge.discriminator === undefined ? {} : { discriminator: edge.discriminator }),
      properties: { ...(edge.properties ?? {}), ...(edge.position === undefined ? {} : { position: edge.position }) },
    });
  }
}

/**
 * The facts of one working tree, as the answers read them beside the base graph
 * (madarch-ztyq.10): the rows the per-file stages read from the changed files and
 * their dependencies, under the keys the answers name.
 */
export class WorkingLayer {
  /** The files whose HEAD facts the layer hides: everything git says the working tree changed. */
  private touched = new Set<string>();
  /**
   * The files whose facts the layer re-derived beside a changed file: a changed migration's siblings, a changed
   * spec's folder. Their HEAD facts are hidden too, because what they said was derived from a file the working tree
   * changed (madarch-ztyq.10 recheck).
   */
  private derived = new Set<string>();
  private nodes = new Map<string, LayerNode>();
  private edges: LayerEdge[] = [];
  private gaps: readonly LayerGap[] = [];
  private extracted = new Map<string, string>();
  private markdown: string[] | undefined;

  constructor(readonly repository: string, private readonly store: () => GraphStore) {}

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
  get held(): readonly LayerNode[] {
    return [...this.nodes.values()].sort((left, right) => byCodePoint(left.key, right.key));
  }

  /** The working tree's version of a document list: the base list with the changed files put right. */
  async documentPaths(base: readonly string[]): Promise<string[]> {
    if (this.touched.size === 0) return [...base];
    if (this.markdown === undefined) {
      let listing: readonly string[];
      try { listing = workingTree(this.repository).paths; } catch { listing = [...base]; }
      this.markdown = listing.filter(isMarkdown);
    }
    const merged = new Set<string>([...base.filter((path) => !this.touched.has(path)), ...this.markdown]);
    return [...merged].sort(byCodePoint);
  }

  /**
   * Reads the changed files again when their content is not the content the layer
   * was built from, and answers what it read. An empty answer means the layer
   * already describes this working tree.
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
    if (sameTouched && sameContent) return { reextracted: [], gaps: this.gaps };
    if (revision.touched.length === 0) {
      this.clear();
      this.touched = new Set();
      this.extracted = new Map();
      return { reextracted: [], gaps: [] };
    }
    const tree = workingTree(this.repository);
    const known = new Set(tree.paths);
    const manifests = tree.paths.filter(isManifest);
    const closure = await this.closureOf(present.filter((path) => codeLanguageOf(path) !== undefined), known);
    const dependencies = this.dependenciesOf(present, known);
    // The files whose facts the working tree owns: the changed files and the files their producers derived from.
    const scope = new Set([...present, ...dependencies]);
    // The files the stages read: the changed ones, their dependencies, the closure (to resolve, never to answer)
    // and the manifests that name a module.
    const read = [...new Set([...present, ...manifests, ...closure, ...dependencies])].sort(byCodePoint);
    const overlay: Overlay = { nodes: new Map(), edges: [], paths: new Set(present) };
    const gaps: LayerGap[] = [];
    const repository = this.repositoryId();
    const source = new WorktreeSource(repository, this.repository, revision.commit);
    const base = staticGraphReaderOf(this.store());
    const reader = new OverlayReader(base, overlay.nodes, overlay.edges, overlay.paths);
    const stages = fileStages();
    for (const path of read) {
      const fileKey = fileFactIdOf(repository, path);
      overlay.nodes.set(fileKey, await this.fileNodeOf(repository, path, fileKey, base, present.includes(path), source));
      for (const held of stages) {
        const unitId = held.unitOf(repository, path);
        if (unitId === undefined) continue;
        await this.runUnit(held.stage, unitId, `${repository}:${path}`, source, reader, overlay, gaps);
      }
    }
    // The resolution reads what the file pass wrote (decision 0033, item 14), so it runs over the changed source
    // files once their mentions and symbols stand in the overlay.
    const resolution = createSemanticResolutionStage(NEVER_PLANNED);
    for (const path of present) {
      if (codeLanguageOf(path) === undefined) continue;
      await this.runUnit(resolution, fileUnitId(repository, path), `${repository}:${path}`, source, reader, overlay, gaps);
    }
    await this.collect(overlay, scope, base);
    this.touched = new Set(revision.touched);
    this.derived = new Set(dependencies.filter((path) => !this.touched.has(path)));
    this.extracted = digests;
    this.markdown = undefined;
    this.gaps = gaps;
    return { reextracted: present.sort(byCodePoint), gaps };
  }

  /** One unit of one stage, read from the working tree, its writes added to the overlay. */
  private async runUnit(stage: FillStage, unitId: string, scope: string, source: WorktreeSource, reader: OverlayReader, overlay: Overlay, gaps: LayerGap[]): Promise<void> {
    const collector = new Collector();
    const config = resolveStageConfiguration(stage);
    const context: StageContext = {
      unit: { id: unitId, scope } satisfies StageUnit,
      config,
      graph: NO_TRACKED_READS as unknown as StageContext['graph'],
      static: {
        repository: source,
        byKey: (key, options) => reader.byKey(key, options),
        byGlobalName: (name, options) => reader.byGlobalName(name, options),
        byProperty: (kind, field, value, options) => reader.byProperty(kind, field, value, options),
        edgesByProperty: (relation, field, value, options) => reader.edgesByProperty(relation, field, value, options),
        neighbourhood: (nodeId, options) => reader.neighbourhood(nodeId, options),
      } satisfies StaticStageContext,
      draft: collector.writer,
      progress: () => undefined,
      signal: new AbortController().signal,
    };
    const result = await stage.execute(context.unit, context);
    if (result.outcome !== 'draft') {
      // A static unit reads one file and publishes its reading: a unit that asks to split or to block is a defect of
      // this layer's use of the stage, never a smaller answer.
      throw new Error(`madarch mcp: the stage ${JSON.stringify(stage.id)} answered its unit ${JSON.stringify(unitId)} with ${JSON.stringify(result.outcome)}, and a stage's unit over one working-tree file is a draft (src/mcp/layer.ts)`);
    }
    harvest(collector.writes, source.repository, unitId, overlay, gaps);
  }

  /** A file's node as the working tree declares it: the base's blob when the bytes did not move, the working tree's when they did. */
  private async fileNodeOf(repository: string, path: string, fileKey: string, base: StaticGraphReader, changed: boolean, source: WorktreeSource): Promise<StaticGraphNode> {
    const found = await base.byKey(fileKey, { limit: 2 });
    const held = found.find((node) => node.kind === 'code.file');
    const entry = await source.entry(path);
    const blob = changed ? (entry?.id ?? 'worktree:absent') : String(held?.properties['blob'] ?? entry?.id ?? 'worktree:absent');
    const properties = { ...(held?.properties ?? {}), repository, path, recordKey: fileKey, blob };
    return { id: `overlay:${fileKey}`, kind: 'code.file', label: path, properties, producer: 'madarch-mcp-working-tree', scope: '' };
  }

  /** The repository's id, as the base graph's own repository node names it: a copied product store names its own. */
  private repositoryId(): string {
    return basename(this.repository);
  }

  /**
   * The rows the overlay read, under the keys an answer names, and the base's facts about the same files hidden.
   * An edge's end is a record key; a key the overlay did not write itself — a callee of an unchanged file, a table of
   * a migration none of the read files changed — is presented by the base graph's own node of it, so the layer's
   * edges join the same entities the base graph's do.
   */
  private async collect(overlay: Overlay, scope: ReadonlySet<string>, base: StaticGraphReader): Promise<void> {
    const inScope = (path: string | undefined): boolean => path !== undefined && scope.has(path);
    const presented = new Map<string, string>();
    const nodes = new Map<string, LayerNode>();
    for (const [key, node] of overlay.nodes) {
      const properties = node.properties;
      const place = placeOf(properties);
      if (!inScope(place ?? (typeof properties['path'] === 'string' ? properties['path'] : undefined))) continue;
      const name = presentedKey(node.kind, properties);
      presented.set(key, name);
      const span = spanFromProvenance(properties);
      nodes.set(name, { key: name, kind: node.kind, label: node.label, properties, ...(span === undefined ? {} : { span }) });
    }
    const known = (key: string): boolean => presented.has(key);
    const unknown = new Set<string>();
    for (const edge of overlay.edges) for (const end of [edge.from, edge.to]) if (!known(end)) unknown.add(end);
    for (const key of [...unknown].sort(byCodePoint)) {
      const found = (await base.byKey(key, { limit: 2 })).find((node) => !overlay.paths.has(String(node.properties['file'] ?? node.properties['path'] ?? '')));
      if (found !== undefined) presented.set(key, presentedKey(found.kind, found.properties));
    }
    const edges: LayerEdge[] = [];
    for (const edge of overlay.edges) {
      const place = placeOf(edge.properties) ?? (typeof edge.properties['file'] === 'string' ? edge.properties['file'] : undefined);
      if (!inScope(place)) continue;
      edges.push({ ...edge, from: presented.get(edge.from) ?? edge.from, to: presented.get(edge.to) ?? edge.to });
    }
    this.nodes = nodes;
    this.edges = edges;
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
   * error — the reading that follows reports its own gaps.
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
  edgesAt(key: string, relation: string, direction: 'out' | 'in'): { other: string; count: number; edge: LayerEdge }[] {
    const found: { other: string; count: number; edge: LayerEdge }[] = [];
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

  /** The site line and byte position an edge was read at, when its place names one. */
  static site(span: SourceSpan | undefined): NeighborEdge['position'] {
    return span === undefined ? null : { start: span.byteStart, end: span.byteEnd };
  }
}

/** The place a record's provenance names, when it names one. */
function placeOf(properties: Readonly<Record<string, unknown>>): string | undefined {
  const span = spanFromProvenance({ ...properties });
  return span?.path;
}

export class RepositoryReads {
  private readerHeld: GraphReader | undefined;

  constructor(private readonly view: GraphView, private readonly layer: WorkingLayer, private readonly commit: string) {}

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

  /**
   * One file's text: the working tree's when it changed the file, the served commit's otherwise. The served graph may
   * have been published by the static stages, which store no text of their own (decision 0033), so the commit's bytes
   * are read from the checkout rather than from the graph's content nodes — the commit a session serves is the one its
   * graph was built at, and the answer names it.
   */
  async fileText(path: string): Promise<string | null> {
    const bytes = this.layer.hides(path) ? readWorkingFile(this.layer.repository, path) : readCommitFile(this.layer.repository, this.commit, path);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  }
}

/** A bound no answer of the seven tools reaches: every row of a kind's page, read whole to count it. */
const READ_ALL = 100_000;
