# Show a repository's model as views from madarch's server

Change: server-views
Base: 70ad3f16edd1f8fa2b4b1407d279e21f65191a6b
Tasks: madarch-ti6.2, madarch-ti6.5.1, madarch-ti6.5.2, madarch-ti6.6.1, madarch-ti6.6.2, madarch-ti6.6.3, madarch-ti6.6.4, madarch-ti6.6.5
Kind: behavior

## Intent
Today a repository's views exist only as files the model check renders into
a folder on the machine that ran it: to put a diagram into a document, a
person copies a page by hand, and nobody else can ask for one. After this
change the skill, once the model check passes, sends the repository's
compiled model with its commit to madarch's server, which keeps every version
sent. Anyone who can reach the server asks it for a view (the repository, the
element, how deep, Mermaid or LikeC4) and gets text ready to paste into a
document or open in LikeC4. The server never reads a repository: what it
shows is what was sent, at the commit it was sent for.

Stories:
- As an engineer writing a design document, I ask the server for the view of
  the service I am changing, as Mermaid, and paste the answer into my
  document; it renders on GitHub with its table of arrows.
- As an architect, I ask for the same view as LikeC4 and open it in LikeC4's
  tools to explore.
- As an agent that has just written a repository's model, I send it to the
  server as the skill's last step and report the commit the server stored.
- As someone who asks for a repository nobody has sent, I am told so, shown
  what the server holds, and given the command that sends a model.

## Out of scope
Several repositories in one graph and relations between them (next
milestone); the server cloning, fetching or reading any repository; webhooks,
polling and CI triggers; views at a past time, per environment or per
architecture state; authentication; a Docker image; a web viewer or hosting
the wiki; a command-line client beyond the send command; restarting the query
engine in its own process (madarch-ti6.1, decided on this change's memory
measurement).

