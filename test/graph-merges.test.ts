import {expect,test} from 'bun:test';
import { SQL_TRANSACTION_KINDS } from '../src/sql-driver.js';
import {createTestDatabaseOwner} from './test-database.js';
import {bindTestWriteCapability} from './write-capability-fixture.js';
import {pinContext} from '../src/graph/context.js';
import {generatedTableName,type GraphContract} from '../src/graph/contract.js';
import {withAssertionContract} from '../src/graph/system-contract.js';
import {publishGraphDrafts} from '../src/graph/write.js';
import {bindGraphProducer,activateGraphProducer,type ProducerBinding} from '../src/graph/producer-binding.js';
import {registerSystemSource} from '../src/graph/system-installation.js';
import {startupBinding} from '../src/graph/manifest-publication.js';
import {duplicateCandidates,resolveDuplicate,unmerge} from '../src/graph/merges.js';
import {readKindAssertions} from '../src/graph/records.js';
const productContract:GraphContract={vertex:['sample','other'].map(name=>({name,table:generatedTableName(name,'vertex'),key:['name'],capability:'fixture',fields:[{name:'name',type:'text' as const},{name:'synonyms',type:'json' as const,schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'array',items:{type:'string'}}},{name:'note',type:'text' as const,nullable:true}]})),edge:['related','shared'].map(name=>({name,from:['sample'],to:['other'],repeats:false,cardinality:{from:'many',to:name==='related'?'one':'many'},labels:{en:{out:'related',in:'related'},ru:{out:'related',in:'related'}},fields:[],capability:'fixture'})),dictionary:[]};
const contract:GraphContract=withAssertionContract(productContract);
async function fixture(declared:GraphContract=contract){
 const contract=declared;
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const scope=await owner.transaction(SQL_TRANSACTION_KINDS.write,async tx=>(await startupBinding(tx,contract,'fixture')).binding.productUid);
 const writer=await registerSystemSource(owner,contract,{type:'plugin',installationKey:'writer',scope,version:'1'});
 const resolver=await registerSystemSource(owner,contract,{type:'plugin',installationKey:'resolver',scope,version:'1'});
 const grants=(principal:typeof writer.principal,merge=false)=>bindGraphProducer(owner,contract,{principal,vertices:{sample:['synonyms','note'],other:['synonyms','note'],'system.content-snapshot':['content','digest'],...(contract.vertex.some(kind=>kind.name==='child')?{child:[]}: {})},edges:{related:[],shared:[],...(contract.edge.some(kind=>kind.name==='child-parent')?{'child-parent':[]}: {})},actions:merge?['assert','merge','retract-own']:['assert','retract-own']});
 const a=grants(writer.principal),r=grants(resolver.principal,true);
 const execute=async<T>(binding:ProducerBinding,apply:(tx:import('../src/sql-driver.js').SqlExecutor)=>Promise<T>)=>owner.transaction(SQL_TRANSACTION_KINDS.write,async tx=>{await activateGraphProducer(tx,contract,binding);return apply(tx);});
 const {createHash}=await import('node:crypto');const actual=createHash('sha256').update('Evidence').digest('hex');
 await execute(a,tx=>publishGraphDrafts(tx,contract,{vertices:[{kind:'system.content-snapshot',key:{digest:actual},values:{content:'Evidence'},producer:'fixture',producerVersion:'1'},...['one','two'].map(name=>({kind:'sample',key:{name},values:{synonyms:['shared'],note:name},producer:'fixture',producerVersion:'1'})),{kind:'other',key:{name:'parent'},values:{synonyms:[]},producer:'fixture',producerVersion:'1'}],edges:['related','shared'].flatMap(kind=>['one','two'].map(name=>({kind,from:{kind:'sample',key:{name}},to:{kind:'other',key:{name:'parent'}},producer:'fixture',producerVersion:'1'}))),removals:[]}));
 const rows=await owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['name','note','synonyms'],{contract}));
 const input={members:rows.map(row=>({kind:'sample',key:{},uid:row.uid})) as unknown as readonly [import('../src/graph/contract.js').EntityRefDraft,import('../src/graph/contract.js').EntityRefDraft],signals:{kind:'sample',name:'name',synonyms:'synonyms',edges:['related','shared']},decision:'sure' as const,reason:'Same entity checked',evidence:[{target:{kind:'system.content-snapshot',key:{digest:actual}}}]};
 return {owner,a,r,resolver,execute,rows,input};
}
async function expectNoKeyAllocations(owner:import('../src/adapters/database-owner.js').DatabaseOwner){
 const keys=await owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>tx.query(`SELECT a.assertion_id FROM edge allocation JOIN entity kind ON kind.id=allocation.entity_id AND kind.name='system.merge-allocation-assertion' JOIN assertion a ON a.assertion_id=allocation.to_node WHERE a.property='name'`));
 expect(keys.rows).toHaveLength(0);
}
test('0039.20/32 same-kind declared signals, authority, uncertainty and reversible memberships',async()=>{
 const f=await fixture();try{
 const candidates=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>duplicateCandidates(tx,contract,f.input.signals));expect(candidates).toHaveLength(1);expect(candidates[0]!.signals).toHaveLength(3);
 await expect(f.execute(f.a,tx=>resolveDuplicate(tx,contract,f.a,f.input))).rejects.toThrow('does not permit merge');
 const question=await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,{...f.input,decision:'unsure'}));expect(question.kind).toBe('system.merge-question');
 expect(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['name'],{contract}))).toHaveLength(2);
 const merged=await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,f.input));expect(merged.kind).toBe('system.merge');
 const current=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['name','note','synonyms'],{contract}));expect(current).toHaveLength(1);expect(current[0]!.values.synonyms).toContain('two');expect(current[0]!.assertions.filter(a=>a.property==='note')).toHaveLength(2);
 const edges=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'edge','related',[],{contract}));expect(new Set(edges.map(e=>e.from)).size).toBe(1);
 expect((await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:merged.uid,reason:'Separate after review',evidence:f.input.evidence}))).kind).toBe('system.merge');
 const restored=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['name','note'],{contract}));expect(restored).toHaveLength(2);expect(restored.map(row=>row.values.note).sort()).toEqual(['one','two']);
 }finally{await f.owner.close();}
},60000);
test('0039.32 later survivor edits block unmerge with a retained question, no lost edits',async()=>{
 const f=await fixture();try{
 const merged=await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,f.input));
 await f.execute(f.a,tx=>publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'one'},values:{note:'later'},producer:'fixture',producerVersion:'1'}],removals:[]}));
 const result=await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:merged.uid,reason:'Review',evidence:f.input.evidence}));expect(result.kind).toBe('system.merge-question');
 const current=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['note'],{contract}));expect(current).toHaveLength(1);expect(current[0]!.values.note).toBe('later');
 const {loadAssertions}=await import('../src/graph/assertion-read.js');
 const edits=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>loadAssertions(tx,'vertex','sample',['$exists','note'],[f.rows[0]!.id]));
 const latest=edits.find(a=>a.property==='note'&&a.value==='later')!;
 const allocations=edits.filter(a=>a.operationUid===latest.operationUid).map(a=>({assertionUid:a.id,memberUid:f.rows[0]!.uid}));
 const undone=await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:merged.uid,reason:'Allocated after review',evidence:f.input.evidence,allocations}));expect(undone.kind).toBe('system.merge');
 const restored=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['note'],{contract}));expect(restored).toHaveLength(2);expect(restored.find(row=>row.uid===f.rows[0]!.uid)!.values.note).toBe('later');
 await expectNoKeyAllocations(f.owner);
 }finally{await f.owner.close();}
},60000);

