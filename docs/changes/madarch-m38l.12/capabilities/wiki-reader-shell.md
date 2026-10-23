# Wiki reader shell

Capability: wiki-reader-shell

## Purpose
What the reader does inside the knowledge wiki's frame: the tabs, the click on a
sentence, the list of sources, and the grounds of a statement. The owner's walk
of 0.2.2 (2026-10-23) found each of them acting against the way editors and
reading tools behave.

## Requirement: tabs — A tab is named by its page and a page has one tab
When a reader selects text, drags across a sentence or ends a selection with a
click, the wiki shall open nothing. When a reader opens a page that a tab already
holds (the address without its section), the wiki shall bring that tab to the
front, showing the section if the address names one, and shall not open a second
tab for it. Every page shall name its tab once it has loaded, an error page
included, and a tab shall never keep the word for loading after the page is shown.

### Scenario: drag-opens-nothing
- Given: a page with a statement sentence and one tab
- When: the reader drags across the sentence and releases
- Then: the text is selected, the tab count is unchanged and no statement page opens

### Scenario: open-page-is-focused
- Given: two tabs, the second holding the catalogue
- When: the reader follows a link to the catalogue from the first tab
- Then: the second tab is in front and the wiki holds two tabs

### Scenario: tab-keeps-its-title
- Given: a home page open in its tab
- When: the reader goes to another page and back with the back button
- Then: the tab is named by the home page and never by the word for loading

## Requirement: sources — The sources are listed by title with their path under it
The wiki shall call its list of Markdown documents "Sources" (ru: «Источники»)
with one line saying what they are. Each entry shall show the document's title,
its first level-one heading, else its file name without the Markdown extension,
with its path in small type under it. The filter shall match the title and the
path. The harness files of a coding agent, `AGENTS.md` and `CLAUDE.md` at any
depth, shall not be listed.

### Scenario: titled-sources
- Given: a product with `docs/vision.md` headed `# The vision`, `docs/notes.md` with no heading, and `AGENTS.md` and `CLAUDE.md` at its root
- When: the sources are opened
- Then: the list shows `The vision` over `docs/vision.md` and `notes` over `docs/notes.md`, no entry for `AGENTS.md` or `CLAUDE.md`, and the filter `vision` and the filter `docs/notes` each leave one entry

## Requirement: entity-grounds — A ground that is a thing of the system is shown as a card
When the ground of a statement is a service, a package, a database, a table, a
channel, a contract, a message or an operation, the statement page shall show a
card of it with its name, its kind and what the kind is, what the code says of it,
what it is connected to, and a link to its page, and shall not show the file it
was read from. A ground that is a function, a class, a file or a route shall keep
its excerpt of code, and a ground that is a document its text.

### Scenario: service-ground-is-a-card
- Given: a statement grounded in a service read from its manifest and another grounded in a function
- When: the statement pages are opened
- Then: the first shows the service's card, never the manifest's text, and the second shows the function's lines with the cited ones marked
## Requirement: kind-pages — A kind with its own top-level page is not duplicated in kind navigation
The «Pages by kind» navigation shall omit a kind when the wiki gives that kind its own top-level page. For example, `doc.term` is represented by the «Glossary» page and shall not also appear as a kind entry. The kind remains reachable from its top-level page and from links.

### Scenario: glossary-kind-is-not-repeated
- Given: the wiki has glossary terms of kind `doc.term` and a top-level glossary page
- When: the reader opens «Pages by kind» in the navigation
- Then: `doc.term` is absent from the kind list while the «Glossary» page remains available

## Requirement: sidebar-counts — The scrolling sidebar keeps counts clear of its scrollbar
When navigation groups are expanded and the sidebar scrolls, the scrollbar shall not cover the count column. The layout shall reserve a stable scrollbar gutter or equivalent inset space for both classic and overlay scrollbars.

### Scenario: expanded-sidebar-counts-remain-visible
- Given: enough expanded navigation groups to make the sidebar scroll
- When: the reader scrolls the sidebar to its end
- Then: every visible count remains outside the scrollbar's track and can be read

## Requirement: fixed-reader-bars — The top bar and tabs stay fixed while page content scrolls
The top bar and tab bar shall remain fixed at the top of the reader while only page content scrolls. Anchor targets and fullscreen diagrams shall be positioned below both bars, not hidden behind them.

### Scenario: long-page-scroll-keeps-reader-bars
- Given: a long page with section anchors
- When: the reader scrolls the page and follows an anchor
- Then: the top bar and tab bar remain in place and the target section starts below them

### Scenario: fullscreen-diagram-clears-reader-bars
- Given: a page containing a diagram that can open fullscreen
- When: the reader opens the diagram fullscreen
- Then: the fullscreen diagram is positioned below the fixed top bar and tab bar
