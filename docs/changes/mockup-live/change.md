# The wiki reads and looks like the mockup: live update by push, the shell at window height, the mockup's dark and home

Change: mockup-live
Base: cbc5316b18c7e4cf1c327fb3312b700445300546
Tasks: madarch-iuc.11
Kind: behavior

## Intent
The owner rejected the landed wiki on two grounds (note-owner-rejects.md): the app polls for changes every second, and the pages fall short of the mockup they were built to reach. After this change the server pushes change events over Server-Sent Events on one long-lived request and the app refetches only on an event (reconnecting with backoff when the stream drops), an idle tab makes no per-second requests beyond the open stream, and the reading shell holds every measure the owner's notes list: a window-height shell whose sidebar and top bars stay fixed while only the document column scrolls; the home as the mockup's overview (a lead, groups as quiet sections with counts, links not underlined, icon and title rows on the sidebar's rhythm); the tab strip row under the top bar carrying the open file's name (no dead controls); the dark palette at the mockup's warm graphite; the brand reading the product (m· madarch) with the product named in its block; the status bar at the very bottom of the window, not inside the scrolled content; typography riding the mockup's weights and sizes.

Stories:
- As the person reading with the wiki open all day, the tab sits at zero requests per second after load; a saved file still shows within two seconds, with no reload.
- As the owner comparing my screen with the mockup, the difference list is empty but for what was named kept on purpose.

## Out of scope
Search (madarch-o0d; its slot stays out, not a dead box); the view switch and history (they arrive when they work); open questions, prototypes/results pages (product documents of the skill set); the editor; the chat.

## Rationale
The owner's word at 2026-10-10 after the 07ca5fc landing (note-owner-rejects.md): "the owner ran the landed wiki in their own browser and says it does not look like the mockup, and asks why requests go out every second. They are right on both." The mockup may be improved on, but not fallen below.

## Changes to requirements
- product-wiki/live: the poll (one page list about once a second) is replaced by a server push: the server watches the product's working tree and answers one long-lived Server-Sent Events stream of change events; the app refetches on an event and reconnects with backoff on a dropped stream; the two-second live rule and the same-revision rule hold; an idle tab adds no per-second requests beyond the stream.
- product-wiki/shell: the reading shell gains the mockup's fixed-height layout (the window fills at any height, the sidebar and top bars stay while the document column scrolls), the tab strip row under the top bar with the open file's name (the switch itself arrives with madarch-j0a), the dark theme at the mockup's graphite, the home overview in the mockup's language, and the status bar at the window's bottom edge. (The shell requirement sits in the current spec already, through the close-out sync; this change re-states it with the additions.)
- product-wiki/reading-typography: the document typography adjusts to the mockup: heading weights step lighter while the body keeps its accepted 18 px, the eyebrow and the lead sit as the mockup places them, and the status bar stays quiet at the very bottom of the window.

## Preserved contracts
- product-wiki/pages: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test

## Coverage
- product-wiki/live: test, browser-walk
- product-wiki/shell: test, browser-walk
- product-wiki/reading-typography: browser-walk
- product-wiki/pages: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test

## Blocking questions
None.

## Design and decisions
- The SSE endpoint rides the app's server: one `GET /api/events` stream per open wiki, text/event-stream, an event per working-tree change (debounced), `retry:` on reconnect; the app keeps one stream per open page and stops when the tab hides? No: the tab still shows changes when it becomes visible again; the fetches are the only background work.
- The dark tokens move to the mockup's dark values; the light tokens stay at the accepted graphite.
- The home loses the boxed cards: quiet sections, compact grid, icon+title rows, counts small and muted.
- The tab strip row is structure only: the open file's name; the switch and history buttons do not render.
- Search stays OUT and its slot stays OUT; the task madarch-o0d holds it.
- At the time of this change, a committed sample product supplied the mockup's reading material (vision, requirements, decisions, research; every reading element; links between pages), so nothing wrote outside the repository. The demo runner served and opened it; `wiki:shots` rendered side-by-side pairs into a scratch folder, as documented under AGENTS.md Checks.
- The acceptance compares side by side at the owner's window and at 1440x900, 1150, 390, light dark, plus a tall window (1440x1400) and a scrolled home page; a vision-capable reviewer (gpt-6.1-sol with the images) must find no difference that is not on the named-keepers list.

## Acceptance evidence
Recorded on the change's tasks with the side-by-side pairs and the walk numbers.

## DONE WHEN
The owner's notes: the two grounds (polling, falling below the mockup) resolved; every screen compared side by side with differences fixed or named on purpose; a vision-capable reviewer finds no difference off the list; the idle-tab test holds; CI green; landing through main after the owner's yes on the side-by-side shots.