test('0039.20/32 names alone escalate; cross-kind is refused; conflicting required relations roll back',async()=>{
 const f=await fixture();try{
 expect((await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,{...f.input,signals:{...f.input.signals,edges:[]}}))).kind).toBe('system.merge-question');
 await expect(f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,{...f.input,members:[f.input.members[0],{...f.input.members[1],kind:'other'}]}))).rejects.toThrow('END_KIND_INVALID');
 await f.execute(f.a,tx=>publishGraphDrafts(tx,contract,{vertices:[{kind:'other',key:{name:'second'},values:{synonyms:[]},producer:'fixture',producerVersion:'1'}],removals:[],edgeRemovals:[{kind:'related',from:{kind:'sample',key:{name:'two'}},to:{kind:'other',key:{name:'parent'}},producer:'fixture'}],edges:[{kind:'related',from:{kind:'sample',key:{name:'two'}},to:{kind:'other',key:{name:'second'}},producer:'fixture',producerVersion:'1'}]}));
 await expect(f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,f.input))).rejects.toThrow('CARDINALITY_INVALID');
 expect(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['note'],{contract}))).toHaveLength(2);
 }finally{await f.owner.close();}
},60000);
test('0039.32 an edit addressed to the losing alias follows that member back',async()=>{
 const f=await fixture();try{
 const merged=await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,f.input));
 await f.execute(f.a,tx=>publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'two'},values:{note:'alias edit'},producer:'fixture',producerVersion:'1'}],removals:[]}));
 expect((await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:merged.uid,reason:'Review',evidence:f.input.evidence}))).kind).toBe('system.merge');
 const restored=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['name','note'],{contract}));expect(restored.find(row=>row.values.name==='two')!.values.note).toBe('alias edit');
 }finally{await f.owner.close();}
},60000);

