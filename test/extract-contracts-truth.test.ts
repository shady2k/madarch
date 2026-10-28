import {describe, expect, test} from 'bun:test';
import {extractContracts} from '../src/extract/contracts/index.js';
import {extractCode} from '../src/extract/code/index.js';
import type {TreeReader} from '../src/extract/records.js';
const tree = (files: Record<string, string>): TreeReader => ({paths: Object.keys(files).sort(), read: (path) => new TextEncoder().encode(files[path] ?? '')});
const openapi = (service: string, port: number) => `openapi: 3.0.0
info: {title: API, version: 1.0.0}
servers: [{url: "http://${service}:${port}"}]
paths:
  /healthz:
    get: {operationId: health}
`;
describe('madarch-m38l.20 contracts truth', () => {
 test('server-scoped-health-operations: duplicated paths resolve to each own service and named handler reference', async () => {
  const input = tree({
   'contracts/openapi/a.yaml': openapi('a', 8080), 'contracts/openapi/b.yaml': openapi('b', 8081),
   'services/a/package.json': '{"name":"a"}', 'services/b/package.json': '{"name":"b"}',
   'services/a/main.ts': 'import express from "express";\nfunction health(req: any, res: any) { res.send("ok"); }\nfunction start() { const app = express(); app.get("/healthz", health); app.listen(8080); }',
   'services/b/main.ts': 'import express from "express";\nfunction health(req: any, res: any) { res.send("ok"); }\nfunction start() { const app = express(); app.get("/healthz", health); app.listen(8081); }',
  });
  const code = await extractCode(input); const ex = await extractContracts(input, code);
  for (const service of ['a', 'b']) {
   const route = `code.route:services/${service}/main.ts#GET:/healthz`;
   expect(ex.edges.some((edge) => edge.type === 'code.serves' && edge.from === route && edge.to === `code.operation:contracts/openapi/${service}.yaml#GET:/healthz`)).toBe(true);
   expect(ex.edges.some((edge) => edge.type === 'code.handled-by' && edge.from === route && edge.to === `code.symbol:services/${service}/main.ts#health`)).toBe(true);
   expect(code.edges.some((edge) => edge.type === 'code.calls' && edge.from === `code.symbol:services/${service}/main.ts#start` && edge.to.endsWith('#health'))).toBe(false);
  }
 });
 test('inline-handler-remote-chain: a registered callback owns its remote call and its registration remains a reference', async () => {
  const input = tree({
   'services/gateway/main.ts': 'import express from "express";\nexport function start() { const app = express(); app.get("/check", async (req: any, res: any) => { const reply = await fetch("http://api:8080/healthz"); res.send(reply); }); }',
   'services/api/main.ts': 'import express from "express";\nfunction health(req: any, res: any) { res.send("ok"); }\nfunction start() { const app = express(); app.get("/healthz", health); app.listen(8080); }',
   'contracts/openapi/api.yaml': openapi('api', 8080),
  });
  const code = await extractCode(input); const ex = await extractContracts(input, code); const route = ex.nodes.find((node) => node.kind === 'code.route' && node.properties.path === '/check');
  const handler = ex.edges.find((edge) => edge.type === 'code.handled-by' && edge.from === route?.key)?.to;
  expect(handler).toBeDefined(); expect(code.nodes.find((node) => node.key === handler)?.properties.inline).toBe(true);
  expect(ex.nodes.some((node) => node.key === handler)).toBe(false);
  expect(ex.edges.some((edge) => edge.type === 'code.calls-remote' && edge.from === handler && edge.to === 'code.operation:contracts/openapi/api.yaml#GET:/healthz')).toBe(true);
  expect(ex.edges.some((edge) => edge.type === 'code.references' && edge.to === handler)).toBe(true);
 });
 test('channel-with-no-consumer: explicitly not found in product, publishers are function symbols', async () => {
  const input = tree({
   'contracts/asyncapi/events.yaml': 'asyncapi: 2.6.0\ninfo: {title: Events, version: 1.0.0}\nchannels:\n  events:\n    publish:\n      message: {name: Changed}\n',
   'services/api/main.ts': 'import type { Producer } from "kafkajs";\nexport async function publish(producer: Producer) { await producer.send({topic: "events", messages: [{value: "changed"}]}); }',
  });
  const ex = await extractContracts(input);
  expect(ex.nodes.find((node) => node.key === 'code.channel:events')?.properties.consumerStatus).toBe('not-found-in-product');
  const published = ex.edges.find((edge) => edge.type === 'code.publishes' && edge.from === 'code.symbol:services/api/main.ts#publish' && edge.to === 'code.channel:events');
  expect(published).toBeDefined();
  expect(published?.span?.path).toBe('services/api/main.ts');
  const source = new TextDecoder().decode(input.read('services/api/main.ts'));
  const span = published?.span;
  if (span === undefined) throw new Error(`${import.meta.path}:53: publisher has no source span in services/api/main.ts`);
  expect(source.slice(span.byteStart, span.byteEnd)).toBe('producer.send({topic: "events", messages: [{value: "changed"}]})');
 });
 test('arbitrary-get-is-not-an-http-route-and-topic-objects-are-not-publishers', async () => {
  const input = tree({
   'contracts/asyncapi/events.yaml': 'asyncapi: 2.6.0\ninfo: {title: Events, version: 1.0.0}\nchannels:\n  events:\n    publish:\n      message: {name: Changed}\n',
   'services/api/main.ts': 'export function read(cache: any, queue: any, res: any) { cache.get("/healthz", () => 1); queue.send({topic: "events"}); res.send("events"); res.send({topic: "events", messages: []}); const note = {topic: "events", messages: []}; return note; }',
  });
  const ex = await extractContracts(input);
  expect(ex.nodes.filter((node) => node.kind === 'code.route')).toEqual([]);
  expect(ex.edges.filter((edge) => edge.type === 'code.publishes')).toEqual([]);
  expect(ex.gaps.filter((gap) => gap.reason.includes('receiver'))).toEqual([]);
 });

 test('messaging-receiver-scope-matrix: actual imported types, fields and wrapper delegation only', async () => {
  const contract = 'asyncapi: 2.6.0\ninfo: {title: Events, version: 1.0.0}\nchannels:\n  events:\n    publish:\n      message: {name: Changed}\n';
  const positive = [
   'import type {Producer} from "kafkajs"; export function publish(p: Producer) { p.send({topic:"events",messages:[]}); }',
   'import type {Producer as EventProducer} from "kafkajs"; export function publish(p: EventProducer) { p.send({topic:"events",messages:[]}); }',
   'import type {Producer} from "kafkajs"; export class Publisher { constructor(private readonly p: Producer) {} publish() { this.p.send({topic:"events",messages:[]}); } }',
   `import {Kafka, Producer} from "kafkajs";
interface EventSink { send(topic:string,key:string,value:string):Promise<void>; }
class KafkaSink implements EventSink {
 private constructor(private readonly producer:Producer) {}
 static connect() { const producer=new Kafka({clientId:"events",brokers:[]}).producer(); return new KafkaSink(producer); }
 async send(topic:string,key:string,value:string) { await this.producer.send({topic,messages:[{key,value}]}); }
}
export function publish(sink:EventSink) { sink.send("events","key","value"); }`,
  ];
  const negative = [
   `import {Kafka, Producer} from "kafkajs";
interface EventSink { send(topic:string,key:string,value:string):Promise<void>; }
class KafkaSink implements EventSink {
 private constructor(private readonly producer:Producer) {}
 static connect(Kafka:any) { const producer=new Kafka({clientId:"events",brokers:[]}).producer(); return new KafkaSink(producer); }
 async send(topic:string,key:string,value:string) { await this.producer.send({topic,messages:[{key,value}]}); }
}
export function publish(sink:EventSink) { sink.send("events","key","value"); }`,
   'import type {Producer} from "kafkajs"; class Sender { configure(p:Producer) {} publish() { this.p.send({topic:"events",messages:[]}); } }',
   'import type {Producer} from "kafkajs"; class Sender { publish() { class Nested { constructor(private p:Producer) {} } this.p.send({topic:"events",messages:[]}); } }',
   'import type {Producer} from "kafkajs"; function outer(p:Producer) { function publish(p:any) { p.send({topic:"events",messages:[]}); } }',
   'import type {Producer} from "kafkajs"; function publish<Producer>(p:Producer) { p.send({topic:"events",messages:[]}); }',
   'import type {Producer as EventProducer} from "kafkajs"; function publish<EventProducer>(p:EventProducer) { p.send({topic:"events",messages:[]}); }',
   'import type {Producer} from "kafkajs"; function publish(p:Producer) { { const p:any={}; p.send({topic:"events",messages:[]}); } }',
   'interface EventSink { send(topic:string,key:string,value:string):Promise<void>; } function publish(sink:EventSink) { sink.send("events","key","value"); }',
   'function publish(res:any) { res.send("events"); res.send({topic:"events",messages:[]}); }',
   'import type {Producer} from "kafkajs"; function outer() { interface Producer {send(value:any):void} function publish(p:Producer) { p.send({topic:"events",messages:[]}); } }',
   'import type {Producer as EventProducer} from "kafkajs"; class Sender { configure(producer:EventProducer) {} publish() { this.producer.send({topic:"events",messages:[]}); } }',
   `import {Kafka, Producer} from "kafkajs";
interface EventSink {send(topic:string,key:string,value:string):Promise<void>;}
class UnconnectedSink implements EventSink {
 constructor(private producer:Producer) {}
 static unrelated() { const producer=new Kafka({clientId:"events",brokers:[]}).producer(); return producer; }
 async send(topic:string,key:string,value:string) { await this.producer.send({topic,messages:[{key,value}]}); }
}
function publish(sink:EventSink) { sink.send("events","key","value"); }`,
  ];
  const failures: {expectation: string; index: number; path: string; line: number; source: string; nodes?: unknown; edges?: unknown; gaps?: unknown; error?: string}[] = [];
  for (const [expectation, cases] of [['positive', positive], ['negative', negative]] as const) for (const [index, source] of cases.entries()) {
   const path = 'services/api/main.ts';
   try {
    const result = await extractContracts(tree({'contracts/asyncapi/events.yaml':contract, [path]:source}));
    const actual = result.edges.filter((edge) => edge.type === 'code.publishes' && edge.from.startsWith('code.symbol:'));
    const expectedCount = expectation === 'positive' ? 1 : 0;
    const hasSpans = actual.every((edge) => edge.span?.path === path && edge.span.byteStart >= 0 && edge.span.byteEnd > edge.span.byteStart);
    const unsupported = expectation !== 'negative' || index !== 6 || result.gaps.some((gap) => gap.path === path && gap.reason.includes('line 1: send names channel events'));
    if (actual.length !== expectedCount || !hasSpans || !unsupported) failures.push({expectation,index,path,line:1,source,nodes:result.nodes,edges:result.edges,gaps:result.gaps});
   } catch (error) {failures.push({expectation,index,path,line:1,source,error:error instanceof Error ? error.stack ?? error.message : String(error)});}
  }
  if (failures.length > 0) throw new Error(`${import.meta.path}:105: messaging receiver matrix: ${failures.length} of ${positive.length+negative.length} cases failed; every case was examined\n${JSON.stringify(failures,null,2)}`);
 });
});
