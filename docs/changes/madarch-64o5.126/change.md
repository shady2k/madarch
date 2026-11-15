# No page is wider than its work area

Change: madarch-64o5.126
Base: 39bf4ae12863dc42f0808cf0641d042f1e8d71b9
Tasks: madarch-64o5.126
Kind: behavior

## Intent
Every page fits its work area at 1440 and 390 px. A long machine path in a card wraps instead of widening or being cut,
and no page has horizontal overflow. Wide tables and diagrams keep their own scroller.

## Rationale
Owner, 2026-11-15: «Вот здесь обрезается часть страницы, не помещается». The settings cards carry machine paths and
agent install folders; a path without spaces pushed the card past the work area's right edge.

## Out of scope
- The content of a page; this change only makes the shell, cards and inline code fit.
- A table or diagram that is deliberately wider than its column: it may scroll inside its own container.

## Changes to requirements
- product-wiki/no-horizontal-overflow: add. Every page and card fits at 1440 and 390 px; unbroken paths wrap; wide tables
  and diagrams scroll in their own container.

## Preserved contracts
- product-wiki/shell: the sidebar, top bar and work area keep their sizes; the fix adds min-width and wrapping, not a new frame (static test)
- product-wiki/reading-typography: prose keeps its reading measure; only unbroken code and paths wrap (static)

## Coverage
- product-wiki/no-horizontal-overflow: static test mutation review
- product-wiki/shell: static test mutation review
- product-wiki/reading-typography: static test

## Where it is seen
Kind: screen
Place: a served product's settings page at `/p/settings`, and every page at 1440 and 390
Mockup: docs/prototypes/long-path-settings.png

1. Open a product whose machine folder path is long and unbroken at 390 px.
2. Read the settings cards: the path wraps inside the card, the card's right edge is inside the work area, and the page has no horizontal overflow.
3. Read the home, catalogue, settings, sources, problems, glossary, runs, kit, preparation, search and entity pages at 1440 and 390: each work area has no horizontal overflow.

## Blocking questions
None.

## Design and decisions
The card, card header and card content take `min-w-0` and `max-w-full`; `InlineCode` wraps anywhere; the settings agent
note wraps long paths; inline code inside pages wraps anywhere. The work area already has a scrolling content column and
its tables and diagrams keep their own scrollers, so the page itself never widens.

## Acceptance evidence
Static: `bun run check` passed; the wiki app's `bun run check` passed.
Test: the app suite 121 passed, 0 failed.
Audit: a headless Chromium opened the home, catalogue, settings, sources, problems, glossary, runs, kit, preparation,
search and three catalogue entity pages at 1440 and 390; every page's `main` scroll width equalled its client width, and
the document's scroll width equalled the viewport. The settings page was also opened with a 263-character machine home
path at both widths: every card's right edge stayed inside the work area, and the path wrapped.
Screens: `docs/changes/madarch-64o5.126/mockups/` holds the long-path settings at 1440 and 390, light and dark.
Mutation: not run, filed per the stage rule.
Review: pending; this record is for the review.

## DONE WHEN
No wiki page has horizontal overflow at 1440 or 390; a long machine path wraps inside its card; and a deliberately wide
table or diagram scrolls inside its own container.
