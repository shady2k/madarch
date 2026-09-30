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

## Known unknowns

- The server: the last outcome of the MVP.
- The query engine's memory in a long-lived process: bounded by fewer
  execution threads and fewer prepared statements (madarch-ti6.2), not yet
  measured over a long run (madarch-ti6.1).
