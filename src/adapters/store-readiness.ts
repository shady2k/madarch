/** Connect-only checks. Schema preparation belongs to the store-owning process. */
import type { DatabaseOwner } from './database-owner.js';

export async function requireSchema(owner: Pick<DatabaseOwner, 'transaction'> & Partial<Pick<DatabaseOwner, 'location'>>, name: string, stamp?: string): Promise<void> {
  const ready = await owner.transaction('snapshot', async (tx) => {
    const exists = await tx.query<{ held: string | null }>("SELECT to_regclass('madarch_meta.schema_stamp')::text AS held");
    if (exists.rows[0]?.held == null) return false;
    const found = await tx.query<{ stamp: string }>('SELECT stamp FROM madarch_meta.schema_stamp WHERE name = $1', [name]);
    return found.rows[0] !== undefined && (stamp === undefined || found.rows[0].stamp === stamp);
  });
  if (!ready) throw new Error(`src/adapters/store-readiness.ts:13: store "${owner.location ?? 'unknown store'}" has no prepared ${name} schema of this build; run madarch start for this store before connecting`);
}
