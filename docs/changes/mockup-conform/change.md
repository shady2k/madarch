# The wiki reads like the mockup: the conformance pass of madarch-iuc.12

Change: mockup-conform
Base: 58fc5c0a65ad66176173d8049da3d65198e62879
Tasks: madarch-iuc.12
Kind: behavior

## Intent
The owner (2026-10-11, note-luna.md) called the wiki still far from the mockup and handed the mockup-conformance check and the rework to a worker. The worker compared each pair (1440 light, 1440 dark, 1150 light, 390 light, tall documents and homes, scrolled home, phone menu), named every visible difference and reworked wiki/app until the pairs read the same, except the named keepers: the search and its slot, the Reader/Editor/Markdown/History switch and the "Open questions" demo content are not built, and no control stands dead. The served chrome and document typography match the mockup's sizes and weights, with the sidebar, top bar, tab strip, breadcrumb, product block and status bar matched. In round 3, the coordinator asked for a top-bar globe menu and restrained shared surface, radius and shadow tokens in both themes, with visible focus and hover and reduced-motion support. The owner's round-4 direction replaces the inset reading page with a flush work area, responsive side padding and a shared fluid measure for documents and home groups.

Stories:
- As the owner comparing my screen with the mockup, the difference lists of the fresh pairs are empty but for what is named kept on purpose.

## Out of scope
Search (its slot stays out, not a dead box); the view switch and history (they arrive with the editor work); open questions, prototypes/results pages (the mock-up's own demo content); the editor; the chat; a watch mode.

## Rationale
The owner supplied the 2026-10-11 fluid-width direction in note-width.md: remove the inset page, use responsive inline padding, and let the text fill the available work area until a 960px cap is useful. The column measure: the earlier research value (36em/62 chars; the mockup's 740px) is superseded by the owner's fluid-width direction of 2026-10-11 (note-width.md). The work area stays flush; only the content is capped and centered when the window is wide enough.

## Changes to requirements
- product-wiki/shell: the chrome finishes at the mockup's geometry: the brand as the product's own mark, the product block naming the product with "Product space" and an initial square about 36 px, the product overview row without a trailing chevron, the sidebar's group heading in small muted uppercase, the breadcrumb two-coloured around a spaced slash, and the status bar carrying the wiki's actual live-connection state (Live open, Reconnecting dropped) on its left, never a claimed browser save. Language selection lives behind a top-bar globe menu with a localized accessible name and tooltip; the menu marks the selected language as checked and the sidebar footer has no language controls. The work area is one flush surface from the tab strip through the status bar; at 1000 px the sidebar is 240 px wide and focus mode still collapses it.
- product-wiki/reading-typography: the body rides the mockup's 18 px, headings sit medium weight with normal tracking, and text fills the available work area inside responsive side padding (48 px desktop, 32 px tablet, 20 px phone), capped at 960 px and centered only when space allows. Documents and home groups share this measure. Shared neutral surface, radius and three-level shadow tokens support restrained depth in both themes; home groups use a rounded hairline border without inner rules or a card shadow; hover and keyboard focus remain visible, and reduced motion disables transitions.
- product-wiki/live: the app shows the stream's actual state on its own, and nothing outside the product's own files is claimed as saved.

## Preserved contracts
- product-wiki/pages: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test

## Coverage
- product-wiki/shell: test, browser-walk
- product-wiki/reading-typography: test, browser-walk
- product-wiki/live: test, browser-walk
- product-wiki/pages: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- product-wiki/internationalization: test, browser-walk
