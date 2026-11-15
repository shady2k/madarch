# The code map: one Files section on the kind page, a folder's page and home

Change: madarch-j9ao.1.1
Base: 2535d187abbbbd925ab3a3b38dc38bd7ac04e254
Tasks: madarch-j9ao.1.1
Kind: no-behavior

## Intent
The Files kind page, a folder's own page and the home page now draw the code map from the graph's files: a treemap whose area is lines or bytes, coloured by language, recent heat, age or authors, with a legend, the totals and a table of every file. The map drills from repository to folder to file, and the folder page reads only the files under that folder. The drawing is a template section (`files-page`), fed by the GraphQL `filesPage` read; the app names no kind and no checkout is read.

## Out of scope
Changing the fill's code facts or their closure; replacing the existing file, folder or repository entity pages; adding a new chart library.

## Rationale
The owner's walk found no code map on the Files page, a folder's page or home. The map belongs to the template layer under decision 0036: the graph supplies files and their rhythm, and the kit draws them. One section serves the kind catalogue, a folder's subtree and the home summary, so the map cannot drift between pages.

## Preserved contracts
- product-wiki/pages: every page is still a template the app runs over one operation; the Files map is one section with its own params, and no page names a kind in the app.
- product-wiki/app: the map is built from kit components (`ChartTreemap`, `ChartLegend`, the table and controls), and the page keeps its language, theme and keyboard focus.
- product-wiki/shell: the Files section keeps the shell's address, navigation and live page updates; opening a file uses the entity address the graph gives.

## Coverage
- product-wiki/pages: test mutation
- product-wiki/app: test mutation
- product-wiki/shell: test

## Where it is seen
Kind: screen
Place: the Files kind page, a folder's page and `/` in the wiki app
Mockup: docs/changes/madarch-j9ao.1.1/treemap-home-1440.png

1. Open the Files kind page and read the map's totals, legend, treemap and table.
2. Switch area and colour, drill into a repository and a folder, and open a file from a cell or a row.
3. Open a folder's page and confirm the map reads only its subtree.
4. Open home and read the compact map with its totals and legend.
