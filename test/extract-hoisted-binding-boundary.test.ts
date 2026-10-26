import { expect, test } from 'bun:test';
import { extractCodeWithFacts } from '../src/extract/code/index.js';
import { evaluateLibraryModels } from '../src/extract/library-models/evaluate.js';
import type { TreeReader } from '../src/extract/records.js';
import type { CodeFacts } from '../src/extract/code/facts.js';
import { TreeText } from '../src/extract/operations/source.js';
import { functionsOf } from '../src/extract/operations/symbol-sites.js';

function treeOf(source: string): TreeReader {
  const files: Readonly<Record<string, string>> = {
    'package.json': '{"name":"fixture","dependencies":{"pino":"9.0.0"}}',
    'src/main.ts': source,
  };
  return { paths: Object.keys(files).sort(), read: (path) => {
    const content = files[path];
    if (content === undefined) throw new Error(`missing fixture path ${path}`);
    return new TextEncoder().encode(content);
  } };
}

test('a function-hoisted var keeps its declaration identity before initialization but has no origin', async () => {
  const source = [
    'import logger from "pino";',
    'import makeLogger from "pino";',
    'export function run(){',
    '  logger.info("before");',
    '  if (true) { var logger = makeLogger(); }',
    '}',
  ].join('\n');
  const { facts } = await extractCodeWithFacts(treeOf(source));
  const member = facts.expressions.find((expression) => expression.member === 'info');
  expect(member).toBeDefined();
  const receiver = facts.expressions.find((expression) => expression.id === member?.receiver);
  expect(receiver?.bindingId).toBeDefined();
  const binding = facts.bindings.find((entry) => entry.id === receiver?.bindingId);
  expect(binding?.kind).toBe('local');
  expect(binding?.importId).toBeUndefined();
  expect(binding?.span.byteStart).toBe(source.indexOf('logger ='));
  expect(binding?.initializer).toBeDefined();
  expect(receiver!.span.byteStart).toBeLessThan(binding!.span.byteStart);
  expect(binding!.scope.byteStart).toBeLessThanOrEqual(receiver!.span.byteStart);
  expect(binding!.scope.byteEnd).toBeGreaterThanOrEqual(receiver!.span.byteEnd);
  expect(facts.gaps.filter((gap) => gap.reason.includes('lexical binding is not initialized'))).toEqual([]);

  const evaluated = evaluateLibraryModels(facts);
  expect(evaluated.effects.filter((effect) => effect.kind === 'logger-use')).toEqual([]);
  expect(evaluated.diagnostics.some((entry) => entry.path === 'src/main.ts' &&
    entry.reason.includes('local binding is used before its declaration'))).toBe(true);
});

test('hoisted destructuring var patterns retain only their exact function-local binding IDs', async () => {
  for (const declaration of [
    'var { logger } = other',
    'var { value: logger } = other',
    'var { logger = other } = other',
    'var [logger = other] = other',
    'var [...logger] = other',
  ]) {
    const source = `import logger from "pino"; export function run(){ logger.info("before"); if (true) { ${declaration}; } }`;
    const { facts } = await extractCodeWithFacts(treeOf(source));
    const member = facts.expressions.find((expression) => expression.member === 'info');
    expect(member, declaration).toBeDefined();
    const receiver = facts.expressions.find((expression) => expression.id === member?.receiver);
    const binding = facts.bindings.find((entry) => entry.id === receiver?.bindingId);
    expect(binding?.kind, declaration).toBe('local');
    expect(binding?.importId, declaration).toBeUndefined();
    expect(receiver!.span.byteStart, declaration).toBeLessThan(binding!.span.byteStart);
    expect(binding!.scope.byteStart, declaration).toBeLessThanOrEqual(receiver!.span.byteStart);
    expect(facts.gaps.filter((gap) => gap.reason.includes('lexical binding is not initialized')), declaration).toEqual([]);
    expect(evaluateLibraryModels(facts).effects.filter((effect) => effect.kind === 'logger-use'), declaration).toEqual([]);
  }
});