test('0039.32 chained equivalence sets split only the undone link',async()=>{
 const f=await fixture();try{
 await f.execute(f.a,tx=>publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'three'},values:{synonyms:['shared'],note:'three'},producer:'fixture',producerVersion:'1'}],edges:['related','shared'].map(kind=>({kind,from:{kind:'sample',key:{name:'three'}},to:{kind:'other',key:{name:'parent'}},producer:'fixture',producerVersion:'1'})),removals:[]}));
 const third=(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['name'],{contract}))).find(row=>row.values.name==='three')!;
 const ab=await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,f.input));
 const bc=await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,{...f.input,members:[f.input.members[1],{kind:'sample',key:{},uid:third.uid}]}));
 expect(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['note'],{contract}))).toHaveLength(1);
 expect((await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:ab.uid,reason:'Split first',evidence:f.input.evidence}))).kind).toBe('system.merge');
 const split=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['note'],{contract}));expect(split).toHaveLength(2);
 expect(split.find(row=>row.uid===f.rows[1]!.uid)!.assertions.filter(a=>a.property==='note')).toHaveLength(2);
 await f.execute(f.a,tx=>publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'two'},values:{note:'after first split'},producer:'fixture',producerVersion:'1'}],removals:[]}));
 expect((await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:bc.uid,reason:'Needs allocation after first split',evidence:f.input.evidence}))).kind).toBe('system.merge-question');
 const {loadAssertions}=await import('../src/graph/assertion-read.js');
 const edits=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>loadAssertions(tx,'vertex','sample',['$exists','note'],[f.rows[1]!.id]));const latest=edits.find(row=>row.value==='after first split')!;
 const allocations=edits.filter(row=>row.operationUid===latest.operationUid).map(row=>({assertionUid:row.id,memberUid:third.uid}));
 expect((await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:bc.uid,reason:'Split second',evidence:f.input.evidence,allocations}))).kind).toBe('system.merge');
 expect(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['note'],{contract}))).toHaveLength(3);
 await expectNoKeyAllocations(f.owner);
 }finally{await f.owner.close();}
},120000);

