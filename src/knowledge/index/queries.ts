/**
 * What the wiki asks of the index (madarch-m38l.8), all over the current
 * index (open-ended versions as recorded now):
 *
 * - `statementsRelyingOn(key)`: the statements grounded on (or mentioning) a
 *   graph node or a document section, for the entity page's backlinks;
 * - `indexCounts()`: pages and statements per page kind, for the catalogue;
 * - `changedGrounds(...)`: the grounds whose content now differs from what
 *   the page was written from, recomputed from git against the digest the
 *   edge holds.
 *
 * Every list is in code-point order of (page, line, statement, ground).
 */
import type { DatabaseOwner } from '../../adapters/database-owner.js';
import { byCodePoint } from '../../model/order.js';
import { digestGround, type DigestMethod, type GitReader } from './grounds.js';
import { sectionKey } from './publish.js';
import { GROUNDED_BY, INDEX_PRODUCER, MENTIONS, PAGE_KIND, STATEMENT_KIND } from './vocabulary.js';

type Raw = Record<string, unknown>;

const OPEN = (alias: string): string => `${alias}.valid_to = 'infinity' AND ${alias}.recorded_to = 'infinity'`;

export interface RelyingStatement {
  readonly page: string;
  readonly pageTitle: string;
  readonly pageKind: string;
  readonly file: string;
  readonly statement: string;
  readonly text: string;
  readonly line: number;
  /** `grounds` when the statement stands on the entity, `mentions` when its text only names it. */
  readonly how: 'grounds' | 'mentions';
}

