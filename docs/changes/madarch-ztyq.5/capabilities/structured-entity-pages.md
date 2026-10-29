# Structured entity pages
Capability: structured-entity-pages

## Purpose
The writer's enrichment of a passage of a person's document carries the structure of what the passage is.
A use case reads as its actor, its goal, its preconditions, its main and alternative flows, the rules that
govern it and what implements it; a rule reads as its statement, where it applies, its exceptions and what
implements it; a decision reads as its status, its context, the decision, its consequences and what carries
it out. The sections are the core's, their headings are in the wiki's language, every place a page names is
a key the graph held when the page was written, and a part the document or the graph leaves empty is said on
the page instead of being left out. The person's document keeps its own text: the page stands beside it.

## Requirement: use-case-page — A use case's page carries its actor, its goal, its preconditions, its main and alternative flows, the rules that govern it and what implements it

A use case's enrichment page carries the seven sections of its kind, in this order: Actor, Goal,
Preconditions, Main flow, Alternative flows, Rules that govern it, Implementation. The unit gives each part
as a sentence with the grounds that show it, and the core writes the sections, so a part is never missing
because a model forgot it. Each alternative flow states its condition and then what happens under it. The
rules that govern the use case are the sections of the person's document that state them.

### Scenario: a-use-case-carries-its-parts
- Given: a requirements document holding a use case, and a unit that read it
- When: the unit writes the enrichment of that passage
- Then: the page carries Actor, Goal, Preconditions, Main flow, Alternative flows, Rules that govern it and Implementation, in that order, and each statement of it ends in the footnote that lists its grounds

### Scenario: a-part-the-document-leaves-empty-is-said
- Given: a use case whose passage names no precondition and no alternative flow, and a unit that read it
- When: the unit writes the enrichment of that passage
- Then: the page states that the document names no precondition and no alternative flow for this use case, in a sentence grounded on the passage, and the section is never left as an empty heading

## Requirement: rule-page — A rule's page carries its statement, where it applies, its exceptions and what implements it

A rule's enrichment page carries Statement, Where it applies, Exceptions and Implementation. The statement is
the rule in the unit's own words, one sentence a reader can check against the document; where it applies and
its exceptions are the unit's reading of the passage; the implementation names the functions, routes, tables
and events the graph holds for it.

### Scenario: a-rule-carries-its-parts
- Given: a requirements document holding a business rule, and a unit that read it
- When: the unit writes the enrichment of that passage
- Then: the page carries Statement, Where it applies, Exceptions and Implementation, and each of them is grounded or says what the document leaves unsaid

### Scenario: a-rule-the-document-gives-no-exception-for
- Given: a rule whose passage names no exception
- When: the unit writes the enrichment of that passage
- Then: the page states that the document names no exception to this rule, grounded on the passage

## Requirement: decision-page — A decision's page carries its status, its context, the decision, its consequences and what carries it out, and the person's record keeps its own sections

A decision's enrichment page carries Status, Context, Decision, Consequences and Implementation, and the
record a person wrote keeps its own Status, Context, Decision and Consequences in its own document: the
writer never edits it, and the page stands beside it, keyed by the passage's identity. The unit states each
part in its own words rather than copying the record's sentences, and names the code that carries the
decision out.

### Scenario: a-decision-keeps-its-parts
- Given: an architecture decision record whose document holds Status, Context, Decision and Consequences, and a unit that read it
- When: the unit writes the enrichment of that passage
- Then: the page carries Status, Context, Decision, Consequences and Implementation, and the record's own file is the same bytes after the run

### Scenario: a-decision-with-nothing-in-the-graph
- Given: a decision whose passage names no code the graph holds
- When: the unit writes the enrichment of that passage
- Then: the page states that the graph holds no code that carries this decision out, grounded on the passage, and names no place it did not resolve

## Requirement: resolved-places — Every place a page names is a key the graph held when the page was written, and a place that does not resolve is a refusal naming the key and the tool that answers it

Before a byte is written, the core resolves every place the unit named: a route is a code.route key, a
function or a method a code.symbol key, a table a code.table key and an event a code.channel key, each read
at the cell of the field it was given in; a rule is the section of the person's document that states it, as
the passage's own anchor names it. A key the graph does not hold, or a key of another kind, is refused with
its key, the field it stands in and the tool that answers it, and nothing is written. The places of the
implementation are the page's relates, so the engine can draw from them and a reader can follow them.

### Scenario: an-unresolvable-place-is-refused
- Given: a unit that names a route the graph does not hold
- When: it writes the enrichment
- Then: the write is refused with the key, its field and the tool that answers it, nothing is written, and the unit may call again with the key that tool answers

### Scenario: a-rule-is-named-by-its-section
- Given: a unit that names a rule by a graph key instead of the section of the document that states it
- When: it writes the enrichment
- Then: the write is refused, the refusal says that a rule is named by the section of the document, and nothing is written

### Scenario: the-places-are-the-pages-relates
- Given: an enrichment page written with three functions and one table
- When: the page's front matter is read
- Then: its relates names those four keys in code point order, and every one of them is a key of the graph at the last filled commit

## Requirement: sequence-diagram — A use case's sequence diagram is drawn by the engine from the route the page relates, and reachability is never shown as order

The writer does not draw the diagram and writes no diagram syntax into the page: the implementation keys are
the page's relates, and the page's kind template asks the engine for its sequence block, which walks the
graph from the route to the functions it calls and to the tables and events they reach. A step that is
reachable without an order in the graph is drawn as unordered, and a route that reaches no function is stated
on the page as a gap rather than drawn as if it reached something.

### Scenario: the-diagram-starts-at-the-related-route
- Given: an enrichment page of a use case that relates the route POST /orders and its functions
- When: the page is rendered by the engine
- Then: the page carries a sequence view whose entry is that route and whose steps are the handler, the functions it calls, the table it writes and the event it publishes

### Scenario: a-route-that-reaches-nothing-is-said
- Given: a use case whose implementation names a route the graph cannot trace to any function
- When: the unit writes the page
- Then: the page states that the route reaches no function of the graph, grounded on the route and the passage

## Requirement: product-language — The sections and the title of a structured page are written in the wiki's language, and the places keep the graph's own names

The headings of the sections and the sentences the core adds for a gap are written in the language the
product's pages are written in, English or Russian, while the places a page names keep the name the graph
gives them, so a Russian page and an English page of one passage carry one structure and the same targets.
The title of the page is the unit's, in the wiki's language, and falls back to the passage's own title.

### Scenario: a-russian-page-keeps-the-structure
- Given: a product whose pages are written in Russian, and a use case whose fields a unit gives
- When: the unit writes the enrichment
- Then: the page's headings are the Russian ones of the same seven sections, its title is the unit's Russian title, and its places are the same graph keys the English page names

### Scenario: an-english-page-names-the-same-places
- Given: the same passage written for an English product
- When: the unit writes the enrichment
- Then: the headings are the English ones, and the places of the two pages are the same keys
