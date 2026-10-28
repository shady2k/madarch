# Writer unit graph
Capability: writer-unit-graph

## Purpose
The writer runs as a graph of unit kinds. Each kind declares the artifacts it reads and the artifacts it
writes; the run order is derived from those declarations; a unit is handed the pages of the artifacts its
kind reads; the enrichment of a passage of a person's document is stored apart from the document, keyed by
its identity; and every unit is a generation in the fill's own unit state, so an interrupted run resumes.

## Requirement: kinds — The writer's unit kinds and the artifacts each reads and writes are declared once, in code point order of the kind's nam

The writer's unit kinds and the artifacts each reads and writes are declared once, in code point order of
the kind's name, and the run order is derived from those declarations alone: a kind is ready when every
artifact it reads is written by a kind already ordered, and among the ready kinds the smallest name goes
next. A declaration is refused with the module, the declaration entry and the artifact named when a kind
reads an artifact nobody writes, when two kinds write one artifact, when a kind reads what it writes, or
when the reads make a cycle (in which case every kind that never became ready is named with what it still
waits for).

Scenario `order-is-derived`: the declares of `src/writer/graph.ts` give the order document-interpretation,
graph-validation, product, rules-and-decisions, scenarios, domains, guides, overview, editorial.
Scenario `a-declaration-moves-a-kind`: a kind that declares it reads an artifact moves after the kind that
writes it, and the order the run follows moves with it.
Scenario `a-read-nobody-writes-is-refused`: removing a producer while a kind still reads its artifact is a
problem naming the reading declaration and the artifact.
Scenario `a-twin-producer-is-refused`: two kinds writing one artifact is a problem naming both kinds.
Scenario `a-cycle-is-refused`: a cycle yields no order and names the kinds that never became ready.

### Scenario: a-declaration-that-does-not-fit-is-refused
- Given: a graph whose kinds read an artifact nobody writes, or name two producers of one artifact, or hold a cycle
- When: the declarations are read
- Then: the run is refused with the module, the declaration entry and the artifact named, and no unit runs

## Requirement: prepared-context — A unit is handed the pages of the artifacts its kind declares it reads, in code point order, cut at a stated number of characters and pages with the cut and the remainder said

A unit is handed the pages of the artifacts its kind declares it reads, in code point order, cut at a
stated number of characters and pages with the cut and the remainder said. A kind that requires an artifact
no unit of the run produced is reported `blocked`, naming the artifact and the kind that owes it, and its
units do not run: no unit runs on a smaller input than its declaration names. A kind whose inputs hold
nothing to run is reported `nothing-found` with the reason it looked and found nothing, so a reader can
tell that from a kind that could not run.

Scenario `a-later-unit-holds-the-earlier-pages`: the rule's enrichment page is in the scenario unit's
prompt, the scenarios and rules are in the domain unit's, and the published pages are in the home page's.
Scenario `a-missing-required-artifact-blocks`: a run whose product page was not written reports the domain
kind blocked, naming `product-page` and the `product` kind, and writes no domain page.
Scenario `nothing-found-says-what-it-looked-for`: a kind with no units carries the reason, such as the run
wiring no checked guide production.

### Scenario: a-unit-holds-what-earlier-ones-wrote
- Given: two kinds, one writing a page the other declares it reads
- When: the second kind's unit runs
- Then: its prompt carries the first kind's page, with the artifact named, and the cut and the remainder said when the page is longer than the bound

## Requirement: declared-kinds — The graph's own pages — the verdicts, the home page and the editorial pass's report — are written only where the product's manifest (`madarch/kinds.yaml`, decision 0029) declares their kinds

The graph's own pages — the verdicts, the home page and the editorial pass's report — are written only where the
product's manifest (`madarch/kinds.yaml`, decision 0029) declares their kinds. A kind the manifest does not declare is
a page no reader could open: the unit of that kind does not run, the run reports it as a reason (naming the manifest
file and the kind), and the absence of that page alone never makes the run a failure.

Scenario `an-undeclared-kind-is-not-written`: a product whose manifest declares no validation, overview or editorial
kind has none of those pages after a run, and each kind is reported with the reason.
Scenario `an-undeclared-kind-does-not-fail-the-run`: the same run is whole when the pages its manifest does declare
were written.
Scenario `a-declared-kind-runs`: a product whose manifest declares the three kinds runs their units, and their pages
are written and checked like any other page.

### Scenario: an-undeclared-kind-writes-nothing
- Given: a product whose manifest declares none of the validation, overview and editorial kinds
- When: the fill runs
- Then: none of those pages is written, each is reported as nothing-found with the manifest file and kind, and the run is still ok

## Requirement: enrichment-apart — The enrichment of one passage of a person's document is written beside the product, keyed by the passage's identity

The enrichment of one passage of a person's document is written to
`docs/enrichment/` under a folder named for the entity's kind, and a file named for the SHA-256 digest of the entity's identity; its page id names the entity it enriches; its
front matter records the entity, its kind, the source document and the lines it stands at; its body is the
agent's statements, each grounded on the passage or on the code. The writer's sink writes a closed list of
page families and refuses anything else, naming the path and line; a page family whose file holds no page
whose front matter names the producer `agent` is refused rather than overwritten.

Scenario `enrichment-is-keyed-by-identity`: the path and the page id are derived from the entity's durable
identity, and a renumbering of the document keeps them.
Scenario `the-source-lines-are-recorded`: the front matter names the entity, the document and its line range.
Scenario `the-persons-document-is-untouched`: the document a person wrote in the product repository is the
same bytes after a run that enriched two of its passages.
Scenario `a-page-not-the-writers-is-not-overwritten`: a page whose text is a person's is refused, with its
path and line, and its text stays.
Scenario `two-passages-never-share-a-file`: two passages of one document have two files.

### Scenario: a-persons-document-is-never-overwritten
- Given: a person's requirements document holding two passages a unit enriches
- When: the unit runs
- Then: two files are written beside the product, each keyed by its passage’s identity, and the person's file is byte-identical afterwards

## Requirement: resumability — Every unit is a generation in the fill's own unit tables under a stage named `writer.` and the unit's kind, with the digest of what it read and was

Every unit is a generation in the fill's own unit tables under a stage named `writer.` and the unit's kind, with the digest of what it
read and was told, walked through the landed machine: planned, ready, leased, running, draft, validating,
published. A run reads what the product's earlier runs published and keeps every unit whose digest and page
still match; a unit whose inputs moved gets a new generation and is published again; a unit that ends
without its page is left blocked with its reason, and the next run takes it up.

Scenario `a-finished-unit-stays-finished`: after an interruption the published units are the ones that
finished, and the pages they wrote are the same bytes later.
Scenario `a-resumed-run-writes-what-is-left`: the run after an interruption starts only the units that never
finished.
Scenario `a-changed-digest-publishes-a-new-generation`: a unit published under one digest and offered under
another is marked stale, replaced and published again.
Scenario `an-unfinished-unit-is-blocked-with-its-reason`: a unit whose page the agent never wrote is reported
with that reason, is not counted as written, and the run is not ok.

### Scenario: an-interrupted-run-resumes
- Given: a fill interrupted after the domain unit, then run again
- When: the second run starts
- Then: the finished units are not run again, the interrupted work is taken up, and the pages already written are unchanged
