/**
 * The index of a product's Markdown in the temporal graph (decision 0029;
 * madarch-m38l.8). One producer, `knowledge.index`, in one scope per product,
 * publishes after every fill and every page write:
 *
 * - a page node per knowledge page, with its front matter;
 * - a statement node per grounded sentence, `statement-of` its page;
 * - `grounded-by` edges from a statement to each ground: a graph node, or a
 *   document section node (`path#anchor`) with its text digest. The edge
 *   carries the ground's digest at the page's written-at commit;
 * - `mentions` edges for entity links in the text and `relates` edges from the
 *   front matter.
 *
 * The publication is complete: it is the whole of what the Markdown says, so
 * a statement the page no longer holds ends. A rebuild is the same call over
 * the same Markdown. A ground that does not resolve makes no edge and is
 * reported with its file and line; nothing is dropped silently.
 */
import type { DatabaseOwner } from '../../adapters/database-owner.js';
import { sha256Hex, type GraphId } from '../../graph/digest.js';
import type { GraphStore, PublishEdge, PublishNode } from '../../graph/index.js';
import { canonicalJsonDigest } from '../../model/canonical.js';
import { byCodePoint } from '../../model/order.js';
import { digestGround, type GitReader, type GroundDigest } from './grounds.js';
import { documentSections, sectionDigest } from './sections.js';
import type { IndexedPage, WrittenAt } from './page.js';
import { GROUNDED_BY, INDEX_PRODUCER, INDEX_VOCABULARY, MENTIONS, PAGE_KIND, PRODUCT_KIND, RELATES, SECTION_KIND, STATEMENT_KIND, STATEMENT_OF } from './vocabulary.js';

/** The repository head the graph was filled from: the commit its spans and files describe. */
export interface IndexHead {
  readonly commit: string;
  readonly git: GitReader;
}

export interface IndexInput {
  /** The product's id: one scope per product. */
  readonly productId: string;
  /** The valid time of the publication: the instant of the fill's last commit. */
  readonly at: string;
  readonly pages: readonly IndexedPage[];
  /** The graph's head, for the section nodes' digests and for trusting a node's span. */
  readonly head?: IndexHead;
  /** A reader of the repository a page names in `written-at`. */
  readonly repositories: (name: string) => GitReader | undefined;
}

export interface Unresolved {
  readonly file: string;
  readonly line: number;
  readonly statement?: string;
  readonly target: string;
  readonly reason: string;
}

export interface IndexReport {
  readonly pages: number;
  readonly statements: number;
  readonly grounds: number;
  readonly mentions: number;
  readonly relates: number;
  readonly sections: number;
  /** Grounds and mentions that name nothing the graph or the documents hold: no edge was made for them. */
  readonly unresolved: readonly Unresolved[];
  /** True when the graph already held exactly this index and nothing was written. */
  readonly unchanged: boolean;
}

type Raw = Record<string, unknown>;

export const pageKey = (id: string): string => `page:${id}`;
export const statementKey = (pageId: string, statement: string): string => `statement:${pageId}#${statement}`;
export const sectionKey = (path: string, anchor: string): string => `section:${path}#${anchor}`;

/** The key of a `madarch:` document target `doc:<path>#<anchor>`. */
function docTarget(target: string): { path: string; anchor: string } | undefined {
  if (!target.startsWith('doc:')) return undefined;
  const rest = target.slice(4);
  const hash = rest.indexOf('#');
  if (hash <= 0 || hash === rest.length - 1) return undefined;
  return { path: rest.slice(0, hash), anchor: rest.slice(hash + 1).toLowerCase() };
}

interface FoundNode {
  readonly id: GraphId;
  readonly kind: string;
  readonly path: string | undefined;
  readonly span: { lineStart: number; lineEnd: number } | undefined;
}

function pathOf(key: string, properties: Raw): string | undefined {
  const span = properties['span'];
  if (span !== null && typeof span === 'object' && typeof (span as Raw)['path'] === 'string') return (span as Raw)['path'] as string;
  if (typeof properties['path'] === 'string') return properties['path'];
  if (key.startsWith('code.file:') || key.startsWith('code.directory:')) return key.slice(key.indexOf(':') + 1);
  if (key.startsWith('code.symbol:')) {
    const rest = key.slice('code.symbol:'.length);
    const hash = rest.indexOf('#');
    return hash < 0 ? rest : rest.slice(0, hash);
  }
  return undefined;
}

function spanOf(properties: Raw): { lineStart: number; lineEnd: number } | undefined {
  const span = properties['span'];
  if (span === null || typeof span !== 'object') return undefined;
  const { lineStart, lineEnd } = span as Raw;
  return typeof lineStart === 'number' && typeof lineEnd === 'number' ? { lineStart, lineEnd } : undefined;
}

