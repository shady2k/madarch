import type { DatabaseOwner } from '../src/adapters/database-owner.js';

/** Measure only the call, in one transaction; keep the executor's writer authority intact. */
export async function publicationCounts<T>(owner: DatabaseOwner, work: (measured: DatabaseOwner) => Promise<T>) {
  return await owner.transaction('write', async tx => {
    const stats = async () => (await tx.query<{ reads: number; writes: number }>(`SELECT
      coalesce(sum(seq_tup_read + idx_tup_fetch),0)::bigint AS reads,
      coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del),0)::bigint AS writes
      FROM pg_stat_xact_user_tables WHERE relname IN ('entity','context','node','edge','assertion','assertion_vertex_subject','assertion_edge_subject') OR left(relname,2)='a_'`)).rows[0]!;
    const sizes = async () => (await tx.query<{ nodes: number; edges: number; assertions: number }>(`SELECT
      (SELECT count(*) FROM node)::bigint AS nodes,
      (SELECT count(*) FROM edge)::bigint AS edges,
      (SELECT count(*) FROM assertion)::bigint AS assertions`)).rows[0]!;
    const before = await sizes();
    const start = await stats();
    const query = tx.query;
    const statements: string[] = [];
    tx.query = async (sql, values) => { statements.push(sql); return await query.call(tx, sql, values) as never; };
    let result: T;
    try {
      const measured: DatabaseOwner = {
        location: owner.location, ready: owner.ready, hasVector: owner.hasVector,
        allowConcurrentSnapshots: owner.allowConcurrentSnapshots,
        transaction: async (_kind, body) => await body(tx),
        run: async body => await body(tx), exec: owner.exec.bind(owner), close: owner.close.bind(owner),
      };
      result = await work(measured);
    } finally { tx.query = query; }
    const end = await stats();
    const after = await sizes();
    return { result, before, after, statements: statements.length,
      constraints: statements.filter(sql => sql.startsWith('SET CONSTRAINTS')).length,
      reads: end.reads - start.reads, writes: end.writes - start.writes };
  });
}
