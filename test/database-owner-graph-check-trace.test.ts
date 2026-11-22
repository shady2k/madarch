import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPostgresDatabaseOwner } from '../src/adapters/database-owner.js';
import { CLUSTER_PORT } from '../src/adapters/postgres-cluster.js';
import { openTrace, closeTrace, runInTrace } from '../src/obs/trace.js';
import { readTraceSpans } from '../src/obs/trace-report.js';

test('graph check diagnostics distinguish deferred COMMIT, explicit constraints and rollback on one connection', async () => {
  const old = process.env['MADARCH_TRACE_GRAPH_CHECKS'];
  process.env['MADARCH_TRACE_GRAPH_CHECKS'] = '1';
  const store = mkdtempSync(join(tmpdir(), 'graph-check-trace-'));
  const owner = await createPostgresDatabaseOwner({ host: process.env['MADARCH_TEST_PG_SOCKET']!, port: CLUSTER_PORT, user: 'postgres', database: 'postgres', max: 1 });
  const run = openTrace({ store, runId: 'graph-checks' });
  try {
    // Session-local fixture functions do not replace the product's graph functions in any schema.
    await owner.exec(`CREATE TEMP TABLE graph_check_probe (value integer);
      CREATE FUNCTION pg_temp.graph_checks_pass() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.005); END $$;
      CREATE FUNCTION pg_temp.graph_relations_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_temp.graph_checks_pass(); RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER graph_relations AFTER INSERT ON graph_check_probe
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.graph_relations_check()`);
    await runInTrace(run, async () => {
      await owner.transaction('write', async tx => { await tx.query('INSERT INTO graph_check_probe VALUES (1), (2)'); });
      await owner.transaction('write', async tx => {
        await tx.query('INSERT INTO graph_check_probe VALUES (3)');
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      });
      await expect(owner.transaction('write', async tx => {
        await tx.query('INSERT INTO graph_check_probe VALUES (4)');
        throw new Error('rollback probe');
      })).rejects.toThrow('rollback probe');
      await owner.transaction('write', async tx => { await tx.query('INSERT INTO graph_check_probe VALUES (5)'); });
      delete process.env['MADARCH_TRACE_GRAPH_CHECKS'];
      await owner.transaction('write', async tx => { await tx.query('SELECT 1'); });
    });
    closeTrace(run);
    const spans = readTraceSpans(run.file);
    const commits = spans.filter(span => span.name === 'db.commit');
    expect(commits).toHaveLength(4);
    expect(commits[3]!.attributes['db.graph_relations_check.calls']).toBeUndefined();
    const measuredCommits = commits.slice(0, 3);
    expect(measuredCommits.map(span => span.attributes['db.graph_relations_check.calls'])).toEqual([2, 0, 1]);
    expect(measuredCommits.map(span => span.attributes['db.graph_checks_pass.calls'])).toEqual([2, 0, 1]);
    const constraints = spans.find(span => span.name === 'db.constraints')!;
    expect(constraints.attributes['db.graph_relations_check.calls']).toBe(1);
    expect(constraints.attributes['db.graph_checks_pass.calls']).toBe(1);
    for (const span of [commits[0]!, constraints, commits[2]!]) {
      expect(span.attributes['db.graph_checks_pass.total_ms']).toBeGreaterThan(0);
      expect(span.attributes['db.graph_relations_check.total_ms']).toBeGreaterThanOrEqual(span.attributes['db.graph_checks_pass.total_ms'] as number);
      expect(span.attributes['db.graph_relations_check.self_ms']).toBeGreaterThanOrEqual(0);
    }
    const transactions = spans.filter(span => span.name === 'db.transaction' && span.attributes['db.diagnostic.statements'] !== undefined);
    expect(transactions.map(span => span.attributes['db.statements'])).toEqual([1, 2, 1]);
    expect(transactions.map(span => span.attributes['db.diagnostic.statements'])).toEqual([5, 7, 5]);
    expect(await owner.run(async tx => (await tx.query('SELECT * FROM graph_check_probe')).rows)).toHaveLength(4);
    process.env['MADARCH_TRACE_GRAPH_CHECKS'] = '1';
    let published = false;
    // Missing post-COMMIT evidence cannot turn kept data into an apparent rollback or suppress publication.
    await owner.transaction('write', async tx => {
      await tx.query(`CREATE OR REPLACE FUNCTION pg_temp.madarch_graph_check_trace() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
      await tx.query('INSERT INTO graph_check_probe VALUES (6)');
      tx.afterCommit!(() => { published = true; });
    });
    expect(published).toBe(true);
    expect(await owner.run(async tx => (await tx.query('SELECT * FROM graph_check_probe')).rows)).toHaveLength(5);
  } finally {
    closeTrace(run);
    await owner.close();
    if (old === undefined) delete process.env['MADARCH_TRACE_GRAPH_CHECKS']; else process.env['MADARCH_TRACE_GRAPH_CHECKS'] = old;
    rmSync(store, { recursive: true, force: true });
  }
});
