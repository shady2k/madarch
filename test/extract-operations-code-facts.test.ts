import { expect, test } from 'bun:test';
import { extractCodeWithFacts } from '../src/extract/code/index.js';
import { evaluateLibraryModels } from '../src/extract/library-models/evaluate.js';
import { extractOperations } from '../src/extract/operations/index.js';
import type { TreeReader } from '../src/extract/records.js';

function treeOf(files: Readonly<Record<string, string>>): TreeReader {
  return { paths: Object.keys(files).sort(), read: (path) => {
    const source = files[path];
    if (source === undefined) throw new Error(`missing fixture ${path}`);
    return new TextEncoder().encode(source);
  } };
}

test('metric and logger consumers distinguish exact bindings from unrelated qualified suffixes', async () => {
  const tree = treeOf({
    'package.json': JSON.stringify({ name: 'independent-unit', dependencies: { pino: '9.0.0', 'prom-client': '15.0.0' } }),
    'lib/entry.ts': [
      'import makeLogger from "pino";',
      'import { Counter as Count } from "prom-client";',
      'const logger = makeLogger();',
      'const requests = new Count({ name: "completed_total", help: "completed", labelNames: ["kind"] });',
      'export function correct(){ logger.info("yes"); requests.inc(); }',
      'export function unrelated(other: any){ other.logger.info("no"); other.requests.inc(); }',
      'export function shadow(logger: any, requests: any){ logger.info("no"); requests.inc(); }',
    ].join('\n'),
  });
  const code = await extractCodeWithFacts(tree);
  const result = extractOperations(tree, code.extraction, code.facts);
  const metric = result.nodes.find((node) => node.kind === 'code.metric');
  const logger = result.nodes.find((node) => node.kind === 'code.logger');
  expect(metric?.label).toBe('completed_total');
  expect(metric?.properties.labels).toEqual(['kind']);
  expect(logger).toBeDefined();
  const updates = result.edges.filter((edge) => edge.type === 'code.updates-metric');
  expect(updates.map((edge) => edge.from)).toEqual(['code.symbol:lib/entry.ts#correct']);
  const uses = result.edges.filter((edge) => edge.type === 'code.uses-logger' && edge.to.startsWith('code.symbol:'));
  expect(uses.map((edge) => edge.to)).toEqual(['code.symbol:lib/entry.ts#correct']);
  const bytes = tree.read('lib/entry.ts');
  for (const edge of [...updates, ...uses]) {
    expect(edge.span).toBeDefined();
    const source = new TextDecoder().decode(bytes.subarray(edge.span!.byteStart, edge.span!.byteEnd));
    expect(source.startsWith('other.')).toBe(false);
    expect(edge.properties.model).toBeDefined();
    expect(edge.properties.origin).toBeDefined();
  }
});

test('unrelated package constructors never acquire metric or logger effects', async () => {
  const tree = treeOf({
    'package.json': '{"name":"fixture","dependencies":{"other-library":"1.0.0"}}',
    'src/main.ts': 'import makeLogger, {Counter} from "other-library"; const logger=makeLogger(); const count=new Counter({name:"not_metric"}); export function run(){logger.info("x");count.inc();}',
  });
  const code = await extractCodeWithFacts(tree);
  const result = extractOperations(tree, code.extraction, code.facts);
  expect(result.nodes.filter((node) => node.kind === 'code.metric' || node.kind === 'code.logger')).toEqual([]);
  expect(result.edges.filter((edge) => edge.type === 'code.updates-metric' || edge.type === 'code.uses-logger')).toEqual([]);
});

test('operations never falls back to source patterns when the shared fact view is absent', () => {
  const result = extractOperations(treeOf({
    'package.json': '{"name":"fixture","dependencies":{"pino":"9.0.0","prom-client":"15.0.0"}}',
    'src/main.ts': 'import pino from "pino"; const logger=pino(); logger.info("x");',
  }));
  expect(result.nodes.some((node) => node.kind === 'code.logger')).toBe(false);
  expect(result.gaps.some((gap) => gap.reason.includes('shared resolved code facts'))).toBe(true);
});

test('unknown-origin diagnostics survive once and anonymous logger factories keep distinct source identities', async () => {
  const tree = treeOf({
    'package.json': '{"name":"fixture","dependencies":{"pino":"9.0.0"}}',
    'src/main.ts': 'import makeLogger from "pino"; export function build(){ consume(makeLogger(), makeLogger()); unknown.info("unresolved"); }',
  });
  const code = await extractCodeWithFacts(tree);
  const result = extractOperations(tree, code.extraction, code.facts);
  const loggers = result.nodes.filter((node) => node.kind === 'code.logger');
  expect(loggers).toHaveLength(2);
  expect(new Set(loggers.map((node) => node.key)).size).toBe(2);
  expect(loggers.every((node) => typeof node.properties.origin === 'object')).toBe(true);
  const gaps = result.gaps.filter((gap) => gap.reason.includes('unknown-origin'));
  expect(gaps.length).toBeGreaterThan(0);
  expect(new Set(gaps.map((gap) => `${gap.path}:${gap.reason}`)).size).toBe(gaps.length);
});


test('cross-file exports retain metric/logger identity through aliases and explicit re-exports', async () => {
  const tree = treeOf({
    'package.json': '{"name":"fixture","dependencies":{"pino":"9.0.0","prom-client":"15.0.0"}}',
    'lib/decl.ts': 'import pino from "pino"; import {Counter} from "prom-client"; export const logger=pino(); export const count=new Counter({name:"cross_total",help:"x"});',
    'lib/bridge.ts': 'export {logger as audit,count as completed} from "./decl.js";',
    'lib/use.ts': 'import {audit as log,completed as metric} from "./bridge.js"; export function run(){log.info("real");metric.inc();} export function shadow(log:any,metric:any){log.info("fake");metric.inc();}',
  });
  const code = await extractCodeWithFacts(tree);
  const result = extractOperations(tree, code.extraction, code.facts);
  expect(result.edges.filter((edge) => edge.type === 'code.updates-metric').map((edge) => [edge.from, edge.to])).toEqual([['code.symbol:lib/use.ts#run', 'code.metric:lib/decl.ts#cross_total']]);
  const uses = result.edges.filter((edge) => edge.type === 'code.uses-logger' && edge.to.startsWith('code.symbol:'));
  expect(uses.map((edge) => edge.to)).toEqual(['code.symbol:lib/use.ts#run']);
  expect(uses[0]?.properties.origin).toMatchObject({ importSpan: {path:'lib/decl.ts'} });
  const origin = uses[0]?.properties.origin as {chain?: readonly string[]} | undefined;
  expect(origin?.chain?.some((id) => id.includes('lib/bridge.ts'))).toBe(true);
  expect(origin?.chain?.some((id) => id.includes('lib/use.ts'))).toBe(true);
});

