# MVP: a sound graph foundation, proved on a large invented system and a real repository

Chartered 2026-09-24, revised the same day after the owner restated their
expectations (madarch-tid). The foundation first: the model's format, its
storage with history and the query engine. Then readable views of a large
invented system, an agent skill that writes a repository's model, and a server
that turns the model the skill sends into diagrams (revised 2026-09-29).

## Outcomes and acceptance

Outcomes 2, 3, 4 and 5 rest on the foundation only; their order below is not a
dependency.

1. **Store the graph on a sound foundation** (madarch-ozp). The intended-model
   YAML format, nested to any depth, with environments (bindings, zone
   differences, which elements each environment has) and a chain of
   architecture states (as-is, transition stages, to-be); its compilation into
   `model.json`; the storage of every model version with both time axes from
   the first write, in SQLite; and LadybugDB as the query engine built from it,
   answering the traversals views need (collapsing relations to the visible
   level, drilling into an element, transitive dependencies) with the time
   filter.
   *Check:* conformance tests for the review's scenarios (a service gains
   internal elements; a service moves to another domain; one request carries
   different data categories each way; two environments differ in endpoints and
   zones; a general relation and its refinement are not counted twice); a model
   using environments and states compiles and is stored without loss; as-of
   reads on both time axes, through the query engine, return the expected graph.
2. **See a large information system as readable views** (madarch-mk5). An
   invented reference system with stores, brokers and topics, REST, gRPC,
   caches, external systems, zones and data categories, rendered in Mermaid and
   LikeC4 with grouping, collapsed relations and drill-down, from domains down
   to the modules of a service.
   *Check:* the top-level view shows about ten boxes or fewer, every domain
   opens into its own view, at least one service opens down to its modules,
   `likec4 validate` passes, the Mermaid views render in Markdown.
3. **Let an agent write the intended model of a repository** (madarch-utk). A
   skill for coding agents reads a repository with the agent's own tools (the
   language's import graph, contract and schema files) and by reading it (the
   README, architecture documents, the code), and writes the intended-model YAML
   inside the repository. Every element and relation it writes names its
   evidence (a file, optionally a line).
   *Check:* on the owner's public repository nocx the skill writes a model that
   compiles and shows three levels (context, the application's parts, the
   modules of its core), with evidence on every element and relation.
4. **Show a repository's model as views from madarch's server** (madarch-ti6).
   After the model check passes, the `write-intended-model` skill (or a command
   beside the check) sends one repository's compiled model with its commit and
   commit time to the server. The server never clones or reads a repository: it
   stores the model in the history and answers a view request (the source, the
   element to show, the depth and the format) with Mermaid or LikeC4 text,
   ready to paste into documentation. One repository per graph.
   *Check:* nocx's model written by the skill and the invented reference
   system's model (`examples/reference-system`) are sent; for each, views
   requested at the top level, at a domain or service and at the modules of a
   core come back as Mermaid that renders in Markdown and as LikeC4 that
   `likec4 validate` accepts; sending the same commit again changes nothing; a
   request for a source never sent is answered saying so and how to send one.
5. **Generate a wiki with diagrams from a repository's model** (madarch-7br).
   Documentation people read in a browser instead of Markdown files in a
   repository: from the compiled model, one page per domain and per element
   (its interfaces, its relations with their contracts and data categories,
   its diagram), and pages for the interfaces, the zones and the data
   categories, all cross-linked. One page-data layer feeds two engines,
   Zensical and Starlight, chosen by `MADARCH_WIKI_ENGINE` (default
   `zensical`) or `--engine`; `bun scripts/wiki.ts`, given a repository and
   an output folder, builds the site, and the server of outcome 4 reuses it.
   *Check:* the reference system's and nocx's wikis build on both engines from
   the model alone; on their pages the interactive LikeC4 diagram opens with
   element details and drill-down and the Mermaid diagram renders; the built
   sites have no broken links.

## Exclusions

- Extraction plugins, facts and the fact log's extracted layer: the MVP stores
  only the intended model read from git; the agent skill does static analysis
  with its own tools.
- Any analysis of code by the server itself.
- Views per environment and per architecture state: both are in the format and
  the storage, not yet in views.
- Rules and flows in the model.
- Webhooks, CI triggers and polling: a model arrives when the skill sends it.
- The server cloning or reading repositories; several repositories in one
  graph, relations between them joined by contract ids, the list of
  repositories composing a system, and ids unique across repositories (next
  milestone).
- Calling the skill's send step from other skill sets: the owner's own skill
  set is outside this repository.
- Pull-request what-if checks and PR comments.
- History queries through the API: history is stored from the first write, but
  asked for in the next milestone.
- Authentication, a command-line client, MCP, our own web viewer: the wiki's
  pages are built by Zensical or Starlight and its diagrams drawn by LikeC4
  and Mermaid; hosting the wiki, and choosing one engine, come later.
- Runtime observation, network access matrices.
- PostgreSQL, several server instances, several graphs.
- Anything from the owner's private repositories in this public repository;
  from nocx, a public repository, only findings about the skill are recorded
  here.

## Scope decisions

- Nothing carries over: this is the first milestone. The tasks "Wire the
  document gate" and "Record the vision, the founding decisions and a first
  glossary" belonged to it and are closed.
- Revised 2026-09-24 (madarch-tid): extraction plugins and facts moved to
  `live-graph`; the skill moved before the server; drill-down into a service,
  environments, architecture states and the view on request were added;
  LadybugDB stays in the foundation.
- Revised 2026-09-25: after looking at the merged views of outcome 2, the
  owner added "Make the reference system's views readable" (madarch-48x) to
  this milestone: measured on GitHub, 5 of 8 pages had labels under 12 px.
- Revised 2026-09-29: after the agent skill was accepted, the owner narrowed
  outcome 4 to one repository ("для MVP хватит одного репозитория. Я хочу
  просто посмотреть, как это будет выглядеть для начала"): the skill sends the
  model and the server never reads repositories; the invented reference system
  is the server's second acceptance case. Joining several repositories moved to
  `live-graph`. The two tasks on the query engine's process and memory
  (madarch-ti6.1, madarch-ti6.2) still hold: the server keeps the history and
  the engine for days.
- Revised 2026-09-29, later the same day: the owner added outcome 5, a wiki
  with diagrams generated from the model, after comparing two throwaway sites
  of the reference system (madarch-ti6.3) and keeping both engines behind an
  environment variable ("Давай сливать, движок выбираем через env").
- Finding budget: kept at the value agreed at setup (see `findingBudget` in
  `.shady2k/config.json`); there is no history yet to justify another.

## Next horizon

Milestone `live-graph`, titles only (deferred in the tracker): keep the graph
current from webhooks, CI and polling; extract facts with static plugins into
the fact log; check a pull request against the graph before merge; answer
questions about the past on both time axes; serve the graph to agents over MCP;
find interactions in source code; show views per environment and architecture
state; protect the server with tokens and single sign-on; join several
repositories into one graph by contract ids.
