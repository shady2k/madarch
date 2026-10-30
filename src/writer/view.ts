/**
 * The writer's view of the graph (decision 0026: agents read only through the
 * graph; decision 0029: the graph indexes the code facts). It reads the graph
 * as it stood at the fill's last commit: the valid time of the last file
 * listing, as recorded now. Every answer is a bounded page in code-point
 * order, so the same graph gives the same answers.
 *
 * File content is served from the graph's content nodes (`engine:content`);
 * `ingestContent` puts the last commit's text files there, once, through the
 * graph's publication, and says which files it could not store.
 */
import { execFileSync } from 'node:child_process';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { FILES_PRODUCER } from '../extract/driver/files.js';
import { DRIVER_PRODUCER } from '../extract/driver/index.js';
import type { GraphId, GraphStore } from '../graph/index.js';
import { sha256Hex } from '../graph/digest.js';
import { GraphReader } from '../knowledge/graph-read.js';
import { byCodePoint } from '../model/order.js';
import { anchorLines, documentAnchors, slugOf } from '../knowledge/anchors.js';
import type { GroundResolver, MadarchTarget } from './format.js';
import { graphMentionName, type MentionName } from './mentions.js';

type Raw = Record<string, unknown>;

/** A graph node as the writer's tools show it. */
export interface NodeInfo {
  readonly id: GraphId;
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly properties: Record<string, unknown>;
}

export interface NeighborInfo {
  readonly relation: string;
  readonly direction: 'out' | 'in';
  readonly key: string;
  readonly kind: string;
  readonly label: string;
}

