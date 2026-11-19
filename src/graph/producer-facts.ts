/** A producer's active typed assertions for SDK reconciliation (0039 item 18). */
import { SQL_TRANSACTION_KINDS, type SqlExecutor } from '../sql-driver.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphContract } from './contract.js';
import type { PluginVertexResult, PluginEdgeResult, PluginEvidence, PluginEntityRef } from '../plugin/protocol.js';
import { withSpan } from '../obs/trace.js';
import { loadAssertions, type StoredAssertion } from './assertion-read.js';
import { referenceOf } from './plugin-turns.js';

/** The SDK reference envelope carries natural keys and parent roles, not host uids. */
function sdkReference(reference: import('./contract.js').EntityRefDraft): PluginEntityRef {
  return { kind: reference.kind, key: reference.key, ...(reference.keyEdges === undefined ? {} : {
    keyEdges: Object.fromEntries(Object.entries(reference.keyEdges).map(([role, parent]) => [role, sdkReference(parent)])),
  }) };
}

async function evidenceOf(tx: SqlExecutor, contract: GraphContract, assertions: readonly StoredAssertion[]): Promise<PluginEvidence | undefined> {
  if (assertions.every(assertion => assertion.evidence.length === 0)) return undefined;
  const links = await withSpan('graph.producer-facts.evidence', {}, async () => await tx.query<{ id: number; kind: string; discriminator: string }>(
    `SELECT target.id,k.name AS kind,e.discriminator FROM edge e JOIN entity ek ON ek.id=e.entity_id
     JOIN node origin ON origin.id=e.from_node JOIN node target ON target.id=e.to_node JOIN entity k ON k.id=target.entity_id
     WHERE ek.name='system.assertion-evidence' AND origin.uid=ANY($1::uuid[]) ORDER BY origin.uid,e.discriminator,e.uid LIMIT 1`, [assertions.map(assertion => assertion.id)]));
  const link = links.rows[0];
  if (link === undefined) return undefined;
  const target = await referenceOf(tx, contract, link.kind, Number(link.id));
  const { locator } = JSON.parse(link.discriminator) as { locator: Record<string, unknown> };
  return { target: sdkReference(target), ...(typeof locator['path'] === 'string' ? { path: locator['path'] } : {}),
    ...(typeof locator['commit'] === 'string' ? { commit: locator['commit'] } : {}),
    ...(typeof locator.digest === 'string' ? { digest: locator.digest } : {}),
    ...(typeof locator['lineStart'] === 'number' ? { lineStart: locator['lineStart'] } : {}),
    ...(typeof locator['lineEnd'] === 'number' ? { lineEnd: locator['lineEnd'] } : {}) };
}

/** The argument is the host-issued source uid, never a producer display name. */
export async function producerFacts(owner: DatabaseOwner, contract: GraphContract, sourceUid: string, kinds: readonly string[], edgeKinds: readonly string[]): Promise<{ vertices: PluginVertexResult[]; edges: PluginEdgeResult[] }> {
  return await withSpan('graph.producer-facts', { sourceUid }, async () => await owner.transaction(SQL_TRANSACTION_KINDS.snapshot, async tx => {
    const now = new Date((await tx.query<{ now: string | Date }>('SELECT transaction_timestamp() AS now')).rows[0]!.now).toISOString();
    const selector = { validAt: now, recordedAt: now, contexts: [1] };
    const vertices: PluginVertexResult[] = [];
    const edges: PluginEdgeResult[] = [];
    for (const sort of ['vertex', 'edge'] as const) for (const name of sort === 'vertex' ? kinds : edgeKinds) {
      const kind = contract[sort].find(declaration => declaration.name === name);
      if (kind === undefined) throw new Error(`${import.meta.path}:39: unknown reconciliation ${sort} kind ${name}`);
      const identities = await tx.query<{ id: number; from_node?: number; to_node?: number; discriminator?: string }>(
        sort === 'vertex' ? 'SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name=$1 ORDER BY n.uid'
          : 'SELECT n.id,n.from_node,n.to_node,n.discriminator FROM edge n JOIN entity k ON k.id=n.entity_id WHERE k.name=$1 ORDER BY n.uid', [name]);
      const fields = kind.fields.filter(field => sort === 'edge' || !('key' in kind && kind.key.includes(field.name))).map(field => field.name);
      const assertions = (await loadAssertions(tx, sort, name, ['$exists', ...fields], identities.rows.map(row => Number(row.id)), { ...selector, sourceUids: [sourceUid] })).filter(assertion => assertion.source === sourceUid && assertion.language === null);
      const selected = new Set(assertions.filter(assertion => assertion.selected).map(assertion => assertion.id));
      for (const row of identities.rows) {
        const own = assertions.filter(assertion => assertion.subjectId === Number(row.id) && selected.has(assertion.id));
        if (!own.some(assertion => assertion.property === '$exists' && assertion.value === true)) continue;
        const values = Object.fromEntries(own.filter(assertion => assertion.property !== '$exists').map(assertion => [assertion.property, assertion.value]));
        const evidence = await evidenceOf(tx, contract, own);
        if (sort === 'vertex') {
          const ref = sdkReference(await referenceOf(tx, contract, name, Number(row.id), new Set(), selector));
          vertices.push({ kind: name, key: ref.key, ...(ref.keyEdges === undefined ? {} : { keyEdges: ref.keyEdges }), values, ...(evidence === undefined ? {} : { evidence }) });
        } else {
          const ends = (await tx.query<{ id: number; kind: string }>('SELECT n.id,k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.id=ANY($1::bigint[])', [[row.from_node!, row.to_node!]])).rows;
          const fromKind = ends.find(end => Number(end.id) === Number(row.from_node))?.kind;
          const toKind = ends.find(end => Number(end.id) === Number(row.to_node))?.kind;
          if (fromKind === undefined || toKind === undefined) throw new Error(`${import.meta.path}:61: reconciliation edge has a missing endpoint`);
          edges.push({ kind: name, from: sdkReference(await referenceOf(tx, contract, fromKind, Number(row.from_node), new Set(), selector)), to: sdkReference(await referenceOf(tx, contract, toKind, Number(row.to_node), new Set(), selector)),
            ...(row.discriminator === '' ? {} : { discriminator: row.discriminator }), values, ...(evidence === undefined ? {} : { evidence }) });
        }
      }
    }
    return { vertices, edges };
  }));
}
