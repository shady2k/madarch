import {activateGraphProducer} from '../src/graph/producer-binding.js';
import {initializeOperationScope,createOperationHost} from '../src/graph/operation-host.js';
import {createPgBossQueue} from '../src/adapters/pg-boss-queue.js';
import {prepareQueueSchema} from '../src/adapters/schemas/queue.js';
import {requireWriteCapability} from '../src/graph/write.js';
import {amendmentFixture} from './dispute-amendment-fixture.js';

export async function operation(f:Awaited<ReturnType<typeof amendmentFixture>>,apply:(tx:import('../src/sql-driver.js').SqlExecutor)=>Promise<unknown>,bindingIndex=2){
 const queue=await createPgBossQueue({owner:f.owner,supervise:false});
 try{
  const declaration={name:'dependency-guard',leaseSeconds:60,retries:0,retryDelaySeconds:0,retryBackoff:false};
  await prepareQueueSchema(f.owner,{declarations:[declaration]});await queue.declare(declaration);
  await queue.enqueue({queue:declaration.name,data:{}});const [job]=await queue.claim({queue:declaration.name});
  const runUid=crypto.randomUUID(),unitUid=crypto.randomUUID();
  const capability=await f.owner.transaction('write',async tx=>{await activateGraphProducer(tx,f.contract,f.bindings[bindingIndex]!);const capability=requireWriteCapability(tx);await initializeOperationScope(tx,f.contract,capability,runUid,unitUid);return capability;});
  const host=createOperationHost({owner:f.owner,queue,job:job!,contract:f.contract,capability,runUid,unitUid});
  await host.execute({key:'change-support',request:{}},tx=>apply(tx));
 }finally{await queue.stop();}
}