test('named default-value export and renamed imported factory preserve anonymous source identity', async () => {
  const tree = treeOf({
    'package.json': '{"name":"fixture","dependencies":{"pino":"9.0.0"}}',
    'lib/default.ts': 'import makeLogger from "pino"; export default makeLogger();',
    'lib/use.ts': 'import renamed from "./default.js"; export function run(){renamed.info("real");}',
  });
  const code = await extractCodeWithFacts(tree);
  const result = extractOperations(tree, code.extraction, code.facts);
  expect(result.nodes.filter((node) => node.kind === 'code.logger')).toHaveLength(1);
  expect(result.edges.filter((edge) => edge.type === 'code.uses-logger' && edge.to.startsWith('code.symbol:')).map((edge) => edge.to)).toEqual(['code.symbol:lib/use.ts#run']);
});

test('mutated exports, type-only values, cycles and wildcard exports never invent cross-file roles', async () => {
  const tree = treeOf({
    'package.json': '{"name":"fixture","dependencies":{"pino":"9.0.0","prom-client":"15.0.0"}}',
    'lib/decl.ts': 'import pino from "pino"; export let mutable=pino(); mutable=unknownLogger; export const actual=pino();',
    'lib/types.ts': 'export type {actual as Typed} from "./decl.js"; export {type actual as AlsoTyped} from "./decl.js";',
    'lib/cycle-a.ts': 'export {circular} from "./cycle-b.js";',
    'lib/cycle-b.ts': 'export {circular} from "./cycle-a.js";',
    'lib/star.ts': 'export * from "./decl.js";',
    'lib/use.ts': 'import {mutable} from "./decl.js"; import type {actual} from "./decl.js"; import {type actual as alternate} from "./decl.js"; import {Typed,AlsoTyped} from "./types.js"; import {circular} from "./cycle-a.js"; import {actual as wildcard} from "./star.js"; import type makeLogger from "pino"; import {type Counter} from "prom-client"; const no=makeLogger(); const notMetric=new Counter({name:"bad_total"}); export function run(){mutable.info("no");actual.info("no");alternate.info("no");Typed.info("no");AlsoTyped.info("no");circular.info("no");wildcard.info("no");}',
  });
  const code = await extractCodeWithFacts(tree);
  const result = extractOperations(tree, code.extraction, code.facts);
  expect(result.edges.filter((edge) => edge.type === 'code.uses-logger')).toEqual([]);
  expect(result.nodes.filter((node) => node.kind === 'code.logger' && node.span?.path === 'lib/use.ts')).toEqual([]);
  expect(result.nodes.filter((node) => node.kind === 'code.metric')).toEqual([]);
  expect(code.facts.imports.filter((entry) => entry.typeOnly)).toHaveLength(4);
  expect(code.facts.gaps.some((gap) => gap.reason.includes('no unique exported value'))).toBe(true);
  expect(code.facts.gaps.some((gap) => gap.reason.includes('wildcard/namespace re-export'))).toBe(true);
});

test('metric definitions retain full declaration bytes without export prefix or trailing separator', async () => {
  for (const [path,source,expected] of [
    ['lib/metric.ts','import {Counter} from "prom-client";\nexport const requests = new Counter({name:"requests_total",help:"x"});','const requests = new Counter({name:"requests_total",help:"x"})'],
    ['lib/metric.go','package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\nvar requests = prom.NewCounter(prom.CounterOpts{Name:"requests_total"})','var requests = prom.NewCounter(prom.CounterOpts{Name:"requests_total"})'],
  ] as const) {
    const tree = treeOf({[path]: source});
    const code = await extractCodeWithFacts(tree);
    const result = extractOperations(tree, code.extraction, code.facts);
    const metric = result.nodes.find((node) => node.kind === 'code.metric');
    expect(metric?.span).toBeDefined();
    expect(new TextDecoder().decode(tree.read(path).subarray(metric!.span!.byteStart, metric!.span!.byteEnd))).toBe(expected);
    expect(metric?.properties.origin).toMatchObject({importSpan:{path}});
  }
});


test('forged cross-file proof IDs, duplicate exports, wrong targets and type-only imports are rejected', async () => {
  const tree = treeOf({
    'package.json': '{"name":"fixture","dependencies":{"pino":"9.0.0"}}',
    'lib/decl.ts': 'import pino from "pino";export const logger=pino();',
    'lib/use.ts': 'import {logger} from "./decl.js";export function run(){logger.info("real");}',
  });
  const {facts} = await extractCodeWithFacts(tree);
  const imported = facts.imports.find((entry) => entry.targetExpression !== undefined)!;
  const terminal = facts.exports?.find((entry) => entry.path === 'lib/decl.ts' && entry.name === 'logger')!;
  expect(imported).toBeDefined(); expect(terminal).toBeDefined();
  expect(evaluateLibraryModels(facts).effects.filter((effect) => effect.kind === 'logger-use')).toHaveLength(1);
  const altered = [
    {...facts, imports: facts.imports.map((entry) => entry.id === imported.id ? {...entry, targetChain:[...(entry.targetChain ?? []),'forged-unknown-id']} : entry)},
    {...facts, imports: facts.imports.map((entry) => entry.id === imported.id ? {...entry, targetChain:[...(entry.targetChain ?? []),...(entry.targetChain ?? [])]} : entry)},
    {...facts, exports: [...(facts.exports ?? []),terminal]},
    {...facts, exports: [...(facts.exports ?? []),{...terminal,id:'forged-second-export-same-name'}]},
    {...facts, exports: (facts.exports ?? []).map((entry) => entry.id === terminal.id ? {...entry,typeOnly:true} : entry)},
    {...facts, imports: facts.imports.map((entry) => entry.id === imported.id ? {...entry,targetPath:'lib/not-the-export.ts'} : entry)},
    {...facts, imports: facts.imports.map((entry) => entry.id === imported.id ? {...entry,typeOnly:true} : entry)},
    {...facts, exports: (facts.exports ?? []).map((entry) => entry.id === terminal.id ? {...entry,localBinding:'forged-binding'} : entry)},
  ];
  for (const variant of altered) {
    const result = evaluateLibraryModels(variant);
    expect(result.effects.filter((effect) => effect.kind === 'logger-use')).toEqual([]);
    expect(result.diagnostics.some((entry) => entry.code === 'dangling-fact' || entry.code === 'ambiguous-fact' || entry.code === 'unknown-origin')).toBe(true);
  }
});


