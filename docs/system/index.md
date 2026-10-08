# System documentation

Current specifications describe accepted behaviour on the main line, one file
per capability in `capabilities/<capability>.md`, named from the glossary and
written from the skills' capability template.

## Coverage

Accepted 2026-09-25 with the change graph-foundation (`docs/changes/graph-foundation/`):

- [intended-model](capabilities/intended-model.md): reading and checking a repository's model.
- [compiled-model](capabilities/compiled-model.md): the `model.json` every view and agent reads.
- [model-history](capabilities/model-history.md): every version of every source's model, on both time axes.
- [graph-queries](capabilities/graph-queries.md): what is inside, views with collapsed relations, dependencies, as of any time, through LadybugDB.

The readings the run decided within these requirements are in
`docs/changes/graph-foundation/design.md`, "Readings decided during the run".

Changed and added 2026-09-25 with the change readable-views (`docs/changes/readable-views/`):

- intended-model: relations carry a name; an unnamed one loads with a warning.
- compiled-model: relations carry their names.
- graph-queries: a view may be asked with its context, the neighbours outside its scope.
- [views](capabilities/views.md): the view set, rendered as Mermaid pages and a LikeC4 workspace.

Its run's decisions are in `docs/changes/readable-views/design.md`, "Decided during the run".

Changed and added 2026-09-29 with the change agent-model (`docs/changes/agent-model/`):

- intended-model: an evidence item may name a range of lines, the commit and the file's blob id.
- [model-authoring](capabilities/model-authoring.md): the skill that lets a coding agent write and update a repository's intended model and its review report.
- [model-check](capabilities/model-check.md): checking a repository's model against the repository, without a server.

Its run's decisions are in `docs/changes/agent-model/change.md`, "Design and decisions".

Added 2026-09-30 with the change wiki (`docs/changes/wiki/`):

- [wiki](capabilities/wiki.md): a static site generated from a repository's model and its own documents, built by Zensical or Starlight, each view offered as LikeC4, Mermaid and archify.

Its run's decisions are in `docs/changes/wiki/change.md`, "Design and decisions".

Added 2026-10-01 with the change server-views (`docs/changes/server-views/`):

- [server](capabilities/server.md): storing sent models per source and answering view requests as Mermaid or LikeC4 text, across restarts.
- [graph-queries](capabilities/graph-queries.md): the engine's memory bounded for a server that runs for days.
- [views](capabilities/views.md): one view of an element at a depth, as Mermaid or LikeC4, beside the view set.
- [model-authoring](capabilities/model-authoring.md): the skill sends the checked model to a named server.

Its run's decisions are in `docs/changes/server-views/change.md`, "Design and decisions".

Changed 2026-10-08 with the change use-cases-data-entities (`docs/changes/use-cases-data-entities/`):

- intended-model: data entities with their classification, transfers naming the entities they carry, and scenarios whose steps follow the model's relations and name the requirements they realise.
- compiled-model: the compiled model carries data entities and scenarios.
- model-history: data entities and scenarios are kept through the history, each a source's own claim.
- model-check: a scenario's requirements resolve against the capability specs, and a data entity's evidence is resolved and checked for staleness.

Its run's decisions are in `docs/changes/use-cases-data-entities/change.md`, "Design and decisions".

## Known unknowns

- The query engine's memory in a long-lived process: measured with the
  change server-views (madarch-ti6.2) — at a fixed 2 execution threads and
  query times reduced to the history's own times, a long run of
  `dependents` and `view` calls at an advancing clock levels off well
  under the long-run test's 400 MB bound, so the server holds one engine per
  graph without a restartable process (madarch-ti6.1). The update path is
  not bounded yet: about 115 KB per update, the buffer pool full after about
  5 000 updates without a rebuild (madarch-8iw, the live-graph charter's exclusions).
