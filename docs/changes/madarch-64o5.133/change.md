# A product's home and its catalogue as a reader had them before PR #299

Change: madarch-64o5.133
Base: dd6c44f53c5d07a6dff790adeebef801645db591
Tasks: madarch-64o5.133
Kind: no-behavior

## Intent
The read-only audit `/tmp/audit-299-lost.md` lists what a reader could do in the wiki
before PR #299 and cannot do on the template layer. This change takes its sections 3
(Home) and 4 (Catalogue), every item marked lost or partly, and gives each one back on
today's mechanism: the page templates under `catalog/templates/pages/`, the components
under `wiki/app/src/components/`, and data read from the graph through `/graphql`. No
old page and no old module returns, and no table, data file or text pointer is added.

## Rationale
The owner's words for the task: «дом и каталог как до PR #299». A filled product's home
showed seven fact cards with their grounds, and its catalogue showed how many kinds and
records it holds, the fill state of every kind and a contents list that follows the page.
On the template layer the home kept two charts of code files and the catalogue kept its
rows, its filters and its selection mode; the rest was gone. The items and their fates
are listed under "Design and decisions", one row each.

## Out of scope
- Item 37, the dependency graph of kinds: madarch-64o5.124, another worker.
- Every item of sections 1, 2 and 5 to 16 of the audit, and the items it marks [known].
- The behaviours decision 0036 removes on purpose (historical reads, Liquid templates, the
  32 server blocks, page exports, the replaced MCP tools, the per-page read routes).
- The role question itself and the sidebar's order (section 1 of the audit).

## Changes to requirements
None. The change realizes the existing product-wiki/overview, pages, presentation,
internationalization and app requirements: the home explains the product and its fill,
the catalogue states what the product declares and holds, and every page's data is the
graph's answer.

## Preserved contracts
- product-wiki/overview: the home still introduces the product before what it holds, and a product without a manifest shows the localized empty-home guidance (test)
- product-wiki/pages: a page is still one `/graphql` operation composed from the product's own templates, and no page carries data of its own (test)
- product-wiki/presentation: a kind's page and its row in the catalogue still follow the manifest's declaration and the product's own templates (test)
- product-wiki/app: a page that shows workflow state reads it from the retained command routes, never from a new store (test)
- product-wiki/internationalization: every new reader-facing line stands in English and Russian (test)
- product-wiki/live: a page keeps its last answer while the server is away, and a change notice reads it again (test)

## Coverage
- product-wiki/overview: test
- product-wiki/pages: test
- product-wiki/presentation: test
- product-wiki/app: test
- product-wiki/internationalization: test
- product-wiki/live: test

## Where it is seen
Kind: screen
Place: a filled product's home at `/`, its catalogue at `/p/catalogue`, and the home of a product created with no kinds manifest
Mockup: docs/changes/madarch-64o5.133/home-1440-light.png

1. Open the home of a product the disk and git plugins have filled: seven fact cards stand under «Что держит граф» — the number of files, the files by language, by folder, by repository, their age and the largest and most changed files — each drawn as a number or a chart, each with «Основания» under it (the kind, the measure, the field, the records counted and the records no shown row accounts for) and a title that opens the kind's catalogue page. A reader whose role is everything reads all seven; a reader who chose analyst reads none of them and still sees what the graph holds of every kind.
2. Open the catalogue: the header states «63 вида, 772 записи», each area and subgroup states its own share, every kind wears its state («Заполнено», «Не заполнено», «Ошибка»), and «На этой странице» follows the areas at the right of the page and turns into a button at a phone's width; a press on an entry scrolls to its area.
3. Read the home while a fill runs: «Идёт заполнение · N из M» stands with the last thing the run did, in the words of its run page. When the newest run failed, a problem card stands until «Скрыть» is pressed, with «Повторить заполнение». A graph that holds only part of a repository's history offers «Заполнить» to read the rest.
4. Create a product with `madarch init --template none` and open it: the page names the product, says the product was created, that the graph is empty, names `madarch/catalog.yaml` and links «Как написать манифесты продукта».

## Blocking questions
None.

