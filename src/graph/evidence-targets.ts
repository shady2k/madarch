/** Read-only evidence admission for the later assertion writer; never declares a target. */
import { withSpan } from '../obs/trace.js';
import type { SqlExecutor } from '../sql-driver.js';
import type { GraphContract } from './contract.js';
import { contextLayers } from './context.js';
import { loadAssertions } from './assertion-read.js';
import { selectAssertions } from './assertion-selection.js';

export interface EvidenceTargetKinds {
  readonly file: string;
  readonly repository: string;
  readonly commit: string;
  readonly blob: string;
  readonly currentCommitEdge: string;
  readonly currentFileEdge: string;
  readonly repositoryCommitEdge?: string;
  readonly repositoryKey: string;
  readonly fileRepositoryEdge: string;
  readonly filePathKey: string;
  readonly commitKey: string;
  readonly blobKey: string;
  readonly lineCountField: string;
  readonly fileBlobEdge: string;
}

export type EvidenceLocatorDraft =
  | { readonly type: 'file'; readonly repository: string; readonly commit: string; readonly path: string; readonly lineStart?: number; readonly lineEnd?: number; readonly blob?: string }
  | { readonly type: 'commit'; readonly repository: string; readonly commit: string }
  | { readonly type: 'blob'; readonly blob: string };

export type EvidenceTarget = {
  readonly target: { readonly uid: string; readonly kind: string };
  readonly locator: { readonly type: 'file'; readonly path: string; readonly lineStart?: number; readonly lineEnd?: number } | { readonly type: 'commit' | 'blob' };
};

export class EvidenceTargetError extends Error {
  constructor(readonly code: 'EVIDENCE_UNRESOLVED' | 'EVIDENCE_AMBIGUOUS' | 'EVIDENCE_KIND' | 'EVIDENCE_LINES' | 'EVIDENCE_INVALID', readonly field: string, readonly value: unknown, expected: string) {
    super(`${import.meta.path}:1: ${code}: ${field}: expected ${expected}; received ${JSON.stringify(value)}`);
  }
}

type TargetRow = { id: string; uid: string; kind: string };

function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new EvidenceTargetError('EVIDENCE_INVALID', field, value, 'nonempty text');
}

function declaredKind(contract: GraphContract, kind: string): void {
  if (!contract.vertex.some(one => one.name === kind)) throw new EvidenceTargetError('EVIDENCE_KIND', 'kind', kind, 'an installed evidence kind');
}

async function targetOf(executor: SqlExecutor, contract: GraphContract, kind: string, key: Record<string, unknown>, contextId: number, parent?: { edge: string; id: string }): Promise<TargetRow> {
  return await withSpan('graph.evidence.target', { 'graph.kind': kind }, async () => {
    declaredKind(contract, kind);
    const found = await executor.query<TargetRow>(`SELECT n.id::text AS id, n.uid::text AS uid, e.name AS kind
      FROM node n JOIN entity e ON e.id = n.entity_id
      WHERE e.name = $1 AND n.key = $2::jsonb AND graph_vertex_active(n.id,e.name,$3::bigint)
      ${parent === undefined ? '' : `AND EXISTS (SELECT 1 FROM edge relation JOIN entity k ON k.id=relation.entity_id WHERE k.name=$4 AND relation.from_node=n.id AND relation.to_node=$5::bigint AND graph_edge_active(relation.id,k.name,$3::bigint))`}`, parent === undefined ? [kind, JSON.stringify(key), contextId] : [kind, JSON.stringify(key), contextId, parent.edge, parent.id]);
    if (found.rows.length !== 1) throw new EvidenceTargetError(found.rows.length === 0 ? 'EVIDENCE_UNRESOLVED' : 'EVIDENCE_AMBIGUOUS', kind, key, 'exactly one existing active target in the requested context');
    return found.rows[0]!;
  });
}

function declaredEdge(contract: GraphContract, name: string, from: string, to: string): void {
  const edge = contract.edge.find(one => one.name === name);
  if (edge === undefined || !edge.from.includes(from) || !edge.to.includes(to)) throw new EvidenceTargetError('EVIDENCE_KIND', 'edge', name, 'a declared edge with matching endpoint kinds');
}

async function related(executor: SqlExecutor, contract: GraphContract, name: string, from: TargetRow, to: TargetRow, context: number): Promise<boolean> {
  return await withSpan('graph.evidence.relation', {}, async () => {
  declaredEdge(contract, name, from.kind, to.kind);
  const result = await executor.query(`SELECT e.id FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name=$1 AND e.from_node=$2::bigint AND e.to_node=$3::bigint AND graph_edge_active(e.id,k.name,$4::bigint)`, [name, from.id, to.id, context]);
  return result.rows.length === 1;
  });
}

function resolved(row: TargetRow, locator: EvidenceTarget['locator']): EvidenceTarget {
  return { target: { uid: row.uid, kind: row.kind }, locator };
}

/**
 * Resolve inside the caller's snapshot/operation transaction. The present graph has only a
 * current file snapshot: the declared current-commit edge must prove its commit. Historical commits alone do not
 * prove that a path or span existed there. File blob identity is proved by an edge, never a scalar value.
 */
