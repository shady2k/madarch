#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '../../reference-system/madarch');
const answerKey = path.join(here, 'answer-key.json');
const files = {
  'README.md': `# Ordering and payments training system\n\nThe service applies a 10% discount to every order and calculates tax at a flat 5%. Orders are retained indefinitely. See [the HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110). Sign in at [the project workspace](https://github.com/settings/profile) to see private project details.\n`,
  'docs/architecture.md': `# Ordering and payments\n\nCheckout coordinates pricing, payment and order placement. The code calls Promotions over HTTP and receives payment outcomes as events.\n\nThe order state is pending_payment → confirmed → shipped; a failed payment moves it to cancelled.\n\nThe system calls a card number a payment token in prose, although code uses CardToken only for the vault reference and calls the captured value PaymentToken.\n`,
  'services/checkout/src/checkout.ts': `export const checkoutService = 'checkout-api';\nexport const cartModule = 'checkout-cart';\nexport const pricingModule = 'checkout-pricing';\nexport const paymentStepModule = 'checkout-payment-step';\nexport const confirmationModule = 'checkout-confirmation';\nexport const cartStore = 'cart-cache';\nexport const taxRate = 0.08;\nexport const discountFor = (subtotal: number, percent: number) => subtotal * (1 - percent / 100);\nexport async function applyPromotion(orderId: string) { return fetch('http://promotions-api/internal/apply', { method: 'POST', body: orderId }); }\nexport function paymentToken(vaultReference: string) { return { kind: 'PaymentToken', vaultReference }; }\nexport function confirmCheckout() { return 'orders-api'; }\n`,
  'services/orders/src/order.go': `package orders\n\nconst ServiceID = "orders-api"\nconst StoreID = "orders-db"\ntype State string\nconst ( PendingPayment State = "pending_payment"; Confirmed State = "confirmed"; Cancelled State = "cancelled"; Shipped State = "shipped" )\ntype OrderNumber string
type OrderContents []string
type Order struct { ID string; OrderNumber OrderNumber; Contents OrderContents; State State; CreatedDay int }\nfunc Transition(o *Order, event string) {\n switch {\n case o.State == PendingPayment && event == "payment-captured": o.State = Confirmed\n case o.State == PendingPayment && event == "payment-failed": o.State = Cancelled\n case o.State == Confirmed && event == "shipment-dispatched": o.State = Shipped\n }\n}\nfunc Expire(o *Order, day int) bool { return day-o.CreatedDay >= 90 && o.State != Shipped }\nfunc PurgeExpired(orders []Order, day int) []Order { kept:=make([]Order,0,len(orders)); for _,o:=range orders { if !Expire(&o,day) { kept=append(kept,o) } }; return kept }\nfunc RunRetentionJob(store *OrderStore, day int) { store.Orders = PurgeExpired(store.Orders, day) }\ntype OrderStore struct { Orders []Order }\nfunc PublishOrderEvent(event string) string { return EventBus.Publish("orders", event) }
type eventBroker struct { Topics map[string][]string }
func (b *eventBroker) Publish(topic, event string) string { b.Topics[topic] = append(b.Topics[topic], event); return event }
var EventBus = &eventBroker{Topics: map[string][]string{}}\n`,
  'services/promotions/src/promotions.go': `package promotions\n\nconst ServiceID = "promotions-api"\nconst StoreID = "promotions-db"\nfunc Discount(subtotal int, percent int) int { return subtotal * percent / 100 }\n`,
  'services/payments/src/payment.ts': `export const serviceId = 'payments-api';\nexport const storeId = 'payments-db';\nexport const vaultId = 'card-vault';\nexport const vaultStoreId = 'card-vault-db';\nexport const fraudServiceId = 'fraud-api';\nexport const featureStoreId = 'fraud-features';\nexport const reconciliationId = 'reconciliation-job';\nexport const reconciliationStoreId = 'reconciliation-db';\nexport type CardNumber = { masked: string };\nexport type CardToken = { vaultReference: string };\nexport type PaymentEvent = 'payment-captured' | 'payment-failed';\nexport function publishPaymentEvent(event: PaymentEvent): PaymentEvent { return eventBroker.publish('payments', event); }
const eventBroker = { topics: new Map<string, PaymentEvent[]>(), publish(topic: string, event: PaymentEvent) { this.topics.set(topic, [...(this.topics.get(topic) ?? []), event]); return event; } }
export type SettlementReport = { id: string; total: number };\nexport function reconcileSettlement(report: SettlementReport) { return report }\n// Keep the order identifier stable across retries so the payment callback is idempotent.\nexport function capture(orderId: string): PaymentEvent { return orderId ? 'payment-captured' : 'payment-failed'; }\n`,
  'services/orders/README.md': `# Orders service\n\nOrders remain available forever.\n`,
};
const symbols = Object.fromEntries(Object.entries(files).map(([f, text]) => [f, [...text.matchAll(/(?:export\s+(?:async\s+)?function|export\s+const|func|type|const)\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map(x => x[1])]));
const elements = [];
for (const name of ['ordering', 'payments', 'platform']) {
  const text = await readFile(path.join(source, `${name}.yaml`), 'utf8');
  for (const block of text.split(/\n  - id: /).slice(1)) {
    const id = block.match(/^([^\n]+)/)?.[1];
    const kind = block.match(/^\s*kind: ([^\n]+)/m)?.[1];
    const displayName = block.match(/^\s*name: ([^\n]+)/m)?.[1];
    if (id && kind && displayName) elements.push({ id, kind, name: displayName });
  }
}
const selected = new Set(['checkout-api','checkout-cart','checkout-pricing','checkout-payment-step','checkout-confirmation','cart-cache','orders-api','orders-db','promotions-api','promotions-db','payments-api','payments-db','card-vault-db','fraud-features','reconciliation-db','event-bus']);
const missing = [...selected].filter(id => !elements.some(e => e.id === id));
if (missing.length) throw new Error(`Reference model ids missing: ${missing.join(', ')}`);
const destination = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node generate.mjs <destination-folder>');
if (destination === path.parse(destination).root) throw new Error('Destination must not be a filesystem root');
const checkout = path.resolve(here, '../../..');
if (destination === checkout || destination.startsWith(`${checkout}${path.sep}`) || checkout.startsWith(`${destination}${path.sep}`)) throw new Error('Destination must be a separate directory outside this checkout');
let parent = path.dirname(destination);
while (parent !== path.dirname(parent)) { try { const resolved=await realpath(parent); if (resolved===path.parse(resolved).root || resolved===checkout || resolved.startsWith(`${checkout}${path.sep}`) || checkout.startsWith(`${resolved}${path.sep}`)) throw new Error('Destination must not resolve into or contain this checkout'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; parent=path.dirname(parent); } }
try { if ((await lstat(destination)).isSymbolicLink()) throw new Error('Destination must not be a symlink'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const key = JSON.parse(await readFile(answerKey, 'utf8'));
key.sourceModel = elements.filter(e => selected.has(e.id)).map(({id,name,kind})=>({id,name,kind,file:'model-ids.json',symbol:id}));
await writeFile(path.join(destination, 'model-ids.json'), `${JSON.stringify(key.sourceModel, null, 2)}\n`);
const run = (args, env={}) => execFileSync('git', args, {cwd: destination, stdio:'ignore', env:{...process.env,...env}});
run(['init','--initial-branch=main']); run(['config','user.name','Training Repository']); run(['config','user.email','training@example.com']);
const commits = [
  {date:'2024-01-01T00:00:00Z',key:'ORD-12',message:'ORD-12 add order lifecycle', files:['services/orders/src/order.go','services/orders/README.md']},
  {date:'2024-01-02T00:00:00Z',key:'PAY-4',message:'PAY-4 add checkout pricing and promotions', files:['services/checkout/src/checkout.ts','services/promotions/src/promotions.go']},
  {date:'2024-01-03T00:00:00Z',key:'ORD-19',message:'ORD-19 document services and model', files:Object.keys(files).filter(f=>!['services/orders/src/order.go','services/orders/README.md','services/checkout/src/checkout.ts','services/promotions/src/promotions.go'].includes(f))},
];
for (const c of commits) {
  for (const file of c.files) { const full=path.join(destination,file); await mkdir(path.dirname(full),{recursive:true}); await writeFile(full,files[file]); }
  run(['add','.']);
  run(['commit','--allow-empty','-m',c.message], {GIT_AUTHOR_NAME:'Training Repository',GIT_AUTHOR_EMAIL:'training@example.com',GIT_COMMITTER_NAME:'Training Repository',GIT_COMMITTER_EMAIL:'training@example.com',GIT_AUTHOR_DATE:c.date,GIT_COMMITTER_DATE:c.date});
}
console.log(destination);
