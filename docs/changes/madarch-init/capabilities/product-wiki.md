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
that page; a link to anything else shall be shown as its text. A home page of a product with no pages shall say that the product has no pages yet.





### Scenario: draft-pages
- Given: a draft whose `docs/vision.md` holds `# Vision` and whose `docs/notes.md` holds no heading
- When: its wiki is opened
- Then: the home page names the product and lists `Vision` and `notes`, and `/p/docs/vision.md` shows the document's text as formatted text
### Scenario: no-pages-yet
- Given: a product with no Markdown documents, with or without a product manifest
- When: its wiki is opened
- Then: the home page names the product and says it has no pages yet

### Scenario: link-between-pages
- Given: a product whose `docs/index.md` links to `vision.md` and to `../AGENTS.md`
- When: its index page is read
- Then: the link to `vision.md` opens the vision page, and the link to `AGENTS.md` is not a page of the wiki

## Requirement: overview — A product's home explains it before listing its groups
When a product's wiki has a normalized overview projection, its home shall
introduce the product on its first screen before listing document groups. The
optional response shape is `overview?: { audience?: string; problem?: string;
outcome?: string; currentMilestone?: { title?: string; state?: string;
nextStep?: string; path?: string }; errors?: { role: string; document: string;
section: string; message: string }[] }`; the existing top-level
`Product.audience` remains a compatible value and matches `overview.audience`
when both are present. The overview shall show the product name and the
audience, problem, outcome, current milestone title, state and next step
supplied by product data. Their normative document-and-section source mappings
are defined by `questions-and-overview`; the UI shall not infer identity,
vision facts, milestone state, document paths or workflow from engine defaults.
The projection is optional; when absent (including a manifestless product
response), the wiki shall not render the overview-facts block. If the
projection is absent but the legacy top-level audience exists, that audience
shall remain visible without an overview-facts block. A blank or whitespace
legacy audience and missing or blank facts within a supplied projection shall
be omitted without placeholder text. A milestone title becomes a link only when its path is safe and names a page
in the current wiki page list; missing data shall never create a blank link. A source path that is unsafe or does not name a served page shall be reported in the projection's `errors`; absent or empty sections remain absent without a fabricated value. The existing empty-home guidance remains available when a product has no pages.

### Scenario: manifest-overview-before-groups
- Given: a product whose response supplies audience, problem, outcome and a current milestone with title, state, next step and a safe page path
- When: its home is read
- Then: the first screen shows the product's supplied audience, problem, outcome, milestone title, milestone state and next step before the document groups, and the milestone title links to the supplied page

### Scenario: missing-overview-facts
- Given: a product whose overview fields are absent, blank or whitespace-only
- When: its home is read in English or Russian
- Then: missing fact rows are omitted without placeholders, and a milestone has no blank or unsafe link

### Scenario: production-overview-sources
- Given: a registry with independent document-and-section mappings for all six overview roles
- When: `GET /api/product` is read
- Then: each first paragraph supplies only its declared role, `overview.audience` matches the top-level audience alias, and a milestone path is returned only for a served wiki page

### Scenario: unsafe-overview-source
- Given: a registry whose overview source contains traversal or names a page outside the wiki's served page set
- When: `GET /api/product` is read
- Then: that source contributes no fact or link and the projection reports the source error without reading outside the product

### Scenario: legacy-audience-compatibility
- Given: a product response with the existing top-level audience and no `overview.audience`
- When: its home is read
- Then: the audience remains visible without requiring a nested projection

### Scenario: no-manifest-overview
- Given: an existing directory without manifest metadata and no pages
- When: its home is read
- Then: no overview-facts block is shown and the existing localized empty-home guidance remains

### Scenario: manifestless-legacy-audience
- Given: a manifestless product response with a top-level legacy audience and no normalized overview
- When: its home is read
- Then: the legacy audience remains visible and no overview-facts block is shown

### Scenario: blank-legacy-audience
- Given: a product response, with or without manifest metadata, whose top-level legacy audience is blank or whitespace-only and has no normalized overview
- When: its home is read in English or Russian
- Then: no audience placeholder or overview-facts block is shown

