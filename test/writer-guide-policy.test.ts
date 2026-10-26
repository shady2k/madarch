import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore } from '../src/graph/index.js';
import { fillGraph } from '../src/extract/driver/index.js';
import { extractFiles } from '../src/extract/driver/files.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { gitEnv } from './git-env.js';
import { canonicalJsonDigest } from '../src/model/canonical.js';
import { validateGuide } from '../src/writer/guides/validate.js';
import { GUIDE_SCHEMA } from '../src/writer/guides/model.js';
import { containsGuideSecret, createGuideWriter } from '../src/writer/guides/writer.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { renderGuideArtifact } from '../src/writer/guides/artifact.js';

import { guidePacketPolicy, prepareGuideEvidence, resolveGuideContext, type GuidePreparedEvidence } from '../src/writer/guides/writer.js';
import { guideDigest } from '../src/writer/guides/digest.js';
import { extractOperations } from '../src/extract/operations/index.js';
import { firstGuideCursor, readGuidePageContext, registerGuidePages, type GuideContextPage } from '../src/writer/guides/prepared.js';
import type { GuidePreparedUnit } from '../src/writer/guides/host-contract.js';

test('configuration and host-known literal values are withheld with explicit policy provenance',()=>{
 const context={valid:'2026-01-01T00:00:00Z',known:'2026-01-02T00:00:00Z',state:'0',repositories:[{name:'sample',commit:'a'.repeat(40)}]};
 const ground={repository:'sample',commit:'a'.repeat(40),path:'deployment.yaml',line:1,endLine:2};
 const text='value: private-config-value';
 const evidence:GuidePreparedEvidence={context,facts:[{id:'1',kind:'code.env-definition',properties:{value:'private-config-value'}},{id:'2',kind:'code.route',label:'status'}],spans:[{ground,text,digest:guideDigest({ground,text})}],gaps:[],policy:{version:'withhold-config-values@1',withheldValues:1,classifiedSources:['sample/deployment.yaml']},configValues:['private-config-value']};
 const result=guidePacketPolicy(evidence,['host-private-value']);
 expect(JSON.stringify(result.evidence)).not.toContain('private-config-value');expect(JSON.stringify(result.evidence)).not.toContain('host-private-value');expect(result.evidence.configValues).toBeUndefined();
 expect(result.evidence.spans).toEqual([]);expect(result.evidence.gaps.join(' ')).toContain('1 source spans');expect(result.evidence.policy.classifiedSources).toContain('sample/deployment.yaml');expect(result.evidence.facts).toContainEqual({id:'2',kind:'code.route',label:'status'});
});


test('parsed facts and source spans with escaped sensitive characters are withheld before pagination',()=>{
 const privateValue='private"credential';
 const context={valid:'2026-01-01T00:00:00Z',known:'2026-01-02T00:00:00Z',state:'0',repositories:[{name:'sample',commit:'a'.repeat(40)}]};
 const ground={repository:'sample',commit:'a'.repeat(40),path:'settings.yaml',line:1,endLine:1};
 const text=`const configured = ${JSON.stringify(privateValue)}; // ${privateValue}`;
 const evidence:GuidePreparedEvidence={context,facts:[{id:'definition',kind:'code.env-definition',properties:{value:privateValue}},{id:'nested',kind:'code.symbol',properties:{nested:[{value:privateValue}]}},{id:'key',kind:'code.symbol',properties:{[privateValue]:'value'}},{id:'public',kind:'code.route',label:'Status'}],spans:[{ground,text,digest:guideDigest({ground,text}),sourceLiterals:[privateValue]}],gaps:[],policy:{version:'withhold-config-values@1',withheldValues:0,classifiedSources:[]}};
 const result=guidePacketPolicy(evidence,[privateValue]);
 const inspect=(value:unknown):void=>{if(typeof value==='string')expect(value.includes(privateValue)).toBe(false);else if(Array.isArray(value))value.forEach(inspect);else if(value!==null&&typeof value==='object')for(const [key,child]of Object.entries(value)){inspect(key);inspect(child);}};
 inspect(result.evidence);
 expect(result.sensitiveValues).toContain(privateValue);
 expect(result.evidence.spans).toEqual([]);
 expect(result.evidence.gaps.join(' ')).toContain('1 source spans');
 expect(result.evidence.facts.slice(0,3).every((value)=>Object.hasOwn(value as object,'withheld'))).toBe(true);
 expect(result.evidence.facts[3]).toEqual({id:'public',kind:'code.route',label:'Status'});
});


