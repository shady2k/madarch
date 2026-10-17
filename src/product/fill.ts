/** Shared local fill entry point: pins source repos, persists resumable units and drives stages. */
import { randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readProduct } from './manifest.js';
import { readProductRegistry } from './registry.js';
import { inventoryRepository, indexRepository, inventoryUnitPlan, structuralIndexUnitPlans, executeInventoryUnit, executeStructuralIndexUnit, type StructuralIndexResult, type RepositoryInventoryResult } from './fill-index.js';
import { createFillRun, createFillFileStore, fillStatePaths, hashFillInput, hashFillInputs, readFillJson, consumeFillControl, type FillRun, type FillStage, type FillUnit, type FillUnitPlan } from './fill-runtime.js';
import { createHeadlessAgentExecutor, type AgentKind } from './fill-agents.js';
import { assembleClaims, createClaimSources, readPinnedGitMaterial, readPinnedGitHistory, type ClaimsExtraction, type ClaimSource, type ExtractedClaim, type ClaimLayer } from './fill-claims.js';
import { buildCodeMap, persistCodeMap, synthesizePages, applySynthesisPages, type SynthesisClaim, type SynthesizedPage } from './fill-synthesis.js';

export interface StartFillOptions { agent?: AgentKind; maxUnits?: number; executorFactory?: (context: { stage: FillStage; repository: string; prompt: string; onEvent: (event: unknown) => Promise<void> }) => { execute: (prompt: string, signal: AbortSignal, onEvent: (event: unknown) => Promise<void>) => Promise<string> }; }
export interface StartFillResult { run: FillRun; counts: { reused: number; run: number }; questionReview: 'hook-pending-co2d.1'; }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
const codePoint = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const jsonFromText = (text: string): unknown => {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* permit fenced JSON from model output */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]!);
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('Agent returned no JSON object');
};
async function agentJson(options: StartFillOptions, agent: AgentKind, repository: string, stage: FillStage, unit: FillUnit, prompt: string, events: (event: unknown) => Promise<void>, signal: AbortSignal): Promise<any> {
  if (options.executorFactory) {
    const executor = options.executorFactory({ stage, repository, prompt, onEvent: events });
    const raw = await executor.execute(prompt, signal, events);
    return jsonFromText(raw);
  }
  let output = '';
  const executor = createHeadlessAgentExecutor({ kind: agent, snapshot: repository, promptFor: () => prompt, onEvent: async (event) => { await events(event); }, onRawLine: async (_unit, line) => { output += `${line}\n`; } });
  await executor.execute(unit, signal, async (summary) => { await events({ summary }); });
  // Provider stream-json wraps final text in several event shapes; collect only assistant text blocks.
  const texts: string[] = [];
  for (const line of output.split('\n')) { try { const row = JSON.parse(line); if (typeof row.result === 'string') texts.push(row.result); for (const c of row.message?.content ?? []) if (typeof c.text === 'string') texts.push(c.text); if (typeof row.text === 'string') texts.push(row.text); } catch { /* ignored provider protocol lines */ } }
  if (!texts.length) throw new Error(`${agent} returned no structured assistant output for ${stage}`);
  return jsonFromText(texts.at(-1)!);
}
function asArray<T>(value: unknown, name: string): T[] { if (!Array.isArray(value)) throw new Error(`Agent output field ${name} must be an array`); return value as T[]; }
async function readUnitOutput<T>(product: string, unit: FillUnit): Promise<T> { const path = unit.outputPaths[0]; if (!path) throw new Error(`Unit ${unit.id} has no output path`); return readFillJson<T>(resolve(product, path)); }

