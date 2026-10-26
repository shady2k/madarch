/** Authority follows environment/secret-store schemas, never arbitrary configuration scalar names. */
import {expect,test} from 'bun:test';
import {configurationReferences} from '../src/writer/guides/writer.js';
import {readComposeDocument,readComposeFile} from '../src/extract/operations/compose.js';
import {TreeText} from '../src/extract/operations/source.js';
import {Records} from '../src/extract/operations/accumulate.js';
const read = async (_path:string):Promise<string>=>{throw new Error('unpinned file');};
test('ordinary constraints, tsconfig options and compose paths never become authority',async()=>{
 for(const [path,text] of [['schema.yaml','minimum: 0'],['tsconfig.json','{"compilerOptions":{"moduleResolution":"node"}}'],['compose.yaml','services:\n  api:\n    build:\n      context: .\n    ports: ["8000:80"]\n']])expect(await configurationReferences(path!,text!,read)).toEqual([]);
});
test('Compose environment, pinned env_file and dotenv settings use parsed values',async()=>{
 const content='services:\n  api:\n    environment:\n      SIGNING_KEY: private/credential\n    env_file: runtime.settings\n';
 const opened:string[]=[];const refs=await configurationReferences('ops/compose.yaml',content,async(path)=>{opened.push(path);return `QUOTED='private"credential'\nLOCALHOST=localhost\n`;});
 expect(opened).toEqual(['ops/runtime.settings']);expect(refs.map(r=>r.name)).toEqual(['SIGNING_KEY','QUOTED','LOCALHOST']);expect(refs.map(r=>r.value)).toEqual(['private/credential','private"credential','localhost']);
 expect((await configurationReferences('.env.local','COUNT=0\nREADY=Ready\n',read)).map(r=>r.value)).toEqual(['0','Ready']);
 await expect(configurationReferences('compose.yaml',content,read)).rejects.toThrow();
 await expect(configurationReferences('compose.yaml','services:\n  api:\n    env_file: ../outside\n',read)).rejects.toThrow();
});
test('Kubernetes Secret and ConfigMap data are authority, ordinary adjacent fields are not',async()=>{
 const refs=await configurationReferences('store.yaml',`kind: Secret\nmetadata: {name: ordinary-store}\ndata: {TOKEN: cHJpdmF0ZS9jcmVkZW50aWFs}\nstringData: {QUOTED: 'private"credential'}\n`,read);
 expect(refs.map(r=>r.value)).toEqual(['cHJpdmF0ZS9jcmVkZW50aWFs','private/credential','private"credential']);
 const map=await configurationReferences('store.json',JSON.stringify({kind:'ConfigMap',data:{HOST:'localhost',COUNT:'0'},metadata:{name:'ordinary'}}),read);
 expect(map.map(r=>r.name)).toEqual(['HOST','COUNT']);
});

test('malformed secret-store shapes and invalid base64 or UTF-8 refuse rather than expose partial content',async()=>{
 for(const text of ['kind: Secret\ndata: [private/credential]\n','kind: ConfigMap\ndata: {KEY: [private/credential]}\n','kind: Secret\ndata: {KEY: "@@@"}\n','kind: Secret\ndata: {KEY: /w==}\n']) await expect(configurationReferences('store.yaml',text,read)).rejects.toThrow();
});

