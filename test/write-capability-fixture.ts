/** Explicit trusted identities for fixture writes (0039 items 25–26). */
import type { SqlExecutor } from '../src/sql-driver.js';
import type { GraphContract } from '../src/graph/contract.js';
import { bindWriteCapability, bootstrapWriteIdentity, activateBoundIdentities, type WriteCapability } from '../src/graph/write.js';
import { startupBinding } from '../src/graph/manifest-publication.js';

export const TEST_SOURCE_UID = '019a0000-0000-7000-8000-000000000002';

export async function bindTestWriteCapability(tx: SqlExecutor, contract: GraphContract, sourceUid = TEST_SOURCE_UID, context = 1): Promise<WriteCapability> {
  const installed = await startupBinding(tx, contract, 'fixture-host');
  await bootstrapWriteIdentity(tx, 'plugin', sourceUid, installed.binding.productUid, context);
  const binding: WriteCapability = { ...installed.binding, sourceUid, principalUid: sourceUid, context };
  bindWriteCapability(tx, binding);
  await activateBoundIdentities(tx, installed.contract);
  return binding;
}
