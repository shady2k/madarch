import {describe, expect, test} from 'bun:test';
import {extractOperations} from '../src/extract/operations/index.js';
import {endpointRelations} from '../src/extract/driver/relationships.js';
import type {Extraction, TreeReader} from '../src/extract/records.js';
const tree = (files: Record<string, string>): TreeReader => ({paths: Object.keys(files).sort(), read: (path) => new TextEncoder().encode(files[path] ?? '')});
const fixture = {
 'services/api/package.json': '{"name":"api","dependencies":{"prom-client":"1.0.0","pino":"2.0.0"}}',
 'services/api/src/metrics.ts': `import {Counter, Gauge, Histogram} from "prom-client";
export const requests = new Counter({name: "requests_total", labelNames: ["status"]});
export const active = new Gauge({name: "active"});
export const latency = new Histogram({name: "latency", labelNames: ["method"]});
export function run() { requests.inc(); active.set(1); latency.observe(2); }
`,
 'services/api/src/logger.ts': 'import pino from "pino";\nexport const logger = pino();\n',
 'services/api/src/main.ts': `import {logger as log} from "./logger.js";
export function run() { log.info("ready"); }
export function shadow(log: any) { log.info("not ours"); }
`,
 'docker-compose.yml': `services:
  api:
    image: api:1
    environment:
      KAFKA_BROKERS: kafka:9092
    healthcheck:
      test: ["CMD", "curl", "http://localhost:8080/healthz"]
      interval: 5s
      timeout: 2s
      retries: 4
      start_period: 10s
  kafka:
    image: apache/kafka:3.9.0
`,
 'contracts/asyncapi/events.yaml': `asyncapi: 2.6.0
info: {title: Events, version: 1.0.0}
servers:
  local: {url: kafka:9092, protocol: kafka}
channels:
  events:
    publish: {message: {name: Changed}}
`,
 'deploy/k8s/api.yaml': `apiVersion: apps/v1
kind: Deployment
metadata: {name: api}
spec:
  template:
    spec:
      containers:
        - name: api
          image: api:1
          ports:
            - {name: web, containerPort: 8080}
          readinessProbe:
            httpGet: {path: /healthz, port: 8080}
            periodSeconds: 5
            timeoutSeconds: 2
          livenessProbe:
            httpGet: {path: /healthz, port: web}
            periodSeconds: 10
            failureThreshold: 3
          startupProbe:
            httpGet: {path: /healthz, port: 8080}
            periodSeconds: 2
            failureThreshold: 30
`,
};
describe('madarch-m38l.20 operations truth', () => {
 test('three-independent-probes-and-compose-healthcheck: settings and precise declaration spans survive', () => {
  const ex = extractOperations(tree(fixture));
  const probes = ex.nodes.filter((node) => node.kind === 'code.probe');
  expect(probes.map((node) => node.properties.probeType)).toEqual(['livenessProbe', 'readinessProbe', 'startupProbe']);
  expect(probes.map((node) => node.properties.periodSeconds)).toEqual([10, 5, 2]);
  expect(probes[0]?.properties.port).toBe('web');
  expect(new Set(probes.map((node) => node.span?.lineStart)).size).toBe(3);
  const health = ex.nodes.find((node) => node.kind === 'code.healthcheck');
  expect(health?.properties.interval).toBe('5s'); expect(health?.properties.retries).toBe(4);
  for (const node of [...probes, health!]) expect(ex.edges.some((edge) => edge.type === 'code.contains' && edge.from === `code.file:${node.span?.path}` && edge.to === node.key)).toBe(true);
 });
 test('metric-counter-gauge-histogram: each typed definition has labels and a function updater', () => {
  const ex = extractOperations(tree(fixture));
  const metrics = ex.nodes.filter((node) => node.kind === 'code.metric');
  expect(metrics.map((node) => node.properties.metricType)).toEqual(['gauge', 'histogram', 'counter']);
  expect(metrics.find((node) => node.label === 'requests_total')?.properties.labels).toEqual(['status']);
  for (const node of metrics) expect(ex.edges.some((edge) => edge.type === 'code.updates-metric' && edge.from === 'code.symbol:services/api/src/metrics.ts#run' && edge.to === node.key)).toBe(true);
 });
 test('logger-import-alias-users: real using file and function, not a shadowed argument', () => {
  const ex = extractOperations(tree(fixture));
  const uses = ex.edges.filter((edge) => edge.type === 'code.uses-logger');
  expect(uses.some((edge) => edge.to === 'code.file:services/api/src/main.ts')).toBe(true);
  expect(uses.some((edge) => edge.to === 'code.symbol:services/api/src/main.ts#run')).toBe(true);
  expect(uses.some((edge) => edge.to.endsWith('#shadow'))).toBe(false);
 });
 test('grounded-broker: compose instance joins actual address setting, connecting service and AsyncAPI channels', () => {
  const ex = extractOperations(tree(fixture)); const broker = ex.nodes.find((node) => node.kind === 'code.broker');
  expect(ex.nodes.filter((node) => node.kind === 'code.broker')).toHaveLength(1);
  expect(broker?.properties.source).toBe('compose');
  for (const type of ['code.configured-by', 'code.connects-to', 'code.hosts-channel']) expect(ex.edges.some((edge) => edge.type === type && (edge.from === broker?.key || edge.to === broker?.key)), type).toBe(true);
  expect(ex.nodes.filter((node) => node.kind === 'code.broker').every((node) => node.span !== undefined)).toBe(true);
 });
 test('probe-to-serving-route: joins by service and method, never by path alone', () => {
  const ex = extractOperations(tree(fixture));
  const contracts: Extraction = {producer: 'code.extract.contracts', nodes: [{key: 'code.route:api', kind: 'code.route', label: 'GET /healthz', properties: {service: 'api', path: '/healthz', method: 'GET', ports: ['8080']}}, {key: 'code.route:other', kind: 'code.route', label: 'GET /healthz', properties: {service: 'other', path: '/healthz', method: 'GET'}}], edges: [], gaps: []};
  const linked = endpointRelations([ex, contracts]);
  const probes = linked.flatMap((entry) => entry.edges).filter((edge) => edge.type === 'code.probes' && edge.discriminator === 'route');
  expect(probes).toHaveLength(4); expect(probes.every((edge) => edge.to === 'code.route:api')).toBe(true);
 });
});

test('recipe and README file references retain their exact declaring source blocks',()=>{
 const files={'README.md':'é\n## Run it\n1. `cat scripts/seed.sql`\n   to prepare the database.\n\nCommon failure: "busy"; remove scripts/seed.sql\nthen retry.\n','Makefile':'seed:\n\tcat scripts/seed.sql\n','scripts/seed.sql':'select 1;\n'};
 const input=tree(files);const ex=extractOperations(input);const edges=ex.edges.filter((edge)=>edge.type==='code.references'&&edge.to==='code.file:scripts/seed.sql');expect(edges).toHaveLength(3);
 for(const edge of edges){const node=ex.nodes.find((node)=>node.key===edge.from);expect(edge.span).toEqual(node?.span);const span=edge.span!;const bytes=input.read(span.path).subarray(span.byteStart,span.byteEnd);expect(new TextDecoder('utf-8',{fatal:true}).decode(bytes)).toContain('scripts/seed.sql');}
 expect(edges.map((edge)=>[edge.span?.path,edge.span?.lineStart,edge.span?.lineEnd]).sort()).toEqual([['Makefile',1,2],['README.md',3,4],['README.md',6,7]].sort());
});
