/**
 * One template per graph contract (ALX-105 variant 4, ALX-119): a case whose
 * store declares a contract clones the run's template of that contract instead
 * of installing the schema again (the numbers are in /work/reports/ALX-119.md).
 */
import { expect, test } from 'bun:test';
import { Client } from 'pg';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { clusterEndpoint } from '../src/adapters/postgres-cluster.js';
import { assertionValueTableName, generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { createTestDatabaseOwner, TEST_SERVER_VARIABLE } from './test-database.js';

/** A contract no other file of the run declares, so its template is this case's own first preparation. */
function probeContract(): GraphContract {
  const suffix = randomBytes(4).toString('hex');
  return {
    vertex: [{
      name: `probe.node-${suffix}`,
      table: generatedTableName(`probe.node-${suffix}`, 'vertex'),
      key: ['name'],
      fields: [{ name: 'name', type: 'text' }],
      capability: 'fixture',
    }],
    edge: [],
    dictionary: [],
  };
}

/** The run server's socket folder: the preload names it before any test file loads. */
function runServerSocket(): string {
  const held = process.env[TEST_SERVER_VARIABLE]?.trim();
  if (held === undefined || held === '') throw new Error('test/test-database-contract-template.test.ts:1: the run server is not there: run the suite from the repository root');
  return held;
}

/** One statement on the run server's administrative database, in a connection of its own. */
async function runServerQuery(sql: string, values: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
  const client = new Client({ ...clusterEndpoint(runServerSocket()), user: 'postgres', database: 'postgres' });
  await client.connect();
  try {
    return (await client.query(sql, [...values])).rows as Record<string, unknown>[];
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The server's log file: `pg_ctl` points its output at `postgres.log` beside the cluster's data directory. */
async function serverLogFile(): Promise<string> {
  const rows = await runServerQuery('SHOW data_directory');
  return join(String(rows[0]?.['data_directory']), '..', 'postgres.log');
}

/** Every statement the server logged after `offset`, `log_statement = 'ddl'` naming one per DDL statement. */
function statementsSince(file: string, offset: number): string[] {
  return readFileSync(file, 'utf8').slice(offset).split('\n').filter((line) => line.includes('statement:'));
}

/** Whether the scheme's table is in the database the case opened. */
async function holdsTable(owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>, table: string): Promise<string | null> {
  return (await owner.run((tx) => tx.query<{ held: string | null }>('SELECT to_regclass($1)::text AS held', [table]))).rows[0]?.held ?? null;
}

test('a second database of one explicit contract clones the run template and creates no table', async () => {
  const contract = probeContract();
  const table = assertionValueTableName(contract.vertex[0]!.name, 'vertex', 'name');
  const log = await serverLogFile();
  const firstPhases: string[] = [];
  const first = await createTestDatabaseOwner({ graphContract: contract, timing: (phase) => firstPhases.push(phase) });
  try {
    expect(firstPhases).toContain('contract-template-preparation');
    expect(await holdsTable(first, table)).toBe(table);
  } finally { await first.close(); }
  // From here every DDL statement the server runs is logged: a preparation installs the schema with CREATE TABLE, a clone does not.
  const held = String((await runServerQuery('SHOW log_statement'))[0]?.['log_statement']);
  await runServerQuery("ALTER SYSTEM SET log_statement = 'ddl'");
  await runServerQuery('SELECT pg_reload_conf()');
  try {
    const offset = statSync(log).size;
    const secondPhases: string[] = [];
    const second = await createTestDatabaseOwner({ graphContract: contract, timing: (phase) => secondPhases.push(phase) });
    try {
      expect(secondPhases).toContain('database-clone');
      expect(secondPhases).toContain('contract-template-reused');
      expect(secondPhases).not.toContain('contract-template-preparation');
      expect(statementsSince(log, offset).filter((line) => line.includes('CREATE TABLE'))).toEqual([]);
      // The clone carries the schema the template installed: the case reads the table without a statement of its own.
      expect(await holdsTable(second, table)).toBe(table);
    } finally { await second.close(); }
  } finally {
    await runServerQuery(`ALTER SYSTEM SET log_statement = '${held}'`);
    await runServerQuery('SELECT pg_reload_conf()');
  }
}, 120_000);