/** The statements that rely on a graph logical key, on a page id, or on a document section given as `doc:<path>#<anchor>`. */
export async function statementsRelyingOn(owner: DatabaseOwner, key: string): Promise<RelyingStatement[]> {
  const doc = key.startsWith('doc:') ? /^doc:([^#]+)#(.+)$/.exec(key) : null;
  const indexKey = doc === null ? `page:${key}` : sectionKey(doc[1]!, doc[2]!.toLowerCase());
  const rows = (await owner.run((tx) => tx.query<Raw>(
    `SELECT r.key AS relation, s.properties AS statement, p.properties AS page, p.label AS page_label
     FROM edge_version e
     JOIN relation_type r ON r.id = e.relation_type_id AND r.key IN ($1, $2)
     JOIN node_version s ON s.node_id = e.src_id AND s.producer = $3 AND s.properties ? 'statement' AND ${OPEN('s')}
     JOIN node_version d ON d.node_id = e.dst_id AND ${OPEN('d')} AND (d.properties->>'recordKey' = $4 OR (d.producer = $3 AND d.properties->>'key' = $5))
     JOIN node_version p ON p.producer = $3 AND p.properties->>'key' = 'page:' || (s.properties->>'page') AND ${OPEN('p')}
     WHERE ${OPEN('e')}`,
    [GROUNDED_BY, MENTIONS, INDEX_PRODUCER, key, indexKey],
  ))).rows;
  const byStatement = new Map<string, RelyingStatement>();
  for (const row of rows) {
    const statement = row['statement'] as Raw;
    const page = row['page'] as Raw;
    const how = row['relation'] === GROUNDED_BY ? 'grounds' : 'mentions';
    const id = String(statement['key']);
    const held = byStatement.get(id);
    if (held !== undefined && held.how === 'grounds') continue;
    byStatement.set(id, {
      page: String(page['id']), pageTitle: String(row['page_label']), pageKind: String(page['pageKind']), file: String(page['file']),
      statement: String(statement['statement']), text: String(statement['text']), line: Number(statement['line']), how: how === 'grounds' || held?.how === 'grounds' ? 'grounds' : 'mentions',
    });
  }
  return [...byStatement.values()].sort((a, b) => byCodePoint(a.page, b.page) || a.line - b.line || byCodePoint(a.statement, b.statement));
}

export interface KindCount {
  readonly kind: string;
  readonly pages: number;
  readonly statements: number;
}

/** Pages and statements per page kind, in kind order. */
export async function indexCounts(owner: DatabaseOwner): Promise<KindCount[]> {
  const rows = (await owner.run((tx) => tx.query<Raw>(
    `SELECT p.properties->>'pageKind' AS kind, count(DISTINCT p.node_id)::int AS pages, count(DISTINCT s.node_id)::int AS statements
     FROM node_version p JOIN node_kind pk ON pk.id = p.kind_id AND pk.key = $1
     LEFT JOIN node_version s ON s.producer = $3 AND s.properties ? 'statement' AND s.properties->>'page' = p.properties->>'id' AND ${OPEN('s')}
     WHERE p.producer = $2 AND ${OPEN('p')} GROUP BY 1`,
    [PAGE_KIND, INDEX_PRODUCER, INDEX_PRODUCER],
  ))).rows;
  return rows.map((row) => ({ kind: String(row['kind']), pages: Number(row['pages']), statements: Number(row['statements']) })).sort((a, b) => byCodePoint(a.kind, b.kind));
}

export type GroundStatus = 'changed' | 'unchanged' | 'removed' | 'unknown';

export interface GroundChange {
  readonly page: string;
  readonly statement: string;
  readonly text: string;
  readonly line: number;
  /** The ground as the page wrote it, without the scheme. */
  readonly ground: string;
  readonly status: GroundStatus;
  readonly method: DigestMethod;
  /** The commit the page was written at, when it said. */
  readonly writtenCommit: string | null;
  readonly before: string | null;
  readonly after: string | null;
  /** Why the status is `unknown`. */
  readonly reason?: string;
}

export interface NowState {
  /** The commit "now" is: the repository's head the graph reflects. */
  readonly commit: string;
  readonly git: GitReader;
}

/**
 * Every ground of the index, or of one page, compared with the repository now.
 * The digest of a ground at the page's written-at commit was recorded on its
 * edge when the page was indexed; the digest now is recomputed from git by the
 * same method. A statement whose ground has no recorded digest (a page with no
 * written-at, or several repositories) is `unknown`, never `unchanged`.
 * `now.commit` must be the head the graph's current spans describe.
 */
export async function changedGrounds(owner: DatabaseOwner, now: NowState, options: { page?: string } = {}): Promise<GroundChange[]> {
  const rows = (await owner.run((tx) => tx.query<Raw>(
    `SELECT s.properties AS statement, e.properties AS edge, d.properties AS dst, (d.valid_to <> 'infinity') AS gone
     FROM edge_version e
     JOIN relation_type r ON r.id = e.relation_type_id AND r.key = $1
     JOIN node_version s ON s.node_id = e.src_id AND s.producer = $2 AND s.properties ? 'statement' AND ${OPEN('s')}
     JOIN LATERAL (SELECT * FROM node_version x WHERE x.node_id = e.dst_id AND x.recorded_to = 'infinity' ORDER BY x.valid_to DESC, x.valid_from DESC LIMIT 1) d ON true
     WHERE e.recorded_to = 'infinity' AND (e.valid_to = 'infinity' OR d.valid_to <> 'infinity') AND ($3::text IS NULL OR s.properties->>'page' = $3)`,
    [GROUNDED_BY, INDEX_PRODUCER, options.page ?? null],
  ))).rows;
  const out: GroundChange[] = [];
  const unique = new Set<string>();
  for (const row of rows) {
    const statement = row['statement'] as Raw;
    const edge = row['edge'] as Raw;
    const dst = row['dst'] as Raw;
    const target = String(edge['target']);
    const id = `${String(statement['key'])}\u0000${target}`;
    if (unique.has(id)) continue;
    unique.add(id);
    const method = (typeof edge['method'] === 'string' ? edge['method'] : 'none') as DigestMethod;
    const before = typeof edge['digest'] === 'string' ? edge['digest'] : null;
    const writtenCommit = typeof edge['commit'] === 'string' ? edge['commit'] : null;
    const base = { page: String(statement['page']), statement: String(statement['statement']), text: String(statement['text']), line: Number(statement['line']), ground: target, method, writtenCommit, before };
    // A ground the fill removed ended its node, and the node's edges with it: the statement still stands on something that is gone.
    if (row['gone'] === true && before !== null) { out.push({ ...base, status: 'removed', after: null }); continue; }
    if (method === 'none' || before === null) {
      out.push({ ...base, status: 'unknown', after: null, reason: writtenCommit === null ? 'the page names no single repository it was written from, so the ground has no digest to compare' : edge['absent'] === true ? 'the ground did not exist at the written-at commit' : 'the ground has no digest' });
      continue;
    }
    let after;
    if (method === 'section') {
      const [, path, anchor] = /^doc:([^#]+)#(.+)$/.exec(target) ?? [];
      after = path === undefined ? undefined : await digestGround(now.git, now.commit, { type: 'section', path, anchor: anchor!.toLowerCase() });
    } else {
      const path = typeof dst['path'] === 'string' ? dst['path'] : spanPath(dst) ?? pathFromKey(String(dst['recordKey'] ?? ''));
      const span = method === 'span' ? spanOf(dst) : undefined;
      after = method === 'span' && span === undefined ? { method: 'span' as const, digest: null, absent: true } : await digestGround(now.git, now.commit, { type: 'node', path, ...(span === undefined ? {} : { span }) });
    }
    if (after === undefined) { out.push({ ...base, status: 'unknown', after: null, reason: `the ground ${target} has no readable document path` }); continue; }
    out.push({ ...base, after: after.digest, status: after.absent ? 'removed' : after.digest === before ? 'unchanged' : 'changed' });
  }
  return out.sort((a, b) => byCodePoint(a.page, b.page) || a.line - b.line || byCodePoint(a.statement, b.statement) || byCodePoint(a.ground, b.ground));
}

function spanOf(properties: Raw): { lineStart: number; lineEnd: number } | undefined {
  const span = properties['span'];
  if (span === null || typeof span !== 'object') return undefined;
  const { lineStart, lineEnd } = span as Raw;
  return typeof lineStart === 'number' && typeof lineEnd === 'number' ? { lineStart, lineEnd } : undefined;
}

function spanPath(properties: Raw): string | undefined {
  const span = properties['span'];
  return span !== null && typeof span === 'object' && typeof (span as Raw)['path'] === 'string' ? (span as Raw)['path'] as string : undefined;
}

function pathFromKey(key: string): string | undefined {
  if (key.startsWith('code.file:') || key.startsWith('code.directory:')) return key.slice(key.indexOf(':') + 1);
  if (key.startsWith('code.symbol:')) {
    const rest = key.slice('code.symbol:'.length);
    const hash = rest.indexOf('#');
    return hash < 0 ? rest : rest.slice(0, hash);
  }
  return undefined;
}

export { PAGE_KIND, STATEMENT_KIND };
