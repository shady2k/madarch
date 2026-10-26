import { expect, test } from 'bun:test';
import { extractCode, extractOperations } from './extract-code-facts-fixture.js';
import { codeFactsOf } from '../src/extract/code/index.js';
import { structuralHttpRegistrations } from '../src/extract/operations/route-facts.js';
import { TreeText } from '../src/extract/operations/source.js';
import type { TreeReader } from '../src/extract/records.js';
import { metricSemanticModels, validateMetricSemanticModels } from '../src/extract/library-models/metric-semantic-models.js';
const path = 'services/api/main.ts';
const tree = (source: string): TreeReader => ({ paths: [path], read: () => new TextEncoder().encode(source) });
const targets = (result: Awaited<ReturnType<typeof extractOperations>>) => result.edges.filter((edge) => edge.type === 'code.exposes-metric').map((edge) => edge.to);

test('explicit registry list, alias and explicit registration expose only the selected identity', async () => {
  const result = await extractOperations(tree(`import express from 'express';
import { Counter, Registry } from 'prom-client';
const registry = new Registry(); const alias = registry;
const privateRegistry = new Registry();
const one = new Counter({name:'queue_one_total',help:'One',registers:[alias]});
const two = new Counter({name:'queue_two_total',help:'Two',registers:[]});
const secret = new Counter({name:'queue_secret_total',help:'Secret',registers:[privateRegistry]});
alias.registerMetric(two);
const app = express(); app.get('/telemetry', () => registry.metrics());`));
  expect(targets(result)).toEqual([`code.metric:${path}#queue_one_total`, `code.metric:${path}#queue_two_total`]);
  expect(result.nodes.filter((node) => node.kind === 'code.metric')).toHaveLength(3);
  expect(result.nodes.filter((node) => node.kind === 'code.metrics-endpoint')).toHaveLength(1);
  expect(result.edges.filter((edge) => edge.type === 'code.served-by' && edge.properties.role === 'handler').every((edge) => result.nodes.some((node) => node.key === edge.to))).toBe(true);
});

test('registry collection in cache or timer callback does not become HTTP exposure', async () => {
  for (const registration of [
    `cache.get('/telemetry', () => registry.metrics());`,
    `const app = express(); app.get('/telemetry', () => { setTimeout(() => registry.metrics(), 1); });`,
  ]) {
    const result = await extractOperations(tree(`import express from 'express'; import { Counter, Registry } from 'prom-client';
const registry = new Registry(); const count = new Counter({name:'queue_total',help:'Queue',registers:[registry]});
const cache = {get(_key: string, callback: () => unknown) { return callback(); }};
${registration}`));
    expect(targets(result)).toEqual([]);
    expect(result.nodes.filter((node) => node.kind === 'code.metrics-endpoint')).toEqual([]);
  }
});

test('empty explicit list stays private even when the default registry is exposed', async () => {
  const result = await extractOperations(tree(`import express from 'express'; import { Counter, register } from 'prom-client';
const publicCount = new Counter({name:'queue_public_total',help:'Public'});
const privateCount = new Counter({name:'queue_private_total',help:'Private',registers:[]});
const app = express(); app.get('/telemetry', () => register.metrics());`));
  expect(targets(result)).toEqual([`code.metric:${path}#queue_public_total`]);
});


test('modeled aliased fmt literals retain declaration, format arguments and resolved backing writes', async () => {
  const source = `package api
import printer "fmt"
import "io"
type Telemetry struct { count int64 }
func (t *Telemetry) Add() { t.count++ }
func (t *Telemetry) Export(w io.Writer) {
 printer.Fprint(w, "# TYPE queue_events_total counter\\n")
 printer.Fprintf(w, "queue_events_total %d\\n", t.count)
}`;
  const goPath = 'services/api/telemetry.go';
  const input: TreeReader = { paths: [goPath], read: () => new TextEncoder().encode(source) };
  const result = await extractOperations(input);
  const metric = result.nodes.find((node) => node.key === `code.metric:${goPath}#queue_events_total`);
  expect(metric?.properties.definitionFormat).toBe('prometheus-text');
  expect(metric?.properties.backingDeclaration).toBe(`code.symbol:${goPath}#Telemetry.count`);
  expect(typeof metric?.properties.backingOwnerDeclaration).toBe('string');
  expect(typeof metric?.properties.backingTypeExpression).toBe('string');
  expect(metric?.properties.samples).toBeArray();
  expect(result.edges.filter((edge) => edge.type === 'code.updates-metric').map((edge) => edge.from)).toEqual([`code.symbol:${goPath}#Telemetry.Add`]);
  expect(result.edges.filter((edge) => edge.type === 'code.exposes-metric')).toEqual([]);
  expect(result.gaps.some((gap) => gap.path === goPath && gap.reason.includes('HTTP exposure is withheld'))).toBe(true);
});

