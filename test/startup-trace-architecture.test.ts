import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { extractionViolations } from '../scripts/check/architecture/gates.js';
const root=mkdtempSync(join(tmpdir(),'startup-architecture-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
function file(name:string,text:string){const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);}
test('startup platform reads are confined to their declared observation modules',()=>{
 file('src/obs/startup-context.ts',"import { openSync } from 'node:fs';");
 file('src/obs/startup-platform.ts',"import { readFileSync } from 'node:fs';");
 file('src/other.ts',"import { readFileSync } from 'node:fs';");
 const found=extractionViolations(root);
 expect(found.some(v=>v.file==='src/obs/startup-context.ts'||v.file==='src/obs/startup-platform.ts')).toBe(false);
 expect(found.some(v=>v.file==='src/other.ts')).toBe(true);
});