test('0039.32 later edge assertions require directional allocation and restore original endpoints',async()=>{
 const f=await fixture();try{
 const merged=await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,f.input));
 await f.execute(f.a,tx=>publishGraphDrafts(tx,contract,{vertices:[{kind:'other',key:{name:'later'},values:{synonyms:[]},producer:'fixture',producerVersion:'1'}],edges:[{kind:'shared',from:{kind:'sample',key:{name:'one'}},to:{kind:'other',key:{name:'later'}},producer:'fixture',producerVersion:'1'}],removals:[]}));
 expect((await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:merged.uid,reason:'Needs attribution',evidence:f.input.evidence}))).kind).toBe('system.merge-question');
 const {loadAssertions}=await import('../src/graph/assertion-read.js');
 const rows=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>loadAssertions(tx,'edge','shared',['$exists']));
 const latest=rows.at(-1)!;
 const allocation={assertionUid:latest.id,memberUid:f.rows[1]!.uid,direction:'from' as const};
 await expect(f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:merged.uid,reason:'Invalid direction',evidence:f.input.evidence,allocations:[{...allocation,direction:'to'}]}))).rejects.toThrow('SCHEMA_INVALID');
 expect((await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:merged.uid,reason:'Source checked',evidence:f.input.evidence,allocations:[allocation]}))).kind).toBe('system.merge');
 const edges=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'edge','shared',[],{contract}));
 const target=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','other',['name'],{contract}));
 expect(edges.find(edge=>edge.to===target.find(row=>row.values.name==='later')!.id)!.from).toBe(f.rows[1]!.id);
 const original=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>tx.query<{from_node:number}>(`SELECT e.from_node FROM edge e WHERE e.uid=$1::uuid`,[latest.subject.type==='edge'?latest.subject.id:'']));expect(Number(original.rows[0]!.from_node)).toBe(f.rows[0]!.id);
 }finally{await f.owner.close();}
},60000);

test('0039.20 required subject boundary cannot be omitted or overridden',async()=>{
 const f=await fixture();try{
 const scoped:GraphContract={...contract,vertex:contract.vertex.map(kind=>kind.name==='sample'?{...kind,duplicateSubjectRequired:true,duplicateSubjectEdge:'related'}:kind)};
 expect(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>duplicateCandidates(tx,scoped,f.input.signals))).toHaveLength(1);
 await expect(f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>duplicateCandidates(tx,scoped,{...f.input.signals,subjectFieldEdge:'shared'}))).rejects.toThrow('cannot override');
 await f.execute(f.a,tx=>publishGraphDrafts(tx,contract,{vertices:[{kind:'other',key:{name:'different field'},values:{synonyms:[]},producer:'fixture',producerVersion:'1'}],removals:[],edgeRemovals:[{kind:'related',from:{kind:'sample',key:{name:'two'}},to:{kind:'other',key:{name:'parent'}},producer:'fixture'}],edges:[{kind:'related',from:{kind:'sample',key:{name:'two'}},to:{kind:'other',key:{name:'different field'}},producer:'fixture',producerVersion:'1'}]}));
 expect(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>duplicateCandidates(tx,scoped,f.input.signals))).toHaveLength(0);
 const missing:GraphContract={...scoped,vertex:scoped.vertex.map(kind=>kind.name==='sample'?{...kind,duplicateSubjectEdge:undefined}:kind)};
 await expect(f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>duplicateCandidates(tx,missing,f.input.signals))).rejects.toThrow('subject field relation required');
 }finally{await f.owner.close();}
},60000);

