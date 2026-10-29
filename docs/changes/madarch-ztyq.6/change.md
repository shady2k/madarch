# A domain page explains the business: who takes part, the main scenario in plain steps, the rules that govern it, what can go wrong and what is open; the code — routes, codes, headers, timeouts — stands in one section for the developer at the end

Change: madarch-ztyq.6
Base: 8b49a8f9cbb4c094bea43600f3a687c1ed0b233d
Tasks: madarch-ztyq.6
Kind: behavior

## Intent
The owner opened the checkout domain page of the training product on 2026-10-24 and asked: «Ну и вот посмотри, что из этой страницы можно понять?». The page listed HTTP codes, headers and timeouts, and its «Участники» were a list of services. The code agreed with the reading. The domain unit of decision 0032's section 1 wrote one free-form page: the shared prompt asked it to go "from the services down to the functions that do the work", and a section of its own prompt asked it to compare how neighbouring operations handle timeouts, retries and error answers, which is a code review written for a developer. Nothing in the writer said what a domain page is for, so what a reader got depended on what the model chose to write.

This change makes the page's shape the core's, and puts the business first. A domain unit no longer writes a page body: it gives the participants as roles and systems in plain words, the main scenario as numbered steps, the rules that govern the domain, what can go wrong, what is open, and the places of the code for one section at its end. The writer writes the sections, their headings in the wiki's language, and a grounded sentence for every part the documents leave empty. A business field refuses a place of the code by the key it names, and says where that key belongs. The unit writes from the enriched use cases, rules and decisions the earlier units produced, so the domain page tells a fact the same way the pages it came from tell it, and reads the code only for the developer section.

## Rationale
A person who opens a domain page now learns what the part of the product does, who takes part, how it goes and what can go wrong, in words that need no code to follow, and finds the routes, status codes, headers and timeouts where a developer looks for them: at the end, under their own heading. The owner's question is answered where he asked it — the page says something a reader can understand — and decision 0032's sections 1 and 6 are carried out as written: the unit summarises instead of rediscovering, every statement stands on the graph or a document, and a fact the documents leave open is said as an open point rather than invented.

No capability described the writer's domain page: the capability `domain-page` is new, and its complete proposed
text is in `capabilities/domain-page.md`.

## Out of scope
- The LiquidJS template path of decision 0032's section 8 (madarch-u3vw.1): the sections are declared in `src/writer/domain-page.ts` with a stable id each and their headings per language. When the Liquid engine lands these declarations become the blocks of a kind template, and the ids they carry are the identities they take there.
- The editorial pass and the owner's reading (madarch-ztyq.9): the pages the fixture writes are judged by their structure and their grounds here, and a person's reading of the shop's pages at milestone acceptance.
- The prepared-context packet of decision 0032's section 2 as a shape of its own: the unit is handed the subgraph and the pages of the units it reads, as every unit of the writer is; a unit-specific packet is madarch-u3vw.1's.
- A real model run, a mutation run and a change to the tracker: every committed check answers the writer with a scripted agent, and no check of this change starts an agent.

## Changes to requirements
- domain-page/business-first (new): a domain page carries Participants, Main scenario, Rules that govern it, What can go wrong, Open points and For the developer, in that order, the headings in the wiki's language. Scenarios: `the-page-opens-with-the-business`, `a-ru-page-carries-the-same-sections`.
- domain-page/participants-and-steps (new): participants are roles and systems in plain words and the main scenario is numbered steps, each statement grounded, and a gap the documents leave said on the page. Scenarios: `participants-are-plain-words`, `the-main-scenario-is-numbered`.
- domain-page/code-detail-belongs-to-the-developer (new): the places of the code stand only in the developer section, a business field refuses a code key by name and says where it belongs, and the developer places are the page's relates. Scenarios: `a-code-key-in-a-business-field-is-refused`, `the-developer-places-are-the-pages-relates`.
- domain-page/open-points (new): an ungrounded statement is refused and what the documents leave unsaid is said as an open point or a gap sentence, never invented. Scenarios: `an-ungrounded-statement-is-refused`, `a-field-the-documents-leave-empty-is-said`.
- domain-page/summary-of-earlier-units (new): the unit writes from the enriched scenarios, rules and decisions of the earlier units. Scenario: `the-unit-is-handed-the-earlier-pages`.

