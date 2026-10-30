# The home page is a one-minute overview of the product in eight sections, and the rest of its history is one bounded line and the five files that change most, with the whole list one link away

Change: madarch-ztyq.7
Base: 96b0558801d17eacdeecd2a604351aca89a62ee2
Tasks: madarch-ztyq.7
Kind: behavior

## Intent
The owner opens the wiki to understand the product in a minute. The home page did not do that: the product unit and the overview unit each wrote a free-form body, the product page carried the whole repository history and a treemap and a relation table, and the overview unit could only describe pages instead of pointing at them. Two units that were meant to write the same page could say different things, and a product whose graph held twenty repositories got twenty summaries and as many hotspot tables where the page promised a minute.

This change makes the home page one core-owned shape: eight sections in the order a reader reads them, written from fields a unit fills, with a grounded sentence for every part the documents and the graph leave empty. The product page and the overview page are the same shape at two moments of a run; the overview is written last and may point at the pages the run published, giving each the label a reader can read. Every place a section points at is resolved before a byte is written, every declared domain appears in the domains section, and an empty product gets the core's eight gap sentences rather than invented facts or an empty page. The app's home keeps the overview and a compact rest of at most six rows — one line of history totals and the five files that change most — and the whole list of files is one link away. The product history is projected once across all repositories, so its budget bounds the page rather than each repository.

The same work closes the app failure PR #205 carried at `2150324f`: after the plural families landed, the home history summary badges asked the catalogue for the figure kind's key with no count, so the browser showed the raw key instead of "1 commit". The badges now go through the same `figureTitle` path as every other figure, and the app's duplicated list of counted kinds is replaced by the writer's `COUNTED_FIGURES`, so English and Russian resolve through one plural family. The genuine CI failure was the home badge; the other `error:` lines in the CI log are logged inside passing tests and are not this branch's failures.

## Rationale
A person who opens the wiki now gets the whole product in one read: what it is and for whom, its main scenarios, how the system is put together, its domains, the rules and decisions that matter, its technology and size, how complete the wiki is, and what is not connected. Each section sends the reader to the page that says it in full instead of repeating it, so the home page stays a minute and the detail stays where it belongs. The page is the core's in the same way the domain page is (madarch-ztyq.6): a unit gives the parts, the core owns the headings and order, and a part it cannot fill says so rather than disappearing or being invented. The app's rest is bounded for the same reason: a history block that grew with every repository was the opposite of a one-minute page.

No capability described this writer page: the capability `home-page` is new, and its complete proposed text is in `capabilities/home-page.md`.

## Out of scope
- The LiquidJS template path of decision 0032's section 8 (madarch-u3vw.1): the eight sections are declared in `src/writer/home-page.ts` with a stable id each and their headings per language. When the Liquid engine lands these declarations become the blocks of a kind template, and the ids they carry are the identities they take there.
- The editorial pass and the owner's reading (madarch-ztyq.9): the pages are judged here by their structure, their grounds and the suites that read them; a person's reading of the shop's home page at milestone acceptance is that task's.
- The prepared-context packet of decision 0032's section 2 as a shape of its own: the home units are handed the graph, the documents and the pages of the run as every unit of the writer is; a unit-specific packet is madarch-u3vw.1's.
- A full visual redesign of the app's home screen: this change rearranges what the existing page holds below the overview and fixes the language of its history figures. The navigation, the page chrome and the other screens are not changed.
- The history block's other sections on entity pages: they keep their existing shapes and defaults; only the product home asks for the compact summary and hotspots.
- A real model run, a mutation run and a change to the tracker: every committed check answers the writer with a scripted agent, and no check of this change starts an agent.