test('local fmt-shaped receiver and string-held exposition do not claim library provenance', async () => {
  const source = `package api
import "io"
type Printer struct{}
func (Printer) Fprint(w io.Writer, s string) {}
func (Printer) Fprintf(w io.Writer, s string, n int) {}
func export(w io.Writer) { printer := Printer{}; printer.Fprint(w, "# TYPE decoy_total counter\\n"); printer.Fprintf(w, "decoy_total %d\\n", 1) }`;
  const input: TreeReader = { paths: ['services/api/telemetry.go'], read: () => new TextEncoder().encode(source) };
  const result = await extractOperations(input);
  expect(result.nodes.filter((node) => node.kind === 'code.metric')).toEqual([]);
});

const goTree = (source: string): TreeReader => ({ paths: ['services/api/telemetry.go'], read: () => new TextEncoder().encode(source) });
const goMetric = 'code.metric:services/api/telemetry.go#work_items_total';

test('registered typed HTTP object handler exposes a typed atomic observation and its modeled mutations', async () => {
  const input = goTree(`package api
import printer "fmt"
import web "net/http"
import cell "sync/atomic"
type Collector struct { count cell.Int64 }
func (c *Collector) Increase() { c.count.Add(1) }
func (c *Collector) Reset() { c.count.Store(0) }
func (c *Collector) Observe() int64 { return c.count.Load() }
func (c *Collector) ServeHTTP(w web.ResponseWriter, r *web.Request) {
 printer.Fprint(w, "# TYPE work_items_total counter\\n")
 printer.Fprintf(w, "work_items_total %d\\n", c.count.Load())
}
func Register() { mux := web.NewServeMux(); mux.Handle("/inspect", &Collector{}) }`);
  const code = await extractCode(input);
  const facts = codeFactsOf(code, input);
  const result = await extractOperations(input, code);
  const metric = result.nodes.find((node) => node.key === goMetric);
  expect(metric?.properties.backingDeclaration).toBe('code.symbol:services/api/telemetry.go#Collector.count');
  expect(metric?.properties.backingTypeExpression).toBeString();
  expect(metric?.properties.definitionFormat).toBe('prometheus-text');
  expect(result.edges.filter((edge) => edge.type === 'code.updates-metric' && edge.to === goMetric).map((edge) => edge.from)).toEqual([
    'code.symbol:services/api/telemetry.go#Collector.Increase', 'code.symbol:services/api/telemetry.go#Collector.Reset',
  ]);
  const updates = result.edges.filter((edge) => edge.type === 'code.updates-metric' && edge.to === goMetric);
  expect(updates.every((edge) => edge.properties.receiverModel === 'go.atomic.int64')).toBe(true);
  const endpoint = result.nodes.find((node) => node.key === 'code.metrics-endpoint:services/api/telemetry.go#Collector');
  const diagnostics = JSON.stringify({ facts, registrations: structuralHttpRegistrations(new TreeText(input, code, facts)),
    gaps: result.gaps, nodes: result.nodes, edges: result.edges }, null, 2);
  expect(endpoint?.properties.path, diagnostics).toBe('/inspect');
  expect(facts?.expressions.find((expression) => expression.syntaxKind === 'unary_expression')?.operator, diagnostics).toBe('&');
  expect(endpoint?.properties.handler).toBe('code.symbol:services/api/telemetry.go#Collector.ServeHTTP');
  expect(endpoint?.properties.counters).toEqual(['work_items_total']);
  expect(targets(result)).toEqual([goMetric]);
  expect(result.edges.filter((edge) => edge.type === 'code.served-by' && edge.properties.role === 'handler').map((edge) => edge.to))
    .toContain('code.symbol:services/api/telemetry.go#Collector.ServeHTTP');
});

