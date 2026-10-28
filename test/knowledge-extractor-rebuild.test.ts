import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test,spyOn} from 'bun:test';
import {createPGliteDatabaseOwner,type DatabaseOwner} from '../src/adapters/database-owner.js';
import * as indexRuntime from '../src/knowledge/index/run.js';
import {runFillWorker} from '../src/knowledge/fill-worker.js';
import type {FromWorker,WorkerStart} from '../src/knowledge/fill-protocol.js';
test('persistent worker rebuild holds old snapshots until complete index and leaves Markdown untouched',async()=>{
 const root=mkdtempSync(join(tmpdir(),'madarch-worker-rebuild-'));const product=join(root,'product');const repository=join(root,'repo');mkdirSync(product);mkdirSync(repository);
 const graph=join(root,'state','graph');const reads=join(root,'state','read');const page=join(product,'kept.md');writeFileSync(page,'# Person\nExact é.\n');const markdown=readFileSync(page);
 const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{cwd:repository,env:{...process.env,GIT_AUTHOR_NAME:'Example',GIT_AUTHOR_EMAIL:'example@example.test',GIT_COMMITTER_NAME:'Example',GIT_COMMITTER_EMAIL:'example@example.test'}});
 git('init','-q','-b','main');writeFileSync(join(repository,'main.ts'),'export function run() {return 1;}');git('add','.');git('commit','-qm','One');
 const start:WorkerStart={type:'start',productFolder:product,productName:'Example',graphPath:graph,readRoot:reads,repositories:[{name:'code',path:repository}],writer:false,language:'en',languageChanged:false,snapshotMs:0};
 const run=async(request:WorkerStart)=>{const messages:FromWorker[]=[];const lines={async *[Symbol.asyncIterator](){yield JSON.stringify(request);await new Promise<void>(()=>{});}};expect(await runFillWorker({lines,send:(message)=>messages.push(message)})).toBe(0);return messages;};
 try {
  const first=await run(start);expect(first.some((message)=>message.type==='rebuild')).toBe(true);
  const done=first.findIndex((message)=>message.type==='fill'&&message.state==='done');const snapshot=first.findIndex((message)=>message.type==='snapshot');expect(snapshot).toBeGreaterThan(-1);expect(done).toBeGreaterThan(snapshot);
  const oldSnapshots=readdirSync(reads).filter((name)=>/^\d+$/.test(name));const oldManifest=readFileSync(join(graph,'extractors.json'));
  writeFileSync(join(graph,'extractors.json'),'{}');
  const failed=await run({...start,repositories:[{name:'missing',path:join(root,'missing')}]});expect(failed.some((message)=>message.type==='fill'&&message.state==='failed')).toBe(true);expect(failed.some((message)=>message.type==='snapshot')).toBe(false);expect(readdirSync(reads).filter((name)=>/^\d+$/.test(name))).toEqual(oldSnapshots);expect(readFileSync(page)).toEqual(markdown);
  const retry=await run(start);expect(retry.some((message)=>message.type==='rebuild')).toBe(true);expect(readFileSync(join(graph,'extractors.json'))).toEqual(oldManifest);
  const newer=readdirSync(reads).filter((name)=>/^\d+$/.test(name)).map(Number);expect(Math.min(...newer.filter((number)=>!oldSnapshots.includes(String(number))))).toBeGreaterThan(Math.max(...oldSnapshots.map(Number)));
  const repeated=await run(start);expect(repeated.some((message)=>message.type==='rebuild')).toBe(false);expect(readFileSync(page)).toEqual(markdown);
 } finally {rmSync(root,{recursive:true,force:true});}
},90000);


const originalIndexWorkerProduct=indexRuntime.indexWorkerProduct;
function inputChannel(){const queue:string[]=[];let wake:(()=>void)|undefined;let ended=false;return {push:(value:unknown)=>{queue.push(JSON.stringify(value));wake?.();},end:()=>{ended=true;wake?.();},lines:{async *[Symbol.asyncIterator](){for(;;){while(queue.length)yield queue.shift()!;if(ended)return;await new Promise<void>((resolve)=>{wake=resolve;});}}}};}
test('late history, Markdown index, closed-owner stop and EOF abort stage without done or writer handshake',async()=>{
 const root=mkdtempSync(join(tmpdir(),'madarch-worker-cancel-'));const product=join(root,'product');const repository=join(root,'repo');mkdirSync(product);mkdirSync(repository);writeFileSync(join(product,'page.md'),'# Person\nExact é.');const before=readFileSync(join(product,'page.md'));
 const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{cwd:repository,env:{...process.env,GIT_AUTHOR_NAME:'Example',GIT_AUTHOR_EMAIL:'example@example.test',GIT_COMMITTER_NAME:'Example',GIT_COMMITTER_EMAIL:'example@example.test'}});git('init','-q','-b','main');writeFileSync(join(repository,'main.ts'),'export function run(){return 1;}');git('add','.');git('commit','-qm','One');
 const probe=createPGliteDatabaseOwner();const ownerPrototype=Object.getPrototypeOf(probe) as DatabaseOwner;await probe.close();const realClose=ownerPrototype.close;
 try {for(const phase of ['history','index','close','eof'] as const){
  const graph=join(root,phase,'graph');mkdirSync(graph,{recursive:true});writeFileSync(join(graph,'previous'),'working graph');const reads=join(root,phase,'read');mkdirSync(join(reads,'3'),{recursive:true});writeFileSync(join(reads,'3','previous'),'working snapshot');
  const input=inputChannel();const said:FromWorker[]=[];const stop=()=>input.push({type:'stop'});let fired=false;
  const close=spyOn(ownerPrototype,'close').mockImplementation(async function(this:DatabaseOwner){await realClose.call(this);if(phase==='close'&&!fired){fired=true;stop();await new Promise<void>((resolve)=>setImmediate(resolve));}});
  const realIndex=originalIndexWorkerProduct;const index=spyOn(indexRuntime,'indexWorkerProduct').mockImplementation(async(options)=>{const result=await realIndex(options);if(phase==='index'){stop();await new Promise<void>((resolve)=>setImmediate(resolve));}return result;});
  input.push({type:'start',productFolder:product,productName:'Example',graphPath:graph,readRoot:reads,repositories:[{name:'code',path:repository}],writer:true,language:'en',languageChanged:false,snapshotMs:0});
  try {const work=runFillWorker({lines:input.lines,send:(message)=>{said.push(message);if(message.type==='phase'&&message.phase==='history'&&!fired&&(phase==='history'||phase==='eof')){fired=true;if(phase==='eof')input.end();else stop();}}});expect(await work).toBe(0);expect(said.some((message)=>message.type==='fill'&&message.state==='stopped')).toBe(true);expect(said.some((message)=>message.type==='fill'&&message.state==='done')).toBe(false);expect(said.some((message)=>message.type==='agent-wanted'||message.type==='snapshot')).toBe(false);expect(readFileSync(join(graph,'previous'),'utf8')).toBe('working graph');expect(readdirSync(reads)).toEqual(['3']);expect(readFileSync(join(product,'page.md'))).toEqual(before);
  } finally {input.end();index.mockRestore();close.mockRestore();}
 }} finally {rmSync(root,{recursive:true,force:true});}
},120000);
