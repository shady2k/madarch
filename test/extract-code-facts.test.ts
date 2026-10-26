import { expect, test } from 'bun:test';
import { extractCode, extractCodeWithFacts } from '../src/extract/code/index.js';
import { decodeNumberToken, decodeStringToken } from '../src/extract/code/literals.js';
import { evaluateLibraryModels } from '../src/extract/library-models/evaluate.js';
import { freezeCodeFacts, type CodeFacts } from '../src/extract/code/facts.js';
import type { TreeReader } from '../src/extract/records.js';

function treeOf(files: Readonly<Record<string, string>>): TreeReader {
  return { paths: Object.keys(files).sort(), read: (path) => {
    const source = files[path];
    if (source === undefined) throw new Error(`missing fixture path ${path}`);
    return new TextEncoder().encode(source);
  } };
}

function member(facts: CodeFacts, name: string) {
  return facts.expressions.filter((expression) => expression.member === name);
}

test('one code pass exposes frozen source facts without changing the extraction API', async () => {
  const tree = treeOf({
    'package.json': JSON.stringify({ name: 'fixture', dependencies: { pino: '9.0.0' } }),
    'lib/entry.ts': 'import factory from "pino"; export const logger = factory(); export function run(){ logger.info("ok"); }',
  });
  const result = await extractCodeWithFacts(tree);
  expect(result.extraction).toEqual(await extractCode(tree));
  expect(Object.isFrozen(result.facts)).toBe(true);
  expect(Object.isFrozen(result.facts.expressions)).toBe(true);
  expect(result.facts.imports[0]?.package).toEqual({ ecosystem: 'node', name: 'pino', manifestPath: 'package.json', declaredVersion: '9.0.0' });
  expect(result.facts.expressions.every((expression) => Object.isFrozen(expression) && Object.isFrozen(expression.fields))).toBe(true);
  const ids = result.facts.expressions.map((expression) => expression.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(Object.isFrozen(result.facts.bindings[0]?.span)).toBe(true);
});

test('a full receiver chain cannot borrow a standalone logger or counter binding', async () => {
  const { facts } = await extractCodeWithFacts(treeOf({
    'package.json': '{"name":"fixture","dependencies":{"pino":"9.0.0","prom-client":"15.0.0"}}',
    'src/main.ts': [
      'import makeLog from "pino";',
      'import {Counter} from "prom-client";',
      'const logger = makeLog(); const requests = new Counter({name:"work_total",help:"work"});',
      'export function run(other: any){ logger.info("yes"); other.logger.info("no"); requests.inc(); other.requests.inc(); }',
    ].join('\n'),
  }));
  const expressions = new Map(facts.expressions.map((expression) => [expression.id, expression]));
  const info = member(facts, 'info');
  expect(info).toHaveLength(2);
  const roots = info.map((expression) => expressions.get(expression.receiver!));
  expect(roots.some((expression) => expression?.name === 'logger' && expression.bindingId !== undefined)).toBe(true);
  expect(roots.some((expression) => expression?.member === 'logger' && expression.receiver !== undefined && expression.bindingId === undefined)).toBe(true);
  const inc = member(facts, 'inc');
  expect(inc).toHaveLength(2);
  expect(inc.map((expression) => expressions.get(expression.receiver!)).some((expression) => expression?.member === 'requests')).toBe(true);
});

test('destructured parameters and temporal-dead-zone locals do not reuse imports', async () => {
  const { facts } = await extractCodeWithFacts(treeOf({
    'package.json': '{"name":"fixture","dependencies":{"pino":"9.0.0"}}',
    'src/main.ts': 'import logger from "pino"; export function run({logger}: any){ logger.info("local"); (()=>logger.info("nested"))(); } export function next(){ logger.info("tdz"); const logger = other; }',
  }));
  const expressions = new Map(facts.expressions.map((expression) => [expression.id, expression]));
  const bindings = new Map(facts.bindings.map((binding) => [binding.id, binding]));
  for (const expression of member(facts, 'info')) {
    const receiver = expressions.get(expression.receiver!);
    if (receiver?.bindingId !== undefined) expect(bindings.get(receiver.bindingId)?.kind).not.toBe('import');
    else expect(receiver?.name).toBe('logger'); // TDZ: unknown, never outer import.
  }
});

test('copied facts retain UTF-8 spans and canonical callback owners after AST disposal', async () => {
  const path = 'src/work.ts';
  const source = 'const label = "éλ"; export function outer(){ setTimeout(()=>{ console.log(label); }, 1); }';
  const { facts } = await extractCodeWithFacts(treeOf({ 'package.json': '{"name":"fixture"}', [path]: source }));
  const call = facts.calls.find((call) => facts.expressions.find((expression) => expression.id === call.callee)?.member === 'log');
  expect(call).toBeDefined();
  expect(call!.holder).not.toBe('code.symbol:src/work.ts#outer');
  const bytes = new TextEncoder().encode(source);
  expect(new TextDecoder().decode(bytes.subarray(call!.span.byteStart, call!.span.byteEnd))).toBe('console.log(label)');
  const expressionIds = new Set(facts.expressions.map((expression) => expression.id));
  for (const expression of facts.expressions) for (const child of expression.children) expect(expressionIds.has(child)).toBe(true);
});

test('JavaScript, TSX and Go query assets return facts or explicit syntax diagnostics', async () => {
  const { facts } = await extractCodeWithFacts(treeOf({
    'package.json': '{"name":"fixture"}',
    'web/view.tsx': 'export function View(){ return <div>{String(1)}</div>; }',
    'web/entry.js': 'export function start(){ return globalThis.run(); }',
    'engine/go.mod': 'module example.invalid/engine\n\ngo 1.23\n',
    'engine/main.go': 'package engine\nimport "log/slog"\nfunc Run(){ slog.Info("ready") }\n',
    'web/bad.ts': 'export function broken( {',
  }));
  expect(new Set(facts.files.map((file) => file.language))).toEqual(new Set(['tsx', 'javascript', 'go', 'typescript']));
  expect(facts.calls.some((call) => call.path === 'web/view.tsx')).toBe(true);
  expect(facts.calls.some((call) => call.path === 'engine/main.go')).toBe(true);
  expect(facts.gaps.some((gap) => gap.path === 'web/bad.ts')).toBe(true);
});

test('literal decoding follows grammar tokens and refuses dynamic template values', () => {
  expect(decodeStringToken('string', '"a\\n\\u03bb"')).toBe('a\nλ');
  expect(decodeStringToken('string', "'it\\'s'")).toBe("it's");
  expect(decodeStringToken('raw_string_literal', '`raw\\n`')).toBe('raw\\n');
  expect(decodeStringToken('interpreted_string_literal', '"\\141"')).toBe('a');
  expect(decodeStringToken('template_string', '`hello ${name}`')).toBeUndefined();
  expect(decodeStringToken('identifier', '"not a token"')).toBeUndefined();
});

test('function-hoisted var and reassignment cannot retain imported receiver origins', async () => {
  const { facts } = await extractCodeWithFacts(treeOf({
    'package.json': '{"name":"fixture","dependencies":{"pino":"9.0.0"}}',
    'src/main.ts': 'import logger from "pino"; export function run(){ logger.info("before"); if (true) { var logger = other; } } export function change(){ logger = replacement; logger.info("after"); }',
  }));
  const expressions = new Map(facts.expressions.map((expression) => [expression.id, expression]));
  const bindings = new Map(facts.bindings.map((binding) => [binding.id, binding]));
  const uses = member(facts, 'info');
  expect(uses).toHaveLength(2);
  const [before, after] = [...uses].sort((left, right) => left.span.byteStart - right.span.byteStart);
  const bound = (expression: (typeof uses)[number] | undefined) => {const receiver = expression?.receiver === undefined ? undefined : expressions.get(expression.receiver);return receiver?.bindingId === undefined ? undefined : bindings.get(receiver.bindingId);};
  // Hoisting selects the function-local declaration. Assignment keeps the real
  // import declaration as evidence; its write proof forbids a stale origin.
  expect(bound(before)?.importId).toBeUndefined();
  expect(bound(before)?.kind).toBe('local');
  const reassigned = bound(after);
  expect(reassigned?.kind).toBe('import');
  expect(reassigned?.importId).toBe(facts.imports.find(entry => entry.local === 'logger')?.id);
  expect(facts.expressions.some(expression => expression.syntaxKind === 'assignment_expression' && (expression.fields.left ?? []).some(id => expressions.get(id)?.bindingId === reassigned?.id))).toBe(true);
  const evaluated = evaluateLibraryModels(facts);
  expect(evaluated.effects.filter(effect => effect.kind === 'logger-use')).toEqual([]);
  expect(evaluated.diagnostics.some(entry => entry.path === 'src/main.ts' && entry.reason.includes('reassigned'))).toBe(true);
});

test('Go legacy octal and non-ASCII byte escapes are decoded accurately or left unknown', async () => {
  expect(decodeNumberToken('int_literal', '0777', true)).toBe(511);
  expect(decodeNumberToken('int_literal', '0o777', true)).toBe(511);
  expect(decodeStringToken('interpreted_string_literal', '"\\xff"')).toBeUndefined();
  expect(decodeStringToken('interpreted_string_literal', '"\\377"')).toBeUndefined();
  const { facts } = await extractCodeWithFacts(treeOf({
    'go.mod': 'module example.invalid/unit\n\ngo 1.23\n',
    'main.go': 'package unit\nvar mode = 0777\nvar invalid = "\\xff"\n',
  }));
  expect(facts.expressions.find((expression) => expression.literal?.raw === '0777')?.literal?.value).toBe(511);
  expect(facts.expressions.find((expression) => expression.literal?.raw === '"\\xff"')?.literal?.value).toBeUndefined();
  expect(facts.gaps.some((gap) => gap.path === 'main.go' && gap.reason.includes('literal'))).toBe(true);
});


test('grammar fields called constructor retain their own exact expression identity without prototype collisions',async()=>{
  const path='lib/construct.ts';const source='class Unit {} export const value=new Unit();';const tree=treeOf({[path]:source});
  const code=await extractCodeWithFacts(tree);const expressions=new Map(code.facts.expressions.map((entry)=>[entry.id,entry]));
  const construct=code.facts.calls.find((call)=>call.construct)!;expect(construct).toBeDefined();
  const expression=expressions.get(construct.expression)!;expect(Object.hasOwn(expression.fields,'constructor')).toBe(true);
  expect(expression.fields['constructor']).toEqual([construct.callee]);
  const constructor=expressions.get(construct.callee)!;
  expect(new TextDecoder().decode(tree.read(path).subarray(constructor.span.byteStart,constructor.span.byteEnd))).toBe('Unit');
  expect(code.extraction.nodes.some((node)=>node.key==='code.symbol:lib/construct.ts#Unit')).toBe(true);
});


test('copied structural fields preserve constructor, prototype and inherited-method names as own data keys',()=>{
  const span={path:'lib/generated.ts',byteStart:0,byteEnd:1,lineStart:1,lineEnd:1};
  const fields:Record<string,string[]> = Object.fromEntries(new Map([['constructor',['ctor']],['__proto__',['proto']],['toString',['display']]]));
  const facts=freezeCodeFacts({files:[],symbols:[],imports:[],bindings:[],expressions:[{id:'holder',path:span.path,syntaxKind:'generated',span,children:[],fields}],calls:[],sites:[],gaps:[]});
  const copied=facts.expressions[0]!.fields;
  for(const [key,expected] of [['constructor','ctor'],['__proto__','proto'],['toString','display']] as const){
    expect(Object.hasOwn(copied,key)).toBe(true);expect(copied[key]).toEqual([expected]);
  }
  expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);expect(Object.isFrozen(copied)).toBe(true);
});


