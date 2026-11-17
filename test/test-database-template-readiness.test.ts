/**
 * A template is a database whose preparation finished (ALX-134, the review of
 * ALX-119: `test/test-database.ts:136-146`). A row in `pg_database` under the
 * template's name is not proof of that: a preparation that failed halfway
 * leaves such a database, and the next case of the contract must either
 * prepare the template again or fail naming the original error — it must never
 * get an owner that lacks the store's schema.
 */
import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { clusterEndpoint } from '../src/adapters/postgres-cluster.js';
import { graphSchemaStamp } from '../src/adapters/schemas/graph-definition.js';
import { hasSchema, requireSchema } from '../src/adapters/store-readiness.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import {
  createTestDatabaseOwner,
  failNextContractTemplatePreparation,
  TEST_SERVER_VARIABLE,
  type TestDatabaseOwner,
} from './test-database.js';

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
  if (held === undefined || held === '') throw new Error('test/test-database-template-readiness.test.ts:1: the run server is not there: run the suite from the repository root');
  return held;
}

/** The name `test-database.ts` gives the run's template of one contract. */
function templateName(contract: GraphContract): string {
  return `template_madarch_${graphSchemaStamp(withAssertionContract(contract)).slice(0, 12)}`;
}

/** One statement on the run server's administrative database, in a connection of its own. */
async function runServerStatement(sql: string, values: readonly unknown[] = []): Promise<void> {
  const client = new Client({ ...clusterEndpoint(runServerSocket()), user: 'postgres', database: 'postgres' });
  await client.connect();
  try {
    await client.query(sql, [...values]);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The store schemas a case's owner reads through `requireSchema`; the template must carry all of them. */
const CASE_SCHEMAS = ['one-graph', 'history', 'queue:pgboss', 'agent-usage'] as const;

/** Every schema `prepareStore` installs that the owner lacks, sorted by code point. */
async function missingSchemas(owner: TestDatabaseOwner): Promise<string[]> {
  const missing: string[] = [];
  for (const name of CASE_SCHEMAS) if (!await hasSchema(owner, name)) missing.push(name);
  return missing.sort();
}

test('a preparation that failed is prepared again, never cloned as a template', async () => {
  const contract = probeContract();
  const firstPhases: string[] = [];
  // The preparation fails where a transient SQL failure would: after its database is made, before the schema is installed.
  failNextContractTemplatePreparation(new Error('injected schema installation failure'));
  await expect(createTestDatabaseOwner({ graphContract: contract, timing: (phase) => firstPhases.push(phase) }))
    .rejects.toThrow('injected schema installation failure');
  // The next case of the same contract asks for its template again.
  const phases: string[] = [];
  const owner = await createTestDatabaseOwner({ graphContract: contract, timing: (phase) => phases.push(phase) });
  try {
    const stampTable = (await owner.run((tx) => tx.query<{ held: string | null }>("SELECT to_regclass('madarch_meta.schema_stamp')::text AS held"))).rows[0]?.held ?? null;
    expect({ stampTable, missing: await missingSchemas(owner) }).toEqual({ stampTable: 'madarch_meta.schema_stamp', missing: [] });
    for (const name of CASE_SCHEMAS) await requireSchema(owner, name);
    // The second case did not inherit a database: the template was prepared again.
    expect(phases).toContain('contract-template-preparation');
  } finally { await owner.close(); }
}, 120_000);

test('a database under the template name without the schema is not cloned', async () => {
  const contract = probeContract();
  const name = templateName(contract);
  // An empty database where the template stands, the shape an interrupted preparation leaves.
  await runServerStatement(`CREATE DATABASE "${name}"`);
  try {
    const phases: string[] = [];
    const owner = await createTestDatabaseOwner({ graphContract: contract, timing: (phase) => phases.push(phase) });
    try {
      expect({ missing: await missingSchemas(owner), prepared: phases.includes('contract-template-preparation') })
        .toEqual({ missing: [], prepared: true });
    } finally { await owner.close(); }
  } finally {
    // The template that took the name is the run's; a test that failed before the case ran leaves this one for the sweep.
    await runServerStatement(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
  }
}, 120_000);
