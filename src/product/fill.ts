/** Shared local fill entry point: pins source repos, persists resumable units and drives stages. */
import { randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readProduct } from './manifest.js';
import { readProductRegistry } from './registry.js';
import { inventoryRepository, indexRepository, inventoryUnitPlan, structuralIndexUnitPlans, executeInventoryUnit, executeStructuralIndexUnit, type StructuralIndexResult, type RepositoryInventoryResult } from './fill-index.js';
import { consumeFillControl, createFillRun, createFillFileStore, fillStatePaths, hashFillInput, hashFillInputs, readFillJson, reconcileFillUnit, withFillControlLock, writeFillJsonAtomic, type FillRun, type FillStage, type FillUnit, type FillUnitPlan } from './fill-runtime.js';
import { createHeadlessAgentExecutor, type AgentKind, type AgentSettings } from './fill-agents.js';
import { assembleClaims, createClaimSources, readPinnedGitMaterial, readPinnedGitHistory, type ClaimsExtraction, type ClaimSource, type ExtractedClaim, type ClaimLayer } from './fill-claims.js';
import { buildCodeMap, persistCodeMap, synthesizePages, applySynthesisPages, type SynthesisClaim, type SynthesizedPage } from './fill-synthesis.js';
import { asArray, asSourceIdList, claimRowsFromAnswer, parseAgentAnswer, requestValidatedAgentAnswer, validateClaimsAnswer } from './fill-agent-answers.js';

export interface StartFillOptions { agent?: AgentKind; model?: string; ompExecutable?: string; ompExtension?: string; ompTools?: string; maxUnits?: number; executorFactory?: (context: { stage: FillStage; repository: string; prompt: string; onEvent: (event: unknown) => Promise<void> }) => { execute: (prompt: string, signal: AbortSignal, onEvent: (event: unknown) => Promise<void>) => Promise<string> }; }
export interface StartFillResult { run: FillRun; counts: { reused: number; run: number }; questionReview: 'hook-pending-co2d.1'; }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
export function createAgentCallBudget(maxCalls:number, initialCalls=0, onDispatch?: (calls:number)=>Promise<void>): { dispatch<T>(call:()=>Promise<T>):Promise<T>; count:()=>number } { let calls=initialCalls; return { count:()=>calls, dispatch:async<T>(call:()=>Promise<T>)=>{if(calls>=maxCalls)throw new Error(`maxUnits ${maxCalls} exhausted before agent call ${calls+1}`); calls++; await onDispatch?.(calls); return call();} }; }
const codePoint = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** Run one agent call and return its raw answer text; parsing and validation happen at the call site. */
async function agentRaw(options: StartFillOptions, agent: AgentKind, repository: string, stage: FillStage, unit: FillUnit, prompt: string, events: (event: unknown) => Promise<void>, signal: AbortSignal): Promise<string> {
  if (options.executorFactory) {
    const executor = options.executorFactory({ stage, repository, prompt, onEvent: events });
    return await executor.execute(prompt, signal, events);
  }
  let output = '';
  const executor = createHeadlessAgentExecutor({ kind: agent, snapshot: repository, promptFor: () => prompt, settings:{model:options.model,executable:options.ompExecutable,extension:options.ompExtension,tools:options.ompTools}, onEvent: async (event) => { await events(event); }, onRawLine: async (_unit, line) => { output += `${line}\n`; } });
  await executor.execute(unit, signal, async (summary) => { await events({ summary }); });
  // Provider stream-json wraps final text in several event shapes; collect only assistant text blocks.
  const texts: string[] = [];
  for (const line of output.split('\n')) { try { const row = JSON.parse(line); if (typeof row.result === 'string') texts.push(row.result); for (const c of row.message?.content ?? []) if (typeof c.text === 'string') texts.push(c.text); for (const c of row.assistantMessageEvent?.content ?? []) if (typeof c.text === 'string') texts.push(c.text); if (typeof row.text === 'string') texts.push(row.text); } catch { /* ignored provider protocol lines */ } }
  if (!texts.length) throw new Error(`${agent} returned no structured assistant output for ${stage}`);
  return texts.at(-1)!;
}
async function readUnitOutput<T>(product: string, unit: FillUnit): Promise<T> { const path = unit.outputPaths[0]; if (!path) throw new Error(`Unit ${unit.id} has no output path`); return readFillJson<T>(resolve(product, path)); }

