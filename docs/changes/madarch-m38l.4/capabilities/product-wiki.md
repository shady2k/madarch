# Product wiki

Capability: product-wiki

## Purpose
A product's wiki as its reader reaches it on their own machine: madarch's one
app (decisions 0018 and 0029), the knowledge wiki, served by a local madarch,
showing the product's Markdown read from its working tree and its graph, so that what the person and their agent
write is what the wiki shows as soon as it is saved. The static site the wiki
capability builds stays as the read-only export.

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


## Requirement: acp-agent — madarch drives an agent over the Agent Client Protocol
When madarch runs an agent unit of the fill (decision 0026), it shall start the
agent as a child process and speak the Agent Client Protocol to it over the
process's standard input and output, using the protocol's version 1: one
`initialize` request per process, carrying the protocol version madarch speaks
and the capabilities it offers — no file system, no terminal — and, per unit,
one `session/new` request carrying the unit's working folder and the MCP
servers the unit reads and writes through. It shall send one `session/prompt`
per turn with the unit's prompt as text content, deliver each `session/update`
the agent streams to the reader in the order it arrives, and end the turn with
the agent's stop reason. A turn shall be cancellable: madarch sends
`session/cancel`, answers any permission request pending at that moment as
cancelled, and reads the turn's end as cancelled whether the agent answers with
the `cancelled` stop reason or with the protocol's request-cancelled error.
Every request an agent makes of madarch shall be answered: a permission request
as cancelled, and a file system call as an error naming the method and saying
that code is read through the session's MCP server, since an agent's own file
tools are off. A failure shall name the ACP method in flight, the agent's id,
the program resolved to its full path, the folder it ran in and the end of what
it wrote on standard error; a program the system refuses to run shall be named
with the reason it gave. Closing the connection shall end the agent and the
helper processes it started, and shall not wait for a helper that holds the
connection's pipes; a turn in flight at that moment shall end as cancelled.

For each session, madarch shall report the input and output tokens the agent
reported, or say that token usage was not reported: it keeps the agent's latest
report as the session's figure and never adds reports together. The token
figures sit in a field the protocol's published v1 schema does not carry — the
official library's generated schema has it, marked unstable — so an agent that
conforms to v1 may never report them, and the session then reads "not
reported". The context window an agent reports through `usage_update` is a
stable part of the schema, and the unit's limits are read from it; madarch keeps
it beside the session's figures. An update kind madarch does not name shall be
kept as it arrived rather than dropped, and an update outside the protocol's
schema shall not end the turn.

A probe shall report, for a machine, which of the agents the fill considers
connect over ACP: for each, whether an adapter is installed, and for one that
is, the protocol version and agent identity its `initialize` answer carried; for
one that is not, the command that installs it and the size of what that
installs, or — for an agent that carries ACP in its own program — that program.
The probe shall send no prompt and install nothing. `madarch fill --probe-acp`
shall print that report, one block per agent, and with `--json` the same facts
as one JSON object.

### Scenario: acp-session-and-updates
- Given: a fake ACP agent on this machine that answers `initialize` and `session/new`, and a unit whose MCP server is given
- When: madarch connects to it and sends one prompt
- Then: the agent was sent protocol version 1 with no file system or terminal capability, a session was created with the unit's MCP server, the session's prompt arrived as one text block, and the messages, thoughts, tool calls and context usage the agent streamed arrive in order, ending the turn with the agent's stop reason

### Scenario: acp-token-accounting
- Given: one fake agent that reports tokens each turn and one that reports none
- When: a prompt turn ends in each session
- Then: the first session reports the input and output tokens its agent gave last, the second says token usage was not reported, and neither is invented

### Scenario: acp-cancel
- Given: a fake agent holding a turn open until it is cancelled
- When: madarch cancels the turn
- Then: the turn ends as cancelled, whether the agent answers with the cancelled stop reason or with the protocol's request-cancelled error

### Scenario: acp-close
- Given: a fake agent that starts a helper process holding the connection's pipes and then holds a turn open
- When: madarch closes the connection while that turn is in flight
- Then: the turn ends as cancelled within the client's kill grace, and both the agent and its helper are gone

### Scenario: acp-no-file-system
- Given: a fake agent that asks the client to read text from a file, and one that asks for permission
- When: the turn runs
- Then: the file call receives an error naming the method and the permission request is answered cancelled, and the turn still ends

### Scenario: acp-probe
- Given: a machine on which one agent's ACP adapter is installed and another's is not
- When: the probe runs
- Then: the installed adapter is reported connected with the protocol version and agent identity its `initialize` answer carried, the missing one is reported with the command that installs it and that command's unpacked size, and no prompt was sent to either

