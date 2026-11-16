/** Evidence proof uses retained graph values only; it never opens a source path. */
import { withSpan } from '../obs/trace.js';
import type { SqlExecutor } from '../sql-driver.js';
import type { GraphContract } from './contract.js';
import { loadAssertions } from './assertion-read.js';
import { selectAssertions } from './assertion-selection.js';
import { validateEvidenceLocator } from './evidence-locator.js';
import { sha256Hex } from './digest.js';

export interface EvidenceState {
  readonly historicalValidity: 'valid' | 'invalid' | 'unknown';
  readonly currentApplicability: 'current' | 'stale' | 'ended' | 'unknown';
  readonly availability: 'available' | 'unavailable' | 'unknown';
  readonly issues: readonly string[];
}

export type EvidenceSelector = Parameters<typeof selectAssertions>[1];
export interface EvidenceAssertion {
  readonly operation: 'assert' | 'retract';
  readonly validTo: string | null;
}

/** The producer's declared support, already selected in the reader's context. No guessed role. */
export interface EvidenceSupport {
  readonly currentApplicability: 'current' | 'stale' | 'unknown';
  readonly issues?: readonly string[];
}

/** The catalogue explicitly declares the support relation and its source endpoint. */
export interface EvidenceSupportRoles {
  readonly edgeKind: string;
  readonly direction: 'from' | 'to';
}

async function readSupports(tx: SqlExecutor, contract: GraphContract, targets: readonly { id: string }[], selector: EvidenceSelector, roles: EvidenceSupportRoles): Promise<Map<string, EvidenceSupport>> {
  return await withSpan('graph.evidence.support', {}, async () => {
    const result = new Map<string, EvidenceSupport>();
    if (!contract.edge.some(edge => edge.name === roles.edgeKind)) return new Map(targets.map(target => [target.id, { currentApplicability: 'unknown', issues: [`${import.meta.path}:37: evidence support relation is not declared`] }]));
    if (targets.length === 0) return result;
    const here = roles.direction === 'from' ? 'from_node' : 'to_node';
    const there = roles.direction === 'from' ? 'to_node' : 'from_node';
    const rows = (await tx.query<{ target_id: string; edge_id: string; source_id: string; kind: string }>(
      `SELECT e.${here}::text AS target_id,e.id::text AS edge_id,n.id::text AS source_id,k.name AS kind FROM edge e JOIN entity ek ON ek.id=e.entity_id JOIN node n ON n.id=e.${there} JOIN entity k ON k.id=n.entity_id WHERE e.${here}=ANY($1::bigint[]) AND ek.name=$2`,
      [targets.map(target => target.id), roles.edgeKind])).rows;
    const sources = new Map<string, boolean>();
    for (const kind of new Set(rows.map(row => row.kind))) {
      const ids = [...new Set(rows.filter(row => row.kind === kind).map(row => Number(row.source_id)))];
      const assertions = await loadAssertions(tx, 'vertex', kind, ['$exists'], ids);
      for (const id of ids) {
        const selection = selectAssertions(assertions.filter(row => row.subjectId === id), selector);
        sources.set(String(id), !selection.contested && selection.selected?.value === true);
      }
    }
    const sourceIds = [...new Set(rows.map(row => row.source_id))];
    const siblings = sourceIds.length === 0 ? [] : (await tx.query<{ id: string; source_id: string }>(
      `SELECT e.id::text AS id,e.${there}::text AS source_id FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.${there}=ANY($1::bigint[]) AND k.name=$2`,
      [sourceIds, roles.edgeKind])).rows;
    const assertions = await loadAssertions(tx, 'edge', roles.edgeKind, ['$exists'], siblings.map(row => Number(row.id)));
    const edgeStates = new Map(siblings.map(edge => [edge.id, selectAssertions(assertions.filter(row => row.subjectId === Number(edge.id)), selector)]));
    for (const target of targets) {
      const own = rows.filter(row => row.target_id === target.id);
      if (own.length === 0) { result.set(target.id, { currentApplicability: 'unknown', issues: [`${import.meta.path}:42: evidence has no declared source support`] }); continue; }
      let active = 0, retired = 0;
      let failure: string | undefined;
      for (const row of own) {
        if (sources.get(row.source_id) !== true) continue;
        const state = edgeStates.get(row.edge_id)!;
        if (state.contested) { failure = 'evidence support is contested'; break; }
        if (state.selected?.value !== true) { retired += 1; continue; }
        const family = siblings.filter(edge => edge.source_id === row.source_id).map(edge => edgeStates.get(edge.id)!);
        if (family.some(selection => selection.contested)) { failure = 'source support is contested'; break; }
        if (family.filter(selection => selection.selected?.value === true).length !== 1) { failure = 'source has several selected immutable support targets'; break; }
        active += 1;
      }
      result.set(target.id, failure !== undefined ? { currentApplicability: 'unknown', issues: [`${import.meta.path}:57: ${failure}`] }
        : active > 0 ? { currentApplicability: 'current' } : retired > 0 ? { currentApplicability: 'stale' }
        : { currentApplicability: 'unknown', issues: [`${import.meta.path}:62: source support is unavailable in this context`] });
    }
    return result;
  });
}

