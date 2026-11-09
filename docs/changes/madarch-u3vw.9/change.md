# The catalogue is a place of the product, not a row that waits for a person

Change: madarch-u3vw.9
Base: 04bcf3317972b6373b3d49e68dc0344403311a37
Tasks: madarch-u3vw.9
Kind: no-behavior

## Intent
The sidebar drew every link of the catalogue under the heading «Ждёт вас» (Waiting for you), beside Questions, Tasks and
Problems. The catalogue waits for nobody: nothing in it is a queue of a person's work, and a reader looking for the
product's kinds had to look among the things that ask for an answer. Its link now stands directly under Home, before the
waiting group, and the group keeps its three rows: Questions, Tasks and Problems.

## Out of scope
- The catalogue's page, its rows and its counts.
- The order or the contents of Questions, Tasks and Problems.
- The phone drawer's behaviour, which draws the same navigation.

## Changes to requirements
None. The shell's navigation already says that the catalogue is a place of the product and the waiting group is the
things that wait for a reader; this change makes the drawing follow the written place.

## Preserved contracts
- product-wiki/shell: Home names the product front, the catalogue names every declared kind, «Ждёт вас» names Questions,
  Tasks and Problems with their counts, and the product's documents and settings keep their foot of the column.

## Coverage
- product-wiki/shell: test, `wiki/app/src/knowledge/layout.test.tsx` — the catalogue is Home's next row, not a child of
  the waiting group, and the three waiting rows stand in it.

## Where it is seen

Kind: internal
Place: the left navigation of a served product wiki
Reason: the row moves inside the navigation the shell already draws; no new screen, command or message is added.

1. Open the catalogue, then any page of the wiki, and see the catalogue's row under Home, outside «Ждёт вас».
2. Read the waiting group and see Questions, Tasks and Problems there with their counts.

## Blocking questions
None.

## Design and decisions
The link is one row of the navigation panel, moved to sit between Home and the waiting heading. No group is renamed and
no count is changed.

## Acceptance evidence
- `wiki/app/src/knowledge/app.tsx`: the catalogue link moves above `nav-waiting`.
- `wiki/app/src/knowledge/layout.test.tsx`: the order and the group's membership are held.
