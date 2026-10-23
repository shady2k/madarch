# The reader shell: a selection opens nothing, an open page is focused, every tab has its title, sources show their titles, and a service ground is a card

Change: madarch-m38l.12
Base: 05af1efa4ccd3b72531c9f0c93fea0dd8d260982
Tasks: madarch-m38l.12
Kind: behavior

## Intent
The owner's walk of 0.2.2 on 2026-10-23 found five defects in the frame around the pages: selecting text opened a new statement page, opening an open page opened another copy, the home tab stayed «Загрузка…», the list called «Документы» showed file names although the wiki is not documents, and a statement grounded in a service showed `package.json`. This change fixes them where the reader meets them.

## Out of scope
- Product settings, manifest upgrade and the index refusal (madarch-m38l.11), the writer (madarch-m38l.13) and diagrams (madarch-m38l.15).
- Titles of documents beyond the first heading (front matter titles are not read).

## Changes to requirements
- wiki-reader-shell (absent on the target): add. Complete proposed text in `capabilities/wiki-reader-shell.md`.

## Preserved contracts
None.

## Coverage
- wiki-reader-shell/tabs: test
- wiki-reader-shell/sources: test
- wiki-reader-shell/entity-grounds: test
- wiki-reader-shell/kind-pages: test
- wiki-reader-shell/sidebar-counts: test
- wiki-reader-shell/fixed-reader-bars: test

## Where it is seen

Kind: screen
Place: any page of a product's wiki; the sources list; a statement page
Mockup: docs/prototypes/madarch-m38l.10/first-run-en.png

1. The reader drags across a sentence of a page: the text is selected and nothing opens. A click opens the statement in a tab; the same statement opened again brings its tab forward.
2. The reader opens «Источники»: each entry is a title with its path small under it; `AGENTS.md` and `CLAUDE.md` are not there; the filter finds a title or a path.
3. The reader opens a statement grounded in a service: a card with the service's name, kind, facts, connections and a link to its page. A statement grounded in a function still shows the code.
4. The reader opens «Страницы по видам»: a kind that already has its own top-level page, such as `doc.term` on «Глоссарий», is not listed a second time.
5. The reader expands sidebar groups until the list scrolls: the scrollbar gutter stays clear of the count column.
6. The reader scrolls a long page: the top bar and tab bar stay fixed while only page content scrolls; an anchor and a fullscreen diagram land below both bars.

## Blocking questions
None.

## Design and decisions
- The click handler of a sentence leaves selection gestures alone: a drag or a double click selects, so the click that ends it opens nothing. Statement opening waits one click interval so a native double click can select before it opens.
- A page has one tab. `focusOpenTab` finds the tab holding the same address without its section; a plain click, a control click and a statement click all go through it. When the address names a section, that tab shows it. Browser Back and Forward re-focus the tab already holding the history address rather than overwriting the active tab.
- `useTabTitle` depends on the tab's own title: the window moving to another page clears the title of the front tab, and the home page and its entity page are one mounted element, so a title that did not change was never written again, which left «Загрузка…». Error pages now title their tab as well.
- The server lists a document with its title (`DocumentRef.title`, from the same function that titles a document's page). A code repository's titles are read with one `git cat-file --batch` pair, not a process per document. `AGENTS.md` and `CLAUDE.md` are dropped by name at any depth in the listing only; entities and the pages still read them if a link names one.
- A ground's excerpt gains a third form, `entity`, for graph kinds that are things of the system. The engine names the kinds from its own code vocabulary (`code.service`, `code.package`, `code.database`, `code.table`, `code.channel`, `code.contract`, `code.message`, `code.operation`); a product kind is never named. The card reuses the properties and related blocks (four groups, five rows each); the kind's description is the manifest's, in the reader's language.
- "Sources" is the one word for the list in both languages («Источники»); the navigation, the page heading and the tab say it.
- A kind with its own top-level page is excluded from «Страницы по видам»; `doc.term` is represented by «Глоссарий», not a duplicate kind link.
- The sidebar reserves scrollbar space with a stable gutter and inset padding so expanded, scrolling groups cannot cover the count column.
- The toolbar and tabs share a sticky top block; the content area scrolls. Anchor targets and fullscreen diagrams use a top offset below both bars.

## Acceptance evidence
See the report of the pull request: tests in `wiki/app/src/knowledge/entities.test.tsx`, `test/knowledge-vertical.test.ts`, `test/product-wiki-serve.test.ts`, and the pictures of `bun scripts/shell-shots.ts` (ru and en, light and dark, 1150 px and 390 px).

## DONE WHEN
A drag across a sentence opens nothing; an open page is focused; no tab is titled as loading after load; the sources list shows titles over paths without `AGENTS.md` or `CLAUDE.md`; a statement grounded in a service shows a card and one grounded in a function shows code; «Страницы по видам» does not repeat a kind with its own top-level page; the sidebar scrollbar does not cover counts when groups are expanded; and on a long page the top bar and tab bar stay fixed while anchors and fullscreen diagrams land below them. All are checked in Russian and English, light and dark where applicable.
