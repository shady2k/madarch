# Checkpoint 1 — first fill of the generated training repository (rerun)

Change: fill-pipeline-monday. Task: madarch-p45j.4. Run date: 2026-10-17, 15:14–15:19 UTC.
Engine: `main` as landed by PR #59 (`61e511d2`, the `fix/madarch-fill-agent-output` fix included; this worktree's tree is byte-identical to `origin/main`, `git diff origin/main HEAD` empty).
Agent: `omp` with model `shady2k-gateway/glm-5.3-flash-auto` (the owner-authorized combination), read-only tools (`read,grep,glob`). Caps agreed with the owner for this run: 60 agent calls and 45 minutes — the run ended blocked after 4 agent calls in about 5 minutes, well inside both.

## Reproduction

From a madarch checkout (main):

```sh
node examples/training-repository/generate.mjs /tmp/madarch-p45j4-ckpt2/training-source   # deterministic; the answer key (examples/training-repository/answer-key.json) stays in the checkout
MADARCH_HOME=/tmp/madarch-p45j4-ckpt2/home bun scripts/madarch.ts new --home /tmp/madarch-p45j4-ckpt2/home --port 18123 --json   # detached; killed once the product existed
bun scripts/madarch.ts repo add training-source file:///tmp/madarch-p45j4-ckpt2/training-source --source /tmp/madarch-p45j4-ckpt2/training-source --mode move --product <product folder>
git -C <product> add docs/kinds.yaml && git -C <product> commit -m 'Add training registry'   # registry: Data Entity, Module, Service, Store (as the previous checkpoint attempt authored it)
cd <product>
bun <checkout>/scripts/madarch.ts fill --agent omp --model shady2k-gateway/glm-5.3-flash-auto --omp-executable <wrapper> --omp-extension /home/dev/.omp/plugins/node_modules/pi-extension-shady2k-gateway/index.js --max-units 60 --json
```

Run state: `/tmp/madarch-p45j4-ckpt2/home/idea-2026-10-17/.madarch/fill/`. Logs: `fill.log`, `fill-resume.log`, `fill-resume2.log` beside it. Every omp call is recorded with its full JSONL stream in `/tmp/madarch-p45j4-ckpt2/omp-calls/` (a wrapper executable tees each call; the engine is unmodified).

## Outcome

The run did not complete. Stages inventory, index, code-map and claims completed; the synthesis stage blocked three times, each leaving the unit `running` and the run `blocked`:

| attempt | agent call | model's shape | the reader's refusal |
| --- | --- | --- | --- |
| run 1 | call 2 (38 s) | fenced JSON: `title`, `segments` with `name`/`prose` keys, no `body` | `Generator returned an empty overview page` |
| resume 1 | call 3 (59 s) | fenced JSON: `title`, `proseSegments`, no `body` | `Agent output field segments must be an array` |
| resume 2 | call 4 (65 s) | fenced JSON: `title`, `segments` (7, with `prose` key), no `body` | `Generator returned an empty overview page` |

Cause: `src/product/synthesis-prompts/page-synthesis.md` names no JSON fields and shows no example — the exact gap madarch-tzte.10 fixed for the claims prompt. The contrast is direct: the claims call, whose prompt now carries an explicit schema with one example, answered correctly on the first try (22 claims, no retry); the synthesis call, whose prompt does not, guessed a different shape three times and never supplied the required non-empty `body`. Filed as **madarch-tzte.13**. The claims retry/fail-one-unit mechanism of madarch-tzte.10 covers the claims unit only; the synthesis unit kept being left `running` by these blocks.

## Found / missed / invented against the answer key (claims stage, 22 claims)

**Found**
- Entities by kind — service 4/4 (`checkout-api`, `orders-api`, `promotions-api`, `payments-api`, each claimed with its identifier constant and anchor); store 7/7 (`cart-cache`, `orders-db`, `promotions-db`, `payments-db`, `card-vault-db`, `fraud-features`, `reconciliation-db`); module 4/4 (`checkout-cart`, `checkout-pricing`, `checkout-payment-step`, `checkout-confirmation`, claimed with their constants in one claim); data entity 5/6 (order with its fields and states, card-number, card-token, settlement-report; `order-number` only as a field name — see misses).
- Business rules 4/4: retention purge (`RunRetentionJob`/`PurgeExpired`, 90 days from `CreatedDay`), checkouts' `discountFor` percent parameter, promotions' integer `Discount = subtotal*percent/100`, and the tax discrepancy.
- Order state machine: `pending_payment→confirmed` (payment-captured), `pending_payment→cancelled` (payment-failed), `confirmed→shipped` (shipment-dispatched) claimed with anchors; the fourth key transition (expiry→purged, condition `day - CreatedDay >= 90 and state != shipped`) is covered by the retention claim.
- Interactions 3/3: checkout→promotions over HTTP (`applyPromotion`), payments→event bus (`publishPaymentEvent`), orders→event bus (`PublishOrderEvent`).
- Contradictions 3/3, claimed with the conflicting document named: README "10% discount on every order" vs caller-supplied percent (as `assumed-meaning`, 0.8); README "flat 5% tax" vs `taxRate = 0.08`; README "orders retained indefinitely" / orders README "available forever" vs the 90-day purge (two claims).
- Undocumented behaviour 1/1 (the 90-day purge), intent evidence 1/1 (the idempotency "why" comment on `capture`), term mismatch 1/1 (code calls the vault reference `CardToken`, prose calls the captured value a payment token — layer `intent-evidence`, confidence 0.9).
- Links: one `assumed-meaning` claim records that both README URLs (RFC 9110; github.com/settings/profile) were not fetched and stay unverified.
- Git history: the three scripted commits (ORD-12, PAY-4, ORD-19 with their fixed dates) cited as a `fact` claim from git-history source records.

