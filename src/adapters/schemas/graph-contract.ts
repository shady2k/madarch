/** Installs generated assertion storage, decision 0039 items 10 and 25. */
import type { OuterTransaction } from '../database-owner.js';
import { withSpan } from '../../obs/trace.js';
import type { GraphContract } from '../../graph/contract.js';
import { generateContractStatements } from './graph-definition.js';

/** The generated storage contains values, not relations or identity strings. */
export async function createContractTablesIn(tx: OuterTransaction, declared: GraphContract, before: readonly string[] = [], reset = false): Promise<void> {
  return await withSpan('graph.schema.contract', {}, async () => {
    const generated = generateContractStatements(declared);
    const tables = [...new Set(generated.triggers.map(trigger => trigger.table))];
    const held = await tx.query<{table:string;name:string;fn:string;type:number;deferred:boolean;initially_deferred:boolean;enabled:string;constraint:boolean;no_arguments:boolean;no_columns:boolean;no_condition:boolean;no_transition:boolean;has_transition:boolean}>(`SELECT c.relname AS table,t.tgname AS name,t.tgfoid::regproc::text AS fn,t.tgtype AS type,
      t.tgdeferrable AS deferred,t.tginitdeferred AS initially_deferred,t.tgenabled AS enabled,
      t.tgconstraint<>0 AS constraint,t.tgnargs=0 AS no_arguments,t.tgattr::text='' AS no_columns,
      t.tgqual IS NULL AS no_condition,t.tgoldtable IS NULL AND t.tgnewtable IS NULL AS no_transition,t.tgoldtable IS NULL AND t.tgnewtable IS NOT NULL AS has_transition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal`,[tables]);
    const installed = new Map((reset ? [] : held.rows).map(row => [row.table+'\0'+row.name,row]));
    const changes: string[] = [];
    for (const trigger of generated.triggers) {
      const row = installed.get(trigger.table+'\0'+trigger.name);
      if (row !== undefined && row.fn===trigger.fn && row.type===trigger.type && row.deferred===trigger.deferred
        && row.initially_deferred===trigger.deferred && row.enabled==='O' && row.constraint===trigger.deferred
        && row.no_arguments && row.no_columns && row.no_condition && row.has_transition===trigger.transition) continue;
      if (row !== undefined) changes.push(`DROP TRIGGER "${trigger.name}" ON "${trigger.table}"`);
      changes.push(trigger.statement);
    }
    // No parameters: pg sends the complete DDL script through its simple protocol on this transaction's connection.
    await tx.query(`DO $contract_install$ BEGIN\n${[...before,...generated.statements,...changes].join(';\n')};\nEND $contract_install$`);
    await tx.query(generated.entityStatement,
      [JSON.stringify(generated.entities)]);
  });
}
