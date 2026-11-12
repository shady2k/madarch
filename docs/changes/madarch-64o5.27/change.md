# Two-level responsive catalogue contents

Change: madarch-64o5.27
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.27
Kind: behavior

## Intent
Make catalogue contents useful without listing individual kinds, adapt the same navigation to narrow layouts, and leave Graph its full width.

## Out of scope
Graph aggregation/layout/interaction changes (.26), fill behavior and model runs.

## Changes to requirements
- product-wiki/catalog: two-level responsive catalogue contents, current-section indication and graph full-width absence.

## Preserved contracts
None.

## Coverage
- product-wiki/catalog: static test review

## Where it is seen
Kind: request
Place: catalogue Table and Graph views at1400,1024,390CSSpixels

1. Open the native519-kind scripted catalogue fixture.
2. At1400px read the right-hand two-level contents and scroll to update the current section.
3. At1024/390px open On this page using the kit Button above content, choose a subsection, and verify arrival plus close.
4. Open Graph at each size: no contents navigation mounts and no contents column is reserved.

## Acceptance evidence
Actual pre-implementation red tests (`/tmp/q27-toc-red.log`, 7 passed and 5 failed), focused catalogue tests (`/tmp/q27-toc-focused.log`, 12 passed with 58 assertions), full wiki/native checks and actual Chromium walks are retained in `/tmp/q27-toc-report.md` and `/tmp/q27-browser-report.md`; final `/tmp/madarch-64o5.27-report.md` records exact results, limitations and independent delivery. No real agent/model run, no unperformed mutation or human visual-review claim. Screenshots and DOM geometry record browser layout.

## Rationale
Independently replayed on integration/2026-11-12c. The pages.tsx import conflict keeps integrated FilterResults and lean catalogue cells. Kind details, stable filtering/pagination, and the pre-existing Graph filtering remain unchanged; .26 graph work is not included. Fresh integration evidence (native wiki check, 22 focused tests, Chromium catalogue 1400/1024/390 English and 390 Russian, and kind-detail 1400/390 English smoke) is recorded in `/tmp/i27-report.md`; mutation was not rerun; the acceptance evidence above is historical. Owner approval and tracker closure remain pending.

## Design and decisions
Use the published catalogue sections and subsections and existing UI kit layout/navigation primitives. Do not keep a second list of kinds/groups or introduce fallback readers.