**Missed**
- 0 of the 8 expected open questions were produced (`claims.json` has `questions: []`) — filed as **madarch-tzte.14**; see "five telling misses" below.
- `OrderContents` (a key data entity, 1 of the key's 21 entities) is claimed only as the Order field name `Contents`, never as its own entity claim; `OrderNumber` appears only as a field name in the Order claim, not as its own claimed entity (the key lists both as entities).
- The event bus (`event-bus`, key broker entity) has no registry kind in the checkpoint registry (Data Entity, Module, Service, Store), so it can appear only inside service claims — a registry-and-key coverage gap to settle with the owner, not a model error.
- `inaccessibleLinks` is always `[]` in the agent path (built empty in `src/product/fill.ts`), so the "one link needs sign-in" treatment the key expects has no typed record — the claim above carries the substance. Link reading is deferred after Monday by the charter, noted here for completeness.

**Invented**
- None. Every claim traces to a supplied source (8 pinned sources: README.md, docs/architecture.md, services/orders/README.md, the four service sources, git history); 16 `fact` / 2 `intent-evidence` / 4 `assumed-meaning` (0.7–0.8), 18 verified / 4 unverified, every `sourceIds` entry resolves.

### Five telling misses or inventions, with anchors

1. **Questions: 0 of 8 expected types** (`examples/training-repository/answer-key.json`, `expectedOpenQuestions`) — the engine's question generation covers only a registry kind with no supported claim (`src/product/fill-claims.ts:118`, the `present`-kind filter in `assembleClaims`), so the contradiction, term and undocumented-behaviour signals the claims carry never become question records. Filed madarch-tzte.14.
2. **`OrderContents` missed** (key entity; `services/orders/src/order.go` line 1 area, `type OrderContents []string`) — absent from all 22 claims; only the Order field `Contents` appears.
3. **`OrderNumber` not claimed as an entity** (key entity; `services/orders/src/order.go`, `type OrderNumber string`) — appears only as a field name inside the Order claim.
4. **Event bus unrepresentable** (key `sourceModel` entity `event-bus`; `model-ids.json`) — no broker kind in the checkpoint registry, so the fill can never describe it on its own page; visible only inside the two service claims.
5. **No synthesis pages at all** — the checkpoint's page-level check could not run: three wrong shapes (table above), never a `body`, never a segment whose text quotes a supported claim verbatim as the reader requires (`src/product/fill-synthesis.ts`, `synthesizeRegistryPage`). The model's best attempt (call 4) was coherent prose with plausible sourcing but not the required record. Filed madarch-tzte.13.

## Time and tokens per unit and total

Per-unit wall time comes from the persisted unit records (`createdAt`→`finishedAt`, UTC); per-call tokens from the wrapper's captured omp streams (input tokens exclude cache reads; cacheRead is reported separately; the engine's own usage aggregation was not used because it sums every event line, which double-counts repeated usage records — noted as an observation, not used here).

| unit | attempt(s) | time | agent calls (duration) | input | cacheRead | output |
| --- | --- | --- | --- | --- | --- | --- |
| inventory-repository | 1 | 0.01 s | — (deterministic) | — | — | — |
| index ×4 | 1 each | 0.02–0.05 s each | — (deterministic) | — | — | — |
| claims-repository | 1 | 41 s | call 1, 41 s | 21,737 | 20,672 | 1,968 |
| code map | — | < 1 s | — (deterministic) | — | — | — |
| synthesis-pages (overview) | 3 blocked attempts | never completed | calls 2–4: 38 s, 59 s, 65 s | 26,391 / 7,895 / 26,391 | 0 / 18,496 / 0 | 2,038 / 4,336 / 4,544 |
| **total** | | ~5 min wall | 4 agent calls | **82,414** (+39,168 cache reads = 121,582) | 39,168 | **12,886** |

## Reused vs run on resume

| start | run id | reused units | agent calls made |
| --- | --- | --- | --- |
| run 1 | `b0b1c500…` | 0 (fresh product) | 2 (claims + first synthesis attempt) |
| resume 1 | new id (prior run `blocked`) | inventory, 4 index units, claims, code map — all complete with matching input hashes | 1 (synthesis attempt; `proseSegments`) |
| resume 2 | new id | same 6 units + code map reused, no agent call for them | 1 (synthesis attempt; `prose` keys) |

Completed units were reused on every resume; only the synthesis unit re-ran. Two resume behaviours behaved as designed: a `blocked` run resumes by reusing every completed unit, and the synthesis unit left `running` by the previous start did not block the fresh attempt.

Two behaviours worth the owner's attention, observed on the way:

- Each resume starts a NEW run id and resets the persisted per-run agent-call budget (`.madarch/fill/agent-calls.json` is matched by `runId`), so a blocked-and-resumed cycle does not accumulate toward a 60-call cap; the cap bounds one run attempt, not one checkpoint. Say the word and it becomes a task.
- The synthesis unit is always recreated at `attempt: 1` on start (`src/product/fill.ts`), so its failed-attempt count is lost between runs; the claims unit keeps its true attempt count.

## Verdict

With the tzte.10 fix in place the claims stage is stable with this flash model (schema + example ⇒ correct first answer), the pipeline fails fast with named units instead of hanging, and resumption reuses all deterministic and claimed work. The remaining blocker for a full checkpoint is the synthesis stage's prompt schema and retry (madarch-tzte.13), with typed question emission behind it (madarch-tzte.14). Caps used: 4 of 60 agent calls, ~5 of 45 minutes.
