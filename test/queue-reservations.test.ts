import {test,expect} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {prepareStore} from '../src/adapters/prepare-store.js';
import {createPgBossQueue} from '../src/adapters/pg-boss-queue.js';

test('publication completion and singleton contender both commit with the follow-up',async()=>{
 const owner=await createTestDatabaseOwner();
 const schema='deadlock_review';
 const declaration={name:'q',leaseSeconds:60,retries:0,retryDelaySeconds:0,retryBackoff:false,singletons:true};
 let queue;
 try {
  await prepareStore(owner,{queue:{schema,declarations:[declaration]}});
  queue=await createPgBossQueue({owner,schema,supervise:false});
  await queue.declare(declaration);
  await queue.enqueue({queue:'q',data:{},singletonKey:'K'});
  const [job]=await queue.claim({queue:'q'});
  let completeReady!:()=>void,insertReady!:()=>void;
  const completed=new Promise<void>(r=>completeReady=r);
  const inserting=new Promise<void>(r=>insertReady=r);
  const a=owner.transaction('write',async tx=>{
   expect(await queue!.fence(job!,tx)).toBe(true);
   expect(await queue!.complete('q',job!,{},tx)).toBe(true);
   completeReady();
   await inserting;
   expect((await queue!.enqueue({queue:'q',data:{followUp:true},singletonKey:'OTHER',transaction:tx})).created).toBe(true);
  });
  const b=(async()=>{
   await completed;
   return owner.transaction('write',async tx=>{
    const wrapped={...tx,query:async(text:string,values?:unknown[])=>{
     const result=tx.query(text,values);
     if(text.includes('INSERT INTO')&&text.includes('.job'))insertReady();
     return result;
    }};
    expect((await queue!.enqueue({queue:'q',data:{contender:true},singletonKey:'K',transaction:wrapped})).created).toBe(true);
   });
  })();
  const results=await Promise.allSettled([a,b]);
  console.log('DEADLOCK RESULTS',JSON.stringify(results,(_key,value)=>value instanceof Error?{message:value.message,code:(value as any).code,detail:(value as any).detail}:value));
  expect(results).toEqual([{status:'fulfilled',value:undefined},{status:'fulfilled',value:undefined}]);
  expect((await queue.job('q',job!.id))?.state).toBe('completed');
  expect((await queue.enqueue({queue:'q',data:{},singletonKey:'K'})).created).toBe(false);
  expect((await queue.enqueue({queue:'q',data:{},singletonKey:'OTHER'})).created).toBe(false);
  expect(await owner.run(tx=>tx.query("SELECT id FROM deadlock_review.job WHERE state='created'"))).toMatchObject({rows:expect.arrayContaining([expect.anything(),expect.anything()])});
 }finally{await queue?.stop();await owner.close();}
},60000);

import type { OuterTransaction } from '../src/history-types.js';
import { prepareQueueSchema } from '../src/adapters/schemas/queue.js';

const ordered = {name:'ordered',leaseSeconds:60,retries:2,retryDelaySeconds:0,retryBackoff:false,singletons:true};
const tick = '2026-01-01T00:00:00.000Z';
function gate() {
 let open!:()=>void;
 const ready = new Promise<void>(resolve=>{open=resolve;});
 return {ready,open};
}
function instrument(tx:OuterTransaction, before?:(sql:string,values?:readonly unknown[])=>Promise<void>, after?:(sql:string)=>Promise<void>):OuterTransaction {
 return {async query<Row extends object>(sql:string,values?:readonly unknown[]) {
  await before?.(sql,values);
  const result = await tx.query<Row>(sql.replaceAll('clock_timestamp()',`'${tick}'::timestamptz`),values);
  await after?.(sql);
  return result;
 }};
}
async function fixture(work:(owner:Awaited<ReturnType<typeof createTestDatabaseOwner>>,queue:Awaited<ReturnType<typeof createPgBossQueue>>)=>Promise<void>) {
 const owner=await createTestDatabaseOwner({authenticated:false});
 await prepareQueueSchema(owner,{declarations:[ordered,{...ordered,name:'other'}]});
 const queue=await createPgBossQueue({owner,supervise:false});
 try {await queue.declare(ordered);await queue.declare({...ordered,name:'other'});await work(owner,queue);}
 finally {await queue.stop();await owner.close();}
}
async function places(owner:Awaited<ReturnType<typeof createTestDatabaseOwner>>) {
 return (await owner.run(tx=>tx.query<{n:number;ms:string}>("SELECT (data->>'n')::int AS n, (extract(epoch FROM created_on)*1000)::text AS ms FROM pgboss.job WHERE name='ordered' ORDER BY created_on"))).rows;
}