test('0039.32 allocations respect recorded snapshots and inherited contexts',async()=>{
 const f=await fixture();try{
 const merged=await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,f.input));
 await f.execute(f.a,tx=>publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'one'},values:{note:'allocated'},producer:'fixture',producerVersion:'1'}],removals:[]}));
 const {loadAssertions}=await import('../src/graph/assertion-read.js');
 const edits=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>loadAssertions(tx,'vertex','sample',['$exists','note'],[f.rows[0]!.id]));
 const latest=edits.find(row=>row.value==='allocated')!;
 const allocations=edits.filter(row=>row.operationUid===latest.operationUid).map(row=>({assertionUid:row.id,memberUid:f.rows[1]!.uid}));
 const before=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>tx.query<{at:string}>(`SELECT clock_timestamp()::text AS at`));
 await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:merged.uid,reason:'Checked attribution',evidence:f.input.evidence,allocations}));
 const current=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['note'],{contract}));expect(current.find(row=>row.uid===f.rows[1]!.uid)!.values.note).toBe('allocated');
 const past=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['note'],{contract,validAt:before.rows[0]!.at,recordedAt:before.rows[0]!.at}));expect(past).toHaveLength(1);
 expect(past[0]!.assertions.find(row=>row.value==='allocated')!.subjectId).toBe(f.rows[0]!.id);
 const child=await f.owner.transaction(SQL_TRANSACTION_KINDS.write,tx=>tx.query<{id:number}>(`INSERT INTO context(ref,parent) VALUES ('after-allocation',1) RETURNING id`));
 const inherited=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['note'],{contract,contexts:[Number(child.rows[0]!.id),1]}));expect(inherited.find(row=>row.uid===f.rows[1]!.uid)!.values.note).toBe('allocated');
 await expectNoKeyAllocations(f.owner);
 const allocation=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,async tx=>{
  const linked=await tx.query<{id:number}>(`SELECT allocation.from_node AS id FROM edge allocation JOIN entity kind ON kind.id=allocation.entity_id AND kind.name='system.merge-allocation-assertion' JOIN node assertion_node ON assertion_node.id=allocation.to_node WHERE assertion_node.uid=$1::uuid`,[latest.id]);
  expect(linked.rows).toHaveLength(1);
  return linked.rows[0]!;
 });
 const {writeAssertion}=await import('../src/graph/write.js');
 for(const interval of [{ref:'future-allocation',validFrom:'2100-01-01T00:00:00.000Z'},{ref:'expired-allocation',validFrom:'2000-01-01T00:00:00.000Z',validTo:'2001-01-01T00:00:00.000Z'}]){
  const context=Number(await f.owner.transaction(SQL_TRANSACTION_KINDS.write,tx=>pinContext(tx,'1',interval.ref)));
  await f.owner.transaction(SQL_TRANSACTION_KINDS.write,async tx=>{
   await bindTestWriteCapability(tx,contract,undefined,context);
   await writeAssertion(tx,contract,{sort:'vertex',kind:'system.merge-allocation',subjectId:String(allocation.id),property:'$exists',operation:'assert',value:true,validFrom:interval.validFrom,...('validTo' in interval?{validTo:interval.validTo}:{})},context);
  });
  const target=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>tx.query<{target:string}>(`SELECT graph_assertion_target($1::bigint,a.assertion_id,$2::bigint,'2050-01-01T00:00:00.000Z'::timestamptz,clock_timestamp())::text AS target FROM assertion a JOIN node assertion_node ON assertion_node.id=a.assertion_id WHERE assertion_node.uid=$3::uuid`,[f.rows[0]!.id,context,latest.id]));
  expect(Number(target.rows[0]!.target)).toBe(f.rows[0]!.id);
 }

 }finally{await f.owner.close();}
},60000);

test('0039.32 disputes on both members follow membership and split by immutable assertion subjects',async()=>{
 const f=await fixture();try{
 const {reconcileDisputes}=await import('../src/graph/disputes.js');
 const {listDisputeSlots}=await import('../src/graph/dispute-read.js');
 await f.execute(f.r,async tx=>{
 await publishGraphDrafts(tx,contract,{vertices:['one','two'].map(name=>({kind:'sample',key:{name},values:{note:'alternative '+name},producer:'fixture',producerVersion:'1'})),removals:[]});
 await reconcileDisputes(tx,contract);
 });
 const slots=()=>f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,async tx=>{const now=(await tx.query<{at:string}>(`SELECT clock_timestamp()::text AS at`)).rows[0]!.at;return (await listDisputeSlots(tx,contract,{contexts:[1],validAt:now,recordedAt:now})).filter(slot=>slot.kind==='sample'&&slot.property==='note');});
 const before=await slots();expect(new Set(before.map(slot=>slot.subjectId)).size).toBe(2);
 const merged=await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,f.input));
 const joined=await slots();expect(new Set(joined.map(slot=>slot.subjectId))).toEqual(new Set([f.rows[0]!.id]));expect(joined.every(slot=>slot.dispute.state==='OPEN')).toBe(true);
 await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:merged.uid,reason:'Split disputes',evidence:f.input.evidence}));
 const split=await slots();expect(new Set(split.map(slot=>slot.subjectId)).size).toBe(2);expect(split.every(slot=>slot.rows.every(row=>row.originalSubjectId===slot.subjectId))).toBe(true);
 }finally{await f.owner.close();}
},60000);

