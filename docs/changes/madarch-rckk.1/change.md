# Administrator and user guides grounded in product evidence

Change: madarch-rckk.1
Base: a083f53625d5f139d5ea6c78ade825fbc49e7ad5
Tasks: madarch-rckk.1, madarch-rckk.2
Kind: behavior

## Intent
A newcomer opens the wiki, brings the product up from its administrator guide, and performs the supported role-based scenarios from its user guide without rediscovering repository files. The two guides serve O4 of wiki-for-people, defect 26 and decision 0032 section 7. A procedure is accepted only by executing its steps; gaps remain visible rather than becoming invented operations or UI.

## Rationale
The owner asked for administrator and user guides and said that frontend/design absence was not stated. Current writer units in src/writer/tools.ts:37–40 are product, domain and localized-source. src/writer/run.ts:162–167 restricts the page sink to their existing outputs and questions. src/writer/prompts.ts:81 and src/writer/format.ts:240–242 reject command fences for ordinary pages. No existing product-guides capability covers executable procedures or walked receipts. A complete new capability is proposed under capabilities/product-guides.md; current capability files remain unchanged until acceptance. Both tasks share one generated training deployment and walkthrough, so one proposal and PR avoids duplicate startup evidence.

## Out of scope
- A second writer/orchestrator, guessed APIs for unfinished graph-context or unit-DAG work, new extraction or semantic classification.
- Automatic execution of agent commands, an in-wiki terminal, real agents in checks, real credentials or production infrastructure.
- Product-specific procedures hard-coded in the engine; product data or guides committed into this engine repository.
- A new frontend/design, fictitious UI, invented role enforcement, finance APIs, backups, recovery or operational guarantees.
- A generic runbook platform or complete Kubernetes deployment where source evidence only supplies a partial manifest.

## Changes to requirements
- product-guides/guide-outputs (new): two declared shared-writer output types, grounded bounded temporal inputs, versioned fenced publication and durable product Markdown.
- product-guides/administrator-guide (new): evidence-based environment, install/configuration, Compose/Kubernetes operations, observability, failures and explicit gaps.
- product-guides/user-guide (new): role/scenario/API how-to with actual auth, expected results, failure/repeat behavior and missing experience stated.
- product-guides/checked-procedures (new): guide-only checked executable steps, grounded instructions/results and unchanged ordinary-page fence rules; no automatic execution.
- product-guides/walk-receipts (new): real isolated step receipts, invalidation, failures and unavailable prerequisites; one shared actual deployment walk.
- product-guides/guide-reading (new): two discoverable bilingual guide pages across existing page/Markdown/JSON surfaces, readable procedures and truthful walked/gap states.

Complete proposed capability: capabilities/product-guides.md. It is new at Base.

## Preserved contracts
- product-wiki/pages: existing source documents remain pages and are not rewritten by guide output.
- product-wiki/internationalization: existing app-owned strings and added guide strings use paired English/Russian catalogues.
- product-wiki/serve: existing wiki page/API routes continue working; guide integration is additive.

## Coverage
- product-guides/guide-outputs: test
- product-guides/administrator-guide: test
- product-guides/user-guide: test
- product-guides/checked-procedures: test
- product-guides/walk-receipts: test
- product-guides/guide-reading: test
- product-wiki/pages: test
- product-wiki/internationalization: test
- product-wiki/serve: test

## Where it is seen
Kind: screen
Place: a product's Administrator guide and User guide, reached from navigation
Mockup: docs/changes/madarch-rckk.1/guides-mockup.html

1. A newcomer opens Administrator guide, reads prerequisites and coverage, and follows grounded setup steps with expected results and explicit walkthrough status.
2. The reader sees the boundary between a working local environment and partial Kubernetes evidence; missing infrastructure or backup procedures are visible gaps.
3. The reader opens User guide, chooses a product role and follows the supported API procedure, including actual authorization, inputs, success/failure results and source links.
4. Every procedure shows passed, failed or not-walked status backed by separate execution receipts; no generated text or mocked server is called a successful walkthrough.

## Blocking questions
None.