test('same-spelled let and const bindings stay in the TDZ beside a function-hoisted var', async () => {
  const source = [
    'import logger from "pino";',
    'export function hoisted(){ logger.info("var"); var logger = other; }',
    'export function lexicalLet(){ logger.info("let"); let logger = other; }',
    'export function lexicalConst(){ logger.info("const"); const logger = other; }',
  ].join('\n');
  const { facts } = await extractCodeWithFacts(treeOf(source));
  const members = facts.expressions.filter((expression) => expression.member === 'info')
    .sort((left, right) => left.span.byteStart - right.span.byteStart);
  expect(members).toHaveLength(3);
  const receivers = members.map((member) => facts.expressions.find((expression) => expression.id === member.receiver));
  expect(receivers[0]?.bindingId).toBeDefined();
  for (const receiver of receivers.slice(1)) {
    expect(receiver?.name).toBe('logger');
    expect(receiver?.bindingId).toBeUndefined();
    expect(facts.gaps.some((gap) => gap.path === 'src/main.ts' &&
      gap.reason.includes(`lexical binding is not initialized at bytes ${receiver!.span.byteStart}-${receiver!.span.byteEnd}`))).toBe(true);
  }
  expect(evaluateLibraryModels(facts).effects.filter((effect) => effect.kind === 'logger-use')).toEqual([]);
});

function filesTree(files: Readonly<Record<string, string>>): TreeReader {
  return { paths: Object.keys(files).sort(), read: (path) => {
    const content = files[path];
    if (content === undefined) throw new Error(`missing fixture path ${path}`);
    return new TextEncoder().encode(content);
  } };
}

test('Go if initializers shadow outer bindings and end before the next statement', async () => {
  const path = 'engine/scope.go';
  const source = [
    'package sample',
    'func run(err error){',
    ' if err := first(); err != nil { consume(err) } else { consume(err) }',
    ' consume(err)',
    ' next, err := second()',
    ' consume(next, err)',
    '}',
  ].join('\n');
  const { facts } = await extractCodeWithFacts(filesTree({ [path]: source }));
  const parameter = facts.bindings.find((binding) => binding.name === 'err' && binding.kind === 'parameter');
  const local = facts.bindings.find((binding) => binding.name === 'err' && binding.kind === 'local');
  expect(parameter).toBeDefined();
  expect(local).toBeDefined();
  expect(facts.bindings.filter((binding) => binding.name === 'err')).toHaveLength(2);
  expect(local?.span.byteStart).toBe(source.indexOf('err := first'));
  expect(source.slice(local!.scope.byteStart, local!.scope.byteEnd)).toBe('if err := first(); err != nil { consume(err) } else { consume(err) }');
  const reads = facts.expressions.filter((expression) => expression.name === 'err' && expression.span.byteStart > local!.span.byteStart);
  expect(reads.filter((expression) => expression.span.byteEnd <= local!.scope.byteEnd).every((expression) => expression.bindingId === local?.id)).toBe(true);
  expect(reads.filter((expression) => expression.span.byteStart > local!.scope.byteEnd).every((expression) => expression.bindingId === parameter?.id)).toBe(true);
  expect(facts.gaps).toEqual([]);
});

test('Go for and switch initializer scopes keep their locals out of subsequent declarations', async () => {
  for (const statement of [
    'for item := first(); item != nil; item = next() { consume(item) }',
    'switch item := first(); item { default: consume(item) }',
    'switch item := first(); item.(type) { default: consume(item) }',
  ]) {
    const path = 'engine/scope.go';
    const source = `package sample\nfunc run(){ ${statement}; item := first(); consume(item) }`;
    const { facts } = await extractCodeWithFacts(filesTree({ [path]: source }));
    const bindings = facts.bindings.filter((binding) => binding.name === 'item');
    expect(bindings, statement).toHaveLength(2);
    expect(facts.gaps, statement).toEqual([]);
    const last = facts.expressions.filter((expression) => expression.name === 'item').sort((left, right) => right.span.byteStart - left.span.byteStart)[0];
    expect(last?.bindingId, statement).toBe(bindings.find((binding) => binding.span.byteStart === source.lastIndexOf('item := first'))?.id);
  }
});