test('0039.32 future-dated survivor edits require allocation before split',async()=>{
 const f=await fixture();try{
 const merged=await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,f.input));
 const {writeAssertion}=await import('../src/graph/write.js');
 await f.execute(f.a,tx=>writeAssertion(tx,contract,{sort:'vertex',kind:'sample',subjectId:String(f.rows[0]!.id),property:'note',operation:'assert',value:'tomorrow',validFrom:new Date(Date.now()+86400000).toISOString()}));
 expect((await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:merged.uid,reason:'Retain future edit',evidence:f.input.evidence}))).kind).toBe('system.merge-question');
 }finally{await f.owner.close();}
},60000);

test('0039.32 a prior split allocation remains attributable in the remaining chain',async()=>{
 const f=await fixture();try{
 await f.execute(f.a,tx=>publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'three'},values:{synonyms:['shared'],note:'three'},producer:'fixture',producerVersion:'1'}],edges:['related','shared'].map(kind=>({kind,from:{kind:'sample',key:{name:'three'}},to:{kind:'other',key:{name:'parent'}},producer:'fixture',producerVersion:'1'})),removals:[]}));
 const third=(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['name'],{contract}))).find(row=>row.values.name==='three')!;
 const ab=await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,f.input));
 const bc=await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,{...f.input,members:[f.input.members[1],{kind:'sample',key:{},uid:third.uid}]}));
 await f.execute(f.a,tx=>publishGraphDrafts(tx,contract,{vertices:[{kind:'sample',key:{name:'one'},values:{note:'chain edit'},producer:'fixture',producerVersion:'1'}],removals:[]}));
 const {loadAssertions}=await import('../src/graph/assertion-read.js');
 const rows=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>loadAssertions(tx,'vertex','sample',['$exists','note'],[f.rows[0]!.id]));const edit=rows.find(row=>row.value==='chain edit')!;
 const edits=rows.filter(row=>row.operationUid===edit.operationUid);
 expect((await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:ab.uid,reason:'To B',evidence:f.input.evidence,allocations:edits.map(row=>({assertionUid:row.id,memberUid:f.rows[1]!.uid}))}))).kind).toBe('system.merge');
 expect((await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:bc.uid,reason:'Needs second attribution',evidence:f.input.evidence}))).kind).toBe('system.merge-question');
 expect((await f.execute(f.r,tx=>unmerge(tx,contract,f.r,{mergeUid:bc.uid,reason:'To C',evidence:f.input.evidence,allocations:edits.map(row=>({assertionUid:row.id,memberUid:third.uid}))}))).kind).toBe('system.merge');
 const restored=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['note'],{contract}));expect(restored.find(row=>row.uid===third.uid)!.values.note).toBe('chain edit');
 await expectNoKeyAllocations(f.owner);
 }finally{await f.owner.close();}
},120000);

test('0039.20/32 both immutable members must be inside the authenticated scope',async()=>{
 const f=await fixture();try{
 const scoped=bindGraphProducer(f.owner,contract,{principal:f.resolver.principal,scopeUid:f.rows[0]!.uid,vertices:{sample:['synonyms','note']},edges:{},actions:['assert','merge']});
 await expect(f.execute(scoped,tx=>resolveDuplicate(tx,contract,scoped,f.input))).rejects.toThrow('SOURCE_FORBIDDEN assertion outside authenticated scope');
 expect(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['name'],{contract}))).toHaveLength(2);
 expect(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','system.merge',['state'],{contract}))).toHaveLength(0);
 }finally{await f.owner.close();}
},60000);

test('0039.20/32 merge evidence validates immutable targets and content bounds atomically',async()=>{
 const f=await fixture();try{
 await expect(f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,{...f.input,evidence:[{target:f.input.members[0]}]}))).rejects.toThrow('EVIDENCE_INVALID');
 await expect(f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,{...f.input,evidence:[{...f.input.evidence[0]!,locator:{start:0,end:9}}]}))).rejects.toThrow('EVIDENCE_INVALID');
 expect(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['name'],{contract}))).toHaveLength(2);
 expect(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','system.merge',['state'],{contract}))).toHaveLength(0);
 }finally{await f.owner.close();}
},60000);

