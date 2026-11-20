import {test,expect} from 'bun:test';
import {createTestDatabaseOwner} from './test-database.js';
import {createPgBossQueue} from '../src/adapters/pg-boss-queue.js';
import {prepareQueueSchema} from '../src/adapters/schemas/queue.js';
import {createOperationHost,initializeOperationScope} from '../src/graph/operation-host.js';
import {startupBinding} from '../src/graph/manifest-publication.js';
import {EMPTY_CONTRACT} from '../src/graph/contract.js';
import {newUid} from '../src/graph/uid.js';
import {withFillStateIn} from '../src/graph/fill-state.js';
import {boundWriteCapability} from '../src/graph/write.js';

for(const action of ['execute','fail'] as const)test(`host ${action} creates only its own operation`,async()=>{
 const owner=await createTestDatabaseOwner({authenticated:false});
 const declaration={name:'operation-count',leaseSeconds:60,retries:0,retryDelaySeconds:0,retryBackoff:false};
 await prepareQueueSchema(owner,{declarations:[declaration]});
 const queue=await createPgBossQueue({owner,supervise:false});
 try{
  await queue.declare(declaration);await queue.enqueue({queue:declaration.name,data:{}});
  const [job]=await queue.claim({queue:declaration.name});
  const runUid=newUid(),unitUid=newUid();
  const {binding,contract}=await owner.transaction('write',tx=>startupBinding(tx,EMPTY_CONTRACT,'host-count'));
  await owner.transaction('write',tx=>initializeOperationScope(tx,contract,binding,runUid,unitUid));
  const host=createOperationHost({owner,queue,job:job!,contract,capability:binding,runUid,unitUid});
  const count=async()=>Number((await owner.run(tx=>tx.query<{n:string}>("SELECT count(*)::text n FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='system.operation'"))).rows[0]!.n);
  const before=await count();
  if(action==='execute')await host.execute({key:'complete',request:{},completion:{output:{},enqueue:[]}},async()=>null);
  else expect(await host.fail('failed')).toBe(true);
  expect(await count()-before).toBe(1);
 }finally{await queue.stop();await owner.close();}
},30000);

test('a machine helper removes its binding when no caller was bound',async()=>{
 const owner=await createTestDatabaseOwner({authenticated:false});
 try{await owner.transaction('write',async tx=>{
  expect(boundWriteCapability(tx)).toBeUndefined();
  await withFillStateIn(tx,EMPTY_CONTRACT,undefined,async()=>expect(boundWriteCapability(tx)).toBeDefined());
  expect(boundWriteCapability(tx)).toBeUndefined();
 });}finally{await owner.close();}
},30000);