## Requirement: shell — The reading shell holds the navigation, the document and the panel place
When a product's wiki is served, its pages shall be shown in a reading shell: a left navigation holding the product's name and its documents grouped by kind — the kind a page's path names, pages outside a kind by themselves — with the current page marked visually and by its accessibility attributes, and every page of the wiki one click away from it; each group heading shall link to a generic page at `/g/` followed by the URI-encoded group identity, keyed by the existing `PageMeta.kind ?? groupOf(path)` identity, whose heading uses the matching registry entry's current-locale `labels` value when the optional pair is present; if absent, the manifest's own name is shown unchanged, never the other locale; the stage navigator and document-kind labels follow the same rule (a stage uses its own `id` only when it has no display name or label); and whose links list only that group's live pages in code point order; the sidebar brand `madarch вики` shall link to Product overview; a document breadcrumb shall link its first `Продукт` segment to Product overview and its group segment to that group page, providing the in-app way back without a separate Back button; the document in the centre as the main element; and a place for a right context panel, closed by default and empty until content fills it. A focus mode shall hide both panels and bring them back, and on a narrow screen the navigation shall open from a menu without narrowing the document's column. Language selection shall live in a globe menu in the top bar; the globe button shall have a localized accessible name and tooltip, and the menu shall mark the current language as checked.

The sidebar carries an Architecture entry in the life-cycle order — after the decisions, before the research kinds — with the model's views' count; the entry stands even where the product holds no model. The shell shall fill the window at any window height: its sidebar and top bar stay while only the document work area scrolls. No tab strip or bottom status strip shall be rendered. On a document page, the top bar shall not repeat that page's title; the page title belongs to the document content. The document surface shall be flush across the work area, from the sidebar edge to the window edge, with no inset page or raised frame. The chrome reads as the mockup lays it: the brand as the product's own mark, a product block naming the product with its "Product space" line and an initial square about 36 px, the product block has no disclosure chevron or switcher affordance, no trailing chevron on the product overview row, the sidebar's group heading in small muted uppercase, and a breadcrumb whose parent sits muted around a spaced slash without repeating the document title.

### Scenario: group-page-and-group-navigation
- Given: a served product whose pages carry more than one group identity, including two pages in one group
- When: the group heading in the sidebar or that group's breadcrumb segment is clicked
- Then: the app opens `/g/` followed by the URI-encoded group identity, uses the registry entry’s current-locale label as its heading, or its own name unchanged when the optional pair is absent, never the other locale, and lists only that group’s live pages as links in code point path order

### Scenario: brand-and-product-breadcrumb
- Given: a document page is open
- When: the sidebar brand `madarch вики` or the first breadcrumb segment `Продукт` is clicked
- Then: each opens Product overview at `/` with its overview heading

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
### Scenario: architecture-entry-in-the-sidebar
- Given: a served product's page open
- When: the sidebar is read
- Then: the Architecture entry stands between the decisions and the research kinds and opens the section's index; on a product with no model the entry is still there and the page says what is missing
### Scenario: window-height-shell
- Given: the wiki open in a tall window (1440x1400) and then scrolled
- When: the shell is read while the column scrolls
- Then: the sidebar and top bar stay fixed while only the document column scrolls, with no tab strip or bottom status strip

### Scenario: no-dead-reader-chrome
- Given: a document page is open in the served wiki
- When: the reader inspects the shell and document
- Then: the tab strip and bottom status strip are absent, the top bar does not repeat the document heading, and the product block has no disclosure control
### Scenario: home-overview
- Given: a served product home read in a browser
- When: the home page is read
- Then: the home carries a lead, its documents grouped by kind with counts, links not underlined, each row icon and title on the navigation rhythm, and groups that share the document text measure with rounded hairline borders and no inner rules

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

