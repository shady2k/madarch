# Home page

Capability: home-page

## Purpose
A home page answers the question a person asks when they open the wiki: what is this product, for whom, and where do I read more? It is a one-minute overview in eight sections — what the product is and for whom, its main scenarios, how the system is put together, its domains, the rules and decisions that matter, its technology and size, how complete the wiki is, and what is not connected. Each section points at the page that says it in full instead of restating it. The sections, their order and their headings are the core's; the unit gives the parts and every sentence stands on a graph key, a document section or an answered question. A part the documents and the graph leave empty is said on the page, never left as an empty heading or filled with invention. The app keeps the home page compact: below the product overview it shows one line of history totals and the five files that change most, and the whole file list is one link away. Its figures and titles count in the reader's language through the shared counted-figure families.

## Requirement: eight-sections — A home page carries eight sections in the order a reader reads them, and the core owns their headings in the wiki's language

A home page carries eight sections in this order: What the product is and for whom, Main scenarios, How the system is put together, Domains, Key rules and decisions, Technology and size, How complete the wiki is, and What is not connected. The product page and the overview page are the same shape at two moments of a run: the product unit writes first with the domains it declares, and the overview unit writes last with the pages the run published. The unit fills fields; it does not choose the sections or write their headings, so no section is missing because a model forgot it, and the headings are in the language the product's pages are written in.

### Scenario: the-page-is-eight-sections
- Given: a product whose documents hold a vision, use cases, rules and decisions, and a product unit that read them
- When: the unit writes the home page
- Then: the page carries the eight sections in the declared order, each with its own part, and no other section stands between them

### Scenario: a-ru-page-carries-the-same-sections
- Given: a product whose pages are written in Russian, and the same fields of the same product
- When: its home page is written
- Then: its headings are the Russian headings of the same eight sections in the same order, and its places are the same graph keys, document sections and domain pages the English page names

### Scenario: the-overview-page-is-the-same-home
- Given: a run that has written the product page and the domain pages
- When: the overview unit writes its page
- Then: the page has the same eight sections and may point at the pages this run published, each with the label a reader sees

## Requirement: grounded-places — Every section points at a page that says it in full, every place and ground resolves before the page is written, and every declared domain appears

A section's places are links, each with the sentence the page says about it and the grounds of that sentence. A place resolves to a declared domain page, a section of a document, a key of the graph at the last filled commit, or a page this run published. A place that does not resolve is refused with the field path of the target, and nothing is written. A page this run published needs the label a reader sees, because its id is not readable. Every domain the product unit declared appears in the domains section, so the home page names the same domains the rest of the wiki is built around. The declared domains and the graph keys the page stands on are the page's `relates`.

### Scenario: an-unresolved-place-is-refused
- Given: a unit that points a scenario at a graph key the graph does not hold
- When: it writes the home page
- Then: the write is refused, the refusal names the place and the tool that would have found it, and nothing is written

### Scenario: a-refusal-names-its-field
- Given: a unit whose scenarios entry points at a missing key, and another whose grounded sentence names a missing key
- When: each write is refused
- Then: the first names `fields.scenarios[0].target` and the second names `fields.whatItIs[0].grounds[0]`

### Scenario: every-declared-domain-is-named
- Given: a product unit that declares payments and ordering but names only payments in the domains section
- When: it writes the home page
- Then: the write is refused with the domain it left out, and nothing is written

### Scenario: a-published-page-is-pointed-at-by-its-label
- Given: an overview unit that points a section at a page the run published
- When: it writes the page without a label for that place
- Then: the write is refused, and with the reader's label the page shows that label instead of the page id

## Requirement: fields-and-gaps — The unit gives fields rather than a body, every field is parsed before the page is judged, and an empty part or an empty product says its gap

The page is written from eight fields in reading order. Every field is checked before any page is judged, so a malformed field is a problem of its own and never a part that vanishes. `whatItIs` is the one required field: at least one grounded sentence of what the product is and for whom, so the page says what it is about before it points anywhere. A field nothing declares is refused with the fields there are. A section whose part is empty says the core's gap sentence about the documents and the graph, never an empty heading and never a claim about the world. When the graph holds no document and no content node, the core writes the whole page as eight gap sentences, with no invented ground and no footnote, and `checkPage` admits exactly those sentences.

### Scenario: what-the-product-is-is-required
- Given: a unit that gives scenarios and domains but no grounded sentence of what the product is
- When: it writes the home page
- Then: the write is refused with the required field, and nothing is written

### Scenario: an-unknown-field-is-refused
- Given: a unit that writes a field the home page does not declare
- When: it writes the page
- Then: the write is refused, and the refusal names the fields there are

### Scenario: an-empty-part-says-its-gap
- Given: a home page whose unit found no rule and no decision, and no technology
- When: the page is written
- Then: each of those sections holds its gap sentence about the documents and the graph, and neither is an empty heading

### Scenario: an-empty-product-is-eight-gap-sentences
- Given: a product whose graph holds no document and no content node, and a unit that did not describe it
- When: the unit writes the page
- Then: the page carries the eight headings, each followed by its core gap sentence, no footnote and no invented ground

## Requirement: one-minute-rest — The app's home keeps the overview and at most six rows outside it, and the whole history is one link away

The app's home page keeps the product's overview, then the system map, then a compact history: one line of totals and the five files that change most. At most six rows stand outside the overview. The treemap and the relation table are not on the home page; they live on the pages of what they describe. The compact history links to the kind's whole list in the reader's language. The product history is projected once across every repository, with entities and edges deduplicated by graph identity and one limit for the page, so a product of twenty repositories does not turn a five-row budget into twenty summaries.

### Scenario: the-rest-fits-in-six-rows
- Given: a filled product whose graph holds many files, commits and authors
- When: its home page is rendered
- Then: at most six rows stand outside the overview — one line of totals and the five files that change most — and no treemap or relation table stands on the page

### Scenario: the-rest-links-to-the-whole-list
- Given: the compact history of a home page in English, and the same page in Russian
- When: the reader follows the link to the rest of the story
- Then: it opens the files listing, and the link says "All files" in English and "Все файлы" in Russian

### Scenario: many-repositories-stay-one-budget
- Given: a product whose repositories together hold far more history rows than the limit
- When: its home history is projected
- Then: the summary reports the product's totals once, the hotspots number at most the limit, and a shared author or commit is counted once

## Requirement: counted-figures — Every history figure and title counts in its numeral's own form, through one list of counted kinds

Every history figure is shown in the grammatical form its numeral takes in the reader's language, in the figure's value and in its title. A summary badge for one commit reads "1 commit", not a catalogue key and not "1 commits"; in Russian the same figure takes the Russian form for one. The set of kinds that carry a count is declared once in the writer's history figures and read by the app, so no screen-local list can drift from the plural families.

### Scenario: a-figure-says-one-commit
- Given: a home history summary whose commits figure is 1
- When: the block is read in English
- Then: the badge shows "1 commit" in its visible value and in its title

### Scenario: a-russian-figure-takes-its-form
- Given: the same figures on a page read in Russian
- When: the block is read
- Then: each counted figure takes the Russian form its numeral requires

### Scenario: one-list-names-the-counted-figures
- Given: the writer's declared counted figures and the app that shows them
- When: the app decides which figures carry a count
- Then: it reads the writer's one list, so a kind added to the families is counted without a second declaration
