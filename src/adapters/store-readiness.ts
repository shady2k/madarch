/** Connect-only checks. Schema preparation belongs to the store-owning process. */
import { createDatabaseOwner, StoreNotPreparedError, type DatabaseOwner } from './database-owner.js';

/** Attach only when operational modules are prepared; no schema is created and SQL failures are not hidden. */
export async function openPreparedDatabaseOwner(store: string, modules: readonly string[]): Promise<DatabaseOwner | null> {
  let owner: DatabaseOwner;
  try { owner = await createDatabaseOwner({ store, connectOnly: true }); }
  catch (error) {
    if (error instanceof StoreNotPreparedError) return null;
    throw error;
  }
  try {
    for (const name of modules) {
      if (!await hasSchema(owner, name)) {
        await owner.close();
        return null;
      }
    }
    return owner;
  } catch (error) {
    await owner.close().catch(() => undefined);
    throw error;
  }
}

/** Whether the owner has published a module's preparation stamp; database failures still throw. */
export async function hasSchema(owner: Pick<DatabaseOwner, 'transaction'>, name: string, stamp?: string): Promise<boolean> {
  return await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ stamp: string }>('SELECT stamp FROM madarch_meta.schema_stamp WHERE name = $1', [name]);
    return found.rows[0] !== undefined && (stamp === undefined || found.rows[0].stamp === stamp);
  }).catch((error: unknown) => {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === '42P01') return false;
    throw error;
  });
}

export async function requireSchema(owner: Pick<DatabaseOwner, 'transaction'> & Partial<Pick<DatabaseOwner, 'location'>>, name: string, stamp?: string): Promise<void> {
  const ready = await hasSchema(owner, name, stamp);
  if (!ready) throw new Error(`src/adapters/store-readiness.ts:13: store "${owner.location ?? 'unknown store'}" has no prepared ${name} schema of this build; run madarch start for this store before connecting`);
}
