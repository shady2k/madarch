import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/http.js';
import { createAgentCallBudget, startFill } from '../src/product/fill.js';
import { fillStatePaths } from '../src/product/fill-runtime.js';

const productFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'madarch-fill-dispatch-'));
  await writeFile(join(root,'workspace.yaml'),'schemaVersion: 1\nid: example\nname: Example\nskills:\n  madarch: "1.0.0"\nrepos:\n  - name: source\n    url: https://example.invalid/source\n');
  await mkdir(join(root,'docs'),{recursive:true});
  await writeFile(join(root,'docs/kinds.yaml'),'contract: 1\nstages:\n  - id: overview\n    name: Overview\nkinds:\n  - name: Overview\n    prefix: OV\n    folder: docs/overview\n    stage: overview\n    hint: Describe the product\n');
  const app=join(root,'app'); await mkdir(app); await writeFile(join(app,'index.html'),'<html></html>');
  return {root,app};
};

describe('fill dispatcher entry',()=>{
  test('rejects unavailable agent and invalid max units without making state',async()=>{
    const {root}=await productFixture();
    try { await expect(startFill(root,{agent:'claude',maxUnits:0})).rejects.toThrow('maxUnits'); }
    finally { await rm(root,{recursive:true,force:true}); }
  });
  test('counts every real agent dispatch before invoking it and refuses beyond maxUnits',async()=>{
    let persisted=0; const budget=createAgentCallBudget(2,0,async count=>{persisted=count;}); let calls=0; const invoke=()=>budget.dispatch(async()=>++calls);
    expect(await invoke()).toBe(1); expect(await invoke()).toBe(2); await expect(invoke()).rejects.toThrow('maxUnits 2 exhausted before agent call 3'); expect(calls).toBe(2); expect(budget.count()).toBe(2); expect(persisted).toBe(2);
  });
  test('refuses an overlapping start and names the active run',async()=>{
    const {root}=await productFixture(); const state=fillStatePaths(root); await mkdir(state.root,{recursive:true}); await writeFile(state.run,JSON.stringify({id:'already-running'})); await mkdir(join(state.root,'active.lock'));
    try { await expect(startFill(root)).rejects.toThrow('already-running'); } finally { await rm(root,{recursive:true,force:true}); }
  });
  test('server exposes POST /api/fill/start and delegates validated options to the injected shared entry',async()=>{
    const {root,app}=await productFixture(); const calls: unknown[]=[];
    const server=await startServer({productFolder:root,appFolder:app,port:0,startFill:async(folder,options)=>{calls.push({folder,options});return {run:{id:'run-1',status:'running'},counts:{reused:1,run:2},questionReview:'hook-pending-co2d.1'} as any;},log:()=>{},errorLog:()=>{}});
    try {
      const response=await fetch(`${server.url}/api/fill/start`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent:'codex',maxUnits:7})});
      expect(response.status).toBe(202); expect(await response.json()).toMatchObject({accepted:true,status:'starting'}); await new Promise(resolve=>setTimeout(resolve,0)); expect(calls).toEqual([{folder:root,options:{agent:'codex',maxUnits:7}}]);
      const bad=await fetch(`${server.url}/api/fill/start`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agent:'other'})}); expect(bad.status).toBe(400);
    } finally { await server.stop(); await rm(root,{recursive:true,force:true}); }
  });
});