test('actual extracted environment defaults and definition edges are withheld before bounded context reads',()=>{
 const ordinary='private-runtime-key';const escaped='private"credential';
 const files:Record<string,string>={
  'services/api/config.ts':`export const key = process.env.JWT_SECRET ?? "${ordinary}";\nexport const other = process.env.OTHER_SECRET ?? '${escaped}';\n`,
  'docker-compose.yml':`services:\n  api:\n    build: ./services/api\n    environment:\n      JWT_SECRET: '${escaped}'\n`,
 };
 const encoder=new TextEncoder();
 const extraction=extractOperations({paths:Object.keys(files).sort(),read(path){const text=files[path];if(text===undefined)throw new Error(`missing fixture path ${path}`);return encoder.encode(text);}});
 const variable=extraction.nodes.find((node)=>node.kind==='code.env-var'&&node.properties['default']===ordinary);
 const read=extraction.edges.find((edge)=>edge.type==='code.reads-env'&&edge.properties['default']===ordinary);
 const definition=extraction.nodes.find((node)=>node.kind==='code.env-definition'&&node.properties['value']===escaped);
 const defines=extraction.edges.find((edge)=>edge.type==='code.defines'&&edge.properties['value']===escaped);
 expect(variable).toBeDefined();expect(read).toBeDefined();expect(definition).toBeDefined();expect(defines).toBeDefined();
 const context={valid:'2026-01-01T00:00:00Z',known:'2026-01-02T00:00:00Z',state:'0',repositories:[{name:'sample',commit:'a'.repeat(40)}]};
 const facts=[...extraction.nodes.map((node)=>({id:node.key,kind:node.kind,label:node.label,properties:{...node.properties,...(node.span===undefined?{}:{span:node.span})}})),...extraction.edges.map((edge,index)=>({id:`edge:${index}`,relation:edge.type,properties:{...edge.properties,...(edge.span===undefined?{}:{span:edge.span})}}))];
 const spans=Object.entries(files).map(([path,text])=>{const ground={repository:'sample',commit:'a'.repeat(40),path,line:1,endLine:text.split('\n').length};return {ground,text,digest:guideDigest({ground,text})};});
 const evidence:GuidePreparedEvidence={context,facts,spans,gaps:[],configReferences:[{name:'services.api.environment.JWT_SECRET',path:'docker-compose.yml',value:escaped}],policy:{version:'withhold-config-values@1',withheldValues:0,classifiedSources:[]}};
 const protectedInput=guidePacketPolicy(evidence);
 expect(()=>canonicalJsonDigest(protectedInput.evidence)).not.toThrow();
 expect(protectedInput.sensitiveValues).toContain(ordinary); expect(protectedInput.sensitiveValues).toContain(escaped); // distinctive withheld values also protect output
 expect(protectedInput.evidence.spans).toEqual([]);expect(protectedInput.evidence.gaps.join(' ')).toContain('2 source spans');
 expect(protectedInput.evidence.policy.classifiedSources).toContain(`graph:${variable!.key}`);
 expect(protectedInput.evidence.policy.classifiedSources).toContain(`graph:${definition!.key}`);
 const prepared={prompt:'',validation:{},publishChecked:async()=>({ok:false,diagnostics:[]})} as unknown as GuidePreparedUnit;
 registerGuidePages(prepared,guideDigest(evidence),[...protectedInput.evidence.facts,...protectedInput.evidence.spans,...protectedInput.evidence.gaps]);
 let cursor:string|null=firstGuideCursor(prepared)!;const packets:unknown[]=[];
 while(cursor!==null){const packet:GuideContextPage=readGuidePageContext(prepared,cursor)!;packets.push(...packet.entries);cursor=packet.next;}
 const inspect=(value:unknown):void=>{if(typeof value==='string'){expect(value.includes(ordinary)).toBe(false);expect(value.includes(escaped)).toBe(false);}else if(Array.isArray(value))value.forEach(inspect);else if(value!==null&&typeof value==='object')for(const [key,child]of Object.entries(value)){inspect(key);inspect(child);}};
 inspect(packets);
 // The dependency membership remains complete and private; withholding does not shrink it.
 expect(facts.length).toBe(extraction.nodes.length+extraction.edges.length);
 expect(facts.some((fact)=>Object.values(fact.properties).some((value: unknown)=>typeof value === 'string' && value === escaped))).toBe(true);
 // Each actual edge independently supplies its value, even if a read returns no declaring node.
 for(const edge of [read!,defines!]){
  const edgeOnly=guidePacketPolicy({...evidence,facts:[{id:'actual-edge',relation:edge.type,properties:edge.properties}]});
  const actualValue=edge.properties['default']??edge.properties['value'];
  if(typeof actualValue!=='string')throw new Error('the actual extracted edge must carry its literal value');
  expect(edgeOnly.sensitiveValues).toContain(actualValue);
  expect(edgeOnly.evidence.spans.some((span)=>span.text.includes(actualValue))).toBe(false);
  expect(edgeOnly.evidence.facts[0]).toHaveProperty('withheld');
 }
});


