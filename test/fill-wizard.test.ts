import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';import { tmpdir } from 'node:os';
import { agentSettingsPath, readChosenAgent } from '../src/product/fill-wizard.js';
let root='';afterEach(()=>{if(root)rmSync(root,{recursive:true,force:true});root='';});function setup(){root=mkdtempSync(join(tmpdir(),'madarch-wizard-'));const bin=join(root,'bin');mkdirSync(bin);return bin;}function fake(bin:string,name:string,script:string){const file=join(bin,name);writeFileSync(file,`#!/bin/sh\n${script}\n`);chmodSync(file,0o755);}
describe('fill wizard agent discovery',()=>{
});


