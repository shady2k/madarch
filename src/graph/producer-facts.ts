/** A producer's active typed assertions for SDK reconciliation (0039 item 18). */
import { SQL_TRANSACTION_KINDS } from '../sql-driver.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphContract, EntityRefDraft } from './contract.js';
import type { PluginVertexResult, PluginEdgeResult, PluginEvidence, PluginKeyValues } from '../plugin/protocol.js';
import { canonicalKey } from '../plugin/results.js';
import { withSpan } from '../obs/trace.js';
import { loadAssertions, type StoredAssertion } from './assertion-read.js';
import { referencesOf, sdkReference } from './plugin-turns.js';

type Identity = { id: number; key?: PluginKeyValues; from_node?: number; to_node?: number; discriminator?: string };
type EvidenceLink = { origin: string; id: number; kind: string; discriminator: string };

/** The argument is the host-issued source uid, never a producer display name. */
export async function producerFacts(owner: DatabaseOwner, contract: GraphContract, sourceUid: string, kinds: readonly string[], edgeKinds: readonly string[], scope?: {
  readonly kind: string;
  readonly supportEdges?: readonly string[];
  readonly foreignEdges?: readonly string[];
  readonly keys?: readonly PluginKeyValues[];
  readonly paths?: readonly string[];
}): Promise<{ vertices: PluginVertexResult[]; edges: PluginEdgeResult[] }> {
  return await withSpan('graph.producer-facts', { sourceUid }, async () => await owner.transaction(SQL_TRANSACTION_KINDS.snapshot, async tx => {
    const now = new Date((await tx.query<{ now: string | Date }>('SELECT transaction_timestamp() AS now')).rows[0]!.now).toISOString();
    const selector = { validAt: now, recordedAt: now, contexts: [1] };
    const held: { sort: 'vertex' | 'edge'; name: string; row: Identity; own: StoredAssertion[]; link?: EvidenceLink }[] = [];
    for (const sort of ['vertex', 'edge'] as const) for (const name of sort === 'vertex' ? kinds : edgeKinds) {
      const kind = contract[sort].find(declaration => declaration.name === name);
      if (kind === undefined) throw new Error(`${import.meta.path}:1: unknown reconciliation ${sort} kind ${name}`);
      const identities = await tx.query<Identity>(sort === 'vertex'
        ? 'SELECT n.id,n.key FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name=$1 ORDER BY n.uid'
        : 'SELECT n.id,n.from_node,n.to_node,n.discriminator FROM edge n JOIN entity k ON k.id=n.entity_id WHERE k.name=$1 ORDER BY n.uid', [name]);
      const fields = kind.fields.filter(field => sort === 'edge' || !('key' in kind && kind.key.includes(field.name))).map(field => field.name);
      const assertions = await loadAssertions(tx, sort, name, ['$exists', ...fields], identities.rows.map(row => Number(row.id)), { ...selector, sourceUids: [sourceUid] });
      const bySubject = new Map<number, StoredAssertion[]>();
      for (const assertion of assertions) if (assertion.source === sourceUid && assertion.language === null && assertion.selected) {
        const group = bySubject.get(assertion.subjectId);
        if (group === undefined) bySubject.set(assertion.subjectId, [assertion]); else group.push(assertion);
      }
      for (const row of identities.rows) {
        const own = bySubject.get(Number(row.id)) ?? [];
        if (own.some(assertion => assertion.property === '$exists' && assertion.value === true)) held.push({ sort, name, row, own });
      }
    }
    const assertionIds = held.flatMap(item => item.own.some(assertion => assertion.evidence.length > 0) ? item.own.map(assertion => assertion.id) : []);
    const links = assertionIds.length === 0 ? [] : (await withSpan('graph.producer-facts.evidence', {}, () => tx.query<EvidenceLink>(
      `SELECT DISTINCT ON (origin.uid) origin.uid::text AS origin,target.id,k.name AS kind,e.discriminator
       FROM edge e JOIN entity ek ON ek.id=e.entity_id JOIN node origin ON origin.id=e.from_node
       JOIN node target ON target.id=e.to_node JOIN entity k ON k.id=target.entity_id
       WHERE ek.name='system.assertion-evidence' AND origin.uid=ANY($1::uuid[])
       ORDER BY origin.uid,e.discriminator,e.uid`, [assertionIds]))).rows;
    const byAssertion = new Map(links.map(link => [link.origin, link]));
    for (const item of held) if (item.own.some(assertion => assertion.evidence.length > 0)) {
      item.link = item.own.map(assertion => assertion.id).sort().map(id => byAssertion.get(id)).find(link => link !== undefined);
    }
    const endIds = [...new Set(held.filter(item => item.sort === 'edge').flatMap(item => [Number(item.row.from_node), Number(item.row.to_node)]))];
    const ends = endIds.length === 0 ? [] : (await tx.query<{ id: number; kind: string; key: PluginKeyValues }>(
      'SELECT n.id,k.name AS kind,n.key FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.id=ANY($1::bigint[])', [endIds])).rows;
    const byEnd = new Map(ends.map(end => [Number(end.id), end]));
    const keys = scope?.keys === undefined ? undefined : new Set(scope.keys.map(canonicalKey));
    const selected = held.filter(item => {
      if (scope === undefined) return true;
      const end = item.sort === 'vertex' ? { kind: item.name, key: item.row.key! }
        : !scope.supportEdges?.includes(item.name) && byEnd.get(Number(item.row.from_node))?.kind === scope.kind ? byEnd.get(Number(item.row.from_node)) : byEnd.get(Number(item.row.to_node));
      if (end === undefined) throw new Error(`${import.meta.path}:1: reconciliation edge has a missing endpoint`);
      if (end.kind !== scope.kind && (item.sort !== 'edge' || scope.supportEdges?.includes(item.name) || !scope.foreignEdges?.includes(item.name))) return false;
      if (keys !== undefined && !keys.has(canonicalKey(end.key))) return false;
      const locator = item.link === undefined ? undefined : (JSON.parse(item.link.discriminator) as { locator: Record<string, unknown> }).locator;
      const path = locator?.['path'] ?? end.key['path'];
      return scope.paths === undefined || (typeof path === 'string' && scope.paths.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)));
    });
    const idsByKind = new Map<string, Set<number>>();
    const need = (kind: string, id: number): void => {
      let ids = idsByKind.get(kind);
      if (ids === undefined) { ids = new Set(); idsByKind.set(kind, ids); }
      ids.add(id);
    };
    for (const item of selected) {
      if (item.sort === 'vertex') need(item.name, Number(item.row.id));
      else for (const id of [Number(item.row.from_node), Number(item.row.to_node)]) {
        const end = byEnd.get(id);
        if (end === undefined) throw new Error(`${import.meta.path}:1: reconciliation edge has a missing endpoint`);
        need(end.kind, id);
      }
      if (item.link !== undefined) need(item.link.kind, Number(item.link.id));
    }
    const refs = new Map<string, Map<number, EntityRefDraft>>();
    for (const [kind, ids] of idsByKind) refs.set(kind, await referencesOf(tx, contract, kind, [...ids], selector));
    const reference = (kind: string, id: number) => sdkReference(refs.get(kind)!.get(id)!);
    const vertices: PluginVertexResult[] = [];
    const edges: PluginEdgeResult[] = [];
    for (const item of selected) {
      const values = Object.fromEntries(item.own.filter(assertion => assertion.property !== '$exists').map(assertion => [assertion.property, assertion.value]));
      let evidence: PluginEvidence | undefined;
      if (item.link !== undefined) {
        const { locator } = JSON.parse(item.link.discriminator) as { locator: Record<string, unknown> };
        evidence = { target: reference(item.link.kind, Number(item.link.id)),
          ...(typeof locator['path'] === 'string' ? { path: locator['path'] } : {}),
          ...(typeof locator['commit'] === 'string' ? { commit: locator['commit'] } : {}),
          ...(typeof locator.digest === 'string' ? { digest: locator.digest } : {}),
          ...(typeof locator['lineStart'] === 'number' ? { lineStart: locator['lineStart'] } : {}),
          ...(typeof locator['lineEnd'] === 'number' ? { lineEnd: locator['lineEnd'] } : {}) };
      }
      if (item.sort === 'vertex') {
        const ref = reference(item.name, Number(item.row.id));
        vertices.push({ kind: item.name, key: ref.key, ...(ref.keyEdges === undefined ? {} : { keyEdges: ref.keyEdges }), values, ...(evidence === undefined ? {} : { evidence }) });
      } else edges.push({ kind: item.name,
        from: reference(byEnd.get(Number(item.row.from_node))!.kind, Number(item.row.from_node)),
        to: reference(byEnd.get(Number(item.row.to_node))!.kind, Number(item.row.to_node)),
        ...(item.row.discriminator === '' ? {} : { discriminator: item.row.discriminator }), values, ...(evidence === undefined ? {} : { evidence }) });
    }
    return { vertices, edges };
  }));
}
