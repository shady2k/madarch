# Contracts open in their standard renderers and operations are grouped by contract

Change: madarch-m38l.16
Base: 6913d38b561017f46fc158d5c2aa1224ee167da0
Tasks: madarch-m38l.16
Kind: behavior

## Intent
A reader understanding an integration opens the operations catalogue, finds
an operation under its contract and protocol, and reads the actual contract
in a familiar documentation view. The main path is catalogue → operation →
Definition, with implementation, caller and source links beside it. Success
means the complete contract and the selected operation are readable in the
installed binary, not just a table of extracted names and raw source.
This implements item 2 only and milestone wiki-for-people defect 41.

## Rationale
The owner asked for Swagger/Redoc views, then found that PR #164 had not
provided them: «Здесь мы с тобой обсуждали swagger/redoc вид. Где это все?».
At the pinned current origin/main baseline, the lazy Definition block exists
but draws a member table and raw text; it is not Redoc or AsyncAPI, cuts source
at 400 lines, and accepts contract pages only. The operation template has no
Definition block. The wiki app declares neither renderer dependency.

This is a behavior change with a complete proposed product-wiki capability in
`capabilities/product-wiki.md`. It is the accepted capability at Base plus only
`contract-display`. The previous proposal included graph, history and location
work already delivered by PR #164; that proposal is narrowed here, not replayed
as fresh work. Its historical audit and screenshots are not evidence for this
remaining item. Current capability files stay unchanged until stage acceptance
and closure.

## Out of scope
- Item 1: graph connectivity, isolation audit, history summaries and code locations, delivered in PR #164.
- Health/probe and route-operation extraction, now madarch-m38l.20; no changes under src/extract.
- Other diagrams (madarch-m38l.15), document/page content and kinds (madarch-m38l.21), questions and the writer (madarch-m38l.22).
- A general catalogue/menu redesign, new graph storage, product data inside the engine, contract editing or API execution.
- Real agent runs, owner infrastructure and outside-repository fixtures. Use generated or committed neutral fixtures and the scripted ACP agent only.

## Changes to requirements
- product-wiki/contract-display (new at Base): operations grouped by contract with protocol badges and operation, implemented-by, called-by and place columns; lazy, read-only Redoc, AsyncAPI and protobuf documentation; operation-specific Redoc views retaining graph links and chain; complete definitions or explicit diagnostic errors; bilingual app-owned strings; exact established dependencies and all renderer assets inside the compiled binary. Scenarios: `operations-grouped-by-contract`, `openapi-definition-and-operation-slice`, `asyncapi-definition`, `grpc-definition`, `contract-definition-is-lazy-and-failure-visible`, `protocol-rendering-localization`, `compiled-binary-contract-renderers`, `complete-definition-or-explicit-refusal`, `pinned-established-renderers`.

Complete proposed capability: `capabilities/product-wiki.md`. All existing
requirements are retained verbatim from Base; no hand-written delta is stored.

## Preserved contracts
- product-wiki/serve: product routes remain reachable and reads do not change product files.
- product-wiki/internationalization: app-owned text follows English and Russian catalogues; source content is not translated.
- product-wiki/app: the same built app is served from a checkout and embedded in the release binary.

## Coverage
- product-wiki/contract-display: test, browser-walk, compiled-binary-contract-walk, renderer-version-audit
- product-wiki/serve: test
- product-wiki/internationalization: test, browser-walk
- product-wiki/app: test, compiled-binary-contract-walk

## Where it is seen

Kind: screen
Place: a product's operations catalogue, contract Definition views and operation pages
Mockup: docs/changes/madarch-m38l.16/contract-views-mockup.html

1. Open the API operations catalogue and read each contract heading, its protocol badge and the operation, implemented-by, called-by and place columns.
2. Open an OpenAPI contract and expand Definition. Read Redoc, then open one operation and find Redoc positioned at that operation beside madarch's links and chain.
3. Open an AsyncAPI contract and read its channels and messages in the AsyncAPI component. Open a gRPC contract and follow service → method → request/response message fields.
4. Repeat from an installed compiled binary with external network requests blocked, in English and Russian, light and dark, at 1150 px and 390 px. A bad definition reports its source and cause while the rest of the page remains usable.

## Blocking questions
None.

