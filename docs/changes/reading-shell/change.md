# Read the product's pages in a comfortable typography and layout shell

Change: reading-shell
Base: 772a25487f88e6e939ecfd14a9a2627c13f76527
Tasks: madarch-iuc.1, madarch-iuc.3.1, madarch-iuc.3.2, madarch-iuc.4.1, madarch-iuc.4.2, madarch-iuc.4.3, madarch-iuc.5.1, madarch-iuc.7.1
Kind: behavior

## Intent
Today the wiki app ships no stylesheet of its own, so every page shows the
browser's default HTML: no navigation, a measure that follows the window
width, and no reading rhythm. After this change the app holds one set of
design tokens — font families it ships (Inter and a monospace face under the
OFL, Cyrillic included), a type scale, spacing, colours, a light and a dark
theme following the system setting — and a layout shell built on them: a left
navigation of the product's documents grouped by kind with the current page
marked, the document in the centre, a focus mode that hides the panels, a
navigation menu on a phone, and a closed place for the right context panel.
The reading styles give the text column 60 to 75 characters at a body line
height of 1.4 to 1.6, with readable quotes, code blocks, lists and tables,
and no overflow at 1150 px or 390 px. The editor of madarch-j0a reuses the
same tokens.

Stories:
- As a person reading a product's wiki, I open a page and read it in a column
of about 70 characters at a comfortable size and line height, with the page
list one glance away in the left navigation.
- As a person who wants the text alone, I turn on focus mode and the panels
disappear; I turn it off and they come back.
- As a person reading on a phone, I open the same wiki and the navigation
waits in a menu instead of squeezing the text.

## Out of scope
Search (madarch-o0d); the context panel's content (madarch-fe1, madarch-0uc);
the editor, the Markdown and history modes and any editing (madarch-j0a);
the chat (madarch-cuu); the diagram tabs' own styling; the static Starlight
export; a theme switch inside the app.

## Rationale
Added to idea-to-wiki by the owner on 2026-10-09 as a scope addition
(recorded in the charter's scope decisions). The owner likes Zettlr's
typography; a design mockup ("Madarch Wiki v2", static, not kept in the
repository) is a reference, not a target. The owner rejected a green accent
first version (neutral graphite with larger text was accepted as the
direction), and decided: no brand colour and no smaller interface without
asking, and the dark theme follows the system setting. The mockup's found
faults this change fixes: it names Inter but does not ship it (Linux fell
back to DejaVu Sans), its icons are Unicode symbols half missing on Linux,
its 740 px column at 18 px gives about 80 to 85 characters, the phone
toolbar crowds, and its 9 to 10 px grey secondary text needs a measured
contrast check.

## Changes to requirements
- product-wiki/shell (new): the app's layout shell — the left navigation with the product's documents grouped by kind and the current page marked visually and by accessibility attributes, the document in the centre, a focus mode hiding the panels and bringing them back, on a narrow screen the navigation in a menu without narrowing the text, and a right context panel place closed by default and empty.
- product-wiki/reading-typography (new): the reading styles on the shared tokens — the shipped fonts with their licences, a text column of 60 to 75 characters, a body line height of 1.4 to 1.6, a heading scale with a steady rhythm, readable quotes, code blocks, lists and tables, no element overflowing the column at 1150 px and 390 px.
- glossary (present document): the shell's names (reading shell, focus mode, context panel, design tokens) get entries.

## Preserved contracts
- product-wiki/pages: unchanged; which pages exist and how they are read from the API does not move.
- product-wiki/live: unchanged; the polling and refetch behaviour stays.
- product-wiki/serve: unchanged; the command and its exits stay.
- product-wiki/app: unchanged; the app is still built from wiki/app by the madarch build.
- product-wiki/result: unchanged; the serve command's exits and refusals stay.

## Coverage
- product-wiki/shell: test, browser-walk
- product-wiki/reading-typography: test, browser-walk
- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test

## Blocking questions
None.

## Design and decisions
The token values are proposed by the research madarch-iuc.1 and are
implementation detail of its task; this change fixes only the ranges the
owner set (column 60 to 75 characters, line height 1.4 to 1.6, dark theme
following the system, no brand colour, larger text). Icons are inline SVG,
never Unicode symbols. Fonts ship under the SIL Open Font Licence from the
official releases with Cyrillic, each licence recorded beside the file;
Zettlr is GPL-3.0 and contributes ideas only. Documents are grouped by kind
from the page paths the server already gives: a first-level folder under
`docs/` that the skill set's product layout names as a kind groups under
that kind, other folders under their own name, and documents directly under
`docs/` (and the README) under the product group. The walk is accepted by
rendering pages the way a reader sees them in headless Chromium and
recording the measured numbers (characters per line, line height,
overflow).

The styling implementation (2026-10-10, madarch-iuc.7.1, the owner's decision recorded as 0020): the app's styling stands on Tailwind v4's CSS-first theme built from the tokens through @theme (the same token names the editor of madarch-j0a reads), the reading styles are our own element rules themed on the tokens — the design the decision named as "@tailwindcss/typography prose classes with our values on top" came out as these rules because the plugin's own defaults sit under every value we pin; the plugin stays pinned for the editor of madarch-j0a to take up — lucide-react is the icon source, and shadcn/ui's CLI-copied components (sheet, toggle, tooltip, button, Radix underneath) run the shell's existing behaviours, themed from the tokens. The structure follows the mockup (the owner's word: a structure to reach, improvements allowed, each departure with its reason reported); the hand-written stylesheets leave; no requirement of this change moves and no measured value changes.

## Acceptance evidence
Recorded on the change's tasks as check receipts and in the stages'
acceptance records, with the walk's numbers.

## DONE WHEN
On a served fixture product holding headings of every level, paragraphs, a
list, a quote, a code block, a table and a long line, read in headless
Chromium at 1440, 1150 and 390 px in light and dark: each page's text column
measures 60 to 75 characters, body line height is 1.4 to 1.6, no element
overflows the column, the dark theme follows the system setting, every page
is reached from the left navigation in one click with the current one marked
visually and by its accessibility attributes, the focus mode hides both
panels and brings them back, and on a phone the navigation opens from a menu
without narrowing the text. Where it is seen: the served wiki of the fixture
product, in a headless Chromium walk whose numbers are recorded.