test('Go struct proofs retain exact raw type children and local declaration identities; aliases stay unproven', async () => {
  const path = 'lib/options.go';
  const {facts} = await extractCodeWithFacts(treeOf({[path]: 'package sample\n' +
    'type Local struct { Name string }\n' +
    'var anonymous = struct { Name string }{Name:"one"}\nvar named = Local{Name:"two"}\ntype Alias = Local\nvar alias = Alias{Name:"three"}\n'}));
  const anonymousCandidates = facts.expressions.filter((entry) => entry.compositeType !== undefined && entry.compositeType.bindingId === undefined &&
    facts.expressions.find((type) => type.id === entry.compositeType?.typeExpression)?.syntaxKind === 'struct_type');
  expect(anonymousCandidates).toHaveLength(1);
  const anonymous = anonymousCandidates[0];
  expect(anonymous).toBeDefined();
  const type = facts.expressions.find((entry) => entry.id === anonymous?.compositeType?.typeExpression);
  expect(type?.syntaxKind).toBe('struct_type');
  if (anonymous?.compositeType === undefined || type === undefined) throw new Error('anonymous struct type proof missing');
  expect(anonymous.compositeType.declarationSpan).toEqual(type.span);
  expect(Object.isFrozen(anonymous?.compositeType)).toBe(true);
  const named = facts.expressions.find((entry) => entry.compositeType?.bindingId !== undefined);
  expect(named?.compositeType?.declarationExpression).toBeDefined();
  const alias = facts.expressions.find((entry) => entry.syntaxKind === 'composite_literal' &&
    (entry.fields.type ?? []).some((id) => facts.expressions.find((type) => type.id === id)?.name === 'Alias'));
  expect(alias).toBeDefined();
  expect(alias?.compositeType).toBeUndefined();
  const pair = facts.expressions.find((entry) => entry.syntaxKind === 'keyed_element');
  expect(pair?.fields).toEqual({});
  expect(pair?.children).toHaveLength(2);
  expect(pair?.children.map((id) => facts.expressions.find((entry) => entry.id === id)?.syntaxKind)).toEqual(['literal_element', 'literal_element']);
});


