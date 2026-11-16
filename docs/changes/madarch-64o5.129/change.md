# A diagram opens at full screen again, and the words of the old control are used

Change: madarch-64o5.129
Base: b43b57ff88f525024961bdd2f855531643b3dc44
Tasks: madarch-64o5.129
Kind: behavior

## Intent
The owner's walk: «Где просмотр на всю страницу? Раньше был.» The old wiki wrapped every diagram in a full-screen frame
(`diagrams/fullscreen.tsx` at `fcbc2004b^`: a button, Escape to leave, the picture taking the window, a press on a node
leaving the frame and opening the page). PR #299 kept only the words — `knowledge.views.fullscreen` and
`exitFullscreen` in both locales — and the CSS of the removed control, with nothing using either.

The diagram section now carries the button the words name; the picture opens in the kit's dialog at 92 % of the window,
its panes fill it, Escape and the dialog's close button leave it, and a press on a node leaves it before opening the
page. The CSS of the old mechanism is deleted.

## Out of scope
Depth 2 and the "+" expansion of a node (audit §6 rows 58, 59) and opening a node in a new tab (row 64).

## Rationale
A neighbourhood of many nodes is unreadable in a reading column; the reader could take it to the window before and
cannot now.

## Changes to requirements
- views/one-view: a picture opens at full screen, takes the window with pan and zoom, and leaves on Escape.

## Preserved contracts
- product-wiki/shell: the page's own shell and its figure are unchanged.

## Coverage
- views/one-view: test
- product-wiki/shell: test

## Where it is seen
Kind: screen
Place: an entity page's «Вокруг», the «На весь экран» button beside the renderer choice
Mockup: docs/prototypes/madarch-64o5.129/fullscreen-1440-light.png
1. Press «На весь экран»: the picture fills the window and its pan and zoom still work.
2. Press Escape or the dialog's close button: the page returns as it was.
3. Press a node in the full-screen picture: the full screen closes and the node's page opens.