test('mutation through an imported live binding poisons export aliases conservatively', async () => {
  const tree = treeOf({
    'package.json': '{"name":"fixture","dependencies":{"pino":"9.0.0"}}',
    'lib/decl.ts': 'import pino from "pino";export const logger=pino();',
    'lib/change.ts': 'import {logger as imported} from "./decl.js"; imported.info=replacement;',
    'lib/use.ts': 'import {logger} from "./decl.js";export function run(){logger.info("unknown after mutation");}',
  });
  const code = await extractCodeWithFacts(tree);
  const result = extractOperations(tree, code.extraction, code.facts);
  expect(result.edges.filter((edge) => edge.type === 'code.uses-logger')).toEqual([]);
  expect(result.gaps.some((gap) => gap.reason.includes('reassigned'))).toBe(true);
});


test('real Go composite options select the exact declared metric name through grammar wrappers',async()=>{
  const path='lib/metric.go';const source='package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\nvar requests=prom.NewCounter(prom.CounterOpts{Name:"requests_total"})\nfunc run(){requests.Inc()}';
  const tree=treeOf({[path]:source});const code=await extractCodeWithFacts(tree);const evaluated=evaluateLibraryModels(code.facts);
  const name=code.facts.expressions.find((entry)=>entry.literal?.value==='requests_total')!;expect(name).toBeDefined();
  const pair=code.facts.expressions.find((entry)=>entry.syntaxKind==='keyed_element');
  expect(pair?.fields).toEqual({});
  expect(pair?.children.map((id)=>code.facts.expressions.find((entry)=>entry.id===id)?.syntaxKind)).toEqual(['literal_element','literal_element']);
  const declaration=evaluated.effects.find((effect)=>effect.kind==='metric-declare');
  if(declaration===undefined)throw new Error(JSON.stringify({path,facts:code.facts,diagnostics:evaluated.diagnostics}));
  const selected=declaration.arguments.find((argument)=>argument.name==='name');expect(selected?.expression).toBeDefined();
  const operations=extractOperations(tree,code.extraction,code.facts);
  expect(operations.nodes.filter((node)=>node.kind==='code.metric').map((node)=>node.label)).toEqual(['requests_total']);
  expect(operations.edges.filter((edge)=>edge.type==='code.updates-metric').map((edge)=>edge.from)).toEqual(['code.symbol:lib/metric.go#run']);
});


test('Go struct selectors require syntax or exact declarative imported type proof', async () => {
  const path = 'lib/metric.go';
  const prefix = 'package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\n';
  for (const options of ['struct { Name string }{Name:"neutral_total"}', 'prom.CounterOpts{Name:"neutral_total"}',
    'prom.CounterOpts{Help:"neutral", /* value position is structural */ Name:"neutral_total"}']) {
    const source = prefix + 'var requests = prom.NewCounter(' + options + ')\nfunc run(){requests.Inc()}';
    const tree = treeOf({[path]:source}); const code = await extractCodeWithFacts(tree);
    const result = extractOperations(tree,code.extraction,code.facts);
    expect(result.nodes.filter((entry)=>entry.kind==='code.metric').map((entry)=>entry.label)).toEqual(['neutral_total']);
    expect(result.edges.filter((entry)=>entry.type==='code.updates-metric').map((entry)=>entry.from)).toEqual(['code.symbol:lib/metric.go#run']);
  }
  for (const [declarations,options] of [
    ['type Labels map[string]string\nconst Name="different"\n','Labels{Name:"neutral_total"}'],
    ['type Original struct { Name string }\ntype Alias = Original\n','Alias{Name:"neutral_total"}'],
    ['type Original map[string]string\ntype Alias = Original\nconst Name="different"\n','Alias{Name:"neutral_total"}'],
    ['', 'prom.UnknownOptions{Name:"neutral_total"}'],
    ['', 'prom.CounterOpts{Name:"one",Name:"two"}'],
    ['const Name="different"\n', 'map[string]string{Name:"neutral_total"}'],
  ]) {
    const tree=treeOf({[path]:prefix+declarations+'var requests=prom.NewCounter('+options+')\nfunc run(){requests.Inc()}'});
    const code=await extractCodeWithFacts(tree);const result=extractOperations(tree,code.extraction,code.facts);
    expect(result.nodes.filter((entry)=>entry.kind==='code.metric')).toEqual([]);
    expect(result.edges.filter((entry)=>entry.type==='code.updates-metric')).toEqual([]);
    expect(result.gaps.some((entry)=>entry.path===path&&entry.reason.includes('selector'))).toBe(true);
  }
});

test('Go local named struct without its copied declaration proof remains an explicit gap', async () => {
  const path='lib/metric.go';
  const tree=treeOf({[path]:'package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\ntype Local struct{Name string}\nvar requests=prom.NewCounter(Local{Name:"local_total"})'});
  const code=await extractCodeWithFacts(tree);
  const missingProof={...code.facts,expressions:code.facts.expressions.map((entry)=>entry.compositeType?.bindingId===undefined?entry:{...entry,compositeType:undefined})};
  const result=extractOperations(tree,code.extraction,missingProof);
  expect(result.nodes.filter((entry)=>entry.kind==='code.metric')).toEqual([]);
  expect(result.gaps.some((entry)=>entry.path===path&&entry.reason.includes('struct-shape proof'))).toBe(true);
});

// This independent positive can pass only through the copied lexical declaration
// identity. Program's first-wins type table is never proof for this assertion.
test('Go local named struct has a declaration identity and can select its field', async () => {
  const path='lib/metric.go';
  const tree=treeOf({[path]:'package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\ntype Local struct{Name string}\nvar requests=prom.NewCounter(Local{Name:"local_total"})'});
  const code=await extractCodeWithFacts(tree);const result=extractOperations(tree,code.extraction,code.facts);
  expect(result.nodes.filter((entry)=>entry.kind==='code.metric').map((entry)=>entry.label)).toEqual(['local_total']);
});