## Requirement: front-matter — A page shows the set's document it is, linked both ways, with the set's check on it
When a page's text carries the set's document form — the identity line, the
fields, the sections — or stands where one of the set's kinds lives, the
wiki shall read that form and show, on the page: its kind, named in the
reader's language; a calm block of the form's fields beside the identity
ones (the id, the status the set computes from the document's own text, the
dates and the people a kind carries); the pages it grew from, resolved from
the form's link fields; and a "Linked from" section naming every document
of the product whose link fields, ids or wiki addresses reach this page —
link fields first. A page the set names not at all shall keep the plain
page behaviour, and no kind shall be invented for it. The lines the
fields block is read from shall not stand in the body again beneath the
title: where the block shows a field, its raw `Name: value` line is out of
the served body, and the file's line numbers stay true.
The set's product check shall run over the product's folder once per
product revision while the wiki serves — a revision that asked once shall
not run it again until the pages change — and each finding that names this
page's file shall show on the page with the rule, the file's path within
the product, the line and the words. A page the check says nothing about
shall show nothing, and where the check cannot run at all the page shall
say so, naming the script and the cause, instead of passing the product as
checked.

The navigation shall group the product's documents by the set's kinds in
the set's life-cycle order — the chain vision, source, hypothesis, user
story, use case, product requirement, open question, prototype, result,
with the planning documents after the vision, the design-side records
between the product requirements and the questions, and the practices last,
active first and retired apart — and a group of no set kind shall keep its
place after them.

### Scenario: a-requirement-shows-its-chain
- Given: the fixture product whose product requirement serves a use case and a user story
- When: the requirement's page is read
- Then: the page names its kind, carries the form's fields in its header block, and the "Grew from" row opens the use case and the story pages

### Scenario: backlinks-across-kinds
- Given: the fixture product whose source is cited by the hypothesis, the story, the use case, the requirements and the vision
- When: the source's page is read
- Then: the "Linked from" section names every one of them, whatever their kinds

### Scenario: findings-on-the-failing-page
- Given: the fixture product whose `docs/requirements/FR-999-a-failing-example.md` fails the set's check
- When: its page is read
- Then: the page carries the findings block, each finding naming the rule, the file's path, the line and the words, and no other page carries a findings block

### Scenario: check-runs-once-per-revision
- Given: a served fixture product and a way to count the check's runs
- When: three pages are asked for with no change between them, then a file is saved and a page is asked again
- Then: the check ran once for the three asks and once again after the save

### Scenario: sidebar-groups-in-life-cycle-order
- Given: the fixture product holding documents of every kind, active and retired practices included
- When: the navigation is read
- Then: the groups stand in the set's life-cycle order — vision through results, practices active before retired — and pages of no set kind group after them

### Scenario: plain-page-stays-plain
- Given: a page of no set kind (no identity line, no kind's place)
- When: its page is read
- Then: the page shows no kind, no fields and no findings, as before this requirement

### Scenario: fields-show-once
- Given: a set-form page whose fields block carries a field
- When: the page is read
- Then: the block names the field once, the body holds no line of it beneath the title, and the file's line numbers match what the page names

## Requirement: architecture — The model's views and elements are the Architecture section
When a product's wiki is served, it shall have an Architecture section — the
Design stage's part of the life cycle — computed from the product's model:
the product's own model files (`model/` of the product repository) merged
with each declared code repository's own `madarch/` model under `repos/`, in
the manifest's repository order, the product's files first. The section
shall have an index page listing the model's views and elements; one page
per view with its diagram drawn in the browser — the shared renderer's
Mermaid source drawn client-side, and the LikeC4 webcomponent of the same
view beside it — with the view's relation table, the view one level up and
the drill-down to the views it opens; and one page per model element with
its kind, technology, parent, its interfaces, its incoming and outgoing
relations, and the pages whose text names it. A document page shall link the
first standalone, word-bounded mention of an element's id (the backlinks'
conservative rule) to the element's page. A declared repository with no
checkout under `repos/` shall be named as a note beside the model, never
omitted silently. When the model does not compile, the section's pages shall
show the compiler's own errors, each naming its file, line and path, and
every other page of the wiki shall keep working. The diagrams shall follow
the reader's colour scheme, and every app-owned string of the section shall
use the selected catalogue.

