/** Read-only evidence admission for the later assertion writer; never declares a target. */
import { withSpan } from '../obs/trace.js';
import type { SqlExecutor } from '../sql-driver.js';
import type { GraphContract } from './contract.js';

export interface EvidenceTargetKinds {
  readonly file: string;
  readonly repository: string;
  readonly commit: string;
  readonly blob: string;
  readonly currentCommitEdge: string;
  readonly currentFileEdge: string;
  readonly repositoryCommitEdge?: string;
  readonly repositoryKey: string;
  readonly fileRepositoryKey: string;
  readonly filePathKey: string;
  readonly commitKey: string;
  readonly blobKey: string;
  readonly lineCountField: string;
  readonly fileBlobField: string;
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

function tableOf(contract: GraphContract, kind: string): string {
  const vertex = contract.vertex.find(one => one.name === kind);
  if (vertex === undefined) throw new EvidenceTargetError('EVIDENCE_KIND', 'kind', kind, 'an installed evidence kind');
  // Names come from the installed contract, but still quote them as identifiers.
  return `"${vertex.table.replaceAll('"', '""')}"`;
}

async function targetOf(executor: SqlExecutor, contract: GraphContract, kind: string, key: Record<string, unknown>, contextId: number): Promise<TargetRow> {
  return await withSpan('graph.evidence.target', { 'graph.kind': kind }, async () => {
    tableOf(contract, kind);
    const found = await executor.query<TargetRow>(`SELECT n.id::text AS id, n.uid::text AS uid, e.name AS kind
      FROM node n JOIN entity e ON e.id = n.entity_id
      WHERE e.name = $1 AND n.key = $2::jsonb AND n.context_id = $3 AND NOT n.removed`, [kind, JSON.stringify(key), contextId]);
    if (found.rows.length !== 1) throw new EvidenceTargetError(found.rows.length === 0 ? 'EVIDENCE_UNRESOLVED' : 'EVIDENCE_AMBIGUOUS', kind, key, 'exactly one existing active target in the requested context');
    return found.rows[0]!;
  });
}

function edgeTable(contract: GraphContract, name: string, kinds: EvidenceTargetKinds): string {
  const edge = contract.edge.find(one => one.name === name);
  if (edge?.table === undefined || !edge.from.includes(kinds.repository) || !edge.to.includes(kinds.commit)) throw new EvidenceTargetError('EVIDENCE_KIND', 'edge', name, 'a declared repository-to-commit edge with an opinion table');
  return `"${edge.table.replaceAll('"', '""')}"`;
}

function resolved(row: TargetRow, locator: EvidenceTarget['locator']): EvidenceTarget {
  return { target: { uid: row.uid, kind: row.kind }, locator };
}

/**
 * Resolve inside the caller's snapshot/operation transaction. The present graph has only a
 * current file snapshot: the declared current-commit edge must prove its commit. Historical commits alone do not
 * prove that a path or span existed there. Blob strings on file opinions are not vertices.
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
      const table = edgeTable(contract, edgeName, kinds);
      const membership = await executor.query(`SELECT e.id FROM edge e JOIN entity k ON k.id = e.entity_id WHERE k.name = $1 AND e.from_node = $2::bigint AND e.to_node = $3::bigint AND e.context_id = $4 AND EXISTS (SELECT 1 FROM ${table} o WHERE o.edge_id = e.id AND o.context_id = $4 AND o.state IN ('open', 'confirmed'))`, [edgeName, repository.id, commit.id, contextId]);
      if (membership.rows.length !== 1) throw new EvidenceTargetError('EVIDENCE_UNRESOLVED', 'commit', draft.commit, 'a commit related to the repository by the declared edge');
      return [resolved(commit, { type: 'commit' })];
    }
    text(draft.path, 'path');
    const lineStart = draft.lineStart;
    const lineEnd = draft.lineEnd ?? lineStart;
    if ((lineStart !== undefined || lineEnd !== undefined) && (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd) || lineStart! < 1 || lineEnd! < lineStart!)) {
      throw new EvidenceTargetError('EVIDENCE_LINES', 'lines', { lineStart, lineEnd }, 'inclusive positive safe integers with lineStart <= lineEnd');
    }
    const reference = contract.vertex.find(one => one.name === kinds.file)?.fields.find(one => one.name === kinds.fileRepositoryKey)?.reference;
    const file = await targetOf(executor, contract, kinds.file, { [kinds.fileRepositoryKey]: reference === undefined ? draft.repository : { kind: reference, key: { [kinds.repositoryKey]: draft.repository } }, [kinds.filePathKey]: draft.path }, contextId);
    const containment = contract.edge.find(one => one.name === kinds.currentFileEdge);
    if (containment?.table === undefined || !containment.to.includes(kinds.file)) throw new EvidenceTargetError('EVIDENCE_KIND', 'edge', kinds.currentFileEdge, 'a declared current file membership edge');
    const containmentTable = `"${containment.table.replaceAll('"', '""')}"`;
    const placed = await executor.query(`WITH RECURSIVE tree(id) AS (
        SELECT $4::bigint
        UNION
        SELECT e.to_node FROM tree parent JOIN edge e ON e.from_node = parent.id
          JOIN entity k ON k.id = e.entity_id JOIN node child ON child.id = e.to_node
        WHERE k.name = $1 AND e.context_id = $3 AND child.context_id = $3 AND NOT child.removed
          AND EXISTS (SELECT 1 FROM ${containmentTable} o WHERE o.edge_id = e.id AND o.context_id = $3 AND o.state IN ('open', 'confirmed'))
      ) SELECT id FROM tree WHERE id = $2::bigint`, [kinds.currentFileEdge, file.id, contextId, repository.id]);
    if (placed.rows.length === 0) throw new EvidenceTargetError('EVIDENCE_UNRESOLVED', 'path', draft.path, 'a file in the current snapshot tree');
    const pinTable = edgeTable(contract, kinds.currentCommitEdge, kinds);
    const pin = await executor.query(`SELECT e.to_node::text AS target FROM edge e JOIN entity k ON k.id = e.entity_id
      WHERE k.name = $3 AND e.from_node = $1::bigint AND e.context_id = $2 AND EXISTS (SELECT 1 FROM ${pinTable} o WHERE o.edge_id = e.id AND o.context_id = $2 AND o.state IN ('open', 'confirmed'))`, [repository.id, contextId, kinds.currentCommitEdge]);
    if (pin.rows.length !== 1 || pin.rows[0]!['target'] !== commit.id) throw new EvidenceTargetError('EVIDENCE_UNRESOLVED', 'commit', draft.commit, 'the repository current snapshot commit');
    const fileTable = tableOf(contract, kinds.file);
    const column = (name: string): string => {
      if (!contract.vertex.find(one => one.name === kinds.file)?.fields.some(one => one.name === name)) throw new EvidenceTargetError('EVIDENCE_KIND', 'field', name, 'a declared file field');
      return `"${name.replaceAll('"', '""')}"`;
    };
    if (lineEnd !== undefined) {
      const counts = await executor.query<{ lines: string | null }>(`SELECT ${column(kinds.lineCountField)}::text AS lines FROM ${fileTable} WHERE node_id = $1::bigint AND context_id = $2 AND state IN ('open', 'confirmed')`, [file.id, contextId]);
      const distinct = new Set(counts.rows.map(one => one.lines));
      if (distinct.size !== 1 || distinct.has(null)) throw new EvidenceTargetError('EVIDENCE_AMBIGUOUS', 'lines', [...distinct], 'one agreed file line count');
      const count = Number(counts.rows[0]!.lines);
      if (!Number.isSafeInteger(count) || count < lineEnd) throw new EvidenceTargetError('EVIDENCE_LINES', 'lineEnd', lineEnd, `a line within the file (${count} lines)`);
    }
    const answer = [resolved(file, { type: 'file', path: draft.path, ...(lineStart === undefined ? {} : { lineStart, lineEnd }) }), resolved(commit, { type: 'commit' })];
    if (draft.blob !== undefined) {
      text(draft.blob, 'blob');
      const blob = await targetOf(executor, contract, kinds.blob, { [kinds.blobKey]: draft.blob }, contextId);
      const held = await executor.query<{ blob: string | null }>(`SELECT ${column(kinds.fileBlobField)} AS blob FROM ${fileTable} WHERE node_id = $1::bigint AND context_id = $2 AND state IN ('open', 'confirmed')`, [file.id, contextId]);
      if (held.rows.length === 0 || held.rows.some(one => one.blob !== draft.blob)) throw new EvidenceTargetError('EVIDENCE_UNRESOLVED', 'blob', draft.blob, 'the agreed file blob');
      answer.push(resolved(blob, { type: 'blob' }));
    }
    return answer;
  });
}
