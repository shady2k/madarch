import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { productDataViolations, extractionViolations } from '../scripts/check/architecture/gates.js';
const root=mkdtempSync(join(tmpdir(),'startup-architecture-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function file(name:string,text:string){const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);}
test('startup protocol status and platform reads are confined to their declared observation modules',()=>{
 file('catalog/work/execution/unsupported.yaml','fields: []\n');
 file('src/obs/startup-context.ts',"import { openSync } from 'node:fs'; export const status = 'unsupported';");
 file('src/obs/startup-platform.ts',"import { readFileSync } from 'node:fs';");
 file('src/other.ts',"import { readFileSync } from 'node:fs'; export const word='unsupported';");
 expect(productDataViolations(root).map(v=>[v.file,v.symbol])).toEqual([['src/other.ts','unsupported']]);
 const found=extractionViolations(root);
 expect(found.some(v=>v.file==='src/obs/startup-context.ts'||v.file==='src/obs/startup-platform.ts')).toBe(false);
 expect(found.some(v=>v.file==='src/other.ts')).toBe(true);
});
