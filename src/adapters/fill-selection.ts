/**
 * The catalogue's fill selection, in the store's mechanism tables (madarch-stm0.6, decision 0035's fill design of
 * 2026-11-10): which entities the person means to fill next, and with which agent and token cap. It is state of the
 * machinery, never a fact of the graph and never a file of the product's repository, so it lives in the store beside
 * the run's tables — in tables of this module's own schema, so the graph's own schema (one-graph.ts) is left alone.
 *
 * The selection is a list of kinds the product's manifest declares, exactly as the catalogue shows them; the engine
 * reads no entity of its own and stores none it was not given.
 */
import { byCodePoint } from '../model/order.js';
import type { DatabaseOwner } from './database-owner.js';
import { requireSchema } from './store-readiness.js';

/** What one product's catalogue selection holds: the kinds checked, and the choices the panel saved with them. */
export interface FillSelection {
  /** The kinds checked, in code point order. */
  readonly selected: readonly string[];
  /** The agent the panel names for the run, or null for none (only the plugins' own work then runs). */
  readonly agent: string | null;
  /** The most tokens one run may spend, or null for no cap the person set. */
  readonly tokenCap: number | null;
  /** When the selection was last written, in ISO form; empty when it never was. */
  readonly savedAt: string;
}


/** Checks preparation without changing a schema. */
export async function createFillSelectionSchema(owner: Pick<DatabaseOwner, 'transaction'>): Promise<void> {
  await requireSchema(owner, 'fill-selection');
}

/** One product's selection as the store holds it; a product whose selection was never written reads as none. */
export async function readFillSelection(owner: DatabaseOwner, product: string): Promise<FillSelection> {
  await createFillSelectionSchema(owner);
  return await owner.transaction('snapshot', async (tx) => {
    const rows = await tx.query<{ kind: string }>('SELECT kind FROM fill_selection WHERE product = $1 AND selected ORDER BY kind', [product]);
    const settings = await tx.query<{ agent: string | null; token_cap: number | null; updated_at: string }>(
      'SELECT agent, token_cap, updated_at::text AS updated_at FROM fill_selection_settings WHERE product = $1',
      [product],
    );
    const held = settings.rows[0];
    return {
      selected: rows.rows.map((row) => row.kind),
      agent: held?.agent ?? null,
      tokenCap: held?.token_cap ?? null,
      savedAt: held?.updated_at ?? '',
    };
  });
}

/**
 * Writes one product's selection: the kinds checked replace what stood (a kind no longer selected loses its row), and the
 * agent and the cap are written with them. The write is one transaction, so a reader never sees half a selection.
 */
export async function writeFillSelection(owner: DatabaseOwner, product: string, selection: {
  readonly selected: readonly string[];
  readonly agent: string | null;
  readonly tokenCap: number | null;
}): Promise<FillSelection> {
  await createFillSelectionSchema(owner);
  const selected = [...new Set(selection.selected)].sort(byCodePoint);
  return await owner.transaction('write', async (tx) => {
    await tx.query('DELETE FROM fill_selection WHERE product = $1', [product]);
    for (const kind of selected) {
      await tx.query('INSERT INTO fill_selection (product, kind, selected) VALUES ($1, $2, true) ON CONFLICT (product, kind) DO UPDATE SET selected = true, updated_at = now()', [product, kind]);
    }
    const saved = await tx.query<{ updated_at: string }>(
      `INSERT INTO fill_selection_settings (product, agent, token_cap, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (product) DO UPDATE SET agent = EXCLUDED.agent, token_cap = EXCLUDED.token_cap, updated_at = now()
       RETURNING updated_at::text AS updated_at`,
      [product, selection.agent, selection.tokenCap],
    );
    return { selected, agent: selection.agent, tokenCap: selection.tokenCap, savedAt: saved.rows[0]?.updated_at ?? '' };
  });
}
