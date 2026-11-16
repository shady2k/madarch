/** Installs the final assertion graph. Existing products refill (0039 item 25). */
import type { DatabaseOwner } from '../database-owner.js';
import { withSpan } from '../../obs/trace.js';
import { SCHEMA_LOCK_SQL, storeSchemaLockKey } from '../schema-lock.js';
import { EMPTY_CONTRACT, type GraphContract } from '../../graph/contract.js';
import { withAssertionContract } from '../../graph/system-contract.js';
import { createContractTablesIn } from './graph-contract.js';
import { validateValueContracts } from '../../graph/value-validation.js';
import { METADATA_SCHEMA, SCHEMA, SCHEMA_REVISION, graphSchemaStamp } from './graph-definition.js';

export const RETIRED_GRAPH_DROP_SQL: readonly string[] = [
  'DROP TABLE IF EXISTS assertion_vertex_subject CASCADE',
  'DROP TABLE IF EXISTS assertion_edge_subject CASCADE',
  'DROP TABLE IF EXISTS assertion CASCADE',
  'DROP TABLE IF EXISTS edge CASCADE',
  'DROP TABLE IF EXISTS node CASCADE',
  'DROP TABLE IF EXISTS entity CASCADE',
  'DROP TABLE IF EXISTS context CASCADE',
  'DROP TABLE IF EXISTS operation CASCADE',
  'DROP TABLE IF EXISTS unresolved_reference CASCADE',
  'DROP TABLE IF EXISTS claim CASCADE',
  'DROP TABLE IF EXISTS evidence CASCADE',
  'DROP TABLE IF EXISTS kind CASCADE',
];

export async function prepareGraphSchema(owner: DatabaseOwner, declared: GraphContract = EMPTY_CONTRACT): Promise<{reset:boolean}> {
  return await withSpan('graph.schema.prepare',{},async () => await owner.transaction('write',async tx => {
    const contract=withAssertionContract(declared);
    validateValueContracts(contract);
    await tx.query(SCHEMA_LOCK_SQL,[storeSchemaLockKey()]);
    for(const statement of METADATA_SCHEMA)await tx.query(statement);
    const held=await tx.query<{name:string;stamp:string}>(`SELECT name,stamp FROM madarch_meta.schema_stamp WHERE name IN ('one-graph','one-graph-revision')`);
    const stamp=graphSchemaStamp(contract);
    if(held.rows.some(row=>row.name==='one-graph'&&row.stamp===stamp) && held.rows.some(row=>row.name==='one-graph-revision'&&row.stamp===String(SCHEMA_REVISION))) return {reset:false};
    const reset=!held.rows.some(row=>row.name==='one-graph-revision'&&row.stamp===String(SCHEMA_REVISION));
    if(reset) {
      const tables=await tx.query<{name:string}>(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r'`);
      for(const row of tables.rows) if(['k_','e_','a_','d_'].some(prefix=>row.name.startsWith(prefix))) {
        await tx.query(`DROP TABLE "${row.name.split('"').join('""')}" CASCADE`);
      }
      for(const statement of RETIRED_GRAPH_DROP_SQL) await tx.query(statement);
      await tx.query('DROP SEQUENCE IF EXISTS opinion_id');
      await tx.query('DROP SEQUENCE IF EXISTS graph_recorded_seq');
    }
    if(reset) for(const statement of SCHEMA) await tx.query(statement);
    const base=await tx.query(`SELECT id FROM context WHERE parent IS NULL`);
    if(base.rows.length===0) await tx.query(`INSERT INTO context(parent,ref,parent_recorded_seq) VALUES(NULL,'',NULL)`);
    await createContractTablesIn(tx,contract);
    for(const [name,value] of [['one-graph',stamp],['one-graph-revision',String(SCHEMA_REVISION)]]) await tx.query(`INSERT INTO madarch_meta.schema_stamp(name,stamp) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET stamp=excluded.stamp,created_at=now()`,[name,value]);
    if(reset) await tx.query(`INSERT INTO madarch_meta.schema_stamp(name,stamp) VALUES('graph-reset',now()::text) ON CONFLICT(name) DO UPDATE SET stamp=excluded.stamp,created_at=now()`);
    return {reset};
  }));
}
