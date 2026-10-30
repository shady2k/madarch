# The glossary is a compact table, and the catalogue and menu group by sub-area with what waits for the reader first

Change: madarch-m38l.24
Base: 378f2909c70d4c304e64b4ed400e8df4b32ace23
Tasks: madarch-m38l.24
Kind: behavior

## Intent
The home page and menu now share the manifest's one-level group parents. A group's sub-areas are nested in the menu and the catalogue, and each group carries the total of its branch, counted before rows that have their own pages are hidden. Questions, tasks and problems stand directly under Home with their open counts, empty ones grey; sources and settings move to the foot; the kind cards leave the front. The glossary becomes a compact table with one row per term — the term, its definition in the wiki's language, its source mark and its place shown once — while the original expands in place, and seven terms fit one 1150 px screen.

The second commit closes the gaps review found: the tasks badge reads the closure the Tasks page reads, the problems badge is cached under a key stamping every file the Problems page reads, a manifest group may say `open: true`, a parent total counts all sub-areas, and an invalid parent edge is discarded so a cycle's groups stand at the top level.

## Out of scope
- A redesign of the home page beyond removing the kind cards and moving what waits for the reader.
- Changing the manifest's own group schema beyond the optional `open` flag.
- Giving a glossary term a new source or rewriting its definition; the table shows what the term already has.

## Rationale
The owner asked for a more compact glossary, for the catalogue to be split by category such as devops, said the kind cards duplicate the left menu, and asked why questions and tasks were at the bottom. The manifest already names one-level group parents, so the catalogue and menu can share that structure rather than inventing a second taxonomy in the engine. Putting what waits for the reader under Home gives the counts the first place, and the compact glossary shows seven terms on one screen while keeping the original available in place.

## Changes to requirements
- wiki-navigation/sub-areas (new): the menu and catalogue nest a manifest group's one-level sub-areas and show each branch total; an invalid parent edge is discarded. Scenarios: `sub-areas-are-nested`, `a-cycle-stands-at-the-top`.
- wiki-navigation/waiting-first (new): questions, tasks and problems stand under Home with open counts and grey empties, sources and settings stand at the foot, and the kind cards leave the front. Scenarios: `waiting-sits-under-home`, `empty-counts-are-grey`.
- wiki-navigation/glossary-table (new): the glossary is a table with one row per term, its definition in the wiki's language, its source and its place once; the original expands in place and seven terms fit a 1150 px screen. Scenarios: `a-term-is-one-row`, `seven-terms-fit`.
- wiki-navigation/menu-state (new): a menu badge follows the same closure its page reads, is refreshed when any file its page reads changes, and a group marked `open` opens itself. Scenarios: `a-commit-closed-task-is-not-open`, `a-group-marks-itself-open`.

## Preserved contracts
- product-wiki/shell: the reading shell keeps its layout, its top bar and its document column; this change regroups the navigation and the catalogue inside that shell and adds no second navigation.

## Coverage
- wiki-navigation/sub-areas: test
- wiki-navigation/waiting-first: test
- wiki-navigation/glossary-table: test
- wiki-navigation/menu-state: test
- product-wiki/shell: test

## Where it is seen

Kind: internal
Place: the product wiki's home page, left menu and glossary view
Reason: the merge carries browser assertions, not a committed mockup; the screen is the wiki the product already serves, and the grouping, counts and compact glossary are held by those assertions.

1. Open a filled product's home page at 1150 px and see questions, tasks and problems with their counts directly under Home, sources and settings at the foot, and no kind cards.
2. Open the catalogue and menu: a manifest group's sub-areas are nested, and each group shows its branch total; mark a group `open` in the manifest and see it open itself.
3. Open the glossary: one row per term with its definition and source, the place shown once, the original expanding in place, and seven terms on one 1150 px screen.

## Blocking questions
None.

## Design and decisions
One-level group parents come from the product manifest, not from a list in the engine; the menu and catalogue read the same resolved groups. A group's total is counted over every sub-area before rows with their own pages are hidden, and an edge that would make a cycle is dropped, leaving those groups at the top level. The tasks badge reads the Tasks page's closure, and the problems badge's cache key stamps the manifest, its templates, the Markdown kinds, documents, questions, corrections and the store's identities and classifications. The glossary renders a table and keeps the original as an in-place expansion; its place is rendered once.

## Acceptance evidence
- PR #190 (`0395ac00`) grouped the menu and catalogue by manifest sub-areas, moved the waiting items under Home, and made the glossary a compact table.
- `test/knowledge-subgroups.test.ts`, `test/loop-menu-counts.test.ts` and `wiki/app/src/knowledge/layout.test.tsx` hold the nested groups, the totals, the `open` flag, the cycle, the badge freshness and the glossary table.
