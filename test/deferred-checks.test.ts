import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { assertionValueTableName, generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';

const contract: GraphContract = {
  vertex: [{ name: 'keyed', table: generatedTableName('keyed', 'vertex'), key: ['name'],
    fields: [{ name: 'name', type: 'text' }, { name: 'amount', type: 'integer' }], capability: 'fixture' }],
  edge: [], dictionary: [],
};

test('deferred checking work is one pass, independent of the number of new keyed vertices', async () => {
  const counts = [];
  for (const n of [2, 200]) {
    const owner = await createTestDatabaseOwner({ graphContract: contract });
    try {
      counts.push(await owner.transaction('write', async tx => {
        await tx.query("SET LOCAL track_functions='all'");
        await bindTestWriteCapability(tx, contract);
        await publishGraphDrafts(tx, contract, { vertices: Array.from({ length: n }, (_, i) => ({
          kind: 'keyed', key: { name: `key-${i}` }, values: { amount: i }, producer: 'fixture', producerVersion: '1',
        })), removals: [] });
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        const rows = (await tx.query<{ funcname: string; calls: string }>(`SELECT funcname,calls::text
          FROM pg_stat_xact_user_functions WHERE funcname IN
          ('graph_key_check','graph_value_check','graph_subject_check','graph_checks_pass') ORDER BY funcname`)).rows;
        return Object.fromEntries(rows.map(row => [row.funcname, Number(row.calls)]));
      }));
    } finally { await owner.close(); }
  }
  console.error('deferred checking calls N=2 / N=200', JSON.stringify(counts));
  expect(Object.keys(counts[0]!)).not.toHaveLength(0);
  expect(counts[1]).toEqual(counts[0]);
}, 60_000);

for (const [code, message] of [
  [77, 'assertion % requires exactly one subject'],
  [80, 'invalid assertion subject edge'],
  [83, 'assertion header requires a system.assertion vertex'],
  [88, 'assertion requires source, author and operation edges'],
  [106, 'END_KIND_INVALID assertion lineage'],
  [43, 'assertion value does not match declared subject/property'],
  [60, 'assertion requires exactly one typed value; retraction requires none'],
  [214, 'IMMUTABLE_KEY missing or contradictory assertion for keyed.name'],
] as const) test(`one invalid row among valid rows: ${code}`, async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', async tx => {
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      for (const table of ['assertion','assertion_vertex_subject','node','edge']) await tx.query(`ALTER TABLE "${table}" DISABLE TRIGGER immutable`);
    });
    await expect(owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, { vertices: Array.from({ length: 20 }, (_, i) => ({
        kind: 'keyed', key: { name: `row-${i}` }, values: { amount: i }, producer: 'fixture', producerVersion: '1',
      })), removals: [] });
      const id = (await tx.query<{ id: string }>(`SELECT a.assertion_id::text id FROM assertion a
        JOIN assertion_vertex_subject av ON av.assertion_id=a.assertion_id JOIN edge e ON e.id=av.subject_edge_id
        JOIN node n ON n.id=e.to_node JOIN entity k ON k.id=n.entity_id
        WHERE k.name='keyed' AND a.property='amount' ORDER BY a.assertion_id DESC LIMIT 1`)).rows[0]!.id;
      if (code===77) await tx.query('DELETE FROM assertion_vertex_subject WHERE assertion_id=$1',[id]);
      if (code===80) await tx.query(`UPDATE edge SET from_node=to_node WHERE id=(SELECT subject_edge_id FROM assertion_vertex_subject WHERE assertion_id=$1)`,[id]);
      if (code===83) await tx.query(`UPDATE node SET entity_id=(SELECT id FROM entity WHERE name='keyed') WHERE id=$1`,[id]);
      if (code===88) await tx.query(`DELETE FROM edge WHERE from_node=$1 AND entity_id=(SELECT id FROM entity WHERE name='system.assertion-author')`,[id]);
      if (code===106) await tx.query(`UPDATE edge SET to_node=$1 WHERE from_node=$1 AND entity_id=(SELECT id FROM entity WHERE name='system.assertion-author')`,[id]);
      if (code===43) await tx.query(`UPDATE assertion SET operation='retract' WHERE assertion_id=$1`,[id]);
      if (code===60) {
        const table = assertionValueTableName('keyed','vertex','amount');
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        await tx.query(`ALTER TABLE "${table}" DISABLE TRIGGER immutable`);
        await tx.query('SET CONSTRAINTS ALL DEFERRED');
        await tx.query(`DELETE FROM "${table}" WHERE assertion_id=$1`,[id]);
        await tx.query("SELECT set_config('madarch.graph_node_lower',$1,true),set_config('madarch.checked_graph_revision','',true)",[id]);
        await tx.query('SELECT graph_checks_pass()');
      }
      if (code===214) await tx.query(`UPDATE node SET key='{"name":"contradiction"}' WHERE id=(SELECT e.to_node FROM assertion_vertex_subject s JOIN edge e ON e.id=s.subject_edge_id WHERE s.assertion_id=$1)`,[id]);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    })).rejects.toThrow(code===77 ? 'requires exactly one subject' : `:${code}: ${message}`);
  } finally { await owner.close(); }
}, 60_000);