test('real pinned tree-sitter source literals decode escapes before protected context pages',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'guide-literal-policy-'));const owner=createPGliteDatabaseOwner({btreeGist:true});
 try{
  const credential='private"credential';
  const files:Record<string,string>={
   'settings.json':JSON.stringify({SIGNING_KEY:credential}),
   'config.ts':`export const signingKey = ${JSON.stringify(credential)};\n`,
   'unicode.ts':'export const signingKey = "private\\u0022credential";\n',
   'config.go':'package example\nconst signingKey = "private\\\"credential"\n',
   'public.ts':'export const title = "Public readiness";\n',
   'unsupported.py':'signing_key = "private\\\"credential"\n',
  };
  // Write exact source bytes. No command runs while the test is authored.
  for(const [path,text]of Object.entries(files))writeFileSync(join(folder,path),text);
  const env=gitEnv({GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'});
  const git=(...args:string[])=>execFileSync('git',args,{cwd:folder,env,encoding:'utf8'}).trim();
  git('init','--quiet','--initial-branch=main');git('add','.');git('-c','commit.gpgsign=false','commit','--quiet','-m','Record literal policy sources');const commit=git('rev-parse','HEAD');
  const store=createGraphStore(owner);await store.createSchema();const filled=await fillGraph({owner,store,repository:folder,extractors:[extractFiles]});
  const snapshots=createGitSnapshotSource([{id:'sample',form:'code',root:folder,commit}]);
  const wiring={owner,scope:filled.repositoryNode,snapshots,valid:filled.commits[0]!.effectiveTime};const context=await resolveGuideContext(wiring);
  const privateEvidence=await prepareGuideEvidence(wiring,context);const protectedInput=guidePacketPolicy(privateEvidence,[credential]);
  for(const path of ['config.ts','unicode.ts','config.go']){
   expect(privateEvidence.spans.find((span)=>span.ground.path===path)?.sourceLiterals).toContain(credential);
   expect(protectedInput.evidence.spans.some((span)=>span.ground.path===path)).toBe(false);
  }
  expect(protectedInput.evidence.spans.some((span)=>span.ground.path==='public.ts')).toBe(true);
  expect(protectedInput.evidence.spans.some((span)=>span.ground.path==='unsupported.py')).toBe(false);
  expect(protectedInput.evidence.gaps.some((gap)=>gap.includes('source spans'))).toBe(true);
  expect(protectedInput.evidence.spans.every((span)=>span.sourceLiterals===undefined)).toBe(true);
  const prepared={prompt:'',validation:{},publishChecked:async()=>({ok:false,diagnostics:[]})} as unknown as GuidePreparedUnit;
  registerGuidePages(prepared,guideDigest(privateEvidence),[...protectedInput.evidence.facts,...protectedInput.evidence.spans,...protectedInput.evidence.gaps]);
  let cursor:string|null=firstGuideCursor(prepared)!;
  while(cursor!==null){const packet:GuideContextPage=readGuidePageContext(prepared,cursor)!;for(const entry of packet.entries){expect(JSON.stringify(entry)).not.toContain('private');}cursor=packet.next;}
  // A redacted actual graph node must remain canonical JSON through real publication, not just guideDigest.
  await store.registerCodeSchema({kinds:['code.env-var'],relations:[]});
  await store.openNode({kind:'code.env-var',label:'Configured value',properties:{default:credential},validFrom:wiring.valid,owner:{producer:'code.fixture',scope:filled.repositoryNode}});
  seedStarterSet(folder);
  const production=await createGuideWriter({...wiring,store,output:folder,agent:{run:async()=>{throw new Error('gap-only publication needs no semantic agent');}},sensitiveValues:[credential]});
  const unit=await production.prepare('user-guide','en');const header=JSON.parse(unit.prompt) as {context:unknown;inputDigest:string;unitVersion:string};
  let next:string|null=firstGuideCursor(unit)!;
  while(next!==null){const page:GuideContextPage=readGuidePageContext(unit,next)!;next=page.next;}
  const document={schema:GUIDE_SCHEMA,id:'user-guide:main',kind:'user-guide',locale:'en',title:'Source evidence gaps',context:header.context,inputDigest:header.inputDigest,unitVersion:header.unitVersion,prerequisites:[],gaps:['No complete procedure was established.'],procedures:[]};
  const checked=await validateGuide(document,unit.validation);if(!checked.ok)throw new Error(JSON.stringify(checked.diagnostics));
  const published=await unit.publishChecked({guide:checked.guide,artifact:renderGuideArtifact(checked.guide),expectedContext:unit.validation.expectedContext,expectedInputDigest:unit.validation.expectedInputDigest,expectedUnitVersion:unit.validation.expectedUnitVersion});
  expect(published.ok,JSON.stringify(published)).toBe(true);
 }finally{await owner.close();rmSync(folder,{recursive:true,force:true});}
},60_000);