/** Start or resume the product's one local fill run. Returns after all currently planned units drain. */
export async function startFill(productFolder: string, options: StartFillOptions = {}): Promise<StartFillResult> {
  const product = resolve(productFolder); const identity = readProduct(product);
  if (!identity.ok) throw new Error(identity.message);
  const registry = readProductRegistry(product);
  if (!registry.present || 'refused' in registry) throw new Error(!registry.present ? `Fill requires ${join(product, 'docs/kinds.yaml')}` : registry.refused.map(e => `${e.file}:${e.line}: ${e.message}`).join('\n'));
  const agent = options.agent ?? 'claude';
  if (agent !== 'claude' && agent !== 'codex') throw new Error(`Unsupported fill agent: ${String(agent)}`);
  const maxUnits = options.maxUnits ?? 60;
  if (!Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > 10000) throw new Error('maxUnits must be a whole number from 1 through 10000');
  const repos = identity.product.repos.length ? identity.product.repos.map(r => resolve(product, 'repos', r.name)) : [product];
  const source = repos[0]!;
  for (const repo of repos) { if (git(repo, 'rev-parse', '--show-toplevel') !== repo) throw new Error(`Connected repository is not a Git root: ${repo}`); }
  const commit = git(source, 'rev-parse', 'HEAD'); let branchName='main'; try { branchName=git(product,'symbolic-ref','refs/remotes/origin/HEAD').split('/').at(-1) ?? 'main'; } catch { branchName=git(product,'branch','--show-current') || 'main'; } const defaultHead=git(product,'rev-parse',branchName);
  const registryText = await readFile(join(product, 'docs/kinds.yaml'), 'utf8'); const registryHash = hashFillInput(registryText);
  const paths = fillStatePaths(product); await mkdir(paths.root, { recursive: true });
  let prior: FillRun | undefined; try { prior = await readFillJson<FillRun>(paths.run); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const run = prior && prior.status !== 'complete' && prior.status !== 'blocked' ? { ...prior, status: 'running' as const, controlOpen: true, updatedAt: new Date().toISOString() } : createFillRun({ productSnapshot: { repository: source, defaultBranch: branchName, commit, registryHash }, agentBranch: `madarch/fill/${randomUUID()}` });
  const store = createFillFileStore(product); await store.saveRun(run);
  const runController=new AbortController(); let controlWatch=true; let paused=false; const controlWatcher=(async()=>{ while(controlWatch&&!runController.signal.aborted){ try { const control=await consumeFillControl(product,run.id); if(control==='stopped'){runController.abort();break;} paused=control==='paused'; if(control==='paused'){ await new Promise(resolve=>{const timer=setTimeout(resolve,250);timer.unref();}); } else await new Promise(resolve=>{const timer=setTimeout(resolve,250);timer.unref();}); } catch { await new Promise(resolve=>{const timer=setTimeout(resolve,250);timer.unref();}); } } })();
  const assertRunning=async()=>{ while(paused&&!runController.signal.aborted) await new Promise(resolve=>{const timer=setTimeout(resolve,100);timer.unref();}); if(runController.signal.aborted)throw new Error(`Fill run ${run.id} was stopped`); };
  const previousUnits = await store.loadUnits(); const priorById = new Map(previousUnits.map(u => [u.id,u]));
  const priorInventory = priorById.get('inventory-repository');
  const inv = await inventoryRepository(source, commit); const invPlan = inventoryUnitPlan(inv);
  const inventoryUnit = priorInventory && JSON.stringify(priorInventory.inputHashes) === JSON.stringify(invPlan.inputHashes) && priorInventory.status === 'complete' ? priorInventory : { ...priorInventory, ...invPlan, stage: 'inventory' as const, status:'running' as const, attempt:(priorInventory?.attempt??0)+1, outputPaths:invPlan.outputPaths, createdAt:priorInventory?.createdAt??new Date().toISOString(), updatedAt:new Date().toISOString() } as FillUnit;
  if (inventoryUnit.status !== 'complete') { await assertRunning(); await store.saveUnit(inventoryUnit); await executeInventoryUnit(product, inventoryUnit, inv, runController.signal); Object.assign(inventoryUnit,{status:'complete',finishedAt:new Date().toISOString()}); await store.saveUnit(inventoryUnit); }
  const index = await indexRepository(source, commit); const plans: FillUnitPlan[] = structuralIndexUnitPlans(index, inv.contentHash);
  if (identity.product.repos.length > 1) throw new Error(`This fill version cannot yet combine ${identity.product.repos.length} connected repositories without losing source anchors; no partial run was started.`);
  const requiredUnits=1+plans.length+2; if(requiredUnits>maxUnits) throw new Error(`maxUnits ${maxUnits} is too small for the complete run (${requiredUnits} units); refusing a partial result.`);
  const units: FillUnit[] = [inventoryUnit];
  for (const plan of plans) {
    await assertRunning();
    let unit = priorById.get(plan.id);
    if (!unit || unit.status !== 'complete' || JSON.stringify(unit.inputHashes) !== JSON.stringify(plan.inputHashes)) { unit = { ...plan, stage:'index',status:'running',attempt:(unit?.attempt??0)+1,createdAt:unit?.createdAt??new Date().toISOString(),updatedAt:new Date().toISOString(),outputPaths:plan.outputPaths } as FillUnit; await store.saveUnit(unit); await executeStructuralIndexUnit(source,product,unit,runController.signal); unit={...unit,status:'complete',finishedAt:new Date().toISOString()}; await store.saveUnit(unit); }
    units.push(unit);
  }
  const outputFolder = paths.outputs;
  const indexFiles = await Promise.all(units.filter(u=>u.stage==='index').map(u=>readUnitOutput<any>(product,u)));
  const fullIndex: StructuralIndexResult = { repository: source, commit, files:indexFiles, contentHash:hashFillInput(JSON.stringify(indexFiles)) };
  const materialPaths=execFileSync('git',['-C',source,'ls-tree','-r','--name-only',commit],{encoding:'utf8'}).split('\n').filter(path=>path && (path.toLowerCase().endsWith('.md')||path.toLowerCase()==='readme')).sort(codePoint); const materials=[...materialPaths.map(path=>readPinnedGitMaterial(source,commit,path,'document')),readPinnedGitHistory(source,commit)];
  const allSources = createClaimSources(commit,[...materials,...fullIndex.files.map(file=>({path:file.path,text:execFileSync('git',['show',`${commit}:${file.path}`],{cwd:source,encoding:'utf8'}),type:'code' as const,blob:file.blob}))]);
  const prompt = await (await import('node:fs/promises')).readFile(new URL('./claims-prompts/repository-claims.md', import.meta.url),'utf8');
  const claimPlan: FillUnitPlan = { id:'claims-repository',stage:'claims',inputHashes:hashFillInputs({index:JSON.stringify(fullIndex),registry:registryText,docs:JSON.stringify(materials)}),outputPaths:[`.madarch/fill/outputs/claims-repository/claims.json`],dependencies:units.map(u=>u.id) };
  let claimUnit = priorById.get(claimPlan.id); let extraction: ClaimsExtraction;
  if (claimUnit?.status==='complete'&&JSON.stringify(claimUnit.inputHashes)===JSON.stringify(claimPlan.inputHashes)) extraction=await readUnitOutput(product,claimUnit);
  else {
    claimUnit={...claimPlan,status:'running',attempt:(claimUnit?.attempt??0)+1,createdAt:claimUnit?.createdAt??new Date().toISOString(),updatedAt:new Date().toISOString()} as FillUnit; await store.saveUnit(claimUnit);
    const response=await agentJson(options,agent,source,'claims',claimUnit,`${prompt}\n\nRegistry:\n${registryText}\n\nAllowed source records (cite these ids exactly):\n${JSON.stringify(allSources)}\n\nMaterials:\n${materials.map(m=>`### ${m.path}\n${m.text}`).join('\n')}`,async()=>{},runController.signal);
    await assertRunning();
    const rows=asArray<any>(response.claims??response,'claims');
    // Ensure every claim is tied to a known source id; prompts are given source catalogue identifiers.
    const claims=rows.map((c:any)=>({kind:String(c.kind),text:String(c.text),layer:c.layer as ClaimLayer,confidence:Number(c.confidence??0.8),sourceIds:asArray<string>(c.sourceIds,'sourceIds')}));
    const built=assembleClaims({runId:run.id,unitId:claimUnit.id,kinds:registry.kinds,sources:allSources,agentClaims:claims}); extraction={...built,usage:{elapsedMs:0,inputTokens:0,outputTokens:0},inaccessibleLinks:[]};
    const out=resolve(product,claimPlan.outputPaths[0]!); await import('./fill-runtime.js').then(({writeFillJsonAtomic})=>writeFillJsonAtomic(out,extraction)); claimUnit={...claimUnit,status:'complete',finishedAt:new Date().toISOString()}; await store.saveUnit(claimUnit);
  }
  const codeMap=buildCodeMap(fullIndex,allSources); const mapPath=await persistCodeMap(join(outputFolder,'code-map'),codeMap);
  const mapSource: ClaimSource={id:`src-${hashFillInput(JSON.stringify(codeMap)).slice(0,24)}`,address:'fill/code-map.json',version:commit,anchor:'whole',readAt:new Date().toISOString(),sha256:hashFillInput(JSON.stringify(codeMap)),mediaType:'application/json',byteLength:Buffer.byteLength(JSON.stringify(codeMap)),type:'code'};
  const synthesisClaimUnitPlan: FillUnitPlan={id:'synthesis-pages',stage:'synthesis',inputHashes:hashFillInputs({claims:JSON.stringify(extraction.claims),map:JSON.stringify(codeMap),registry:registryText}),outputPaths:['.madarch/fill/outputs/synthesis-pages/pages.json'],dependencies:[claimPlan.id]};
  const synthesisUnit={...synthesisClaimUnitPlan,status:'running',attempt:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()} as FillUnit; await store.saveUnit(synthesisUnit);
  const target={name:'Overview',folder:'docs/overview',hint:'Describe this product from its sources.'};
  const overviewTarget={name:'overview',folder:'docs/overview',hint:'Describe the product and its users from sourced evidence.'};
  const synthesisPrompt=await (await import('node:fs/promises')).readFile(new URL('./synthesis-prompts/page-synthesis.md',import.meta.url),'utf8');
  const criticPrompt=await (await import('node:fs/promises')).readFile(new URL('./synthesis-prompts/page-critic.md',import.meta.url),'utf8');
  const pages=await synthesizePages({ overview:overviewTarget, kinds:registry.kinds, codeMap, claims:extraction.claims as SynthesisClaim[], sources:allSources,
    generate:async({target,claims,priorDraft,criticFindings,pass})=>{
      const response=await agentJson(options,agent,source,'synthesis',synthesisUnit,`${synthesisPrompt}\nTarget: ${JSON.stringify(target)}\nPass: ${pass}\nPrior draft: ${priorDraft??''}\nCritic findings: ${JSON.stringify(criticFindings??[])}\nCode map: ${JSON.stringify(codeMap)}\nSupported claims: ${JSON.stringify(claims)}\nSource catalogue: ${JSON.stringify(allSources)}`,async()=>{},runController.signal);
    await assertRunning();
      return {title:String(response.title??target.name),body:String(response.body??''),claims:asArray<SynthesisClaim>(response.claims,'claims'),segments:asArray<any>(response.segments,'segments')};
    },
    critique:async(page,pass)=>{
      const response=await agentJson(options,agent,source,'synthesis',synthesisUnit,`${criticPrompt}\nPass: ${pass}\nPage: ${JSON.stringify(page)}\nRegistry kind: ${JSON.stringify(page.kind)}\nClaims: ${JSON.stringify(page.claims)}\nSources: ${JSON.stringify(allSources)}`,async()=>{},runController.signal);
    await assertRunning();
      return {findings:asArray<string>(response.findings??[],'findings')};
    }, maxRevisions:2, questions:extraction.questions,
  });
  const mapUnit={...synthesisClaimUnitPlan,status:'complete',finishedAt:new Date().toISOString()} as FillUnit; await store.saveUnit(mapUnit);
  // A real product worktree is created for controlled proposed-page writes.
  const worktree=join(resolve(product,'..'),`.madarch-fill-${run.id}`); await mkdir(paths.root,{recursive:true});
  try { const existing=execFileSync('git',['-C',product,'worktree','list','--porcelain'],{encoding:'utf8'}); if(!existing.split('\n').some(line=>line===`worktree ${worktree}`)) execFileSync('git',['-C',product,'worktree','add','-B',run.agentBranch,worktree,defaultHead],{stdio:'ignore'}); } catch(error) { throw new Error(`Cannot create or resume fill agent worktree ${worktree}: ${(error as Error).message}`); }
  const outputs=await applySynthesisPages({agentWorktree:worktree,sourceCheckout:source,expectedAgentBranch:run.agentBranch,pages,sources:allSources});
  execFileSync('git',['-C',worktree,'add','--',...outputs.map(path=>resolve(worktree,path))]); execFileSync('git',['-C',worktree,'-c','user.name=Madarch Fill','-c','user.email=fill@localhost','commit','-m',`Fill synthesis stage ${run.id}`]);
  const stageCommit=git(worktree,'rev-parse','HEAD');
  // Merge only as a fast-forward: any human commit on the default branch makes this stage wait rather than overwrite it.
  try { execFileSync('git',['-C',product,'update-ref',`refs/heads/${branchName}`,stageCommit,defaultHead],{stdio:'ignore'}); } catch { const blocked={...run,status:'blocked' as const,controlOpen:false,updatedAt:new Date().toISOString()}; await store.saveRun(blocked); throw new Error(`The default branch ${branchName} changed during synthesis; agent output remains on ${run.agentBranch} for review.`); }
  const summary={runId:run.id,agent,branch:run.agentBranch,stages:['inventory','index','claims','code-map','synthesis'],outputs,questionReview:'hook-pending-co2d.1',counts:{reused:previousUnits.filter(u=>u.status==='complete').length,run:units.length+2},nextStep:'Review the proposed pages and their sources in the wiki.'};
  controlWatch=false; const completed={...run,status:'complete' as const,controlOpen:false,updatedAt:new Date().toISOString()}; await store.saveRun(completed); const summaryPath=join(paths.root,'report.json'); await import('./fill-runtime.js').then(({writeFillJsonAtomic})=>writeFillJsonAtomic(summaryPath,summary));
  void controlWatcher; return {run:completed,counts:summary.counts,questionReview:'hook-pending-co2d.1'};
}
