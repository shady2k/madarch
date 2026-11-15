# Every diagram reads in both schemes, fits its box, and names what a node is

Change: madarch-64o5.96
Base: 1460a3b7dfeb14756a5cda0c017eab599b2837da
Tasks: madarch-64o5.96
Kind: no-behavior

## Intent
The owner's walk, a file page's «Вокруг» in the dark theme: the LikeC4 canvas was white with near-invisible labels;
«В mermaid тоже» — edge labels dark on grey chips over the dark page and connectors dark on dark. On a folder page the
Mermaid diagram was wider than the page (a column cut at the edge, clipped second lines), with no fit, zoom or scroll.
A section was headed by the raw key «manifestDependsOn · 2».

Every renderer now draws its canvas, node fill, node border, label text and edges from the kit's tokens of the current
scheme, and a test computes the label/edge/focus contrasts from tokens.css and holds them to WCAG AA (4.5:1) in both.
Mermaid's theme variables, LikeC4's own canvas and text tokens (unlayered, since the runtime's stand in a layer) and an
archify frame painted through the theme message all read those tokens; the page's own entity takes the focus pair.
Mermaid pictures fit their box by default with zoom, fit and drag-to-pan controls. A path-like label shows its name and
keeps the whole path as its hover text. A relation heading falls back to the shared vocabulary, never a raw field key.

## Out of scope
The width of pages (madarch-64o5.99) and the wider layout of the catalogue and the fill panel.

## Rationale
A diagram a reader cannot read is no picture; a cut-off diagram hides the neighbours it exists to show.

## Changes to requirements
None.

## Preserved contracts
- views/one-view: the same graph revision answers the same picture bytes; only colours, scale and the node's shown name change.
- product-wiki/shell: the diagram sits in the same panel and follows the reader's scheme.

## Coverage
- views/one-view: test
- product-wiki/shell: test

## Where it is seen
Kind: screen
Place: an entity page's «Вокруг», in each renderer, in light and dark, at 1440 and 390
1. The diagram's canvas, nodes, labels and edges take the scheme's palette; every label reads.
2. The page's own entity stands out from its neighbours.
3. A diagram wider than the page is shown whole by default, with zoom, fit and drag-to-pan.
4. A path-like node shows its file name; the whole path shows on hover.
5. A relation section is headed by words («зависит от · 2»), never a raw key.