export async function resolveEvidenceTargets(executor: SqlExecutor, contract: GraphContract, draft: EvidenceLocatorDraft, kinds: EvidenceTargetKinds, contextId = 1): Promise<readonly EvidenceTarget[]> {
  return await withSpan('graph.evidence.resolve', { 'evidence.type': draft.type, 'graph.context': contextId }, async () => {
    if (!Number.isSafeInteger(contextId) || contextId < 1) throw new EvidenceTargetError('EVIDENCE_INVALID', 'contextId', contextId, 'a positive safe integer');
    if (draft.type === 'blob') {
      text(draft.blob, 'blob');
      return [resolved(await targetOf(executor, contract, kinds.blob, { [kinds.blobKey]: draft.blob }, contextId), { type: 'blob' })];
    }
    if (draft.type !== 'commit' && draft.type !== 'file') throw new EvidenceTargetError('EVIDENCE_INVALID', 'type', (draft as { type: unknown }).type, 'file, commit or blob');
    text(draft.commit, 'commit');
    const commit = await targetOf(executor, contract, kinds.commit, { [kinds.commitKey]: draft.commit }, contextId);
    text(draft.repository, 'repository');
    const repository = await targetOf(executor, contract, kinds.repository, { [kinds.repositoryKey]: draft.repository }, contextId);
    if (draft.type === 'commit') {
      const edgeName = kinds.repositoryCommitEdge ?? kinds.currentCommitEdge;
      if (!await related(executor, contract, edgeName, repository, commit, contextId)) throw new EvidenceTargetError('EVIDENCE_UNRESOLVED', 'commit', draft.commit, 'a commit related to the repository by the declared edge');
      return [resolved(commit, { type: 'commit' })];
    }
    text(draft.path, 'path');
    const lineStart = draft.lineStart;
    const lineEnd = draft.lineEnd ?? lineStart;
    if ((lineStart !== undefined || lineEnd !== undefined) && (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd) || lineStart! < 1 || lineEnd! < lineStart!)) {
      throw new EvidenceTargetError('EVIDENCE_LINES', 'lines', { lineStart, lineEnd }, 'inclusive positive safe integers with lineStart <= lineEnd');
    }
    declaredEdge(contract, kinds.fileRepositoryEdge, kinds.file, kinds.repository);
    const file = await targetOf(executor, contract, kinds.file, { [kinds.filePathKey]: draft.path }, contextId, { edge: kinds.fileRepositoryEdge, id: repository.id });
    const containment = contract.edge.find(one => one.name === kinds.currentFileEdge);
    if (containment === undefined || !containment.to.includes(kinds.file)) throw new EvidenceTargetError('EVIDENCE_KIND', 'edge', kinds.currentFileEdge, 'a declared current file membership edge');
    const placed = await executor.query(`WITH RECURSIVE tree(id) AS (
      SELECT $4::bigint UNION SELECT e.to_node FROM tree parent JOIN edge e ON e.from_node=parent.id JOIN entity k ON k.id=e.entity_id JOIN node child ON child.id=e.to_node JOIN entity ck ON ck.id=child.entity_id
      WHERE k.name=$1 AND graph_edge_active(e.id,k.name,$3::bigint) AND graph_vertex_active(child.id,ck.name,$3::bigint)
    ) SELECT id FROM tree WHERE id=$2::bigint`, [kinds.currentFileEdge, file.id, contextId, repository.id]);
    if (placed.rows.length === 0) throw new EvidenceTargetError('EVIDENCE_UNRESOLVED', 'path', draft.path, 'a file in the current snapshot tree');
    declaredEdge(contract, kinds.currentCommitEdge, kinds.repository, kinds.commit);
    const pin = await executor.query<{ target: string }>(`SELECT e.to_node::text AS target FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name=$1 AND e.from_node=$2::bigint AND graph_edge_active(e.id,k.name,$3::bigint)`, [kinds.currentCommitEdge, repository.id, contextId]);
    if (pin.rows.length !== 1 || pin.rows[0]!.target !== commit.id) throw new EvidenceTargetError('EVIDENCE_UNRESOLVED', 'commit', draft.commit, 'the repository current snapshot commit');
    if (lineEnd !== undefined) {
      if (!contract.vertex.find(one => one.name === kinds.file)?.fields.some(one => one.name === kinds.lineCountField)) throw new EvidenceTargetError('EVIDENCE_KIND', 'field', kinds.lineCountField, 'a declared file line count');
      const rows = await loadAssertions(executor, 'vertex', kinds.file, [kinds.lineCountField], [Number(file.id)]);
      const now = new Date().toISOString();
      const layers = await contextLayers(executor, String(contextId));
      const eligible = rows.filter(row => {
        const layer = layers.find(one => Number(one.id) === row.context);
        return layer !== undefined && (layer.recordedThrough === null || row.recordedSequence <= BigInt(layer.recordedThrough));
      });
      const selected = selectAssertions(eligible, { validAt: now, recordedAt: now, contexts: layers.map(one => Number(one.id)) });
      if (selected.selected === null || selected.contested) throw new EvidenceTargetError('EVIDENCE_AMBIGUOUS', 'lines', selected.candidates.map(one => one.value), 'one agreed file line count');
      const count = Number(selected.selected.value);
      if (!Number.isSafeInteger(count) || count < lineEnd) throw new EvidenceTargetError('EVIDENCE_LINES', 'lineEnd', lineEnd, `a line within the file (${count} lines)`);
    }
    const answer = [resolved(file, { type: 'file', path: draft.path, ...(lineStart === undefined ? {} : { lineStart, lineEnd }) }), resolved(commit, { type: 'commit' })];
    if (draft.blob !== undefined) {
      text(draft.blob, 'blob');
      const blob = await targetOf(executor, contract, kinds.blob, { [kinds.blobKey]: draft.blob }, contextId);
      if (!await related(executor, contract, kinds.fileBlobEdge, file, blob, contextId)) throw new EvidenceTargetError('EVIDENCE_UNRESOLVED', 'blob', draft.blob, 'the active file blob relation');
      answer.push(resolved(blob, { type: 'blob' }));
    }
    return answer;
  });
}