test('Go short declaration reuses a function parameter and binds only its new name',async()=>{
  const path='lib/reuse.go';const source='package sample\nfunc run(x int){x,y:=1,2;_ = x;_ = y}';
  const {facts}=await extractCodeWithFacts(treeOf({[path]:source}));
  const parameter=facts.bindings.find((entry)=>entry.kind==='parameter'&&entry.name==='x');
  expect(parameter).toBeDefined();expect(facts.bindings.filter((entry)=>entry.name==='x')).toHaveLength(1);
  const y=facts.bindings.filter((entry)=>entry.name==='y');expect(y).toHaveLength(1);expect(y[0]?.kind).toBe('local');
  const read=facts.expressions.filter((entry)=>entry.name==='x'&&entry.span.byteStart>source.indexOf('x,y'));
  expect(read.every((entry)=>entry.bindingId===parameter?.id)).toBe(true);
  expect(facts.gaps).toEqual([]);
});

test('Go repeated short declaration without a new name is a located gap and invents no binding identity',async()=>{
  const path='lib/reuse.go';const source='package sample\nfunc run(){x:=1;x:=2;_ = x}';
  const {facts}=await extractCodeWithFacts(treeOf({[path]:source}));
  expect(facts.bindings.filter((entry)=>entry.name==='x')).toHaveLength(1);
  expect(facts.gaps.some((entry)=>entry.path===path&&entry.reason.includes('short declaration has no unique new binding'))).toBe(true);
});