for (const check of ['subject', 'value', 'key'] as const) {
  test(`${check} check reads the same rows after small and large standing graphs`, async () => {
    const measured = [];
    for (const size of [5, 50]) {
      const owner = await createTestDatabaseOwner({ graphContract: contract });
      try {
        await owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
          vertices: Array.from({ length: size }, (_, i) => ({
            kind: 'keyed', key: { name: `standing-${i}` }, values: { amount: i }, producer: 'fixture', producerVersion: '1',
          })), removals: [],
        }));
        measured.push(await owner.transaction('write', async tx => {
          await tx.query('SET LOCAL enable_seqscan=off');
          await tx.query('DISCARD PLANS');
          if (check === 'key') {
            await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'keyed', key: { name: 'new-key' },
              producer: 'fixture', producerVersion: '1' }], removals: [] });
          } else {
            const { writeAssertion } = await import('../src/graph/write.js');
            const subject = (await tx.query<{ id: string }>(`SELECT id::text FROM node
              WHERE entity_id=(SELECT id FROM entity WHERE name='keyed') AND key='{"name":"standing-0"}'::jsonb`)).rows[0]!.id;
            await writeAssertion(tx, contract, { sort: 'vertex', kind: 'keyed', subjectId: subject,
              property: check === 'subject' ? '$exists' : 'amount', operation: 'assert', value: check === 'subject' ? true : 99,
              ...(check === 'subject' ? { validFrom: '0001-01-01T00:00:00.000Z' } : {}) });
          }
          const reads = async () => (await tx.query<{ table: string; reads: number }>(`SELECT relname AS table,
            (seq_tup_read+idx_tup_fetch)::integer AS reads FROM pg_stat_xact_user_tables
            WHERE schemaname='public' ORDER BY relname COLLATE "C"`)).rows;
          const before = new Map((await reads()).map(row => [row.table, row.reads]));
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          return Object.fromEntries((await reads()).map(row => [row.table, row.reads - (before.get(row.table) ?? 0)]));
        }));
      } finally { await owner.close(); }
    }
    console.log(`${check.toUpperCase()}_ROWS ${JSON.stringify(measured.map(rows => Object.fromEntries(Object.entries(rows).filter(([, n]) => n !== 0))))}`);
    expect(Object.values(measured[0]!).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
    expect(measured[1]).toEqual(measured[0]);
  }, 60_000);
}

