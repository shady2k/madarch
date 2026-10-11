# Product wiki

Capability: product-wiki

## Purpose
A product's wiki as its reader reaches it on their own machine: madarch's own
thin app (decision 0018), served by a local madarch, showing the product's
pages read from its working tree, so that what the person and their agent
write is what the wiki shows as soon as it is saved. The static site the wiki
capability builds stays as the read-only export.

## Requirement: pages — The product's documents are the wiki's pages
When a product's wiki is served, it shall have a home page naming the product
and listing its pages, and one page for every Markdown file under the
product's `docs/` folder and for `README.md` at its root when it has one, in
code point order of their paths. It shall read those two places and nothing
else: the skill set's tracker at the product's root, every other dot-folder
and every other folder are neither pages of the wiki nor read by it. A page's title shall be its first level-one
heading, else its file's name without its extension, and its address shall be
`/p/` and its path within the product. A page shall show its Markdown as
formatted text. A link from one page to another page of the wiki shall open
that page; a link to anything else shall be shown as its text. A home page of
a product with no pages shall say that it has none yet.





### Scenario: draft-pages
- Given: a draft whose `docs/vision.md` holds `# Vision` and whose `docs/notes.md` holds no heading
- When: its wiki is opened
- Then: the home page names the product and lists `Vision` and `notes`, and `/p/docs/vision.md` shows the document's text as formatted text
### Scenario: no-pages-yet
- Given: a draft whose `docs/` holds no Markdown file
- When: its wiki is opened
- Then: the home page names the product and says it has no pages yet
### Scenario: link-between-pages
- Given: a product whose `docs/index.md` links to `vision.md` and to `../AGENTS.md`
- When: its index page is read
- Then: the link to `vision.md` opens the vision page, and the link to `AGENTS.md` is not a page of the wiki

## Requirement: shell — The reading shell holds the navigation, the document and the panel place
When a product's wiki is served, its pages shall be shown in a reading shell: a left navigation holding the product's name and its documents grouped by kind — the kind a page's path names, pages outside a kind by themselves — with the current page marked visually and by its accessibility attributes, and every page of the wiki one click away from it; the document in the centre as the main element; and a place for a right context panel, closed by default and empty until content fills it. A focus mode shall hide both panels and bring them back, and on a narrow screen the navigation shall open from a menu without narrowing the document's column. Language selection shall live in a globe menu in the top bar; the globe button shall have a localized accessible name and tooltip, and the menu shall mark the current language as checked.

The shell shall fill the window at any window height: its sidebar, its top bar and its tab strip stay while only the work area scrolls, and a tab strip row under the top bar carries the open file name (the view switch and history arrive with the editor work and no control stands dead). The document surface shall be flush across the work area, from the sidebar edge to the window edge and from the tab strip through the status bar, with no inset page or raised frame. The status bar stands at the very bottom of the window, outside the scrolled content, and carries on its left the wiki's actual live-connection state — Live when the event stream is open, Reconnecting while it is not — with nothing claimed about browser persistence. The chrome reads as the mockup lays it: the brand as the product's own mark, a product block naming the product with its "Product space" line and an initial square about 36 px, no trailing chevron on the product overview row, the sidebar's group heading in small muted uppercase, and a breadcrumb whose parent sits muted around a spaced slash with the current page in the primary text colour.

### Scenario: language-menu
- Given: the wiki is open with English chrome and the reader opens the globe menu
- When: the menu is shown and Russian is chosen
- Then: the menu marks English as checked before the choice, then the chrome changes to Russian and the saved preference is Russian
### Scenario: navigation-groups-and-marks
- Given: a served product whose `docs/` holds a vision, a requirement, a decision and a research note, opened at one of them
- When: its page is read in a browser
- Then: the left navigation lists all of them grouped by kind, the current page is marked visually and carries `aria-current`, and each other page opens with one click
### Scenario: focus-mode-hides-and-returns
- Given: a served product's page open
- When: focus mode is turned on and then off
- Then: with it on the navigation and the panel place are hidden and only the document shows; with it off both panels are back
### Scenario: phone-menu
- Given: the wiki open at 390 px
- When: the shell is read and the menu is opened
- Then: the navigation opens from a menu, and the text uses the full work area minus 20 px on each side without narrowing

### Scenario: flush-work-area-and-responsive-sidebar
- Given: the wiki open at a 1000x700 window and the reader exits focus mode
- When: the shell is read
- Then: the document and home surface is flush from the sidebar edge to the window edge, the sidebar is 240 px wide, and no inset or raised page frame remains
### Scenario: window-height-shell
- Given: the wiki open in a tall window (1440x1400) and then scrolled
- When: the shell is read while the column scrolls
- Then: the sidebar and the top bars stay fixed while only the document column scrolls, and the status bar stands at the bottom edge of the window
### Scenario: home-overview
- Given: a served product home read in a browser
- When: the home page is read
- Then: the home carries a lead, its documents grouped by kind with counts, links not underlined, each row icon and title on the navigation rhythm, and groups that share the document text measure with rounded hairline borders and no inner rules
### Scenario: connection-state-in-the-status-bar
- Given: the wiki served and its event stream open
- When: the status bar is read, and then the stream is dropped
- Then: with the stream open the status bar names the connection Live; with it dropped it names Reconnecting, and it never claims a browser save happened