test('atomic-shaped local methods and nested scalar arguments do not prove backing observations', async () => {
  for (const sample of ['c.count.Load()', 'identity(c.scalar)']) {
    const result = await extractOperations(goTree(`package api
import "fmt"
import "net/http"
type Cell struct { value int64 }
func (c *Cell) Add(n int64) { c.value += n }
func (c *Cell) Load() int64 { return c.value }
type Collector struct { count Cell; scalar int64 }
func identity(n int64) int64 { return 0 }
func (c *Collector) Increase() { c.count.Add(1); c.scalar++ }
func (c *Collector) Export(w http.ResponseWriter, r *http.Request) {
 fmt.Fprintf(w, "# TYPE work_items_total counter\\nwork_items_total %d\\n", ${sample})
}
func Register() { mux := http.NewServeMux(); c := &Collector{}; mux.HandleFunc("/inspect", c.Export) }`));
    expect(result.nodes.find((node) => node.key === goMetric)?.properties.backingDeclaration).toBeUndefined();
    expect(result.edges.filter((edge) => edge.type === 'code.updates-metric' && edge.to === goMetric)).toEqual([]);
    expect(targets(result)).toEqual([]);
    expect(result.gaps.some((gap) => gap.reason.includes('sample value has no unique resolved backing declaration'))).toBe(true);
  }
});

test('unregistered text, timer text and a different writer stay private despite genuine atomic type', async () => {
  for (const body of [
    `func (c *Collector) Export(w web.ResponseWriter, r *web.Request) {
 printer.Fprintf(w, "# TYPE work_items_total counter\\nwork_items_total %d\\n", c.count.Load())
}
func Register() {}`,
    `func (c *Collector) Export(w web.ResponseWriter, r *web.Request) {
 later := func() { printer.Fprintf(w, "# TYPE work_items_total counter\\nwork_items_total %d\\n", c.count.Load()) }; later()
}
func Register() { mux := web.NewServeMux(); c := &Collector{}; mux.HandleFunc("/inspect", c.Export) }`,
    `func (c *Collector) Export(w web.ResponseWriter, r *web.Request) {
 var destination io.Writer
 printer.Fprintf(destination, "# TYPE work_items_total counter\\nwork_items_total %d\\n", c.count.Load())
}
func Register() { mux := web.NewServeMux(); c := &Collector{}; mux.HandleFunc("/inspect", c.Export) }`,
  ]) {
    const result = await extractOperations(goTree(`package api
import printer "fmt"
import web "net/http"
import cell "sync/atomic"
import "io"
type Collector struct { count cell.Int64 }
func (c *Collector) Increase() { c.count.Add(1) }
${body}`));
    expect(result.nodes.filter((node) => node.kind === 'code.metrics-endpoint')).toEqual([]);
    expect(targets(result)).toEqual([]);
  }
});

test('TYPE and sample on distinct parameter writers do not form one exposition family', async () => {
  const result = await extractOperations(goTree(`package api
import "fmt"
import "net/http"
import "sync/atomic"
type Collector struct { count atomic.Int64 }
func (c *Collector) Increase() { c.count.Add(1) }
func (c *Collector) Export(w http.ResponseWriter, other http.ResponseWriter) {
 fmt.Fprint(w, "# TYPE work_items_total counter\\n")
 fmt.Fprintf(other, "work_items_total %d\\n", c.count.Load())
}`));
  expect(result.nodes.filter((node) => node.kind === 'code.metric')).toEqual([]);
  expect(result.edges.filter((edge) => edge.type === 'code.updates-metric')).toEqual([]);
  expect(targets(result)).toEqual([]);
});