test('key checks read only changed ids of their keyed kind', async () => {
  const reads: number[] = [];
  for (const kinds of [1, 20]) {
    const declared: GraphContract = { vertex: Array.from({ length: kinds }, (_, i) => ({
      name: `keyed${i}`, table: generatedTableName(`keyed${i}`, 'vertex'), key: ['name'],
      fields: [{ name: 'name', type: 'text' as const }], capability: 'fixture',
    })), edge: [], dictionary: [] };
    const owner = await createTestDatabaseOwner({ graphContract: declared });
    try { reads.push(await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, declared);
      await publishGraphDrafts(tx, declared, { vertices: Array.from({length:200},(_,i)=>({
        kind:'keyed0',key:{name:`new-${i}`},producer:'fixture',producerVersion:'1',
      })), removals:[] });
      const count=async()=>Number((await tx.query<{reads:number}>(`SELECT (seq_tup_read+idx_tup_fetch)::integer reads FROM pg_stat_xact_user_tables WHERE relname='node'`)).rows[0]!.reads);
      await tx.query('DROP INDEX node_entity');
      const before=await count(); await tx.query('SELECT graph_checks_pass()'); const measured=await count()-before;
      await tx.query('SAVEPOINT invalid_key');
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      await tx.query('ALTER TABLE node DISABLE TRIGGER immutable');
      await tx.query(`UPDATE node SET key='{"name":"contradiction"}' WHERE entity_id=(SELECT id FROM entity WHERE name='keyed0') AND key='{"name":"new-0"}'`);
      await tx.query(`SELECT set_config('madarch.graph_node_lower',(SELECT min(id)::text FROM node WHERE entity_id=(SELECT id FROM entity WHERE name='keyed0')),true),set_config('madarch.checked_graph_revision','',true)`);
      await expect(tx.query('SELECT graph_checks_pass()')).rejects.toThrow(':214: IMMUTABLE_KEY missing or contradictory assertion for keyed0.name');
      await tx.query('ROLLBACK TO SAVEPOINT invalid_key');
      return measured;
    })); } finally { await owner.close(); }
  }
  console.log('KEY_KIND_READS',reads); expect(reads[0]).toBeGreaterThan(0); expect(reads[1]).toBe(reads[0]);
},60_000);

test('relation active-id calls depend on kinds, not vertex count', async () => {
  const declared: GraphContract={...contract,edge:[{name:'related',table:generatedTableName('related','edge'),
    from:['keyed'],to:['keyed'],cardinality:{from:'many',to:'many'},fields:[],capability:'fixture',repeats:false,labels:{en:{out:'related',in:'related'},ru:{out:'related',in:'related'}}}]};
  const calls:number[]=[];
  for(const n of [2,200]) {
    const owner=await createTestDatabaseOwner({graphContract:declared});
    try { calls.push(await owner.transaction('write',async tx=>{
      await tx.query("SET LOCAL track_functions='all'"); await bindTestWriteCapability(tx,declared);
      await publishGraphDrafts(tx,declared,{vertices:Array.from({length:n},(_,i)=>({kind:'keyed',key:{name:`v-${i}`},producer:'fixture',producerVersion:'1'})),edges:[{kind:'related',from:{kind:'keyed',key:{name:'v-0'}},to:{kind:'keyed',key:{name:'v-1'}},producer:'fixture',producerVersion:'1'}],removals:[]});
      const count=async()=>Number((await tx.query<{calls:number}>("SELECT coalesce(sum(calls),0)::integer calls FROM pg_stat_xact_user_functions WHERE funcname IN ('graph_vertex_active_ids','graph_vertex_active_ids_batch')")).rows[0]!.calls);
      const before=await count(); await tx.query('SELECT graph_checks_pass()'); return await count()-before;
    })); } finally {await owner.close();}
  }
  console.log('ACTIVE_KIND_CALLS',calls); expect(calls[0]).toBeGreaterThan(0); expect(calls[1]).toBe(calls[0]);
},60_000);

