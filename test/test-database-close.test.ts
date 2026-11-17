/**
 * A case's database is dropped inside `close()` (ALX-186, C2-C5): the run has no
 * drop queue any more. `close()` does not resolve before PostgreSQL dropped the
 * database, a failed DROP rejects `close()` with the database and the server's
 * error, a second `close()` retries only the DROP, and a close that succeeded is
 * never repeated. When opening a case's database fails after the clone, the
 * database is dropped at once and the original error is thrown; a DROP that
 * fails there is its cause.
 */
import { expect, test } from 'bun:test';
import { Client } from 'pg';
import { clusterEndpoint } from '../src/adapters/postgres-cluster.js';
import { createTestDatabaseOwner, TEST_SERVER_VARIABLE } from './test-database.js';

/** The run server's socket folder: the preload names it before any test file loads. */
function runServerSocket(): string {
  const held = process.env[TEST_SERVER_VARIABLE]?.trim();
  if (held === undefined || held === '') throw new Error('test/test-database-close.test.ts:1: the run server is not there: run the suite from the repository root');
  return held;
}

/** One statement on the run server's administrative database, in a connection of its own. */
async function runServerStatement(sql: string, values: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
  const client = new Client({ ...clusterEndpoint(runServerSocket()), user: 'postgres', database: 'postgres' });
  await client.connect();
  try {
    return (await client.query(sql, [...values])).rows as Record<string, unknown>[];
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The case databases of this process the run server holds, sorted by code point. */
async function caseDatabases(): Promise<string[]> {
  const rows = await runServerStatement('SELECT datname FROM pg_database WHERE datname LIKE $1', [`t_${String(process.pid)}\\_%`]);
  return rows.map((row) => String(row['datname'])).sort();
}

/** What a promise rejected with, or undefined when it resolved: the caller sees the rejection either way. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  return await work.then(() => undefined, (error: unknown) => error);
}

test('a failed DROP rejects close() with the database and the server error, and a retry drops it', async () => {
  const before = await caseDatabases();
  const phases: string[] = [];
  const owner = await createTestDatabaseOwner({ timing: (phase) => phases.push(phase) });
  const [database] = (await caseDatabases()).filter((name) => !before.includes(name));
  expect(database).toBeDefined();
  // PostgreSQL refuses to drop a database that is a template: a real DROP failure, not a substituted error.
  await runServerStatement('UPDATE pg_database SET datistemplate = true WHERE datname = $1', [database!]);
  const failure = await rejection(owner.close());
  expect(failure).toBeInstanceOf(Error);
  expect(String((failure as Error).message)).toContain(database!);
  expect(String((failure as Error).message)).toContain('cannot drop a template database');
  expect(await caseDatabases()).toEqual([...before, database!].sort());
  // The close that failed closed the pool and did not drop the database; the close that follows drops only the database.
  await runServerStatement('UPDATE pg_database SET datistemplate = false WHERE datname = $1', [database!]);
  const phasesBeforeRetry = [...phases];
  await owner.close();
  // The drop is done when close() resolves, not scheduled after it: the phase is already there before the next statement.
  expect([...phases].filter((phase) => phase === 'database-drop')).toHaveLength(1);
  expect(await caseDatabases()).toEqual(before);
  expect(phasesBeforeRetry.filter((phase) => phase === 'database-owner-close')).toHaveLength(1);
  expect(phasesBeforeRetry).not.toContain('database-drop');
  expect(phases.filter((phase) => phase === 'database-drop')).toHaveLength(1);
  // A third close() issues no DROP at all: a same-named sentinel makes even DROP IF EXISTS observable.
  await runServerStatement(`CREATE DATABASE "${database!}"`);
  try {
    await owner.close();
    expect(await caseDatabases()).toEqual([...before, database!].sort());
  } finally { await runServerStatement(`DROP DATABASE IF EXISTS "${database!}" WITH (FORCE)`); }
}, 120_000);

test('a close resolves only after the DROP, and after success it returns the same settled promise', async () => {
  const before = await caseDatabases();
  const phases: string[] = [];
  const owner = await createTestDatabaseOwner({ timing: (phase) => phases.push(phase) });
  const [database] = (await caseDatabases()).filter((name) => !before.includes(name));
  expect(database).toBeDefined();
  const first = owner.close();
  // The owner closes once: a second call while the first runs is the same attempt.
  expect(owner.close()).toBe(first);
  await first;
  // Nothing was awaited between close() and this read: the DROP is behind us, not scheduled for after the close.
  expect(phases.filter((phase) => phase === 'database-drop')).toHaveLength(1);
  expect(await caseDatabases()).toEqual(before);
  // A close that succeeded is settled: every later call returns that same promise.
  expect(owner.close()).toBe(first);
}, 60_000);

test('a failure after the clone leaves no case database and reports the original error', async () => {
  const before = await caseDatabases();
  const error = new Error('opening failed after the clone');
  const failure = await rejection(createTestDatabaseOwner({ timing: (phase) => { if (phase === 'database-clone') throw error; } }));
  expect(failure).toBe(error);
  expect((failure as Error).cause).toBeUndefined();
  // The database the clone made is dropped before the error reaches the case.
  expect(await caseDatabases()).toEqual(before);
}, 60_000);

test('a DROP that fails while the case is failing is the cause, and the original error is thrown', async () => {
  // The next database this process creates carries the number after the one a probe gets: the counter is the process's,
  // and nothing between the probe and the case below names another database.
  const before = await caseDatabases();
  const probe = await createTestDatabaseOwner();
  const [probeName] = (await caseDatabases()).filter((name) => !before.includes(name));
  await probe.close();
  expect(probeName).toBeDefined();
  const next = Number(probeName!.slice(`t_${String(process.pid)}_`.length)) + 1;
  const database = `t_${String(process.pid)}_${String(next)}`;
  // A database the case's own open adopts, marked a template so that PostgreSQL refuses to drop it.
  await runServerStatement(`CREATE DATABASE "${database}"`);
  await runServerStatement('UPDATE pg_database SET datistemplate = true WHERE datname = $1', [database]);
  const error = new Error('opening failed on an adopted database');
  try {
    const failure = await rejection(createTestDatabaseOwner({ socket: runServerSocket(), timing: (phase) => { if (phase === 'database-owner-open') throw error; } }));
    expect(failure).toBe(error);
    const cause = (failure as Error).cause;
    expect(String(cause instanceof Error ? cause.message : cause)).toContain(database);
    expect(String(cause instanceof Error ? cause.message : cause)).toContain('cannot drop a template database');
  } finally {
    await runServerStatement('UPDATE pg_database SET datistemplate = false WHERE datname = $1', [database]);
    await runServerStatement(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  }
}, 120_000);

test('a callback that throws after the DROP rejects close() and causes no second DROP', async () => {
  const before = await caseDatabases();
  const error = new Error('timing failed after the drop');
  const owner = await createTestDatabaseOwner({ timing: (phase) => { if (phase === 'database-drop') throw error; } });
  const [database] = (await caseDatabases()).filter((name) => !before.includes(name));
  expect(database).toBeDefined();
  const failure = await rejection(owner.close());
  expect(failure).toBe(error);
  // The DROP succeeded before the callback threw: the database is gone.
  expect(await caseDatabases()).toEqual(before);
  // A later close() must not issue another DROP: the sentinel would be gone.
  await runServerStatement(`CREATE DATABASE "${database!}"`);
  try {
    await owner.close();
    expect(await caseDatabases()).toEqual([...before, database!].sort());
  } finally { await runServerStatement(`DROP DATABASE IF EXISTS "${database!}" WITH (FORCE)`); }
}, 120_000);
