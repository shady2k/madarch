import { expect, test } from 'bun:test';
import { extractOperations } from './extract-code-facts-fixture.js';
import type { TreeReader } from '../src/extract/records.js';
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
