/** Machine-local agent choice and safe discovery helpers for the first-fill wizard. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
const exec = promisify(execFile);
export type WizardAgent = 'claude' | 'codex';
export interface DetectedAgent { name: WizardAgent; available: boolean; version?: string; reason?: string }
export function agentSettingsPath(home = homedir()): string { return join(home,'.config','madarch','fill-agent.json'); }
export async function detectFillAgents(pathValue = process.env.PATH ?? ''): Promise<DetectedAgent[]> {
 const result: DetectedAgent[]=[];
 for(const name of ['claude','codex'] as const){try{const {stdout,stderr}=await exec(name,['--version'],{env:{...process.env,PATH:pathValue},timeout:5000});result.push({name,available:true,version:(stdout||stderr).trim().split(/\r?\n/)[0]||'unknown version'});}catch(error){const e=error as NodeJS.ErrnoException;result.push({name,available:false,reason:e.code==='ENOENT'?'Not found on PATH':(e.message||'Could not read version').slice(0,300)});}}
 return result;
}
export async function testFillAgent(name:WizardAgent,pathValue=process.env.PATH??''):Promise<{status:'ok'|'not-signed-in'|'failed';reason?:string}>{
 const args=name==='claude'?['-p','--output-format','text','--permission-mode','plan','--permission-prompts','none','Reply with the single word OK.']:['exec','--json','--sandbox','read-only','Reply with the single word OK.'];
 try{const {stdout,stderr}=await exec(name,args,{env:{...process.env,PATH:pathValue,CI:'1'},timeout:30000,maxBuffer:128*1024});const text=`${stdout}\n${stderr}`;return /not logged in|not authenticated|login required|not signed in/i.test(text)?{status:'not-signed-in',reason:'The agent CLI is installed but is not signed in.'}:{status:'ok'};}
 catch(error){const e=error as NodeJS.ErrnoException&{stderr?:string};const reason=(e.stderr||e.message||'Agent test failed').trim().slice(0,300);return /not logged in|not authenticated|login required|not signed in/i.test(reason)?{status:'not-signed-in',reason}:{status:'failed',reason};}
}
export async function readChosenAgent(home=homedir()):Promise<WizardAgent|undefined>{try{const value=JSON.parse(await readFile(agentSettingsPath(home),'utf8')) as {agent?:unknown};return value.agent==='claude'||value.agent==='codex'?value.agent:undefined;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
export async function saveChosenAgent(agent:WizardAgent,home=homedir()):Promise<void>{const file=agentSettingsPath(home);await mkdir(dirname(file),{recursive:true});const temp=`${file}.${process.pid}.tmp`;await writeFile(temp,`${JSON.stringify({agent},null,2)}\n`,{mode:0o600});await rename(temp,file);}