test('Go grammar pair and type proofs reject malformed copied facts without changing raw syntax', async () => {
  const path='lib/metric.go';
  const tree=treeOf({[path]:'package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\nvar requests=prom.NewCounter(prom.CounterOpts{Name:"neutral_total"})\nfunc run(){requests.Inc()}'});
  const {facts}=await extractCodeWithFacts(tree);
  const pair=facts.expressions.find((entry)=>entry.syntaxKind==='keyed_element');
  const type=facts.expressions.find((entry)=>entry.syntaxKind==='qualified_type');
  if(pair===undefined||type===undefined)throw new Error('real Go fixture lacks pair or qualified type');
  const key=pair.children[0];const value=pair.children[1];
  if(key===undefined||value===undefined)throw new Error('real Go pair lacks exact two children');
  expect(pair.fields).toEqual({});
  const good=evaluateLibraryModels(facts);
  expect(good.effects.filter((entry)=>entry.kind==='metric-declare')).toHaveLength(1);
  const change=(id:string,patch:Partial<typeof pair>)=>({...facts,expressions:facts.expressions.map((entry)=>entry.id===id?{...entry,...patch}:entry)});
  const keyFact=facts.expressions.find((entry)=>entry.id===key);
  if(keyFact===undefined)throw new Error('real Go fixture lacks key wrapper');
  const coherent=change(pair.id,{fields:{key:[key],value:[value]}});
  expect(evaluateLibraryModels(coherent).effects.filter((entry)=>entry.kind==='metric-declare')).toHaveLength(1);
  const imported=facts.imports[0];
  if(imported===undefined)throw new Error('real Go fixture lacks import');
  const variants=[
    change(pair.id,{children:[key]}),change(pair.id,{children:[key,key]}),change(pair.id,{children:[value,key]}),
    change(pair.id,{fields:{key:[key]}}),change(pair.id,{fields:{key:[key,key],value:[value]}}),
    change(pair.id,{fields:{key:[value],value:[key]}}),change(key,{children:[]}),change(key,{children:[key]}),
    change(key,{span:{...keyFact.span,path:'other.go'}}),change(key,{span:{...keyFact.span,byteEnd:pair.span.byteEnd+1}}),
    {...facts,expressions:facts.expressions.filter((entry)=>entry.id!==key)},
    {...facts,expressions:[...facts.expressions,keyFact]},
    {...facts,imports:[...facts.imports,{...imported,id:'duplicate-import-proof'}]},
    {...facts,imports:facts.imports.map((entry)=>({...entry,targetPath:'internal/types.go'}))},
    {...facts,imports:facts.imports.map((entry)=>({...entry,typeOnly:true}))},
    change(type.id,{member:'CounterOpts',fields:{...type.fields,name:[]}}),
  ];
  for(const variant of variants){
    const result=evaluateLibraryModels(variant);
    expect(result.effects.filter((entry)=>entry.kind==='metric-declare'||entry.kind==='metric-update')).toEqual([]);
    expect(result.diagnostics.some((entry)=>entry.path===path&&entry.span.path===path)).toBe(true);
  }
});

for(const [type,constructor] of [['CounterOpts','NewCounter'],['GaugeOpts','NewGauge'],['HistogramOpts','NewHistogram']] as const){
  test(`prometheus.${type}.struct.positive`,async()=>{
    const path='lib/metric.go';const tree=treeOf({[path]:`package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\nvar metric=prom.${constructor}(prom.${type}{Name:"neutral_total"})`});
    const code=await extractCodeWithFacts(tree);const result=extractOperations(tree,code.extraction,code.facts);
    expect(result.nodes.filter((entry)=>entry.kind==='code.metric').map((entry)=>entry.label)).toEqual(['neutral_total']);
  });
  test(`prometheus.${type}.struct.negative`,async()=>{
    const path='lib/metric.go';const tree=treeOf({[path]:`package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\nvar metric=prom.${constructor}(prom.UnknownOpts{Name:"neutral_total"})`});
    const code=await extractCodeWithFacts(tree);const result=extractOperations(tree,code.extraction,code.facts);
    expect(result.nodes.filter((entry)=>entry.kind==='code.metric')).toEqual([]);
    expect(result.gaps.some((entry)=>entry.path===path&&entry.reason.includes('struct-shape proof'))).toBe(true);
  });
}

test('Go local type scopes, duplicate types and import type shadows never borrow external shape proof',async()=>{
  const path='lib/metric.go';const prefix='package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\n';
  for(const body of [
    'type Local struct{Name string}\nfunc run(){type Local map[string]string;const Name="different";requests:=prom.NewCounter(Local{Name:"bad_total"});requests.Inc()}',
    'type Local struct{Name string}\ntype Local map[string]string\nvar metric=prom.NewCounter(Local{Name:"bad_total"})',
    'func run(){type prom struct{};requests:=prom.NewCounter(prom.CounterOpts{Name:"bad_total"});requests.Inc()}',
    'func run(prom any){requests:=prom.NewCounter(prom.CounterOpts{Name:"bad_total"});requests.Inc()}',
  ]){
    const tree=treeOf({[path]:prefix+body});const code=await extractCodeWithFacts(tree);const result=extractOperations(tree,code.extraction,code.facts);
    expect(result.nodes.filter((entry)=>entry.kind==='code.metric')).toEqual([]);
    expect(result.edges.filter((entry)=>entry.type==='code.updates-metric')).toEqual([]);
    expect(result.gaps.some((entry)=>entry.path===path)).toBe(true);
  }
});