test('Compose environment aliases retain authority and anchor target source positions',async()=>{
 const source='x-environment: &runtime\n  TOKEN: private/credential\nservices:\n  api:\n    environment: *runtime\n';
 expect(await configurationReferences('compose.yaml',source,read)).toEqual([{name:'TOKEN',path:'compose.yaml',value:'private/credential'}]);
 const tree=new TreeText({paths:['compose.yaml'],read:()=>new TextEncoder().encode(source)});
 const records=new Records(tree);const services=readComposeFile(tree,records,'compose.yaml');
 expect(records.gaps).toEqual([]);expect(services[0]!.environment[0]!.span.lineStart).toBe(2);
 expect(services[0]!.environment[0]!.span.lineEnd).toBe(2);
});
test('Compose environment merges retain every setting and explicit overrides follow YAML precedence',async()=>{
 const source='x-first: &first\n  TOKEN: private/credential\n  SHARED: first-value\nx-second: &second\n  SHARED: second-value\n  SECOND: another-value\nservices:\n  api:\n    environment:\n      <<: [*first, *second]\n      EXTRA: extra-value\n      SECOND: explicit-value\n';
 const refs=await configurationReferences('compose.yaml',source,read);
 expect(refs).toEqual([{name:'EXTRA',path:'compose.yaml',value:'extra-value'},{name:'SECOND',path:'compose.yaml',value:'explicit-value'},{name:'SHARED',path:'compose.yaml',value:'first-value'},{name:'TOKEN',path:'compose.yaml',value:'private/credential'}]);
 const single='x-environment: &runtime {TOKEN: private/credential}\nservices:\n  api:\n    environment: {<<: *runtime, EXTRA: extra-value}\n';
 expect((await configurationReferences('compose.yaml',single,read)).map(ref=>ref.name)).toEqual(['EXTRA','TOKEN']);
});
test('Compose environment scalar aliases resolve their actual values',async()=>{
 const source='x-secret: &secret private/credential\nservices:\n  api:\n    environment:\n      TOKEN: *secret\n';
 expect(await configurationReferences('compose.yaml',source,read)).toEqual([{name:'TOKEN',path:'compose.yaml',value:'private/credential'}]);
});
test('Compose dangling aliases, nonmapping merges and recursive merges refuse the complete file',async()=>{
 for(const environment of ['*missing','{<<: missing-map}','{<<: [null]}','&recursive {<<: *recursive}']){
  const source=`services:\n  first:\n    environment: {PUBLIC: normal-value}\n  second:\n    environment: ${environment}\n`;
  await expect(configurationReferences('compose.yaml',source,read)).rejects.toThrow();
  const tree=new TreeText({paths:['compose.yaml'],read:()=>new TextEncoder().encode(source)});const records=new Records(tree);
  expect(readComposeFile(tree,records,'compose.yaml')).toEqual([]);expect(records.gaps.length).toBeGreaterThan(0);expect(records.gaps[0]!.reason).toContain('line ');
 }
});

test('whole Compose resolution covers service aliases and service merges without losing environment authority',async()=>{
 const anchor='x-service: &runtime\n  environment:\n    TOKEN: private/credential\n  build: &build {context: ./api, dockerfile: Containerfile}\n  ports: &ports ["8100:80"]\n  depends_on: &dependencies [database]\n';
 for(const service of ['*runtime','{<<: *runtime}']){
  const source=anchor+`services:\n  api: ${service}\n`;
  expect(await configurationReferences('compose.yaml',source,read)).toEqual([{name:'TOKEN',path:'compose.yaml',value:'private/credential'}]);
  const tree=new TreeText({paths:['compose.yaml'],read:()=>new TextEncoder().encode(source)});const records=new Records(tree);
  const result=readComposeFile(tree,records,'compose.yaml');
  expect(records.gaps).toEqual([]);expect(result[0]!.environment[0]!.span.lineStart).toBe(3);
  expect(result[0]!.build).toEqual({context:'./api',dockerfile:'Containerfile'});expect(result[0]!.ports).toEqual(['8100:80']);expect(result[0]!.dependsOn).toEqual(['database']);
 }
 const individual=anchor+'services:\n  api:\n    build: *build\n    ports: *ports\n    depends_on: *dependencies\n';
 const tree=new TreeText({paths:['compose.yaml'],read:()=>new TextEncoder().encode(individual)});const records=new Records(tree);
 const service=readComposeFile(tree,records,'compose.yaml')[0]!;
 expect(service.build).toEqual({context:'./api',dockerfile:'Containerfile'});expect(service.ports).toEqual(['8100:80']);expect(service.dependsOn).toEqual(['database']);
});
test('whole Compose resolution refuses dangling service or unrelated aliases, cycles and alias-budget excess',async()=>{
 const budget=['x-base: &a [value]'];let previous='a';for(let index=0;index<8;index++){const name=`layer${index}`;budget.push(`x-${name}: &${name} [*${previous}, *${previous}, *${previous}, *${previous}]`);previous=name;}
 const documents=['services:\n  api: *missing\n','x-unused: *missing\nservices: {api: {}}\n','x-cycle: &cycle {self: *cycle}\nservices: {api: {}}\n',budget.join('\n')+'\nservices: {api: {}}\n'];
 for(const source of documents){
  const tree=new TreeText({paths:['compose.yaml'],read:()=>new TextEncoder().encode(source)});const records=new Records(tree);
  expect(readComposeFile(tree,records,'compose.yaml')).toEqual([]);expect(records.gaps.length).toBeGreaterThan(0);expect(records.gaps[0]!.reason).toContain('line ');
  await expect(configurationReferences('compose.yaml',source,read)).rejects.toThrow();
 }
});

