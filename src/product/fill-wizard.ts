/** Machine-local agent choice and safe discovery helpers for the first-fill wizard. */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { homeFromEnv } from './home.js';
export type WizardAgent = 'claude' | 'codex' | 'omp';
/** The person's home, read by the one module that reads madarch's homes (`home.ts`). */
function defaultHome(): string { return homeFromEnv(); }
export function agentSettingsPath(home = defaultHome()): string { return join(home,'.config','madarch','fill-agent.json'); }
interface AgentChoice { agent?: unknown; model?: unknown; auth?: unknown }
async function readAgentChoice(home:string):Promise<AgentChoice|undefined>{try{return JSON.parse(await readFile(agentSettingsPath(home),'utf8')) as AgentChoice;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
export async function readChosenAgent(home=defaultHome()):Promise<WizardAgent|undefined>{const choice=await readAgentChoice(home);return choice!==undefined&&(choice.agent==='claude'||choice.agent==='codex'||choice.agent==='omp')?choice.agent:undefined;}
