# A run's plan is asked for the press, and the first fill's pages name no machine path

Change: madarch-blko
Base: 6fa60fcee7ef543009bdc377c843b5311d6ab315
Tasks: madarch-blko
Kind: no-behavior

## Intent

The first fill of a product started with the default `everything` template, pressed in Plugins only
mode, lands on pages that read as broken or leak the machine's own folder names. Two defects, one walk
on a compiled Linux arm64 binary (`6fa60fcee`):

- The run's own page asks `POST /api/fill-plan` for `run.order`, the order the engine keeps beside the
  press (it holds every prerequisite the run resolved, `system.product` among them). The product's
  manifest declares no such kind, so the engine refuses the request (`src/knowledge/fill-targets.ts`) and
  the page received HTTP 500 — its plan words (the plugin labels) never arrived. The page now asks for
  the press the run was made with (`run.selected`), which is what `POST /api/fill-plan` plans; the home's
  last-fill line, which builds the same lookup, asks the same way. A run that recorded no press still
  falls back to its order.
- Four visible lines named the machine's folder: the preparation panel printed the product's own folder
  (the products home's own folder for the product, a temporary folder in the walk) beside the product repository it names, and the
  Problems page's two section notes carried the manifest's full path (`.../madarch/catalog.yaml:1`) in
  the words the code section states. The panel now names the product's own repository by the product —
  where this machine keeps it stays the settings' «Places» card — and a note names a file inside the
  product by its path in the product, in its sentence and in the values the reader's language fills.

## Out of scope

- The broad journal cleanup the walk's other paths belong to: `madarch-64o5.62` stays the tracked work
  for it, and this change touches only the four lines the walk saw.
- What `/api/fill-plan` refuses and how it words a refusal: a press naming a kind the manifest does not
  declare is still refused, by name, with every declared kind listed.
- The remaining HTTP 500 the walk meets one page further on, `GET /api/problems?count=1` after a fill,
  which this change neither causes nor fixes: its cause is a `code.commit` vertex of the product
  repository's own baseline that carries no `subject`, which the commit role's projection refuses
  (`semanticEntities`, madarch-blko's report names the entity and the place).

## Rationale

`POST /api/fill-plan` is the plan of one press: `fillPlan(selected, pluginsOnly)` plans the kinds a person
asked for and the prerequisites they need, and it refuses a kind the manifest does not declare. A run's
`order` is not a press — it is the engine's resolution of one, and it can hold prerequisites the product
never declares (`system.product`, which every product kind derives from in the shipped catalogue). Passing
the resolved order asked the engine to plan something nobody pressed, and the refusal is right: the page
was wrong. The plan's only reader-facing use on that page is the plugin labels — the manifest's whole
plugin list, which every press returns — so the press answers it exactly.

The four paths were located one by one on the compiled page (`data-testid` of each holder): both were
renderings of a machine path, not diagnostics. The preparation panel's row is «Репозиторий продукта» and
already names the product; the folder beneath it was the only place the wiki printed a checkout's full
path outside the settings' «Places» card, where a reader asks for it. The notes are the code section's
statements about what it could not judge: their sentence is worth keeping, and the path in it reads the
way every other path the wiki shows a reader reads — inside the product (`madarch/catalog.yaml:7583`),
never the folder the product happens to stand in.

## Preserved contracts

- product-wiki/pages: the run's page still reads its plan from `POST /api/fill-plan`, names its plugins and their labels in the reader's words, and states the kinds it fills; the preparation panel still names the product's own repository and every repository the fill reads (test).
- model-check/problems: every note the Problems page states is still stated, with the same words, the same cause and the same language keys — only a file inside the product is now named by its path in the product (test).

## Coverage

- product-wiki/pages: test
- model-check/problems: test

## Where it is seen

Kind: request
Place: `POST /api/fill-plan`, as the first fill's run page asks it, and the notes beside the Problems page's listing

1. Create a one-file Git checkout and run `madarch init --template everything` from it, then open the wiki, select Files and press Run in Plugins only mode.
2. Open the run's own page: the plan request names only the press (`code.file`), the page answers HTTP 200, and the page still names the plugin that filled the kind.
3. Read the preparation panel and the Problems page: neither states a folder this machine keeps the product in.

## Blocking questions

None.
