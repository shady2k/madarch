import { expect, test } from 'bun:test';
import { guidePacketPolicy, type GuidePreparedEvidence } from '../src/writer/guides/writer.js';
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
 const evidence:GuidePreparedEvidence={context,facts:[{id:'definition',kind:'code.env-definition',properties:{value:privateValue}},{id:'nested',kind:'code.symbol',properties:{nested:[{value:privateValue}]}},{id:'key',kind:'code.symbol',properties:{[privateValue]:'value'}},{id:'public',kind:'code.route',label:'Status'}],spans:[{ground,text,digest:guideDigest({ground,text})}],gaps:[],policy:{version:'withhold-config-values@1',withheldValues:0,classifiedSources:[]}};
 const result=guidePacketPolicy(evidence);
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
 const facts=[...extraction.nodes.map((node)=>({id:node.key,kind:node.kind,properties:node.properties})),...extraction.edges.map((edge,index)=>({id:`edge:${index}`,relation:edge.type,properties:edge.properties}))];
 const spans=Object.entries(files).map(([path,text])=>{const ground={repository:'sample',commit:'a'.repeat(40),path,line:1,endLine:text.split('\n').length};return {ground,text,digest:guideDigest({ground,text})};});
 const evidence:GuidePreparedEvidence={context,facts,spans,gaps:[],policy:{version:'withhold-config-values@1',withheldValues:0,classifiedSources:[]}};
 const protectedInput=guidePacketPolicy(evidence);
 expect(protectedInput.sensitiveValues).toContain(ordinary);expect(protectedInput.sensitiveValues).toContain(escaped);
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
 expect(facts.some((fact)=>Object.values(fact.properties).includes(escaped))).toBe(true);
 // Each actual edge independently supplies its value, even if a read returns no declaring node.
 for(const edge of [read!,defines!]){
  const edgeOnly=guidePacketPolicy({...evidence,facts:[{id:'actual-edge',relation:edge.type,properties:edge.properties}]});
  const actualValue=edge.properties['default']??edge.properties['value'];
  if(typeof actualValue!=='string')throw new Error('the actual extracted edge must carry its literal value');
  expect(edgeOnly.sensitiveValues).toContain(actualValue);
  expect(edgeOnly.evidence.facts[0]).toHaveProperty('withheld');
 }
});
