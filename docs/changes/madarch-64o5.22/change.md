# Reset filled knowledge through the product's store owner

Change: madarch-64o5.22
Base: 7cbfed93effa7a4e3592b2c522f1cbd1f2760a2d
Tasks: madarch-64o5.22
Kind: behavior

## Intent
`madarch reset sample` works both while the owning server is running and
when it is stopped. A live reset goes through that server; an offline reset
opens the prepared store as its owner and keeps it open until the reset is
done. The command reports the removal only after application completes.
Afterward the product is idle and `not-filled`, with its graph-backed manifest
catalogue available before the next explicit Fill.

## Out of scope
- Automatically starting a fill after the command.
- Changing which personal files the reset preserves or which agent files it removes.
- Restoring working-tree catalogue or document readers.
- Changing the settings page's separate reset actions.

## Changes to requirements
- product-reset/reset: added. The reset command uses the live owning server or owns the prepared store directly while offline, waits for application, reports removal and leaves an idle, not-filled product with its graph-backed manifest catalogue.

Complete proposed capability: `capabilities/product-reset.md`.

## Preserved contracts
None.

## Coverage
- product-reset/reset: test

## Where it is seen
Kind: command
Place: `madarch reset sample [--home /tmp/products] --yes`, then the product's status and catalogue

1. Fill a fixture product, stop its server and run the reset command. Read the preview, removal report and successful completion.
2. Open the product again: it is idle and `not-filled`; its manifest kinds remain in the graph-backed catalogue, without filled content or an automatic fill.
3. Fill a fixture product with its server running, then run the reset command. The same server answers the reset and serves the same idle, `not-filled` state and graph-backed catalogue.

## Blocking questions
None.

## Acceptance evidence
`test/product-reset.test.ts` covers the two execution paths:
- `reset starts a filled fixture over without a running server`
- `reset starts a filled fixture over through its running server`

Both cases check the removal report, reset state and graph-only catalogue.
Static: bun run check passed, with 18 existing SQL findings and UI debt zero.
Test: the final reset/store-preparation/server suite passed 169 cases, skipped 8 and failed none, with 2257 assertions across nine files.
Review: independent ownership and file-safety review found no remaining blocker after table locks and post-await fingerprint checks were added.
Mutation: not-made. No mutation run was performed; no mutation score or survivors are claimed.
Evidence: /work/out/b6422/report.md, check-delivery.log, final-stable-suite.log and review.md.
