import {expect,test} from 'bun:test';
import {amendmentFixture} from './dispute-amendment-fixture.js';
import {operation} from './dispute-operation-fixture.js';
import {writeAssertion,publishGraphDrafts} from '../src/graph/write.js';
import {loadAssertions} from '../src/graph/assertion-read.js';
import {readDispute} from '../src/graph/dispute-read.js';
import {readKindAssertions} from '../src/graph/records.js';
import {sha256Hex} from '../src/graph/digest.js';

for(const change of ['second-support','retireSupport'] as const)test(`support dependency guard: ${change}`,async()=>{
 const f=await amendmentFixture(true);try{
  await f.resolve();
  const before=await f.owner.transaction('snapshot',tx=>readKindAssertions(tx,'vertex','sample',['amount'],{contract:f.contract}));
  await operation(f,async tx=>{
   if(change==='second-support'){
    const content='A second support target',digest=sha256Hex(Buffer.from(content));
    await publishGraphDrafts(tx,f.contract,{vertices:[{kind:'system.content-snapshot',key:{digest},values:{content},producer:'fixture',producerVersion:'1'}],edges:[{kind:'justifies',from:{kind:'system.content-snapshot',key:{digest}},to:{kind:'sample',key:{name:'file'}},producer:'fixture',producerVersion:'1'}],removals:[]});
   }else{
    const edge=(await tx.query<{id:string}>("SELECT e.id::text FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='justifies'")).rows[0]!;
    await writeAssertion(tx,f.contract,{sort:'edge',kind:'justifies',subjectId:edge.id,property:'$exists',operation:'retract'});
   }
  });
  const current=await f.owner.transaction('snapshot',async tx=>({question:await readDispute(tx,f.contract,await loadAssertions(tx,'vertex','sample',['amount']),{validAt:new Date().toISOString(),recordedAt:new Date().toISOString(),contexts:[1]}),problems:await readKindAssertions(tx,'vertex','system.problem',['rule','reason'],{contract:f.contract}),rows:await readKindAssertions(tx,'vertex','sample',['amount'],{contract:f.contract})}));
  if(change==='retireSupport'){expect(current.question?.state).toBe('OPEN');expect(current.rows[0]!.values.amount).toBe(2);}
  else{expect(current.question?.state).toBe('RESOLVED');expect(current.rows.find(row=>row.values.amount!==undefined)!.values.amount).toBe(before.find(row=>row.values.amount!==undefined)!.values.amount);expect(current.problems.some(row=>row.values.rule==='resolution-stale-evidence')).toBe(true);}
 }finally{await f.owner.close();}
},30000);
