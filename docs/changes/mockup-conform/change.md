# The wiki reads like the mockup: the conformance pass of madarch-iuc.12

Change: mockup-conform
Base: 58fc5c0a65ad66176173d8049da3d65198e62879
Tasks: madarch-iuc.12
Kind: behavior

## Intent
The owner (2026-10-11, note-luna.md) called the wiki still far from the mockup and handed the mockup-conformance check and the rework to a worker. The worker compared each pair (1440 light, 1440 dark, 1150 light, 390 light, tall documents and homes, scrolled home, phone menu), named every visible difference and reworked wiki/app until the pairs read the same, except the named keepers: the search and its slot, the Reader/Editor/Markdown/History switch and the "Open questions" demo content are not built, and no control stands dead. The served chrome and the document column now sit where the mockup's do, at the mockup's sizes and weights, with the sidebar, top bar, tab strip, breadcrumb, product block and status bar matched, and the owner may improve on the mockup but never fell below it.

Stories:
- As the owner comparing my screen with the mockup, the difference lists of the fresh pairs are empty but for what is named kept on purpose.

## Out of scope
Search (its slot stays out, not a dead box); the view switch and history (they arrive with the editor work); open questions, prototypes/results pages (the mock-up's own demo content); the editor; the chat; a watch mode.

## Rationale
The owner's word at 2026-10-11 (note-luna.md): after the rebuild the wiki "is better, but still far from the mockup". The mockup may be improved on, never fallen below; the column measure follows the mockup's proportion where the window gives it room, citing the mockup's value.

## Changes to requirements
- product-wiki/shell: the chrome finishes at the mockup's geometry: the brand as the product's own mark, the product block naming the product with "Product space" and an initial square about 36 px, the product overview row without a trailing chevron, the sidebar's group heading in small muted uppercase, the breadcrumb two-coloured around a spaced slash, and the status bar carrying the wiki's actual live-connection state (Live open, Reconnecting dropped) on its left, never a claimed browser save.
- product-wiki/reading-typography: the body rides the mockup's 18 px, headings sit medium weight with normal tracking, and the column measure may take the mockup's proportion where the window gives it room.
- product-wiki/live: the app shows the stream's actual state on its own, and nothing outside the product's own files is claimed as saved.

## Preserved contracts
- product-wiki/pages: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test

## Coverage
- product-wiki/shell: test, browser-walk
- product-wiki/reading-typography: browser-walk
- product-wiki/live: test, browser-walk
- product-wiki/pages: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
