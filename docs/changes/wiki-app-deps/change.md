# The wiki app's dependencies are its own: mermaid declared in wiki/app

Change: wiki-app-deps
Base: 7d9ac8015e0902b28303b26cbef80980fdb2b781
Tasks: madarch-iuc.15
Kind: no-behavior

## Intent
The walk finding (note-walk-fixes.md #1, qualified by walk 2's finding 7):
`wiki/app/src/diagram.tsx` imports `mermaid`, but `wiki/app/package.json`
does not declare it — the root package.json declares mermaid@12 and bun
hoists it, so only a `wiki/app`-alone install breaks. After this change
`wiki/app` declares mermaid 12.0.0 (the version the code is tested
against, the root's own pin), the lock carries it, and
`rm -rf wiki/app/node_modules && bun install --frozen-lockfile && bun run
build` inside `wiki/app` is green; the demo runner worked from a clean
clone. No behaviour changes: the app already resolved mermaid through the
hoist; the declaration only makes the app's own install self-sufficient.

## Out of scope
Any version bump; changing how the diagram module imports mermaid; the
root package.json's own dependencies.

## Rationale
An app folder that cannot install alone breaks CI's wiki/app steps and
every clean clone; a dependency the code imports belongs in the package
that imports it.

The same commit carries the walk-2 conformance fixes (note-walk-fixes no. 3 and 4): an
architecture view or element page now reads "Architecture / the view's or element's name"
in the top bar's breadcrumb and the document tab (the shell requirement's breadcrumb
naming, which the pages did not follow), the arrows' numbered labels get a page-ground chip
so the number reads over the line (the relation table keeps the mapping), and the report's
LikeC4 line is corrected — the panel renders in the walk. No requirement text moves.

## Preserved contracts
- product-wiki/app: the app is still built from wiki/app by the same build step; only the folder's own dependency list grows.
- product-wiki/shell: the breadcrumb and tab rule is unchanged — architecture pages now follow it.
- product-wiki/architecture: the diagram is still the shared renderer's Mermaid source; only its label legibility styling moves.

## Coverage
- product-wiki/app: test
- product-wiki/shell: test
- product-wiki/architecture: test