test('Go copied anonymous struct proof cannot disagree with raw syntax identity',async()=>{
  const path='lib/metric.go';const tree=treeOf({[path]:'package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\nvar metric=prom.NewCounter(struct{Name string}{Name:"neutral_total"})'});
  const {facts}=await extractCodeWithFacts(tree);const composite=facts.expressions.find((entry)=>entry.compositeType!==undefined);
  if(composite?.compositeType===undefined)throw new Error('real parser fixture lacks anonymous struct proof');
  expect(evaluateLibraryModels(facts).effects.filter((entry)=>entry.kind==='metric-declare')).toHaveLength(1);
  for(const patch of [
    {compositeType:undefined},
    {compositeType:{...composite.compositeType,typeExpression:'missing-type-id'}},
    {compositeType:{...composite.compositeType,declarationSpan:{...composite.compositeType.declarationSpan,path:'other.go'}}},
    {compositeType:{...composite.compositeType,declarationSpan:{...composite.compositeType.declarationSpan,byteEnd:composite.span.byteEnd}}},
  ]){
    const result=evaluateLibraryModels({...facts,expressions:facts.expressions.map((entry)=>entry.id===composite.id?{...entry,...patch}:entry)});
    expect(result.effects.filter((entry)=>entry.kind==='metric-declare')).toEqual([]);
    expect(result.diagnostics.some((entry)=>entry.path===path&&entry.reason.includes('struct-shape proof'))).toBe(true);
  }
});

test('Go external struct type identity rejects origin aliases and conflicting import bindings',async()=>{
  const path='lib/metric.go';const tree=treeOf({[path]:'package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\nvar metric=prom.NewCounter(prom.CounterOpts{Name:"neutral_total"})'});
  const {facts}=await extractCodeWithFacts(tree);const imported=facts.imports[0];
  const binding=facts.bindings.find((entry)=>entry.kind==='import');const type=facts.expressions.find((entry)=>entry.syntaxKind==='qualified_type');
  if(imported===undefined||binding===undefined||type===undefined)throw new Error('real parser type import fixture incomplete');
  const variants=[
    {...facts,bindings:[...facts.bindings,{...binding,id:'duplicate-binding'}]},
    {...facts,imports:facts.imports.map((entry)=>({...entry,targetExpression:'internal-expression'}))},
    {...facts,imports:facts.imports.map((entry)=>({...entry,targetChain:[]}))},
    {...facts,imports:facts.imports.map((entry)=>({...entry,span:{...entry.span,byteStart:entry.span.byteStart+1}}))},
    {...facts,imports:facts.imports.map((entry)=>({...entry,package:{ecosystem:'go' as const,name:'example.test/not-the-import',manifestPath:'go.mod',declaredVersion:'v1'}}))},
    {...facts,expressions:facts.expressions.map((entry)=>entry.id===type.id?{...entry,member:'UnknownOpts'}:entry)},
  ];
  for(const variant of variants){
    const result=evaluateLibraryModels(variant);expect(result.effects.filter((entry)=>entry.kind==='metric-declare')).toEqual([]);
    expect(result.diagnostics.some((entry)=>entry.path===path)).toBe(true);
  }
});


test('Go struct option order and string-list labels stay on the actual declaration',async()=>{
  const path='lib/metric.go';const source='package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\nvar metric=prom.NewCounterVec(prom.CounterOpts{Help:"neutral",Namespace:"worker",Name:"requests_total"},[]string{"region","zone"})';
  const tree=treeOf({[path]:source});const code=await extractCodeWithFacts(tree);const result=extractOperations(tree,code.extraction,code.facts);
  const metric=result.nodes.find((entry)=>entry.kind==='code.metric');
  expect(metric?.label).toBe('worker_requests_total');expect(metric?.properties.labels).toEqual(['region','zone']);
  expect(metric?.span).toBeDefined();
  if(metric?.span===undefined)throw new Error('metric declaration lacks span');
  expect(new TextDecoder().decode(tree.read(path).subarray(metric.span.byteStart,metric.span.byteEnd))).toBe(source.slice(source.indexOf('var metric')));
});


test('external type schema shape is exact and cannot be borrowed from another package or exported path',async()=>{
  const path='lib/metric.go';const tree=treeOf({[path]:'package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\nvar metric=prom.NewCounter(prom.CounterOpts{Name:"neutral_total"})'});
  const {facts}=await extractCodeWithFacts(tree);
  const {libraryRegistry}=await import('../src/extract/library-models/validate.js');
  const types=libraryRegistry.types??[];
  for(const registry of [
    {...libraryRegistry,types:[]},
    {...libraryRegistry,types:types.map((entry)=>({...entry,package:'example.test/not-the-import'}))},
    {...libraryRegistry,types:types.map((entry)=>({...entry,exportedPath:[...entry.exportedPath,'UnknownOpts']}))},
  ]){
    const result=evaluateLibraryModels(facts,registry);
    expect(result.effects.filter((entry)=>entry.kind==='metric-declare')).toEqual([]);
    expect(result.diagnostics.some((entry)=>entry.path===path&&entry.reason.includes('struct-shape proof'))).toBe(true);
  }
});


test('Go block type scope starts at its identifier and restores the outer type on exit',async()=>{
  const path='lib/metric.go';const source='package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\n'+
    'type Options struct{Name string}\nfunc run(){\n'+
    'prom.NewCounter(Options{Name:"outer_before"})\n'+
    '{prom.NewCounter(Options{Name:"inner_before"});type Options map[string]string;const Name="different";prom.NewCounter(Options{Name:"must_not_exist"})}\n'+
    'prom.NewCounter(Options{Name:"outer_after"})\n}';
  const tree=treeOf({[path]:source});const code=await extractCodeWithFacts(tree);const result=extractOperations(tree,code.extraction,code.facts);
  expect(result.nodes.filter((entry)=>entry.kind==='code.metric').map((entry)=>entry.label)).toEqual(['inner_before','outer_after','outer_before']);
  const typeBindings=code.facts.bindings.filter((entry)=>entry.kind==='type'&&entry.name==='Options');
  expect(typeBindings).toHaveLength(2);
  const nested=typeBindings.find((entry)=>entry.typeDeclaration?.shape==='unknown');
  expect(nested?.typeDeclaration?.scopeStart).toBe(nested?.span.byteStart);
  expect(result.gaps.some((entry)=>entry.path===path&&entry.reason.includes('struct-shape proof'))).toBe(true);
});

