import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,test,spyOn} from 'bun:test';
import {KnowledgeProduct} from '../src/knowledge/product.js';
import {RemoteOwner} from '../src/knowledge/remote-owner.js';
import {createPGliteDatabaseOwner,type DatabaseOwner} from '../src/adapters/database-owner.js';
import {createGraphStore} from '../src/graph/index.js';
import {takeSnapshot} from '../src/knowledge/fill-worker.js';
import type {RepositoryPin} from '../src/knowledge/fill-protocol.js';
/** Inspect the existing private activation boundary, without adding a product API just for a test. */
type PinBoundary={reader:{owner:DatabaseOwner;seq:number;path:string};pins:Map<string,RepositoryPin>;open:()=>Promise<DatabaseOwner>;readRoot:()=>string;swapReader:(seq:number,pins:RepositoryPin[])=>Promise<void>;loadPins:(owner:DatabaseOwner)=>Promise<void>};
const pin=(name:string,scope:string):RepositoryPin=>({name,scope,head:name,commit:name,effectiveTime:'2025-01-01T00:00:00Z',commits:1,filledCommits:1});
test('snapshot activation replaces complete pins on reused scope only after successful warm; delayed notices cannot clobber',async()=>{
 const root=mkdtempSync(join(tmpdir(),'madarch-rebuild-pins-'));const graph=join(root,'graph');const reads=join(root,'read');
 const maker=createPGliteDatabaseOwner({path:graph,btreeGist:true});await maker.ready;await createGraphStore(maker).createSchema();const seq=await takeSnapshot(maker,graph,reads);await maker.close();
 const product=new KnowledgeProduct({productFolder:root,storeRoot:root});const boundary=product as unknown as PinBoundary;
 const old=Object.create(RemoteOwner.prototype) as RemoteOwner;Object.assign(old,{close:async()=>undefined,recent:()=>[]});boundary.reader={owner:old,seq:0,path:join(reads,'0')};boundary.open=async()=>boundary.reader.owner;boundary.readRoot=()=>reads;boundary.pins.set('A',pin('A','7'));boundary.pins.set('B',pin('B','8'));
 const failing={transaction:async()=>{throw new Error('injected pin query failure');}} as unknown as DatabaseOwner;await expect(boundary.loadPins(failing)).rejects.toThrow('pin query failure');expect([...boundary.pins.keys()]).toEqual(['A','B']);
 const warm=spyOn(RemoteOwner.prototype,'warm').mockRejectedValueOnce(new Error('injected warm failure'));
 try {
  await expect(boundary.swapReader(seq,[pin('B','7')])).rejects.toThrow('injected warm failure');expect(boundary.reader.owner).toBe(old);expect([...boundary.pins.keys()]).toEqual(['A','B']);
  warm.mockRestore();await boundary.swapReader(seq,[pin('B','7')]);expect(boundary.reader.seq).toBe(seq);expect([...boundary.pins.values()]).toEqual([pin('B','7')]);expect([...boundary.pins.values()].find((item)=>item.scope==='7')?.name).toBe('B');
  await boundary.swapReader(0,[pin('A','7')]);await boundary.swapReader(seq,[pin('A','7')]);expect([...boundary.pins.values()]).toEqual([pin('B','7')]);
 } finally {warm.mockRestore();await boundary.reader.owner.close();await product.close();rmSync(root,{recursive:true,force:true});}
},60000);
