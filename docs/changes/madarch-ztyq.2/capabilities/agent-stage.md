# Agent stage

Capability: agent-stage

## Purpose

What a unit of the knowledge writer is given, and what it may ask. A unit writes
one page from the graph, and the graph is what it holds before it asks anything:
the answers it may ask for (a symbol by name, an entity's context, a flow from a
route, a document's sections, the pages already written, the questions already
asked) and the shared prompt that carries them. This is section 2 of decision
0032, apart from the writer's page format, which is the format's own capability.

## Requirement: graph-tools — A unit's tools answer questions about the graph, bounded and named

The writer's unit tools shall hold, beside `overview`, `find_nodes`, `get_node`,
`neighbors` and `read_file`, the answers `get_symbol`, `get_context`,
`trace_flow`, `get_document_sections`, `search_pages`, `get_page` and
`search_questions`, each declared with a JSON input schema, and a product unit
and a domain unit shall hold the same seven. Every read they make shall be a
read of the graph at one pinned instant — the fill's last commit — through the
pinned snapshot reader, and none shall read the working tree.

`get_symbol(name, service?)` shall answer the declarations a name means: the one
declaration a key names, or every declaration whose qualified name is the name,
narrowed by a service to the declarations under that service's folder. Several
declarations shall be answered as candidates with nothing selected and the total
named; one shall be answered with its signature, its exact source span, the
declaration that owns it, its service, and its callers, callees, references and
tests, each with the number behind it and at most eight of them. A signature
shall be the lines of the declaration from its first line to the line that opens
its body, four lines and 400 characters at most.

`get_context(entity, purpose)` shall answer one entity in one call for a purpose
of `domain`, `scenario`, `rule`, `decision`, `implementation` or `overview`: its
relations grouped by relation and direction, each group with the number of
entities at its other end and at most six of them and 36 in all, the relations
the purpose does not read with their totals, and for `domain`, `scenario`, `rule`
and `decision` the document sections that name the entity, at most six over at
most 200 documents. The order of the groups shall be the purpose's, and every
list shall be in code point order.

`trace_flow(entry, targets?, depth?, maxSteps?)` shall answer, for a route or a
function, the functions a route hands its request to and then what they call,
read, write, publish and call into another service, at most 200 edges of a
relation, `depth` calls away (1 to 8, four by default) and 60 steps. Each step
shall carry the depth it was reached at and whether its site is known, and
reachability shall never be presented as an order: a step's order is its site in
the source (`source`) or `unknown`, a target shall be `table`, `event` or
`external`, and a target reached twice shall be named once, at its nearest
distance.

`get_document_sections(intent, scope?)` shall answer the sections of the
product's documents whose heading or text holds the words of the intent, at most
30 over at most 200 documents, each as a document ground naming the document's
path and the section's anchor, with its heading, its lines and a 400-character
excerpt, matched by words and not claimed to be a classification of what a
section means. The anchors shall be the ones the writer
accepts as grounds, and `scope` shall limit the answer to one document or to the
documents under a path.

`search_pages(text, kind?, limit?)` shall answer the pages of the product the
writer holds — the product page, the domain pages and the questions — whose
title or text holds the words, at most ten pages with at most four lines of each.
`get_page(page, format)` shall answer one page by its id or path, as Markdown
cut at 400 lines or as its front matter and its statements with the grounds and
mentions of each. `search_questions(text?, includeAnswered?, limit?)` shall
answer the questions of the product, open ones alone unless the answered ones
are asked for, at most 60.

Every answer of the seven shall name the repositories and the commit each was
read at, the instant of the graph, the evidence it stands on (one entry per
target, in code point order, at most 60) and whether any of its lists was cut.
A join it was asked for and could not make — a name that means several
declarations, a route with no handler, an edge with no site, a page that does
not exist — shall be named in its answer, at most 20, and counted.

### Scenario: symbol-by-name
- Given: a graph in which the one declaration named `Checkout.pay` stands in `src/checkout.ts`, is owned by the class `Checkout` in the same file, is called by `register`, calls `Client.charge` and is exercised by the test case `pays`
- When: a unit asks `get_symbol` for `Checkout.pay`
- Then: the answer names its signature, its span, its owner `Checkout` as a class, its one caller, its one callee and its one test, each with the site the graph read it at