test('0039.32 a later immutable key edge needs no ordinary relation allocation on split',async()=>{
 const keyed:GraphContract=withAssertionContract({...productContract,vertex:[...productContract.vertex,{name:'child',table:generatedTableName('child','vertex'),key:['name'],keyEdges:[{role:'parent',edge:'child-parent',direction:'from',onDelete:'restrict'}],fields:[{name:'name',type:'text'}],capability:'fixture'}],edge:[...productContract.edge,{name:'child-parent',from:['child'],to:['sample'],repeats:false,cardinality:{from:'many',to:'one'},labels:{en:{out:'parent',in:'children'},ru:{out:'parent',in:'children'}},fields:[],capability:'fixture'}]});
 const f=await fixture(keyed);try{
 const merged=await f.execute(f.r,tx=>resolveDuplicate(tx,keyed,f.r,f.input));
 const {writeAssertion}=await import('../src/graph/write.js');
 await f.execute(f.a,tx=>writeAssertion(tx,keyed,{sort:'vertex',kind:'sample',subjectId:String(f.rows[0]!.id),property:'name',operation:'assert',value:'one'}));
 const parent={kind:'sample',key:{name:'one'}};
 await f.execute(f.a,tx=>publishGraphDrafts(tx,keyed,{vertices:[{kind:'child',key:{name:'later-child'},keyEdges:{parent},producer:'fixture',producerVersion:'1'}],removals:[]}));
 const before=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'edge','child-parent',[],{contract:keyed}));
 expect(before).toHaveLength(1);expect(before[0]!.to).toBe(f.rows[0]!.id);
 expect((await f.execute(f.r,tx=>unmerge(tx,keyed,f.r,{mergeUid:merged.uid,reason:'Key identity is not an ordinary relation edit',evidence:f.input.evidence}))).kind).toBe('system.merge');
 const after=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'edge','child-parent',[],{contract:keyed}));
 expect(after).toHaveLength(1);expect(after[0]!.uid).toBe(before[0]!.uid);expect(after[0]!.from).toBe(before[0]!.from);expect(after[0]!.to).toBe(f.rows[0]!.id);
 expect(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['name'],{contract:keyed}))).toHaveLength(2);
 }finally{await f.owner.close();}
},60000);

test('0039.32 nearest context merge state suppresses parent fallback outside its valid interval',async()=>{
 const f=await fixture();try{
 const merged=await f.execute(f.r,tx=>resolveDuplicate(tx,contract,f.r,f.input));
 const mergeRecord=(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','system.merge',['state'],{contract,subjectUids:[merged.uid]})))[0]!;
 const {writeAssertion}=await import('../src/graph/write.js');
 for(const interval of [{ref:'future-merge-state',validFrom:'2100-01-01T00:00:00.000Z'},{ref:'expired-merge-state',validFrom:'2000-01-01T00:00:00.000Z',validTo:'2001-01-01T00:00:00.000Z'}]){
  const child=Number(await f.owner.transaction(SQL_TRANSACTION_KINDS.write,tx=>pinContext(tx,'1',interval.ref)));
  await f.owner.transaction(SQL_TRANSACTION_KINDS.write,async tx=>{
   await bindTestWriteCapability(tx,contract,undefined,child);
   await writeAssertion(tx,contract,{sort:'vertex',kind:'system.merge',subjectId:String(mergeRecord.id),property:'state',operation:'assert',value:'UNDONE',validFrom:interval.validFrom,...('validTo' in interval?{validTo:interval.validTo}:{})},child);
  });
  const childRows=await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['note'],{contract,contexts:[child,1],validAt:'2050-01-01T00:00:00.000Z'}));
  expect(childRows).toHaveLength(2);expect(childRows.map(row=>row.uid).sort()).toEqual(f.rows.map(row=>row.uid).sort());
  expect(childRows.every(row=>row.assertions.every(assertion=>assertion.originalSubjectId===row.id))).toBe(true);
 }
 expect(await f.owner.transaction(SQL_TRANSACTION_KINDS.snapshot,tx=>readKindAssertions(tx,'vertex','sample',['note'],{contract,validAt:'2050-01-01T00:00:00.000Z'}))).toHaveLength(1);
 }finally{await f.owner.close();}
},60000);
