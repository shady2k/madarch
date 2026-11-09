# The current row of the sidebar draws its line whole

Change: madarch-u3vw.10
Base: 04bcf3317972b6373b3d49e68dc0344403311a37
Tasks: madarch-u3vw.10
Kind: no-behavior

## Intent
The current page's row in the sidebar is marked by its line, and the line was cut on the row's left edge: the list is a
scrolling column with no left padding, so anything drawn outside a row's box loses its left side at the column's edge.
The row now carries the line inside its own box, one pixel, all four sides whole, and an inactive row carries none. A
keyboard focus inside the list is drawn inside its row for the same reason, so the list never clips a mark it shows.

## Out of scope
- The active row's colour, type weight and width.
- The background of the scrollable list and the column's own width.
- The waiting group's rows and the product block above the list.

## Changes to requirements
None. The shell already requires the current page to be marked visually; this change makes the mark whole.

## Preserved contracts
- product-wiki/shell: the current page is marked visually and with `aria-current="page"`, an inactive row is unmarked,
  the sidebar's list stays in view as the document scrolls, and the row's text and count are unchanged.

## Coverage
- product-wiki/shell: browser check, `test/wiki-catalogue-e2e.test.ts` — the active row's outline box lies inside the
  list's visible box at 1150 and 390 px in both themes, and an inactive row has no outline.

## Where it is seen

Kind: internal
Place: the left navigation of a served product wiki, at 1150 and 390 px in the light and dark themes
Reason: the change corrects the mark the shell already draws; no new screen, command or message is added.

1. Open the catalogue at 1150 px in the light theme and see the current row's line on all four sides.
2. Repeat in the dark theme, at 390 px with the menu drawer open, and read the same whole line.
3. Read another row and see no line on it.

## Blocking questions
None.

## Design and decisions
The current row's mark is an inset outline (`outline-offset: -1px`), which is painted inside the row's border box and so
cannot be clipped by the list's `overflow-y: auto`. A keyboard focus ring in the list uses the same inset offset. The
background of the active row is unchanged.

## Acceptance evidence
- `wiki/app/src/styles/index.css`: `.nav-current` draws the inset line, and `.app-nav a:focus-visible` draws its ring
  inside the row.
- `test/wiki-catalogue-e2e.test.ts`: the browser assertion over the outline box at both widths and both themes.