test('the shared resolved Compose probe owns inherited env_file paths for aliases and merge keys',async()=>{
 const anchor='x-files: &files [runtime.env]\nx-service: &runtime\n  environment: {TOKEN: private/credential}\n  env_file: *files\n';
 for(const service of ['*runtime','{<<: *runtime}']){
  const source=anchor+`services:\n  api: ${service}\n`;
  const opened:string[]=[];const refs=await configurationReferences('ops/compose.yaml',source,async(file)=>{opened.push(file);return 'EXTRA=private/extra\n';});
  expect(opened).toEqual(['ops/runtime.env']);expect(refs).toEqual([{name:'TOKEN',path:'ops/compose.yaml',value:'private/credential'},{name:'EXTRA',path:'ops/runtime.env',value:'private/extra'}]);
  const probe=readComposeDocument(source,'ops/compose.yaml');expect(probe.present).toBe(true);
  if(!probe.present)throw new Error('Compose document was not recognized');
  expect(probe.gaps).toEqual([]);expect(probe.services[0]!.envFiles).toEqual(['runtime.env']);
 }
});
test('the shared probe resolves a services alias and refuses a dangling services alias before any authority escapes',async()=>{
 const source='x-services: &services\n  api:\n    environment: {TOKEN: private/credential}\n    env_file: {path: runtime.env}\nservices: *services\n';
 const opened:string[]=[];expect(await configurationReferences('compose.yaml',source,async(file)=>{opened.push(file);return 'EXTRA=private/extra\n';})).toEqual([{name:'TOKEN',path:'compose.yaml',value:'private/credential'},{name:'EXTRA',path:'runtime.env',value:'private/extra'}]);
 expect(opened).toEqual(['runtime.env']);
 const invalid=readComposeDocument('services: *missing\n','compose.yaml');expect(invalid.present).toBe(true);
 if(!invalid.present)throw new Error('invalid Compose document was treated as ordinary YAML');
 expect(invalid.services).toEqual([]);expect(invalid.gaps.length).toBeGreaterThan(0);
 await expect(configurationReferences('compose.yaml','services: *missing\n',read)).rejects.toThrow();
 expect(readComposeDocument('minimum: 0\n','schema.yaml')).toEqual({present:false,reason:'no-services'});
});

test('ordinary multi-document Kubernetes YAML is not Compose authority',async()=>{
 const source='kind: Deployment\nmetadata: {name: api}\n---\nkind: Service\nmetadata: {name: api}\n';
 expect(readComposeDocument(source,'deploy/k8s/api.yaml')).toEqual({present:false,reason:'no-services'});
 expect(await configurationReferences('deploy/k8s/api.yaml',source,read)).toEqual([]);
});
test('the authority probe selects a Compose document while extraction keeps its single-document diagnostic',async()=>{
 for(const source of ['services:\n  api:\n    environment: {TOKEN: private/credential}\n---\nkind: Service\n','kind: Service\n---\nservices:\n  api:\n    environment: {TOKEN: private/credential}\n']){
  const probe=readComposeDocument(source,'compose.yaml');expect(probe.present).toBe(true);
  if(!probe.present)throw new Error('Compose document was not recognized');
  expect(probe.gaps).toEqual([]);expect(probe.services[0]!.environment[0]!.value).toBe('private/credential');
  expect(await configurationReferences('compose.yaml',source,read)).toEqual([{name:'TOKEN',path:'compose.yaml',value:'private/credential'}]);
  const tree=new TreeText({paths:['compose.yaml'],read:()=>new TextEncoder().encode(source)});const records=new Records(tree);
  expect(readComposeFile(tree,records,'compose.yaml')).toEqual([]);expect(records.gaps.some(gap=>gap.reason.includes('Source contains multiple documents'))).toBe(true);
 }
});
test('an explicit nonmapping services key remains recognized and fails closed',async()=>{
 const source='services: ordinary-text\n---\nkind: Service\n';
 const probe=readComposeDocument(source,'compose.yaml');expect(probe.present).toBe(true);
 if(!probe.present)throw new Error('invalid Compose document was not recognized');
 expect(probe.services).toEqual([]);expect(probe.gaps.length).toBeGreaterThan(0);
 await expect(configurationReferences('compose.yaml',source,read)).rejects.toThrow();
});