## Rationale
The last outcome of the MVP charter (madarch-ti6), narrowed by the owner on
2026-09-29 to one repository per graph, the model sent by the skill ("для
MVP хватит одного репозитория. Я хочу просто посмотреть, как это будет
выглядеть для начала").

## Changes to requirements
- server (new capability): the send command runs the model check and sends
  the compiled model with its commit; the server stores it per source,
  idempotently; answers a view request with Mermaid or LikeC4 text; explains
  a request it cannot answer, naming the send command for a source never
  sent; lists its sources; answers the same after a restart.
- views: one view on request, at a depth; at depth 1 the view set's page
  without its links, or a workspace with that one view; deeper views nest
  frames.
- model-authoring: the skill sends the model when a server is named.
- graph-queries: the engine's memory levels off over a long run, with few
  execution threads and statements prepared only for the history's own times.

## Preserved contracts
- graph-queries/as-of: the times a query answers for are unchanged; reducing a time to the history's latest time at or before it gives the same answer (madarch-ti6.2), checked by the conformance tests passing unchanged.
- views/view-set: the pages and the workspace the view set renders are byte-identical; one view on request is a separate way in.

## Coverage
- server/send: test, server-views
- server/store: test, server-views
- server/view: test, server-views
- server/explains: test, server-views
- server/sources: test
- server/survives-restart: test
- views/one-view: test, server-views
- views/view-set: test
- model-authoring/send: server-views
- graph-queries/as-of: test

## Blocking questions
None.

## Design and decisions
Decided with the owner before this change (charter, 2026-09-29): one
repository per graph; the skill, or a command beside the check, sends the
compiled model with its commit and commit time; the server never reads a
repository; the reference system is the second acceptance case.

Decided with the owner on 2026-09-30, at this change's preflight: one
repository per graph stays for the MVP, and the architecture provides for a
product made of several repositories ("Остаемся с одним для MVP, но мы должны
предусмотреть в архитектуре"). So:
- **A graph is a named set of sources.** The server keeps one history file
  per source in its data folder, and one query engine per graph, built from
  the assertions of every source the graph lists (the engine takes any list
  of records, and the histories read one source each). In this milestone
  every graph lists exactly one source and is named after it; joining a
  product's repositories (madarch-bwt) adds graphs that list several, with
  no change to how a source is sent or stored and no merge of history files.
  A test builds a graph from two sources' histories and gets the union's
  view, so the seam is exercised, not only described.
- **Ids that clash are a join-time problem.** Each source stores its own ids
  freely (the reference system and nocx both declare `platform`, measured
  2026-09-30); a graph listing several sources will refuse or report a clash
  when it is built, as decision 0003's duplicate-id check says.
- **The view request names a source now, a graph later.** `POST /views` takes
  `source`; a later `graph` (or product) field is added beside it, so no
  request valid today changes meaning.
- Decision 0013 is amended for this milestone (each graph one source, the
  graph a list of sources), and `docs/system/architecture.md` is written with
  the server's parts and this path to several repositories.

Recommended by the agent (the owner may change any):
- **HTTP with JSON, three ways in.** `POST /models` takes `{source, commit,
  committedAt, model}` and answers stored or already stored; `POST /views`
  takes `{source, element?, depth?, format}` (parameters in the body, as
  decision 0007 says) and answers `text/markdown` or LikeC4 text; `GET
  /sources` lists what is held. A refusal is JSON `{error: {message, field?,
  accepted?}}` with 400, 404 or 409. No framework: Bun's own server.
- **The send command runs the check first.** `bun scripts/send-model.ts
  <repo> --server <url> [--source <name>] [--rev <rev>]` beside
  `check-model.ts`; it sends only a model whose check passes, at the checked
  revision's commit and commit time, read from the working tree as the check
  reads it (a model not committed yet, as in the skill's own run, can be
  sent). The source's name defaults to the `origin` remote as host and path
  (`github.com/shady2k/nocx`): stable across clones and machines, unlike a
  folder name.
- **The server is started with a data folder.** `bun scripts/serve.ts --data
  <folder> [--host 127.0.0.1] [--port 4180]`; without a data folder it refuses
  to start (a missing input is an error, never a temporary default).
- **Mermaid answers are the page without its links.** At depth 1 the answer is
  exactly the view set's page of that element minus its "Up" and "Open" lines,
  whose targets are not in the reader's document. So what the renderer
  already proved readable on GitHub is what the server gives.
- **LikeC4 answers are a whole workspace with one view.** Every element and
  relation, as the workspace already holds them, and only the asked view, so
  the answer validates alone and opening a neighbour in LikeC4 still works.
- **Depth.** Default 1; deeper views frame each shown element with children
  around its own children. They follow the same rules but are not held to
  the 12-pixel label size.
- **Memory first.** madarch-ti6.2 lands as this change's first stage: a
  server runs for days, and its long-run test decides madarch-ti6.1 (no
  restartable process if memory levels off).
- **Logs.** One line per request on standard output: method, path, status,
  source and milliseconds; a refusal adds its message; a failure of the
  server itself is logged at error level with its cause and answered 500.

Run settings, agreed at the preflight on 2026-09-30 (the owner accepted the
batch, "Да"):
- Workers are omp sessions started through herdr, one at a time, on omp's
  default model; the coordinator (a Claude session) plans, integrates,
  reviews and accepts, and its session stays open for the run.
- Review by Codex CLI; fallback an independent same-model reviewer,
  disclosed in the acceptance record. Jev on piles. Changed by the owner
  mid-run, 2026-09-30 20:45 MSK, after stage 1's review ("А зачем ты каждый
  этап отдельно проверяешь? Сделай одну проверку в конце"): one review of
  the whole feature's diff before the pull request; each stage is still
  accepted on its full checks and mutation run, its record naming the final
  review as its review evidence. Stage 1's review, already done, stands;
  its three findings are fixed.
- Checks, changed by the owner mid-run, 2026-09-30 20:50 MSK ("Да, все
  проверки делай в конце"): workers run the type-checker and their own
  change's tests only; after each merge the coordinator runs the
  type-checker and the changed code's tests; stages are recorded as
  integrated, not accepted on their own checks. The full suite with the
  performance tests, `views:check`, the mutation run over every changed
  range, the Codex review and the `server-views` check run once, on the
  final revision, and every stage's acceptance record rests on that run.
- Forecast: 2 to 4 hours of agent work, the pull request expected about
  00:00 to 02:00 MSK on 2026-10-01; past 06:00 MSK without word the run has
  stopped. The owner named no absence; the due time stands for it.
- If madarch-ti6.2's long-run test levels off, the coordinator closes
  madarch-ti6.1 as "no restartable process" on that evidence; if not, that
  part stops for the owner.
- The LadybugDB issue draft goes into the pull request's report and is sent
  only with the owner's yes.
- Before the run, the test suites' leftover temporary folders were removed
  at the owner's word ("Диск почисть конечно"); madarch-1xq stays out.
- Notification by Bark when the pull request is ready or the run stops for
  the owner.

Acceptance (the check named in Coverage):
- `server-views`: a server started on a scratch data folder; the reference
  system and nocx's model (the accepted skill run on nocx at `3f0e46e`, in
  its local checkout) sent with the send command; for each, the views at the
  top level, at a domain or service, and at the modules of a core requested
  as Mermaid and as LikeC4: every Mermaid answer parses, and rendered by
  GitHub's Mermaid in a 1150-pixel column its labels are at least 12 pixels
  and none overlaps (numbers recorded); every LikeC4 answer passes `likec4
  validate`; sending the same commit again answers already stored and every
  answer is byte-identical; a request for a source never sent is answered as
  the explains requirement says; the skill's send step is run once against
  the same server.

## Acceptance evidence
Recorded on the change's tasks as `check:` comments and in the stages'
acceptance records, with the `server-views` numbers.

## DONE WHEN
nocx's model written by the skill and the invented reference system's model
(`examples/reference-system`) are sent; for each, views requested at the top
level, at a domain or service and at the modules of a core come back as
Mermaid that renders in Markdown and as LikeC4 that `likec4 validate`
accepts; sending the same commit again changes nothing; a request for a
source never sent is answered saying so and how to send one. Where it is
seen: a server started from a checkout of madarch with `bun scripts/serve.ts`,
the send command run on the reference system and on nocx's checkout, and
view requests made with `curl` to the server, the answers pasted into a
Markdown file and opened on GitHub, and saved as a `.c4` file for `likec4
validate`.
