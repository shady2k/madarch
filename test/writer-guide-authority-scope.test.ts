/** Authority follows environment/secret-store schemas, never arbitrary configuration scalar names. */
import {expect,test} from 'bun:test';
import {configurationReferences} from '../src/writer/guides/writer.js';
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