## Changes to requirements
- home-page/eight-sections (new): a home page is eight sections in the order a reader reads them, with headings owned by the core in the wiki's language, and the product page and the overview page carry the same shape at two moments of the run. Scenarios: `the-page-is-eight-sections`, `a-ru-page-carries-the-same-sections`, `the-overview-page-is-the-same-home`.
- home-page/grounded-places (new): every section points at a page that says it in full; every place and ground resolves at the last filled commit; every declared domain appears; a page this run published is pointed at with a reader's label; a refusal names the field and writes nothing. Scenarios: `an-unresolved-place-is-refused`, `a-refusal-names-its-field`, `every-declared-domain-is-named`, `a-published-page-is-pointed-at-by-its-label`.
- home-page/fields-and-gaps (new): the unit gives fields, not a body; every field is parsed before the page is judged; `whatItIs` is required; an unknown field is refused; an empty part says its gap; an empty product is the core's eight gap sentences with no invented ground. Each gap sentence carries a core-written marker naming the section the core left empty and the sentence's digest; `checkPage` accepts a gap only through that marker, so a copied sentence without one stays ungrounded. Scenarios: `what-the-product-is-is-required`, `an-unknown-field-is-refused`, `an-empty-part-says-its-gap`, `an-empty-product-is-eight-gap-sentences`.
- home-page/one-minute-rest (new): the app's home keeps the overview and at most six rows outside it — one line of history totals and the five files that change most — and links the whole list of files in the reader's language; the product history is projected once across repositories, so the limit bounds the page and not each repository. Scenarios: `the-rest-fits-in-six-rows`, `the-rest-links-to-the-whole-list`, `many-repositories-stay-one-budget`.
- home-page/counted-figures (new): every history figure and title counts in its numeral's own form, in English and Russian, through the shared counted-figure families; no app-local list of counted kinds decides a plural. Scenarios: `a-figure-says-one-commit`, `a-russian-figure-takes-its-form`, `one-list-names-the-counted-figures`.

Complete proposed capability text: `capabilities/home-page.md`. It is the whole capability, not a hand-written delta.

## Preserved contracts
- product-wiki/pages: a home page is still a Markdown page with the set's form and the same `checkPage` judgment — its front matter, its footnotes and its canonical form — and a page whose fields are refused is not written.
- product-wiki/front-matter: the page still names its id, kind and title, links the graph keys it stands on in `relates`, names the documents it stands on in `sources`, and names its producer.
- product-wiki/overview: the manifest's overview block still projects the graph's kinds, own relations and documents for the wiki's overview page; the writer's home page is a different page and does not replace that projection.
- product-wiki/internationalization: the app still speaks English and Russian through paired catalogues, and counts and relative times still follow the selected language through the shared plural rules; the home history figures now take their forms from those same families through one counted-kind list, not an app-local list.

## Coverage
- home-page/eight-sections: test
- home-page/grounded-places: test
- home-page/fields-and-gaps: test
- home-page/one-minute-rest: test
- home-page/counted-figures: test
- product-wiki/pages: test
- product-wiki/front-matter: test
- product-wiki/overview: test
- product-wiki/internationalization: test

## Where it is seen

Kind: internal
Place: a fill of a product, the home page the writer publishes, and the home page the wiki app serves
Reason: the change alters a page the writer publishes and how the existing home screen holds its history, not a new screen, command, request or log: a person reaches the same fill and the same wiki home, and what changes is what the page says, in what order, and what its history rows count.

1. Fill a product whose documents hold a vision, use cases, rules and decisions, and open the wiki's home page: it reads as eight sections, each pointing at the page that says it in full.
2. Open a product whose pages are Russian: the same eight sections in the same order, with Russian headings, and the history figures count in Russian.
3. Open a product with several repositories: below the overview stand one line of history totals and the five files that change most, not one summary per repository.
4. Follow "All files" from the compact history: the kind's listing opens, and a summary badge reads "1 commit" rather than a catalogue key.

## Blocking questions
None.

