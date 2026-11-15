/** A producer's current opinions for SDK reconciliation (0039 item 18). */
import { SQL_TRANSACTION_KINDS } from '../sql-driver.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { GraphContract } from './contract.js';
import type { PluginVertexResult, PluginEdgeResult, PluginEvidence } from '../plugin/protocol.js';
import { withSpan } from '../obs/trace.js';
import type { SqlExecutor } from '../sql-driver.js';

async function readRows<Row extends Record<string, unknown>>(tx: SqlExecutor, sql: string, values: readonly unknown[]): Promise<{ rows: Row[] }> {
  async function read(): Promise<{ rows: Row[] }> { return await tx.query<Row>(sql, values); }
  return await withSpan('graph.producer-facts.query', {}, read);
}

function evidenceOf(value: unknown): PluginEvidence | undefined {
  if (!Array.isArray(value)) return undefined;
  const entry = value.find((one: Record<string, unknown>) => one['type'] === 'file');
  if (entry === undefined) return undefined;
  return {
    ...(typeof entry.repository === 'string' ? { repository: entry.repository } : {}),
    ...(typeof entry.commit_or_digest === 'string' ? { commitOrDigest: entry.commit_or_digest } : {}),
    ...(typeof entry.path === 'string' ? { path: entry.path } : {}),
    ...(typeof entry.line_start === 'number' ? { lineStart: entry.line_start } : {}),
    ...(typeof entry.line_end === 'number' ? { lineEnd: entry.line_end } : {}),
  };
}

/** Select one producer only; never reconcile against another source's or closed historical opinion. */
export async function producerFacts(owner: DatabaseOwner, contract: GraphContract, producer: string, kinds: readonly string[], edgeKinds: readonly string[]): Promise<{ vertices: PluginVertexResult[]; edges: PluginEdgeResult[] }> {
  return await withSpan('graph.producer-facts', { producer }, async () => await owner.transaction(SQL_TRANSACTION_KINDS.snapshot, async (tx) => await withSpan('graph.producer-facts.read', {}, async () => {
    const vertices: PluginVertexResult[] = [];
    const edges: PluginEdgeResult[] = [];
    for (const name of kinds) {
      const kind = contract.vertex.find((held) => held.name === name);
      if (kind === undefined) throw new Error(`${import.meta.path}:29: unknown reconciliation kind ${name}`);
      const rows = await readRows<{ key: PluginVertexResult['key']; opinion: Record<string, unknown> }>(tx,
        `SELECT DISTINCT ON (n.id) n.key, to_jsonb(o) AS opinion FROM ${kind.table} o JOIN node n ON n.id = o.node_id
         WHERE o.state = 'open' AND o.context_id = 1 AND o.lang IS NULL AND split_part(o.said_by, '@', 1) = $1 AND NOT n.removed
         ORDER BY n.id, o.id DESC`, [producer]);
      for (const row of rows.rows) {
        const values = Object.fromEntries(kind.fields.filter((field) => !kind.key.includes(field.name) && row.opinion[field.name] != null).map((field) => [field.name, row.opinion[field.name]]));
        const evidence = evidenceOf(row.opinion['evidence']);
        vertices.push({ kind: name, key: row.key, values, ...(evidence === undefined ? {} : { evidence }) });
      }
    }
    for (const name of edgeKinds) {
      const kind = contract.edge.find((held) => held.name === name);
      if (kind?.table === undefined) throw new Error(`${import.meta.path}:41: unknown reconciliation edge ${name}`);
      const rows = await readRows<{ from_kind: string; to_kind: string; from_key: PluginVertexResult['key']; to_key: PluginVertexResult['key']; discriminator: string; opinion: Record<string, unknown> }>(tx,
        `SELECT DISTINCT ON (e.id) fk.name AS from_kind, tk.name AS to_kind, nf.key AS from_key, nt.key AS to_key, e.discriminator, to_jsonb(o) AS opinion
         FROM ${kind.table} o JOIN edge e ON e.id = o.edge_id JOIN node nf ON nf.id = e.from_node JOIN entity fk ON fk.id = nf.entity_id
         JOIN node nt ON nt.id = e.to_node JOIN entity tk ON tk.id = nt.entity_id
         WHERE o.state = 'open' AND o.context_id = 1 AND o.lang IS NULL AND split_part(o.said_by, '@', 1) = $1 AND NOT nf.removed AND NOT nt.removed
         ORDER BY e.id, o.id DESC`, [producer]);
      for (const row of rows.rows) {
        const values = Object.fromEntries(kind.fields.filter((field) => row.opinion[field.name] != null).map((field) => [field.name, row.opinion[field.name]]));
        const evidence = evidenceOf(row.opinion['evidence']);
        edges.push({ kind: name, from: { kind: row.from_kind, key: row.from_key }, to: { kind: row.to_kind, key: row.to_key }, ...(row.discriminator === '' ? {} : { discriminator: row.discriminator }), values, ...(evidence === undefined ? {} : { evidence }) });
      }
    }
    return { vertices, edges };
  })));
}