test('atomic aliases and generic type parameters do not borrow external cell semantics', async () => {
  for (const [declaration, receiver] of [
    ['type Cell = atomic.Int64\ntype Collector struct { count Cell }', '*Collector'],
    ['type Collector[Cell any] struct { count Cell }', '*Collector[Cell]'],
  ]) {
    const result = await extractOperations(goTree(`package api
import "fmt"
import "io"
import "sync/atomic"
${declaration}
func (c ${receiver}) Increase() { c.count.Add(1) }
func (c ${receiver}) Export(w io.Writer) {
 fmt.Fprintf(w, "# TYPE work_items_total counter\\nwork_items_total %d\\n", c.count.Load())
}`));
    expect(result.nodes.find((node) => node.key === goMetric)?.properties.backingDeclaration).toBeUndefined();
    expect(result.edges.filter((edge) => edge.type === 'code.updates-metric' && edge.to === goMetric)).toEqual([]);
    expect(targets(result)).toEqual([]);
  }
});

test('a genuine cell read is not an update and wrong-arity or opaque cell calls are not mutations', async () => {
  const result = await extractOperations(goTree(`package api
import "fmt"
import "io"
import "sync/atomic"
type Collector struct { count atomic.Int64 }
func (c *Collector) Observe() int64 { return c.count.Load() }
func (c *Collector) Invalid() { c.count.Add(); c.count.Unknown(1) }
func (c *Collector) Export(w io.Writer) {
 fmt.Fprintf(w, "# TYPE work_items_total counter\\nwork_items_total %d\\n", c.count.Load())
}`));
  expect(result.nodes.find((node) => node.key === goMetric)?.properties.backingDeclaration).toBe('code.symbol:services/api/telemetry.go#Collector.count');
  expect(result.edges.filter((edge) => edge.type === 'code.updates-metric' && edge.to === goMetric)).toEqual([]);
  expect(targets(result)).toEqual([]);
  expect(result.gaps.some((gap) => gap.reason.includes('backing declaration has no resolved write effect'))).toBe(true);
});

test('metric receiver semantics use a closed immutable data vocabulary', () => {
  const model = metricSemanticModels.find((entry) => entry.role === 'metric-cell')!;
  expect(Object.isFrozen(metricSemanticModels)).toBe(true);
  expect(Object.isFrozen(model)).toBe(true);
  const registry = (entry: unknown) => ({ schemaVersion: 1, models: [entry] });
  expect(() => validateMetricSemanticModels(registry({ ...model, evaluate: 'arbitrary' }))).toThrow('unknown field');
  expect(() => validateMetricSemanticModels(registry({ ...model, ecosystem: 'unknown' }))).toThrow('unsupported ecosystem');
  expect(() => validateMetricSemanticModels(registry({ ...model, role: 'unknown' }))).toThrow('unknown role');
  expect(() => validateMetricSemanticModels(registry({ ...model, writes: [{ member: 'Change', arguments: -1 }] }))).toThrow('invalid argument count');
  expect(() => validateMetricSemanticModels({ schemaVersion: 1, models: [model, model] })).toThrow('duplicate selector');
});

test('a registered named handler keeps its actual callable endpoint key', async () => {
  const result = await extractOperations(goTree(`package api
import "fmt"
import "net/http"
import "sync/atomic"
type Totals struct { count atomic.Int64 }
var totals Totals
func Increase() { totals.count.Add(1) }
func Publish(w http.ResponseWriter, r *http.Request) {
 fmt.Fprintf(w, "# TYPE work_items_total counter\\nwork_items_total %d\\n", totals.count.Load())
}
func Register() { http.HandleFunc("/inspect", Publish) }`));
  const endpoint = result.nodes.find((node) => node.key === 'code.metrics-endpoint:services/api/telemetry.go#Publish');
  expect(endpoint?.properties.counters).toEqual(['work_items_total']);
  expect(targets(result)).toEqual([goMetric]);
  expect(result.edges.filter((edge) => edge.type === 'code.updates-metric' && edge.to === goMetric).map((edge) => edge.from))
    .toEqual(['code.symbol:services/api/telemetry.go#Increase']);
});