test('Go file type can be used before its declaration but nested duplicate types do not poison outer scopes',async()=>{
  const path='lib/metric.go';const source='package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\n'+
    'var before=prom.NewCounter(Options{Name:"before_declaration"})\ntype Options struct{Name string}\n'+
    'func run(){ {type Options struct{Name string};type Options map[string]string;prom.NewCounter(Options{Name:"duplicate_bad"})};prom.NewCounter(Options{Name:"after_block"}) }';
  const tree=treeOf({[path]:source});const code=await extractCodeWithFacts(tree);const result=extractOperations(tree,code.extraction,code.facts);
  expect(result.nodes.filter((entry)=>entry.kind==='code.metric').map((entry)=>entry.label)).toEqual(['after_block','before_declaration']);
  expect(result.gaps.some((entry)=>entry.path===path&&entry.reason.includes('ambiguous same-scope Go declaration'))).toBe(true);
});

test('Go declared type proof fails closed on binding, declaration, shape and scope disagreement',async()=>{
  const path='lib/metric.go';const tree=treeOf({[path]:'package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\ntype Options struct{Name string}\nvar metric=prom.NewCounter(Options{Name:"neutral_total"})'});
  const {facts}=await extractCodeWithFacts(tree);const binding=facts.bindings.find((entry)=>entry.kind==='type');
  const composite=facts.expressions.find((entry)=>entry.compositeType?.bindingId!==undefined);
  if(binding?.typeDeclaration===undefined||composite?.compositeType===undefined)throw new Error('real parser lacks local type binding proof');
  expect(evaluateLibraryModels(facts).effects.filter((entry)=>entry.kind==='metric-declare')).toHaveLength(1);
  const alterBinding=(patch:Partial<typeof binding>)=>({...facts,bindings:facts.bindings.map((entry)=>entry.id===binding.id?{...entry,...patch}:entry)});
  const variants=[
    {...facts,bindings:facts.bindings.filter((entry)=>entry.id!==binding.id)},
    {...facts,bindings:[...facts.bindings,binding]},
    {...facts,bindings:[...facts.bindings,{...binding,id:'same-scope-duplicate'}]},
    alterBinding({kind:'local'}),alterBinding({path:'other.go'}),
    alterBinding({scope:{...binding.scope,byteStart:composite.span.byteEnd}}),
    alterBinding({typeDeclaration:{...binding.typeDeclaration,shape:'unknown'}}),
    alterBinding({typeDeclaration:{...binding.typeDeclaration,expression:'missing-declaration'}}),
    alterBinding({typeDeclaration:{...binding.typeDeclaration,typeExpression:'missing-struct'}}),
    alterBinding({typeDeclaration:{...binding.typeDeclaration,scopeStart:composite.span.byteEnd}}),
    {...facts,expressions:facts.expressions.map((entry)=>entry.id===composite.id?{...entry,compositeType:{...composite.compositeType!,declarationExpression:'forged-declaration'}}:entry)},
  ];
  for(const variant of variants){const result=evaluateLibraryModels(variant);
    expect(result.effects.filter((entry)=>entry.kind==='metric-declare')).toEqual([]);
    expect(result.diagnostics.some((entry)=>entry.path===path)).toBe(true);
  }
});


test('Go nested block type may shadow a parameter but outer function-body redeclaration is ambiguous',async()=>{
  const path='lib/metric.go';const prefix='package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\n';
  const tree=treeOf({[path]:prefix+'func run(Options any){ {type Options struct{Name string};prom.NewCounter(Options{Name:"nested_total"})};prom.NewCounter(Options{Name:"outside_unknown"}) }'});
  const code=await extractCodeWithFacts(tree);const result=extractOperations(tree,code.extraction,code.facts);
  expect(result.nodes.filter((entry)=>entry.kind==='code.metric').map((entry)=>entry.label)).toEqual(['nested_total']);
  expect(result.gaps.some((entry)=>entry.path===path&&entry.reason.includes('struct-shape proof'))).toBe(true);
  const badTree=treeOf({[path]:prefix+'func run(Options any){type Options struct{Name string};prom.NewCounter(Options{Name:"bad_total"})}'});
  const badCode=await extractCodeWithFacts(badTree);const bad=extractOperations(badTree,badCode.extraction,badCode.facts);
  expect(bad.nodes.filter((entry)=>entry.kind==='code.metric')).toEqual([]);
  expect(bad.gaps.some((entry)=>entry.path===path&&entry.reason.includes('ambiguous same-scope'))).toBe(true);
});

test('Go copied type scope cannot be widened, moved before its declaration, or used through a forged spelling',async()=>{
  const path='lib/metric.go';const tree=treeOf({[path]:'package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\nfunc run(){type Options struct{Name string};prom.NewCounter(Options{Name:"neutral_total"})}'});
  const {facts}=await extractCodeWithFacts(tree);const binding=facts.bindings.find((entry)=>entry.kind==='type');
  const composite=facts.expressions.find((entry)=>entry.compositeType?.bindingId!==undefined);
  const type=composite===undefined?undefined:facts.expressions.find((entry)=>entry.id===composite.compositeType?.typeExpression);
  if(binding?.typeDeclaration===undefined||composite?.compositeType===undefined||type===undefined)throw new Error('real local type scope fixture lacks proof');
  const variants=[
    {...facts,bindings:facts.bindings.map((entry)=>entry.id===binding.id?{...entry,typeDeclaration:{...binding.typeDeclaration!,scopeStart:binding.scope.byteStart}}:entry)},
    {...facts,bindings:facts.bindings.map((entry)=>entry.id===binding.id?{...entry,typeDeclaration:{...binding.typeDeclaration!,scopeExpression:'forged-scope'}}:entry)},
    {...facts,expressions:facts.expressions.map((entry)=>entry.id===type.id?{...entry,name:'Other'}:entry)},
    {...facts,expressions:facts.expressions.map((entry)=>entry.id===binding.typeDeclaration?.expression?{...entry,fields:{...entry.fields,name:[type.id]}}:entry)},
  ];
  for(const variant of variants){const result=evaluateLibraryModels(variant);expect(result.effects.filter((entry)=>entry.kind==='metric-declare')).toEqual([]);
    expect(result.diagnostics.some((entry)=>entry.path===path)).toBe(true);}
});


