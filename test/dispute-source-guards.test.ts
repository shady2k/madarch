import {expect,test} from 'bun:test';
import {amendmentFixture} from './dispute-amendment-fixture.js';
import {operation} from './dispute-operation-fixture.js';
import {writeAssertion} from '../src/graph/write.js';
import {readKindAssertions} from '../src/graph/records.js';

for(const change of ['disputed source existence','source and support withdrawn together'] as const)test(`support dependency guard: ${change}`,async()=>{
 const f=await amendmentFixture(true);try{
  const resolution=await f.resolve();
  const decision=(await f.rows()).find(row=>row.selected)!;
  const targetUid=await f.owner.transaction('snapshot',async tx=>(await tx.query<{uid:string}>("SELECT uid::text FROM node WHERE key->>'digest'=$1",[f.digest])).rows[0]!.uid);
  const before=await f.owner.transaction('snapshot',tx=>readKindAssertions(tx,'vertex','sample',['amount'],{contract:f.contract}));
  await operation(f,async tx=>{
   const file=(await tx.query<{id:string}>("SELECT id::text FROM node WHERE key->>'name'='file'")).rows[0]!;
   if(change==='disputed source existence'){
    await writeAssertion(tx,f.contract,{sort:'vertex',kind:'sample',subjectId:file.id,property:'$exists',operation:'assert',value:false,validFrom:'2020-01-01T00:00:00Z'});
   }else{
    const edge=(await tx.query<{id:string}>("SELECT e.id::text FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='justifies'")).rows[0]!;
    await writeAssertion(tx,f.contract,{sort:'edge',kind:'justifies',subjectId:edge.id,property:'$exists',operation:'retract'});
    await writeAssertion(tx,f.contract,{sort:'vertex',kind:'sample',subjectId:file.id,property:'$exists',operation:'retract'});
   }
  },change==='disputed source existence'?1:2);
  const current=await f.owner.transaction('snapshot',async tx=>({problems:await readKindAssertions(tx,'vertex','system.problem',['rule','fingerprint','reason'],{contract:f.contract}),rows:await readKindAssertions(tx,'vertex','sample',['amount'],{contract:f.contract})}));
  const view=await f.view(new Date().toISOString());
  const retracted=(await f.rows(new Date().toISOString())).some(row=>row.source===decision.source&&row.operation==='retract');
  if(change==='disputed source existence'){
   expect(view?.state).toBe('RESOLVED');
   expect(current.rows.find(row=>row.values.amount!==undefined)!.values.amount).toBe(before.find(row=>row.values.amount!==undefined)!.values.amount);
   expect(current.problems.some(row=>row.values.rule==='resolution-stale-evidence'&&row.values.fingerprint===`${resolution}:${targetUid}`&&String(row.values.reason).includes('source support is unavailable in this context'))).toBe(true);
   expect(retracted).toBe(false);
  }else{
   expect(view?.state).toBe('OPEN');
   expect(current.rows.find(row=>row.values.amount!==undefined)!.values.amount).toBe(2);
   expect(retracted).toBe(true);
   expect(current.problems.some(row=>row.values.rule==='resolution-stale-evidence')).toBe(false);
  }
 }finally{await f.owner.close();}
},30000);