test('indexed map samples keep the direct map declaration and exact index evidence', async () => {
  const input = goTree(`package api
import "fmt"
import "io"
type Collector struct { counts map[string]int64; category string }
func (c *Collector) Increase() { c.counts[c.category]++ }
func (c *Collector) Export(w io.Writer) {
 fmt.Fprintf(w, "# TYPE work_items_total counter\\nwork_items_total %d\\n", c.counts[c.category])
}`);
  const code = await extractCode(input);
  const facts = codeFactsOf(code, input)!;
  const result = await extractOperations(input, code);
  const metric = result.nodes.find((node) => node.key === goMetric);
  expect(metric?.properties.backingDeclaration).toBe('code.symbol:services/api/telemetry.go#Collector.counts');
  expect(result.edges.filter((edge) => edge.type === 'code.updates-metric' && edge.to === goMetric).map((edge) => edge.from))
    .toEqual(['code.symbol:services/api/telemetry.go#Collector.Increase']);
  const samples = metric?.properties.samples as { valueExpression: string; valueSpan: unknown; indexedBaseDeclaration: string;
    indexExpression: string; indexSpan: unknown; indexKeyExpression: string; indexKeySpan: unknown }[];
  expect(samples).toHaveLength(1);
  expect(samples[0]?.indexedBaseDeclaration).toBe('code.symbol:services/api/telemetry.go#Collector.counts');
  expect(samples[0]?.indexExpression).toBe(samples[0]?.valueExpression);
  expect(samples[0]?.indexSpan).toEqual(samples[0]?.valueSpan);
  expect(samples[0]?.indexKeyExpression).toBeString();
  expect(samples[0]?.indexKeySpan).toBeDefined();
  const increase = 'code.symbol:services/api/telemetry.go#Collector.Increase';
  const backingSites = facts.sites.filter((site) => site.holder === increase && site.to === 'code.symbol:services/api/telemetry.go#Collector.counts');
  expect(backingSites).toHaveLength(1);
  expect(backingSites[0]?.roles).toEqual(['read-access', 'write-access']);
  const keySites = facts.sites.filter((site) => site.holder === increase && site.to === 'code.symbol:services/api/telemetry.go#Collector.category');
  expect(keySites).toHaveLength(1);
  expect(keySites[0]?.roles).toEqual(['read-access']);
  const keyExpression = facts.expressions.find((expression) => expression.id === samples[0]?.indexKeyExpression);
  expect(keyExpression?.syntaxKind).toBe('selector_expression');
  expect(keyExpression?.member).toBe('category');
  expect(samples[0]?.indexKeySpan).toEqual(keyExpression?.span);
  expect(samples[0]?.valueSpan).not.toEqual(keyExpression?.span);
  expect(metric?.properties.backingDeclaration).not.toBe('code.symbol:services/api/telemetry.go#Collector.category');
  expect(targets(result)).toEqual([]);
});

test('incrementing a map element does not update the declaration read by its key', async () => {
  const result = await extractOperations(goTree(`package api
import "fmt"
import "io"
type Collector struct { counts map[int64]int64; category int64 }
func (c *Collector) Increase() { c.counts[c.category]++ }
func (c *Collector) Export(w io.Writer) {
 fmt.Fprintf(w, "# TYPE work_items_total counter\\nwork_items_total %d\\n", c.category)
}`));
  const metric = result.nodes.find((node) => node.key === goMetric);
  expect(metric?.properties.backingDeclaration).toBe('code.symbol:services/api/telemetry.go#Collector.category');
  expect(result.edges.filter((edge) => edge.type === 'code.updates-metric' && edge.to === goMetric)).toEqual([]);
  expect(result.gaps.some((gap) => gap.reason.includes('backing declaration has no resolved write effect'))).toBe(true);
  expect(targets(result)).toEqual([]);
});

test('indexing a slice or a named map type does not borrow direct map backing proof', async () => {
  for (const type of ['[]int64', 'Counts']) {
    const result = await extractOperations(goTree(`package api
import "fmt"
import "io"
type Counts map[int]int64
type Collector struct { counts ${type}; position int }
func (c *Collector) Increase() { c.counts[c.position]++ }
func (c *Collector) Export(w io.Writer) {
 fmt.Fprintf(w, "# TYPE work_items_total counter\\nwork_items_total %d\\n", c.counts[c.position])
}`));
    expect(result.nodes.find((node) => node.key === goMetric)?.properties.backingDeclaration).toBeUndefined();
    expect(result.edges.filter((edge) => edge.type === 'code.updates-metric' && edge.to === goMetric)).toEqual([]);
    expect(targets(result)).toEqual([]);
    expect(result.gaps.some((gap) => gap.reason.includes('sample value has no unique resolved backing declaration'))).toBe(true);
  }
});
