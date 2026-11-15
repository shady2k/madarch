# A kind's diagram shows its kinds, both roles of a self relation, and no fill order

Change: madarch-64o5.125
Base: 39bf4ae12863dc42f0808cf0641d042f1e8d71b9
Tasks: madarch-64o5.125
Kind: no-behavior

## Intent
A kind's page now titles its picture «Kinds around it» and draws the kinds' declared relations, not the fill order. A folder's self relation reads both role words («содержит / содержится в»), every node and edge label follows the reader's language from the published catalogue, and the LikeC4 picture keeps every node inside its canvas with a wider fit padding.

## Out of scope
The relation lists below the picture; the fill's own dependency graph; the renderer tabs and their vendored runtimes.

## Rationale
The owner's walk found English words on a Russian kind page, a folder loop without the inverse role word, and fill-order arrows among the domain relations. The read layer already publishes the catalogue's words; the diagram now takes both directions of a self relation and leaves the fill order to the catalogue's dependency graph (madarch-64o5.124).

## Preserved contracts
- product-wiki/pages: the diagram is still one template section; the kind's page inherits it from `catalogue-entity`, and no page names a kind or an edge key.
- product-wiki/app: the picture keeps the kit's LikeC4 tab, zoom, pan, focus and page links; every visible word is a locale string or the catalogue's own label.
- product-wiki/shell: the kind page keeps its address, trails and live update.

## Coverage
- product-wiki/pages: test
- product-wiki/app: test
- product-wiki/shell: static test review

## Where it is seen
Kind: screen
Place: a kind's catalogue entry in the wiki app, in Russian
Mockup: docs/changes/madarch-64o5.125/folder-1440-light.png

1. Open the Directory kind's catalogue entry in Russian and read «Виды вокруг».
2. Read the folder's self relation: «содержит / содержится в».
3. Confirm no «зависит от» arrow stands in the picture; the fill order is the catalogue's dependency graph.
4. At 1440 and 390 px, light and dark, every node stays inside the canvas and no label is cut.
