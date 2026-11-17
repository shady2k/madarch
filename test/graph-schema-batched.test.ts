/** T1/C: generated SQL reaches standing stores, without repeated DDL (0039.10,25,28). */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { DatabaseOwner, OuterTransaction } from '../src/adapters/database-owner.js';
import { prepareGraphSchema } from '../src/adapters/schemas/graph.js';
import { graphSchemaStamp, generateContractStatements, SCHEMA, SCHEMA_REVISION } from '../src/adapters/schemas/graph-definition.js';
import { EMPTY_CONTRACT, type GraphContract } from '../src/graph/contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { MANIFEST_CONTRACT } from '../src/graph/manifest-contract.js';
import { createTestDatabaseOwner } from './test-database.js';

function counted(owner: DatabaseOwner) {
  const statements: string[] = [];
  return { statements, owner: { ...owner, transaction: async <T>(kind: 'write' | 'snapshot', work: (tx: OuterTransaction) => Promise<T>) =>
    await owner.transaction(kind, async tx => await work({ query: async <Row extends object>(sql: string, values?: readonly unknown[]) => {
      statements.push(sql); return await tx.query<Row>(sql, values);
    } })) } as DatabaseOwner };
}

test('same prepared contract costs at most two statements, no DDL or trigger/catalog walk', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  try {
    await prepareGraphSchema(owner);
    const measured = counted(owner);
    await prepareGraphSchema(measured.owner);
    console.log('T1/C warm statements', measured.statements.length);
    expect(measured.statements.length).toBeLessThanOrEqual(2);
    expect(measured.statements.filter(sql => ['CREATE','ALTER','DROP'].some(verb => sql.trimStart().startsWith(verb)) || sql.includes('pg_trigger') || sql.includes('pg_class'))).toEqual([]);
  } finally { await owner.close(); }
}, 60_000);

test('first manifest schema installs in at most ten statements with one trigger read and one entity upsert', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  try {
    await owner.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DELETE FROM madarch_meta.schema_stamp');
    const measured = counted(owner);
    await prepareGraphSchema(measured.owner, MANIFEST_CONTRACT);
    console.log('T1/C first statements', measured.statements.length, 'trigger reads', measured.statements.filter(sql => sql.includes('FROM pg_trigger')).length);
    expect(measured.statements.length).toBeLessThanOrEqual(10);
    expect(measured.statements.filter(sql => sql.includes('FROM pg_trigger'))).toHaveLength(1);
    expect(measured.statements.filter(sql => sql.includes('INSERT INTO entity'))).toHaveLength(1);
  } finally { await owner.close(); }
}, 60_000);

test('kind declaration ordering does not alter the schema stamp', () => {
  const kind = (name: string) => ({ name, table: name, capability: 'fixture', key: [], fields: [] });
  const contract: GraphContract = { ...EMPTY_CONTRACT, vertex: [kind('z'), kind('a')], edge: [] };
  expect(graphSchemaStamp(contract)).toBe(graphSchemaStamp({ ...contract, vertex: [...contract.vertex].reverse() }));
}, 10_000);

test('stamp includes every generated operator and excludes bound entity data', () => {
  const generated = generateContractStatements(EMPTY_CONTRACT);
  const canonical = JSON.stringify(generated.contract, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
  });
  const expected = createHash('sha256').update([String(SCHEMA_REVISION), ...SCHEMA, canonical,
    ...generated.statements, ...generated.triggers.map(trigger => trigger.statement), generated.entityStatement].join('\n')).digest('hex');
  expect(graphSchemaStamp(EMPTY_CONTRACT)).toBe(expected);
}, 10_000);

test('a previous declaration-only stamp upgrades generated functions without resetting graph identities', async () => {
  const owner = await createTestDatabaseOwner({ authenticated: false });
  try {
    const contract = withAssertionContract(EMPTY_CONTRACT);
    const declaration = JSON.stringify(contract, (_key, value: unknown) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
      const object = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
    });
    const previous = createHash('sha256').update([String(SCHEMA_REVISION), ...SCHEMA, declaration].join('\n')).digest('hex');
    const before = await owner.run(async tx => await tx.query<{stamp:string}>("SELECT stamp FROM madarch_meta.schema_stamp WHERE name='graph-reset'"));
    await owner.exec("CREATE OR REPLACE FUNCTION graph_relations_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'obsolete generated function'; END $$");
    await owner.run(async tx => await tx.query("UPDATE madarch_meta.schema_stamp SET stamp=$1 WHERE name='one-graph'", [previous]));
    expect((await prepareGraphSchema(owner)).reset).toBe(false);
    const after = await owner.run(async tx => await tx.query<{stamp:string}>("SELECT stamp FROM madarch_meta.schema_stamp WHERE name='graph-reset'"));
    const fn = await owner.run(async tx => await tx.query<{body:string}>("SELECT prosrc AS body FROM pg_proc WHERE oid='graph_relations_check()'::regprocedure"));
    expect(after.rows).toEqual(before.rows);
    expect(fn.rows[0]!.body).not.toContain('obsolete generated function');
  } finally { await owner.close(); }
}, 60_000);
