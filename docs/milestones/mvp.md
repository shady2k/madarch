# MVP: a sound graph foundation, proved on a large invented system and a real repository

Chartered 2026-09-24, revised the same day after the owner restated their
expectations (madarch-tid). The foundation first: the model's format, its
storage with history and the query engine. Then readable views of a large
invented system, an agent skill that writes a repository's model, and a server
that turns a repository's address into diagrams.

## Outcomes and acceptance

Outcomes 2, 3 and 4 rest on the foundation only; their order below is not a
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
4. **Build the graph of a real repository from its address** (madarch-ti6).
   `POST /sources` with a repository URL: the server clones it, reads its model,
   compiles and stores it, and renders Mermaid and LikeC4 views. A view is also
   returned on request: a `POST` whose body names the source, the element to
   show, the depth and the format returns that view's text, ready to paste into
   documentation. No CI, no webhooks.
   *Check:* a public repository holding a model yields Mermaid and LikeC4 views;
   a view requested with a scope and a depth comes back as Mermaid that renders
   in Markdown; a repository without a model gets an answer saying so and how to
   write one.

## Exclusions

- Extraction plugins, facts and the fact log's extracted layer: the MVP stores
  only the intended model read from git; the agent skill does static analysis
  with its own tools.
- Any analysis of code by the server itself.
- Views per environment and per architecture state: both are in the format and
  the storage, not yet in views.
- Rules and flows in the model.
- Webhooks, CI triggers and polling: sources are added on request by address.
- Pull-request what-if checks and PR comments.
- History queries through the API: history is stored from the first write, but
  asked for in the next milestone.
- Authentication, a command-line client, MCP, our own web viewer.
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
- Finding budget: kept at the value agreed at setup (see `findingBudget` in
  `.shady2k/config.json`); there is no history yet to justify another.

## Next horizon

Milestone `live-graph`, titles only (deferred in the tracker): keep the graph
current from webhooks, CI and polling; extract facts with static plugins into
the fact log; check a pull request against the graph before merge; answer
questions about the past on both time axes; serve the graph to agents over MCP;
find interactions in source code; show views per environment and architecture
state; protect the server with tokens and single sign-on.