test('ordinary configuration metadata is withheld source input but not secret authority for guide prose',async()=>{
 const context={valid:'2026-01-01T00:00:00Z',known:'2026-01-02T00:00:00Z',state:'0',repositories:[{name:'sample',commit:'a'.repeat(40)}]};
 const evidence:GuidePreparedEvidence={context,facts:[{id:'node',kind:'code.env-var',properties:{default:'0'}}],spans:[],gaps:[],configValues:['number','object','Ready'],policy:{version:'withhold-config-values@1',withheldValues:0,classifiedSources:['sample/package.json']}};
 const result=guidePacketPolicy(evidence);
 expect(result.sensitiveValues).toEqual([]);expect(result.evidence.configValues).toBeUndefined();expect(result.evidence.policy.sourceCandidateValues).toBe(4);expect(result.evidence.policy.hostSensitiveValues).toBe(0);
 expect(result.evidence.facts[0]).toHaveProperty('withheld');
 const raw={schema:GUIDE_SCHEMA,id:'user-guide:main',kind:'user-guide',locale:'en',title:'Read a number object',context,unitVersion:'1',inputDigest:guideDigest(context),prerequisites:[],gaps:[],procedures:[{id:'read',title:'Read a number object',goal:'Read readiness',role:'Reader',prerequisites:[],steps:[{id:'ready',title:'Read readiness',cwd:'.',environment:'isolated',inputs:[],instruction:{kind:'command',content:'status'},expected:{status:0,observation:'Ready'},grounds:[{repository:'sample',commit:'a'.repeat(40),path:'README.md',line:1,endLine:1}]}]}]};
 let verified=0;
 const host={file:'/product/docs/guides/user.md',expectedContext:context,expectedInputDigest:raw.inputDigest,expectedUnitVersion:'1',containsSecret:(text:string)=>containsGuideSecret(text,result.sensitiveValues),verifyStep:async()=>{verified++;return [];}};
 expect((await validateGuide(raw,host)).ok).toBe(true);expect(verified).toBe(1);
 const known=guidePacketPolicy(evidence,['private-runtime-key']);
 const refused=await validateGuide({...raw,title:'private-runtime-key'}, {...host,containsSecret:(text)=>containsGuideSecret(text,known.sensitiveValues)});
 expect(refused.ok).toBe(false);expect(verified).toBe(1);expect(JSON.stringify(refused)).not.toContain('private-runtime-key');
});

test('classified token matching preserves internal punctuation but refuses prefix and suffix partial matches',()=>{
 const candidates=['private"credential','private-runtime-key','private\\credential','key_value'];
 for(const value of candidates){
  expect(containsGuideSecret(value,[value])).toBe(true);
  expect(containsGuideSecret(`'${value}';`,[value])).toBe(true);
  expect(containsGuideSecret(`repos/sample/${value}`,[value])).toBe(true);
  expect(containsGuideSecret(`prefix${value}`,[value])).toBe(false);
  expect(containsGuideSecret(`${value}-suffix`,[value])).toBe(false);
  expect(containsGuideSecret(`repos/sample/${value}-suffix`,[value])).toBe(false);
 }
});
