/** A producer's active typed assertions for SDK reconciliation (0039 item 18). */
import { SQL_TRANSACTION_KINDS } from '../sql-driver.js';
import type { SqlExecutor } from '../sql-driver.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphContract, EntityRefDraft } from './contract.js';
import type { PluginVertexResult, PluginEdgeResult, PluginEvidence, PluginKeyValues, PluginSubjectRevision } from '../plugin/protocol.js';
import { canonicalKey } from '../plugin/results.js';
import { canonicalAssertionValue } from './assertion-selection.js';
import { withSpan } from '../obs/trace.js';
import { loadAssertionsBatch, type StoredAssertion } from './assertion-read.js';
import { referencesOf, sdkReference } from './plugin-turns.js';

type Identity = { id: number; key?: PluginKeyValues; from_node?: number; to_node?: number; discriminator?: string };
type EvidenceLink = { origin: string; id: number; kind: string; discriminator: string };

/** The sequence one subject holds in the source's stream: its id and the last recorded sequence of that statement. */
type SubjectSequence = { readonly id: number; readonly recordedSequence: string };

/**
 * The last recorded sequence of the source's stream for each subject of the covered kinds (0039 item 24, clarification of
 * 2026-11-18): the read a reconcile batch is decided from states it, and a retraction is a statement of the stream too, so
 * a withdrawn subject has a sequence and a later assertion of the same subject is planned from it. Two statements: one
 * for vertex subjects, one for edge subjects, each grouped by subject — the cost is the source's own stream, not a fact.
 */
async function sourceSubjectSequences(tx: SqlExecutor, sourceUid: string, kinds: readonly string[], edgeKinds: readonly string[]): Promise<{ vertices: SubjectSequence[]; edges: SubjectSequence[] }> {
  return await withSpan('graph.producer-facts.sequences', {}, async () => {
  const source = `JOIN edge source ON source.from_node=a.assertion_id
      JOIN entity source_kind ON source_kind.id=source.entity_id AND source_kind.name='system.assertion-source' AND source_kind.sort='edge'
      JOIN node source_node ON source_node.id=source.to_node`;
  const vertices = kinds.length === 0 ? [] : (await tx.query<SubjectSequence>(`SELECT n.id,max(a.recorded_sequence)::text AS "recordedSequence" FROM assertion a
      ${source}
      JOIN assertion_vertex_subject subject ON subject.assertion_id=a.assertion_id
      JOIN edge attachment ON attachment.id=subject.subject_edge_id
      JOIN node n ON n.id=attachment.to_node
      JOIN entity k ON k.id=n.entity_id
    WHERE source_node.uid::text=$1 AND k.name=ANY($2::text[])
    GROUP BY n.id`, [sourceUid, kinds])).rows;
  const edges = edgeKinds.length === 0 ? [] : (await tx.query<SubjectSequence>(`SELECT e.id,max(a.recorded_sequence)::text AS "recordedSequence" FROM assertion a
      ${source}
      JOIN assertion_edge_subject subject ON subject.assertion_id=a.assertion_id
      JOIN edge e ON e.id=subject.edge_id
      JOIN entity k ON k.id=e.entity_id
    WHERE source_node.uid::text=$1 AND k.name=ANY($2::text[])
    GROUP BY e.id`, [sourceUid, edgeKinds])).rows;
  return { vertices, edges };
  });
}

/** The matching unit endpoint anchors scope; foreign pairs use their target. */
export function reconciliationEndpoint<T extends { readonly kind: string }>(kind: string, from: T, to: T): T {
  return from.kind === kind ? from : to;
}

