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
When a product's wiki is served, its pages shall be shown in a reading shell: a left navigation holding the product's name and its documents grouped by kind — the kind a page's path names, pages outside a kind by themselves — with the current page marked visually and by its accessibility attributes, and every page of the wiki one click away from it; the document in the centre as the main element; and a place for a right context panel, closed by default and empty until content fills it. A focus mode shall hide both panels and bring them back, and on a narrow screen the navigation shall open from a menu without narrowing the document's column.

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
- Then: the navigation opens from a menu, and the document column keeps its measure without narrowing

## Requirement: reading-typography — Pages read on the shared design tokens
The app's styles shall take their values from one tokens module the editor of madarch-j0a reuses: font families, a type scale, spacing, colours, a light theme and a dark theme that follows the system setting. It shall ship the fonts it names — Inter for text and a monospace face — under the SIL Open Font Licence with Cyrillic, licences recorded beside the files, with a fallback stack for macOS, Linux and Windows. A page's text column shall measure 60 to 75 characters of body text with a body line height of 1.4 to 1.6, its heading scale shall keep a steady vertical rhythm, its quotes, code blocks, lists and tables shall read comfortably, and no element shall overflow the column at 1150 px or 390 px width.

### Scenario: column-and-leading
- Given: a fixture product whose page holds paragraphs, headings of every level, a list, a quote, a code block, a table and a long line
- When: its page is read at 1150 px and then at 390 px
- Then: at 1150 px the text column measures 60 to 75 characters with a body line height of 1.4 to 1.6; at both widths no element overflows the column, and at 390 px the column keeps its font size on the full available width, its characters-per-line recorded at the walk and not held to the desktop range (a phone column inside 60 to 75 characters would need the body size the owner rejected)

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
them; while they are there it shall not build again. If the build fails, the
command shall stop with exit 2 and print what the builder said.

### Scenario: built-on-first-use
- Given: a madarch checkout whose app has never been built
- When: a product's wiki is served
- Then: the app is built once, the command says so, and the wiki is served; serving a second time builds nothing

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