const TEXT_INSTANT = `to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** A file the writer stores and an agent may read: text under this many bytes. */
export const MAX_CONTENT_BYTES = 512 * 1024;
const DOCUMENT_EXTENSIONS = /\.(md|markdown)$/i;

export { documentAnchors, slugOf };

export class GraphView implements GroundResolver {
  private readonly keyCache = new Map<string, NodeInfo | null>();
  private readonly anchorCache = new Map<string, Set<string> | null>();
  private allAnchors: Set<string> | undefined;
  private mentionList: readonly MentionName[] | undefined;

  private constructor(private readonly owner: DatabaseOwner, private readonly store: GraphStore, readonly at: string) {}

  /** Opens the view at the last commit the fill listed files for; refuses an empty graph with the way out. */
  static async open(owner: DatabaseOwner, store: GraphStore): Promise<GraphView> {
    // The last commit's instant: the newest start of a file version, or the newest end a sweep set (a last commit that only deletes files).
    const rows = (await owner.run((tx) => tx.query<Raw>(
      `SELECT ${TEXT_INSTANT.replace('%s', 'max(t)')} AS at FROM (
         SELECT valid_from AS t FROM node_version WHERE producer = $1 AND recorded_to = 'infinity'
         UNION ALL SELECT valid_to FROM node_version WHERE producer = $1 AND recorded_to = 'infinity' AND valid_to <> 'infinity') x`,
      [FILES_PRODUCER],
    ))).rows;
    const at = rows[0]?.['at'];
    if (typeof at !== 'string') throw new Error(`src/writer/view.ts: the graph holds no file listing of producer "${FILES_PRODUCER}": fill the graph with the extract driver before the writer runs`);
    return new GraphView(owner, store, at);
  }

  /**
   * The pinned snapshot reader at this view's instant (decision 0028): the reads a unit's answers need
   * beyond a keyed node — edge sites, key prefixes, whole relations — read at the same valid time as
   * every other answer of the fill, never from the working tree.
   */
  reader(): GraphReader {
    return new GraphReader(this.owner, () => this.at);
  }

  private async query<Row extends object = Raw>(sql: string, values: readonly unknown[] = []): Promise<Row[]> {
    return (await this.owner.run((tx) => tx.query<Row>(sql, values))).rows;
  }

  private static info(row: Raw): NodeInfo {
    const properties = (row['properties'] ?? {}) as Record<string, unknown>;
    return { id: String(row['node_id']), key: String(properties['recordKey'] ?? ''), kind: String(row['kind']), label: String(row['label']), properties };
  }

  private static readonly SEEN = `v.valid_from <= $1::timestamptz AND $1::timestamptz < v.valid_to AND v.recorded_to = 'infinity'`;

  /** The node with a logical key at the last commit, or null. */
  async node(key: string): Promise<NodeInfo | null> {
    if (this.keyCache.has(key)) return this.keyCache.get(key)!;
    const rows = await this.query(
      `SELECT v.node_id::text AS node_id, k.key AS kind, v.label, v.properties FROM node_version v JOIN node_kind k ON k.id = v.kind_id
       WHERE v.properties->>'recordKey' = $2 AND ${GraphView.SEEN} ORDER BY v.node_id LIMIT 1`,
      [this.at, key],
    );
    const found = rows[0] === undefined ? null : GraphView.info(rows[0]);
    this.keyCache.set(key, found);
    return found;
  }

  async graphKey(key: string): Promise<boolean> {
    return (await this.node(key)) !== null;
  }

  /** The text of a file at the last commit from the graph's content nodes, or null when the graph holds none. */
  async fileText(path: string): Promise<string | null> {
    const file = await this.node(`code.file:${path}`);
    const sha = file?.properties['sha256'];
    if (typeof sha !== 'string') return null;
    const bytes = await this.store.contentBytes(sha);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  }

  /** The paths of the Markdown documents of the graph, code-point sorted. */
  async documentPaths(): Promise<string[]> {
    const rows = await this.query<{ path: string }>(
      `SELECT v.properties->>'path' AS path FROM node_version v JOIN node_kind k ON k.id = v.kind_id WHERE k.key = 'code.file' AND ${GraphView.SEEN}`,
      [this.at],
    );
    return rows.map((r) => r.path).filter((path) => DOCUMENT_EXTENSIONS.test(path)).sort(byCodePoint);
  }

  /** The anchors of one document, or null when the graph holds no such document text. */
  async anchorsOf(path: string): Promise<Set<string> | null> {
    if (!DOCUMENT_EXTENSIONS.test(path)) return null;
    if (this.anchorCache.has(path)) return this.anchorCache.get(path)!;
    const text = await this.fileText(path);
    const anchors = text === null ? null : new Set(documentAnchors(text));
    this.anchorCache.set(path, anchors);
    return anchors;
  }

  async docSection(path: string, anchor: string): Promise<boolean> {
    return ((await this.anchorsOf(path))?.has(anchor.toLowerCase())) === true;
  }

  /** The name a ground is shown by: a node's label, or the heading of a document's section (an identifier such as UC-2 as written). */
  async nameOf(target: MadarchTarget): Promise<string | undefined> {
    if (target.type === 'graph') {
      const node = await this.node(target.key);
      return node === null || node.label.trim() === '' ? undefined : node.label.trim();
    }
    if (target.type !== 'doc') return undefined;
    if (/^[a-z]+-\d+$/.test(target.anchor)) return target.anchor.toUpperCase();
    const text = await this.fileText(target.path);
    if (text === null) return undefined;
    const line = anchorLines(text).get(target.anchor);
    if (line === undefined) return undefined;
    const raw = text.split('\n')[line - 1] ?? '';
    const heading = /^#{1,6}\s+(.*?)\s*(?:\{#[\w-]+\})?\s*#*\s*$/.exec(raw);
    const phrase = (heading?.[1] ?? raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^(?:\*\*|__)(.*?)(?:\*\*|__).*$/, '$1')).replace(/[`*_~]/g, '').trim();
    if (phrase === '') return undefined;
    return phrase.length > 60 ? `${phrase.slice(0, 57).replace(/\s+\S*$/, '')}...` : phrase;
  }

  /**
   * The graph's node labels a page may mention (madarch-ztyq.8): one entry per node, so a label
   * several nodes share keeps every candidate and the page's evidence decides which it means. A
   * file, a directory, a path, a hash and a route line are not names; the filter lives in
   * `graphMentionName`, where its reasons are stated.
   */
  async mentionNames(): Promise<readonly MentionName[]> {
    if (this.mentionList !== undefined) return this.mentionList;
    const rows = await this.query<{ key: string; label: string }>(
      `SELECT v.properties->>'recordKey' AS key, v.label AS label FROM node_version v JOIN node_kind k ON k.id = v.kind_id
       WHERE v.properties->>'recordKey' IS NOT NULL AND v.label <> '' AND ${GraphView.SEEN}`,
      [this.at],
    );
    // A label several nodes share is kept as several candidates: the page's evidence decides which one
    // it means, and without evidence the mention stays plain (madarch-ztyq.8, review 202).
    const byTarget = new Map<string, MentionName>();
    for (const row of rows) {
      const mention = graphMentionName(row.key, row.label);
      if (mention === undefined || byTarget.has(mention.target)) continue;
      byTarget.set(mention.target, mention);
    }
    this.mentionList = [...byTarget.values()].sort((left, right) => byCodePoint(left.name, right.name) || byCodePoint(left.target, right.target));
    return this.mentionList;
  }

  /** The key of the only node of this kind whose key ends as asked and whose label is `label` (when given); undefined when none or several. */
  private async only(kind: string, text: string, accept: (node: NodeInfo) => boolean): Promise<string | undefined> {
    const found: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 3; pages += 1) {
      const page = await this.find({ kind, text, ...(after === undefined ? {} : { after }), limit: 40 });
      for (const node of page.nodes) if (accept(node) && !found.includes(node.key)) found.push(node.key);
      if (found.length > 1) return undefined;
      if (page.next === null) return found[0];
      after = page.next;
    }
    // Three pages of candidates and no end: the name is too common to say which is meant.
    return undefined;
  }

  async uniqueRoute(method: string, routePath: string): Promise<string | undefined> {
    return this.only('code.route', `#${method}:${routePath}`, (node) => node.key.endsWith(`#${method}:${routePath}`));
  }

  async uniqueSymbol(name: string): Promise<string | undefined> {
    return this.only('code.symbol', name, (node) => node.label === name);
  }

  async sourceName(name: string): Promise<boolean> {
    if ((await this.node(`code.file:${name}`)) !== null) return true;
    if (this.allAnchors === undefined) {
      const all = new Set<string>();
      for (const path of await this.documentPaths()) for (const anchor of (await this.anchorsOf(path)) ?? []) all.add(anchor);
      this.allAnchors = all;
    }
    return this.allAnchors.has(name.toLowerCase());
  }

  /** The kinds and relation types in the graph with their counts, and the repository's name. */
  async overview(): Promise<{ kinds: { kind: string; count: number }[]; relations: { relation: string; count: number }[]; documents: string[] }> {
    const kinds = await this.query<{ kind: string; n: string }>(
      `SELECT k.key AS kind, count(DISTINCT v.node_id)::text AS n FROM node_version v JOIN node_kind k ON k.id = v.kind_id WHERE ${GraphView.SEEN} AND v.properties ? 'recordKey' GROUP BY 1`,
      [this.at],
    );
    const relations = await this.query<{ relation: string; n: string }>(
      `SELECT r.key AS relation, count(*)::text AS n FROM edge_version v JOIN relation_type r ON r.id = v.relation_type_id WHERE ${GraphView.SEEN} GROUP BY 1`,
      [this.at],
    );
    return {
      kinds: kinds.map((r) => ({ kind: r.kind, count: Number(r.n) })).sort((a, b) => byCodePoint(a.kind, b.kind)),
      relations: relations.map((r) => ({ relation: r.relation, count: Number(r.n) })).sort((a, b) => byCodePoint(a.relation, b.relation)),
      documents: await this.documentPaths(),
    };
  }

  /** A page of keyed nodes in key order: of a kind, whose key or label contains `text`, after the key `after`. */
  async find(options: { kind?: string; text?: string; after?: string; limit: number }): Promise<{ nodes: NodeInfo[]; next: string | null }> {
    const rows = await this.query(
      `SELECT DISTINCT ON ((v.properties->>'recordKey') COLLATE "C") v.node_id::text AS node_id, k.key AS kind, v.label, v.properties
       FROM node_version v JOIN node_kind k ON k.id = v.kind_id
       WHERE ${GraphView.SEEN} AND v.properties ? 'recordKey'
         AND ($2::text IS NULL OR k.key = $2) AND ($3::text IS NULL OR position(lower($3) in lower(v.properties->>'recordKey' || ' ' || v.label)) > 0)
         AND ($4::text IS NULL OR (v.properties->>'recordKey') COLLATE "C" > $4)
       ORDER BY (v.properties->>'recordKey') COLLATE "C", v.node_id LIMIT $5::bigint`,
      [this.at, options.kind ?? null, options.text ?? null, options.after ?? null, String(options.limit + 1)],
    );
    const nodes = rows.map(GraphView.info).sort((a, b) => byCodePoint(a.key, b.key));
    const more = nodes.length > options.limit;
    const shown = more ? nodes.slice(0, options.limit) : nodes;
    return { nodes: shown, next: more ? shown[shown.length - 1]!.key : null };
  }

  /** Edge counts of a node by relation and direction. */
  async degree(node: NodeInfo): Promise<{ relation: string; direction: 'out' | 'in'; count: number }[]> {
    const rows = await this.query<{ relation: string; direction: 'out' | 'in'; n: string }>(
      `SELECT r.key AS relation, CASE WHEN v.src_id = $2::bigint THEN 'out' ELSE 'in' END AS direction, count(*)::text AS n
       FROM edge_version v JOIN relation_type r ON r.id = v.relation_type_id
       WHERE ${GraphView.SEEN} AND (v.src_id = $2::bigint OR v.dst_id = $2::bigint) GROUP BY 1, 2`,
      [this.at, node.id],
    );
    return rows.map((r) => ({ relation: r.relation, direction: r.direction, count: Number(r.n) })).sort((a, b) => byCodePoint(a.relation, b.relation) || byCodePoint(a.direction, b.direction));
  }

  /** A page of a node's neighbors, in (relation, key) order. */
  async neighbors(node: NodeInfo, options: { relation?: string; direction: 'out' | 'in'; after?: string; limit: number }): Promise<{ neighbors: NeighborInfo[]; next: string | null }> {
    const [self, other] = options.direction === 'out' ? ['src_id', 'dst_id'] : ['dst_id', 'src_id'];
    const rows = await this.query(
      `SELECT * FROM (
         SELECT DISTINCT r.key AS relation, o.properties->>'recordKey' AS other_key, ok.key AS kind, o.label
         FROM edge_version v JOIN relation_type r ON r.id = v.relation_type_id
         JOIN node_version o ON o.node_id = v.${other} AND o.valid_from <= $1::timestamptz AND $1::timestamptz < o.valid_to AND o.recorded_to = 'infinity'
         JOIN node_kind ok ON ok.id = o.kind_id
         WHERE ${GraphView.SEEN} AND v.${self} = $2::bigint AND ($3::text IS NULL OR r.key = $3) AND o.properties ? 'recordKey'
       ) t
       WHERE ($4::text IS NULL OR (t.relation COLLATE "C" || ' ' || t.other_key COLLATE "C") > $4::text)
       ORDER BY t.relation COLLATE "C", t.other_key COLLATE "C" LIMIT $5::bigint`,
      [this.at, node.id, options.relation ?? null, options.after ?? null, String(options.limit + 1)],
    );
    const all = rows
      .map((r) => ({ relation: String(r['relation']), direction: options.direction, key: String(r['other_key']), kind: String(r['kind']), label: String(r['label']) }))
      .sort((a, b) => byCodePoint(a.relation, b.relation) || byCodePoint(a.key, b.key));
    const more = all.length > options.limit;
    const shown = more ? all.slice(0, options.limit) : all;
    const last = shown[shown.length - 1];
    return { neighbors: shown, next: more && last !== undefined ? `${last.relation} ${last.key}` : null };
  }

  /** The file nodes that are text candidates at the last commit, with their paths and digests. */
  async fileNodes(): Promise<{ id: GraphId; path: string; sha256: string }[]> {
    const rows = await this.query<{ node_id: string; path: string; sha: string }>(
      `SELECT v.node_id::text AS node_id, v.properties->>'path' AS path, v.properties->>'sha256' AS sha FROM node_version v JOIN node_kind k ON k.id = v.kind_id
       WHERE k.key = 'code.file' AND v.properties->>'path' IS NOT NULL AND ${GraphView.SEEN} ORDER BY (v.properties->>'path') COLLATE "C"`,
      [this.at],
    );
    return rows.map((r) => ({ id: r.node_id, path: r.path, sha256: r.sha }));
  }
}

