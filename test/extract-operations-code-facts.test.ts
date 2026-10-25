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
  const declaration=evaluated.effects.find((effect)=>effect.kind==='metric-declare');
  if(declaration===undefined)throw new Error(JSON.stringify({path,facts:code.facts,diagnostics:evaluated.diagnostics}));
  const selected=declaration.arguments.find((argument)=>argument.name==='name');expect(selected?.expression).toBeDefined();
  const operations=extractOperations(tree,code.extraction,code.facts);
  expect(operations.nodes.filter((node)=>node.kind==='code.metric').map((node)=>node.label)).toEqual(['requests_total']);
  expect(operations.edges.filter((edge)=>edge.type==='code.updates-metric').map((edge)=>edge.from)).toEqual(['code.symbol:lib/metric.go#run']);
});