## Design and decisions
- Implementation starts only after the coordinator records the owner's approval for this scoped proposal's digest.
- Extend the existing deferred Definition block and the operations list; do not introduce a second wiki or standalone API portal. The server reads repository content at the graph's pinned revision. The product remains the source of truth.
- Group using declared contract relationships and stable graph identities, not matching names. Sort deterministically by code point. An operation lacking a contract remains visible in an explicitly labelled group; unresolved ownership must not drop a row. Preserve caller, implementation and location links.
- Use lazy local adapters: Redoc for OpenAPI, @asyncapi/react-component for AsyncAPI and a local protobuf documentation view. Keep network/API execution controls off. The protobuf view documents services, methods, streaming where declared, request/response messages and their fields, rather than showing raw rpc names alone.
- Load renderer code and styles only when Definition is opened. Keep errors inside the definition boundary; do not blank the surrounding page. Supply the entire definition and resolve product-local references against pinned source bytes. Unsupported or unresolved dependencies produce explicit file, line, full-path diagnostics; never silently fetch arbitrary remote references or present truncated content as complete.
- An OpenAPI operation page selects its own operation using its stable operation identity or method/path. Redoc is positioned at that selection; madarch's declared-by, served-by, callers and chain links remain available. A missing or ambiguous selection is an explicit error, never the first operation as a fallback.
- Prefer locally bundled adapters over CDN scripts or hosted documentation: the installed binary must work independently of network access and a source checkout. Compare with the existing embedded app asset path and PR #160's archify embedding. Build output must retain lazy chunks, styles, workers and fonts the renderers actually use.
- Proposed exact pins, checked against the npm registry on 2026-10-24: Redoc 2.5.4 (published 2026-09-10T14:04:23.606Z) and @asyncapi/react-component 3.2.1 (published 2026-09-17T18:54:20.714Z). Both predate adoption by more than fourteen days and declare React 19-compatible peer ranges. Verify transitive compatibility and required peer dependencies on the pod before adoption; record the lockfile and built-asset evidence. Do not silently substitute a newer release or weaken compatibility. No dependency or product-code change is made in this approval proposal.
- Shared-file boundary: the operation template, definition block/model, API projection and UI list/block types, app catalogues, package manifest/lockfile, build embedding and dedicated tests/shots may need targeted edits. Report overlap with m38l.21 (templates and kinds) and m38l.15 (UI blocks); coordinate before writes there. Do not edit extractor, writer or loop ownership.

### Baseline and planned checks
Baseline: origin/main `6913d38b561017f46fc158d5c2aa1224ee167da0`. Source review found:
- `src/knowledge/definition.ts`: contract-only kind guard; member rows; `SPEC_LIMIT = 400`; no standard renderer output.
- `wiki/app/src/knowledge/blocks.tsx`: Definition is a custom table and raw-text disclosure.
- `src/knowledge/seed.ts`: contract has Definition; operation does not.
- `wiki/app/package.json`: neither Redoc nor @asyncapi/react-component is installed.

TDD after approval: reproduce the missing grouping, renderer dispatch, lazy
loading, operation selection, complete source/reference handling, protobuf
fields and local-asset behavior through focused tests. Keep failure fixtures
neutral and ensure malformed, missing and unsupported definitions fail with
source diagnostics. Assert all operation rows remain present, including those
without a resolvable contract, and check exact catalogue-key parity.

Run type checks and focused engine/UI tests only on a SkyPilot AVX2 pod;
use 8 GB for wiki, fill and browser work. Run the full suite through CI on
the final PR head, not with local Bun. Run bounded mutations of changed
logic before reporting, and disclose unsupported tooling or survivors.

After approval, independently review with Codex in read-only mode and fix
valid findings. On the pod, walk every touched contract and operation page
through the JSON page API and kind lists, not a sample; record all ids and
counts. Render and inspect the complete reader path in both languages, light
and dark, desktop and phone. Seed the scratch home with the everything role
before screenshots. Record screenshot paths and layout observations. Build
and serve the compiled binary outside the checkout, block external browser
requests and verify every renderer and required asset from that binary.
Bring the pod down, merge current origin/main before the final push and hand
one green PR to the owner; never merge it.

## Acceptance evidence
Proposal and baseline review only. No implementation, tests, mutation run,
screenshots, compiled-binary verification, independent implementation review,
PR or CI are claimed yet. All remain pending approval.

## DONE WHEN
The operations catalogue groups every operation by contract and protocol with
the four required columns. Contract pages lazily render complete OpenAPI in
Redoc, AsyncAPI in @asyncapi/react-component and gRPC service/method/message
fields in a proto documentation view. OpenAPI operation pages select their
own Redoc operation and keep madarch links and chain. The views are read-only,
errors are explicit and source-located, and the complete reader path works
from the self-contained binary with no CDN. Every touched page is checked
through JSON and inspected in English and Russian, light and dark, at 1150 px
and 390 px, with screenshots, focused pod checks, mutation evidence, independent
review and green CI recorded on the final PR head.
