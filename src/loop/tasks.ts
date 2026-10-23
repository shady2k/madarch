/** Product-owned scoped tasks proposed from answers (madarch-m38l.14). */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { byCodePoint } from '../model/order.js';
import { splitFrontMatter } from '../knowledge/markdown.js';
import { slugOf } from '../writer/names.js';
import type { Author } from './entities.js';

export const TASKS_FOLDER = 'docs/tasks';
export type TaskScope = { type: 'section'; path: string; anchor: string } | { type: 'lines'; path: string; start: number; end: number } | { type: 'symbol'; key: string } | { type: 'statement'; key: string };
export interface PlannedTask { slug: string; id: string; file: string; title: string; status: 'open'|'closed'; question: string; answer: string; grounds: string[]; scope: TaskScope[]; by: Author; at: string; }
export interface TaskFinding { file: string; line: number; message: string; }
export function renderTask(task: Omit<PlannedTask,'id'|'file'>): string {
 const front={id:`task:${task.slug}`,kind:'task',title:task.title,status:task.status,question:task.question,answer:task.answer,grounds:[...task.grounds],scope:task.scope.map(s=>({...s})),producer:'person', 'created-by':{...task.by},'created-at':task.at};
 const yaml= stringifyYaml(front,{lineWidth:0}).trimEnd();
 return `---\n${yaml}\n---\n\n## Task\n\n${task.title}\n`;
}
function parseTask(file:string,source:string):PlannedTask {
 const {front}=splitFrontMatter(source.replace(/\r\n/g,'\n'));
 if(front===null) throw new Error(`${file}:1: the task has no front matter`);
 let raw:unknown; try{raw=parseYaml(front);}catch(e){throw new Error(`${file}:2: task front matter is not YAML: ${(e as Error).message.split('\n')[0]}`)}
 if(raw===null||typeof raw!=='object'||Array.isArray(raw))throw new Error(`${file}:2: task front matter is a mapping`);
 const r=raw as Record<string,unknown>; const slug=file.slice(file.lastIndexOf('/')+1,-3);
 const text=(k:string)=>typeof r[k]==='string'?(r[k] as string):'';
 if(r['id']!==`task:${slug}`||r['kind']!=='task')throw new Error(`${file}:2: task id and kind must name task:${slug}`);
 if(r['status']!=='open'&&r['status']!=='closed')throw new Error(`${file}:2: task status is open or closed`);
 const grounds=r['grounds']; if(!Array.isArray(grounds)||grounds.some(x=>typeof x!=='string'||x===''))throw new Error(`${file}:2: task grounds are a list of non-empty keys`);
 const scope=r['scope']; if(!Array.isArray(scope)||scope.length===0)throw new Error(`${file}:2: task scope is a non-empty list`);
 const parsed:TaskScope[]=scope.map((value,ix)=>{if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error(`${file}:2: scope[${ix}] is a mapping`);const s=value as Record<string,unknown>;if(s['type']==='section'&&typeof s['path']==='string'&&typeof s['anchor']==='string')return {type:'section',path:s['path'],anchor:s['anchor']};if(s['type']==='lines'&&typeof s['path']==='string'&&Number.isInteger(s['start'])&&Number.isInteger(s['end'])&&(s['start'] as number)>0&&(s['end'] as number)>=(s['start'] as number))return {type:'lines',path:s['path'],start:s['start'] as number,end:s['end'] as number};if((s['type']==='symbol'||s['type']==='statement')&&typeof s['key']==='string')return {type:s['type'],key:s['key']};throw new Error(`${file}:2: scope[${ix}] is a section, lines, symbol or statement scope`);});
 const by=r['created-by']; if(by===null||typeof by!=='object'||typeof (by as Record<string,unknown>)['name']!=='string'||typeof (by as Record<string,unknown>)['email']!=='string')throw new Error(`${file}:2: created-by names the person`);
 return {slug,id:`task:${slug}`,file,title:text('title'),status:r['status'],question:text('question'),answer:text('answer'),grounds:grounds as string[],scope:parsed,by:by as Author,at:text('created-at')};
}
export function readTasks(folder:string):{tasks:PlannedTask[];findings:TaskFinding[]} {
 let files:string[];try{files=readdirSync(join(folder,TASKS_FOLDER)).filter(f=>f.endsWith('.md')).sort(byCodePoint);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {tasks:[],findings:[]};throw new Error(`${TASKS_FOLDER}:1: cannot list task files: ${(e as Error).message}`)}
 const tasks:PlannedTask[]=[],findings:TaskFinding[]=[];for(const name of files){const file=`${TASKS_FOLDER}/${name}`;try{tasks.push(parseTask(file,readFileSync(join(folder,file),'utf8')))}catch(e){findings.push({file,line:1,message:(e as Error).message})}}return {tasks,findings};
}
export function taskSlug(title:string,question:string):string{return slugOf(title,question);}
