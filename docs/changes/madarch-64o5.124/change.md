# The catalogue shows its dependency graph again

Change: madarch-64o5.124
Base: 39bf4ae12863dc42f0808cf0641d042f1e8d71b9
Tasks: madarch-64o5.124
Kind: no-behavior

## Intent
The entity catalogue and a kind's page show the graph of kinds again: each kind is a box, an arrow runs from a kind to the kind that needs it filled first, and a press on a box opens that kind's catalogue entry. The catalogue reads the graph from one compact GraphQL answer, `catalogueDependencies`; a kind's page reads its own prerequisites and dependants from `derivesFrom` and `derivedBy`. The picture is Mermaid drawn through the kit, so the words are the catalogue's own labels in the reader's language.

## Out of scope
A graph in the preparation panel; the old hand-positioned canvas and its graph kit; changing what a kind derives from; editing dependencies in the browser.

## Rationale
The owner asked where the dependency graph went. PR #299 removed it with the old page layer. The manifest still publishes the kinds' dependencies in the graph, so the template layer draws that answer again without bringing back the old pages or a second source of truth.

## Preserved contracts
- product-wiki/pages: the graph is a template section (`dependencies`) on `catalogue` and `catalogue-entity`; every page still composes one GraphQL operation, and no template or component names a kind.
- product-wiki/app: the picture is the kit's Mermaid pane; it uses the kit's colours, type, zoom and pan, and a click walks through the app's own navigation. Every label comes from the graph in the reader's language.
- product-wiki/shell: the section keeps the shell's page address, loading state and live page behaviour.

## Coverage
- product-wiki/pages: static test
- product-wiki/app: static test
- product-wiki/shell: test review

## Where it is seen
Kind: screen
Place: `/p/catalogue` and a kind's catalogue entry in the wiki app
Mockup: docs/changes/madarch-64o5.124/catalogue-1440-light.png

1. Open `/p/catalogue`, scroll to the dependency graph, and read the arrows and the counts.
2. Open a kind's catalogue page; its prerequisites and dependants stand around it.
3. Press a box; its kind page opens.
4. At 1440 and 390 px, in light and dark, the picture fits its box and no label is cut.
