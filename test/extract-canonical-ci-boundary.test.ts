import {expect, test} from 'bun:test';
import {codeFactsOf, extractCodeWithFacts, releaseCodeFacts} from '../src/extract/code/index.js';
import type {CodeFacts} from '../src/extract/code/facts.js';
import {ContractSymbols} from '../src/extract/contracts/symbol-links.js';
import {extractContracts} from '../src/extract/contracts/index.js';
import {TreeText} from '../src/extract/operations/source.js';
import {functionAt, functionsOf} from '../src/extract/operations/symbol-sites.js';
import type {SourceSpan, TreeReader} from '../src/extract/records.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const treeOf = (files: Readonly<Record<string, string>>): TreeReader => ({
  paths: Object.keys(files).sort(),
  read(path) {
    const source = files[path];
    if (source === undefined) throw new Error(`missing fixture ${path}`);
    return encoder.encode(source);
  },
});
const raw = (tree: TreeReader, span: SourceSpan): string => decoder.decode(tree.read(span.path).subarray(span.byteStart, span.byteEnd));

test('named local initializers have one canonical owner and retain declaration and expression evidence', async () => {
  const path = 'lib/tasks.ts';
  const source = 'export function run(){const arrow=()=>17;const named=function privateName(){return 23;};return [arrow(),named()];}';
  const tree = treeOf({[path]: source});
  const code = await extractCodeWithFacts(tree);
  const context = new TreeText(tree, code.extraction, code.facts);
  const sites = functionsOf(context, path);
  expect(sites).toHaveLength(3);
  for (const [name, declaration, body] of [
    ['arrow', 'arrow=()=>17', '17'],
    ['named', 'named=function privateName(){return 23;}', '{return 23;}'],
  ]) {
    const site = sites.find((candidate) => candidate.name === name);
    expect(site).toBeDefined();
    expect(raw(tree, site!.span)).toBe(declaration!);
    const symbol = code.facts.symbols.find((candidate) => candidate.key === site!.key)!;
    expect(raw(tree, symbol.bodySpan!)).toBe(body!);
    const at = source.indexOf(body!);
    expect(functionAt(context, path, at)?.key).toBe(site!.key);
    const overlapping = sites.filter((candidate) => candidate.span.byteEnd === site!.span.byteEnd && candidate.key !== site!.key);
    expect(overlapping).toEqual([]);
  }
  expect(code.facts.symbols.some((symbol) => symbol.name === 'privateName')).toBe(false);
  expect(context.factGaps.size).toBe(0);
});

test('nested expression arrows sharing an end boundary retain the innermost body owner', async () => {
  const path = 'lib/factories.ts';
  const source = 'function leaf(){}export const factory=()=>()=>leaf();';
  const tree = treeOf({[path]: source});
  const code = await extractCodeWithFacts(tree);
  const context = new TreeText(tree, code.extraction, code.facts);
  const at = source.lastIndexOf('leaf()');
  const inner = functionAt(context, path, at);
  expect(inner).toBeDefined();
  expect(inner!.name).not.toBe('factory');
  expect(raw(tree, inner!.span)).toBe('()=>leaf()');
  expect(code.facts.calls.find((call) => raw(tree, call.span) === 'leaf()')?.holder).toBe(inner!.key);
  expect(functionsOf(context, path)).toHaveLength(3);
  expect(context.factGaps.size).toBe(0);
});

test('async callbacks keep their public parameter-start identity and full Unicode body evidence', async () => {
  const path = 'lib/callbacks.ts';
  const source = '// λ界\nfunction leaf(){}\nexport function queue(){schedule(async (value:any)=>{leaf();schedule(async()=>leaf());});}';
  const tree = treeOf({[path]: source});
  const code = await extractCodeWithFacts(tree);
  const context = new TreeText(tree, code.extraction, code.facts);
  const callbacks = code.facts.symbols.filter((symbol) => symbol.qualifiedName.includes('.callback@'));
  expect(callbacks).toHaveLength(2);
  for (const [index, prefix] of ['async (value:any)', 'async()'].entries()) {
    const start = source.indexOf(prefix);
    const byte = encoder.encode(source.slice(0, start)).length;
    const parameterByte = encoder.encode(source.slice(0, source.indexOf('(', start))).length;
    const symbol = callbacks.find((candidate) => candidate.span.byteStart === byte)!;
    expect(symbol).toBeDefined();
    expect(symbol.key.endsWith(`.callback@3:${parameterByte}`)).toBe(true);
    expect(raw(tree, symbol.span).startsWith(prefix)).toBe(true);
    expect(symbol.bodySpan).toBeDefined();
    const callAt = source.indexOf('leaf()', start);
    expect(functionAt(context, path, callAt)?.key).toBe(symbol.key);
    const call = code.facts.calls.find((candidate) => candidate.span.byteStart === encoder.encode(source.slice(0, callAt)).length);
    expect(call?.holder).toBe(symbol.key);
    expect(new ContractSymbols(context).handler(symbol.span, true, `/task-${index}`)).toBe(symbol.key);
  }
});

