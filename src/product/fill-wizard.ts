/** Machine-local agent choice and safe discovery helpers for the first-fill wizard. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
const exec = promisify(execFile);
export type WizardAgent = 'claude' | 'codex' | 'omp';
export interface DetectedAgent { name: WizardAgent; available: boolean; version?: string; reason?: string }
/**
 * The user's home as this process reads it: the environment's `HOME`, which is
 * what `os.homedir()` reports when a process starts — and which is the only one
 * a run can point elsewhere, since Bun resolves `homedir()` once and a preload
 * cannot move it afterwards (madarch-1xq: the settings file must follow the
 * home a test run gives the process, not the account's own).
 */
function defaultHome(): string { const named = process.env.HOME?.trim(); return named !== undefined && named !== '' ? named : homedir(); }
export function agentSettingsPath(home = defaultHome()): string { return join(home,'.config','madarch','fill-agent.json'); }
export async function detectFillAgents(pathValue = process.env.PATH ?? ''): Promise<DetectedAgent[]> {
 const result: DetectedAgent[]=[];
 for(const name of ['claude','codex','omp'] as const){try{const {stdout,stderr}=await exec(name,['--version'],{env:{...process.env,PATH:pathValue},timeout:5000});result.push({name,available:true,version:(stdout||stderr).trim().split(/\r?\n/)[0]||'unknown version'});}catch(error){const e=error as NodeJS.ErrnoException;result.push({name,available:false,reason:e.code==='ENOENT'?'Not installed':(e.message||'Could not read version').slice(0,300)});}}
 return result;
}
export async function testFillAgent(name:WizardAgent,pathValue=process.env.PATH??'',model?:string):Promise<{status:'ok'|'not-signed-in'|'failed';reason?:string}>{
 const chosenModel=model||process.env.MADARCH_FILL_MODEL;
 if(name==='omp'&&!process.env.MADARCH_OMP_EXTENSION)return{status:'failed',reason:'The gateway extension is not configured: set MADARCH_OMP_EXTENSION.'};
 const args=name==='omp'?['-p','--no-session','--no-extensions','-e',process.env.MADARCH_OMP_EXTENSION??'',...(chosenModel?['--model',chosenModel]:[]),'--mode','json','--tools','read,grep,glob','Reply with the single word OK.']:name==='claude'?['-p','--output-format','text','--permission-mode','plan','--permission-prompts','none','Reply with the single word OK.']:['exec','--json','--sandbox','read-only','Reply with the single word OK.'];
 try{const {stdout,stderr}=await exec(name,args,{env:{...process.env,PATH:pathValue,CI:'1'},timeout:30000,maxBuffer:128*1024});const text=`${stdout}\n${stderr}`;return /not logged in|not authenticated|login required|not signed in/i.test(text)?{status:'not-signed-in',reason:'The agent CLI is installed but is not signed in.'}:{status:'ok'};}
 catch(error){const e=error as NodeJS.ErrnoException&{stderr?:string};const reason=(e.stderr||e.message||'Agent test failed').trim().slice(0,300);return /not logged in|not authenticated|login required|not signed in/i.test(reason)?{status:'not-signed-in',reason}:{status:'failed',reason};}
}
interface AgentChoice { agent?: unknown; model?: unknown }
async function readAgentChoice(home:string):Promise<AgentChoice|undefined>{try{return JSON.parse(await readFile(agentSettingsPath(home),'utf8')) as AgentChoice;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
export async function readChosenAgent(home=defaultHome()):Promise<WizardAgent|undefined>{const choice=await readAgentChoice(home);return choice!==undefined&&(choice.agent==='claude'||choice.agent==='codex'||choice.agent==='omp')?choice.agent:undefined;}
export async function readChosenModel(home=defaultHome()):Promise<string|undefined>{const choice=await readAgentChoice(home);return typeof choice?.model==='string'?choice.model:undefined;}
/** Save the agent choice; a given model (possibly '' for none) overrides, an omitted one keeps the saved value. */
export async function saveChosenAgent(agent:WizardAgent,options:{model?:string}={},home=defaultHome()):Promise<void>{
 const choice=await readAgentChoice(home);
 const merged={...(choice&&typeof choice.model==='string'?{model:choice.model}:{}),agent,...(options.model===undefined?{}:{model:options.model})};
 const file=agentSettingsPath(home);await mkdir(dirname(file),{recursive:true});const temp=`${file}.${process.pid}.tmp`;await writeFile(temp,`${JSON.stringify(merged,null,2)}\n`,{mode:0o600});await rename(temp,file);
}
