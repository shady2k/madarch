import { expect, test } from 'bun:test';
import { extractCodeWithFacts } from '../src/extract/code/index.js';
import { evaluateLibraryModels } from '../src/extract/library-models/evaluate.js';
import { extractOperations } from '../src/extract/operations/index.js';
import type { CodeFacts } from '../src/extract/code/facts.js';
import type { TreeReader } from '../src/extract/records.js';

function treeOf(files: Readonly<Record<string, string>>): TreeReader {
  return { paths: Object.keys(files).sort(), read(path) {
    const source = files[path];
    if (source === undefined) throw new Error(`missing fixture ${path}`);
    return new TextEncoder().encode(source);
  } };
}

const manifest = JSON.stringify({ name: 'boundary-unit', dependencies: { pino: '9.0.0' } });

test('shadowed destructured factory has a located gap without borrowing the outer logger', async () => {
  const path = 'units/worker.ts';
  const source = [
    'import createLog from "pino";',
    'const audit = createLog();',
    'export function hidden(input: {createLog(): number}) { const {createLog}=input; return createLog(); }',
    'export function unrelated(input: {run(): void}) { input.run(); }',
    'export function ready() { audit.info("ready"); }',
  ].join('\n');
  const code = await extractCodeWithFacts(treeOf({ 'package.json': manifest, [path]: source }));
  const result = evaluateLibraryModels(code.facts);
  expect(result.effects.filter((effect) => effect.kind === 'logger-declare')).toHaveLength(1);
  expect(result.effects.filter((effect) => effect.kind === 'logger-use').map((effect) => effect.holder)).toEqual([`code.symbol:${path}#ready`]);
  expect(result.gaps.some((gap) => gap.path === path && gap.reason.includes('line 3') && gap.reason.includes('logger factory'))).toBe(true);
  const unrelated = code.facts.symbols.find((symbol) => symbol.qualifiedName === 'unrelated')!;
  expect(result.diagnostics.filter((entry) => entry.path === path && unrelated.span.byteStart <= entry.span.byteStart && entry.span.byteEnd <= unrelated.span.byteEnd)).toEqual([]);
});

test('local assignment retains declaration proof but blocks stale factory identity with a located reason', async () => {
  const path = 'units/audit.ts';
  const code = await extractCodeWithFacts(treeOf({ 'package.json': manifest, [path]: [
    'import createLog from "pino";',
    'let audit = createLog();',
    'audit = replacement;',
    'export function ready() { audit.info("not proved"); }',
  ].join('\n') }));
  const binding = code.facts.bindings.find((entry) => entry.name === 'audit' && entry.kind === 'local');
  expect(binding?.initializer).toBeDefined();
  const result = evaluateLibraryModels(code.facts);
  expect(result.effects.filter((effect) => effect.kind === 'logger-use')).toEqual([]);
  expect(result.diagnostics.some((entry) => entry.path === path && entry.span.lineStart === 4 && entry.reason.includes('reassigned'))).toBe(true);
});

test('writes through imported aliases poison re-exported live bindings and retain diagnostics', async () => {
  const tree = treeOf({
    'package.json': manifest,
    'units/declaration.ts': 'import createLog from "pino";export const audit=createLog();',
    'units/public.ts': 'export {audit as published} from "./declaration.js";',
    'units/change.ts': 'import {published as current} from "./public.js";current.info=replacement;',
    'units/use.ts': 'import {published as current} from "./public.js";export function ready(){current.info("unproved");}',
  });
  const code = await extractCodeWithFacts(tree);
  const result = extractOperations(tree, code.extraction, code.facts);
  expect(result.edges.filter((edge) => edge.type === 'code.uses-logger')).toEqual([]);
  expect(result.gaps.some((gap) => gap.path === 'units/use.ts' && gap.reason.includes('reassigned'))).toBe(true);
});