/** The nodes of the code facts that carry these logical keys, current at `at` and open-ended; the lowest id when several producers hold one key. */
async function findNodes(owner: DatabaseOwner, keys: readonly string[], at: string): Promise<Map<string, FoundNode>> {
  const out = new Map<string, FoundNode>();
  if (keys.length === 0) return out;
  const rows = (await owner.run((tx) => tx.query<Raw>(
    `SELECT v.node_id::text AS node_id, k.key AS kind, v.properties FROM node_version v JOIN node_kind k ON k.id = v.kind_id
     WHERE v.properties->>'recordKey' = ANY($2::text[]) AND v.valid_from <= $1::timestamptz AND v.valid_to = 'infinity' AND v.recorded_to = 'infinity'
     ORDER BY v.node_id::bigint`,
    [at, [...keys]],
  ))).rows;
  for (const row of rows) {
    const properties = row['properties'] as Raw;
    const key = String(properties['recordKey']);
    if (out.has(key)) continue;
    const span = spanOf(properties);
    out.set(key, { id: String(row['node_id']), kind: String(row['kind']), path: pathOf(key, properties), span });
  }
  return out;
}

async function scopeNode(owner: DatabaseOwner, store: GraphStore, productId: string, at: string): Promise<GraphId> {
  const key = `product:${productId}`;
  const found = (await owner.run((tx) => tx.query<{ id: string }>(
    `SELECT v.node_id::text AS id FROM node_version v JOIN node_kind k ON k.id = v.kind_id
     WHERE k.key = $1 AND v.producer = $2 AND v.properties->>'key' = $3 AND v.recorded_to = 'infinity' ORDER BY v.node_id::bigint LIMIT 1`,
    [PRODUCT_KIND, INDEX_PRODUCER, key],
  ))).rows[0]?.id;
  if (found !== undefined) return found;
  const nodeId = await store.newNode();
  const opened = await store.openNode({ nodeId, kind: PRODUCT_KIND, label: productId, properties: { key }, validFrom: at, owner: { producer: INDEX_PRODUCER, scope: nodeId } });
  return opened.nodeId;
}

/** The written-at entry a ground is read at: the page's only repository; none when the page names several (no guess) or none. */
function entryOf(page: IndexedPage): WrittenAt | undefined {
  return page.writtenAt.length === 1 ? page.writtenAt[0] : undefined;
}