export interface EvidenceProof {
  readonly immutable: boolean;
  readonly digestAlgorithm?: 'sha256';
  readonly content: unknown;
  readonly digest: unknown;
  readonly locator: Readonly<Record<string, unknown>> | null;
  readonly validAt: string;
  readonly assertion: EvidenceAssertion;
  readonly support?: EvidenceSupport;
  readonly issues?: readonly string[];
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && [...value].every(char => '0123456789abcdef'.includes(char));
}

/** Offsets count code points; line bounds follow the writer's newline-split count. */
function spanProof(content: string, locator: Readonly<Record<string, unknown>>, issues: string[]): 'valid' | 'invalid' | 'unknown' {
  let unknown = false;
  const incomplete = (message: string): void => { issues.push(`${import.meta.path}:52: ${message}`); unknown = true; };
  const invalid = (message: string): 'invalid' => { issues.push(`${import.meta.path}:53: ${message}`); return 'invalid'; };
  const start = locator['start'], end = locator['end'];
  if (start !== undefined || end !== undefined) {
    if (typeof start !== 'number' || typeof end !== 'number') incomplete('span requires both start and end');
    else if (end > [...content].length) return invalid('span exceeds retained content');
  }
  const lineStart = locator['lineStart'], lineEnd = locator['lineEnd'];
  const columnStart = locator['columnStart'], columnEnd = locator['columnEnd'];
  if (lineStart !== undefined || lineEnd !== undefined || columnStart !== undefined || columnEnd !== undefined) {
    if (typeof lineStart !== 'number' || typeof lineEnd !== 'number') incomplete('line span requires both lineStart and lineEnd');
    else {
      const lines = content.split('\n');
      if (lineEnd > lines.length) return invalid('line span exceeds retained content');
      if (columnStart !== undefined || columnEnd !== undefined) incomplete('column indexing is not declared by the locator contract');
    }
  }
  return unknown ? 'unknown' : 'valid';
}

