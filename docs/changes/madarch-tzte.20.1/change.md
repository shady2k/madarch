# The fill's code-fact schema

Change: madarch-tzte.20.1
Base: 82d5edbb1e716df722497d0ccc1ef5a2724448ed
Tasks: madarch-tzte.20.1
Kind: no-behavior

## Intent
Decision 0026 rebuilds the fill as deterministic stages that extract facts
into the product graph and bounded agent units that read and write the same
graph through checked tools. Nothing that rebuild does can be stored, queried
or published until the graph has a vocabulary: what a fact of this fill is,
which kinds exist, what every fact carries as evidence, and how a fact is
named so that two runs, two machines and two commits agree on it.

This change adds `src/fill/facts.ts`: that vocabulary as pure types and pure
functions. Twenty-five node kinds and fifteen edge kinds cover stages 0 to 7
and the agent stages' claims, entity proposals, rules, states, transitions,
interactions, coverage and questions; every fact carries its provenance, its
layer and its status; an id is the digest of a fact's identity and of nothing
else; every path is a repository path, so a machine's checkout reaches no id;
each kind carries its own version; and one explicit table maps each fact kind
onto the product registry's kinds. `test/fill-facts.test.ts` proves it, and
`design.md` draws the kinds as a Mermaid class diagram.

## Rationale
The requirement this code serves is not a current one to change: the fill's
capability is proposed by change `fill-pipeline-monday`, not closed, and the
rebuild's own requirement text lands with the stage that closes decision
0026. So this change implements an accepted decision without moving a current
requirement, as `madarch-24sy` did for decision 0024's persistence. Nothing
imports the module yet: no user-visible behaviour of the product changes.

The kinds are taken from the decisions, not invented here: 0004's atoms
(`provides`, `consumes`, `binds`, `resolves`, `coverage`) are the schema's
edges and its coverage node; 0005's layers and statuses are the fact's own two
fields; 0026's stages are the table's own stage column; 0021's registry
storage forms are the mapping's vocabulary; 0003's normalized contract ids and
0006's variable names are the identity of an endpoint and an environment
variable, so one repository's provider and another's consumer are one node.
The field's schemas the decision cites ground the shapes: SCIP's symbols,
occurrences and their roles, and RepoDoc's code, concept and document entities
with their structural and semantic relations.

## Out of scope
- Storage: the fact log's tables, the database owner and a unit's draft set
  (madarch-tzte.19.1 and its dependants).
- The write path's checks that need the pinned snapshot: that the cited bytes
  exist and were read, that referenced nodes exist, and that a write stands
  inside its unit's scope (0026's checked writes).
- The stages themselves, the extractors behind each kind, the clustering, the
  page rendering and the diagrams drawn from the graph.
- Runtime observation: no stage of the fill watches a running system, so no
  kind of this version is written with the `observed` layer.
- The fill's capability text: `design.md` holds the requirements this schema
  meets as prose, to be folded into the fill's own capability when its change
  closes.

## Preserved contracts
- product-wiki/pages: unchanged — a page stays the product's Markdown in git (0017); a fact is a view's material and never becomes a page, and nothing reads the new module yet.
- product-repository/contract: unchanged — the registry's kinds stay the product's own; the change maps the engine's fact kinds onto its storage forms and adds no registry kind to the engine.

## Coverage
- product-wiki/pages: test
- product-repository/contract: test

## Blocking questions
None.
## Design and decisions
See `design.md`: the shapes, the identity rules, the kinds as a Mermaid class
diagram, and the requirements the schema meets. Taken from decisions 0003,
0004, 0005, 0006, 0021, 0026 and 0027; nothing here re-decides them.

Owner approval is not asked of this change: it is `no-behavior`, and the
policy requires approval for behavior changes only.

## Acceptance evidence
Recorded on the task as `check:` comments against the change's revision: the
focused suite `test/fill-facts.test.ts`, `bun run check`, and the independent
review. The mutation check is not run: the owner's rule runs Stryker once per
assembled stage.

## DONE WHEN
`src/fill/facts.ts` declares every kind madarch-tzte.20.1 names, each with its
stages, provenance, layer, status and version; ids are the digest of each
kind's declared identity, proven equal twice, across two checkouts' machine
paths and across a rerun at another commit, and carrying no run, unit,
attempt or time; and the registry mapping is a table with a test over it.