### Scenario: views-and-elements
- Given: a served product whose `model/` holds a landscape, an overview and a flow view
- When: the Architecture section is opened
- Then: the index lists the three views and every element, and each view's page draws its diagram and links up and drill-down
### Scenario: element-page-relations
- Given: a model where `library` syncs through `sync-engine`
- When: the page of `sync-engine` is opened
- Then: it shows `library` as its incoming other end with the relation's name and interface, and the pages that name it
### Scenario: document-links-to-element
- Given: a document page whose text names `sync-engine`
- When: the document page is read
- Then: the first standalone mention of the id is a link to `/p/madarch/element/sync-engine`, and mentions inside code spans, fences and link targets are not wrapped
### Scenario: merge-with-repository-model
- Given: a product whose manifest declares a repository checked out under `repos/alpha` with a `madarch/` model
- When: the Architecture section is computed
- Then: the elements and relations of both models are shown as one model, and a duplicate id across the two is a compile error naming both files
### Scenario: missing-checkout-is-a-note
- Given: a product whose manifest declares a repository that is not checked out under `repos/`
- When: the Architecture section is computed
- Then: the model is shown from what is on disk, and the section names the missing checkout with its path
### Scenario: compile-errors-do-not-blank-the-wiki
- Given: a served product whose model file declares a kind that does not exist
- When: the Architecture page is opened, and any document page with it
- Then: the Architecture page lists the error with the file's path, the line number and the offending value's path, and the document pages render as usual

## Requirement: repositories — The manifest's code repositories in the wiki
When the product's manifest declares code repositories (`workspace.yaml`, the
`repos` list), the wiki shall show them in a repositories section at its own
address `/r`, reached from a sidebar entry that carries the section's label
and the count of the declared repositories, and the sidebar shall hold no
repositories entry and no `/r` route when the manifest declares none — no
empty stub, no dead link. Every declared repository shall have one row naming
its name, its url and its branch when the manifest declares one, and the
state of its checkout under the product's `repos/` folder: `checked out`
when `repos/NAME` is a folder holding a git repository of its own, `not
checked out` when nothing stands there, and `unreadable` — with the cause
named — when the name is taken by something else, a symlink, a folder with
no repository of its own, a HEAD git cannot show, or bytes that cannot be
read. A checkout's last commit shall be shown as its short sha, its subject
and its age, read by read-only git at the checkout at ask time, and the age
through the same relative-time machinery the pages' change times use. When a
checked-out checkout's root holds a README (any case), its bytes shall be
rendered as markdown through the same pipeline the pages use; when there is
none, the row shall say so quietly. The section's strings shall follow the
wiki's own language the way the chrome's do, counts through `Intl`, and the
git calls the section makes shall write nothing and never reach past the
checkout's own repository.

### Scenario: declared-and-not-checked-out
- Given: a product whose manifest declares `core` (no branch) and `web` (branch `main`), with nothing under its `repos/`
- When: its wiki's repositories section is read
- Then: it shows `core` with its url as not checked out and `web` with its url and `branch: main` as not checked out, the sidebar entry names the section with the count 2, and the row states read in Russian as «Не склонирован» when the chrome is Russian
### Scenario: checked-out-with-readme-and-head
- Given: a product whose `repos/core` holds a git repository of its own with one commit "Make the core" and a `README.md`
- When: its wiki's repositories section is read
- Then: `core` reads checked out, the row carries the commit's short sha, its subject and its age, and the README renders as markdown under the row
### Scenario: no-repos-declared
- Given: a product whose manifest holds no `repos` item
- When: its wiki is read
- Then: no repositories entry stands in the sidebar, `/r` answers the home's content, and no repositories section is shown anywhere
### Scenario: unreadable-checkout
- Given: a product whose manifest declares `broken` while `repos/broken` is a plain folder with no git repository of its own
- When: its wiki's repositories section is read
- Then: `broken` reads unreadable with the path named, and the section itself still answers
### Scenario: served-read-only
- Given: a served product whose `repos/core` is a checked-out repository
- When: its repositories section is read
- Then: the checkout's files and git status are unchanged, and a second commit inside the checkout is what the next ask reports

## Requirement: stages — The manifest owns the stage list and expectations
A product registry supplies the stage list, order, names and the records
expected at each stage. A product without a registry has no stage list. The
wiki may show tracker task groups only on a stage whose manifest expectations
include them; it does not infer expected records from stage names.

The product skill set computes completeness against the manifest once and
commits its result as `docs/completeness.json`. The result is the product's
truth at the source revision it names. It carries the published contract
version, computation date, source product revision and findings. Madarch
validates and renders those findings and the localized “as of” date only. It
never recomputes completeness or warns based on current documents. When the
snapshot is absent, the wiki shows no completeness findings.

