import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTestDatabaseOwner} from './test-database.js';
import {writeFolderManifest} from './catalog-folder-fixture.js';
import {validateProductManifests,publishValidatedManifests,startupBinding} from '../src/graph/manifest-publication.js';
import {graphContractOf} from '../src/fill/stages/plugin-contract.js';
import {withManifestContract} from '../src/graph/manifest-contract.js';
import {createOperationHost,initializeOperationScope} from '../src/graph/operation-host.js';
import {createPgBossQueue} from '../src/adapters/pg-boss-queue.js';
import {prepareQueueSchema} from '../src/adapters/schemas/queue.js';
import {declareProducerScope,storedApplicability} from '../src/graph/applicability.js';
import {execFileSync} from 'node:child_process';
import {newUid} from '../src/graph/uid.js';
import {readKindAssertions} from '../src/graph/records.js';

const cases = [
 {outcome: 'completed', produced: 1, state: 'applicable'},
 {outcome: 'unchanged', produced: 1, state: 'applicable'},
 {outcome: 'completed', produced: 0, state: 'empty'},
 {outcome: 'unchanged', produced: 0, state: 'empty'},
 {outcome: 'empty', produced: 0, state: 'empty'},
 {outcome: 'abstained', produced: 0, state: 'failed'},
 {outcome: 'failed', produced: 0, state: 'failed'},
] as const;
for (const {outcome, produced, state} of cases) test(`0039.35 producer ${outcome} with ${produced} instances maps to applicability with immutable evidence`,async()=>{
 const folder=mkdtempSync(join(tmpdir(),'outcome-applicability-'));mkdirSync(join(folder,'madarch'));
 writeFolderManifest(folder,`kinds:
  sample:
    source: graph
  dependent:
    source: graph
    applicability: {dependencies: [sample], markers: []}
`);
 execFileSync('git',['init','-q',folder]);execFileSync('git',['-C',folder,'add','.']);execFileSync('git',['-C',folder,'-c','user.name=Test','-c','user.email=test@example.org','commit','-qm','fixture']);
 const validated=validateProductManifests(folder);
 if(!validated.ok || !validated.value)throw new Error(JSON.stringify(validated));
 const contract=withManifestContract(graphContractOf(validated.value.manifest));
 const owner=await createTestDatabaseOwner({graphContract:contract});
 const declaration={name:'applicability-outcome',leaseSeconds:60,retries:0,retryDelaySeconds:0,retryBackoff:false};
 await prepareQueueSchema(owner,{declarations:[declaration]});
 const queue=await createPgBossQueue({owner,supervise:false});
 try {
  await publishValidatedManifests(owner,validated.value,contract);
  await queue.declare(declaration);await queue.enqueue({queue:declaration.name,data:{}});
  const [job]=await queue.claim({queue:declaration.name});
  const {binding}=await owner.transaction('write',tx=>startupBinding(tx,contract,'fixture-producer'));
  const runUid=newUid(),unitUid=newUid();
  await owner.transaction('write',tx=>initializeOperationScope(tx,contract,binding,runUid,unitUid));
  const host=createOperationHost({owner,queue,job:job!,contract,capability:binding,runUid,unitUid});
  await host.execute({key:'scope',request:{}},async tx=>{await declareProducerScope(tx,contract,'sample','fixture-producer');return {};});
  if(outcome==='failed')await host.fail('repository unreadable');
  else await host.execute({key:'complete',request:{},completion:{output:{},enqueue:[],outcome:{plugin:'fixture-producer',kind:'sample',outcome,produced,reason:'Searched the complete fixture tree'}}},async()=>({}));
  const marks=await storedApplicability(owner,contract);
  const mark=marks.find(mark=>mark.kind==='sample');
  expect(mark?.state).toBe(state);
  expect(mark?.evidence.length).toBe(1);
  const units = await owner.run(tx => readKindAssertions(tx, 'vertex', 'system.unit', ['outcome'], {contract, subjectUids: [unitUid]}));
  const recordedOutcome = units[0]?.selectedAssertions.find(assertion => assertion.property === 'outcome');
  expect(recordedOutcome?.value).toBe(outcome);
  expect(mark?.evidence).toEqual([recordedOutcome!.id]);
  expect(mark?.reason).toContain(outcome==='failed'?'repository unreadable':'Searched the complete fixture tree');
  expect(marks.find(mark=>mark.kind==='dependent')).toBeUndefined();
 } finally {await queue.stop();await owner.close();rmSync(folder,{recursive:true,force:true});}
},30000);
