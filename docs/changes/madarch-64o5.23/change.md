# Serve normalized product addresses and the kit showcase

Change: madarch-64o5.23
Base: 7cbfed93effa7a4e3592b2c522f1cbd1f2760a2d
Tasks: madarch-64o5.23
Kind: behavior

## Intent
A doubled slash within a served product's address opens the same app page instead of failing with a server error. The kit showcase is served through the existing app route path.

## Out of scope
Changing app content, adding a second router, changing API behavior or decoding encoded separators.

## Changes to requirements
- product-wiki/app: replace the target's app requirement with its existing build contract plus normalized product addresses, the kit route and named not-found refusals. Every other requirement in the complete capability copy is unchanged from the target.

## Preserved contracts
None.

## Coverage
- product-wiki/app: static test review

## Where it is seen
Kind: request
Place: GET /products/sample// and GET /products/sample/kit

1. Serve a fixture product named sample and request its root with a doubled slash; the same app HTML opens as at its normal root.
2. Request /products/sample/kit; the showcase app route opens with product-mounted assets.
3. Request /products/sample//missing.example/unknown; the response is 404 naming the normalized address and source file and line.

## Blocking questions
None.

## Acceptance evidence
Red first: test/product-daemon.test.ts reproduced both failures before implementation in commit 2f72de14; red.log records two failed cases and the invalid URL error.
Static: bun run check passed with 18 existing SQL findings and UI debt zero, recorded in /work/out/b6423/check.log.
Test: the focused six-file server suite passed 146 cases, skipped 8 and failed none, with 2182 assertions in /work/out/b6423/server-tests.log. The doubled-slash and kit-showcase cases are in test/product-daemon.test.ts. Existing app build scenarios are checked in test/app-rebuild.test.ts.
Review: /work/out/b6423/review.md records independent URL origin, query and routing review with no blocker.
Mutation: not-made. No mutation run was performed; no mutation score or survivors are claimed.
