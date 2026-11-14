# Product wiki

Capability: product-wiki

## Purpose
A product's wiki as its reader reaches it on their own machine: madarch's own
thin app (decision 0018), served by a local madarch, showing the product's
pages from its graph. A page is a template of the product, composed and run in
the browser over one GraphQL API (decision 0036); the server renders no page,
holds no page model and refuses a product whose templates it cannot run. The
app reads the product's bootstrap once, composes the page its address names
into one operation and draws its sections with the app's own components.

## Requirement: pages — Every entity has a page, and no page is built by the server
A product's wiki shall address its home at `/`, every entity at `/e/kind/id` and a template bound to no entity at
`/p/template`; a page's data shall come only from `/graphql`, one request per page view after one bootstrap, and no
route of the server shall render a page, a block or a listing. The wiki's own page layer — the blocks and their builders,
the Liquid templates and their compiler, the catalogue, search, statement, neighborhood, view, document and kind routes
and the Markdown page files — is deleted with the mechanism it served, and a request for any of those addresses answers
404 (the app's own addresses answer the app shell). The bootstrap shall state the product's home, its catalogue template,
every template's body, each kind's record template, each entity's own template and the manifest's roles, so the app knows
which template a page opens before it asks the graph.

### Scenario: deleted-page-routes
- Given: a served product
- When: the deleted page, block, catalogue, search, statement, neighborhood, view, glossary, document, problem, question and task routes are asked, and `/e/...` and `/kind/...` are asked
- Then: every deleted route answers 404, and the app addresses answer the app shell as HTML
  Checked by test/removed-routes.test.ts

### Scenario: graph-only-reads
- Given: any read of a page's data in the app
- When: it is made
- Then: it is a `/graphql` request, and the server holds no code path that builds a page
  Checked by test/removed-routes.test.ts and test/graphql-schema-route.test.ts

### Scenario: bootstrap-names-the-page
- Given: a served product whose templates name their kinds' records and their entities' own templates
- When: the bootstrap is read
- Then: it states the templates' bodies, the catalogue template, the record templates and the own templates, and an entity's `template` answers the one its page opens with
  Checked by test/graphql-executor.test.ts and test/server-templates.test.ts

## Requirement: shell — The app's frame holds the reader's controls and the page's column
The app served with a product's wiki shall mount at index.html's root and draw a frame: a top bar with the app's own
name, a link to the home, the language and the role the reader chooses, and a reload, and the column the page is drawn
in. The reader's language and role shall be kept in the browser and passed to the page's operation; the roles offered
shall be the manifest's own. The frame shall name no product data, and the app's source shall import no API function and
name no kind.

### Scenario: reader-controls
- Given: the app served with a product whose manifest declares roles
- When: the reader chooses a language and a role and opens another page
- Then: the page's sections are read in that language and shown to that role, and the choice stands after a reload
  Checked by wiki/app/src/app.test.tsx

### Scenario: no-kind-in-the-app
- Given: the app's source and build
- When: the app is served with a product
- Then: the app's source imports no API function but the GraphQL client and names no kind
  Checked by scripts/check-ui-architecture.ts and scripts/check-architecture.ts (no-kind-names)

## Requirement: live — A page follows the graph as it moves
A page's data shall be read from the graph at the revision the read stands
at, never from a copy of the product's files read at request time. After a
publication or an authored write the server shall report `graph-changed` on
its one event stream (`GET /api/events`), carrying the data revision; a client
whose answers are older than that revision asks again, and after a reconnect
it reads `revision` once and does the same, so a missed event costs nothing.
An unchanged graph is never reported as changed.

### Scenario: publication-moves-the-revision
- Given: a served product whose answers were read at one revision
- When: a fill publishes, or an authored write lands
- Then: the event stream carries `graph-changed` with the new data revision, and `revision` answers it
  Checked by test/wiki-events.test.ts and test/graphql-schema-route.test.ts

## Requirement: status — The poll states what the product is and what it holds
`GET /api/status` shall answer, without opening a store for a product nothing filled: the product's name and id, its
manifest state (`ok`, `not-filled`, `no-manifest`) and file, the language, the groups, the purposes and the roles the
manifest declares, the repositories with whether each is filled, whether the graph holds facts and whether a fill stopped
short, the fill's state with the run's own counts, times and outcomes, the writer's state and the stage's bounds, the
chosen agent, the publication state, and each kind the manifest holds with its count from one graph query. It shall
state no page, no block, no finding count, no home entity and no unit list.

### Scenario: shrunk-body
- Given: a served, unfilled product
- When: the status is polled
- Then: the body names the manifest as not filled, the kinds with zero counts, an idle fill and the writer's bounds, and holds no `findingCount`, `home`, `loop`, `repository` or `writer.units`
  Checked by test/fill-states.test.ts and test/status-fill-memo.test.ts

### Scenario: counts-from-one-query
- Given: a filled product
- When: the status is polled
- Then: each declared kind's count is the graph's count, read once per publication, and the fill's counts are the run's own
  Checked by test/status-work.test.ts

## Requirement: serve — A local madarch serves the wiki and opens it
When a local madarch is given a product folder, it shall serve that product's
wiki at its address and print the address; `madarch init` shall create the
draft and serve its wiki in one command, and `madarch serve` shall serve the
product of the current folder when it is given none. `madarch serve` shall
also serve an existing directory with no `workspace.yaml` as a temporary,
read-only empty home so its reader can see the getting-started guide. The
folder's name supplies only the temporary display name; no manifest, product
id or sample document is written or treated as manifest data. A directory
that does not exist, a manifest that cannot be read, or a manifest that does
not parse remains refused with its cause. Manifest reading and lifecycle
commands remain strict. `madarch init` shall open the address in the browser the
machine uses; where no browser can be opened, it shall say so and print the
address without failing. The server shall serve the app's built files, the one
GraphQL API and the command routes section 8 keeps (the product identity and
status, the source text of the filled commit, the fill and its runs, the
agents and settings, the journal, the kind usage, the refresh plan, the resets,
the graph verdicts, the authored and problem and task writes); a request it
cannot answer shall be refused with a message naming what was asked for, and no
document's content shall be logged.

### Scenario: product-folder-served
- Given: a draft product folder
- When: the server is started with it
- Then: it prints its address, that address serves the app shell, `/graphql` answers, and `/api/status` names the product
  Checked by test/product-daemon.test.ts and test/product-serve.test.ts

### Scenario: source-after-a-fill
- Given: a served product whose source was read before another process filled the store
- When: `/api/source` asks for the same path
- Then: the answer is the new text and the commit the new fill pinned, without a status poll between
  Checked by test/source-follows-fill.test.ts

## Requirement: app — The wiki is madarch's own app, served from madarch's build
When a product's wiki is served, its pages shall be shown by madarch's own app:
the static files madarch's build produces from `wiki/app` in the madarch
checkout (decision 0018), which today is the template frontend. When those
files are absent, the command shall build them once from that folder, saying so
before it starts, and then serve them; while they are there it shall not build
again. If the build fails, the command shall stop with exit 2 and print what the
builder said.

### Scenario: built-on-first-use
- Given: a madarch checkout whose app has never been built
- When: a product's wiki is served
- Then: the app is built once, the command says so, and the wiki is served; serving a second time builds nothing
  Checked by test/product-serve.test.ts

### Scenario: build-fails
- Given: an app folder whose build fails
- When: a product's wiki is served
- Then: the command exits 2 printing what the builder said, and serves nothing
  Checked by test/product-serve.test.ts

## Requirement: templates-at-start — A product's templates are refused before the wiki serves
When a product's wiki is served, its page templates shall be read and validated before the address is bound: a template
naming a component the app does not draw, a parameter that component does not take, a section placed after a section the
page does not hold, an unresolved `extends`, or a query a type of the product cannot answer shall refuse the start with
the template's file and line. A product of a products home whose templates cannot be used shall be named in the log and
left unserved while every other product is served. A product holding no templates shall not be refused.

### Scenario: bad-template-refused
- Given: a product whose template names an unknown component or an unknown parameter
- When: its wiki is served
- Then: the command exits 2 naming the template's file and the line, and serves nothing
  Checked by test/server-templates.test.ts

### Scenario: whole-product-serves
- Given: a product whose templates name only components and parameters the app draws
- When: its wiki is served
- Then: the address is bound, and the bootstrap lists the product's templates
  Checked by test/server-templates.test.ts

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


## Requirement: catalog — The starter set holds the whole entity catalog, and a check validates it
The starter set `madarch new` writes shall hold the product's whole entity
catalog in `madarch/kinds.yaml`: two levels, an area and a subgroup of at most
about twelve kinds, and for every kind of the product's life cycle its concept
id, its definition, the sources it was taken from as addresses a person can
read, the ways it can be acquired (an extractor's mark, a document, a
conversation, an agent from the graph, a live system, or not implemented), its
implementation status, the relation constraints it may carry and its template
policy. The manifest declares the catalog's schema — the bound of a subgroup,
the origin marks, the statuses, the template policies, the values that are
attributes and the relation names — and the engine holds no area, kind or id
of its own. Every area and subgroup also declares a short label for the
navigation in both interface languages, one or two words that fit the sidebar's
column, beside its full name, which a page and the catalogue keep.

One concept has one kind: a concept two areas share stands in one subgroup and
the other refers to it, and distinct senses stay distinct. A value such as a
version, a coverage, an RTO, a sunset date or an error budget is an attribute of
a kind, not a kind. Relation names are the standards' own where they exist,
and a relation reads in the standard's direction; the mapping that ties the
extractors' vocabulary to the catalog says which way each extractor's edge runs.

A mechanical check, run by `bun run check` over the starter set and by the
wiki's own read of a product's manifest, shall refuse a kind that leaves a
field out, a subgroup above its bound, two kinds for one concept id, a value
the catalog marks as an attribute declared as a kind, an area, a subgroup or an
origin mark the manifest does not declare, and a group without a short label or
one longer than the sidebar holds. Every refusal shall name the file, the line
and the kind (or the group), and one defect shall be one finding: the reader
that owns a defect reports it, and the others do not repeat it.

A kind whose template policy is `none` is catalogue data only: the wiki shows
no page and no template for it, and the kinds the wiki shows today are shown
as they were.

### Scenario: starter-set-catalog
- Given: a product made by `madarch new`
- When: its `madarch/kinds.yaml` is read
- Then: every area and subgroup of the catalog is declared with its full name and its short navigation label, and every kind holds its id, definition, sources, acquisition, status, relation constraints and template policy

### Scenario: catalog-refusals
- Given: a starter manifest with a kind that leaves its status out, a subgroup holding thirteen kinds, two kinds of one concept id, a kind whose id is an attribute, a kind whose group, area or origin mark the manifest does not declare, and a group whose short label is missing or too long
- When: the catalog is checked
- Then: each is refused with the file, the line and the kind (or the group), and the check exits 1

### Scenario: catalogue-only-kind
- Given: a kind the catalog declares with the template policy `none`
- When: the product's wiki is served
- Then: the kind is in the catalog and shows no page, and no template is written for it


## Requirement: extractor-mapping — The extractors' vocabulary is tied to the catalog, and an unmapped key is refused
The starter set `madarch new` writes shall hold a versioned mapping of the
extractors' vocabulary to the catalog: every node kind and relation type the
extractors emit, tied to a catalog kind or to one of the catalog's relation
names, or declared internal to extraction with the reason. A tied relation also
says which way it runs — `same` as the catalog's relation, or `inverse` when the
extractor reads the edge the other way round. The emitted keys are read from the
extractors' own declarations, and a record's kind and an edge's type are the
union of those declarations, so an extractor that emits a key its declaration
does not hold fails the type check at the emission site; no list in the check
names a kind.

A mechanical check, run by `bun run check` over the starter set and by the
wiki's own read of a product's manifest, shall refuse an emitted key with no
row, a row that ties a key to a kind or a relation the catalog does not hold, a
row for a key no extractor emits, a tied relation without a direction or with
one the vocabulary does not know, and a row that is neither a tie nor an
internal declaration with its reason. Every refusal shall name both the
extractor's key and the catalog name it was tied to, with the file and the
line. The starter set passes it, and `bun run check` fails when the manifest has
no `mapping:` at all. A product that removes a kind changes what it shows and
walks, never what extraction keeps: the mapping keeps the extractor's key tied
to what the product declares.

### Scenario: mapping-ties-extractors
- Given: a product made by `madarch new`
- When: its `madarch/kinds.yaml` is read
- Then: its `mapping:` names a version and holds a row for every kind and relation the extractors declare, each tied to the catalog (a relation with its direction) or internal with a reason

### Scenario: mapping-refusals
- Given: a starter manifest with a row removed, a row tied to a kind the catalog does not hold, a row tied to a relation the catalog does not hold, a tied relation without a direction, and a row for a key no extractor emits
- When: the mapping is checked
- Then: each is refused with both names, the file and the line, and the check exits 1; a manifest with no `mapping:` fails as well

### Scenario: mapping-notices-new-keys
- Given: an extractor whose code emits a kind its vocabulary declaration does not hold
- When: the code is type-checked, or the mapping is checked against an emitted vocabulary holding it
- Then: the emission site fails the type check, and the key is refused as emitted and unmapped — no list in the check was edited


## Requirement: pov — Ten roles lead the catalog's areas or subgroups, and an area no role leads is refused
The starter set `madarch new` writes shall declare the ten reader roles — product,
analyst, architect, developer, operations, tester, designer, security engineer,
platform/DevOps and product lead — each with the areas or subgroups of the
catalog it leads and the blocks of a page it opens. Every area shall be led by
at least one role, whether the role names the area or one of its subgroups. A
role is the product's data: the engine keeps no list of roles, the settings the
reader changes accept the roles the product declares (with "everything" for all
of them at once), and the role card and the menu offer those roles. The six
roles a product had keep their meaning: the blocks they open and the groups
they lead are unchanged.

The starter set opens, by default, the areas that hold the product's own
knowledge — strategy, requirements, research and development and documentation —
and places the product's areas before the code's, so a person opening the wiki
reads that knowledge at once.

A mechanical check, run by `bun run check` over the starter set and by the
wiki's own read of a product's manifest, shall refuse a role that names an area
or a subgroup the manifest does not declare, and an area no role leads. Every
refusal shall name the file, the line and the role (or, for an unled area, the
area and the roles that exist). The starter set passes it.

### Scenario: ten-roles-lead
- Given: a product made by `madarch new`
- When: its `madarch/kinds.yaml` is read
- Then: its `roles:` declares the ten roles, each `lead` names declared areas or subgroups, and every area of the catalog is led by at least one role

### Scenario: pov-refusals
- Given: a starter manifest with a role that leads an area nobody declares, and a catalog area no role leads
- When: the POV is checked
- Then: each is refused with the file, the line and the role (or the area and the roles), and the check exits 1

### Scenario: pov-is-data
- Given: a product whose manifest declares a role the engine has no constant for
- When: the reader opens the role card or asks the settings
- Then: the role is offered and can be kept, and a role the product does not declare is refused


## Requirement: workflows — The starter set declares the four workflows, and a check refuses a missing stage or an input without a producer
The starter set `madarch new` writes shall declare the product's workflows in
`madarch/workflows.yaml`, beside the kinds and the POV: the four the engine
ships — first fill, update by commit, branch/worktree and history point. A
workflow is a named set of the engine's stage ids; the stages' capabilities give
the order, so no edge is declared in the file, and a stage is engine code
referenced by id. A workflow declares its status: an `implemented` workflow
names stages the engine can run today, and a `planned` one says the engine has
no stage for it yet, may name no stages, and a stage it names must still be one
the engine's stage registry holds. The first fill names the stages of the fill
as the registry holds them today, and every stage a plan reads an input of has a
producer among the workflow's own stages.

A mechanical check, run by `bun run check` over the starter set and by the
wiki's own read of a product's manifest, shall refuse a workflow naming a stage
the engine's stage registry does not hold, and, for an implemented workflow, a
stage whose required input no other stage of the workflow produces, named by the
path the stage graph derives (`modules → symbol → syntax`), and a cycle of the
workflow's stages. Every refusal of a stage shall name the file, the line, the
workflow and the stage, and a refusal of the file or of a workflow's own fields
shall name the file, the line and the workflow; one defect shall be one finding,
and a workflow the reader refuses shall be left out while the others stand. The starter set passes it, and a
valid workflow is read without a finding.

Declaring, reading and checking a workflow shall change no run: which stages a
run enables from its workflow, and how a commit, a branch or a history point
starts a run, is the orchestrator's and lands with later stages.

### Scenario: starter-set-workflows
- Given: a product made by `madarch new`
- When: its `madarch/workflows.yaml` is read
- Then: it holds the four workflows, first fill names the stages the engine's stage registry holds today, and update by commit, branch/worktree and history point are planned with no stages

### Scenario: workflow-refusals
- Given: a workflows manifest with a stage id the registry does not hold, an implemented workflow whose stage reads an input no stage of the workflow produces, and a cycle of the workflow's stages
- When: the workflows are checked
- Then: each is refused with the file, the line, the workflow and the stage, and the check exits 1

### Scenario: workflow-reads
- Given: a workflows manifest naming stages the registry holds whose required inputs each have a producer among them, and a planned workflow naming no stages
- When: the workflows are read, by `bun run check` or by the wiki's own read of the product
- Then: every workflow reads without a finding and the wiki's manifest findings hold none of its own
