/** Authority follows environment/secret-store schemas, never arbitrary configuration scalar names. */
import {expect,test} from 'bun:test';
import {configurationReferences} from '../src/writer/guides/writer.js';
import {readComposeFile} from '../src/extract/operations/compose.js';
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