test('opposite queue sends finish before either caller commits',async()=>{
 await fixture(async(owner,queue)=>{
  const first=[gate(),gate()];const second=[gate(),gate()];
  await Promise.all([0,1].map(i=>owner.transaction('write',async tx=>{
   await tx.query("SET LOCAL statement_timeout='4s'");
   const transaction=instrument(tx);
   expect((await queue.enqueue({queue:i===0?'ordered':'other',data:{},singletonKey:`first-${i}`,transaction})).created).toBe(true);
   first[i]!.open();await first[1-i]!.ready;
   expect((await queue.enqueue({queue:i===0?'other':'ordered',data:{},singletonKey:`second-${i}`,transaction})).created).toBe(true);
   second[i]!.open();await second[1-i]!.ready;
  })));
 });
},60000);

for (const commitBeforeTry of [false,true]) test(`same proposed slot: ${commitBeforeTry?'predecessor commits between initial read and try':'reservation holder stays uncommitted'}`,async()=>{
 await fixture(async(owner,queue)=>{
  const held=gate(),release=gate(),initial=gate(),proceed=gate(),finished=gate();
  let probes=0;
  const first=owner.transaction('write',async tx=>{
   await queue.enqueue({queue:'ordered',data:{n:1},singletonKey:'a',transaction:instrument(tx)});
   held.open();await release.ready;
  });
  await held.ready;
  const second=owner.transaction('write',async tx=>{
   await tx.query("SET LOCAL statement_timeout='4s'");
   const transaction=instrument(tx,async sql=>{
    if(sql.includes('pg_try_advisory_xact_lock')) {probes++;if(probes===1){initial.open();await proceed.ready;}}
   });
   await queue.enqueue({queue:'ordered',data:{n:2},singletonKey:'b',transaction});
   finished.open();
  });
  await initial.ready;
  if(commitBeforeTry){release.open();await first;}
  proceed.open();
  try {await second;await finished.ready;} finally {release.open();await first;}
  const rows=await places(owner);
  expect(rows.map(r=>r.n)).toEqual([1,2]);
  expect(Number(rows[1]!.ms)-Number(rows[0]!.ms)).toBe(1);
  expect(probes).toBe(2);
 });
},60000);

test('fractional retained predecessor rounds up; repeated sends include all states; rollback releases its slot',async()=>{
 await fixture(async(owner,queue)=>{
  await queue.enqueue({queue:'ordered',data:{n:0},singletonKey:'zero'});
  await owner.run(tx=>tx.query(`UPDATE pgboss.job SET created_on='${tick}'::timestamptz+interval '0.25 milliseconds'`));
  const [job]=await queue.claim({queue:'ordered'});
  await owner.transaction('write',async tx=>{
   const transaction=instrument(tx);
   await queue.enqueue({queue:'ordered',data:{n:1},singletonKey:'one',transaction});
   await queue.enqueue({queue:'ordered',data:{n:2},singletonKey:'two',transaction});
  });
  await queue.fail('ordered',job!,'retry');
  let rolledBack:string|undefined;
  await expect(owner.transaction('write',async tx=>{
   const transaction=instrument(tx,async(sql,values)=>{if(sql.includes('pg_try_advisory_xact_lock'))rolledBack=String(values![0]);});
   await queue.enqueue({queue:'ordered',data:{n:99},singletonKey:'rollback',transaction});
   throw new Error('rollback allocation');
  })).rejects.toThrow('rollback allocation');
  let reused:string|undefined;
  await owner.transaction('write',async tx=>{
   await queue.enqueue({queue:'ordered',data:{n:3},singletonKey:'three',transaction:instrument(tx,async(sql,values)=>{if(sql.includes('pg_try_advisory_xact_lock'))reused=String(values![0]);})});
  });
  expect(reused).toBe(rolledBack);
  const rows=await places(owner);
  expect(rows.map(r=>r.n)).toEqual([0,1,2,3]);
  expect(Number(rows[1]!.ms)%1000).toBe(2);
  for(let i=1;i<rows.length;i++)expect(Number(rows[i]!.ms)-Number(rows[i-1]!.ms)).toBeGreaterThanOrEqual(1);
 });
},60000);

test('unsupported transaction isolation rolls back; folded singleton needs no reservation',async()=>{
 await fixture(async(owner,queue)=>{
  await queue.enqueue({queue:'ordered',data:{},singletonKey:'held'});
  await owner.transaction('write',async tx=>{
   const transaction=instrument(tx,async sql=>{expect(sql.includes('pg_try_advisory_xact_lock')).toBe(false);});
   expect(await queue.enqueue({queue:'ordered',data:{},singletonKey:'held',transaction})).toEqual({created:false,id:null});
  });
  for(const isolation of ['REPEATABLE READ','SERIALIZABLE']) {
   await expect(owner.transaction('write',async tx=>{
    await tx.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
    await queue.enqueue({queue:'ordered',data:{},singletonKey:isolation,transaction:tx});
   })).rejects.toThrow('READ COMMITTED');
  }
  expect((await owner.run(tx=>tx.query('SELECT id FROM pgboss.job'))).rows).toHaveLength(1);
 });
},60000);

