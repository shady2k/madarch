# The writer runs as a graph of units: kinds declared by what they read and write, the order derived from those declarations, enrichment kept apart from the person's document, and resumability on the fill's own unit state

Change: madarch-ztyq.4
Base: 5ef36b6e73fa08fd62ce9c1193773a878eaec6af
Tasks: madarch-ztyq.4
Kind: behavior

## Intent
The writer ran one unit for the product page and one per domain the product page declared, so a fill produced two kinds of page and nothing held what the documents say beside them: a use case was translated but never enriched, an ADR was flattened to a paragraph, and a domain page rediscovered the code its scenarios already described. Decision 0032, section 1, replaces that with a graph of unit kinds, each declaring the artifacts it reads and writes; this change builds the graph, the kinds, the order derived from their declarations, the apart store for an enrichment, and the resumability that keeps a finished unit finished when a run is interrupted.

The order is not a list in code: `writerUnitOrder()` (`src/writer/graph.ts`) computes the topological order of the declared reads and writes, ties broken in code point order, and refuses — naming the module, the declaration entry and the artifact — a read nobody writes, one artifact with two producers, or a cycle. A later unit is handed the pages the earlier ones wrote, so "each unit reads what the earlier units produced" is what the unit holds, not a count of its calls.

Enrichment is stored apart from the person's document: a folder per entity kind under the product's enrichment store, one file per passage named by the SHA-256 digest of the entity's identity, whose page id names the entity — the identity the document reader mints from its durable `stableId`, so a renumbered document keeps its enrichment. `fsSink` writes a closed list of page families and refuses a page whose file holds no page of the writer's own, so a document of the product cannot be overwritten by accident or by an agent's mistake.

Every unit is a generation in the fill's own unit tables (a stage named for the writer and the unit's kind, decision 0027), with the digest of what it read and was told: `planned → ready → leased → running → draft → validating → published`, through `src/fill/state-store.ts` as it stands. The state resumes the units no plan names — the graph's own pages and the enrichments: a unit an earlier run published with the same digest and whose page still stands is kept, and a unit that ends without its page is left blocked with its reason for the next run. A unit a plan does name is the plan's: it runs whatever the state remembers, because a person who asked for the page again is answered, and the page's own incremental logic is what keeps a page that stands. The state never fails a run: a step it refuses is reported in `report.stateProblems` with its page, line and reason, the unit goes on, and a unit already published under exactly the same inputs opens nothing.

