/** Durable interactive requests use a closed handler registry and the fill operation fence. */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { createPgBossQueue } from '../adapters/pg-boss-queue.js';
import { MANUAL_GRAPH_QUEUE } from '../adapters/queue-definition.js';
import { createOperationHost, resolveOperationScope, operationReceipt, canonicalOperationRequest, type OperationRequest } from './operation-host.js';
import { withAssertionContract } from './system-contract.js';
import { readPublishedManifest } from './manifest-publication.js';
import { putEntityAssertion, putProblemTaskAssertion, putEdgeAssertion, retractAssertion, writeContractOf, WriteRefusal, type WriteSource, type WriteAnswer } from './graph-writes.js';
import type { OuterTransaction } from '../history-types.js';
import { newUid } from './uid.js';
import { publishGraphDrafts } from './write.js';
import { canonicalJson } from './write.js';
import { canonicalJsonDigest } from '../model/canonical.js';
import { authoredEntity } from './authored.js';
import { authoredImportTarget, type AuthoredImportIdentity } from '../adapters/authored-import.js';
import { withSpan } from '../obs/trace.js';
import {resolveDuplicate,unmerge,type MergeInput,type UnmergeInput} from './merges.js';
import { resolveDispute, type ResolveDisputeInput } from './disputes.js';
import { MERGE_ACTION, activateGraphProducer, producerIdentityOf, requireProducerAction, type ProducerBinding } from './producer-binding.js';

export type ManualRequest = { readonly contractVersion?: string; readonly preconditions?: readonly { readonly uid: string; readonly recordedSequence: string }[] } & (
  | { readonly kind: 'authored-import'; readonly input: { readonly identity: AuthoredImportIdentity; readonly words: string; readonly entityKind: string; readonly values: Readonly<Record<string, unknown>>; readonly prefix: string } }
  | { readonly kind: 'put-entity'; readonly input: Parameters<typeof putEntityAssertion>[2] }
  | { readonly kind: 'put-edge'; readonly input: Parameters<typeof putEdgeAssertion>[2] }
  | { readonly kind: 'problem-task'; readonly input: Parameters<typeof putProblemTaskAssertion>[2] }
  | { readonly kind: 'retract'; readonly input: Parameters<typeof retractAssertion>[2] }
  | { readonly kind: 'merge-duplicates'; readonly input: MergeInput }
  | { readonly kind: 'unmerge'; readonly input: UnmergeInput }
  | { readonly kind: 'resolve-dispute'; readonly input: ResolveDisputeInput });
interface AdmittedRequest { readonly source: WriteSource; readonly operation: ManualRequest; readonly identity: string }
const QUEUE = MANUAL_GRAPH_QUEUE.name;
const HOST_GRANTS = new WeakMap<DatabaseOwner, Map<string, ProducerBinding>>();

