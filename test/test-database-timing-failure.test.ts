import { expect, test } from 'bun:test';
import { Client } from 'pg';
import { randomBytes } from 'node:crypto';
import { clusterEndpoint } from '../src/adapters/postgres-cluster.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { requireSchema } from '../src/adapters/store-readiness.js';
import { createTestDatabaseOwner, TEST_SERVER_VARIABLE } from './test-database.js';

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

const setupPhases = ['server-ready-start', 'server-ready', 'template-ready-start', 'contract-template-reused', 'template-ready', 'contract-template-preparation-start', 'contract-template-preparation', 'template-first-request', 'database-clone-start', 'database-clone', 'database-owner-open-start', 'database-owner-open'];
for (const phase of setupPhases) {
  test(`a case failure at ${phase} leaves no case database`, async () => {
    const error = new Error(`timing failed at ${phase}`);
    const fresh = phase.startsWith('contract-template-preparation') || phase === 'template-first-request';
    const failure = await rejection(createTestDatabaseOwner({ ...(fresh ? { graphContract: contract() } : {}), timing: held => { if (held === phase) throw error; } }));
    // A close, not a queue: the database a failed open made is dropped before the error reaches the case (ALX-186, C4).
    expect(failure).toBe(error);
    expect(await cases()).toEqual([]);
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