/** The argument is the host-issued source uid, never a producer display name. */
export async function producerFacts(owner: DatabaseOwner, contract: GraphContract, sourceUid: string, kinds: readonly string[], edgeKinds: readonly string[], scope?: {
  readonly kind: string;
  readonly ownedEdges?: readonly { readonly kind: string; readonly from: string; readonly to: string }[];
  readonly keys?: readonly PluginKeyValues[];
  readonly supportKeys?: boolean;
  readonly paths?: readonly string[];
}): Promise<{ vertices: PluginVertexResult[]; edges: PluginEdgeResult[]; revisions: PluginSubjectRevision[] }> {
  return await withSpan('graph.producer-facts', { sourceUid }, async () => await owner.transaction(SQL_TRANSACTION_KINDS.snapshot, async tx => {
    const now = new Date((await tx.query<{ now: string | Date }>('SELECT transaction_timestamp() AS now')).rows[0]!.now).toISOString();
    const selector = { validAt: now, recordedAt: now, contexts: [1] };
    const held: { sort: 'vertex' | 'edge'; name: string; row: Identity; own: StoredAssertion[]; link?: EvidenceLink }[] = [];
    const requested = (['vertex', 'edge'] as const).flatMap(sort => (sort === 'vertex' ? kinds : edgeKinds).map(name => {
      const kind = contract[sort].find(declaration => declaration.name === name);
      if (kind === undefined) throw new Error(`${import.meta.path}:1: unknown reconciliation ${sort} kind ${name}`);
      const fields = kind.fields.filter(field => sort === 'edge' || !('key' in kind && kind.key.includes(field.name))).map(field => field.name);
      return { sort, name, fields };
    }));
    const identities = requested.length === 0 ? [] : (await tx.query<Identity & { sort: 'vertex' | 'edge'; name: string }>(
      `SELECT 'vertex' AS sort,k.name,n.id,n.key,NULL::bigint AS from_node,NULL::bigint AS to_node,NULL::text AS discriminator,n.uid
       FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name=ANY($1::text[])
       UNION ALL
       SELECT 'edge' AS sort,k.name,n.id,NULL::jsonb AS key,n.from_node,n.to_node,n.discriminator,n.uid
       FROM edge n JOIN entity k ON k.id=n.entity_id WHERE k.name=ANY($2::text[])
       ORDER BY uid`, [kinds, edgeKinds])).rows;
    const identitiesByKind = new Map<string, Identity[]>();
    const identityById = new Map(identities.map(row => [Number(row.id), row]));
    for (const row of identities) {
      const key = `${row.sort}:${row.name}`;
      const group = identitiesByKind.get(key);
      if (group === undefined) identitiesByKind.set(key, [row]); else group.push(row);
    }
    // One statement for every requested kind, not one read per kind.
    const batches = requested.length === 0 ? [] : await loadAssertionsBatch(tx, requested.map(({ sort, name, fields }) => ({
      sort, kind: name, properties: ['$exists', ...fields], subjectIds: (identitiesByKind.get(`${sort}:${name}`) ?? []).map(row => Number(row.id)),
    })), { ...selector, sourceUids: [sourceUid], currentValues: true });
    for (const [requestIndex, { sort, name }] of requested.entries()) {
      const rows = identitiesByKind.get(`${sort}:${name}`) ?? [];
      const assertions = batches[requestIndex]!;
      const bySubject = new Map<number, StoredAssertion[]>();
      for (const assertion of assertions) if (assertion.source === sourceUid && assertion.language === null && assertion.selected) {
        const group = bySubject.get(assertion.subjectId);
        if (group === undefined) bySubject.set(assertion.subjectId, [assertion]); else group.push(assertion);
      }
      for (const row of rows) {
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
    const sequences = await sourceSubjectSequences(tx, sourceUid, kinds, edgeKinds);
    const endIds = [...new Set([
      ...held.filter(item => item.sort === 'edge').flatMap(item => [Number(item.row.from_node), Number(item.row.to_node)]),
      ...sequences.edges.flatMap(sequence => { const row = identityById.get(sequence.id)!; return [Number(row.from_node), Number(row.to_node)]; }),
    ])];
    const ends = endIds.length === 0 ? [] : (await tx.query<{ id: number; kind: string; key: PluginKeyValues }>(
      'SELECT n.id,k.name AS kind,n.key FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.id=ANY($1::bigint[])', [endIds])).rows;
    const byEnd = new Map(ends.map(end => [Number(end.id), end]));
    const keys = scope?.keys === undefined ? undefined : new Set(scope.keys.map(canonicalKey));
    const inScope = (item: (typeof held)[number], supportKey = false): boolean => {
      if (scope === undefined) return true;
      let end;
      if (item.sort === 'vertex') {
        if (item.name !== scope.kind) return false;
        end = { kind: item.name, key: item.row.key! };
      } else {
        const from = byEnd.get(Number(item.row.from_node));
        const to = byEnd.get(Number(item.row.to_node));
        if (from === undefined || to === undefined) throw new Error(`${import.meta.path}:1: reconciliation edge has a missing endpoint`);
        if (!scope.ownedEdges?.some(edge => edge.kind === item.name && edge.from === from.kind && edge.to === to.kind)) return false;
        end = reconciliationEndpoint(scope.kind, from, to);
      }
      if (keys !== undefined && !supportKey && !keys.has(canonicalKey(end.key))) return false;
      const locator = item.link === undefined ? undefined : (JSON.parse(item.link.discriminator) as { locator: Record<string, unknown> }).locator;
      const path = locator?.['path'] ?? end.key['path'];
      return scope.paths === undefined || (typeof path === 'string' && scope.paths.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)));
    };
    const scoped = held.filter(item => inScope(item));
    // The sequences the answer names are the subjects the read covers: a subject outside the read's scope is its own
    // business, and answering it would grow every reconciliation answer by a partition it never touches.
    const sequenceInScope = (sequence: SubjectSequence, sort: 'vertex' | 'edge'): boolean => {
      const row = identityById.get(sequence.id)!;
      return inScope({ sort, name: row.name, row, own: [] });
    };
    const coveredSequences = { vertices: sequences.vertices.filter(sequence => sequenceInScope(sequence, 'vertex')), edges: sequences.edges.filter(sequence => sequenceInScope(sequence, 'edge')) };
    const supportIds = new Set<number>();
    if (scope?.supportKeys === true && keys !== undefined) for (const item of scoped) {
      if (item.link?.kind === scope.kind) supportIds.add(Number(item.link.id));
      if (item.sort !== 'edge') continue;
      const from = byEnd.get(Number(item.row.from_node))!;
      const to = byEnd.get(Number(item.row.to_node))!;
      if (from.kind === scope.kind && to.kind === scope.kind && keys.has(canonicalKey(from.key))) supportIds.add(Number(to.id));
    }
    const scopedItems = new Set(scoped);
    const selected = held.filter(item => scopedItems.has(item) || (item.sort === 'vertex' && supportIds.has(Number(item.row.id)) && inScope(item, true)));
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
    // A revision may name a retracted subject, whose key edge was retracted with it: its identity, and its ends', is read
    // from the rows the graph holds rather than from active statements.
    const storedIdsByKind = new Map<string, Set<number>>();
    const needStored = (kind: string, id: number): void => {
      let ids = storedIdsByKind.get(kind);
      if (ids === undefined) { ids = new Set(); storedIdsByKind.set(kind, ids); }
      ids.add(id);
    };
    for (const sequence of coveredSequences.vertices) needStored(identityById.get(sequence.id)!.name, sequence.id);
    for (const sequence of coveredSequences.edges) {
      const row = identityById.get(sequence.id)!;
      for (const id of [Number(row.from_node), Number(row.to_node)]) needStored(byEnd.get(id)!.kind, id);
    }
    const storedRefs = new Map<string, Map<number, EntityRefDraft>>();
    for (const [kind, ids] of storedIdsByKind) storedRefs.set(kind, await referencesOf(tx, contract, kind, [...ids], selector, { stored: true }));
    const storedReference = (kind: string, id: number) => sdkReference(storedRefs.get(kind)!.get(id)!);
    const revisions: PluginSubjectRevision[] = [
      ...coveredSequences.vertices.map(sequence => ({
        subject: { sort: 'vertex' as const, ...storedReference(identityById.get(sequence.id)!.name, sequence.id) },
        recordedSequence: String(sequence.recordedSequence),
      })),
      ...coveredSequences.edges.map(sequence => {
        const row = identityById.get(sequence.id)!;
        return {
          subject: { sort: 'edge' as const, kind: row.name, from: storedReference(byEnd.get(Number(row.from_node))!.kind, Number(row.from_node)), to: storedReference(byEnd.get(Number(row.to_node))!.kind, Number(row.to_node)), ...(row.discriminator === undefined || row.discriminator === '' ? {} : { discriminator: row.discriminator }) },
          recordedSequence: String(sequence.recordedSequence),
        };
      }),
    ].sort((left, right) => { const a = canonicalAssertionValue(left.subject), b = canonicalAssertionValue(right.subject); return a === b ? 0 : a < b ? -1 : 1; });
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
    return { vertices, edges, revisions };
  }));
}