The stage pages may show documents and mechanism-owned material they read,
but missing records are never inferred from those files. The stage page's
findings are only the snapshot's supplied messages. A stage's expected record
names live once in the registry and are not duplicated in engine code.

### Scenario: manifest-stages-and-expectations
- Given: a product registry with a custom ordered stage list and one stage whose `expected` list includes `interview` and `task`
- When: the registry and stage index are read
- Then: the wiki uses only the declared stage order and exposes the stage's expected records from the registry

### Scenario: supplied-snapshot-is-rendered
- Given: a committed snapshot with a source revision, a computation date and a finding for a manifest stage
- When: that stage page is read in English or Russian
- Then: it renders the supplied finding and localized as-of date, without inspecting current documents to change the finding

### Scenario: no-snapshot-no-findings
- Given: a product with a registry but no completeness snapshot
- When: its stage page is read
- Then: it shows no completeness finding or snapshot date

### Scenario: no-registry-no-stages
- Given: a product without a kinds registry
- When: the life-cycle navigation is read
- Then: it shows no built-in stage list

## Requirement: questions-and-overview — Product declarations supply reader forms
A kind may declare a question form in `docs/kinds.yaml`, including its
identity prefix, title separator, field names, section names and the text that
marks a not-applicable answer. Only documents of that declared kind feed the
questions view.

The product registry may also declare an optional `overview` object with
optional source mappings for `audience`, `problem`, `outcome`,
`currentMilestone`, `milestoneState` and `nextStep`. Each mapping shall name a
product-relative Markdown `document` and an exact `section`. The selected
section supplies its first non-empty paragraph as the value for its declared
semantic field; the `currentMilestone` mapping supplies the milestone title.
The paths, sections and semantic roles are product data. An absent mapping
leaves that value absent. Engine code shall not infer document paths, headings,
milestone state or workflow, or fall back to another source. Configured unsafe
or unserved page sources shall be reported in `overview.errors` rather than
silently replaced. A source path is returned as a milestone link only when it
names a page the wiki serves. When both
are present, the legacy top-level `Product.audience` shall match
`overview.audience`. The Open questions sidebar entry is not built into the
engine.

### Scenario: manifest-question-form
- Given: a registry that declares a question kind with non-default prefix, fields and section names
- When: question documents of that kind are read
- Then: the wiki parses only the declared form and renders the configured field labels

### Scenario: manifest-audience-source
- Given: a registry that names a document and section for the overview audience
- When: the product overview is read
- Then: it reads that section's first paragraph and no other document or section

### Scenario: manifest-overview-field-sources
- Given: a registry with separate document-and-section mappings for all overview fields
- When: the normalized overview is produced
- Then: each value comes only from its mapped section, an undeclared source remains absent, and no engine default or alternate source is used

### Scenario: invalid-overview-source
- Given: a configured overview source that is unsafe or cannot be resolved
- When: the normalized overview is produced
- Then: the source error is reported explicitly and no other document or section is used as a fallback

## Requirement: live — A page follows its file as it is saved
When a page is asked for, its text shall be read from the product's working
tree then, never from a copy kept from an earlier read. When a file of the
wiki is created, changed or removed while the wiki is open, every open page
shall show what the working tree holds within two seconds, with the server
still running and without the reader reloading the page. The same pages shall
give the same revision, so an unchanged wiki is never shown as changed. The
revision shall cover the model's sources too — the product's `model/` and
every declared repository's `madarch/` — so a saved model file is a wiki
change: the stream reports it and the Architecture section is asked again.

The server watches the product working tree and answers one Server-Sent Events stream (one long-lived request per open wiki, debounced as a tree change arrives); an open page refetches what it shows when its stream carries an event, and reconnects with backoff when the stream drops. A loaded tab the reader leaves alone makes no per-second requests beyond its open stream. The app shows the stream's actual state on its own (Live when open, Reconnecting while it is not); no save events outside the product's own files are claimed.