## Requirement: reading-typography — Pages read on the shared design tokens
The app's styles shall take their values from one tokens module the editor of madarch-j0a reuses: font families, a type scale, spacing, colours, a light theme and a dark theme that follows the system setting. It shall ship the fonts it names — Inter for text and a monospace face — under the SIL Open Font Licence with Cyrillic, licences recorded beside the files, with a fallback stack for macOS, Linux and Windows. Document text and home groups shall share one fluid measure: 48 px inline padding on desktop, 32 px on tablet and 20 px on phone, with a 960 px maximum text width centered only when the work area has room. Its body line height shall be 1.4 to 1.6, its heading scale shall keep a steady vertical rhythm, its quotes, code blocks, lists and tables shall read comfortably, and no element shall overflow the text area. The column measure: the earlier research value (36em/62 chars; the mockup's 740px) is superseded by the owner's fluid-width direction of 2026-10-11 (note-width.md).

The document typography reads like the mockup: the body rides the mockup's 18 px, heading weights sit medium with the mockup's normal tracking, and the eyebrow and the lead sit as the mockup places them. The shared design tokens define calm, neutral surfaces, radii and three restrained shadow levels in both themes. The work area has no inset or raised page frame; home groups use the shared measure, rounded hairline borders and no inner rules. The shell uses tokens consistently, keeps hover and focus visible, and honors reduced motion.

### Scenario: layered-surfaces-and-accessible-states
- Given: the wiki is shown in light or dark theme, including with reduced motion requested
- When: its navigation, document, cards, controls, code and menus are read or focused
- Then: their surfaces and radii follow the shared tokens, elevation stays restrained, hover and keyboard focus remain visible, and reduced motion disables transitions

### Scenario: fluid-column-and-leading
- Given: a fixture product whose page holds paragraphs, headings of every level, a list, a quote, a code block, a table and a long line
- When: its page and home are read at 1000x700, 1150x900, 1440x900 and 390x844
- Then: at 1000 and 1150 px the text fills the work area minus 48 px desktop padding; at tablet widths it uses 32 px padding; at 390 px it uses 20 px padding; at 1440 px it is capped at 960 px and centered. The browser walk records the exact text widths at 1000, 1150 and 1440 px; body line height stays 1.4 to 1.6, and no element overflows the text area.
### Scenario: dark-follows-system
- Given: the system set to dark mode
- When: a page of the wiki is opened
- Then: the page shows the dark theme without a switch inside the app
### Scenario: shipped-fonts-render
- Given: a page of the wiki on Linux, where no system font matches Inter
- When: the page's rendered text is inspected
- Then: the page's text renders in the shipped Inter and its code in the shipped monospace face, not in a fallback the system chose

## Requirement: live — A page follows its file as it is saved
When a page is asked for, its text shall be read from the product's working
tree then, never from a copy kept from an earlier read. When a file of the
wiki is created, changed or removed while the wiki is open, every open page
shall show what the working tree holds within two seconds, with the server
still running and without the reader reloading the page. The same pages shall
give the same revision, so an unchanged wiki is never shown as changed.

The server watches the product working tree and answers one Server-Sent Events stream (one long-lived request per open wiki, debounced as a tree change arrives); an open page refetches what it shows when its stream carries an event, and reconnects with backoff when the stream drops. A loaded tab the reader leaves alone makes no per-second requests beyond its open stream. The app shows the stream's actual state on its own (Live when open, Reconnecting while it is not); no save events outside the product's own files are claimed.

### Scenario: saved-file-becomes-a-page
- Given: a served draft with no pages, open in a browser
- When: `docs/vision.md` is written in the product root
- Then: the vision page's title appears in the open home page within two seconds, without a reload and with the server still running
### Scenario: open-page-follows-its-file
- Given: a served draft whose page `/p/docs/vision.md` holds `# Vision`, open in a browser
- When: the file is saved with `# Vision` and the sentence `What it is for.` below it
- Then: the open page shows the new text within two seconds, without a reload
### Scenario: no-cache
- Given: a served draft
- When: one page is asked for before and after its file is saved
- Then: the two answers differ, the second holding the new bytes
### Scenario: idle-tab
- Given: the wiki open in a loaded tab the reader leaves alone for a minute
- When: the open page's requests are read for that minute
- Then: no per-second requests go out after the load beyond the one open stream

## Requirement: serve — A local madarch serves the wiki and opens it
When a local madarch is given a product folder, it shall serve that product's
wiki at its address and print the address; `madarch new` shall create the
draft and serve its wiki in one command, and `madarch serve` shall serve the
product of the current folder when it is given none. `madarch new` shall open
the address in the browser the machine uses; where no browser can be opened,
it shall say so and print the address without failing. The server shall serve
the app's built files and answer the wiki's pages; a request it cannot answer
shall be refused with a message naming what was asked for, and no document's
content shall be logged.





