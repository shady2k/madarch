# History and time answer the reader's questions from indexed evidence

Change: madarch-mwhd.2
Base: 6913d38b561017f46fc158d5c2aa1224ee167da0
Tasks: madarch-mwhd.2
Kind: behavior

## Intent
A reader needs to find what changes most, which files change together, who
has contributed to a module, what a merge or move did, and how a part looked
at a date without reading raw graph properties. The milestone's defect 16
and O1 require the training answer key's history and temporal facts to be
shown fully on a fresh fill. Accurate evidence and explicit coverage matter
more than an apparently complete story over missing history.

## Rationale
The baseline is origin/main at Base above, including the wiki-for-people
charter. The history extractor already records commits, raw and effective
times, first-parent membership, merges, authors, touched files, rename links,
change coupling and snapshot trees. Existing history blocks serve tasks,
commits and authors, but do not give the required repository, file, module
and snapshot reading. Decision 0030 parses the tip first and earlier trees
only at chosen points; merely naming a snapshot does not parse its code.
The complete proposed product-wiki capability retains the baseline verbatim
and adds readable-history and dated-history. Current capability files are
not changed before acceptance.

## Out of scope
- General code, contracts, data-model and operations extraction owned by madarch-m38l.20.
- General page-content cleanup, members, navigation and shared details formatting owned by madarch-m38l.21; only history-specific templates and blocks are owned here.
- Diagrams owned by madarch-m38l.15, questions and prose-writing work owned by madarch-m38l.22, and broad graph validation owned by madarch-mwhd.1.
- Parsing every historical commit, extrapolating across unread intervals, or treating authorship as organizational ownership.
- Real agent runs, owner infrastructure, outside repositories in committed tests, or product-specific text stored in the engine.

## Changes to requirements
- product-wiki/readable-history (new): evidence-linked history summary, hotspots, coupling with both single-file counts, module authorship, feature-branch merges, rename continuity and raw/effective date explanations.
- product-wiki/dated-history (new): covered snapshot navigation and source/structure reads, the seven temporal answer-key scenarios, retained date context and explicit uncovered-date behavior.

Complete proposed capability text: capabilities/product-wiki.md.

## Preserved contracts
- product-wiki/pages: product Markdown and templates remain the reader's pages; the engine stores no product prose.
- product-wiki/internationalization: reader-facing labels and explanations support English and Russian.
- product-wiki/serve: existing addresses continue to work; historical context is additive.

## Coverage
- product-wiki/readable-history: test, generated-history-answer-key, history-json-walk, browser-walk
- product-wiki/dated-history: test, generated-history-answer-key, history-json-walk, browser-walk
- product-wiki/pages: test
- product-wiki/internationalization: test, browser-walk
- product-wiki/serve: test

## Where it is seen

Kind: screen
Place: a product's history summary, file, module, author, merge and dated snapshot pages in the knowledge wiki
Mockup: docs/changes/madarch-mwhd.2/history-mockup.html

1. Open history from the filled product, read its totals, authors and period, and follow the leading hotspot to its complete file history.
2. Follow pricing.go to its change-coupling counts and providers to its observed authorship, with links to the commits and source.
3. Open the feature merge, the order.go move and the date-anomaly commit; read their explanation without raw keys.
4. Select a declared snapshot date and follow a part's source, statuses or contracts in that dated context; an uncovered date says what was not read rather than showing today's code.
5. Repeat in English and Russian at 1150 px and 390 px, light and dark; read the same pages through the JSON API.

## Blocking questions
None.

## Design and decisions
- Extend the existing history block and graph reads, not a parallel database or per-page Git walk. Keep reads repository-scoped, deterministic and code-point sorted. Compute aggregate totals before display limits; show any coverage gap explicitly.
- Join a file's history across rename identity without double-counting the move. Show a co-change relationship separately from imports. Preserve authoredAt, committedAt and effectiveAt as distinct facts.
- Reuse the driver's chosen-point fill and the temporal graph for historical structure. Prepare the training product's declared points during its fresh fill. Historical source comes from the pinned blob, not the working tree. The concrete date-selection and coverage plumbing needs design review before implementation; decision 0030's coverage policy is not weakened.
- Likely shared seams are src/knowledge/graph-read.ts, the block model/renderer and bilingual catalogues, history entries in src/knowledge/seed.ts and the fill caller for chosen points. Coordinate these narrow edits with the page-content worker; do not rewrite their general template work. Any changes outside src/extract/history and history-specific reading are listed in the final report.
- This is a behavioral proposal, not implementation evidence. The static mockup illustrates the information hierarchy; actual rendering and exhaustive API checks remain mandatory after implementation.

## Acceptance evidence
- Baseline read: task madarch-mwhd.2, charter defect 16, answer-key fixtureVersion 3, decisions 0028 and 0030, history extractor and existing history block. No baseline test or fill was run locally.
- TDD on the AVX2 SkyPilot pod: extend fixture-based extraction, chosen-point, history rendering and route tests. Run bun run check plus focused tests there; full engine and app suites run through CI. Use only the scripted ACP test agent.
- generated-history-answer-key: check every history.* and temporal.* item plus hotspot, change-coupling, provider-authorship, rename.identity and date-anomaly, using generated repository facts. Expected figures are test oracles only, never production prose.
- history-json-walk: enumerate every changed kind and page through /products/<p>/api/k/entities?kind=<kind> and /products/<p>/api/k/page?id=<id>&lang=ru on the pod, following all pages and pagination rather than a sample. Verify the dated reads in both languages, full counts, evidence links and no silent historical fallback.
- browser-walk: render every touched page kind using the relevant shots script on the pod at 1150 px and 390 px, light and dark, in both languages; seed role everything before walking, inspect the images personally, and record every screenshot path and any limits.
- Run bounded mutation checks over changed logic within the project's ten-minute budget. Obtain read-only Codex review before the PR and fix findings that hold. Merge current origin/main before the final push, require green CI on the final head, hand the PR to the owner and do not merge it.
- Pending: proposal approval, implementation, all pod checks, mutation, rendering, exhaustive JSON walk, independent review, PR and CI.

## DONE WHEN
A fresh training-product fill fully shows every history.* and temporal.*
answer-key item and the hotspot, coupling, provider-authorship, rename and
date-anomaly items through readable evidence-linked pages. The seven dated
scenarios show their own snapshot's code and structure rather than today's;
unknown coverage is explicit. Counts follow the answer key's populations,
renames keep one history, observed contributions are not ownership, and
English/Russian pages pass the exhaustive JSON walk and inspected desktop
and phone renders in both themes. Focused pod checks, mutation and independent
review are recorded, and the open PR has green CI on its final head.