test('external Go struct proof conflicts always retain a located diagnostic', async () => {
  const path = 'units/metric.go';
  const { facts } = await extractCodeWithFacts(treeOf({ [path]: [
    'package sample',
    'import telemetry "github.com/prometheus/client_golang/prometheus"',
    'var completed = telemetry.NewCounter(telemetry.CounterOpts{Name:"completed_total"})',
  ].join('\n') }));
  const imported = facts.imports[0]!;
  const binding = facts.bindings.find((entry) => entry.kind === 'import')!;
  const qualified = facts.expressions.find((entry) => entry.syntaxKind === 'qualified_type')!;
  expect(evaluateLibraryModels(facts).effects.filter((effect) => effect.kind === 'metric-declare')).toHaveLength(1);
  const variants: readonly CodeFacts[] = [
    { ...facts, bindings: [...facts.bindings, { ...binding, id: `${binding.id}:conflict` }] },
    { ...facts, imports: [{ ...imported, targetExpression: 'unproved-internal' }] },
    { ...facts, imports: [{ ...imported, targetChain: [] }] },
    { ...facts, imports: [{ ...imported, span: { ...imported.span, byteStart: imported.span.byteStart + 1 } }] },
    { ...facts, imports: [{ ...imported, package: { ecosystem: 'go', name: 'example.test/other', manifestPath: 'go.mod', declaredVersion: 'v1' } }] },
    { ...facts, expressions: facts.expressions.map((entry) => entry.id === qualified.id ? { ...entry, member: 'DifferentOpts' } : entry) },
  ];
  for (const variant of variants) {
    const result = evaluateLibraryModels(variant);
    expect(result.effects.filter((effect) => effect.kind === 'metric-declare')).toEqual([]);
    expect(result.diagnostics.some((entry) => entry.path === path && entry.span.lineStart > 0)).toBe(true);
  }
});

for (const alias of ['', 'chosen ']) test(`Go namespace comes from the declared package, preserving explicit alias ${alias || '(implicit)'}`, async () => {
  const local = alias === '' ? 'gateway' : 'chosen';
  const path = 'cmd/start/main.go';
  const code = await extractCodeWithFacts(treeOf({
    'go.mod': 'module example.test/unit\n',
    'components/transport/handler.go': 'package gateway\ntype Handler struct{}\nfunc New() *Handler{return &Handler{}}\nfunc(h *Handler) Routes() int{return 1}',
    [path]: `package main\nimport ${alias}"example.test/unit/components/transport"\nfunc main(){handler:=${local}.New();handler.Routes()}`,
  }));
  expect(code.facts.imports.find((entry) => entry.path === path)?.local).toBe(local);
  expect(code.facts.sites.filter((site) => site.path === path && site.use === 'call').map((site) => site.to)).toEqual(expect.arrayContaining([
    'code.symbol:components/transport/handler.go#New',
    'code.symbol:components/transport/handler.go#Handler.Routes',
  ]));
});

test('conflicting internal Go package clauses cannot prove a namespace or constructor target', async () => {
  const path = 'cmd/start/main.go';
  const code = await extractCodeWithFacts(treeOf({
    'go.mod': 'module example.test/unit\n',
    'components/transport/one.go': 'package first\nfunc New() int{return 1}',
    'components/transport/two.go': 'package second\nfunc Other() int{return 2}',
    [path]: 'package main\nimport "example.test/unit/components/transport"\nfunc main(){first.New()}',
  }));
  expect(code.facts.sites.filter((site) => site.path === path && site.use === 'call')).toEqual([]);
  expect(code.facts.gaps.some((gap) => gap.path === path)).toBe(true);
});

test('ordinary Go exports, typed repository methods and dynamic indexing are not unread library calls', async () => {
  const path = 'units/ordinary.go';
  const code = await extractCodeWithFacts(treeOf({ [path]: [
    'package sample',
    'import "fmt"',
    'type Reader interface{With(string) int}',
    'func Run(reader Reader, values map[string]int, key string) int {fmt.Errorf("ordinary");reader.With(key);return values[key]}',
  ].join('\n') }));
  const result = evaluateLibraryModels(code.facts);
  expect(result.diagnostics.filter((entry) => entry.code === 'unknown-origin' || entry.code === 'dynamic-member')).toEqual([]);
  expect(code.facts.gaps.filter((gap) => gap.reason.includes('computed member identity'))).toEqual([]);
});
