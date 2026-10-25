import {expect, test} from 'bun:test';
import {extractCode} from '../src/extract/code/index.js';
import {extractContracts} from '../src/extract/contracts/index.js';
const tree = (files: Record<string, string>) => ({paths: Object.keys(files).sort(), read: (path: string) => new TextEncoder().encode(files[path] ?? '')});
test('Unicode callback spans and ordinary sites use code owner, outer and nested registrations stay separate', async () => {
 const path = 'services/api/main.ts';
 const source = `// карта
import express from "express";
function helper() { return 1; }
export function start() {
 const app = express();
 helper();
 app.get("/outer", () => { helper(); app.get("/inner", () => helper()); });
 app.get("/named", helper);
}`;
 const input = tree({[path]: source}); const code = await extractCode(input); const ex = await extractContracts(input, code);
 const ascii = await extractContracts(tree({[path]: source.replace('// карта','// ascii')}));
 expect(ascii.edges.find((edge) => edge.type === 'code.handled-by' && edge.from.endsWith('#GET:/named'))?.to).toBe(`code.symbol:${path}#helper`);
 const callbacks = code.nodes.filter((node) => node.properties.inline === true);
 expect(callbacks).toHaveLength(2);
 expect(ex.nodes.some((node) => callbacks.some((callback) => callback.key === node.key))).toBe(false);
 for (const callback of callbacks) {
  expect(ex.edges.some((edge) => edge.type === 'code.handled-by' && edge.to === callback.key)).toBe(true);
  expect(code.edges.some((edge) => edge.type === 'code.calls' && edge.from === callback.key && edge.to.endsWith('#helper'))).toBe(true);
  expect(code.edges.some((edge) => edge.type === 'code.occurrence' && edge.from === callback.key && edge.to.endsWith('#helper'))).toBe(true);
 }
 expect(code.edges.find((edge) => edge.type === 'code.calls' && edge.from.endsWith('#start') && edge.to.endsWith('#helper'))?.properties.count).toBe(1);
 const named = ex.edges.find((edge) => edge.type === 'code.handled-by' && edge.from.endsWith('#GET:/named'));
 expect(named?.to).toBe(`code.symbol:${path}#helper`);
 expect(new TextDecoder().decode(input.read(path).slice(named!.span!.byteStart, named!.span!.byteEnd))).toBe('helper');
 const repeated = await extractCode(input);
 expect(repeated.nodes.filter((node) => node.properties.inline).map((node) => node.key)).toEqual(callbacks.map((node) => node.key));
 const renamed = await extractCode(tree({'services/api/renamed.ts': source}));
 expect(renamed.nodes.filter((node) => node.properties.inline).map((node) => node.key.split('#')[1])).toEqual(callbacks.map((node) => node.key.split('#')[1]));
});
test('Kafka messages variables and local real construction are supported, shadowed construction and HTTP are not', async () => {
 const sources = [
  {yes:true, source:'import type {Producer} from "kafkajs"; export function publish(p:Producer,messages:any[]) { p.send({topic:"events",messages}); }'},
  {yes:true, source:'import {Kafka as EventBus} from "kafkajs"; export function publish() { const p = new EventBus({brokers:[]}).producer(); const messages:any[]=[]; p.send({topic:"events",messages:messages}); }'},
  {yes:true, source:'import {Kafka} from "kafkajs"; export function publish() { const p = new Kafka({brokers:[]}).producer(); p.send({topic:"events",messages:[]}); }'},
  {yes:false, source:'import {Kafka} from "kafkajs"; export function publish(Kafka:any) { const p = new Kafka({}).producer(); p.send({topic:"events",messages:[]}); }'},
  {yes:false, source:'import {Kafka} from "kafkajs"; export function publish() { const Kafka:any = class {}; const p = new Kafka({}).producer(); p.send({topic:"events",messages:[]}); }'},
  {yes:false, source:'export function publish(res:any) { res.send({topic:"events",messages:[]}); }'},
 ];
 const failures: string[] = [];
 for (const [index, item] of sources.entries()) {
  const ex = await extractContracts(tree({'services/api/main.ts':item.source, 'contracts/asyncapi/events.yaml':'asyncapi: 2.6.0\ninfo: {title: Events, version: 1.0.0}\nchannels:\n events:\n  publish: {message: {name: Changed}}\n'}));
  const actual = ex.edges.some((edge) => edge.type === 'code.publishes' && edge.to === 'code.channel:events');
  if (actual !== item.yes) failures.push(`${index}: expected publisher ${item.yes}, got ${actual}`);
  if (item.source.startsWith('export function publish(res:') && ex.gaps.some((gap) => gap.reason.includes('receiver'))) failures.push(`${index}: ordinary HTTP send became messaging warning`);
 }
 expect(failures).toEqual([]);
});
test('same port does not override exact service hostname and explicit external origin never falls back internally', async () => {
 const input = tree({
  'services/a/main.ts':'import express from "express"; function health() {} export function start() {const app=express();app.get("/healthz",health);app.listen(8080);} export function external() {fetch("https://outside.example/healthz");} export function internal() {fetch("http://a:8080/healthz");}',
  'services/b/main.ts':'import express from "express"; function health() {} export function start() {const app=express();app.get("/healthz",health);app.listen(8080);}',
  'contracts/openapi/a.yaml':'openapi: 3.0.0\ninfo: {title: API, version: 1.0.0}\nservers: [{url: "http://a:8080"}]\npaths:\n /healthz:\n  get: {operationId: health}\n',
 });
 const ex = await extractContracts(input);
 expect(ex.edges.filter((edge) => edge.type === 'code.serves').map((edge) => edge.from)).toEqual(['code.route:services/a/main.ts#GET:/healthz']);
 expect(ex.edges.some((edge) => edge.type === 'code.calls-remote' && edge.from.endsWith('#external'))).toBe(false);
 expect(ex.edges.some((edge) => edge.type === 'code.calls-remote' && edge.from.endsWith('#internal'))).toBe(true);
});


test('Go inline route keeps byte span and ordinary helper occurrence with code ownership', async () => {
 const path = 'services/api/main.go';
 const input = tree({[path]: `// карта
package api
import "net/http"
func helper() {}
func start() {
 mux := http.NewServeMux()
 helper()
 mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { helper() })
}`});
 const code = await extractCode(input); const ex = await extractContracts(input,code);
 const handler = ex.edges.find((edge) => edge.type === 'code.handled-by')?.to;
 expect(handler).toBeDefined(); expect(code.nodes.some((node) => node.key === handler)).toBe(true);
 expect(ex.nodes.some((node) => node.key === handler)).toBe(false);
 expect(code.edges.some((edge) => edge.type === 'code.calls' && edge.from === handler && edge.to.endsWith('#helper'))).toBe(true);
 expect(code.edges.find((edge) => edge.type === 'code.calls' && edge.from.endsWith('#start') && edge.to.endsWith('#helper'))?.properties.count).toBe(1);
});
