import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {extractOperations} from '../src/extract/operations/index.js';
const tree = (files: Record<string, string>) => ({paths: Object.keys(files).sort(), read: (path: string) => new TextEncoder().encode(files[path] ?? '')});
test('metric constructors require actual library identity and updater parameters cannot shadow binding', () => {
 const ex = extractOperations(tree({'services/api/main.ts': `import {Counter, Gauge as Level, Histogram} from "prom-client";
export const requests = new Counter({name:"requests_total"});
export const active = new Level({name:"active"});
export const latency = new Histogram({name:"latency"});
export function update() { requests.inc(); active.set(1); latency.observe(2); }
export function unrelated(requests:any) { requests.inc(); }
export function outer(requests:any) { function inner() { requests.inc(); } inner(); }
`, 'services/api/unrelated.ts': 'class Counter { constructor(options:any) {} } const fake = new Counter({name:"false_total"});'}));
 expect(ex.nodes.filter((node) => node.kind === 'code.metric').map((node) => node.label).sort()).toEqual(['active','latency','requests_total']);
 expect(ex.edges.filter((edge) => edge.type === 'code.updates-metric')).toHaveLength(3);
 expect(ex.edges.some((edge) => edge.type === 'code.updates-metric' && ['#unrelated','#outer'].some((name) => edge.from.endsWith(name)))).toBe(false);
});
test('AsyncAPI channel servers restrict hosts while unspecified servers retain both', () => {
 const ex = extractOperations(tree({'contracts/asyncapi/events.yaml': `asyncapi: 2.6.0
info: {title: Events, version: 1.0.0}
servers:
 A: {url: a:9092, protocol: kafka}
 B: {url: b:9092, protocol: kafka}
channels:
 events:
  servers: [A]
  publish: {message: {name: Changed}}
 unrestricted:
  publish: {message: {name: Changed}}
`}));
 const hosted = ex.edges.filter((edge) => edge.type === 'code.hosts-channel');
 expect(hosted.filter((edge) => edge.to === 'code.channel:events').map((edge) => edge.from)).toEqual(['code.broker:address/a:9092']);
 expect(hosted.filter((edge) => edge.to === 'code.channel:unrestricted')).toHaveLength(2);
});


test('Go Prometheus aliases stay grounded while unrelated constructors and parameter shadows do not', () => {
 const ex = extractOperations(tree({'services/api/metrics.go': readFileSync(new URL('./fixtures/go-prometheus/metrics.go', import.meta.url), 'utf8'), 'services/api/fake.go':'package api\nfunc NewCounter(options any) any { return options }\nvar fake = NewCounter(Opts{Name:"fake_total"})\n'}));
 expect(ex.nodes.filter((node) => node.kind === 'code.metric').map((node) => node.label)).toEqual(['requests_total']);
 expect(ex.edges.filter((edge) => edge.type === 'code.updates-metric').map((edge) => edge.from)).toEqual(['code.symbol:services/api/metrics.go#update']);
});


test('unsupported AsyncAPI membership never silently attaches all brokers', () => {
 const ex = extractOperations(tree({'contracts/asyncapi/events.yaml':'asyncapi: 3.0.0\ninfo: {title: Events, version: 1.0.0}\nservers: {A: {host: "a:9092", protocol: kafka}}\nchannels: {events: {servers: [{"$ref": "#/servers/A"}]}}\n'}));
 expect(ex.edges.filter((edge) => edge.type === 'code.hosts-channel')).toEqual([]);
 expect(ex.gaps.some((gap) => gap.path === 'contracts/asyncapi/events.yaml' && gap.reason.includes('line 1') && gap.reason.includes('unsupported'))).toBe(true);
});