## Design and decisions
- Proposal only. No implementation begins before coordinator approval and a valid task claim. The .1 task is held for this shared proposal; .2 is included in its task list, not independently claimed by another worker. No dependency is invented from task order.
- Define two output types, their bounded inputs and their step receipt contract for integration with madarch-ztyq.4. The shared unit registry/DAG owns scheduling, typed output registration, publication fencing and output allowlists. Module/type names and the actual registration call remain undecided until that worker's contract is available; coordinate before implementation. Current GraphView's single at argument is not falsely described as full temporal support. Full {valid, known, state}, tracked empty/nonempty reads, facts versus interpretations and digest/version/fencing invariants remain requirements of decision 0032 sections 2 and 11.
- Chosen shape: a narrow structured procedure artifact validated at the shared writer boundary, rendered as Markdown and the same page model. Alternative plain agent command fences would bypass instruction/expected-result grounding and cannot prove a walk. A separate guide runner would duplicate writer ownership. Do not weaken global fixedPart or textUnits: only the two guide outputs admit checked command/request blocks; ordinary pages retain fence refusal. Exact field syntax is an implementation detail to agree with .4, not an invented existing API.
- Product output paths are narrowly allowlisted under docs/guides/administrator.md and docs/guides/user.md, with paired locale artifacts if the shared writer's selected-locale design needs them. Stable guide/procedure/step ids and source grounds remain visible. Existing authored files are preserved or reported as conflicts, never overwritten silently. Step receipts live separately under product docs/guide-walks/ with strict safe paths and no secret values. Guide artifacts/receipts are product Markdown, rebuildable indexes are not their only copy.
- Administrator prepared context includes source README/Makefile commands, environment/configuration definitions, deployment/build artifacts, health/metrics/logging/failure evidence and missing coverage. User context includes vision roles, scenarios/rules, implementing routes/operations, request/response/auth/repeat semantics and absence/gap evidence. Neither reads a repository as an unbounded file dump or uses transient internal graph-builder details as a promised API.
- Receipt ownership is separate from generation. A harness/operator executes explicitly in an isolated environment; the agent cannot certify its own output as walked. Bind guide/procedure/step ids, pinned commit/full temporal context, versions/input and command digests, prerequisites/environment/working directory, actual exit/status/observed result, evidence path and timestamp. Validate stale/forged/missing/failed receipt controls. No execution button or auto-run is introduced.
- The held training template contains timeline markers and must be generated before execution. Its README/Makefile/Compose require actual services, Postgres and Kafka. Committed checks create that fixture; no test requires outside repositories, credentials or owner infrastructure. The coordinator's requested outside-product walk is one-time acceptance evidence only, never a committed test dependency. No fake HTTP substitute satisfies startup. An isolated pod lacking Docker/Compose or a usable cluster is a reported infrastructure decision; no successful walkthrough is claimed until actual commands and requests run.
- Cover shopper order placement and paid/declined checkout; support lookup/cancel/ship/refund only as implemented; finance export/report access with actual auth exceptions. The role name does not imply an enforced permission. No finance reconciliation endpoint or frontend is invented. The source's partial orders Kubernetes Deployment/Service does not imply complete image/secret/broker/database provisioning or backup support.
- Shared changes are limited to guide registration/validation/persistence, prompt/format extension, product kinds/templates/navigation labels, page/API rendering and focused fixtures/acceptance harness. Coordinate writer/DAG seams with lead 1 and navigation surfaces with their owner before source changes. No independent writer rewrite.

## Acceptance evidence
Proposal only. No guide implementation, Bun test/build, real agent, walkthrough, screenshots, numeric layout measurement or Codex review has run. The mockup is illustrative, not evidence that its commands executed.
- Push a draft PR early for full CI in the background, never a full pod suite. Plain 4 GB SkyPilot (no --avx2) handles type checks, app build and UI tests. AVX2 8 GB handles graph/extract/fill/touched-page API checks and screenshots. One bounded focused pipeline per fix; one pod at a time for this batch, down immediately when no command runs and after fetch. No local Bun tests/builds or new uploads while the infrastructure hold remains.
- Scripted ACP generation/validation checks cover both output contracts, grounded steps/results, missing evidence, ordinary-page fence refusal, no execution side effect, path safety, secret redaction, receipt authenticity/invalidation and unchanged publication invariants. Unit/integration tests use held or generated neutral fixtures only. Explicit failures include file, line and full path; sorting uses code points.
- Shared live walkthrough: generate the held training repository; follow actual administrator configuration/start/seed/health steps with Compose/Postgres/Kafka, then real source-backed shopper/support/finance requests and UC-1 state checks. Capture actual exits, responses and receipts, including unsupported or failed steps. A mock server cannot pass this acceptance. Before a live walk, establish isolated container/cluster capability with the coordinator; if absent, leave steps not walked and record the blocker instead of fabricating a pass. Kubernetes evidence that lacks deploy prerequisites remains a visible unwalked gap.
- Only touched guide pages and relevant navigation views need shots: en/ru × light/dark × 1150/390, including long commands/requests, gaps and walked/failed/not-walked states. Seed settings.json with {"role":"everything","roleAsked":true}. Fetch to /home/dev/.cache/wiki-for-people-shots/madarch-rckk.1/ with .2's shared matrix cross-referenced. Record viewport/document width and horizontal overflow pixels, clipped/overlapping controls and warnings, code-scroll availability, page/state/path inventory; require zero horizontal page overflow and no clipped controls or warnings. Coordinator inspects actual images.
- Check only touched page JSON models, Markdown parity, source links and procedure navigation; record counts and all failures. No per-task full-page wiki walk or mutation; those run once at milestone close in madarch-j6ho.3. Do not record them passed here.
- Merge latest origin/main before final push. Exact-head CI green and shots complete precede ONE final read-only Codex review, with parent-approved slot. No design/intermediate Codex. Fix only blocking findings (misleading reader, missing task promise, false-positive check pass), file others through to-backlog under the outcome. A blocking fix gets exact-head green CI, refreshed affected shots and fix-limited review. Hand one PR to the coordinator, never merge/release. Atomic .worker-report.md names all evidence and limits.

## DONE WHEN
From the checked wiki guides alone, a newcomer starts the actual generated product in a capable isolated environment and performs UC-1 and supported role procedures; every walked claim has real receipts. The pages state absent frontend/design, partial Kubernetes prerequisites, missing workflows and unsupported operational promises honestly. Both guides use the shared writer and preserve ordinary-page safety. Touched-page/API/Markdown checks and complete responsive bilingual theme shots pass, exact-head CI is green, and final-head review has no blocking finding. Outside-product acceptance, if used, is recorded once without becoming a test dependency. Stage acceptance and merge remain the coordinator's and owner's work.