test('edge active-id calls depend on kinds, not edge count', async () => {
  const declared: GraphContract={...contract,edge:[{name:'related',table:generatedTableName('related','edge'),
    from:['keyed'],to:['keyed'],cardinality:{from:'many',to:'many'},fields:[],capability:'fixture',repeats:false,labels:{en:{out:'related',in:'related'},ru:{out:'related',in:'related'}}}]};
  const calls:number[]=[];
  for(const n of [2,200]) {
    const owner=await createTestDatabaseOwner({graphContract:declared});
    try { calls.push(await owner.transaction('write',async tx=>{
      await tx.query("SET LOCAL track_functions='all'"); await bindTestWriteCapability(tx,declared);
      await publishGraphDrafts(tx,declared,{vertices:Array.from({length:n},(_,i)=>({kind:'keyed',key:{name:`v-${i}`},producer:'fixture',producerVersion:'1'})),edges:Array.from({length:n-1},(_,i)=>({kind:'related',from:{kind:'keyed',key:{name:'v-0'}},to:{kind:'keyed',key:{name:`v-${i+1}`}},producer:'fixture',producerVersion:'1'})),removals:[]});
      const count=async()=>Number((await tx.query<{calls:number}>("SELECT coalesce(sum(calls),0)::integer calls FROM pg_stat_xact_user_functions WHERE funcname IN ('graph_edge_active_ids','graph_edge_active_ids_batch')")).rows[0]!.calls);
      const before=await count(); await tx.query('SELECT graph_checks_pass()'); return await count()-before;
    })); } finally {await owner.close();}
  }
  console.log('EDGE_KIND_CALLS',calls); expect(calls[0]).toBeGreaterThan(0); expect(calls[1]).toBe(calls[0]);
},60_000);

test('value validation does not open unrelated typed value tables',async()=>{
 const declared:GraphContract={...contract,vertex:[...contract.vertex,{name:'unused',table:generatedTableName('unused','vertex'),key:[],fields:[{name:'note',type:'text'}],capability:'fixture'}]};
 const owner=await createTestDatabaseOwner({graphContract:declared});
 try{
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,declared);
   await publishGraphDrafts(tx,declared,{vertices:[{kind:'keyed',key:{name:'one'},values:{amount:1},producer:'fixture',producerVersion:'1'}],removals:[]});
   await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
   const locks=await tx.query<{count:number}>(`SELECT count(*)::integer AS count FROM pg_locks WHERE pid=pg_backend_pid() AND relation=$1::regclass`,[assertionValueTableName('unused','vertex','note')]);
   expect(locks.rows[0]!.count).toBe(0);
  });
 }finally{await owner.close();}
},30_000);

test('typed value dispatch checks wrong-table inserts across immediate checks and savepoint rollback',async()=>{
 const declared:GraphContract={...contract,vertex:[...contract.vertex,{name:'unused',table:generatedTableName('unused','vertex'),key:[],fields:[{name:'note',type:'text'}],capability:'fixture'}]};
 const owner=await createTestDatabaseOwner({graphContract:declared});
 try{
  await owner.transaction('write',async tx=>{
   await bindTestWriteCapability(tx,declared);
   await publishGraphDrafts(tx,declared,{vertices:[{kind:'keyed',key:{name:'one'},values:{amount:1},producer:'fixture',producerVersion:'1'}],removals:[]});
  });
  await owner.transaction('write',async tx=>{
   const id=(await tx.query<{id:string}>(`SELECT assertion_id::text AS id FROM "${assertionValueTableName('keyed','vertex','amount')}" LIMIT 1`)).rows[0]!.id;
   for(const immediate of [false,true]){
    await tx.query('SAVEPOINT invalid_value');
    if(immediate)await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    const insert=()=>tx.query(`INSERT INTO "${assertionValueTableName('unused','vertex','note')}"(assertion_id,value) VALUES($1,'wrong')`,[id]);
    if(immediate)await expect(insert()).rejects.toThrow(':43: assertion value does not match declared subject/property');
    else{await insert();await expect(tx.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(':43: assertion value does not match declared subject/property');}
    await tx.query('ROLLBACK TO SAVEPOINT invalid_value');
   }
   await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
  });
 }finally{await owner.close();}
},30_000);