/** Start or resume the product's one local fill run. Returns after all currently planned units drain. */
async function startFillUnlocked(productFolder: string, options: StartFillOptions = {}): Promise<StartFillResult> {
  const product = resolve(productFolder); const identity = readProduct(product);
  if (!identity.ok) throw new Error(identity.message);
  const registry = readProductRegistry(product);
  if (!registry.present || 'refused' in registry) throw new Error(!registry.present ? `Fill requires ${join(product, 'docs/kinds.yaml')}` : registry.refused.map(e => `${e.file}:${e.line}: ${e.message}`).join('\n'));
  const agent = options.agent ?? 'claude';
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'omp') throw new Error(`Unsupported fill agent: ${String(agent)}`); if(agent==='omp'&&(!options.model||!options.ompExtension)) throw new Error('OMP requires --model and a configured OMP gateway extension.');
  const maxUnits = options.maxUnits ?? 60;
  if (!Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > 10000) throw new Error('maxUnits must be a whole number from 1 through 10000');
  const repos = identity.product.repos.length ? identity.product.repos.map(r => resolve(product, 'repos', r.name)) : [product];
  const source = repos[0]!;
  for (const repo of repos) { if (git(repo, 'rev-parse', '--show-toplevel') !== repo) throw new Error(`Connected repository is not a Git root: ${repo}`); }
  const commit = git(source, 'rev-parse', 'HEAD'); let branchName='main'; try { branchName=git(product,'symbolic-ref','refs/remotes/origin/HEAD').split('/').at(-1) ?? 'main'; } catch { branchName=git(product,'branch','--show-current') || 'main'; } const defaultHead=git(product,'rev-parse',branchName);
  const registryText = await readFile(join(product, 'docs/kinds.yaml'), 'utf8'); const registryHash = hashFillInput(registryText);
  const paths = fillStatePaths(product); await mkdir(paths.root, { recursive: true });
  let prior: FillRun | undefined; try { prior = await readFillJson<FillRun>(paths.run); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (prior && ['running','paused','stopped'].includes(prior.status) && (prior.productSnapshot.commit !== commit || prior.productSnapshot.registryHash !== registryHash || prior.productSnapshot.defaultBranch !== branchName)) throw new Error(`Cannot resume fill run ${prior.id}: source commit, registry hash, or default branch changed.`);
  const run = prior && ['running','paused','stopped'].includes(prior.status) ? { ...prior, status: 'running' as const, controlOpen: true, updatedAt: new Date().toISOString() } : createFillRun({ productSnapshot: { repository: source, defaultBranch: branchName, commit, registryHash }, agentBranch: `madarch/fill/${randomUUID()}` });
  const store = createFillFileStore(product); await store.saveRun(run);
  const runController=new AbortController(); let controlWatch=true; let paused=false; const controlWatcher=(async()=>{ while(controlWatch&&!runController.signal.aborted){ try { const control=await consumeFillControl(product,run.id); if(control==='stopped'){runController.abort(); await store.saveRun({...run,status:'stopped',controlOpen:false,updatedAt:new Date().toISOString()}); break;} paused=control==='paused'; if(paused){runController.abort(); await store.saveRun({...run,status:'paused',controlOpen:false,updatedAt:new Date().toISOString()}); break;} if(control==='paused'){ await new Promise(resolve=>{const timer=setTimeout(resolve,250);timer.unref();}); } else await new Promise(resolve=>{const timer=setTimeout(resolve,250);timer.unref();}); } catch { await new Promise(resolve=>{const timer=setTimeout(resolve,250);timer.unref();}); } } })();
  const assertRunning=async()=>{ while(paused&&!runController.signal.aborted) await new Promise(resolve=>{const timer=setTimeout(resolve,100);timer.unref();}); if(runController.signal.aborted)throw new Error(`Fill run ${run.id} was ${paused?'paused':'stopped'}; start fill again to resume.`); };
  const previousUnits = await store.loadUnits();
  // The runtime's rule: a unit left 'running' by a crashed process is requeued on the next start.
  const priorById = new Map(previousUnits.map(u => [u.id, reconcileFillUnit(u, u.inputHashes)]));
  const priorInventory = priorById.get('inventory-repository');
  const inv = await inventoryRepository(source, commit); const invPlan = inventoryUnitPlan(inv);
  const inventoryUnit = priorInventory && JSON.stringify(priorInventory.inputHashes) === JSON.stringify(invPlan.inputHashes) && priorInventory.status === 'complete' ? priorInventory : { ...priorInventory, ...invPlan, stage: 'inventory' as const, status:'running' as const, attempt:(priorInventory?.attempt??0)+1, outputPaths:invPlan.outputPaths, createdAt:priorInventory?.createdAt??new Date().toISOString(), updatedAt:new Date().toISOString() } as FillUnit;
  if (inventoryUnit.status !== 'complete') { await assertRunning(); await store.saveUnit(inventoryUnit); await executeInventoryUnit(product, inventoryUnit, inv, runController.signal); Object.assign(inventoryUnit,{status:'complete',finishedAt:new Date().toISOString()}); await store.saveUnit(inventoryUnit); }
  const index = await indexRepository(source, commit); const plans: FillUnitPlan[] = structuralIndexUnitPlans(index, inv.contentHash);
  if (identity.product.repos.length > 1) throw new Error(`This fill version cannot yet combine ${identity.product.repos.length} connected repositories without losing source anchors; no partial run was started.`);
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
  const callsPath=join(paths.root,'agent-calls.json'); let initialCalls=0; try { const saved=JSON.parse(await readFile(callsPath,'utf8')); if(saved.runId===run.id) initialCalls=Number(saved.calls)||0; } catch {} const agentBudget=createAgentCallBudget(maxUnits,initialCalls,async calls=>{await import('./fill-runtime.js').then(({writeFillJsonAtomic})=>writeFillJsonAtomic(callsPath,{runId:run.id,calls}));}); const callAgent=(...args: Parameters<typeof agentRaw>)=>agentBudget.dispatch(()=>agentRaw(...args));
  const claimPlan: FillUnitPlan = { id:'claims-repository',stage:'claims',inputHashes:hashFillInputs({index:JSON.stringify(fullIndex),registry:registryText,docs:JSON.stringify(materials)}),outputPaths:[`.madarch/fill/outputs/claims-repository/claims.json`],dependencies:units.map(u=>u.id) };
  const codeMap=buildCodeMap(fullIndex,allSources); const mapPath=await persistCodeMap(join(outputFolder,'code-map'),codeMap);
  let claimUnit = priorById.get(claimPlan.id); let extraction: ClaimsExtraction;
  if (claimUnit?.status==='complete'&&JSON.stringify(claimUnit.inputHashes)===JSON.stringify(claimPlan.inputHashes)) extraction=await readUnitOutput(product,claimUnit);
  else {
    claimUnit={...claimPlan,status:'running',attempt:(claimUnit?.attempt??0)+1,createdAt:claimUnit?.createdAt??new Date().toISOString(),updatedAt:new Date().toISOString()} as FillUnit; await store.saveUnit(claimUnit);
    const activeUnit: FillUnit = claimUnit;
    const claimsPrompt=`${prompt}\n\nRegistry:\n${registryText}\n\nAllowed source records (cite these ids exactly):\n${JSON.stringify(allSources)}\n\nMaterials:\n${materials.map(m=>`### ${m.path}\n${m.text}`).join('\n')}`;
    const outcome=await requestValidatedAgentAnswer({
      prompt: claimsPrompt,
      call: (retryPrompt) => agentBudget.dispatch(() => agentRaw(options,agent,source,'claims',activeUnit,retryPrompt,async()=>{},runController.signal)),
      validate: (value) => validateClaimsAnswer(value,registry.kinds,allSources),
    });
    await assertRunning();
    if (outcome.ok) {
      const rows=claimRowsFromAnswer(outcome.value);
      // Ensure every claim is tied to a known source id; prompts are given source catalogue identifiers.
      const claims=rows.map((c:any)=>({kind:String(c.kind),text:String(c.text),layer:c.layer as ClaimLayer,confidence:Number(c.confidence??0.8),sourceIds:asSourceIdList(c.sourceIds,'sourceIds')}));
      const built=assembleClaims({runId:run.id,unitId:claimUnit.id,kinds:registry.kinds,sources:allSources,agentClaims:claims}); extraction={...built,usage:{elapsedMs:0,inputTokens:0,outputTokens:0},inaccessibleLinks:[]};
      const out=resolve(product,claimPlan.outputPaths[0]!); await writeFillJsonAtomic(out,extraction); claimUnit={...claimUnit,status:'complete',finishedAt:new Date().toISOString()}; await store.saveUnit(claimUnit);
    } else {
      // The answer stayed invalid after the retries: fail this unit with the errors and the saved raw
      // answers, and let the run finish with every claims-independent unit instead of blocking whole.
      const rawAnswersPath=join(claimPlan.outputPaths[0]!,'..','invalid-answers.json');
      await writeFillJsonAtomic(resolve(product,rawAnswersPath),{unitId:claimPlan.id,attempts:outcome.attempts,errors:outcome.errors,answers:outcome.answers});
      claimUnit={...claimUnit,status:'blocked' as const,error:outcome.errors.join('\n'),finishedAt:new Date().toISOString()}; await store.saveUnit(claimUnit);
      await assertRunning();
      const summary={runId:run.id,agent,branch:run.agentBranch,stages:['inventory','index','claims','code-map','synthesis'],outputs:[],questionReview:'hook-pending-co2d.1',counts:{reused:previousUnits.filter(u=>u.status==='complete').length,run:agentBudget.count()},failedUnits:[{id:claimPlan.id,errors:outcome.errors,rawAnswers:rawAnswersPath}],nextStep:'Fix the failed unit and start fill again to resume; its recorded raw answers name what went wrong.'};
      controlWatch=false; const blockedRun={...run,status:'blocked' as const,controlOpen:false,updatedAt:new Date().toISOString()}; await store.saveRun(blockedRun); await writeFillJsonAtomic(join(paths.root,'report.json'),summary);
      void controlWatcher; return {run:blockedRun,counts:summary.counts,questionReview:'hook-pending-co2d.1'};
    }
  }
  const mapSource: ClaimSource={id:`src-${hashFillInput(JSON.stringify(codeMap)).slice(0,24)}`,address:'fill/code-map.json',version:commit,anchor:'whole',readAt:new Date().toISOString(),sha256:hashFillInput(JSON.stringify(codeMap)),mediaType:'application/json',byteLength:Buffer.byteLength(JSON.stringify(codeMap)),type:'code'};
  const synthesisClaimUnitPlan: FillUnitPlan={id:'synthesis-pages',stage:'synthesis',inputHashes:hashFillInputs({claims:JSON.stringify(extraction.claims),map:JSON.stringify(codeMap),registry:registryText}),outputPaths:['.madarch/fill/outputs/synthesis-pages/pages.json'],dependencies:[claimPlan.id]};
  const synthesisUnit={...synthesisClaimUnitPlan,status:'running',attempt:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()} as FillUnit; await store.saveUnit(synthesisUnit);
  const target={name:'Overview',folder:'docs/overview',hint:'Describe this product from its sources.'};
  const overviewTarget={name:'overview',folder:'docs/overview',hint:'Describe the product and its users from sourced evidence.'};
  const synthesisPrompt=await (await import('node:fs/promises')).readFile(new URL('./synthesis-prompts/page-synthesis.md',import.meta.url),'utf8');
  const criticPrompt=await (await import('node:fs/promises')).readFile(new URL('./synthesis-prompts/page-critic.md',import.meta.url),'utf8');
  const pages=await synthesizePages({ overview:overviewTarget, kinds:registry.kinds, codeMap, claims:extraction.claims as SynthesisClaim[], sources:allSources,
    generate:async({target,claims,priorDraft,criticFindings,pass})=>{
      const raw=await callAgent(options,agent,source,'synthesis',synthesisUnit,`${synthesisPrompt}\nTarget: ${JSON.stringify(target)}\nPass: ${pass}\nPrior draft: ${priorDraft??''}\nCritic findings: ${JSON.stringify(criticFindings??[])}\nCode map: ${JSON.stringify(codeMap)}\nSupported claims: ${JSON.stringify(claims)}\nSource catalogue: ${JSON.stringify(allSources)}`,async()=>{},runController.signal);
    await assertRunning();
      const parsed=parseAgentAnswer(raw); if (!parsed.ok) throw new Error(parsed.error); const response=parsed.value as any;
      return {title:String(response.title??target.name),body:String(response.body??''),claims:asArray<SynthesisClaim>(response.claims,'claims'),segments:asArray<any>(response.segments,'segments')};
    },
    critique:async(page,pass)=>{
      const raw=await callAgent(options,agent,source,'synthesis',synthesisUnit,`${criticPrompt}\nPass: ${pass}\nPage: ${JSON.stringify(page)}\nRegistry kind: ${JSON.stringify(page.kind)}\nClaims: ${JSON.stringify(page.claims)}\nSources: ${JSON.stringify(allSources)}`,async()=>{},runController.signal);
    await assertRunning();
      const parsed=parseAgentAnswer(raw); if (!parsed.ok) throw new Error(parsed.error); const response=parsed.value as any;
      return {findings:asArray<string>(response.findings ?? [],'findings')};
    }, maxRevisions:2, questions:extraction.questions,
  });
  const mapUnit={...synthesisClaimUnitPlan,status:'complete',finishedAt:new Date().toISOString()} as FillUnit; await store.saveUnit(mapUnit);
  // A real product worktree is created for controlled proposed-page writes.
  const worktree=join(resolve(product,'..'),`.madarch-fill-${run.id}`); await mkdir(paths.root,{recursive:true});
  try { const existing=execFileSync('git',['-C',product,'worktree','list','--porcelain'],{encoding:'utf8'}); if(!existing.split('\n').some(line=>line===`worktree ${worktree}`)) execFileSync('git',['-C',product,'worktree','add','-B',run.agentBranch,worktree,defaultHead],{stdio:'ignore'}); } catch(error) { throw new Error(`Cannot create or resume fill agent worktree ${worktree}: ${(error as Error).message}`); }
  await assertRunning(); const outputs=await applySynthesisPages({agentWorktree:worktree,sourceCheckout:source,expectedAgentBranch:run.agentBranch,pages,sources:allSources});
  execFileSync('git',['-C',worktree,'add','--',...outputs.map(path=>resolve(worktree,path))]); execFileSync('git',['-C',worktree,'-c','user.name=Madarch Fill','-c','user.email=fill@localhost','commit','-m',`Fill synthesis stage ${run.id}`]);
  const stageCommit=git(worktree,'rev-parse','HEAD');
  await assertRunning();
  if (git(worktree,'branch','--show-current') !== run.agentBranch) throw new Error(`Fill worktree ${worktree} is not on expected branch ${run.agentBranch}.`);
  // Merge only as a fast-forward: any human commit on the default branch makes this stage wait rather than overwrite it.
  try { await withFillControlLock(product, async()=>{ await assertRunning(); let pending:any; try { pending=JSON.parse(await readFile(join(paths.root,'control.json'),'utf8')); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; } if(pending?.runId===run.id) { const requested=pending.action; await consumeFillControl(product,run.id,true); const status=requested==='stop'?'stopped':'paused'; await store.saveRun({...run,status,controlOpen:false,updatedAt:new Date().toISOString()}); throw new Error(`Fill run ${run.id} was ${status}; start fill again to resume.`); } await store.saveRun({...run,controlOpen:false,updatedAt:new Date().toISOString()}); if(git(source,'rev-parse','HEAD')!==commit || hashFillInput(await readFile(join(product,'docs/kinds.yaml'),'utf8'))!==registryHash) throw new Error(`Fill inputs changed during run ${run.id}; refusing to merge stale output.`); const currentHead=git(product,'rev-parse',branchName); execFileSync('git',['-C',product,'merge-base','--is-ancestor',currentHead,stageCommit],{stdio:'ignore'}); execFileSync('git',['-C',product,'update-ref',`refs/heads/${branchName}`,stageCommit,currentHead],{stdio:'ignore'}); }); } catch(error) { const message=(error as Error).message; if(message.includes('was paused')||message.includes('was stopped')) throw error; if(message.includes('Fill inputs changed')) { await store.saveRun({...run,status:'blocked',controlOpen:false,updatedAt:new Date().toISOString()}); throw error; } const blocked={...run,status:'blocked' as const,controlOpen:false,updatedAt:new Date().toISOString()}; await store.saveRun(blocked); throw new Error(`The default branch ${branchName} changed during synthesis; agent output remains on ${run.agentBranch} for review: ${message}`); }
  await assertRunning(); const summary={runId:run.id,agent,branch:run.agentBranch,stages:['inventory','index','claims','code-map','synthesis'],outputs,questionReview:'hook-pending-co2d.1',counts:{reused:previousUnits.filter(u=>u.status==='complete').length,run:agentBudget.count()},nextStep:'Review the proposed pages and their sources in the wiki.'};
  controlWatch=false; const completed={...run,status:'complete' as const,controlOpen:false,updatedAt:new Date().toISOString()}; await store.saveRun(completed); const summaryPath=join(paths.root,'report.json'); await import('./fill-runtime.js').then(({writeFillJsonAtomic})=>writeFillJsonAtomic(summaryPath,summary));
  void controlWatcher; return {run:completed,counts:summary.counts,questionReview:'hook-pending-co2d.1'};
}

/** Refuse overlapping starts; release the per-product lock on every outcome. */
export async function startFill(productFolder: string, options: StartFillOptions = {}): Promise<StartFillResult> {
  const product=resolve(productFolder); const lock=join(fillStatePaths(product).root,'active.lock'); await mkdir(fillStatePaths(product).root,{recursive:true});
  try { await mkdir(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code==='EEXIST') { let runId='unknown'; try { runId=(await readFillJson<FillRun>(fillStatePaths(product).run)).id; } catch {} throw new Error(`A fill run is already active for this product (run ${runId}).`); } throw error; }
  try { return await startFillUnlocked(product,options); } catch(error) { try { const state=fillStatePaths(product); const run=await readFillJson<FillRun>(state.run); if(run.status==='running' && /was paused|was stopped/.test((error as Error).message)) await createFillFileStore(product).saveRun({...run,status:/was paused/.test((error as Error).message)?'paused':'stopped',controlOpen:false,updatedAt:new Date().toISOString()}); else if(run.status==='running') await createFillFileStore(product).saveRun({...run,status:'blocked',controlOpen:false,updatedAt:new Date().toISOString()}); } catch {} throw error; } finally { await rm(lock,{recursive:true,force:true}); }
}