async function dispatch(tx: OuterTransaction, data: AdmittedRequest, resolver?: ProducerBinding): Promise<WriteAnswer> {
  return await withSpan('graph.manual.dispatch', {}, async () => {
    switch (data.operation.kind) {
      case 'merge-duplicates': case 'unmerge': {
        if(!resolver)throw new WriteRefusal('SOURCE_FORBIDDEN missing merge grant');
        const manifest=await readPublishedManifest(tx);if(!manifest)throw new WriteRefusal('the graph holds no published manifest');
        const contract=withAssertionContract(writeContractOf(manifest));
        const result=data.operation.kind==='merge-duplicates'?await resolveDuplicate(tx,contract,resolver,data.operation.input):await unmerge(tx,contract,resolver,data.operation.input);
        return {...result,written:1};
      }
      case 'resolve-dispute': {
        if (!resolver) throw new WriteRefusal('SOURCE_FORBIDDEN missing authenticated resolver grant');
        const manifest = await readPublishedManifest(tx);
        if (!manifest) throw new WriteRefusal('the graph holds no published manifest');
        const uid = await resolveDispute(tx, withAssertionContract(writeContractOf(manifest)), resolver, data.operation.input);
        return { kind: 'system.dispute-resolution', uid, written: 1 };
      }
      case 'authored-import': {
        const manifest = await readPublishedManifest(tx);
        if (manifest === undefined) throw new WriteRefusal('the graph holds no published manifest');
        const input = data.operation.input;
        const uid = await authoredImportTarget(tx, input.identity.path);
        const current = uid === undefined ? undefined : await authoredEntity(tx, manifest, input.prefix, undefined, 'read', input.entityKind, { uid });
        const unchanged = current?.entity !== undefined && Object.entries(input.values).every(([field, value]) => canonicalJson(current.entity!.values[field] ?? null) === canonicalJson(value));
        const result = unchanged ? current! : await authoredEntity(tx, manifest, input.prefix, undefined, uid === undefined ? 'create' : 'edit', input.entityKind, { values: input.values, ...(uid === undefined ? {} : { uid }) });
        const contract = withAssertionContract(writeContractOf(manifest));
        const source = producerIdentityOf(resolver!);
        const product = (await tx.query<{ uid: string }>("SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.product'")).rows[0];
        if (product === undefined) throw new WriteRefusal('installed import source or product identity is missing');
        const markerUid = newUid();
        const words = JSON.parse(input.words) as { sha256: string };
        const ref = { kind: 'system.authored-import', uid: markerUid, key: {} };
        await publishGraphDrafts(tx, contract, { vertices: [{ ...ref, values: { source_path: input.identity.path, content_digest: words.sha256 }, producer: data.source.producer, producerVersion: data.source.version ?? '1' }], removals: [], edges: [
          { kind: 'system.authored-import-target', from: ref, to: { kind: input.entityKind, uid: result.entity!.uid, key: {} }, producer: data.source.producer, producerVersion: data.source.version ?? '1' },
          { kind: 'system.authored-import-source', from: ref, to: { kind: source.kind, uid: source.sourceUid, key: {} }, producer: data.source.producer, producerVersion: data.source.version ?? '1' },
          { kind: 'system.authored-import-product', from: ref, to: { kind: 'system.product', uid: product.uid, key: {} }, producer: data.source.producer, producerVersion: data.source.version ?? '1' },
        ] });
        return { kind: input.entityKind, uid: result.entity!.uid, written: 1, imported: { identity: input.identity, words: input.words } };
      }
      case 'problem-task': return await putProblemTaskAssertion(tx, data.source, data.operation.input);
      case 'put-entity': return await putEntityAssertion(tx, data.source, data.operation.input);
      case 'put-edge': return await putEdgeAssertion(tx, data.source, data.operation.input);
      case 'retract': return await retractAssertion(tx, data.source, data.operation.input);
    }
  });
}

function operationRequest(operation: ManualRequest): OperationRequest {
  return { key: 'request', request: operation, preconditions: operation.preconditions, completion: { output: {}, enqueue: [] } };
}

async function admit(owner: DatabaseOwner, data: AdmittedRequest) {
  const hostBinding = HOST_GRANTS.get(owner)?.get(data.identity);
  if (!hostBinding) throw new WriteRefusal('SOURCE_FORBIDDEN a retained host source grant is required');
  return await withSpan('graph.manual.admit', {}, async () => await owner.transaction('write', async tx => {
    const manifest = await readPublishedManifest(tx);
    if (!manifest) throw new WriteRefusal('the graph holds no published manifest');
    const contract = withAssertionContract(writeContractOf(manifest));
    const principal = producerIdentityOf(hostBinding);
    requireProducerAction(hostBinding, data.operation.kind === 'merge-duplicates' || data.operation.kind === 'unmerge' ? MERGE_ACTION : data.operation.kind === 'resolve-dispute' ? 'resolve' : data.operation.kind === 'retract' ? 'retract-own' : 'assert');
    if (data.operation.kind === 'resolve-dispute' && principal.kind !== 'person') throw new WriteRefusal('SOURCE_FORBIDDEN resolution requires a retained person');
    const binding = await activateGraphProducer(tx, contract, hostBinding);
    const scope = await resolveOperationScope(tx, contract, binding, { runId: data.identity, unitId: data.identity, generation: 0 });
    const receipt = await operationReceipt(tx, contract, scope.unitUid, 'request');
    if (receipt && receipt.canonicalRequest !== canonicalOperationRequest(operationRequest(data.operation))) throw new WriteRefusal('IDEMPOTENCY_CONFLICT: the authenticated request identity already names a different operation', undefined, 409);
    if (!receipt && data.operation.contractVersion !== undefined && data.operation.contractVersion !== binding.contractVersion) throw new WriteRefusal('CONTRACT_VERSION_MISMATCH: the graph declaration revision changed', undefined, 409);
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    return { contract, capability: binding, ...scope, receipt, resolver: hostBinding };
  }));
}