test('Go var and parameter name lists bind identifiers only and align each initializer', async () => {
  const path = 'engine/names.go';
  const source = 'package sample\nfunc run(left, right int){ var first, second, third = 1, 2, 3; consume(left, right, first, second, third) }';
  const { facts } = await extractCodeWithFacts(filesTree({ [path]: source }));
  expect(facts.bindings.map((binding) => binding.name).sort()).toEqual(['first', 'left', 'right', 'second', 'third']);
  for (const [name, value] of [['first', 1], ['second', 2], ['third', 3]] as const) {
    const binding = facts.bindings.find((entry) => entry.name === name);
    expect(facts.expressions.find((expression) => expression.id === binding?.initializer)?.literal?.value).toBe(value);
  }
  expect(facts.gaps).toEqual([]);
});

test('Go invalid same-block redeclarations and parameter collisions remain located gaps', async () => {
  for (const source of [
    'package sample\nfunc run(){ value := 1; value := 2; consume(value) }',
    'package sample\nfunc run(value int){ var value int; consume(value) }',
    'package sample\nfunc run(){ var value int; var value int; consume(value) }',
  ]) {
    const path = 'engine/invalid.go';
    const { facts } = await extractCodeWithFacts(filesTree({ [path]: source }));
    expect(facts.gaps.some((gap) => gap.path === path &&
      (gap.reason.includes('short declaration has no unique new binding') || gap.reason.includes('ambiguous same-scope Go declaration')))).toBe(true);
  }
});

test('exact Go and TypeScript interface signatures do not claim executable bodies or missing-body gaps', async () => {
  for (const [path, source] of [
    ['engine/contract.go', 'package sample\ntype Worker interface { Run(value int) error }\nfunc actual(){ consume() }'],
    ['lib/contract.ts', 'export interface Worker { run(value: number): void; } export function actual(){ consume(); }'],
  ] as const) {
    const tree = filesTree({ [path]: source });
    const code = await extractCodeWithFacts(tree);
    const signature = code.facts.symbols.find((symbol) => symbol.symbolKind === 'method');
    expect(signature).toBeDefined();
    expect(signature?.bodySpan).toBeUndefined();
    const context = new TreeText(tree, code.extraction, code.facts);
    const sites = functionsOf(context, path!);
    expect(sites.map((site) => site.name)).toEqual(['actual']);
    expect([...context.factGaps.values()]).toEqual([]);

    const actual = code.facts.symbols.find((symbol) => symbol.name === 'actual');
    expect(actual?.bodySpan).toBeDefined();
    const missing: CodeFacts = { ...code.facts, symbols: code.facts.symbols.map((symbol) => symbol.key === actual?.key
      ? { ...symbol, bodySpan: undefined, bodySyntaxKind: undefined } : symbol) };
    const invalid = new TreeText(tree, code.extraction, missing);
    expect(functionsOf(invalid, path!)).toEqual([]);
    expect([...invalid.factGaps.values()].some((gap) => gap.reason.includes(`callable ${actual?.key} has no proved body`))).toBe(true);

    const noProof = { ...code.facts, expressions: code.facts.expressions.filter((expression) =>
      !['method_spec', 'method_signature'].includes(expression.syntaxKind)) };
    const unproved = new TreeText(tree, code.extraction, noProof);
    functionsOf(unproved, path!);
    expect([...unproved.factGaps.values()].some((gap) => gap.reason.includes(`callable ${signature?.key} has no proved body`))).toBe(true);
  }
});
