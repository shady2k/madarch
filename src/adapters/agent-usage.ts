
/**
 * What one agent run spent, in the store's mechanism tables (madarch-stm0.4, decision 0035, item 22): the model, the
 * tokens in and out and the cost, per fill run, plugin run, kind and field, as the agent itself reported them
 * (`src/fill/agent-meter.ts` reads the ACP reports and hands the totals here). It is state of the machinery, never a
 * fact of the graph and never a file of the product's repository, so it lives in the store beside the run's tables — in
 * tables of this module's own schema, so the graph's own schema (`src/graph/one-graph.ts`) is left alone and its
 * revision does not move.
 *
 * A row is one plugin run's spend in one kind and one field on one model: the meter counts each report once (a cumulative
 * report less the one before it), so a row is a sum of what the agent said, never a guess. Money is kept per row in the
 * currency the agent reports, so two currencies are never added; a run stopped by a bound is a row like the rest, with
 * its stop kept.
 */
import { byCodePoint } from '../model/order.js';
import type { DatabaseOwner } from './database-owner.js';
import { requireSchema } from './store-readiness.js';

/** One amount the agent reported, in the unit it named: an ISO 4217 code, or a unit such as `credits`. */
export interface AgentUsageAmount {
  readonly amount: number;
  readonly currency: string;
}

/** One row of `agent_usage`: one plugin run's spend in one kind, one field and one model. */
export interface AgentUsageRecord {
  /** The fill run the spend belongs to (the trace's run id). */
  readonly run: string;
  /** The plugin run's unit id: one plugin, its kind and, when one was named, its vertex. */
  readonly unit: string;
  readonly plugin: string;
  readonly pluginVersion: string;
  readonly kind: string;
  /** The field the turn was asked to fill; `''` for the unit's work in the kind as a whole. */
  readonly field: string;
  /** The model the agent used, or null when it reported none. */
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** The cost the agent reported for this row, or null when it reported none. */
  readonly cost: AgentUsageAmount | null;
  /** How many prompt turns this row's work took. */
  readonly turns: number;
  /** Whether the agent reported any token or cost number at all: a row that reported none is not a zero spend. */
  readonly reported: boolean;
  /** The bound that ended this row's run, when one did. */
  readonly stopped: 'tokens' | 'cost' | null;
}

/** Requires the store owner's prepared usage tables without changing the schema. */
export async function createAgentUsageSchema(owner: Pick<DatabaseOwner, 'transaction'>): Promise<void> {
  await requireSchema(owner, 'agent-usage');
}

/** One row as the meter and the page state it, in code point order of its identity fields. */
function ordered(rows: readonly AgentUsageRecord[]): AgentUsageRecord[] {
  return [...rows].sort((left, right) => byCodePoint(left.run, right.run)
    || byCodePoint(left.unit, right.unit)
    || byCodePoint(left.kind, right.kind)
    || byCodePoint(left.field, right.field)
    || byCodePoint(left.model ?? '', right.model ?? ''));
}

/**
 * Writes the rows the meter holds: each row replaces the one standing under its identity, because the meter's row is
 * that unit's whole spend and not an increment. One transaction, so a reader never sees half a plugin run.
 */
export async function recordAgentUsage(owner: DatabaseOwner, rows: readonly AgentUsageRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await createAgentUsageSchema(owner);
  const orderedRows = ordered(rows);
  await owner.transaction('write', async (tx) => {
    for (const row of orderedRows) {
      await tx.query(
        `INSERT INTO agent_usage (run_id, unit, plugin, plugin_version, kind, field, model, input_tokens, output_tokens, total_tokens, cost_amount, cost_currency, turns, reported, stopped, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
         ON CONFLICT (run_id, unit, kind, field, model) DO UPDATE SET
           plugin = EXCLUDED.plugin,
           plugin_version = EXCLUDED.plugin_version,
           input_tokens = EXCLUDED.input_tokens,
           output_tokens = EXCLUDED.output_tokens,
           total_tokens = EXCLUDED.total_tokens,
           cost_amount = EXCLUDED.cost_amount,
           cost_currency = EXCLUDED.cost_currency,
           turns = EXCLUDED.turns,
           reported = EXCLUDED.reported,
           stopped = EXCLUDED.stopped,
           updated_at = now()`,
        [row.run, row.unit, row.plugin, row.pluginVersion, row.kind, row.field, row.model, row.inputTokens, row.outputTokens, row.totalTokens,
          row.cost === null ? null : row.cost.amount.toFixed(6), row.cost === null ? null : row.cost.currency, row.turns, row.reported, row.stopped],
      );
    }
  });
}

/** One row of a kind's usage as its page states it: the spend, and what the agent was. */
export interface KindUsageLine extends AgentUsageRecord {}

/** One run's spend in a kind: its rows and the numbers they make together. */
export interface KindUsageRun {
  readonly run: string;
  /** When the run's last row of this kind was written, in ISO form. */
  readonly at: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cost: readonly AgentUsageAmount[];
  /** The first bound that ended one of the run's rows in this kind, if one did. */
  readonly stopped: 'tokens' | 'cost' | null;
  readonly rows: readonly KindUsageLine[];
}

