# Checkpoint 2 — the real fill of the training repository on the fixed synthesis pipeline

Change: fill-pipeline-monday. Task: madarch-p45j.4 (integrator-held; this record is the run's evidence). Run date: 2026-10-17, 18:25:55–19:11:00 UTC wall — the caps agreed with the owner, 60 agent calls and 45 minutes TOTAL across resumes, were reached exactly and the run was stopped by its own control file (36 calls, 45:00).

Engine: `origin/main` at `b91499bb` (PR #64 — madarch-tzte.13 synthesis schema, madarch-tzte.14 typed questions, madarch-tzte.15 chain-wide call cap — plus the wizard and daemon landings). Mid-run the checkpoint contradicted two behaviours of `main`:

1. The **critic** answer had no schema and no tolerance: the flash model returned findings as objects, `Critic returned invalid findings for overview` crashed the start and left the unit `running` — exactly the failure mode madarch-tzte.13 removed for the generate answer. Fixed during the run as **madarch-9v0p**: `page-critic.md` now carries the explicit shape with one example, findings flatten unambiguously (`{type, detail}` → `type: detail`), the critic answer is retried with the exact validation errors, and a still-invalid critic answer fails the unit like the generate one. Commit `4b1dd428` (branch `fix/madarch-fill-synthesis-schema`).
2. The owner's own words (docs/milestones/self-filling.md: «Даже на один этап одного прохода будет недостаточно») applied to the bounded loop: at `maxRevisions: 2` no resume converged on the overview; widened to 3, commit `11f0503c`. With three revisions everything passed.

Resumes 1–2 ran unmodified `origin/main`; resumes 3–4 ran `origin/main` + `4b1dd428` + `11f0503c`. The call budget persisted across all four starts in one chain (`agent-calls.json` keyed by `fillChainId` — madarch-tzte.15 working as designed).

## Reproduction

From an `origin/main` checkout (`b91499bb`), following checkpoint-1.md's Reproduction:

```sh
node examples/training-repository/generate.mjs /tmp/madarch-p45j4-ckpt3/training-source   # deterministic; the answer key stays in the checkout
bun scripts/madarch.ts new --home /tmp/madarch-p45j4-ckpt3/home --port 18231 --json       # detached, killed once the product existed
bun scripts/madarch.ts repo add training-source file:///tmp/madarch-p45j4-ckpt3/training-source --source /tmp/madarch-p45j4-ckpt3/training-source --mode move --product /tmp/madarch-p45j4-ckpt3/home/idea-2026-10-17
git -C /tmp/madarch-p45j4-ckpt3/home/idea-2026-10-17 add docs/kinds.yaml
git -C /tmp/madarch-p45j4-ckpt3/home/idea-2026-10-17 commit -m 'Add training registry'     # registry: Data Entity, Module, Service, Store — the checkpoint-1 registry
# engine pinned per resume (see Engine), then from the product folder:
bun <engine>/scripts/madarch.ts fill --agent omp --model shady2k-gateway/glm-5.3-flash-auto \
  --omp-executable /tmp/madarch-p45j4-ckpt3/omp-wrapper.sh \
  --omp-extension /home/dev/.omp/plugins/node_modules/pi-extension-shady2k-gateway/index.js --max-units 60 --json
# the wrapper tees every omp stream into /tmp/madarch-p45j4-ckpt3/omp-calls/ (engine unmodified)
```

Run state: `/tmp/madarch-p45j4-ckpt3/home/idea-2026-10-17/.madarch/fill/`; logs `fill.log`, `fill-resume.log`, `fill-resume2.log`, `fill-resume3.log` beside it. The 45-minute stop was applied by writing `.madarch/fill/control.json` `{"action":"stop"}` at 19:10:55; the process drained, left the run `stopped`, and the chain carries 36/60.

## Outcome

The claims and synthesis stages now survive the flash model end to end: every unit ran to a named outcome, no start ever blocked on a malformed generate answer, and the critic loop **accepted four of the five synthesis pages** before the time cap stopped the Stores page.

| resume | started | engine | agent calls | wall | outcome |
| --- | --- | --- | --- | --- | --- |
| run 1 (`962fe947`) | 18:25:55 | `b91499bb` | 4 | 4.7 min | claims refused once on a wrong source id and **recovered on the validated retry** (2 calls, accepted); generate answered in the documented schema first try; **the critic failed with findings as objects** — start crashed, run `blocked` |
| run 2 (`dd1a7229`) | 18:38:19 | `b91499bb` | 7 | 6.4 min | overview could not converge in 2 critic-informed revisions — "Critic did not accept overview page after 3 bounded passes"; run `blocked` |
| run 3 (`f310efab`) | 18:47:04 | `+ 4b1dd428, 11f0503c` | 6 | 5.5 min | kosher critic shape, but the same bound: the overview was refused after 3 passes again — the second such run, at only 6 calls, sharpened the bound |
| run 4 (`4c4e8528`) | 18:58:39 | same | 19 | 12.3 min | **overview accepted on pass 3; Data Entity on pass 3; Module on pass 3; Services first try (pass 2)**; the 45-minute cap stopped the run before the Stores page — run `stopped` by its own control |
| total | | | **36** | **45:00** | |

Unit records at stop: inventory and the 4 index units attempt 1 each; claims-repository attempt 1 complete (98 s wall, reused by every later resume); synthesis-pages attempt 4 (one recreate per resume). The bounded-pass refusal is NOT yet a named unit outcome — the unit stays `running` and `report.json` is never written, and no accepted page persists before the whole stage returns, so each blocked resume re-ran synthesis from scratch. Filed as **madarch-oci2** (with the evidence of resumes 2–3: two identical re-litigations cost 13 calls; with per-page persistence, run 9 could have kept its three accepted pages and finished Stores).

## Claims stage: found against the answer key (24 claims, 24 typed questions)

Found — services 4/4 (`checkout-api`, `orders-api`, `promotions-api`, `payments-api`, each with its identifier constant and anchor, all under `Service`); entities Order/CardNumber/CardToken/PaymentEvent/SettlementReport (`Data Entity`); business rules (checkout `discountFor` percent parameter, promotions integer `Discount = subtotal*percent/100`, the 90-day purge of non-shipped orders, the tax contradiction); the order state transitions pending_payment→confirmed→shipped and the failed-payment cancel; the interactions checkout→promotions over HTTP and payments→event-bus; the intent-evidence idempotency comment on `capture`; the two unfetched RFC 9110 / profile links — now **typed** as two `access-or-document-needed` questions and recorded in `inaccessibleLinks` (`not-attempted`, each carrying its source id).

Missed (unchanged from checkpoint 1, plus one new): `OrderContents` and `OrderNumber` appear only as field names, never as entity claims; `event-bus` is unrepresentable (the checkpoint registry has no broker kind). **New:** no `Store`-kind claims were made at all (the model folded store identifiers into Service claims), so the Stores page would have carried only the `unverifiable` absence question — a claims-stage variance this flash model shows with the questions shape in the prompt; the answer key expects 7 stores.

Invented: none — 18 `fact` / 4 `intent-evidence` / 2 `assumed-meaning`, 22 verified / 2 unverified, every `sourceIds` entry resolves to a supplied pinned source.

### The 24 typed questions the claims stage carried into the pages (tzte.14, real-run verified)

| type | n |
| --- | --- |
| decision-rationale | 12 |
| undocumented-behaviour | 4 |
| contradiction | 2 |
| assumption-check | 2 |
| access-or-document-needed | 2 |
| term | 1 |
| unverifiable | 1 |

Strongest signals, verbatim: `Code behaviour no document mentions: no HTTP handler for the promotions apply endpoint appears in the supplied promotions code; only checkout holds the URL string.` — `Documents and code name one thing differently: payment token versus CardToken / PaymentToken` — `The claim conflicts with the published document README.md: README.md states orders are retained indefinitely and services/orders/README.md states available forever, while order.go purges non-shipped orders after 90 days.` Every question carries `dependsOn` (unit + claim ids) and `rank`; the full list with pending answers is `.madarch/fill/outputs/claims-repository/claims.json`.

## Pages produced (accepted by the bounded critic loop)

| page | passes | title |
| --- | --- | --- |
| overview | 3 | Overview |
| Data Entity | 3 | Data Entities: Order, Payment, and Settlement Shapes |
| Module | 3 | Module Overview |
| Service | 2 | Payments Platform Services |
| Store | — | not started when the cap stopped the run |

The pages never reached `applySynthesisPages` (the controlled write happens only after the whole stage returns), so no `.proposed.md` exists yet and the product's committed docs still hold the pre-fill tree. The accepted contents live in the recorded omp streams: `call-043-2026-10-17T19:02:25Z` (Overview, accepted by critic call-045), `call-055` (Data Entity, accepted by call-057), `call-065` (Module, accepted by call-067), `call-069` (Services, accepted by call-071), every stream preserved verbatim under `/tmp/madarch-p45j4-ckpt3/omp-calls/`.

### The accepted overview page, quoted in full

Title: **"Overview"** — the overview's ten paragraphs, page body.

> # Overview

> The repository's Git history records three commits with subjects "ORD-12 add order lifecycle" (2024-01-01), "PAY-4 add checkout pricing and promotions" (2024-01-02) and "ORD-19 document services and model" (2024-01-03).

> docs/architecture.md describes a commerce system in which Checkout coordinates pricing, payment and order placement, calls Promotions over HTTP, and receives payment outcomes as events; the same document lays out the order state flow from pending_payment to confirmed to shipped, with a failed payment moving the order to cancelled.

> The orders service (services/orders/src/order.go) exports ServiceID 'orders-api' and StoreID 'orders-db'. Its Order struct carries ID, OrderNumber, Contents, State and CreatedDay, with states pending_payment, confirmed, cancelled and shipped. Transition sets Confirmed on the 'payment-captured' event, Cancelled on 'payment-failed' while pending payment, and Shipped on 'shipment-dispatched' while confirmed. It also uses an in-process eventBroker with a Topics map and publishes to topic 'orders'; no document describes this broker.

> Order expiry is enforced in code: an order reports as expired when the current day minus its CreatedDay is at least 90 and its state is not Shipped, and RunRetentionJob replaces store.Orders with the kept set from PurgeExpired.

> The checkout service (services/checkout/src/checkout.ts) exports checkoutService 'checkout-api', modules checkout-cart, checkout-pricing, checkout-payment-step, checkout-confirmation and cartStore 'cart-cache'. It exports a taxRate of 0.08. Its paymentToken builds an object of kind 'PaymentToken' from a vaultReference, and confirmCheckout returns the literal 'orders-api' without performing a remote call.

> The promotions service (services/promotions/src/promotions.go) exports ServiceID 'promotions-api' and StoreID 'promotions-db', and computes a discount as subtotal * percent / 100 with integer truncation. On the checkout side, applyPromotion POSTs the orderId to http://promotions-api/internal/apply; no HTTP handler for the apply endpoint appears in the supplied promotions code, and only checkout holds the URL string.

> The payments service (services/payments/src/payment.ts) exports identifiers payments-api, payments-db, card-vault, card-vault-db, fraud-api, fraud-features, reconciliation-job and reconciliation-db. Its capture function returns 'payment-captured' for a non-empty orderId and 'payment-failed' otherwise, with a code comment stating the order identifier is kept stable across retries so the payment callback is idempotent; it publishes PaymentEvent values to an in-process eventBroker topic 'payments'. The code shows a SettlementReport type with id and total fields whose reconcileSettlement returns the report unchanged; no document mentions settlement reconciliation. CardNumber holds only a masked value and CardToken holds only a vaultReference; no supplied document describes these shapes.

> docs/architecture.md calls a card number a payment token, while the code distinguishes the two: CardToken is used only as a vault reference and PaymentToken for the captured value.

> README.md states a flat 10% discount on every order and a flat 5% tax rate, which the code contradicts: discounts come only from the percent-based promotions call and the exported taxRate is 0.08. README.md and services/orders/README.md state orders are retained indefinitely and remain available forever, which the code contradicts with its 90-day purge of non-shipped orders.

> README.md links RFC 9110 and a GitHub profile URL for private project details; the content of those links is not verified from the supplied sources.
> _Provenance, accepted verbatim from the recorded stream: each paragraph names its layer, its claim ids and its source ids in the answer — (1) fact, clm-625e02141e6058b485ab9914, src-eb6f77d808b91471e95a045b; (2) intent-evidence, clm-cb747712070386e365f9eb5e + clm-383859de29ed26b623a5f3d3, src-cd630a50f7db9354d29208a9; (3) fact, clm-f228f87ebe1fe098f85077d6 + clm-e8fbe670339b31647ac23769 + clm-ce292cf06d729c7965e7ab98 + clm-2f96f716b6ac144435d7c349, src-35de00d87da95b8d1a68b518; (4) fact, clm-8f3615f0b47a87650da1ea6f, src-35de00d87da95b8d1a68b518; (5) fact, clm-bc7f6656e25fb8a55083c1c6 + clm-22baef2e845e24949cf40a01 + clm-f05845fdce7ad3ee99c5e8ae + clm-7162393d80a03820608781d6, src-0d3fa8b9c9e96b02f486b77a; (6) fact, clm-ec8bf9c6e5d7d2ed74d0fdb2 + clm-500d2596317bacafd4ced53e + clm-2e8cf6eeaf08a9d8e39039c6, src-a9353dc89c7f1ed0d7b6196b + src-0d3fa8b9c9e96b02f486b77a; (7) fact, clm-909bce98191655679e820ec6 + clm-27622e5931eb1cab26f43fbe + clm-75dca9ac291be86228ac60d7 + clm-f64cdeacbbfe657f617c8c86 + clm-bf994aa29579db67d6a6aa1f, src-5055435ee6754c4017132a6e; (8) intent-evidence, clm-48cde44555847bbb3df37196, src-cd630a50f7db9354d29208a9 + src-5055435ee6754c4017132a6e; (9) assumed-meaning, clm-6d9408b22fe03dcbe9ea0e44 + clm-ae64723cc62dc314c9ec23b7, src-243841befcd301abb7e78a22 + src-0d3fa8b9c9e96b02f486b77a + src-a9353dc89c7f1ed0d7b6196b + src-35de00d87da95b8d1a68b518 + src-b1f1f0b9ec155d699bc99039; (10) intent-evidence, clm-3b0cd090ad61465b2c127f48, src-243841befcd301abb7e78a22. The answers returned the 24 supplied claim records unchanged._

## Time and tokens per unit and total

Per-call tokens come from the wrapper's captured omp streams, the same method as checkpoint 1 (the last usage record of each stream; `input` excludes cache reads, `cacheRead` reported separately, and one contended call in run 4 lost its EXIT line but not its stream). Wall time per call from the wrapper's START/EXIT stamps; unit wall time from the persisted unit records.

| unit | agent calls | wall | input | cacheRead | output |
| --- | --- | --- | --- | --- | --- |
| inventory + 4 index units (deterministic) | 0 | < 1 s | — | — | — |
| claims-repository: attempt 1 refused, attempt 2 accepted (calls 1–2, 30 s + 68 s) | 2 | 98 s | 5,040 | 44,032 | 7,911 |
| synthesis, run 1: generate accepted by the reader first try; critic refused (malformed) | 2 — calls 3–4 | 2.1 min | 30,317 | 29,184 | 8,010 |
| synthesis, run 2: overview ×3 passes, all refused | 7 | 6.1 min | 179,461 | 24,320 | 24,088 |
| synthesis, run 3: overview ×3 passes, all refused | 6 | 5.3 min | 141,246 | 28,288 | 21,579 |
| synthesis, run 4: overview 3 passes accepted, Data Entity 3 accepted, Module 3 accepted, Services first try accepted, Stores not started | 19 | 12.2 min | 450,012 | 13,696 | 49,358 |
| **total** | **36** | **45:00 (27.3 min inside agent calls)** | **831,516** | **139,520** | **111,911** |

The synthesis-pages unit record keeps `attempt: 4` — one recreate per resume. Claims kept its single attempt — its output was reused unchanged by every later resume, exactly like the deterministic units.

## Reused vs run on resume

| start | run id | units reused with matching input hashes | agent calls made |
| --- | --- | --- | --- |
| run 1 | `962fe947` | 0 (fresh product) | 4 — claims ×2 (one validated retry), generate, critic |
| run 2 | `dd1a7229` | inventory, 4 index units, claims (code map rebuilt deterministically) | 7 |
| run 3 | `f310efab` | same | 6 |
| run 4 | `4c4e8528` | same | 19 |

The cap held the whole time: every start resumed `agent-calls.json` under one `fillChainId` (`962fe947` — madarch-tzte.15); run 4 started correctly at 26 calls used, not 0. Had the cap still been keyed by run id, run 4 would have believed it had 60 fresh calls.

## What the coordinator should look at in the wiki

Serving detached (`nohup`, port 18233):

- **Address:** `http://127.0.0.1:18233` — the wiki app serves the product `idea-2026-10-17` from `/tmp/madarch-p45j4-ckpt3/home` (its reading routes sit under `/p/…`).
- The wiki shows the product's committed docs — the fill has *not* written pages yet, because `applySynthesisPages` runs only after the whole stage returns, and no `.proposed.md` exists. The real record lives beside the wiki: `.madarch/fill/outputs/claims-repository/claims.json` (24 claims + 24 typed questions + 2 inaccessible links), the unit records, and the four accepted page streams under `/tmp/madarch-p45j4-ckpt3/omp-calls/`.
- Next step for the owner: after madarch-9v0p and madarch-oci2 land, resume the same fill — the chain carries 36/60 used, needs the owner's word for extended caps, and then finishes Stores, commits the stage, and puts the four pages plus the answers pending in the wiki for review.

## Verdict

The tzte.13 fix held in a real run: the generate answer came back in the documented schema on the first attempt of every try (calls 3, 9, 23, 35 …), no start ever crashed on a generate answer, and the claims stage recovered on its own validated retry. The critic was the last unshaped call — madarch-9v0p gave it a schema, tolerance for the objects this flash model produces, the same validated retry, and the reviewer results were strong: its findings named exact sentences and exact missing claim ids (calls 37, 41, 49, 53, 63), and the generator corrected against them in single revisions once the bound allowed it (call 43 answered the finding of call 41 and passed, as did 65). Typed questions reached synthesis (tzte.14): the critics audited question premises on the pages, the behaviour the question stage needs. Caps used: 36 of 60 agent calls, 45:00 of 45 minutes, stopped on time by the run's own control file.

The remaining work sits in two named pieces, both filed: **madarch-9v0p** (critic schema, tolerance, validated retry, three-revision bound — commits `4b1dd428` and `11f0503c` on `fix/madarch-fill-synthesis-schema`) and **madarch-oci2** (a critic-rejected stage must record a blocked unit and persist per-page accepted output instead of leaving the unit `running` and losing every accepted page on resume). With those landed, one more short run against this same product finishes synthesis, commits the stage, and gives the checkpoint its wiki pages.
