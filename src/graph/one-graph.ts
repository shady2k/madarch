/** Connects only to the final typed assertion graph (0039 item 25). */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { requireSchema } from '../adapters/store-readiness.js';
import { withSpan } from '../obs/trace.js';
import { graphSchemaStamp } from '../adapters/schemas/graph-definition.js';
import { EMPTY_CONTRACT, assertionValueTableName, type GraphContract } from './contract.js';
import { withAssertionContract } from './system-contract.js';
export async function createOneGraphSchema(owner:DatabaseOwner,declared:GraphContract=EMPTY_CONTRACT):Promise<{reset:boolean}>{
 return await withSpan('graph.schema.require',{},async()=>{
 const contract=withAssertionContract(declared);await requireSchema(owner,'one-graph',graphSchemaStamp(contract));
 const tables=['entity','context','node','edge','assertion','assertion_vertex_subject','assertion_edge_subject'];
 for(const sort of ['vertex','edge'] as const)for(const kind of contract[sort])for(const property of ['$exists',...kind.fields.filter(f=>!('key' in kind&&kind.key.includes(f.name))).map(f=>f.name)])tables.push(assertionValueTableName(kind.name,sort,property));
 await owner.transaction('snapshot',async tx=>{
 const missing=await tx.query<{name:string}>(`SELECT requested.name FROM unnest($1::text[]) requested(name) WHERE NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname=requested.name)`,[tables]);
 if(missing.rows.length)throw new Error(`${import.meta.path}:16: missing prepared graph tables ${missing.rows.map(row=>row.name).join(', ')}`);
 const old=await tx.query<{name:string}>(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' AND (c.relname IN ('operation','unresolved_reference') OR left(c.relname,2) IN ('k_','e_'))`);
 if(old.rows.length)throw new Error(`${import.meta.path}:18: obsolete graph tables ${old.rows.map(row=>row.name).join(', ')}`);
 });return {reset:false};});
}