test('measure burst and long caller transaction reservation probes and latency',async()=>{
 await fixture(async(owner,queue)=>{
  let probes=0;const latencies:number[]=[];
  async function send(tx:OuterTransaction,n:number){
   const start=performance.now();
   await queue.enqueue({queue:'ordered',data:{n},singletonKey:`n-${n}`,transaction:instrument(tx,async sql=>{if(sql.includes('pg_try_advisory_xact_lock'))probes++;})});
   latencies.push(performance.now()-start);
  }
  const start=performance.now();
  await owner.transaction('write',async tx=>{for(let i=0;i<50;i++)await send(tx,i);});
  const burst={ms:performance.now()-start,probes};
  probes=0;latencies.length=0;
  const parallelStart=performance.now();
  await Promise.all(Array.from({length:8},(_,i)=>owner.transaction('write',async tx=>{for(let j=0;j<8;j++)await send(tx,100+i*8+j);})));
  const concurrent={ms:performance.now()-parallelStart,probes,maxSendMs:Math.max(...latencies)};
  probes=0;latencies.length=0;
  const held=gate(),release=gate();
  const longStart=performance.now();
  const long=owner.transaction('write',async tx=>{
   await send(tx,1000);held.open();await release.ready;await send(tx,1001);
  });
  await held.ready;
  try {await owner.transaction('write',async tx=>{for(let i=0;i<50;i++)await send(tx,1100+i);});}
  finally {release.open();await long;}
  const longCaller={ms:performance.now()-longStart,probes,maxSendMs:Math.max(...latencies)};
  console.log('RESERVATION MEASUREMENTS',JSON.stringify({burst,concurrent,longCaller}));
  expect(burst.probes).toBe(50);
  const rows=await places(owner);
  expect(rows).toHaveLength(166);
  for(let i=1;i<rows.length;i++)expect(Number(rows[i]!.ms)-Number(rows[i-1]!.ms)).toBeGreaterThanOrEqual(1);
 });
},60000);

test('terminal retained maxima count in the same transaction',async()=>{
 await fixture(async(owner,queue)=>{
  await owner.transaction('write',async tx=>{
   const transaction=instrument(tx);
   let previous:string|null=null;
   for(const [n,state] of ['completed','cancelled','failed'].entries()) {
    const sent=await queue.enqueue({queue:'ordered',data:{n},singletonKey:`terminal-${n}`,transaction});
    if(previous!==null) {
     const gap=await tx.query<{gap:string}>("SELECT extract(epoch FROM (a.created_on-b.created_on))*1000 AS gap FROM pgboss.job a,pgboss.job b WHERE a.id=$1 AND b.id=$2",[sent.id,previous]);
     expect(Number(gap.rows[0]!.gap)).toBe(1);
    }
    await tx.query('UPDATE pgboss.job SET state=$2::pgboss.job_state WHERE id=$1',[sent.id,state]);
    previous=sent.id;
   }
   await queue.enqueue({queue:'ordered',data:{n:3},singletonKey:'last',transaction});
  });
  expect((await places(owner)).map(r=>Number(r.ms))).toEqual([0,1,2,3].map(n=>Date.parse(tick)+n));
 });
},60000);

test('fractional wall clock is sampled once even when the first reservation is held',async()=>{
 await fixture(async(owner,queue)=>{
  const held=gate(),release=gate();
  const candidate=gate();
  let reservedSql='';let reservedValues:readonly unknown[]|undefined;
  const blocker=owner.transaction('write',async other=>{
   await candidate.ready;
   expect((await other.query<{acquired:boolean}>(reservedSql,reservedValues)).rows[0]!.acquired).toBe(true);
   held.open();await release.ready;
  });
  let samples=0,probes=0;
  try {
   await owner.transaction('write',async tx=>{
    const transaction:OuterTransaction={async query<Row extends object>(sql:string,values?:readonly unknown[]) {
     if(sql.includes('clock_timestamp()')) {
      samples++;
      sql=sql.replaceAll('clock_timestamp()',`'2026-01-0${samples}T00:00:00.00025Z'::timestamptz`);
     }
     if(sql.includes('pg_try_advisory_xact_lock')&&++probes===1) {
      reservedSql=sql;reservedValues=values;candidate.open();
      await held.ready;
     }
     return await tx.query<Row>(sql,values);
    }};
    await queue.enqueue({queue:'ordered',data:{n:1},singletonKey:'fractional',transaction});
   });
  } finally {release.open();await blocker;}
  expect(samples).toBe(1);
  expect(probes).toBe(2);
  expect(Number((await places(owner))[0]!.ms)).toBe(Date.parse(tick)+2);
 });
},60000);

test('catching an isolation refusal cannot commit the provisional job',async()=>{
 await fixture(async(owner,queue)=>{
  await expect(owner.transaction('write',async tx=>{
   await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
   await expect(queue.enqueue({queue:'ordered',data:{},singletonKey:'refused',transaction:tx})).rejects.toThrow('READ COMMITTED');
   await expect(tx.query('SELECT 1')).rejects.toThrow('current transaction is aborted');
  })).rejects.toThrow('cannot be committed');
  expect((await owner.run(tx=>tx.query('SELECT id FROM pgboss.job'))).rows).toEqual([]);
 });
},60000);
