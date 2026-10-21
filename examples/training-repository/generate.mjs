#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {mkdir,rm,writeFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)), checkout=path.resolve(here,'../..'), dest=path.resolve(process.argv[2]||'');
if(!process.argv[2]) throw Error('Usage: node generate.mjs <destination-folder>');
if(dest===path.parse(dest).root||dest===checkout||dest.startsWith(checkout+path.sep)||checkout.startsWith(dest+path.sep)) throw Error('Destination must be outside and separate from this checkout');
try{if((await lstat(dest)).isSymbolicLink())throw Error('Destination must not be a symlink')}catch(e){if(e.code!=='ENOENT')throw e}
for(let p=path.dirname(dest);p!==path.dirname(p);p=path.dirname(p)){try{const r=await realpath(p);if(r===checkout||r.startsWith(checkout+path.sep)||checkout.startsWith(r+path.sep))throw Error('Destination parent resolves into checkout');break}catch(e){if(e.code!=='ENOENT')throw e}}
await rm(dest,{recursive:true,force:true});await mkdir(dest,{recursive:true});
const run=(a,env={})=>execFileSync('git',a,{cwd:dest,stdio:'ignore',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C',LANG:'C',TZ:'UTC',...env}});
const files={
'README.md':`# Ordering and payments training system\n\nPrerequisites: Go 1.22, Node 20, Docker Compose and psql. Set DATABASE_URL=postgres://training:training@localhost:5432/orders. Run make up, then make seed, send an example curl request to http://localhost:8080/orders, then make test. Common failure: port 5432 is already in use.\n\nThe service applies a 10% discount to every order and calculates tax at a flat 5%. Orders are retained indefinitely. See [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110). Sign in at [the project workspace](https://github.com/settings/profile) to see private project details.\n`,
'docs/vision.md':'# Vision\nShopper places orders, support inspects them, finance reconciles settlements. Journeys: place order, pay, refund, use promotion.\n',
'docs/requirements.md':'# Requirements\nUC-1 place order; UC-2 pay; UC-3 refund; UC-4 apply promotion. BR-1 discount; BR-2 tax; BR-3 retention; BR-4 idempotency.\n',
'docs/architecture.md':'# Architecture\nCheckout calls Orders over HTTP and Payments over gRPC. An outbox relays events to Kafka. Payments.order_id is a logical reference, not a foreign key. Prose says payment token; code distinguishes CardToken and PaymentToken.\n',
'docs/glossary.md':'# Glossary\nOrder: purchase. CardToken: vault reference. PaymentToken: captured value.\n',
'docs/adr/0001-broker.md':'# ADR-0001 Kafka\nKafka is chosen for retained, replayable events.\n',
'docs/adr/0002-outbox.md':'# ADR-0002 Outbox\nWrite event and order in one transaction; relay after commit.\n',
'docs/plans/loyalty.md':'# Plan\n2026-05-04 to-be: Loyalty service and Checkout to Loyalty relation; not deployed.\n',
'contracts/openapi/orders.yaml':'openapi: 3.0.3\ninfo: {title: Orders, version: 1.0.0}\npaths:\n  /orders: {post: {operationId: createOrder, responses: {"201": {description: created}}}}\n',
'contracts/proto/payments.proto':'syntax = "proto3"; package payments.v1; service Payments { rpc Authorize(AuthorizeRequest) returns (AuthorizeReply); } message AuthorizeRequest { string order_id = 1; } message AuthorizeReply { string status = 1; }\n',
'contracts/asyncapi/order-events.yaml':'asyncapi: 2.6.0\ninfo: {title: Orders, version: 1.0.0}\nchannels: {orders.events: {publish: {message: {name: OrderChanged}}}}\n',
'services/orders/README.md':'# Orders service\n\nOrders remain available forever.\n',
'services/orders/go.mod':'module training.example/orders\ngo 1.22\n',
'services/orders/go.sum':'',
'services/orders/cmd/orders/main.go':'package main\nimport ("log";"net/http";"training.example/orders/internal/api")\nfunc main(){log.Fatal(http.ListenAndServe(":8080",api.New()))}\n',
'services/orders/src/order.go':'package domain\ntype State string\nconst(PendingPayment State="pending_payment";Confirmed State="confirmed";Cancelled State="cancelled";Shipped State="shipped")\ntype Order struct{ID string;State State;CreatedDay int}\nfunc Transition(o *Order,e string){switch{case o.State==PendingPayment&&e=="payment-captured":o.State=Confirmed;case o.State==PendingPayment&&e=="payment-failed":o.State=Cancelled;case o.State==Confirmed&&e=="shipment-dispatched":o.State=Shipped}}\nfunc Expire(o Order,d int)bool{return d-o.CreatedDay>=90&&o.State!=Shipped}\nfunc PurgeExpired(xs []Order,d int)[]Order{ys:=[]Order{};for _,x:=range xs{if !Expire(x,d){ys=append(ys,x)}};return ys}\nfunc RunRetentionJob(xs []Order,d int)[]Order{return PurgeExpired(xs,d)}\n',
'services/orders/internal/application/order_service.go':'package application\n// Iteration 0\nimport "training.example/orders/internal/domain"\ntype Store interface{Save(domain.Order)error}\ntype Service struct{store Store}\nfunc(s Service)Place(id string)(domain.Order,error){o:=domain.Order{ID:id,State:domain.PendingPayment};return o,s.store.Save(o)}\n',
'services/orders/internal/pricing/pricing.go':'package pricing\n// BR-1 in docs/requirements.md: apply the caller percentage.\nfunc Discount(n,p int)int{return n-n*p/100}\n',
'services/orders/internal/pricing/tax.go':'package pricing\n// BR-2 in docs/requirements.md.\nconst TaxRate=0.08\nfunc Tax(n int)int{return int(float64(n)*TaxRate)}\n',
'services/orders/internal/api/router.go':'package api\nimport "net/http"\nfunc New()http.Handler{m:=http.NewServeMux();auth:=func(h http.Handler)http.Handler{return h};m.Handle("/orders",auth(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){w.WriteHeader(201)})));m.HandleFunc("GET /orders/export",func(w http.ResponseWriter,r *http.Request){w.Write([]byte("export"))});m.HandleFunc("GET /healthz",func(w http.ResponseWriter,r *http.Request){w.WriteHeader(200)});m.HandleFunc("GET /metrics",func(w http.ResponseWriter,r *http.Request){w.Write([]byte("orders_total 0"))});return m}\n',
'services/orders/internal/store/order_repository.go':'package store\nimport("context";"database/sql";"training.example/orders/internal/domain")\ntype OrderRepository struct{DB *sql.DB}\nfunc(r OrderRepository)Save(o domain.Order)error{tx,e:=r.DB.BeginTx(context.Background(),nil);if e!=nil{return e};defer tx.Rollback();_,e=tx.Exec("INSERT INTO orders(id,status) VALUES($1,$2)",o.ID,o.State);if e!=nil{return e};_,e=tx.Exec("INSERT INTO outbox(aggregate_id,topic,payload) VALUES($1,$2,$3)",o.ID,"orders.events",o.State);if e!=nil{return e};return tx.Commit()}\n',
'services/orders/internal/relay/relay.go':'package relay\nimport "database/sql"\ntype Publisher interface{Publish(string,[]byte)error}\ntype Relay struct{DB *sql.DB;Broker Publisher}\nfunc(r Relay)Run()error{rows,e:=r.DB.Query("SELECT topic,payload FROM outbox");if e!=nil{return e};defer rows.Close();for rows.Next(){var t string;var p []byte;if e=rows.Scan(&t,&p);e!=nil{return e};if e=r.Broker.Publish(t,p);e!=nil{return e}};return rows.Err()}\n',
'services/orders/internal/config/config.go':'package config\nimport("os";"sync")\nvar once sync.Once;var databaseURL string\nvar kafkaBrokers string\nvar jwtSecret string\nfunc DatabaseURL()string{once.Do(func(){databaseURL=os.Getenv("DATABASE_URL");kafkaBrokers=os.Getenv("KAFKA_BROKERS");jwtSecret=os.Getenv("JWT_SECRET")});return databaseURL}\n',
'services/orders/internal/logging/logger.go':'package logging\nimport "log"\nfunc Info(s string){log.Print(s)}\n',
'services/orders/migrations/0001_customers.sql':'CREATE TABLE customers(id TEXT PRIMARY KEY,email TEXT NOT NULL);\n',
'services/orders/migrations/0002_orders.sql':'CREATE TABLE orders(id TEXT PRIMARY KEY,customer_id TEXT REFERENCES customers(id),status TEXT NOT NULL);\n',
'services/orders/migrations/0003_order_items.sql':'CREATE TABLE order_items(id TEXT PRIMARY KEY,order_id TEXT REFERENCES orders(id),sku TEXT NOT NULL);\n',
'services/orders/migrations/0004_outbox.sql':'CREATE TABLE outbox(id BIGSERIAL PRIMARY KEY,aggregate_id TEXT,topic TEXT,payload JSONB,published_at TIMESTAMPTZ);\n',
'services/orders/internal/domain/order_test.go':'package domain\nimport "testing"\nfunc TestTransitions(t *testing.T){cases:=[]struct{s State;e string;w State}{{PendingPayment,"payment-captured",Confirmed},{PendingPayment,"payment-failed",Cancelled}};for _,c:=range cases{o:=Order{State:c.s};Transition(&o,c.e);if o.State!=c.w{t.Fatal(o.State)}}}\n',
'services/promotions/go.mod':'module training.example/promotions\ngo 1.22\n',
'services/promotions/go.sum':'',
'services/promotions/cmd/promotions/main.go':'package main\nimport "net/http"\nfunc main(){_ = http.ListenAndServe(":8082",http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){if r.URL.Path=="/healthz"{w.WriteHeader(200)}}))}\n',
'services/promotions/internal/discount/strategy.go':'package discount\ntype Strategy interface{Discount(int,int)int}\ntype Percent struct{}\nfunc(Percent)Discount(n,p int)int{return n*p/100}\nfunc Discount(n,p int)int{return Percent{}.Discount(n,p)}\n',
'services/promotions/migrations/0001_promotions.sql':'CREATE TABLE promotions(id TEXT PRIMARY KEY,code TEXT UNIQUE,percent INTEGER);\n',
'services/checkout/package.json':'{"name":"checkout","version":"1.0.0","dependencies":{"express":"4.19.2"},"devDependencies":{"jest":"29.7.0"}}',
'services/checkout/package-lock.json':'{"name":"checkout","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"dependencies":{"express":"4.19.2"},"devDependencies":{"jest":"29.7.0"}},"node_modules/express":{"version":"4.19.2"},"node_modules/accepts":{"version":"1.3.8"},"node_modules/jest":{"version":"29.7.0","dev":true}}}',
'services/checkout/src/index.ts':'import express from "express";export const app=express();app.get("/healthz",(_q,res)=>res.sendStatus(200));\n',
'services/checkout/src/pricing.ts':'export function discountFor(subtotal:number,percent:number){return subtotal*(1-percent/100)}\nexport const taxRate=0.08;\n',
'services/checkout/src/orders-client.ts':'export async function placeOrder(x:unknown){return fetch("http://orders:8080/orders",{method:"POST",body:JSON.stringify(x)})}\n',
'services/checkout/src/payments-client.ts':'export async function authorize(id:string){return {status:id?"CAPTURED":"DECLINED"}}\n',
'services/checkout/src/promotions-client.ts':'export async function applyPromotion(id:string){return fetch("http://promotions:8082/internal/apply",{method:"POST",body:id})}\n',
'services/checkout/src/api/routes.ts':'import{Router}from"express";import{placeOrder}from"../orders-client";import{authorize}from"../payments-client";export const router=Router();router.post("/checkout",async(req,res)=>{const o=await placeOrder(req.body);const p=await authorize("order");if(p.status==="DECLINED")return res.status(402).end();return res.status(201).json(o)});\n',
'services/checkout/src/logging/logger.ts':'export const info=(s:string)=>console.info(s);\n',
'services/checkout/test/checkout.e2e.test.ts':'test("declined payment returns failure",async()=>{expect(402).toBe(402)});\n',
'services/payments/package.json':'{"name":"payments","version":"1.0.0","dependencies":{"express":"4.19.2","lodash":"4.17.15"},"devDependencies":{"jest":"29.7.0"}}',
'services/payments/package-lock.json':'{"name":"payments","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"dependencies":{"express":"4.19.2","lodash":"4.17.15"},"devDependencies":{"jest":"29.7.0"}},"node_modules/express":{"version":"4.19.2"},"node_modules/accepts":{"version":"1.3.8"},"node_modules/lodash":{"version":"4.17.15"},"node_modules/jest":{"version":"29.7.0","dev":true}}}',
'services/payments/src/index.ts':'import express from "express";export const app=express();app.get("/healthz",(_q,res)=>res.sendStatus(200));\n',
'services/payments/src/config.ts':'// TODO: source the provider secret from the vault when the sandbox is connected.\nexport const paymentTimeoutMs=Number(process.env.PAYMENT_TIMEOUT_MS??3000);export const paymentProvider=process.env.PAYMENT_PROVIDER??"cardnet";\n',
'services/payments/src/domain/payment.ts':'import{emitPaymentEvent}from"../events/publishers";export type CardToken={vaultReference:string};export type PaymentToken={value:string};export function capture(id:string){emitPaymentEvent(id);return id?"CAPTURED":"DECLINED"}\n',
'services/payments/src/events/publishers.ts':'import type{PaymentToken}from"../domain/payment";export function emitPaymentEvent(s:string){void(null as unknown as PaymentToken);return s}\n',
'services/payments/src/providers/provider.ts':'export interface PaymentProvider{charge(id:string):Promise<string>}export abstract class BaseProvider{protected ready=true}\n',
'services/payments/src/providers/cardnet.ts':'import{BaseProvider,PaymentProvider}from"./provider";export class Cardnet extends BaseProvider implements PaymentProvider{async charge(id:string){return this.ready?id:"DECLINED"}}\n',
'services/payments/src/providers/deferred.ts':'import{BaseProvider,PaymentProvider}from"./provider";export class Deferred extends BaseProvider implements PaymentProvider{async charge(id:string){return `deferred:${id}`}}\n',
'services/payments/src/providers/factory.ts':'import{PaymentProvider}from"./provider";import{Cardnet}from"./cardnet";import{Deferred}from"./deferred";export class PaymentClientFactory{static create(n:string):PaymentProvider{return n==="deferred"?new Deferred():new Cardnet()}}\n',
'services/payments/src/api/routes.ts':'import{Router}from"express";import{capture}from"../domain/payment";export const routes=Router();routes.post("/pay",(req,res)=>res.json({status:capture(req.body.orderId),key:req.get("Idempotency-Key")}));\n',
'services/payments/src/api/legacy-report.ts':'import{Request,Response}from"express";\nexport function legacyReport(req:Request,res:Response){\n const sql="SELECT * FROM payments WHERE customer_id = "+req.query.customer_id; // untrusted query parameter concatenated into SQL\n return res.json({sql});\n}\n'+Array.from({length:95},(_,i)=>`// monthly report compatibility row ${i+1}`).join('\n')+'\n// FIXME: parameterize the query before exposing this internal endpoint.\n',
'services/payments/src/store/payment_repository.ts':'export interface PaymentRepository{save(id:string,orderId:string):Promise<void>}export class PrismaPaymentRepository implements PaymentRepository{async save(_id:string,_order:string){}}\n',
'services/payments/prisma/schema.prisma':'datasource db { provider="postgresql"; url=env("DATABASE_URL") }\nmodel Payment { id String @id; order_id String // logical reference; no FK to Orders\n status String; refunds Refund[] }\nmodel Refund { id String @id; payment_id String; payment Payment @relation(fields:[payment_id],references:[id]) }\n',
'services/payments/src/format.ts':'export function formatInvoiceLegacy(total:number){return `$${total.toFixed(2)}`}\n',
'services/payments/src/http-client.ts':'let client:{request:(s:string)=>Promise<string>}|undefined;export async function request(url:string){client={request:async s=>s};return client.request(url)}\n',
'services/payments/src/logging/logger.ts':'export const info=(s:string)=>console.info(s);\n',
'services/payments/src/grpc/server.ts':'import{capture}from"../domain/payment";export function authorize(id:string){return{status:capture(id)}}\n',
'services/payments/test/factory.test.ts':'test("factory selects provider",()=>expect(true).toBe(true));\n',
'services/payments/test/refund.test.ts':'test("refund captured payment",()=>expect(true).toBe(true));test.skip("requires vault sandbox",()=>{});\n',
'services/orders/Dockerfile':'FROM golang:1.22-alpine\nWORKDIR /app\nCOPY . .\nRUN go build -o /orders ./cmd/orders\nEXPOSE 8080\nCMD ["/orders"]\n',
'services/payments/Dockerfile':'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 8081\nCMD ["node","dist/index.js"]\n',
'services/promotions/Dockerfile':'FROM golang:1.22-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 8082\nCMD ["/promotions"]\n',
'services/checkout/Dockerfile':'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 8083\nCMD ["node","dist/index.js"]\n',
'docker-compose.yml':'services:\n  postgres: {image: postgres:16, ports: ["5432:5432"]}\n  kafka: {image: apache/kafka:3.7, ports: ["9092:9092"]}\n  orders: {build: ./services/orders, ports: ["8080:8080"], environment: {DATABASE_URL: postgres://postgres/orders, KAFKA_BROKERS: kafka:9092, JWT_SECRET: local}}\n  payments: {build: ./services/payments, ports: ["8081:8081"], environment: {DATABASE_URL: postgres://postgres/payments, PAYMENT_PROVIDER: cardnet}}\n  promotions: {build: ./services/promotions, ports: ["8082:8082"]}\n  checkout: {build: ./services/checkout, ports: ["8083:8083"]}\n',
'.env.example':'DATABASE_URL=postgres://localhost/orders\nKAFKA_BROKERS=localhost:9092\nPAYMENT_PROVIDER=cardnet\nJWT_SECRET=replace-me\n',
'deploy/k8s/orders.yaml':'apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: orders}\nspec: {template: {spec: {containers: [{name: orders, image: training/orders:1.0, ports: [{containerPort: 8080}]}]}}}\n---\napiVersion: v1\nkind: Service\nmetadata: {name: orders}\nspec: {ports: [{port: 80, targetPort: 8080}]}\n',
'.github/workflows/ci.yml':'name: ci\non: [push]\njobs: {checks: {runs-on: ubuntu-latest, steps: [{uses: actions/checkout@v4}, {run: echo tests}]}}\n',
'Makefile':'run-orders:\n	cd services/orders && go run ./cmd/orders\ntest:\n	cd services/orders && go test ./...\nup:\n	docker compose up --build -d\nseed:\n	psql "$(DATABASE_URL)" -f scripts/seed.sql\n',
'scripts/seed.sql':"INSERT INTO customers(id,email) VALUES('demo','demo@example.test') ON CONFLICT DO NOTHING;\n"
};
const author=[['Rin Tanaka','rin@example.com'],['Avery Quinn','avery@example.com'],['Sam Okafor','sam@example.com']];
run(['init','--initial-branch=main']);run(['config','user.name','Training Repository']);run(['config','user.email','training@example.com']);
const write=async(p,s)=>{const f=path.join(dest,p);await mkdir(path.dirname(f),{recursive:true});await writeFile(f,s)};
for(const p of Object.keys(files).sort())await write(p,files[p]);
for(let i=0;i<60;i++){
 if(i%3===0){const q='docs/architecture.md';files[q]=files[q].replace(/\n$/,`\nHistory note ${i+1}.\n`);await write(q,files[q]);}
 if(i%5===0){const hot='services/orders/internal/application/order_service.go';files[hot]=files[hot].replace(/\/\/ Iteration \d+/,`// Iteration ${i+1}`);await write(hot,files[hot]);}
 if(i===10||i===30){for(const q of ['services/orders/internal/pricing/pricing.go','services/orders/internal/pricing/tax.go']){files[q]=files[q].replace(/\n$/,`\n// Paired revision ${i}.\n`);await write(q,files[q]);}}
 if(i===15){const q='services/orders/internal/pricing/pricing.go';files[q]=files[q].replace(/\n$/,`\n// Pricing-only revision.\n`);await write(q,files[q]);}
 if(i===16){const q='services/orders/internal/pricing/tax.go';files[q]=files[q].replace(/\n$/,`\n// Tax-only revision.\n`);await write(q,files[q]);}
 if(i===12){const from='services/orders/src/order.go',to='services/orders/internal/domain/order.go'; await mkdir(path.dirname(path.join(dest,to)),{recursive:true}); run(['mv',from,to]); files[to]=files[from]; delete files[from]; }
 const [name,email]=author[i%3],d=new Date(Date.UTC(2026,0,5+i*3,12)).toISOString(),cd=i===37?'2026-01-01T12:00:00Z':d;
 run(['add','-A']);run(['-c',`user.name=${name}`,'-c',`user.email=${email}`,'commit','--allow-empty','-m',`${['ORD','PAY','OPS'][i%3]}-${100+i} evolve training system`],{GIT_AUTHOR_NAME:name,GIT_AUTHOR_EMAIL:email,GIT_COMMITTER_NAME:name,GIT_COMMITTER_EMAIL:email,GIT_AUTHOR_DATE:d,GIT_COMMITTER_DATE:cd});
 if(i===20){run(['checkout','-b','feature/checkout-observability']); const fd='2026-03-07T12:00:00Z'; const q='docs/architecture.md'; files[q]+='\nFeature branch note: Checkout reports service health.\n'; await write(q,files[q]);run(['add','-A']);run(['-c','user.name=Rin Tanaka','-c','user.email=rin@example.com','commit','-m','CHK-220 add checkout observability'],{GIT_AUTHOR_NAME:'Rin Tanaka',GIT_AUTHOR_EMAIL:'rin@example.com',GIT_COMMITTER_NAME:'Rin Tanaka',GIT_COMMITTER_EMAIL:'rin@example.com',GIT_AUTHOR_DATE:fd,GIT_COMMITTER_DATE:fd});run(['checkout','main']);run(['merge','--no-ff','feature/checkout-observability','-m','CHK-221 merge checkout observability'],{GIT_AUTHOR_NAME:'Avery Quinn',GIT_AUTHOR_EMAIL:'avery@example.com',GIT_COMMITTER_NAME:'Avery Quinn',GIT_COMMITTER_EMAIL:'avery@example.com',GIT_AUTHOR_DATE:'2026-03-08T12:00:00Z',GIT_COMMITTER_DATE:'2026-03-08T12:00:00Z'});}
}
console.log(dest);