## Requirement: one-app — There is one wiki app, the knowledge wiki, and the root opens a product in it
The wiki shall be one app. A product's repository that holds no `madarch/kinds.yaml` shall be served with the starter manifest and templates that `madarch new` and `madarch init` seed, and a product whose manifest cannot be read shall be served by the same app as a page that names each finding with its file and line. No other app, shell or `?documents` address shall exist. A products home shall have no page that lists products: its root address shall answer a redirect to one product's wiki — the only product; or, of several, the one this browser opened last (a cookie the product's pages set), else the one whose manifest changed most recently — and a product shall be chosen only in the selector at the top left of the wiki. A home with no product shall say at its root what to run.

### Scenario: root-opens-the-product
- Given: a products home that holds one product
- When: the root of a products home that holds one product is asked for
- Then: it redirects to that product's wiki and shows no list of products

### Scenario: root-opens-the-last-product
- Given: a products home that holds several products and a browser that opened the second last
- When: a browser that opened the second of several products asks for the root
- Then: it is sent to the second product

### Scenario: broken-manifest-names-findings
- Given: a product whose manifest has an unreadable line
- When: a product's manifest cannot be read
- Then: the wiki shows a page naming each finding with its file and line

## Requirement: documents — The product's and its repositories' Markdown documents are pages of the knowledge wiki
The sidebar's Documents shall list the Markdown documents of the product repository and of its connected repositories, and each shall be rendered as a page of the knowledge wiki. A ground of the form `madarch:doc:` followed by a path, a hash and an anchor shall open that document at that anchor.

### Scenario: document-ground-opens-its-page
- Given: a page with a `madarch:doc:` followed by a path, a hash and an anchor ground
- When: a reader follows a `madarch:doc:` followed by a path, a hash and an anchor ground
- Then: the wiki shows that document scrolled to the anchor

## Requirement: responsive-during-fill — A page answers while a fill runs
The fill and the writer's work other than the agent's shall run off the request path, so that during a fill on the generated training repository every page and API answer arrives within 300 ms. The navigation shall name the manifest's kinds in the reader's language (English or Russian), a kind's page shall show its name rather than its key, and a kind's list shall show every node its count names, and the navigation's counts shall follow the pages as they appear during a fill. The home page and the sidebar shall use the whole height of the window.

### Scenario: page-within-300-ms-during-a-fill
- Given: the fill of the generated training repository is committing
- When: a page is asked for while the fill is committing
- Then: it answers within 300 ms

## Requirement: agent-stage — One press fills the graph and lets the chosen agent write the pages while the wiki stays up
When the wiki of a product that holds a kinds manifest and a connected code repository is opened empty, it shall offer, beside the fill's start, the agents that can write the product pages (Claude Code, Codex, OpenCode, Pi and omp, and "no agent"), each stating whether its adapter is installed, whether a sign-in is on this machine, and, for an adapter that is not installed, the package, version, size and folder an install would use; and it shall state the bound of the agent stage in plain words: one unit for the product page and one for each domain that page names, each unit bound by the turns, minutes, tool calls and refused writes the writer enforces. Pressing the start with an agent chosen shall be the whole consent: the pick is saved (the adapter installed into madarch's own agents folder when it is not there), the code fill runs, and the agent stage follows it inside the same running server on the product's own open graph store, with no second press and no restart of the wiki. With no agent chosen the code fill shall run alone, and afterwards the wiki shall offer the same choice on a card that lets the agent write the pages. The agent shall be started only after such a press. The writer shall write `docs/product.md` first and then one page per declared domain into the product repository; each page shall appear in the open wiki the moment its unit writes it, through the wiki's change stream, and the wiki shall show every unit with its state (waiting, writing now, written, failed, not written), its tool calls and write attempts, the refusals of a unit that failed with their line and rule, and the unit writing now. The server shall keep answering while the units run. A product that declares more than one code repository shall be refused for the agent stage, in words, rather than written from one of them.

### Scenario: agent-choice-states-the-bound
- Given: an empty product with a connected repository
- When: its wiki is opened
- Then: the card offers Claude Code, Codex and no agent, says for each whether its adapter is installed and signed in, states the units and their bound in plain words, and says that nothing runs an agent until the button is pressed

### Scenario: one-press-flows-into-the-agent
- Given: an empty product, an agent chosen and the fill started
- When: the code fill ends
- Then: the agent stage starts in the same server without another press, the product page is written first and each declared domain's page after it, and the wiki answers requests throughout

### Scenario: page-appears-when-its-unit-writes-it
- Given: the agent stage running with the product page written and the first domain unit still writing
- When: the home page is requested
- Then: it is served with the product page's statements and grounds, before the second unit ends, and the wiki names the unit writing now

### Scenario: no-agent-without-a-press
- Given: a product with no agent chosen
- When: the fill ends
- Then: no agent has run, no page was written, and the wiki offers the agent on a card whose button is the only way to run one

### Scenario: refusal-is-shown
- Given: a unit whose page the writer's checks refuse until its attempts end
- When: the stage ends
- Then: the unit is shown as failed with the line and rule of each refusal, and the pages of the units that were written stay

## Requirement: content-language — The product's pages are written in the product's content language
The product shall have a content language, a setting in its `madarch/kinds.yaml` manifest, chosen on the agent card before the press with the interface language as the default. The writer's prompts shall tell the agent to write every sentence and heading in that language and to keep keys, paths and identifiers as they are. The writer's sentence checks shall work for Russian as for English. A page written in another language by a person or by an agent shall not be refused.

### Scenario: agent-told-the-language
- Given: a product whose content language is Russian
- When: the writer starts a unit
- Then: the agent's prompt asks for every sentence and heading in Russian, and a Russian page with grounds is accepted

### Scenario: other-language-not-refused
- Given: a product whose content language is Russian
- When: a page in English is written
- Then: the page is accepted