test('Go manifest versions and missing-module reason codes come from the manifest parser metadata', async () => {
  const tree=treeOf({'go.mod':'module example.test/unit\nrequire (\n example.test/dependency v1.2.3\n)\n','main.go':'package main\nimport "example.test/dependency/sub"\n'});
  const result=await extractCodeWithFacts(tree);
  const imported=result.extraction.edges.find((edge)=>edge.type==='code.imports' && edge.to==='code.dependency:go.mod#example.test/dependency');
  expect(imported?.properties.version).toBe('v1.2.3');
  expect(result.facts.imports.find((entry)=>entry.specifier==='example.test/dependency/sub')?.package?.declaredVersion).toBe('v1.2.3');
  const missing=await extractCodeWithFacts(treeOf({'go.mod':'go 1.23\n'}));
  expect(missing.extraction.gaps.some((gap)=>gap.path==='go.mod' && gap.reason.includes('line 1') && gap.reason.includes('names no module'))).toBe(true);
});


test('direct Go field declarations retain exact owner and qualified type expressions for cross-method evidence', async () => {
  const path='engine/meter.go';const source='package meter\nimport "sync/atomic"\ntype Meter struct { total atomic.Int64 }\nfunc (m *Meter) Add(){m.total.Add(1)}\nfunc (m *Meter) Read() int64{return m.total.Load()}\n';
  const {facts}=await extractCodeWithFacts(treeOf({[path]:source}));
  const fields=facts.fields?.filter((field)=>field.key===`code.symbol:${path}#Meter.total`);expect(fields).toHaveLength(1);
  const field=fields![0]!;expect(field.ownerTypeName).toBe('Meter');
  const declaration=facts.expressions.find((expression)=>expression.id===field.ownerDeclaration);expect(declaration?.syntaxKind).toBe('type_spec');
  const type=facts.expressions.find((expression)=>expression.id===field.typeExpression);expect(type?.member).toBe('Int64');
  const packageExpression=facts.expressions.find((expression)=>expression.id===type?.receiver);
  const binding=facts.bindings.find((entry)=>entry.id===packageExpression?.bindingId);expect(facts.imports.find((entry)=>entry.id===binding?.importId)?.specifier).toBe('sync/atomic');
  const reads=facts.sites.filter((site)=>site.to===field.key);expect(reads.length).toBeGreaterThanOrEqual(2);
});