export async function indexKnowledge(owner: DatabaseOwner, store: GraphStore, input: IndexInput): Promise<IndexReport> {
  await store.registerVocabulary({ kinds: INDEX_VOCABULARY.kinds, relations: INDEX_VOCABULARY.relations });
  const scope = await scopeNode(owner, store, input.productId, input.at);
  const pages = [...input.pages].sort((a, b) => byCodePoint(a.id, b.id));
  const pageIds = new Set(pages.map((page) => page.id));

  // Every target the Markdown names, resolved once.
  const targets = new Set<string>();
  for (const page of pages) {
    for (const key of page.relates) targets.add(key);
    for (const key of page.mentions) targets.add(key);
    for (const statement of page.statements) {
      for (const key of statement.grounds) targets.add(key);
      for (const key of statement.mentions) targets.add(key);
    }
  }
  const graphKeys = [...targets].filter((target) => !pageIds.has(target) && docTarget(target) === undefined);
  const nodes = await findNodes(owner, graphKeys, input.at);

  const unresolved: Unresolved[] = [];
  const headTexts = new Map<string, string | null>();
  const headText = async (path: string): Promise<string | null> => {
    if (input.head === undefined) return null;
    if (!headTexts.has(path)) headTexts.set(path, await input.head.git.text(input.head.commit, path));
    return headTexts.get(path)!;
  };
  // Section nodes: only the document sections some page names and the head holds.
  const sections = new Map<string, { path: string; anchor: string; digest: string | null }>();
  const wantedSections = new Map<string, { path: string; anchor: string }>();
  for (const target of targets) {
    const doc = docTarget(target);
    if (doc !== undefined) wantedSections.set(sectionKey(doc.path, doc.anchor), doc);
  }
  for (const [key, doc] of [...wantedSections].sort(([a], [b]) => byCodePoint(a, b))) {
    const text = await headText(doc.path);
    if (input.head === undefined) { sections.set(key, { ...doc, digest: null }); continue; }
    if (text === null) continue;
    const section = documentSections(text).find((entry) => entry.anchor === doc.anchor);
    if (section !== undefined) sections.set(key, { ...doc, digest: sectionDigest(section.text) });
  }

  // What the index already holds for a ground at the same commit: a span digest cannot be recomputed once the graph moved on, so it is kept.
  const previous = new Map<string, Raw>();
  for (const row of (await owner.run((tx) => tx.query<Raw>(
    `SELECT s.properties->>'key' AS statement, e.properties AS edge FROM edge_version e
     JOIN relation_type r ON r.id = e.relation_type_id AND r.key = $1
     JOIN node_version s ON s.node_id = e.src_id AND s.producer = $2 AND s.scope_id = $3::bigint AND s.recorded_to = 'infinity' AND s.valid_to = 'infinity'
     WHERE e.producer = $2 AND e.scope_id = $3::bigint AND e.recorded_to = 'infinity' AND e.valid_to = 'infinity'`,
    [GROUNDED_BY, INDEX_PRODUCER, scope],
  ))).rows) previous.set(`${String(row['statement'])}\u0000${String((row['edge'] as Raw)['target'])}`, row['edge'] as Raw);

  const digests = new Map<string, GroundDigest>();
  const digestOf = async (page: IndexedPage, statement: string, target: string): Promise<GroundDigest & { commit: string | null }> => {
    const entry = entryOf(page);
    const reader = entry === undefined ? undefined : input.repositories(entry.repository);
    const none = { method: 'none' as const, digest: null, absent: false, commit: null };
    if (entry === undefined || reader === undefined) return none;
    const kept = previous.get(`${statementKey(page.id, statement)}\u0000${target}`);
    if (kept !== undefined && kept['method'] === 'span' && kept['commit'] === entry.commit && typeof kept['digest'] === 'string') return { method: 'span', digest: kept['digest'], absent: false, commit: entry.commit };
    const doc = docTarget(target);
    const found = doc === undefined ? nodes.get(target) : undefined;
    const trusted = found?.span !== undefined && input.head !== undefined && input.head.commit.startsWith(entry.commit);
    const cacheKey = `${entry.commit}\u0000${target}\u0000${trusted}`;
    let held = digests.get(cacheKey);
    if (held === undefined) {
      held = doc !== undefined
        ? await digestGround(reader, entry.commit, { type: 'section', path: doc.path, anchor: doc.anchor })
        : await digestGround(reader, entry.commit, { type: 'node', path: found?.path, ...(trusted ? { span: found!.span! } : {}) });
      digests.set(cacheKey, held);
    }
    return { ...held, commit: entry.commit };
  };

  // The scope node is the producer's own, so a complete publication must repeat it or it would end it.
  const nodeItems: PublishNode[] = [{ ref: `product:${input.productId}`, kind: PRODUCT_KIND, label: input.productId, validFrom: input.at, properties: { key: `product:${input.productId}` } }];
  const edgeItems: PublishEdge[] = [];
  const counts = { statements: 0, grounds: 0, mentions: 0, relates: 0 };
  const endOf = (target: string): { id: GraphId } | { ref: string } | undefined => {
    if (pageIds.has(target)) return { ref: pageKey(target) };
    const doc = docTarget(target);
    if (doc !== undefined) return sections.has(sectionKey(doc.path, doc.anchor)) ? { ref: sectionKey(doc.path, doc.anchor) } : undefined;
    const found = nodes.get(target);
    return found === undefined ? undefined : { id: found.id };
  };
  const endKey = (end: { id: GraphId } | { ref: string }): string => ('id' in end ? `id:${end.id}` : end.ref);

  for (const page of pages) {
    nodeItems.push({
      ref: pageKey(page.id), kind: PAGE_KIND, label: page.title, validFrom: input.at,
      properties: { key: pageKey(page.id), id: page.id, pageKind: page.kind, file: page.file, digest: page.digest, producer: page.producer, sources: [...page.sources], writtenAt: page.writtenAt.map((entry) => ({ ...entry })) },
    });
    for (const key of page.relates) {
      const end = endOf(key);
      if (end === undefined) { unresolved.push({ file: page.file, line: 2, target: key, reason: `relates entry "${key}" is no node of the graph at ${input.at}` }); continue; }
      edgeItems.push({ relation: RELATES, src: { ref: pageKey(page.id) }, dst: end, validFrom: input.at });
      counts.relates += 1;
    }
    const covered = new Set<string>();
    for (const statement of page.statements) {
      const ref = statementKey(page.id, statement.id);
      nodeItems.push({
        ref, kind: STATEMENT_KIND, label: statement.id, validFrom: input.at,
        properties: { key: ref, page: page.id, statement: statement.id, text: statement.text, digest: statement.digest, line: statement.line },
      });
      edgeItems.push({ relation: STATEMENT_OF, src: { ref }, dst: { ref: pageKey(page.id) }, validFrom: input.at });
      counts.statements += 1;
      const seen = new Set<string>();
      for (const target of statement.grounds) {
        const end = endOf(target);
        if (end === undefined) { unresolved.push({ file: page.file, line: statement.line, statement: statement.id, target, reason: `the ground ${target} names no node of the graph and no document section at ${input.at}` }); continue; }
        if (seen.has(endKey(end))) continue;
        seen.add(endKey(end));
        const digest = await digestOf(page, statement.id, target);
        edgeItems.push({ relation: GROUNDED_BY, src: { ref }, dst: end, validFrom: input.at, properties: { target, method: digest.method, digest: digest.digest, absent: digest.absent, commit: digest.commit } });
        counts.grounds += 1;
      }
      const mentioned = new Set<string>();
      for (const target of statement.mentions) {
        covered.add(target);
        const end = endOf(target);
        if (end === undefined) { unresolved.push({ file: page.file, line: statement.line, statement: statement.id, target, reason: `the link ${target} names no node of the graph, no page and no document section` }); continue; }
        if (mentioned.has(endKey(end))) continue;
        mentioned.add(endKey(end));
        edgeItems.push({ relation: MENTIONS, src: { ref }, dst: end, validFrom: input.at });
        counts.mentions += 1;
      }
    }
    const loose = new Set<string>();
    for (const target of page.mentions) {
      if (covered.has(target)) continue;
      const end = endOf(target);
      if (end === undefined) { unresolved.push({ file: page.file, line: 1, target, reason: `the link ${target} names no node of the graph, no page and no document section` }); continue; }
      if (loose.has(endKey(end))) continue;
      loose.add(endKey(end));
      edgeItems.push({ relation: MENTIONS, src: { ref: pageKey(page.id) }, dst: end, validFrom: input.at });
      counts.mentions += 1;
    }
  }
  for (const [key, section] of [...sections].sort(([a], [b]) => byCodePoint(a, b))) {
    nodeItems.push({ ref: key, kind: SECTION_KIND, label: `${section.path}#${section.anchor}`, validFrom: input.at, properties: { key, path: section.path, anchor: section.anchor, digest: section.digest } });
  }

  // Identities of the nodes this producer already holds, by key.
  // A key that ended and comes back keeps its identity, so its history is one history.
  const held = new Map((await owner.run((tx) => tx.query<{ id: string; key: string }>(
    `SELECT DISTINCT ON (v.properties->>'key') v.node_id::text AS id, v.properties->>'key' AS key FROM node_version v
     WHERE v.producer = $1 AND v.scope_id = $2::bigint AND v.recorded_to = 'infinity' AND v.properties ? 'key'
     ORDER BY v.properties->>'key', v.valid_to DESC, v.node_id::bigint`,
    [INDEX_PRODUCER, scope],
  ))).rows.map((row) => [row.key, row.id] as const));
  const items = nodeItems.map((node) => (held.has(node.ref!) ? { ...node, id: held.get(node.ref!)! } : node)).sort((a, b) => byCodePoint(a.ref!, b.ref!));
  const edges = [...edgeItems].sort((a, b) => byCodePoint(JSON.stringify([a.relation, a.src, a.dst]), JSON.stringify([b.relation, b.src, b.dst])));
  const report = (unchanged: boolean): IndexReport => ({ pages: pages.length, ...counts, sections: sections.size, unresolved, unchanged });

  // What the digest names is what the Markdown says, not the identities the store gave: the same input is the same input on every call.
  const inputDigest = canonicalJsonDigest({ at: input.at, nodes: [...nodeItems].sort((a, b) => byCodePoint(a.ref!, b.ref!)), edges });
  const last = (await owner.run((tx) => tx.query<{ generation: string; input_digest: string }>(
    `SELECT generation::text AS generation, input_digest FROM work_item WHERE producer = $1 AND scope_id = $2::bigint AND published_at IS NOT NULL ORDER BY generation DESC LIMIT 1`,
    [INDEX_PRODUCER, scope],
  ))).rows[0];
  if (last !== undefined && last.input_digest === inputDigest) return report(true);
  const generation = Number((await owner.run((tx) => tx.query<{ g: string }>(`SELECT (coalesce(max(generation), 0) + 1)::text AS g FROM work_item WHERE producer = $1 AND scope_id = $2::bigint`, [INDEX_PRODUCER, scope]))).rows[0]!.g);
  const leaseToken = `knowledge-index:${sha256Hex(new TextEncoder().encode(inputDigest)).slice(0, 16)}`;
  await store.openWorkItem({ producer: INDEX_PRODUCER, scope, generation, inputDigest, leaseToken, leaseUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  const endAt = new Date(new Date(input.at).getTime() + 1).toISOString().replace(/Z$/, '000Z');
  await store.publish({ producer: INDEX_PRODUCER, scope, generation, leaseToken, inputDigest, nodes: items, edges, complete: { validTo: endAt } });
  return report(false);
}