test('Go type parameters and local value shadows cannot borrow a file struct declaration',async()=>{
  const path='lib/metric.go';const prefix='package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\ntype Options struct{Name string}\n';
  for(const body of [
    'func run[Options any](){prom.NewCounter(Options{Name:"bad_total"})}',
    'func run(){var Options any;prom.NewCounter(Options{Name:"bad_total"})}',
    'func run(){type Options = struct{Name string};prom.NewCounter(Options{Name:"bad_total"})}',
    'type Generic[T any] struct{Name string}\nvar metric=prom.NewCounter(Generic[int]{Name:"bad_total"})',
  ]){
    const tree=treeOf({[path]:prefix+body});const code=await extractCodeWithFacts(tree);const result=extractOperations(tree,code.extraction,code.facts);
    expect(result.nodes.filter((entry)=>entry.kind==='code.metric')).toEqual([]);
    expect(result.gaps.some((entry)=>entry.path===path)).toBe(true);
  }
});


test('Go forged outer type binding cannot bypass an active inner map declaration',async()=>{
  const path='lib/metric.go';const tree=treeOf({[path]:'package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\ntype Options struct{Name string}\nfunc run(){type Options map[string]string;const Name="different";prom.NewCounter(Options{Name:"bad_total"})}'});
  const {facts}=await extractCodeWithFacts(tree);const outer=facts.bindings.find((entry)=>entry.typeDeclaration?.shape==='struct');
  const composite=facts.expressions.find((entry)=>entry.syntaxKind==='composite_literal'&&(entry.fields.type??[]).some((id)=>facts.expressions.find((type)=>type.id===id)?.name==='Options'));
  if(outer?.typeDeclaration===undefined||composite===undefined)throw new Error('real shadow fixture lacks declarations');
  const typeId=composite.fields.type?.[0];if(typeId===undefined)throw new Error('composite type child missing');
  const forged={...facts,expressions:facts.expressions.map((entry)=>entry.id===typeId?{...entry,bindingId:outer.id}:entry.id===composite.id?
    {...entry,compositeType:{shape:'struct' as const,typeExpression:typeId,bindingId:outer.id,declarationExpression:outer.typeDeclaration!.expression,declarationSpan:outer.typeDeclaration!.declarationSpan}}:entry)};
  const result=evaluateLibraryModels(forged);expect(result.effects.filter((entry)=>entry.kind==='metric-declare')).toEqual([]);
  expect(result.diagnostics.some((entry)=>entry.path===path&&entry.reason.includes('struct-shape proof'))).toBe(true);
});


test('Go short declaration reused local cannot retain its old logger or options initializer',async()=>{
  const path='lib/reuse.go';const tree=treeOf({[path]:'package sample\nimport "log/slog"\nimport prom "github.com/prometheus/client_golang/prometheus"\nfunc run(replacement any){logger:=slog.Default();logger,next:=replacement,1;logger.Info("not proved");_ = next;options:=prom.CounterOpts{Name:"old_total"};options,other:=replacement,2;prom.NewCounter(options);_ = other}'});
  const code=await extractCodeWithFacts(tree);const result=extractOperations(tree,code.extraction,code.facts);
  expect(code.facts.bindings.filter((entry)=>entry.name==='logger'||entry.name==='options').every((entry)=>entry.initializer===undefined)).toBe(true);
  expect(result.edges.filter((entry)=>entry.type==='code.uses-logger')).toEqual([]);
  expect(result.nodes.filter((entry)=>entry.kind==='code.metric')).toEqual([]);
  expect(result.gaps.some((entry)=>entry.path===path)).toBe(true);
});


test('Go forged imported type receiver cannot bypass an active parameter shadow',async()=>{
  const path='lib/metric.go';const tree=treeOf({[path]:'package sample\nimport prom "github.com/prometheus/client_golang/prometheus"\nvar constructor=prom.NewCounter\nfunc run(prom any){constructor(prom.CounterOpts{Name:"bad_total"})}'});
  const {facts}=await extractCodeWithFacts(tree);const binding=facts.bindings.find((entry)=>entry.kind==='import');
  const type=facts.expressions.find((entry)=>entry.syntaxKind==='qualified_type');
  if(binding===undefined||type?.receiver===undefined)throw new Error('real external shadow fixture lacks receiver');
  const forged={...facts,expressions:facts.expressions.map((entry)=>entry.id===type.receiver?{...entry,bindingId:binding.id}:entry)};
  const result=evaluateLibraryModels(forged);expect(result.effects.filter((entry)=>entry.kind==='metric-declare')).toEqual([]);
  expect(result.diagnostics.some((entry)=>entry.path===path)).toBe(true);
});


test('nested async callbacks preserve canonical parameter keys, raw UTF-8 spans and operation owner closure', async () => {
  const path = 'lib/worker.ts';
  const source = 'const note="éλ"; import pino from "pino"; import {Counter} from "prom-client"; const logger=pino(); const counter=new Counter({name:"work_total",help:"work"}); function target(){} export function outer(){ setTimeout(async () => { setTimeout(() => {target();logger.info("ready");counter.inc();},0); },0); }';
  const tree = treeOf({'package.json': JSON.stringify({name:'neutral-unit',dependencies:{pino:'9.0.0','prom-client':'15.0.0'}}),[path]:source});
  const code = await extractCodeWithFacts(tree);
  const bytes = new TextEncoder().encode(source);
  const byteAt = (index: number) => new TextEncoder().encode(source.slice(0,index)).length;
  const outerAt = source.indexOf('() => {');
  const innerAt = source.indexOf('() => {target');
  const outer = `code.symbol:${path}#outer.callback@1:${byteAt(outerAt)}`;
  const inner = `${outer}.callback@1:${byteAt(innerAt)}`;
  const parent = code.facts.symbols.find((symbol)=>symbol.key===outer);
  expect(parent).toBeDefined();
  expect(new TextDecoder().decode(bytes.subarray(parent!.span.byteStart,parent!.span.byteEnd)).startsWith('async () =>')).toBe(true);
  expect(code.facts.symbols.find((symbol)=>symbol.key===inner)).toBeDefined();
  const logCall = code.facts.calls.find((call)=>new TextDecoder().decode(bytes.subarray(call.span.byteStart,call.span.byteEnd))==='logger.info("ready")');
  expect(logCall?.holder).toBe(inner);
  expect(new TextDecoder().decode(bytes.subarray(logCall!.invocationSpan!.byteStart,logCall!.invocationSpan!.byteEnd))).toBe('logger.info(');
  const operations = extractOperations(tree,code.extraction,code.facts);
  const held = new Set(operations.nodes.map((node)=>node.key));
  for(const edge of operations.edges) {expect(held.has(edge.from),edge.from).toBe(true);expect(held.has(edge.to),edge.to).toBe(true);}
  expect(operations.edges.filter((edge)=>edge.type==='code.uses-logger' && edge.to.startsWith('code.symbol:')).map((edge)=>edge.to)).toEqual([inner]);
  expect(operations.edges.filter((edge)=>edge.type==='code.updates-metric').map((edge)=>edge.from)).toEqual([inner]);
  expect(code.extraction.edges.some((edge)=>edge.type==='code.calls' && edge.from===`code.symbol:${path}#outer` && edge.to===`code.symbol:${path}#target`)).toBe(false);
  expect(code.extraction.edges.some((edge)=>edge.type==='code.calls' && edge.from===inner && edge.to===`code.symbol:${path}#target`)).toBe(true);
});

