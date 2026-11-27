/** Explicit trusted identities for fixture writes (0039 items 25–26). */
import type { SqlExecutor } from '../src/sql-driver.js';
import type { GraphContract } from '../src/graph/contract.js';
import { bindWriteCapability, bootstrapWriteIdentity, writeAssertion, type WriteCapability } from '../src/graph/write.js';
import { MANIFEST_CAPABILITY } from '../src/graph/manifest-contract.js';
import { startupBinding } from '../src/graph/manifest-publication.js';

export const TEST_SOURCE_UID = '019a0000-0000-7000-8000-000000000002';

/**
 * The fixture host carries the manifest publication's capability: a case that states catalogue declarations states the
 * metadata only that source writes, and a case about any other source takes its own binding.
 */
export async function bindTestWriteCapability(tx: SqlExecutor, contract: GraphContract, sourceUid = TEST_SOURCE_UID, context = 1): Promise<WriteCapability> {
  const installed = await startupBinding(tx, contract, 'fixture-host');
  await bootstrapWriteIdentity(tx, 'plugin', sourceUid, installed.binding.productUid, context);
  const binding: WriteCapability = { ...installed.binding, capability: MANIFEST_CAPABILITY, sourceUid, principalUid: sourceUid, context };
  bindWriteCapability(tx, binding);
  const held=(await tx.query<{id:string;active:boolean}>(`SELECT id::text,graph_vertex_active(id,'plugin',$2::bigint) AS active FROM node WHERE uid=$1::uuid`,[sourceUid,context])).rows[0]!;
  if(!held.active)await writeAssertion(tx,installed.contract,{sort:'vertex',kind:'plugin',subjectId:held.id,property:'$exists',operation:'assert',value:true},context);
  return binding;
}