### Scenario: saved-model-becomes-a-change
- Given: a served product whose model compiles, open in a browser at the Architecture section
- When: a model file is saved with a new element
- Then: the section shows the new element within two seconds, without a reload, and an unchanged model never changes the revision
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
product of the current folder when it is given none. `madarch serve` shall
also serve an existing directory with no `workspace.yaml` as a temporary,
read-only empty home so its reader can see the getting-started guide. The
folder's name supplies only the temporary display name; no manifest, product
id or sample document is written or treated as manifest data. A directory
that does not exist, a manifest that cannot be read, or a manifest that does
not parse remains refused with its cause. Manifest reading and lifecycle
commands remain strict. `madarch new` shall open the address in the browser the
machine uses; where no browser can be opened, it shall say so and print the
address without failing. The server shall serve the app's built files and
answer the wiki's pages; a request it cannot answer shall be refused with a
message naming what was asked for, and no document's content shall be logged.





### Scenario: new-opens-the-wiki
- Given: `MADARCH_HOME` names a scratch folder and the machine's browser opener is recorded
- When: `madarch new` is run
- Then: the command prints the address, opens that address in the browser, and the address answers the draft's home page while the command runs
### Scenario: serve-an-existing-product
- Given: a draft created earlier and no server running
- When: `madarch serve` is run in the product's root
- Then: the same wiki answers at the address it prints

### Scenario: serve-empty-folder-without-manifest
- Given: an existing empty directory with no `workspace.yaml` and no server running
- When: `madarch serve` is run in that directory
- Then: the command prints an address, the home page answers with the localized getting-started guide, and the directory is unchanged — no manifest or product data is written

### Scenario: invalid-manifest-still-refused
- Given: an existing directory whose `workspace.yaml` is unreadable or malformed
- When: `madarch serve` is run in that directory
- Then: it remains refused with the manifest's file, line and cause; the no-manifest fallback does not mask it

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
An existing directory without a `workspace.yaml` is the one exception to the
manifest requirement: it serves an empty home with the getting-started guide.
It shall exit 2 when its input cannot be read — an argument it does not know,
a path that is not an existing directory, a manifest entry that cannot be
read, an invalid manifest, an address already taken, or an app that cannot be
built — naming what is wrong; and 1 when a step it takes fails. Serving shall
change neither the product's files nor its repository.






### Scenario: no-product
- Given: a path that does not exist or does not name a directory
- When: `madarch serve --product` naming that path is run
- Then: it exits 2 naming the path and refusing to serve it

### Scenario: present-manifest-refused
- Given: an existing directory whose `workspace.yaml` entry is present but unreadable or invalid
- When: `madarch serve --product` naming that directory is run
- Then: it exits 2 naming the manifest and its cause rather than using the no-manifest fallback
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

