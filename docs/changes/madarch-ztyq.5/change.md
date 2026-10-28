# Scenarios, rules and decisions carry their own structure: a use case its actor, goal, flows, the rules that govern it and what implements it; a rule its statement, where it applies and its exceptions; a decision its status, context, decision and consequences; every place resolved against the graph, and the sequence diagram drawn by the engine

Change: madarch-ztyq.5
Base: e3aee80e6c7e8210a2b9e2555ad1987798ac2e7d
Tasks: madarch-ztyq.5
Kind: behavior

## Intent
The owner read the training product's wiki on 2026-10-24 and found the pages of its documents unfit: «UC очень бедный и без связей», «И вот это, это разве ADR? Мы же договаривались, что будут шаблоны документов?». The code agreed. The writer's units of decision 0032's section 1 — rules and decisions, and scenarios — ran, but each of them wrote one free-form body, so a use case page held whatever sentences a model happened to write, its implementation section said that nothing implements it, and an architecture decision record was flattened to a paragraph. The structure a use case, a rule and a decision have was therefore nobody's: not declared in code, not checked, and not there when a reader looked.

This change makes the structure the core's. A unit of those kinds no longer writes a page body: it gives the fields of its passage's kind — a use case its actor, its goal, its preconditions, its main and alternative flows, the rules that govern it and what implements it; a rule its statement, where it applies and its exceptions; a decision its status, its context, the decision, its consequences and what carries it out — and the writer writes the sections, their headings in the wiki's language and a grounded statement for every part the document or the graph leaves empty. Every place a unit names is resolved against the graph before a byte is written: a route, a function, a table, an event or the section of the document that states a rule, each of the very kind its field holds. The places of the implementation become the page's relates, so the engine draws the use case's sequence diagram from the route the page relates instead of the writer describing a flow in prose.

## Rationale
A person who opens a use case, a rule or a decision in the wiki sees what the passage is, in the same order every time, with links to the code that carries it out and to the rules that govern it. The owner's complaints are answered where he made them: a use case page carries its own parts and its implementation, a decision keeps the four parts of its record, and the structure is declared once, in `src/writer/structured.ts`, rather than improvised per run. Because the place of an implementation is a graph key that resolved at the write, a page can no longer name code the graph does not hold, and a part the documents do not settle is a sentence a reader can see instead of a heading with nothing under it.

No capability described this structure: the capability `structured-entity-pages` is new, and its complete proposed text is in `capabilities/structured-entity-pages.md`, taken from the code as it now stands. No capability file of `docs/system/capabilities/` is changed by this record.

The change is a behavior change, so its units' versions move: `rules-and-decisions` and `scenarios` are version 2 in `src/writer/graph.ts`, and every enrichment of a rule, a decision or a use case is written again on the first run after it, because its page is no longer what the earlier version wrote. A passage whose reading is still open — the document never says what it is — keeps the body the unit writes, since no structure can be declared for a passage nobody has read yet.

## Out of scope
- The LiquidJS template path of decision 0032's section 8 (madarch-u3vw.1): the sections are declared in `src/writer/structured.ts` with a stable id each and their headings per language, and the diagram uses the engine's existing template block. When the Liquid engine lands these declarations become the blocks of a kind template, and the ids they carry are the identities they take there.
- The manifest's kinds for the new pages and a template that asks for the sequence block: until the starter set declares an enrichment kind and its template, a product shows neither these pages nor their diagrams, and the fixture of the committed check declares both for itself. That belongs to madarch-u3vw.1 and the starter set.
- The content of the other units of decision 0032's section 1: the anomaly rules (madarch-mwhd.1), the domain page as business first (madarch-ztyq.6), the one-minute home page (madarch-ztyq.7), in-text links and backlinks (madarch-ztyq.8) and the editorial pass (madarch-ztyq.9).
- A real model run, a mutation run and a change to the tracker: every committed check answers the writer with a scripted agent, and no check of this change starts an agent.

## Changes to requirements
- structured-entity-pages/use-case-page (new): a use case's page carries its actor, its goal, its preconditions, its main and alternative flows, the rules that govern it and what implements it, in the order of its kind, every statement grounded. Scenarios: `a-use-case-carries-its-parts`, `a-part-the-document-leaves-empty-is-said`.
- structured-entity-pages/rule-page (new): a rule's page carries its statement, where it applies, its exceptions and what implements it. Scenarios: `a-rule-carries-its-parts`, `a-rule-the-document-gives-no-exception-for`.
- structured-entity-pages/decision-page (new): a decision's page carries its status, its context, the decision, its consequences and what carries it out, and the person's record keeps its own sections untouched. Scenarios: `a-decision-keeps-its-parts`, `a-decision-with-nothing-in-the-graph`.
- structured-entity-pages/resolved-places (new): every place a page names is a key the graph held when the page was written, of the kind its field holds; a place that does not resolve is a refusal naming the key and the tool that answers it, and the implementation places are the page's relates. Scenarios: `an-unresolvable-place-is-refused`, `a-rule-is-named-by-its-section`, `the-places-are-the-pages-relates`.
- structured-entity-pages/sequence-diagram (new): a use case's sequence diagram is drawn by the engine from the route the page relates, reachability is never shown as order, and a route that reaches no function is said on the page. Scenarios: `the-diagram-starts-at-the-related-route`, `a-route-that-reaches-nothing-is-said`.
- structured-entity-pages/product-language (new): the sections and the title of a structured page are in the wiki's language, and the places keep the graph's names. Scenarios: `a-russian-page-keeps-the-structure`, `an-english-page-names-the-same-places`.