### Scenario: new-opens-the-wiki
- Given: `MADARCH_HOME` names a scratch folder and the machine's browser opener is recorded
- When: `madarch new` is run
- Then: the command prints the address, opens that address in the browser, and the address answers the draft's home page while the command runs
### Scenario: serve-an-existing-product
- Given: a draft created earlier and no server running
- When: `madarch serve` is run in the product's root
- Then: the same wiki answers at the address it prints
### Scenario: unknown-page
- Given: a served draft
- When: a page of a path the product does not hold, and a path outside its `docs/`, are asked for
- Then: each is refused, naming the path and that the wiki does not hold it

## Requirement: app — The wiki is madarch's own app, served from madarch's build
When a product's wiki is served, its pages shall be shown by madarch's own app:
the static files madarch's build produces from `wiki/app` in the madarch
checkout (decision 0018). When those files are absent, the command shall
build them once from that folder, saying so before it starts, and then serve
them. The build shall record into the dist the hash of the app's sources and
lockfile, and the command shall compare that record against the sources on
every later start: with sources unchanged it shall not build again; with
sources changed since the build it shall build again, saying so in one line
before it starts. A dist holding no record — built by hand — shall be served
as it stands. If the build fails, the command shall stop with exit 2 and
print what the builder said.




### Scenario: built-on-first-use
- Given: a madarch checkout whose app has never been built
- When: a product's wiki is served
- Then: the app is built once, the command says so, and the wiki is served; serving a second time with unchanged sources builds nothing
### Scenario: sources-changed-since-the-build
- Given: a checkout whose app was built from its sources, then a source file changed
- When: a product's wiki is served again
- Then: the app is built again, with one line saying so before it starts
### Scenario: hand-built-dist
- Given: a dist with no hash record of its build
- When: a product's wiki is served
- Then: nothing is built and the dist is served as it stands
### Scenario: build-fails
- Given: an app folder whose build fails
- When: a product's wiki is served
- Then: the command exits 2 printing what the builder said, and serves nothing

## Requirement: result — Served, opened or refused, and why
When a product's wiki is served, the command shall serve until it is stopped.
It shall exit 2 when its input cannot be read — an argument it does not know,
a product folder that is not there, a product whose manifest cannot be read, an
address already taken, or an app that cannot be built — naming what is wrong;
and 1 when a step it takes fails. Serving shall change neither the product's
files nor its repository.






### Scenario: no-product
- Given: a folder that holds no `workspace.yaml`
- When: `madarch serve --product` naming that folder is run
- Then: it exits 2 naming the folder and the manifest it looked for
### Scenario: address-taken
- Given: a server already answering on the default port
- When: another product's wiki is served on it
- Then: it exits 2 naming the address and the option that moves it
### Scenario: serves-read-only
- Given: a served draft with its files and its git status recorded
- When: its home page and one page are opened
- Then: the product's files and its git status are unchanged
### Scenario: only-docs-and-readme-are-pages
- Given: a product whose root holds `.beads/issues.jsonl`, `skills/own.md`, `docs/vision.md` and `README.md`
- When: its wiki is listed
- Then: the pages are `README.md` and `docs/vision.md`, and neither the tracker nor `skills/own.md` is a page or is read

## Requirement: internationalization — The wiki app speaks English and Russian
The product wiki's app shall provide its chrome in English and Russian through
message catalogues with the same keys. A language control in the shell shall
switch languages, expose its selected state to assistive technology, and retain
the reader's choice in local storage. Before the reader chooses, the app shall
select Russian for a browser language beginning `ru` (case-insensitive), and
English for every other or missing browser language. Changing the chrome shall
never translate product document content.

Every app-owned visible string shall use the selected catalogue, including the
sidebar, top bar, document tab, document-kind eyebrow, home overview, status,
loading and error states, tooltips and accessible labels. Counts and relative
file-change times shall follow the selected language through `Intl.PluralRules`
and `Intl.RelativeTimeFormat`. The document's changed-time label shall use the
file's real modification time, never placeholder content.

### Scenario: browser-language-default
- Given: the wiki is opened with no saved choice in a browser whose language is `ru-RU`, and then in one whose language is `en-US`
- When: each wiki shell first renders
- Then: the first shell is Russian and the second is English
### Scenario: language-choice-persists
- Given: the wiki is open in English
- When: the reader selects Russian and reloads the wiki
- Then: the chrome is Russian after the reload, the control names Russian as selected, and product document text stays unchanged
### Scenario: russian-counts
- Given: the shell is Russian
- When: a page has 1, 2 or 5 words
- Then: its status line uses `1 слово`, `2 слова` or `5 слов` respectively
### Scenario: localized-date
- Given: a page file has a recorded modification time
- When: the page is read in English or Russian
- Then: its eyebrow reports the real relative modification time in the selected language
### Scenario: catalogue-key-parity
- Given: the English and Russian JSON catalogues
- When: their message keys are compared
- Then: each key exists in both catalogues