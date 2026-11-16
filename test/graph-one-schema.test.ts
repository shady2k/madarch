/** Physical graph storage invariants: decision 0039 items 10, 14, 25, 28. */
import { expect, test } from 'bun:test';
import { assertionValueTableName, generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';
const graph: GraphContract = {
  vertex: [{ name: 'probe', table: generatedTableName('probe','vertex'), key: ['name'], fields: [{ name:'name',type:'text' },{name:'amount',type:'integer'},{name:'description',type:'text',nullable:true}],capability:'fixture'}],
  edge: [{name:'links',from:['probe'],to:['probe'],repeats:true,discriminator:'place',cardinality:{from:'many',to:'many'},labels:{en:{out:'links to',in:'linked from'},ru:{out:'ссылается',in:'ссылка из'}},fields:[{name:'weight',type:'integer'}],capability:'fixture'}],dictionary:[],
};
test('0039.25: graph identities have no mutable opinion state and assertion headers own all time',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph});try{
 const columns=await owner.run(tx=>tx.query<{table_name:string;column_name:string}>("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() ORDER BY table_name,ordinal_position"));
 const names=(table:string)=>columns.rows.filter(r=>r.table_name===table).map(r=>r.column_name);
 expect(names('node')).toEqual(['id','entity_id','uid','key','identity_scope','context_id']);
 expect(names('edge')).toEqual(['id','uid','entity_id','from_node','to_node','discriminator','context_id']);
 expect(names('assertion')).toEqual(['assertion_id','property','language','context_id','valid_from','valid_to','recorded_at','recorded_sequence','operation']);
 expect(names('assertion_vertex_subject')).toEqual(['assertion_id','subject_edge_id']);
 expect(names('assertion_edge_subject')).toEqual(['assertion_id','edge_id']);
 for(const [kind,sort,slot] of [['probe','vertex','amount'],['probe','vertex','description'],['probe','vertex','$exists'],['links','edge','weight'],['links','edge','$exists']] as const) expect(names(assertionValueTableName(kind,sort,slot))).toEqual(['assertion_id','value']);
 expect(names(generatedTableName('probe','vertex'))).toEqual([]);
 expect(columns.rows.filter(r=>['node','edge','assertion','assertion_vertex_subject','assertion_edge_subject'].includes(r.table_name)).some(r=>['said_by','evidence','state','confirmed_field'].includes(r.column_name))).toBe(false);
 expect((await owner.run(tx=>tx.query('SELECT * FROM context'))).rows).toMatchObject([{id:1,parent:null,ref:''}]);
 }finally{await owner.close();}
});
test('0039.25: every assertion has one graph subject and source, author, operation lineage',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph});try{
 await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:['a','b'].map(name=>({kind:'probe',key:{name},values:{amount:2},producer:'fixture',producerVersion:'1'})),edges:[{kind:'links',from:{kind:'probe',key:{name:'a'}},to:{kind:'probe',key:{name:'b'}},discriminator:'one',values:{weight:3},producer:'fixture',producerVersion:'1'}],removals:[]}));
 const headers=await owner.run(tx=>tx.query<{assertion_id:string;subjects:number;source:number;author:number;operation:number}>(`SELECT a.assertion_id::text,
 ((SELECT count(*) FROM assertion_vertex_subject s WHERE s.assertion_id=a.assertion_id)+(SELECT count(*) FROM assertion_edge_subject s WHERE s.assertion_id=a.assertion_id))::integer AS subjects,
 (SELECT count(*) FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.from_node=a.assertion_id AND k.name='system.assertion-source')::integer AS source,
 (SELECT count(*) FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.from_node=a.assertion_id AND k.name='system.assertion-author')::integer AS author,
 (SELECT count(*) FROM edge e JOIN entity k ON k.id=e.entity_id WHERE e.from_node=a.assertion_id AND k.name='system.assertion-operation')::integer AS operation FROM assertion a`));
 expect(headers.rows).toHaveLength(9);
 for(const row of headers.rows)expect(row).toMatchObject({subjects:1,source:1,author:1,operation:1});
 const edges=await owner.run(tx=>tx.query("SELECT e.discriminator FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='links'"));expect(edges.rows).toEqual([{discriminator:'one'}]);
 }finally{await owner.close();}
});
test('0039.25: generated typed values and their subject associations cannot mutate or disappear',async()=>{
 const owner=await createTestDatabaseOwner({graphContract:graph});try{
 await owner.transaction('write',tx=>publishGraphDrafts(tx,graph,{vertices:[{kind:'probe',key:{name:'a'},values:{amount:2},producer:'fixture',producerVersion:'1'}],removals:[]}));
 for(const table of ['assertion','assertion_vertex_subject',assertionValueTableName('probe','vertex','amount')]){
 await expect(owner.transaction('write',tx=>tx.query(`DELETE FROM "${table}"`))).rejects.toThrow('immutable');
 }
 await expect(owner.transaction('write',tx=>tx.query(`UPDATE "${assertionValueTableName('probe','vertex','amount')}" SET value=3`))).rejects.toThrow('immutable');
 const rows=await owner.run(tx=>tx.query(`SELECT value FROM "${assertionValueTableName('probe','vertex','amount')}"`));expect(rows.rows).toEqual([{value:2}]);
 }finally{await owner.close();}
});