/** What `ingestContent` stored and what it could not. */
export interface ContentReport {
  readonly stored: number;
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  /** True when the graph already held exactly this input and nothing was written. */
  readonly unchanged: boolean;
}

export const CONTENT_PRODUCER = 'writer.content';

/**
 * Puts the text files of the last filled commit into the graph as content
 * nodes tied to their file nodes, so agents read file content through the
 * graph and never through the repository. A file that is binary, too large or
 * unreadable is skipped by name with its reason; a second call with the same
 * graph writes nothing.
 */
export async function ingestContent(owner: DatabaseOwner, store: GraphStore, view: GraphView, repository: string, ref = 'HEAD'): Promise<ContentReport> {
  const files = await view.fileNodes();
  const repositoryRows = (await owner.run((tx) => tx.query<{ id: string }>(
    `SELECT v.node_id::text AS id FROM node_version v JOIN node_kind k ON k.id = v.kind_id WHERE k.key = 'code.repository' AND v.producer = $1 AND v.properties->>'path' = $2 AND v.recorded_to = 'infinity' ORDER BY v.node_id`,
    [DRIVER_PRODUCER, repository],
  ))).rows;
  if (repositoryRows.length !== 1) throw new Error(`src/writer/view.ts:ingestContent: the graph holds ${repositoryRows.length} repository nodes for ${repository}; the fill of this repository must have run first`);
  const scope = repositoryRows[0]!.id;
  const skipped: { path: string; reason: string }[] = [];
  const bytesBySha = new Map<string, Uint8Array>();
  const stored: { id: GraphId; sha: string }[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = execFileSync('git', ['show', `${ref}:${file.path}`], { cwd: repository, maxBuffer: MAX_CONTENT_BYTES * 4, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      skipped.push({ path: file.path, reason: `git could not read it at ${ref}: ${(error as Error).message.split('\n')[0]}` });
      continue;
    }
    if (bytes.length > MAX_CONTENT_BYTES) { skipped.push({ path: file.path, reason: `${bytes.length} bytes is over the ${MAX_CONTENT_BYTES}-byte bound` }); continue; }
    if (bytes.includes(0)) { skipped.push({ path: file.path, reason: 'binary (it holds a NUL byte)' }); continue; }
    const sha = sha256Hex(bytes);
    if (sha !== file.sha256) { skipped.push({ path: file.path, reason: `its bytes at ${ref} (${sha}) are not the ones the graph filed (${file.sha256}): the graph was filled from another commit` }); continue; }
    bytesBySha.set(sha, new Uint8Array(bytes));
    stored.push({ id: file.id, sha });
  }
  const digest = sha256Hex(new TextEncoder().encode(JSON.stringify([view.at, stored.map((s) => s.sha + s.id)])));
  const done = (await owner.run((tx) => tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM work_item WHERE producer = $1 AND scope_id = $2::bigint AND input_digest = $3 AND published_at IS NOT NULL`, [CONTENT_PRODUCER, scope, digest]))).rows[0]!.n;
  if (Number(done) > 0) return { stored: stored.length, skipped, unchanged: true };
  const generation = Number((await owner.run((tx) => tx.query<{ g: string }>(`SELECT (coalesce(max(generation), 0) + 1)::text AS g FROM work_item WHERE producer = $1 AND scope_id = $2::bigint`, [CONTENT_PRODUCER, scope]))).rows[0]!.g);
  const leaseToken = `writer:${digest.slice(0, 16)}`;
  await store.openWorkItem({ producer: CONTENT_PRODUCER, scope, generation, inputDigest: digest, leaseToken, leaseUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  await store.publish({
    producer: CONTENT_PRODUCER,
    scope,
    generation,
    leaseToken,
    inputDigest: digest,
    nodes: [...bytesBySha].sort(([a], [b]) => byCodePoint(a, b)).map(([sha, content]) => ({ ref: `content:${sha}`, kind: 'engine:content', label: sha.slice(0, 12), content, validFrom: view.at })),
    edges: stored.map((s) => ({ relation: 'code.links-content', src: { id: s.id }, dst: { ref: `content:${s.sha}` }, validFrom: view.at })),
  });
  return { stored: stored.length, skipped, unchanged: false };
}