/**
 * Source and request identity come from the authenticated host transport, never the mutation payload.
 * An identity belongs to its authenticated producer and survives execution-session changes.
 * A request another dispatcher currently holds returns 409: callers retry the same identity, never assume success.
 */
export async function executeManualOperation(owner: DatabaseOwner, source: WriteSource, operation: ManualRequest, hostBinding: ProducerBinding): Promise<WriteAnswer> {
  return await withSpan('graph.manual-operation', { 'madarch.source': source.producer }, async () => {
    if (!source.operationId) throw new WriteRefusal('an authenticated operation request identity is required');
    const principal = producerIdentityOf(hostBinding);
    requireProducerAction(hostBinding, operation.kind === 'merge-duplicates' || operation.kind === 'unmerge' ? MERGE_ACTION : operation.kind === 'resolve-dispute' ? 'resolve' : operation.kind === 'retract' ? 'retract-own' : 'assert');
    if (operation.kind === 'resolve-dispute' && principal.kind !== 'person') throw new WriteRefusal('SOURCE_FORBIDDEN resolution requires a retained person');
    source = { ...source, producer: principal.producer, version: principal.version };
    const identity = canonicalJsonDigest({ sourceUid: principal.sourceUid, operationId: source.operationId });
    const grants = HOST_GRANTS.get(owner) ?? new Map<string, ProducerBinding>();
    grants.set(identity, hostBinding);
    HOST_GRANTS.set(owner, grants);
    const own = await admit(owner, { source, operation, identity });
    // Every manual handler returns a WriteAnswer; only void operations omit the result.
    if (own.receipt) return JSON.parse(own.receipt.result!) as WriteAnswer;
    const queue = await createPgBossQueue({ owner, supervise: false });
    try {
      await queue.declare(MANUAL_GRAPH_QUEUE);
      const queued = await queue.enqueue<AdmittedRequest>({ queue: QUEUE, singletonKey: identity, data: { source, operation, identity } });
      if (!queued.created) throw new WriteRefusal('the operation is queued or being processed; retry with the same authenticated request identity', undefined, 409);
      let ownAnswer: WriteAnswer | undefined;
      for (;;) {
        const jobs = await queue.claim<AdmittedRequest>({ queue: QUEUE, limit: 32 });
        if (jobs.length === 0) break;
        for (const job of jobs) {
          const data = job.data;
          try {
            const admitted = await admit(owner, data);
            const resolver = admitted.resolver;
            const host = createOperationHost({ owner, queue, job, ...admitted });
            const actor = producerIdentityOf(resolver);
            const authenticated = { ...data, source: { ...data.source, producer: actor.producer, version: actor.version } };
            const answer = await host.execute(operationRequest(data.operation), async tx => await dispatch(tx, authenticated, resolver));
            if (job.id === queued.id) ownAnswer = answer;
          } catch (error) {
            await queue.fail(QUEUE, job, error instanceof Error ? error.message : String(error));
            if (job.id === queued.id) throw error;
          }
        }
        if (ownAnswer !== undefined) return ownAnswer;
      }
      throw new WriteRefusal('the operation is queued or being processed; retry with the same authenticated request identity', undefined, 409);
    } finally { await queue.stop(); }
  });
}