## Rationale
A person sees the change: two more pages per run (the graph's verdicts and the home page), a page per enriched passage beside each document, and a fill that resumes instead of starting over. Two of the pages are minimal until their own tasks land (madarch-mwhd.1 for the verdicts, madarch-ztyq.7 for the home page), and the marks in the record name them. No capability described the writer's unit graph; the capability `writer-unit-graph` is new and its complete proposed text is in `capabilities/writer-unit-graph.md`, taken from the code as it now stands. No capability file of `docs/system/capabilities/` is changed by this record.

The pages of the three kinds this change adds beside the product page and the domain pages are written only where the
product's manifest declares their kinds (`madarch/kinds.yaml`, decision 0029): a page of a kind the manifest does not
declare is a page no reader could open, so the unit does not run, the run says why, and its absence alone never makes
the run a failure. Every existing check keeps its expectations: the fixtures built from the starter set declare none of
the three kinds, so no unit of them is planned there and no scripted agent has to answer one.

## Out of scope
- The content of the pages a later task defines: the anomaly rules and the jev dispatch (madarch-mwhd.1), the structure of a use case, a rule and an ADR (madarch-ztyq.5), the domain page as business first (madarch-ztyq.6), the one-minute home page (madarch-ztyq.7), in-text links and backlinks (madarch-ztyq.8), the typed revision requests and the rounds of the editorial pass (madarch-ztyq.9).
- Liquid templates and the starter manifest's kinds for the new pages: until a kind is declared in `madarch/kinds.yaml`, a page the writer wrote is not read into the wiki's index (`readKnowledgePages`), which is the manifest's job (madarch-u3vw.1 and the starter set), not the writer's.
- The orchestrator's stage registry as the writer's declaration surface: the kinds are declared in `src/writer/graph.ts` in the shape a stage is declared in, and the run reads them there; publishing them as stages of the fact graph is a separate change.
- A real model run: every committed check answers the writer with a scripted agent, and no check of this change starts an agent.

## Changes to requirements
- writer-unit-graph/kinds (new): the writer's unit kinds and the artifacts each reads and writes are declared once, the run order is the topological order of those declarations with ties in code point order, and a read nobody writes, one artifact with two producers or a cycle is refused with the module, the declaration entry and the artifact named. Scenarios: `order-is-derived`, `a-declaration-moves-a-kind`, `a-read-nobody-writes-is-refused`, `a-twin-producer-is-refused`, `a-cycle-is-refused`.
- writer-unit-graph/prepared-context (new): a unit is handed the pages of the artifacts its kind declares it reads, bounded and in code point order, with what was cut said; a unit whose required artifact no kind of the run produced is reported blocked, naming the artifact and its producer, and never run on a smaller input. Scenarios: `a-later-unit-holds-the-earlier-pages`, `a-missing-required-artifact-blocks`, `nothing-found-says-what-it-looked-for`.
- writer-unit-graph/declared-kinds (new): the graph's own page kinds — the verdicts, the home page and the editorial pass's report — run only where the product's manifest declares their kinds, and a kind it does not declare is reported as a reason and never written: the absence of such a page alone does not make a run a failure. Scenarios: `an-undeclared-kind-is-not-written`, `an-undeclared-kind-does-not-fail-the-run`, `a-declared-kind-runs`.
- writer-unit-graph/enrichment-apart (new): the enrichment of a passage of a person's document is written to a file derived from the entity's durable identity, its page id names that identity, its front matter records the entity and the source lines, and no write of the writer may replace a file of a page family that holds no page of the writer's own or a document of the product at all. Scenarios: `enrichment-is-keyed-by-identity`, `the-source-lines-are-recorded`, `the-persons-document-is-untouched`, `a-page-not-the-writers-is-not-overwritten`, `two-passages-never-share-a-file`.
- writer-unit-graph/resumability (new): every unit is a generation in the fill's unit tables with the digest of what it read, a published unit with the same digest and page is kept, an interrupted run leaves the finished units published, the run after it writes only what is left, and a unit that ends without its page is blocked with its reason for the next run. Scenarios: `a-finished-unit-stays-finished`, `a-resumed-run-writes-what-is-left`, `a-changed-digest-publishes-a-new-generation`, `an-unfinished-unit-is-blocked-with-its-reason`.

Complete proposed capability text: `capabilities/writer-unit-graph.md`. It is the whole capability, not a hand-written delta, and no capability file of `docs/system/capabilities/` is changed by this record.

## Preserved contracts
- product-wiki/pages: the pages of 0029 keep their format and their checks — the front matter, the footnote of grounds on every statement, and the canonical form — and the tools keep their guards for questions, answers, corrections and contradictions.
- product-wiki/front-matter: a page's front matter still says which document entity it is, and the domain and product pages are written by the same units as before.
- product-wiki/stages: `UnitsNeeded` still decides which of the plan's pages a refresh writes.

## Coverage
- writer-unit-graph/kinds: test
- writer-unit-graph/prepared-context: test
- writer-unit-graph/declared-kinds: test
- writer-unit-graph/enrichment-apart: test
- writer-unit-graph/resumability: test
- product-wiki/pages: test
- product-wiki/front-matter: test
- product-wiki/stages: test

## Where it is seen
Kind: internal
Place: a fill of a product, and the pages it writes
Reason: the change is invisible as a design — no screen, message or command is added or altered. What a person reaches is the same pages, written by the same units in the same order for a product whose manifest declares none of the graph's own kinds; what changes is that the writer's unit kinds, their order and their resumability are declared rather than implied.

1. A person presses fill on a product; the pages it writes and the order they appear are what they were, and the graph's own pages appear only where the product's manifest declares their kinds.

