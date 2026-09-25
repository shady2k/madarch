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

## Known unknowns

- Views, the server, the agent skill: later outcomes of the MVP.
- The query engine's memory in a long-lived process: bounded by fewer
  execution threads and fewer prepared statements (madarch-ti6.2), not yet
  measured over a long run (madarch-ti6.1).
