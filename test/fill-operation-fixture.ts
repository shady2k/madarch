/** Trusted immediate operations for scheduler fixtures; no private drafts or fact replay. */
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { UnitOperations } from '../src/fill/orchestrator.js';
import type { StageContext } from '../src/fill/stage.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { changeOperationRunState, createOperationHost, resolveOperationScope } from '../src/graph/operation-host.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';

export function fixtureOperations(owner: DatabaseOwner): UnitOperations {
  const scopes = new Map<string, { binding: Awaited<ReturnType<typeof startupBinding>>['binding']; contract: Awaited<ReturnType<typeof startupBinding>>['contract']; runUid: string }>();
  let installed: Awaited<ReturnType<typeof startupBinding>> | undefined;
  return {
    open: async ({ unit, plan, job, queue }) => {
      const opened = await owner.transaction('write', async (tx) => {
        installed ??= await startupBinding(tx, EMPTY_CONTRACT, 'scheduler-fixture');
        const { binding, contract } = installed;
        const scope = await resolveOperationScope(tx, contract, binding, { runId: unit.runId, unitId: unit.unitId, generation: unit.generation, scope: plan.stageUnitId });
        return { binding, contract, ...scope };
      });
      scopes.set(unit.runId, opened);
      return { sourceUid: opened.binding.sourceUid, unitUid: opened.unitUid, host: createOperationHost({ owner, queue, job, contract: opened.contract, capability: opened.binding, runUid: opened.runUid, unitUid: opened.unitUid }) };
    },
    setRunState: async (runId, state) => {
      const scope = scopes.get(runId);
      if (scope !== undefined) await owner.transaction('write', async (tx) => await changeOperationRunState(tx, scope.contract, scope.binding, scope.runUid, state));
    },
  };
}

/** State a real graph fact on the fixture unit through its fenced operation host. */
export async function writeFixtureFact(context: StageContext, evidence: string, value: unknown, key = 'fixture-fact'): Promise<void> {
  if (!context.executeOperation || !context.operationUnitUid || !context.operationSourceUid) throw new Error('fixture stage requires trusted immediate operations');
  const uid = context.operationUnitUid;
  const producer = context.operationSourceUid;
  await context.executeOperation(key, { evidence, value }, async (tx) => {
    await publishGraphDrafts(tx, withAssertionContract(EMPTY_CONTRACT), { vertices: [{ kind: 'system.unit', uid, key: {}, values: { scope: JSON.stringify({ evidence, value }) }, producer, producerVersion: 'fixture-v1' }], edges: [], removals: [] });
    return { accepted: true };
  });
}