/** What a kind's page says about the agent's spend on it. */
export interface KindUsageView {
  readonly kind: string;
  /** The newest runs that spent on the kind, newest first, at most `KIND_USAGE_RUNS` of them. */
  readonly runs: readonly KindUsageRun[];
  /** Whether older runs spent on the kind too and are not listed. */
  readonly moreRuns: boolean;
  /** Every run's spend on the kind, this and the older runs together. */
  readonly total: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number; readonly cost: readonly AgentUsageAmount[]; readonly runs: number };
}

/** How many runs a kind's page lists; the total counts every run, and `moreRuns` says the list is shorter. */
export const KIND_USAGE_RUNS = 10;

/** Sums the amounts of one currency, in code point order of the currency. */
function amountsOf(rows: readonly { readonly amount: number; readonly currency: string }[]): AgentUsageAmount[] {
  const byCurrency = new Map<string, number>();
  for (const row of rows) byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.amount);
  return [...byCurrency.entries()].map(([currency, amount]) => ({ amount: Number(amount.toFixed(6)), currency })).sort((left, right) => byCodePoint(left.currency, right.currency));
}

/** One row's cost as the page lists it, or nothing when the agent reported none. */
function costOf(amount: string | null, currency: string | null): AgentUsageAmount | null {
  return amount === null || currency === null ? null : { amount: Number(amount), currency };
}

/** A kind's agent spend, as its page states it: every run counted in the total, the newest runs listed. */
export async function readKindUsage(owner: DatabaseOwner, kind: string): Promise<KindUsageView> {
  await createAgentUsageSchema(owner);
  return await owner.transaction('snapshot', async (tx) => {
    const totals = await tx.query<{ input: string; output: string; total: string; runs: string }>(
      'SELECT coalesce(sum(input_tokens), 0)::text AS input, coalesce(sum(output_tokens), 0)::text AS output, coalesce(sum(total_tokens), 0)::text AS total, count(DISTINCT run_id)::text AS runs FROM agent_usage WHERE kind = $1',
      [kind],
    );
    const byCurrency = await tx.query<{ currency: string; amount: string }>(
      'SELECT cost_currency AS currency, sum(cost_amount)::text AS amount FROM agent_usage WHERE kind = $1 AND cost_currency IS NOT NULL GROUP BY cost_currency',
      [kind],
    );
    const newest = await tx.query<{ run_id: string; at: string }>(
      `SELECT run_id, max(updated_at)::text AS at FROM agent_usage WHERE kind = $1 GROUP BY run_id ORDER BY max(updated_at) DESC, run_id DESC LIMIT ${String(KIND_USAGE_RUNS + 1)}`,
      [kind],
    );
    const runIds = newest.rows.slice(0, KIND_USAGE_RUNS).map((row) => row.run_id);
    const rows = runIds.length === 0 ? [] : (await tx.query<{
      run_id: string; unit: string; plugin: string; plugin_version: string; kind: string; field: string; model: string | null;
      input_tokens: string; output_tokens: string; total_tokens: string; cost_amount: string | null; cost_currency: string | null;
      turns: number; reported: boolean; stopped: 'tokens' | 'cost' | null; updated_at: string;
    }>(
      `SELECT run_id, unit, plugin, plugin_version, kind, field, model, input_tokens::text AS input_tokens, output_tokens::text AS output_tokens,
              total_tokens::text AS total_tokens, cost_amount::text AS cost_amount, cost_currency, turns, reported, stopped, updated_at::text AS updated_at
       FROM agent_usage WHERE kind = $1 AND run_id = ANY($2::text[])
       ORDER BY run_id, plugin, field, model NULLS FIRST, unit`,
      [kind, runIds],
    )).rows;
    const runs: KindUsageRun[] = newest.rows.slice(0, KIND_USAGE_RUNS).map((entry) => {
      const held = rows.filter((row) => row.run_id === entry.run_id);
      const lines: KindUsageLine[] = held.map((row) => ({
        run: row.run_id, unit: row.unit, plugin: row.plugin, pluginVersion: row.plugin_version, kind: row.kind, field: row.field,
        model: row.model, inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), totalTokens: Number(row.total_tokens),
        cost: costOf(row.cost_amount, row.cost_currency), turns: row.turns, reported: row.reported, stopped: row.stopped,
      }));
      return {
        run: entry.run_id,
        at: new Date(entry.at).toISOString(),
        inputTokens: lines.reduce((sum, line) => sum + line.inputTokens, 0),
        outputTokens: lines.reduce((sum, line) => sum + line.outputTokens, 0),
        totalTokens: lines.reduce((sum, line) => sum + line.totalTokens, 0),
        cost: amountsOf(lines.flatMap((line) => (line.cost === null ? [] : [line.cost]))),
        stopped: lines.find((line) => line.stopped !== null)?.stopped ?? null,
        rows: lines.sort((left, right) => byCodePoint(left.plugin, right.plugin) || byCodePoint(left.field, right.field) || byCodePoint(left.model ?? '', right.model ?? '') || byCodePoint(left.unit, right.unit)),
      };
    });
    return {
      kind,
      runs,
      moreRuns: newest.rows.length > KIND_USAGE_RUNS,
      total: {
        inputTokens: Number(totals.rows[0]?.input ?? '0'),
        outputTokens: Number(totals.rows[0]?.output ?? '0'),
        totalTokens: Number(totals.rows[0]?.total ?? '0'),
        cost: byCurrency.rows.map((row) => ({ amount: Number(row.amount), currency: row.currency })).sort((left, right) => byCodePoint(left.currency, right.currency)),
        runs: Number(totals.rows[0]?.runs ?? '0'),
      },
    };
  });
}
