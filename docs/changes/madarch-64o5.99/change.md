# The work area takes the screen's width; running prose keeps its measure

Change: madarch-64o5.99
Base: 1460a3b7dfeb14756a5cda0c017eab599b2837da
Tasks: madarch-64o5.99
Kind: no-behavior

## Intent
Pages were capped at the 960 px reading measure, so a wide screen left most of the work area empty and a diagram had no
room. The shell now caps the work area at a generous 1920 px with the side padding it had; the reading layout takes that
width, paragraphs, headings and quotes inside it stay at about 75ch, and tables, lists, diagrams, figures and charts take
the width they are given. One rule in the shell and one in the reading sheet, no page rules.

## Out of scope
The diagrams' own fit and colours (madarch-64o5.96) and the wider layout of the catalogue and the fill panel.

## Rationale
The work area is one flush surface on the screen; a cap per page made wide screens a margin with a page in it.

## Changes to requirements
None.

## Preserved contracts
- product-wiki/shell: the sidebar, the bars and the scrolling column stand as they were; only the column's width rule changes.
- product-wiki/reading-typography: prose keeps a reading measure.

## Coverage
- product-wiki/shell: test
- product-wiki/reading-typography: test

## Where it is seen
Kind: screen
Place: any page of a product at 1440, 2560 and 390
Mockup: docs/changes/madarch-64o5.99/home-2560-dark.png
1. Tables, lists, diagrams and charts use the screen's width up to the work cap.
2. Running prose stays a reading column of about 75ch.
