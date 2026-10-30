# A committed walk checks every page of a product through its JSON and CI holds the five classes to a baseline

Change: madarch-j6ho.1
Base: 1b55fdf3bde820b496c17133fd09601404b2833c
Tasks: madarch-j6ho.1
Kind: behavior

## Intent
The milestone's one-off walk of 1 528 pages becomes a committed runner. `scripts/wiki-walk.ts` reads the product's status, every kind's catalogue, every entity page in each interface language the manifest declares, and every document page through the wiki server's JSON responses, and reports each empty section, raw key, passage outside the wiki's language, raw id and node drawn without evidence with its page, section, field and value. A clean product exits 0, a finding exits 1, and a page the server will not answer or a truncated document listing exits 2 with the address.

The walk runs in CI as a ratchet. `scripts/wiki-walk-ci.ts` generates the training repository, fills and serves it, walks it in English and Russian, and compares the per-class counts with `scripts/wiki-walk-baseline.json`; a class above its baseline count, or a class the baseline does not name, fails the job. `test/wiki-walk.test.ts` serves a fixture and plants one defect of each class.

## Out of scope
- Fixing the pages the walk finds; the runner reports them and the ratchet holds the current counts.
- Judging a quotation or a one-word name as prose in another language beyond the detector's declared rules.
- Walking a product other than the training product in CI, or turning the ratchet into a threshold of zero findings.

## Rationale
The owner asked the coordinator to walk every section and every page himself and asked why a browser was needed when the graph and the files exist. A committed script answers both: it reads the wiki's own JSON rather than a rendered screen, names each finding with its page and field, and fails CI on a planted violation of every class instead of relying on a person's one-time pass. The baseline lets the walk land on a product that still has findings without hiding a new class or a regression.

## Changes to requirements
- wiki-walk/five-classes (new): the committed runner checks every page through the wiki's JSON for empty sections, raw keys, foreign-language passages, raw ids and nodes without evidence, and exits 0, 1 or 2 accordingly. Scenarios: `every-class-is-found`, `clean-product-exits-zero`.
- wiki-walk/ratchet (new): CI walks the generated training product in both languages and fails when a class count exceeds its baseline or the baseline names no such class. Scenarios: `counts-hold-at-baseline`, `unnamed-class-fails`.

## Preserved contracts
- product-wiki/pages: the walk reads the pages the wiki already serves and changes no page, route or rendering; it reports what the existing page readers return.

## Coverage
- wiki-walk/five-classes: test
- wiki-walk/ratchet: test
- product-wiki/pages: test

## Where it is seen

Kind: internal
Place: the CI walk over the training product's wiki, and the command a person runs on a filled product
Reason: the change adds a runner and a CI ratchet, not a screen: the wiki and its pages are unchanged, and what a person reads is the walk's report and CI verdict.

1. Run `bun scripts/wiki-walk.ts` against a served product and read one line per finding with its page, section, field and value, or the exit code that says the product is clean.
2. Plant one empty section, one raw key, one foreign-language passage, one raw id and one node without evidence, and see each reported as exactly its class.
3. Open a pull request and see the ratchet walk the generated training product in English and Russian and fail when a class count rises.

## Blocking questions
None.

## Design and decisions
The walk reads the same JSON the wiki app reads: the status, each kind's catalogue, entity pages by interface language and document pages. The language judgment uses `tinyld`: outside the expected script a passage is foreign, and inside one script the detector must name another language with at least eight words and 0.25 confidence; a sentence is judged span by span, a heading as a title, and a one-word name is read for ids only; quotations are never judged. The test plants one finding of each class on a served fixture, so each detector is exercised on its cited input. The baseline file records one count per class for the training product, so CI fails on a class the file does not name as well as on a rise.

## Acceptance evidence
- PR #186 (`482362c8`) added `scripts/wiki-walk.ts`, `scripts/wiki-walk-ci.ts`, `scripts/wiki-walk-baseline.json` and the CI step in `.github/workflows/ci.yml`.
- `test/wiki-walk.test.ts` serves a fixture with one planted defect per class and holds the clean product.
