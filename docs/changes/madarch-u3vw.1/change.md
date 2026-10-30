# Page templates are Liquid: a base page every kind extends, partials and conditions, the engine's blocks as tags, and a render bounded in time and memory

Change: madarch-u3vw.1
Base: 8b49a8f9cbb4c094bea43600f3a687c1ed0b233d
Tasks: madarch-u3vw.1
Kind: behavior

## Intent
Decision 0032 section 8. A product's page templates are Liquid instead of the substitution-plus-directives Markdown of 0029: one base page per entity (`templates/entity.liquid`, a layout with named block sections), a template per kind that extends it and fills what it has, partials the kinds share, and conditions over the page's own values. The engine's blocks are the template's tags, dispatched by the block library, so a block keeps its identity. A block is known by its name and its parameters instead of the line it stands on, a template's diagnostics keep Liquid's own file and line, the template set is the product's `templates/` folder and nothing else, and a page's template is evaluated in a process of its own under a wall clock and a memory bound, because Liquid's own limits are cooperative.

The starter set is rewritten as that base plus the kind templates, and it declares the enrichment kind the writer's structured use case, rule and decision pages land in (madarch-ztyq.5), with a template that draws their chain. A product made before this change keeps its Markdown templates and renders them exactly as before: the engine reads both template languages and decides by the template's extension.

## Rationale
The owner's words: «для каждой сущности может быть либо базовая страница, либо определенный шаблон. Можно шаблонизатор какой-нибудь использовать, чтобы и наследование было и можно было бы страницу из частей собрать». Every kind's template repeated its neighbours' blocks, an empty section could not be hidden, and a diagram's address in the app was the line of the template it stands on, so editing a template above a block broke a reader's open page. Nunjucks was rejected (its documentation warns that user-defined templates are not sandboxed); LiquidJS is the engine, with its filters and template paths allowlisted and its cooperative limits behind a process the server can kill.

## Out of scope
- The writer's units, its graph-first tools and the structured use case, rule and decision pages (madarch-ztyq.5): this change declares the kind and the template their pages are drawn by, and nothing else of that work.
- The editorial and validation passes, in-text links and backlinks, and the domain and home pages of the agent stage (madarch-ztyq.6 to .9, madarch-mwhd.1).
- The wiki's shots of every page kind at two widths and both themes (the stage's acceptance, madarch-u3vw).

## Changes to requirements
- product-wiki/knowledge-templates (absent on the target): add. A kind's page is a Liquid template — a base page extended with a layout and its blocks, partials, conditions, the engine's blocks as tags, `{{label}}` kept, diagnostics with file and line, a template set of the product's `templates/` folder only, a block known by its name and parameters, and a page evaluated in a process of its own under a wall clock and a memory bound. Complete proposed text in `capabilities/product-wiki.md`, with the scenarios `base-and-kind`, `partial-and-condition`, `block-parameters-and-identity`, `diagnostics-name-the-file-and-line`, `templates-are-the-product-folder` and `bounded-render`.

## Preserved contracts
- product-wiki/pages: unchanged; a product's documents are the wiki's pages, and a kind's Markdown template of 0029 still draws a page exactly as it did.
- product-wiki/serve: unchanged; the server, its command and its exits stay.

## Coverage
- product-wiki/knowledge-templates: test
- product-wiki/pages: test
- product-wiki/serve: test

## Where it is seen

Kind: internal
Place: the wiki's entity pages, and a product's own `templates/` folder
Reason: the pages a person opens look as they did — the same blocks with the same titles in the same sections — because the starter set's Liquid templates draw them; what changes is how a product writes its page templates, and the engine's bounded render is not something a reader sees.

1. A person opens a page of a filled product and reads the same sections as before: the details, the place in the graph, the source, the relations and the pages about it.
2. They open a product's own `templates/entity.liquid` and see one base page, the kind templates that extend it and the partials they share.
3. They edit a template while its page is open, and the app's own read of a diagram on that page still draws that diagram.

## Blocking questions
None.

## DONE WHEN
Every page of both products — madarch's own wiki and the generated training product — renders as it did before the starter set was rewritten, or better: the same pages, the same blocks in the same sections, and no section lost. The starter set is a base page, the kind templates that extend it, the partials they share, and the enrichment kind with the template that draws a structured page's chain. A product's Liquid template is evaluated in a process of its own, under the wall clock and the memory bound, with the engine's own limits in front of them.