## Design and decisions
The page's shape is declared once, in `src/writer/home-page.ts`: the eight section ids, the field each is written from, the order they stand in, the heading in English and Russian, the gap sentence a section says when its part is empty, and the JSON schema the unit is answered with. `renderHomePage()` writes the Markdown from those declarations, front matter included, so the core owns the page and no section can be silently absent. `renderEmptyHomePage()` uses the same eight declarations and the core's gap sentences when the graph holds no document and no content node. Each gap sentence is preceded by `<!-- madarch:empty-product-gap:<section>:<sha256> -->`, written by `src/writer/empty-product-gap.ts` and read by `checkPage` from the parsed page: the marker names the section the core left empty and the digest of the one sentence it identifies, so a gap is admitted without a ground only when both the section and the digest agree, and a sentence that copies a gap's words without a marker remains ungrounded. No gap sentence is compared as text. Canonical output keeps the marker, so an unchanged empty page keeps its bytes.

A section is either statements or places. A place is a target, the sentence the page says about it and the grounds of that sentence: `domain:<slug>`, `doc:<path>#<anchor>`, a graph key, or a page this run published. Every target is resolved before the write; `domain:` must be one of the declared domains, `doc:` must be a section the document has at that commit, a graph key must be a node of the graph, and a published page must come with the label a reader sees. A refusal quotes the field path (`fields.scenarios[0].target`) so a unit fixes the field rather than searching the page. Every declared domain must appear in the domains field, and the declared domains and the places the page names are its `relates`.

The overview unit runs last and is given the ids of the pages this run published; the product unit is given the domains and writes first. Both use the same home tool and the same page shape. The app's `product.liquid` keeps the manifest's overview, then the system map, then a history block asked for `summary,hotspots` with `limit=5` and `more-kind="code.file"`; the host page no longer carries the treemap or the relation table. `historyBlock` keeps only the sections a template names, refuses a name it does not read with the names it does, and adds the kind's listing as `more`; `foldLanguageParams` gives `more-ru` and `title-ru` to the reader's language. `projectHistoryAcross()` merges every repository's evidence by graph identity, so a shared author or commit is counted once and the limit bounds the product rather than each repository.

The app's figure path is one path: both the visible value and the badge title go through `figureTitle(figure)`, which uses the numeral's counted form, and the set of counted kinds comes from `COUNTED_FIGURES` in `src/knowledge/history-figures.ts`. That is what makes the summary badge show "1 commit" in English and the Russian form in Russian after the plural families landed.

**The merge with #202.** The home page's fields and gap markers stay as this change wrote them. #202's mention linker reads the parsed page and links only prose, and `write_page` gives it the product's names through the same `checkPage`; the walk baseline takes the merged lowering (`empty-section` 3252, `foreign-language` 6355).

## Acceptance evidence
Red first: at the branch head `2150324f`, `bun test src/knowledge/knowledge.test.tsx -t 'every history figure counts'` in `wiki/app` failed with expected `"1 commit"` and received `"knowledge.historyFigure.commits"` (0 pass, 1 fail, 2 expect calls). The same test after the fix passes with 1 pass and 4 expect calls, and the full `knowledge.test.tsx` and `i18n.test.ts` run gives 95 pass, 0 fail and 2625 expect calls. `bun run check` exits 0 at the repository root and in `wiki/app`. The touched writer and knowledge suites pass: 61 tests in `writer-home-page`, `knowledge-history-product` and `writer-agent-tools`; 58 tests in `writer`, `writer-graph`, `writer-guide-graph-bound` and `writer-journal`; 29 tests in `knowledge-agent` and `knowledge-diagrams`; 16 tests in `knowledge-home-page` and `loop-refresh` — 259 pass, 0 fail, 4186 expect calls across the touched suites. The document gate's raw output, digest and the exact commands are in `/workspace/repo/out/report-ztyq7ci.md`. The full repository suite was not run; the suites above are the touched ones.

## DONE WHEN
A fill writes the product and overview pages as one home page in eight fixed sections, each pointing at a page that says it in full; every place and ground resolves before the page is written, every declared domain appears, and an empty product is the core's eight gap sentences. The app serves the same home page with one line of history totals and the five files that change most, links the whole file list in the reader's language, and counts every figure in its numeral's own form in English and Russian. A multi-repository product's history is bounded once, and no Markdown the run did not write is changed.