## Design and decisions
| Item | Where it lived before #299 | Now |
|---|---|---|
| 32 A missing manifest is named, with the guide | `pages.tsx:417`, `PrefillHome`; the guide address in `src/product/cli.ts` | **done**: the frame draws `components/missing-manifest.tsx` when `/api/status` says `no-manifest`, because such a product has no graph and no template can compose. The guide address is one constant (`src/product/guides.ts`), printed by the command line and served in `/api/status` |
| 33 Role-filtered fact cards: a number or a chart, a ground, a link | `facts.tsx:1-40` and the manifest's per-kind `facts:` | **done** on the template layer: a new `fact` component draws one aggregate as a card, a ground disclosure and a link to the kind's catalogue page; `home.yaml` declares the six facts `catalog/code/structure/code.file.yaml` declares and the files by repository the home already charted, each with `roles: { show: [developer, architect] }` from that kind's audience. Left from the old ground: the list of every entity key the fact counted (a second listing of the kind) and `computedAt` (an aggregate carries no time, and a browser clock would claim one the graph never stated) |
| 34 The fill card: running counts and last item, a failure's place, continue, a failed run kept until dismissed | `pages.tsx:305-383`, `writer.tsx` | **partly done**, in `comp/overview.tsx`: a running fill states `Идёт заполнение · N из M` and the last thing it did, a failed run keeps its retry until dismissed (session storage, per run id), and an incomplete history offers the fill that reads the rest. **Left**: the failure's file, line and path — the run's records carry the place only inside the engine's sentence, and the run page is written for a person with no machine path; showing it would mean parsing that sentence or adding a field to the run store |
| 38 A state badge per kind | `pages.tsx:611-613` | **done**: `catalogue.tsx` shows «Не заполнено» / «Заполнено» / «Ошибка» from the graph's count and the newest run that reached the kind (`/api/fill-runs`, the workflow state the command routes keep) |
| 39 The header totals and a total per group | `pages.tsx:624,637` | **done**: «N видов, M записей» in the header, and the same line on every area and subgroup |
| 40 A sticky contents list that follows the scroll | `pages.tsx:631-651`, the kit's `ResponsiveContents` | **done**: the catalogue stands in the kit's catalogue layout with `ResponsiveContents`; each area and subgroup answers at its own anchor |
| 41 The statement count per kind | `pages.tsx:608` | **left**: statements are not graph entities. Their text stands inside a document's `statements` field and their grounds become `grounds` edges from the page; the count the old page showed came from the Markdown index that always answered none (`src/knowledge/index/queries.ts` before #299). There is nothing to count through `/graphql` |

Two decisions carried by the work:
- **The role a reader reads as has one spelling.** `sectionShownFor` treated `all` as
  every role, while the reader's settings and the manifest name `everything` for that
  reader, so a template's `roles.show` hid its section from the reader who reads as
  everything. The page contract now speaks the reader's own word: `everything` opens
  every section, and a page composed without a role composes as that reader.
- **A product without a manifest has no graph to ask.** Its catalogue cannot be
  published (`the graph holds no published manifest`), so no template composes; the one
  page it gets is the frame's own card, drawn from `/api/status`. This follows the
  existing `no-manifest-overview` scenario of product-wiki/overview.

## Acceptance evidence
Static: `bun run check` passed (tsc, architecture with its 36 listed violations and no new
one, UI architecture with 0, catalog, workflows, quarantine). In `wiki/app`:
`bun run check` passed (tsc and UI architecture 0).
Test: `wiki/app` `bun test` passed 135 cases in 26 files, 623 assertions. The new cases
are `command-pages.test.tsx` (the catalogue's totals, a kind's fill state, the failed
state of the newest run, the contents list), `fact.test.tsx` (a number, a grouped chart
with its unaccounted records, a histogram and a ranking, an answer with no values),
`overview.test.tsx` (a running fill, a failed run kept until dismissed, an incomplete
history), `first-run.test.tsx` (the guide and no guide) and `missing-manifest.test.tsx`.
`test/page-contract.test.ts` states the role a reader reads as. The touched root suites
passed 296 cases in 13 files: `page-contract`, `page-contract-command`,
`server-templates`, `product-cli`, `product-serve`, `product-wiki-serve`,
`draft-templates`, `draft-status`, `knowledge-publication-state`, `graphql-executor`,
`ui-architecture`, `catalog-read`, `roles-check`.
Screens: twelve PNGs in this folder, 1440 and 390 in light and dark: `home-*` and
`catalogue-*` of a product the disk and git plugins filled, and `home-no-manifest-*` of a
product made with `--template none`. Read through Chromium at both widths: the shell
column's horizontal scroll is 0 on every page; the only content past the viewport edge is
a facts table inside the kit's own `overflow-x-auto` wrapper, which scrolls by itself; the
home's fact cards read `Files 584 · Grounds Kind Files, Measure A count of the records,
Entities counted 584`, `By language YAML 524, TypeScript 25, …`, `Files by repository shop
584 · Records in no shown row 0`; the catalogue reads `63 kinds, 772 records` with
`Filled` on the kinds the fill reached and `Never filled` on the ones it did not, and its 39 contents
entries; the no-manifest home reads its card whole and overflows nothing (0 px) at 1440 and 390.
Walk: the screens come from a product made by `createDraft`, filled by the disk and git
plugins through `POST /api/fill` until the run ended `done`, served with the built app.
Mutation: not run, filed per the stage rule.
Review: pending; this record is for the review.
Environment: the container does not delegate the cpu, memory and pids controllers, so the
plugin sandbox cannot start here; the plugin-backed suites ran with
`MADARCH_PLUGIN_SANDBOX=off` (the documented deliberate choice), as the ordinary user
`shady`, because the test preload refuses to run PostgreSQL as root.

## DONE WHEN
Each item of the audit's sections 3 and 4 marked lost or partly is either visible again on
a filled product's home or catalogue at 1440 and 390, in both themes, or named above with
the reason it stays out; `bun run check` and both test suites pass; and no old page,
module, table, data file or text pointer outside the graph came back.