test('a missing canonical inner owner withholds operation edges instead of materializing an outer guess', async () => {
  const path='lib/worker.ts';
  const tree=treeOf({'package.json':JSON.stringify({name:'neutral-unit',dependencies:{pino:'9.0.0'}}),[path]:'import pino from "pino";const logger=pino();export function outer(){setTimeout(()=>logger.info("ready"),0);}'});
  const code=await extractCodeWithFacts(tree);
  const call=code.facts.calls.find((one)=>code.facts.expressions.find((expression)=>expression.id===one.callee)?.member==='info');
  expect(call).toBeDefined();
  const facts={...code.facts,symbols:code.facts.symbols.map((symbol)=>symbol.key===call!.holder?{...symbol,bodySpan:undefined}:symbol)};
  const operations=extractOperations(tree,code.extraction,facts);
  expect(operations.edges.filter((edge)=>edge.type==='code.uses-logger')).toEqual([]);
  expect(operations.gaps.some((gap)=>gap.path===path && gap.reason.includes('unique canonical callable owner'))).toBe(true);
});


test('single returned logger declarations use their proved callable identity and model output metadata', async () => {
  const path='engine/logging/logger.go';
  const tree=treeOf({'engine/go.mod':'module example.test/engine\n',[path]:'package logging\nimport("log/slog";"os")\nfunc Build() *slog.Logger{return slog.New(slog.NewJSONHandler(os.Stdout,nil)).With("unit","value")}\nfunc Fallback() *slog.Logger{return slog.Default()}\n'});
  const code=await extractCodeWithFacts(tree);const result=extractOperations(tree,code.extraction,code.facts);
  const made=result.nodes.find((node)=>node.key===`code.logger:${path}#Build`);
  expect(made).toBeDefined();expect(made?.properties.library).toBe('slog');expect(made?.properties.json).toBe(true);
  const fallback=result.nodes.find((node)=>node.key===`code.logger:${path}#Fallback`);
  expect(fallback).toBeDefined();expect(fallback?.properties.json).toBe(false);
  expect(made?.label).not.toBe(fallback?.label);
});


test('model relevance diagnoses shadowed factories but does not treat unrelated repository calls as missing library proof', async () => {
  const path='lib/worker.ts';const tree=treeOf({'package.json':JSON.stringify({name:'neutral-unit',dependencies:{pino:'9.0.0'}}),[path]:'import pino from "pino";const logger=pino();export function unrelated(service:{run():void}){service.run();}export function shadow(input:{pino:()=>number}){const {pino}=input;return pino();}export function positive(){logger.info("ready");}'});
  const code=await extractCodeWithFacts(tree);const evaluated=evaluateLibraryModels(code.facts);
  expect(evaluated.gaps.some((gap)=>gap.path===path && gap.reason.includes('logger factory'))).toBe(true);
  const uses=evaluated.effects.filter((effect)=>effect.kind==='logger-use');expect(uses).toHaveLength(1);expect(uses[0]?.holder).toBe(`code.symbol:${path}#positive`);
  const unrelated=code.facts.symbols.find((symbol)=>symbol.qualifiedName==='unrelated')!;
  expect(evaluated.diagnostics.filter((entry)=>entry.code==='unknown-origin' && unrelated.span.byteStart<=entry.span.byteStart && entry.span.byteEnd<=unrelated.span.byteEnd)).toEqual([]);
});


test('forged invocation prefix metadata is diagnosed and cannot replace the full call evidence', async () => {
  const path='lib/worker.ts';const tree=treeOf({'package.json':JSON.stringify({name:'neutral-unit',dependencies:{pino:'9.0.0'}}),[path]:'import pino from "pino";const logger=pino();export function run(){logger.info("ready");}'});
  const code=await extractCodeWithFacts(tree);
  const use=code.facts.calls.find((call)=>code.facts.expressions.find((expression)=>expression.id===call.callee)?.member==='info')!;
  expect(use.invocationSpan).toBeDefined();
  const facts={...code.facts,calls:code.facts.calls.map((call)=>call===use?{...call,invocationSpan:{...call.span,byteEnd:call.span.byteEnd-1}}:call)};
  const result=evaluateLibraryModels(facts);
  expect(result.diagnostics.some((diagnostic)=>diagnostic.reason.includes('invocation prefix disagrees'))).toBe(true);
  const effect=result.effects.find((one)=>one.kind==='logger-use');expect(effect?.span).toEqual(use.span);expect(effect?.invocationSpan).toBeUndefined();
});


test('a proved absent selector differs from an unresolved dynamic or duplicate property', async () => {
  const path='lib/worker.ts';const tree=treeOf({'package.json':JSON.stringify({name:'neutral-unit',dependencies:{'prom-client':'15.0.0'}}),[path]:'import {Counter} from "prom-client";export function run(input:any){new Counter({name:"one_total",help:"one"});new Counter({name:"two_total",help:"two",registers:[]});new Counter({...input,name:"three_total",help:"three"});}'});
  const code=await extractCodeWithFacts(tree);const result=evaluateLibraryModels(code.facts);
  const declarations=result.effects.filter((effect)=>effect.kind==='metric-declare');expect(declarations.length).toBeGreaterThanOrEqual(2);
  const registerStatuses=declarations.map((effect)=>effect.arguments.find((argument)=>argument.name==='registers')?.status);
  expect(registerStatuses).toContain('absent');expect(registerStatuses).toContain('selected');
  const unresolved=result.diagnostics.some((diagnostic)=>diagnostic.reason.includes('spread'));expect(unresolved).toBe(true);
});