Kind, group and stage names that come from the product registry are displayed using that entry's label for the selected locale when its optional paired labels are present. When the pair is absent, the wiki displays the manifest's own name unchanged (or a stage's own id when it has no name); it never substitutes the other locale. These registry labels do not translate the product's authored document content.

### Scenario: registry-labels-follow-the-selected-locale
- Given: a contract-v1 registry with paired English and Russian labels for kinds and stages, and a legacy registry whose entries have no labels
- When: each product is read in English and Russian
- Then: the labeled entries use the selected locale; the legacy entries use their own manifest name unchanged (or a stage id if no name exists); no entry falls back to the other locale, and product document content stays as authored

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

## Requirement: describe-guide — The engineer's guide carries the describing step
The engineer's guide to starting a product from the repositories they
already have (`docs/guides/start-a-product.md`) shall carry the describing
step: after `madarch repo add` connects a repository, the engineer asks the
agent running in the product folder to describe it; the guide shall say
what the agent then writes — the repository's intended model with its
evidence into the repository's own `madarch/` folder, the architecture page
under `docs/repositories/name/`, the capabilities found in the code as
requirements and use cases marked derived from code, the decisions found in
the code or its ADRs — that a repository holding uncommitted changes is
described only after they are committed, that everything is a page of the
wiki the moment it is saved, and how to describe every connected
repository at once. The guide's other sections and their commands stay as
they are.

### Scenario: guide-carries-the-step
- Given: the guide at the change's revision
- When: its sections are read
- Then: a section after the agent-work section says to describe each repository after `madarch repo add`, names the four artifacts and the committed-checkout rule, and changes none of the guide's commands

### Scenario: described-pages-appear-live
- Given: a served fixture product whose repository has been described by the skill, its wiki open
- When: one of the description's pages is saved again
- Then: the open page shows the new text within two seconds, without a reload, and the page is in the navigation's groups


## Requirement: empty-home-guidance — The empty home offers the demo command in the reader's language
When the wiki shows its getting-started guidance for a product with no pages, with or without a product manifest, it shall offer `madarch demo` as the one-command way to open the Madarch product wiki. The offer shall be written in the selected chrome language, English or Russian, and shall not ask the reader to clone and serve the product manually.

### Scenario: empty-home-demo-english
- Given: the reader selected English and the served product has no pages, with or without a product manifest
- When: the home page's getting-started guidance is read
- Then: it offers `madarch demo` and does not show manual clone-and-serve instructions

### Scenario: empty-home-demo-russian
- Given: the reader selected Russian and the served product has no pages, with or without a product manifest
- When: the home page's getting-started guidance is read
- Then: it offers `madarch demo` in Russian and does not show manual clone-and-serve instructions

## Requirement: discussions — A reader can comment on a selection and follow its discussion
On a document page, selecting text offers a comment action. The app maps the rendered selection to a source range using parser position data; a selection crossing an inline construct boundary expands to whole words and elements so the markers never break Markdown. Saving creates a discussion message under `comments/{thread ULID}/{message ULID}.md` and wraps the selected source range in matching hidden v1 markers. The page shows the message card in the right margin level with the marked text, and hover links the card and text in both directions. Reload shows the saved message and highlight. Later interactions provide replies, resolution (resolved threads hidden by default and showable), a page-level thread, and a narrow-screen discussions panel. Both markers absent means the selection is lost and the thread is shown with its saved quote; one-sided or mismatched markers are refused with source file and line, and the reader can restore the range by its saved quote or place it again.

### Scenario: selected-comment-round-trip
- Given: a served fixture product and a selectable sentence in a document
- When: the reader selects the sentence, writes a message and saves, then reloads the page
- Then: a comment card appears in the margin beside the highlighted source range and is still there after reload

### Scenario: marker-safe-inline-selection
- Given: a selection crossing an inline Markdown construct
- When: the comment is saved
- Then: marker insertion expands to valid whole words/elements and the document still renders correctly

### Scenario: lost-anchor-and-invalid-pair
- Given: both markers for a selection were removed, or only one remains
- When: the wiki reads the discussion
- Then: both absent is shown as a lost anchor with its quote; a one-sided or mismatched pair is refused with source path and line

### Scenario: discussion-actions-and-narrow-screen
- Given: a document with open and resolved threads
- When: the reader replies, resolves, reveals resolved threads or views the page at a narrow width
- Then: each action persists after reload, resolved threads are hidden by default, and discussions are available in a panel


## Requirement: connected-repositories — The overview and repository page show linked code
When a product manifest declares repositories, the overview shall list each in code-point order with its name, URL when present, and checkout state. The repositories page shall render each checkout's README and list its top-level entries in code-point order. These values come only from the manifest and checkout; the engine keeps no repository data. A URL-less linked checkout shall be clearly named as having no origin URL.

### Scenario: repository-overview
- Given: a product whose manifest declares two linked repositories
- When: the overview is shown
- Then: both names, their URLs or no-origin state, and checkout state are listed in code-point order

### Scenario: repository-page
- Given: a linked checkout with a README and top-level files
- When: its repository page is opened
- Then: the README is rendered and the top-level entries are shown in code-point order

## Requirement: getting-started — Empty product guidance follows product state
Inside a product, the getting-started panel shall not recommend `madarch new`. If the product has no repositories, it shall recommend `cd path/to/checkout && madarch init` or `madarch repo add name url`. If it has repositories but no documents, it shall recommend running setup-shady2k-skills in the product folder with an agent. The heading shall have no empty space above it. A folder without a product manifest keeps guidance for starting a new product.


### Scenario: getting-started-states
- Given: a product with no repositories, or a product with repositories but no documents
- When: the empty overview is shown
- Then: the first recommends init or repo add, the second recommends setup-shady2k-skills with an agent, neither recommends madarch new, and the heading has no top margin