/** Independent dimensions: a stale source does not invalidate a retained historical snapshot. */
export function evaluateEvidenceState(proof: EvidenceProof): EvidenceState {
  const issues = [...(proof.issues ?? [])];
  const issue = (message: string): void => { issues.push(`${import.meta.path}:79: ${message}`); };
  let historicalValidity: EvidenceState['historicalValidity'] = 'unknown';
  let locatorValid = true;
  if (proof.locator !== null) {
    try { validateEvidenceLocator(proof.locator); } catch (error) {
      locatorValid = false;
      historicalValidity = 'invalid';
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  const availability: EvidenceState['availability'] = typeof proof.content === 'string' ? 'available' : 'unavailable';
  if (!proof.immutable) issue('target contract does not declare immutable evidence');
  if (availability === 'unavailable') issue('retained content is unavailable');
  if (!isDigest(proof.digest)) {
    issue('declared SHA-256 digest is unavailable or malformed');
    if (proof.immutable && typeof proof.content === 'string' && proof.digest !== undefined && proof.digest !== null) historicalValidity = 'invalid';
  }
  if (locatorValid && proof.immutable && proof.digestAlgorithm === 'sha256' && typeof proof.content === 'string' && isDigest(proof.digest)) {
    if (sha256Hex(Buffer.from(proof.content, 'utf8')) !== proof.digest) {
      historicalValidity = 'invalid';
      issue('retained content does not match its declared SHA-256 digest');
    } else if (proof.locator !== null && proof.locator['digest'] !== undefined && proof.locator['digest'] !== proof.digest) {
      historicalValidity = 'invalid';
      issue('locator digest does not match retained target digest');
    } else historicalValidity = proof.locator === null ? 'valid' : spanProof(proof.content, proof.locator, issues);
  }
  if (typeof proof.content === 'string' && proof.digestAlgorithm === undefined) issue('content digest algorithm is not declared');
  let currentApplicability: EvidenceState['currentApplicability'] = 'unknown';
  if (proof.assertion.operation === 'retract' || (proof.assertion.validTo !== null && Date.parse(proof.assertion.validTo) <= Date.parse(proof.validAt))) currentApplicability = 'ended';
  else if (proof.support !== undefined) { currentApplicability = proof.support.currentApplicability; issues.push(...(proof.support.issues ?? [])); }
  else issue('current support digest is unavailable; no applicability proof');
  return { historicalValidity, currentApplicability, availability, issues };
}

export interface EvidenceRequest {
  readonly targetUid: string;
  readonly locator: Readonly<Record<string, unknown>> | null;
  readonly assertion: EvidenceAssertion;
}

/** Retained target identities, fields and source support are loaded once per actual kind. */
export async function readEvidenceStates(
  tx: SqlExecutor, contract: GraphContract, requests: readonly EvidenceRequest[],
  selector: EvidenceSelector, support?: EvidenceSupport | EvidenceSupportRoles,
): Promise<EvidenceState[]> {
  return await withSpan('graph.evidence.states', {}, async () => {
    if (requests.length === 0) return [];
    const targets = (await tx.query<{ id: string; uid: string; kind: string; key: Record<string, unknown> }>(
      `SELECT n.id::text AS id,n.uid::text AS uid,k.name AS kind,n.key FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=ANY($1::uuid[])`,
      [[...new Set(requests.map(request => request.targetUid))]])).rows;
    const values = new Map(targets.map(target => [target.uid, { ...target.key }]));
    const issues = new Map(targets.map(target => [target.uid, [] as string[]]));
    for (const kind of new Set(targets.map(target => target.kind))) {
      const declaration = contract.vertex.find(candidate => candidate.name === kind);
      if (declaration === undefined) continue;
      const metadata = declaration.evidence;
      const fields = [...new Set([metadata?.digestField, metadata?.contentField].filter((field): field is string => field !== undefined && !declaration.key.includes(field)))];
      const subjects = targets.filter(target => target.kind === kind);
      const assertions = await loadAssertions(tx, 'vertex', kind, fields, subjects.map(target => Number(target.id)));
      for (const target of subjects) for (const field of fields) {
        const selection = selectAssertions(assertions.filter(row => row.subjectId === Number(target.id) && row.property === field), selector);
        if (selection.contested) issues.get(target.uid)!.push(`${import.meta.path}:121: evidence field ${field} is contested`);
        else if (selection.selected !== null) values.get(target.uid)![field] = selection.selected.value;
      }
    }
    const supports = support !== undefined && 'edgeKind' in support
      ? await readSupports(tx, contract, targets, selector, support)
      : new Map(targets.map(target => [target.id, support]));
    return requests.map(request => {
      const target = targets.find(candidate => candidate.uid === request.targetUid);
      const metadata = contract.vertex.find(candidate => candidate.name === target?.kind)?.evidence;
      const own = values.get(request.targetUid) ?? {};
      const selectedSupport = target === undefined ? undefined : supports.get(target.id);
      return evaluateEvidenceState({ immutable: metadata?.immutable === true, ...(metadata?.digestAlgorithm === undefined ? {} : { digestAlgorithm: metadata.digestAlgorithm }),
        content: metadata?.contentField === undefined ? undefined : own[metadata.contentField],
        digest: metadata?.digestField === undefined ? undefined : own[metadata.digestField],
        locator: request.locator, validAt: selector.validAt, assertion: request.assertion,
        ...(selectedSupport === undefined ? {} : { support: selectedSupport }),
        issues: target === undefined ? [`${import.meta.path}:115: retained target identity is unavailable: ${request.targetUid}`] : issues.get(target.uid) });
    });
  });
}
