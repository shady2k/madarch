import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';import { tmpdir } from 'node:os';
import { agentSettingsPath, detectFillAgents, readChosenAgent, readChosenAuth, readChosenModel, saveChosenAgent, testFillAgent } from '../src/product/fill-wizard.js';
let root='';afterEach(()=>{if(root)rmSync(root,{recursive:true,force:true});root='';});function setup(){root=mkdtempSync(join(tmpdir(),'madarch-wizard-'));const bin=join(root,'bin');mkdirSync(bin);return bin;}function fake(bin:string,name:string,script:string){const file=join(bin,name);writeFileSync(file,`#!/bin/sh\n${script}\n`);chmodSync(file,0o755);}
describe('fill wizard agent discovery',()=>{
test('discovers installed CLI versions using a temporary PATH',async()=>{const bin=setup();fake(bin,'claude','echo Claude 1.2.3');fake(bin,'codex','echo Codex 4.5.6');fake(bin,'omp','echo omp 0.1');const detected=await detectFillAgents(bin);expect(detected.map((agent)=>agent.name)).toEqual(['claude','codex','omp']);expect(detected.every((agent)=>agent.available)).toBe(true);expect(detected.find((agent)=>agent.name==='omp')).toEqual({name:'omp',available:true,version:'omp 0.1'});});
test('reports missing agents without naming PATH',async()=>{const bin=setup();const detected=await detectFillAgents(bin);expect(detected.map((agent)=>agent.available)).toEqual([false,false,false]);for(const agent of detected)expect(agent.reason?.toLowerCase()).not.toContain('path');});
test('runs a short fake call and distinguishes sign-in state',async()=>{const bin=setup();fake(bin,'claude','echo OK');expect(await testFillAgent('claude',bin)).toEqual({status:'ok'});fake(bin,'codex','echo "not logged in" >&2; exit 1');expect(await testFillAgent('codex',bin)).toMatchObject({status:'not-signed-in'});});
test('the omp test call carries the model it was given',async()=>{const bin=setup();const argsFile=join(root,'omp-args.txt');fake(bin,'omp',`printf '%s\\n' "$@" > ${argsFile}`);const hadExtension=process.env.MADARCH_OMP_EXTENSION!==undefined;const extensionBefore=process.env.MADARCH_OMP_EXTENSION;process.env.MADARCH_OMP_EXTENSION='/tmp/madarch-test-extension.mjs';try{await testFillAgent('omp',bin,'glm-5.3-flash-auto');}finally{if(hadExtension)process.env.MADARCH_OMP_EXTENSION=extensionBefore;else delete process.env.MADARCH_OMP_EXTENSION;}const args=readFileSync(argsFile,'utf8');expect(args).toContain('--model');expect(args).toContain('glm-5.3-flash-auto');});
test('the omp test call without a configured extension says so',async()=>{const bin=setup();fake(bin,'omp','echo unexpected');const hadExtension=process.env.MADARCH_OMP_EXTENSION!==undefined;const extensionBefore=process.env.MADARCH_OMP_EXTENSION;delete process.env.MADARCH_OMP_EXTENSION;try{expect(await testFillAgent('omp',bin,'glm-5.3-flash-auto')).toMatchObject({status:'failed'});}finally{if(hadExtension)process.env.MADARCH_OMP_EXTENSION=extensionBefore;else delete process.env.MADARCH_OMP_EXTENSION;}});
test('stores choice and per-machine model outside the product tree',async()=>{const home=setup();await saveChosenAgent('codex',{},home);await saveChosenAgent('omp',{model:'glm-5.3-flash-auto'},home);expect(await readChosenAgent(home)).toBe('omp');expect(await readChosenModel(home)).toBe('glm-5.3-flash-auto');await saveChosenAgent('claude',{},home);expect(await readChosenModel(home)).toBe('glm-5.3-flash-auto');await saveChosenAgent('omp',{model:''},home);expect(await readChosenModel(home)).toBe('');expect(await readChosenAgent(home)).toBe('omp');expect(agentSettingsPath(home)).toBe(join(home,'.config','madarch','fill-agent.json'));});
});

test('the settings file follows the home the environment names, never the account\'s own', async () => {
  // Bun resolves `os.homedir()` once when a process starts, so a test run's
  // scratch home reaches this module only through `HOME` (madarch-1xq): the
  // default must read it, or a run writes into the owner's real
  // `~/.config/madarch/` (and two runs on one machine fight over the file).
  const home = setup();
  const saved = process.env.HOME;
  try {
    process.env.HOME = home;
    expect(agentSettingsPath()).toBe(join(home, '.config', 'madarch', 'fill-agent.json'));
    await saveChosenAgent('codex', { model: 'glm-5.3-flash-auto' });
    expect(await readChosenAgent()).toBe('codex');
    expect(await readChosenModel()).toBe('glm-5.3-flash-auto');
    expect(readFileSync(join(home, '.config', 'madarch', 'fill-agent.json'), 'utf8')).toContain('glm-5.3-flash-auto');
  } finally {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
  }
});

test('how the fill pays is kept beside the agent, and a later save of one leaves the other', async () => {
  const home = setup();
  // Nothing chosen yet: the agent's own sign-in is what a start assumes.
  expect(await readChosenAuth(home)).toBeUndefined();
  await saveChosenAgent('claude', { auth: 'api-key' }, home);
  expect(await readChosenAuth(home)).toBe('api-key');
  expect(await readChosenAgent(home)).toBe('claude');
  // A model saved afterwards keeps the auth choice, and a later auth keeps the model.
  await saveChosenAgent('claude', { model: 'glm-5.3-flash-auto' }, home);
  expect(await readChosenAuth(home)).toBe('api-key');
  await saveChosenAgent('codex', { auth: 'subscription' }, home);
  expect(await readChosenModel(home)).toBe('glm-5.3-flash-auto');
  expect(await readChosenAuth(home)).toBe('subscription');
  // Only madarch's own two words are a choice; anything else is no choice.
  writeFileSync(agentSettingsPath(home), JSON.stringify({ agent: 'codex', auth: 'password' }));
  expect(await readChosenAuth(home)).toBeUndefined();
  // The file holds the choice and never a key.
  await saveChosenAgent('claude', { auth: 'api-key' }, home);
  const saved = readFileSync(agentSettingsPath(home), 'utf8');
  expect(saved).toContain('api-key');
  expect(saved).not.toMatch(/sk-|apiKey|api_key/);
});
