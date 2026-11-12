# Open every kind declaration before the first fill

Change: madarch-64o5.31
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.31
Kind: behavior

## Intent
A kind link opens its full declaration before any fill, instead of the product-wide empty-wiki introduction. The catalogue and fill list stay short; detail belongs on the kind page.

## Out of scope
Running a real agent or model, interpreting kinds in engine-owned readers, changing fill execution or record templates.

## Changes to requirements
- product-wiki/catalog: replace the catalogue requirement with the complete pre-fill kind-page contract and compact navigation contract.

## Preserved contracts
None.

## Coverage
- product-wiki/catalog: static test review

## Where it is seen
Kind: request
Place: /kind/goal from the catalogue of a newly started product

1. Start a fixture product with a published catalogue and no filled records.
2. Follow the goal kind link; read its declaration, sources and manifest location, fields, relations, graph, producer, state and empty records message.
3. Open the catalogue and fill list; their short rows link to kind pages without question-mark popovers.
4. Switch English and Russian; declared field labels follow the selected language without engine columns.

## Blocking questions
None.

## Acceptance evidence
Focused checks: `test/knowledge-catalog-declaration.test.ts`, `test/manifest-publication.test.ts`, `wiki/app/src/knowledge/publication.test.tsx`, `kind-details.test.tsx` and `kind-sources.test.tsx`. Native checks and results are recorded in `/tmp/madarch-64o5.31-report.md`. Mutation: not-made; no mutation run or score is claimed. Review: `/tmp/q31-review.md` final addendum reports no remaining code-review blockers. No owner approval is recorded here.