Complete proposed capability text: `capabilities/structured-entity-pages.md`. It is the whole capability, not a hand-written delta.

## Preserved contracts
- product-wiki/pages: the pages the writer writes keep the format and the checks of decision 0029 — front matter, a footnote of grounds on every statement, and the canonical form — and an enrichment page is judged by the same check as the product and domain pages.
- product-wiki/front-matter: a page still says which entity it is, and an enrichment's front matter still names the document entity it enriches, the document and the lines it stands at.
- product-wiki/stages: which pages a refresh writes is still decided by the run's own seam, so a page that stands is not written again, and the enrichment of a passage whose inputs did not move is kept.

## Coverage
- structured-entity-pages/use-case-page: test
- structured-entity-pages/rule-page: test
- structured-entity-pages/decision-page: test
- structured-entity-pages/resolved-places: test
- structured-entity-pages/sequence-diagram: test
- structured-entity-pages/product-language: test
- product-wiki/pages: test
- product-wiki/front-matter: test
- product-wiki/stages: test

## Where it is seen

Kind: internal
Place: a fill of a product whose manifest declares the enrichment kind, and the pages it writes beside the documents
Reason: the change alters pages the writer publishes, not a screen, a command or a message: what a person reaches is the same fill and the same wiki, and what changes is the structure of the pages it writes and the links they carry. No mockup is judged, because no screen the wiki draws changes.

1. Fill a product whose documents hold use cases, business rules and architecture decision records, with an agent answering the writer's units.
2. Open a use case's page in the wiki: it lists the use case's actor, goal, preconditions, main and alternative flows, the rules that govern it and the code that implements it, and its sequence diagram starts at the route the page relates.
3. Open a decision's page: the record keeps its own status, context, decision and consequences, and the page beside it carries the same four parts with the code that carries the decision out.
4. Open the person's document in the repository: it is the same bytes it was before the fill.

## Blocking questions
None.

## Design and decisions
The structure is declared once, in `src/writer/structured.ts`: the fields of each kind, the order of its sections, each section's stable id, its heading in English and Russian, the sentence a gap is stated with, and the JSON schema the unit is answered with; `renderStructuredBody()` writes the Markdown from those declarations. The core, not the unit, owns the sections and their headings, so an empty part cannot be silently absent and a page written in two languages has one structure.

A place is a key, never a description of one: `implementation.routes` holds code.route keys, `implementation.functions` code.symbol keys, `implementation.tables` code.table keys and `implementation.events` code.channel keys, and a rule is the `doc:` address of the section that states it, as the tool `get_document_sections` answers it. `UnitTools.resolvePlaces()` resolves every one of them against the graph at the last filled commit and refuses the write when one does not resolve, naming the key, its field and the tool that answers it; the names it read are what `renderStructuredBody()` shows for the places, so a page never puts an agent's wording on an entity of the graph.

The diagram is not the writer's: the implementation keys are the page's relates, and the page's kind template asks the engine for its sequence block, which walks the graph from the route. The writer checks that the route reaches something with the same reader the tool `trace_flow` answers with, and states the gap where it does not.

Two decisions of the renderer are deliberate. A footnote label the core writes is a number, because the writer names a statement for what it says and keeps the name a sentence had on the page it replaces, and a label such as `s1` would freeze a position as an identity. And a gap is phrased about the document or the graph, not about the world — "the graph holds no route and no function for this use case" — because a missing edge is never proof of absence (decision 0032, section 3).

## Acceptance evidence
- One command on the pod, on the branch's worktree as it stands (the change is not committed), eight gigabytes of memory and the performance tests skipped: `bun run check && bun test` over the thirty-two `test/writer*.test.ts` files `&& bun test` over the seven writer-running files. It ended with `MADARCH_TESTS_EXIT=0` after 877 seconds: `tsc --noEmit` clean, 406 tests passed and none failed across the thirty-two files, 92 tests passed and none failed across the seven.
- The seven writer-running files are `test/knowledge-agent.test.ts`, `test/loop-training.test.ts`, `test/loop-refresh.test.ts`, `test/madarch-init-e2e.test.ts`, `test/questions-once-script.test.ts`, `test/fill-intent-history-stage.test.ts` and `test/wiki-links.test.ts`.
- The new check `test/writer-structured-entities.test.ts`, one of the thirty-two, proves the four use cases of the training product, its five rules and its two records against the answer key's flows and the repository's own declarations, renders a use case's page through the engine to read the sequence diagram the page carries, and hashes every Markdown document of the repository before and after the run.
- The cluster could not be provisioned by the wrapper's own launch, which exited 3 on a pool whose two large nodes were taken; the same recipe ran through the documented queued launch, which retried until a slot freed.
- No mutation run was made: it waits for the milestone's closure (madarch-j6ho.3), as the writer's earlier change did, and no model run was made, because a real agent needs the owner's yes.

## DONE WHEN
A fill of the training product's wiki writes three kinds of page beside the person's documents. Each of its four use cases gets a page that links the route a person comes in by, the functions that do the work, the table it writes and the event it publishes, names the business rules that govern it, and carries a sequence diagram drawn from that route. Each of its five business rules gets a page with the rule's statement, where it applies, its exceptions and its implementation. Each of its two architecture decision records gets a page with status, context, decision and consequences and the code that carries them out. Every Markdown document of the repository is byte-identical to what it was before the run.