### Scenario: symbol-candidates
- Given: a graph in which `refund` is a function of one service and a method of a class in another
- When: a unit asks `get_symbol` for `refund`, and then for `refund` in the first service
- Then: the first answer lists the declarations as candidates with nothing selected and the total 3, and the second keeps only those under the service's folder

### Scenario: flow-is-not-a-sequence
- Given: a route `POST /pay` whose registration calls the function `pay`, which calls one function and writes one table, and one of those calls is read at no site
- When: a unit asks `trace_flow` for `POST /pay`
- Then: the steps are the calls and the table write of `pay` at depth 0 and the call of the function it calls at depth 1, the step with no site is marked `unknown` and counted in `unresolved`, the table is named once as found, and the answer's note says a depth is not an order

### Scenario: sections-by-intent
- Given: a requirements document whose unnumbered section `Qualities` holds a sentence about the time a payment answer takes
- When: a unit asks `get_document_sections` for the words of that question
- Then: the section `qualities` is answered as `doc:docs/requirements.md#qualities` with its heading and its lines, and that anchor is one the writer accepts as a ground

### Scenario: answer-names-its-basis
- Given: a unit of a product whose page is written from one repository at one commit
- When: it asks any of the seven tools
- Then: the answer names that repository and commit, the instant of the graph, its evidence in code point order and whether it cut a list, and the call's counters name the evidence it inspected

## Requirement: prepared-context — A unit is handed what the graph holds before it asks

When a product unit or a domain unit starts, its prompt shall hold the subgraph
it works in: the services of the graph with their language, frameworks and
infrastructure, and the routes, tables, channels and Markdown documents of the
product by key and label, at most twelve of each and in code point order, with
the key to continue from where a list was cut. The block shall be the same for
the same graph, and it shall be given before the unit's first call, so that what
a unit holds is the graph and not a count of the calls it makes.

### Scenario: subgraph-in-the-prompt
- Given: a graph with one service, one route, one table, no channel and one document
- When: the prompt of a product unit and of a domain unit is made
- Then: both hold the service with its language and the table and the document by key, say that the graph holds no channel, and name `get_symbol` and `trace_flow` as the ways to ask further

### Scenario: subgraph-says-where-it-cut
- Given: a graph with more than twelve routes
- When: a unit's prompt is made
- Then: twelve routes are listed and the block names the key to continue from

## Requirement: unit-prompts — The shared prompt carries no unit's own instructions

The shared part of a unit's prompt shall hold the role, the page format, the
tools and the language of the wiki, and shall hold no instruction of one unit's
work: it shall say nothing of a timeout or a retry. The comparison of how
neighbouring operations handle failure — a timeout, a retry, an error answer and
a repeated request — shall be told to a domain unit, in its own part of the
prompt. The prompt version shall name the shared part, so that a change to it is
a change to every unit's cache key.

### Scenario: retry-instruction-is-the-domain-units
- Given: the writer's shared prompt and the prompt of a domain unit
- When: both are read
- Then: the shared prompt holds no word of a timeout and no comparison of neighbouring operations, and the domain unit's prompt asks for that comparison in those words

## Requirement: journal-counters — The journal counts what a call did, not only that it was made

Every journal record of a tool call shall carry the counters of that call: the
bytes of the product's source the answer showed and the bytes it showed of lines
the unit had already been shown, each counted by file and line; the distinct
evidence targets the unit has been shown; the joins that could not be made; and
what the unit produced — pages, statements, grounds, links and questions. A
page's journal shall add its run's records into totals. A line of a journal
written before this capability shall read as none of them, and a guide unit's
records shall count no source and no evidence.

### Scenario: repeated-source-bytes
- Given: a unit that reads the same file twice and then another file
- When: the journal records the three calls
- Then: the first call counts the file's bytes as served and none as repeated, the second counts all of them as repeated and none as served, and the third counts the other file as served

### Scenario: produced-output
- Given: a domain unit that writes a page of two statements with two footnotes and one link in its text, and then asks one refused question
- When: the journal records the calls
- Then: the page's record counts one page, two statements, two grounds and one link, and the unit's questions count none

### Scenario: journal-totals
- Given: a run's journal of a unit with three records, one of them counting a repeated read and one counting a written page
- When: the page's journal is read
- Then: its totals are the sum of the three records' counters, and a record written without counters adds none