test('missing named inner body proof stays a tombstone for operations and contracts', async () => {
  const path = 'lib/ownership.ts';
  const source = 'export function outer(){const local=()=>consume();return local();}';
  const tree = treeOf({[path]: source});
  const code = await extractCodeWithFacts(tree);
  const inner = code.facts.symbols.find((symbol) => symbol.name === 'local')!;
  expect(inner.bodySpan).toBeDefined();
  const facts: CodeFacts = {...code.facts, symbols: code.facts.symbols.map((symbol) => symbol.key === inner.key ? {...symbol, bodySpan: undefined} : symbol)};
  const context = new TreeText(tree, code.extraction, facts);
  const at = source.indexOf('consume()');
  expect(functionAt(context, path, at)).toBeUndefined();
  const call = code.facts.calls.find((candidate) => raw(tree, candidate.span) === 'consume()')!;
  expect(new ContractSymbols(context).enclosing(call.span)).toBeUndefined();
  expect(context.factGaps.size).toBeGreaterThan(0);
});

test('retained facts belong only to the exact extraction and original reader', async () => {
  const files = {'lib/exact.ts': 'export function exact(){return 1;}'};
  const tree = treeOf(files);
  const code = await extractCodeWithFacts(tree);
  expect(codeFactsOf(code.extraction, tree)).toBe(code.facts);
  expect(Object.isFrozen(codeFactsOf(code.extraction, tree))).toBe(true);
  expect(codeFactsOf({...code.extraction}, tree)).toBeUndefined();
  expect(codeFactsOf(code.extraction, treeOf(files))).toBeUndefined();
  expect(codeFactsOf(undefined, tree)).toBeUndefined();
  expect(new TreeText(tree, code.extraction).facts).toBe(code.facts);
  expect(new TreeText(tree, {...code.extraction}).facts).toBeUndefined();
  expect(new TreeText(treeOf(files), code.extraction).facts).toBeUndefined();
  const partial: CodeFacts = {...code.facts, symbols: []};
  expect(new TreeText(tree, code.extraction, partial).facts).toBe(partial);
});

test('supplied code retains canonical named and inline route handlers without another source parse', async () => {
  const files = {
    'services/web/main.ts': '// λ\nimport express from "express";function ready(){}export function boot(){const app=express();app.get("/ready",ready);app.get("/live",async()=>ready());}',
    'services/worker/main.go': '// 界\npackage worker\nimport "net/http"\nfunc ready(){}\nfunc boot(){mux:=http.NewServeMux();mux.HandleFunc("GET /ready",func(w http.ResponseWriter,r *http.Request){ready()})}',
  };
  const tree = treeOf(files);
  const code = await extractCodeWithFacts(tree);
  const contracts = await extractContracts(tree, code.extraction);
  const handlers = contracts.edges.filter((edge) => edge.type === 'code.handled-by');
  expect(handlers).toHaveLength(3);
  for (const edge of handlers) {
    expect(code.facts.symbols.some((symbol) => symbol.key === edge.to && symbol.bodySpan !== undefined)).toBe(true);
    expect(contracts.nodes.some((node) => node.key === edge.to)).toBe(false);
  }
  expect(handlers.find((edge) => edge.from === 'code.route:services/web/main.ts#GET:/ready')?.to).toBe('code.symbol:services/web/main.ts#ready');
  const copied = await extractContracts(tree, {...code.extraction});
  expect(copied.edges.filter((edge) => edge.type === 'code.handled-by')).toEqual([]);
});

test('releasing the code facts drops the reader and the indexes with them', async () => {
  const tree = treeOf({'src/release.ts': 'export function released(): number { return 1; }'});
  const code = await extractCodeWithFacts(tree);
  expect(codeFactsOf(code.extraction, tree)).toBe(code.facts);
  releaseCodeFacts(code.extraction);
  expect(codeFactsOf(code.extraction, tree)).toBeUndefined();
});
