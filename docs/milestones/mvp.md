# MVP: a sound graph foundation, proved on a large invented system and a real repository

Chartered 2026-09-24. The foundation first, then readable views of a large
system, then a real repository from its address alone, then an agent that fills
in what static extraction cannot.

## Outcomes and acceptance

Independent after the foundation; the order below is not a dependency.

1. **Store the graph on a sound foundation** (madarch-ozp). The intended-model
   YAML schema, the fact schema, the compiled `model.json`, the append-only
   bitemporal fact log, the query engine built from it, and idempotent ingest.
   *Check:* conformance tests for the review's scenarios (a service gains
   internal elements; a service moves to another domain; one request carries
   different data categories each way; two environments differ in endpoints and
   zones; a general relation and its refinement are not counted twice), and
   as-of queries on both time axes return the expected graph.
2. **See a large information system as readable views** (madarch-mk5). An
   invented reference system with stores, brokers and topics, REST, gRPC,
   caches, external systems, zones and data categories, rendered in Mermaid and
   LikeC4 with grouping, collapsed relations and drill-down.
   *Check:* the top-level view shows about ten boxes or fewer, every domain opens
   into its own view, `likec4 validate` passes, the Mermaid views render in Markdown.
3. **Build the graph of a real repository from its address** (madarch-ti6).
   `POST /sources` with a URL; the server clones it and runs the static plugins
   (docker-compose and Kubernetes manifests; OpenAPI, AsyncAPI and proto
   contracts; package manifests), then renders the views. No CI, no webhooks.
   *Check:* a public repository yields Mermaid and LikeC4 views, and the gaps
   static extraction leaves are recorded as a list.
4. **Let an agent write the intended model of a repository** (madarch-utk). A
   skill for coding agents proposes the intended-model YAML from the repository
   and the static results: domains, names, data categories, bindings.
   *Check:* on the repository from outcome 3 the skill closes the recorded gaps,
   and the views show its additions apart from what static extraction found.

## Exclusions

- Webhooks, CI triggers and polling: sources are added on request by address.
- Pull-request what-if checks and PR comments.
- History queries through the API: history is stored from the first write, but
  asked for in the next milestone.
- Authentication, a command-line client, MCP, our own web viewer.
- Extraction from source code, runtime observation, network access matrices.
- PostgreSQL, several server instances, several graphs.
- Anything from the owner's own repositories in this public repository: runs on
  them stay local; only findings about the plugins are recorded here.

## Scope decisions

- Nothing carries over: this is the first milestone. The open tasks "Wire the
  document gate" and "Record the vision, the founding decisions and a first
  glossary" belong to it.
- Finding budget: kept at the value agreed at setup (see `findingBudget` in
  `.shady2k/config.json`); there is no history yet to justify another.

## Next horizon

Milestone `live-graph`, titles only (deferred in the tracker): keep the graph
current from webhooks, CI and polling; check a pull request against the graph
before merge; answer questions about the past on both time axes; serve the graph
to agents over MCP; find interactions in source code; protect the server with
tokens and single sign-on.
