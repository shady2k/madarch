/** Machine-local agent choice and safe discovery helpers for the first-fill wizard. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homeFromEnv } from './home.js';
const exec = promisify(execFile);
export type WizardAgent = 'claude' | 'codex' | 'omp';
/**
 * How the chosen agent pays for a fill, as the person picked it: the agent's
 * own subscription sign-in, or an API key. madarch keeps only this word — the
 * key itself stays in the environment the agent reads it from, and madarch
 * never asks for it, reads it or stores it (the owner's decision of
 * 2026-10-19 recorded on madarch-tzte.6).
 */
export type WizardAuth = 'subscription' | 'api-key';
export interface DetectedAgent { name: WizardAgent; available: boolean; version?: string; reason?: string }
/** The person's home, read by the one module that reads madarch's homes (`home.ts`). */
function defaultHome(): string { return homeFromEnv(); }
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
interface AgentChoice { agent?: unknown; model?: unknown; auth?: unknown }
async function readAgentChoice(home:string):Promise<AgentChoice|undefined>{try{return JSON.parse(await readFile(agentSettingsPath(home),'utf8')) as AgentChoice;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
export async function readChosenAgent(home=defaultHome()):Promise<WizardAgent|undefined>{const choice=await readAgentChoice(home);return choice!==undefined&&(choice.agent==='claude'||choice.agent==='codex'||choice.agent==='omp')?choice.agent:undefined;}
export async function readChosenModel(home=defaultHome()):Promise<string|undefined>{const choice=await readAgentChoice(home);return typeof choice?.model==='string'?choice.model:undefined;}
/** How the chosen agent pays for a fill, or `undefined` when the person never chose: the agent's own sign-in is the default. */
export async function readChosenAuth(home=defaultHome()):Promise<WizardAuth|undefined>{const choice=await readAgentChoice(home);return choice?.auth==='subscription'||choice?.auth==='api-key'?choice.auth:undefined;}
/** Save the agent choice; a given model (possibly '' for none) overrides an omitted one that keeps the saved value, and so does a given auth. */
export async function saveChosenAgent(agent:WizardAgent,options:{model?:string;auth?:WizardAuth}={},home=defaultHome()):Promise<void>{
 const choice=await readAgentChoice(home);
 const merged={...(choice&&typeof choice.model==='string'?{model:choice.model}:{}),...(choice?.auth==='subscription'||choice?.auth==='api-key'?{auth:choice.auth}:{}),agent,...(options.model===undefined?{}:{model:options.model}),...(options.auth===undefined?{}:{auth:options.auth})};
 const file=agentSettingsPath(home);await mkdir(dirname(file),{recursive:true});const temp=`${file}.${process.pid}.tmp`;await writeFile(temp,`${JSON.stringify(merged,null,2)}\n`,{mode:0o600});await rename(temp,file);
}
