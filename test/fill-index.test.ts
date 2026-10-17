import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFillUnit, readFillJson } from '../src/product/fill-runtime.js';
import { execFileSync } from 'node:child_process';
import { inventoryRepository, indexRepository, structuralIndexUnitPlans, inventoryUnitPlan, executeInventoryUnit, executeStructuralIndexUnit } from '../src/product/fill-index.js';

async function fixture(): Promise<{root:string; commit:string; dispose:()=>Promise<void>}> {
 const root=await mkdtemp(join(tmpdir(),'madarch-index-'));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 git('init','-q'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
 await mkdir(join(root,'src'),{recursive:true});
 await writeFile(join(root,'src','main.ts'),`// Task: madarch-demo.1\n// 😀 preceding unicode anchor\nexport function launch(value: number) { return helper(value); }\nfunction helper(value: number) { return value + 1; }\nexport const arrow = (n: number) => helper(n);\nexport class Worker { run() { return helper(2); } }\nexport function first() {}\nfunction later() {}\nexport { later as renamed };\n`);
 await writeFile(join(root,'src','main.go'),`package main\nimport (\n  "fmt"\n  "os"\n)\n// Task: madarch-demo.2\nfunc main() { fmt.Println(os.Args) }\nfunc Exported() {}\n`);
 await writeFile(join(root,'README.md'),'# fixture\n');
 git('add','.'); git('commit','-qm','fixture'); const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 return {root,commit,dispose:()=>rm(root,{recursive:true,force:true})};
}

describe('pinned inventory and structural index',()=>{
 test('inventory is deterministic, counts languages and estimates each pipeline stage',async()=>{
   const f=await fixture(); try {
     const before=execFileSync('git',['status','--porcelain'],{cwd:f.root,encoding:'utf8'});
     const a=await inventoryRepository(f.root,f.commit); const b=await inventoryRepository(f.root,f.commit);
     expect(a.contentHash).toBe(b.contentHash); expect(a.files.map(x=>x.path)).toEqual(['README.md','src/main.go','src/main.ts']);
     expect(a.languages).toEqual({go:1,typescript:1,unknown:1}); expect(a.filesByLanguage).toEqual(a.languages);
     expect(a.estimates.map(x=>x.stage)).toEqual(['inventory','index','claims','code-map','synthesis','question-review']);
     expect(a.files.every(x=>x.blob.length===40 && x.startLine===1 && x.endLine>=1)).toBe(true);
     expect(execFileSync('git',['status','--porcelain'],{cwd:f.root,encoding:'utf8'})).toBe(before);
   } finally {await f.dispose();}
 });
 test('inventory totals files, languages, and estimates across every checkout',async()=>{
   const f=await fixture();const second=await fixture();try{
     const result=await inventoryRepository(f.root,f.commit,[{path:second.root,commit:second.commit}]);
     expect(result.files).toHaveLength(6);
     expect(result.languages).toEqual({go:2,typescript:2,unknown:2});
     expect(result.estimates.find(item=>item.stage==='index')?.units).toBe(4);
     expect(result.repositories).toHaveLength(2);
   }finally{await f.dispose();await second.dispose();}
 });
 test('index extracts anchored symbols, imports, calls, comments, entry points and task keys',async()=>{
   const f=await fixture(); try {
     const index=await indexRepository(f.root,f.commit); const again=await indexRepository(f.root,f.commit);
     expect(index.contentHash).toBe(again.contentHash); expect(index.files.map(x=>x.path)).toEqual(['src/main.go','src/main.ts']);
     const ts=index.files.find(x=>x.path.endsWith('.ts'))!;
     expect(ts.symbols.map(x=>x.name)).toEqual(['launch','helper','arrow','Worker','run','first','later']);
     expect(ts.symbols.find(x=>x.name==='launch')?.startByte).toBe(Buffer.byteLength(`// Task: madarch-demo.1\n// 😀 preceding unicode anchor\nexport `));
     expect(ts.symbols.find(x=>x.name==='first')?.exported).toBe(true); expect(ts.symbols.find(x=>x.name==='later')?.exported).toBe(true);
     expect(ts.symbols.every(x=>x.blob===ts.blob && x.startLine>0 && x.endLine>=x.startLine && x.startByte<x.endByte)).toBe(true);
     expect(ts.symbols.map(x=>x.name)).toContain('arrow'); expect(ts.symbols.map(x=>x.name)).toContain('run');
     expect(ts.callEdges.map(x=>x.target)).toContain('helper'); expect(ts.comments[0]?.text).toContain('Task: madarch-demo.1');
     expect(ts.taskKeys.map(x=>x.key)).toEqual(['madarch-demo.1']);
     const unicode = ts.comments.find(x=>x.text.includes('Task:'))!; expect(unicode.endByte-unicode.startByte).toBe(Buffer.byteLength(unicode.text));
     const go=index.files.find(x=>x.path.endsWith('.go'))!;
     expect(go.imports.map(x=>x.target)).toEqual(['fmt','os']); expect(go.entryPoints).toContain('main'); expect(go.symbols.find(x=>x.name==='Exported')?.exported).toBe(true);
     const plans=structuralIndexUnitPlans(index,'inventory-hash'); expect(plans).toHaveLength(2);
     expect(plans[0]?.inputHashes.inventory).toBe('inventory-hash');
   } finally {await f.dispose();}
 });
 test('runtime units write hash-addressed stage outputs without changing source checkout',async()=>{
   const f=await fixture(); const product=await mkdtemp(join(tmpdir(),'madarch-output-')); try {
     const inventory=await inventoryRepository(f.root,f.commit); const invPlan=inventoryUnitPlan(inventory); const invUnit=createFillUnit(invPlan);
     const inv=await executeInventoryUnit(product,invUnit,inventory,new AbortController().signal);
     expect((await readFillJson<{contentHash:string}>(inv.outputPaths[0]!)).contentHash).toBe(inventory.contentHash);
     const index=await indexRepository(f.root,f.commit); const plans=structuralIndexUnitPlans(index,inventory.contentHash); const plan=plans[0]!;
     const unit=createFillUnit(plan); const result=await executeStructuralIndexUnit(f.root,product,unit,new AbortController().signal);
     const saved=await readFillJson<Record<string,unknown>>(result.outputPaths[0]!); expect(saved).toHaveProperty('blob',plan.inputHashes.blob);
     expect(execFileSync('git',['status','--porcelain'],{cwd:f.root,encoding:'utf8'})).toBe('');
   } finally {await f.dispose(); await rm(product,{recursive:true,force:true});}
 });
 test('a later checkout edit cannot change results for an earlier pinned commit',async()=>{
   const f=await fixture(); try {
     const initial=await indexRepository(f.root,f.commit);
     await writeFile(join(f.root,'src','main.ts'),'// changed\n');
     const pinned=await indexRepository(f.root,f.commit);
     expect(pinned.contentHash).toBe(initial.contentHash);
   } finally {await f.dispose();}
 });
});
