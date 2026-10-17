import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';import { tmpdir } from 'node:os';
import { agentSettingsPath, detectFillAgents, readChosenAgent, saveChosenAgent, testFillAgent } from '../src/product/fill-wizard.js';
let root='';afterEach(()=>{if(root)rmSync(root,{recursive:true,force:true});root='';});function setup(){root=mkdtempSync(join(tmpdir(),'madarch-wizard-'));const bin=join(root,'bin');mkdirSync(bin);return bin;}function fake(bin:string,name:string,script:string){const file=join(bin,name);writeFileSync(file,`#!/bin/sh\n${script}\n`);chmodSync(file,0o755);}
describe('fill wizard agent discovery',()=>{
test('discovers installed CLI versions using a temporary PATH',async()=>{const bin=setup();fake(bin,'claude','echo Claude 1.2.3');fake(bin,'codex','echo Codex 4.5.6');expect(await detectFillAgents(bin)).toEqual([{name:'claude',available:true,version:'Claude 1.2.3'},{name:'codex',available:true,version:'Codex 4.5.6'}]);});
test('reports missing agents',async()=>{const bin=setup();expect(await detectFillAgents(bin)).toEqual([{name:'claude',available:false,reason:'Not found on PATH'},{name:'codex',available:false,reason:'Not found on PATH'}]);});
test('runs a short fake call and distinguishes sign-in state',async()=>{const bin=setup();fake(bin,'claude','echo OK');expect(await testFillAgent('claude',bin)).toEqual({status:'ok'});fake(bin,'codex','echo "not logged in" >&2; exit 1');expect(await testFillAgent('codex',bin)).toMatchObject({status:'not-signed-in'});});
test('stores choice outside the product tree under machine config',async()=>{const home=setup();await saveChosenAgent('codex',home);expect(await readChosenAgent(home)).toBe('codex');expect(agentSettingsPath(home)).toBe(join(home,'.config','madarch','fill-agent.json'));expect(readFileSync(agentSettingsPath(home),'utf8')).toContain('codex');});
});