Complete proposed capability text: `capabilities/domain-page.md`. It is the whole capability, not a hand-written delta.

## Preserved contracts
- product-wiki/pages: a domain page keeps the format and the checks of decision 0029 — a front matter that names the entity and its kind, a footnote of grounds on every statement, and the canonical form — and it is judged by the same `checkPage` as the product page.
- product-wiki/front-matter: the page still says which domain it is, links the product, and names the documents it stands on, and its `relates` holds only graph keys.
- product-wiki/stages: which pages a refresh writes is still decided by the run's own seam, so a page that stands is not written again, and the page of a domain whose inputs did not move is kept.

## Coverage
- domain-page/business-first: test
- domain-page/participants-and-steps: test
- domain-page/code-detail-belongs-to-the-developer: test
- domain-page/open-points: test
- domain-page/summary-of-earlier-units: test
- product-wiki/pages: test
- product-wiki/front-matter: test
- product-wiki/stages: test

## Where it is seen

Kind: internal
Place: a fill of a product whose domain pages the writer publishes, and the pages it writes beside the person's documents
Reason: the change alters pages the writer publishes, not a screen, a command or a message: what a person reaches is the same fill and the same wiki, and what changes is what a domain page says and in what order. No mockup is judged, because no screen the wiki draws changes.

1. Fill a product whose documents hold use cases, business rules and architecture decision records, and whose product page declares its domains.
2. Open a domain page in the wiki: it lists who takes part in plain words, the main scenario as numbered steps, the rules that govern it, what can go wrong and what is open, and its last section is the developer's.
3. Read the same page in a product whose pages are Russian: the same sections in the same order, with Russian headings.
4. Look for a status code, a header or a timeout on the business part of the page: there is none, and the developer section says how the domain is carried out.

## Blocking questions
None.

## Design and decisions
The page's shape is declared once, in `src/writer/domain-page.ts`: the six sections, the order they stand in, each
section's stable id, its heading in English and Russian, the sentence a section says when the documents leave it
empty, and the JSON schema the unit is answered with. `renderDomainPage()` writes the Markdown from those
declarations, front matter included, so the core owns the page and a part cannot be silently absent.

A field is business or developer, and the boundary is the kind of the key a statement stands on rather than a rule
about words: `participants`, `mainScenario`, `rules`, `whatCanGoWrong` and `openPoints` accept document sections and
`code.service` keys, and a route, a function, a table or a channel there is refused with the field, the key and the
section it belongs to. `developer.routes`, `.functions`, `.tables` and `.events` hold those keys, each resolved
against the graph at the last filled commit, and `developer.notes` holds the sentences that state codes, headers and
timeouts, each grounded on those keys. The developer keys and the services the participants name are the page's
`relates`, so the engine can draw from them.

Two decisions of the renderer are deliberate. The main scenario is a numbered list, because a reader follows it in
order and the statement parser already reads a numbered line as a statement of its own, so each step keeps its own
footnote (decision 0029). And a gap is phrased about the document or the graph, not about the world — "The documents
name no rule that governs this domain" — because a missing edge is never proof of absence (decision 0032, section 3).

The prompt of the domain unit changes with the page: it no longer asks for a walk from the services down to the
functions, and its old section about comparing timeouts and retries is gone. It asks for the business fields first,
names the developer section as the one place where the code is stated, and tells the unit that the pages of the
earlier units are its source.

## Acceptance evidence
Filled at the push: one command on the pod over the touched test files and the writer-running set, with the check
before them.

## DONE WHEN
A fill of the training product's wiki writes every domain page of the product as the business first: the
participants as roles and systems in plain words, the main scenario as numbered steps, the rules that govern the
domain, what can go wrong and what is open, and a developer section at the end. No status code, header or timeout
stands outside that section, a statement the unit cannot ground is refused instead of written, and every Markdown
document of the repository is byte-identical to what it was before the run.
