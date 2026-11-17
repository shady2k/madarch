import { expect, test } from 'bun:test';
import { Client } from 'pg';
import { randomBytes } from 'node:crypto';
import { clusterEndpoint } from '../src/adapters/postgres-cluster.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { requireSchema } from '../src/adapters/store-readiness.js';
import { createTestDatabaseOwner, pendingTestDatabaseDrops, TEST_SERVER_VARIABLE, waitForTestDatabaseDrops } from './test-database.js';

function contract(): GraphContract {
  const name = `probe.timing-${randomBytes(4).toString('hex')}`;
  return { vertex: [{ name, table: generatedTableName(name, 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' }], capability: 'fixture' }], edge: [], dictionary: [] };
}

async function query(sql: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  const socket = process.env[TEST_SERVER_VARIABLE];
  if (socket === undefined) throw new Error('run server socket is missing');
  const client = new Client({ ...clusterEndpoint(socket), user: 'postgres', database: 'postgres' });
  await client.connect();
  try { return (await client.query(sql, values)).rows as Record<string, unknown>[]; }
  finally { await client.end(); }
}

async function databases(): Promise<string[]> {
  return (await query('SELECT datname FROM pg_database')).map(row => String(row['datname'])).sort();
}
async function cases(): Promise<string[]> {
  return (await databases()).filter(name => name.startsWith(`t_${String(process.pid)}_`));
}
async function rejection(work: Promise<unknown>): Promise<unknown> {
  return await work.then(() => undefined, (error: unknown) => error);
}

for (const asyncCallback of [false, true]) {
  test(`DROP succeeds without invoking an armed ${asyncCallback ? 'async' : 'sync'} callback`, async () => {
    await waitForTestDatabaseDrops();
    const error = new Error('case timing failure');
    let armed = false;
    const phases: string[] = [];
    const callback = (phase: string) => { phases.push(phase); if (armed) throw error; };
    const owner = await createTestDatabaseOwner({ timing: phase => { if (armed && asyncCallback) return (async () => callback(phase))(); callback(phase); } });
    armed = true;
    const failure = await rejection(owner.close());
    const atClose = [...phases];
    const drain = await rejection(waitForTestDatabaseDrops());
    armed = false;
    await waitForTestDatabaseDrops();
    expect(asyncCallback ? failure instanceof TypeError : failure === error).toBe(true);
    expect(phases).toEqual(atClose);
    expect(drain).toBeUndefined();
    expect(pendingTestDatabaseDrops()).toBe(0);
    expect(await cases()).toEqual([]);
  }, 60_000);
}

test('DROP failure retains only PostgreSQL debt, retries once fixed, and a third drain issues no DROP', async () => {
  await waitForTestDatabaseDrops();
  let armed = false;
  const callbackError = new Error('CALLBACK must not enter debt');
  const phases: string[] = [];
  const owner = await createTestDatabaseOwner({ timing: phase => { phases.push(phase); if (armed) throw callbackError; } });
  const [database] = await cases();
  expect(database).toBeDefined();
  await query('UPDATE pg_database SET datistemplate = true WHERE datname = $1', [database]);
  armed = true;
  const closeError = await rejection(owner.close());
  const atClose = [...phases];
  const failure = await rejection(waitForTestDatabaseDrops());
  const owed = pendingTestDatabaseDrops();
  await query('UPDATE pg_database SET datistemplate = false WHERE datname = $1', [database]);
  const retry = await rejection(waitForTestDatabaseDrops());
  armed = false;
  await waitForTestDatabaseDrops();
  expect(closeError).toBe(callbackError);
  expect(String(failure)).toContain(database!);
  expect(String(failure)).toContain('cannot drop a template database');
  expect(String(failure)).not.toContain('CALLBACK');
  expect(owed).toBe(1);
  expect(retry).toBeUndefined();
  expect(pendingTestDatabaseDrops()).toBe(0);
  expect(await cases()).toEqual([]);
  expect(phases).toEqual(atClose);
  // A same-named sentinel makes even a redundant DROP IF EXISTS observable.
  await query(`CREATE DATABASE "${database!}"`);
  try {
    await waitForTestDatabaseDrops();
    expect(await cases()).toEqual([database!]);
  } finally { await query(`DROP DATABASE "${database!}" WITH (FORCE)`); }
}, 60_000);

const setupPhases = ['server-ready-start', 'server-ready', 'template-ready-start', 'contract-template-reused', 'template-ready', 'contract-template-preparation-start', 'contract-template-preparation', 'template-first-request', 'database-clone-start', 'database-clone', 'database-owner-open-start', 'database-owner-open'];
for (const phase of setupPhases) {
  test(`a case failure at ${phase} leaves no case database`, async () => {
    await waitForTestDatabaseDrops();
    const error = new Error(`timing failed at ${phase}`);
    const fresh = phase.startsWith('contract-template-preparation') || phase === 'template-first-request';
    const failure = await rejection(createTestDatabaseOwner({ ...(fresh ? { graphContract: contract() } : {}), timing: held => { if (held === phase) throw error; } }));
    await waitForTestDatabaseDrops();
    const leaked = await cases();
    // Clean a red baseline run so later counters are independent.
    for (const name of leaked) await query(`DROP DATABASE "${name}" WITH (FORCE)`);
    expect(failure).toBe(error);
    expect(leaked).toEqual([]);
  }, 60_000);
}

for (const asyncCallback of [false, true]) {
  test(`template completes before a ${asyncCallback ? 'async' : 'sync'} preparation callback fails`, async () => {
    const declared = contract();
    const error = new Error('preparation timing failed');
    const failure = await rejection(createTestDatabaseOwner({ graphContract: declared, timing: phase => {
      if (phase !== 'contract-template-preparation') return;
      if (asyncCallback) return Promise.reject(error);
      throw error;
    } }));
    const building = (await databases()).filter(name => name.includes(`_building_${String(process.pid)}_`));
    const phases: string[] = [];
    const next = await createTestDatabaseOwner({ graphContract: declared, timing: phase => { phases.push(phase); } });
    try { await requireSchema(next, 'one-graph'); }
    finally { await next.close(); }
    await waitForTestDatabaseDrops();
    expect(asyncCallback ? failure instanceof TypeError : failure === error).toBe(true);
    if (asyncCallback) {
      expect(String(failure)).toContain('contract-template-preparation');
      expect(String(failure)).toContain('synchronous');
    }
    expect(building).toEqual([]);
    expect(phases.includes('contract-template-reused') || phases.includes('template-already-exists')).toBe(true);
    expect(phases).not.toContain('contract-template-preparation');
  }, 60_000);
}
