# The foundation's first slice, walked end to end

Change: madarch-64o5.148
Base: 4316c762d
Tasks: madarch-64o5.148
Kind: no-behavior

## Intent

One opt-in end-to-end test of the foundation's first slice, ready before the landing. It makes a product with a small
repository it builds itself — two parts of TypeScript that import one another through a shared folder, and a README that
names the two parts — and fills it with the disk, git and imports plugins together with a scripted agent; never a
model. It then reads the graph through madarch's own MCP server (`madarch mcp`, the session an agent is given) and walks
the wiki in a real browser at 1440 and 390 px, writing the screens under `MADARCH_FOUNDATION_SHOTS`.

The assertions name what decision 0039 requires of the slice, by item:

- item 1 — every relation is an edge: a folder's and a file's repository is the parent key edge the kind declares, a
  file's folder is an edge, an import is an edge, and a component reaches the folder that realises it through edges
  only; no kind of the product declares a field that holds another entity's identity (`reference:`).
- item 2 — identity is the parent edge plus the entity's own key: the published schema has no `repository` scalar on a
  folder or a file.
- items 14 and 25 — every value is an assertion per source with its evidence, read back through the `Assertions` list of
  the field.
- item 35 — the catalogue counts the kinds the fill took and marks the kind nothing in the repository answers
  «неприменимо», with the reason of what was searched (`code.debt`: no file states a debt).

The declarations the test cannot do without are one list, read before any fill: the kinds `product`, `code.repository`,
`code.directory`, `code.file`, `code.module`, `c4.component`, `code.debt`; the edges `product.uses-repository`,
`code.contains`, `code.imports`, `code.file-repository`, `code.directory-repository`, `code.file-directory`; the key edges
that make a folder's and a file's repository part of their identity; and an edge chain that takes a component to the
folder that realises it.

## Rationale

The coordinator's brief for the first stage: the foundation is accepted on a small product, not on madarch's own
checkout, and the walk reads both doors a person and an agent use — the MCP server and the wiki. A scripted agent keeps
the walk free of a model, and a product the test builds keeps it free of an outside repository. The test is opt-in
(`MADARCH_FOUNDATION_E2E=1`, after `bun run build` in `wiki/app`), as the wiki's own walks are.

## Out of scope

- Fixing what the snapshot does not yet hold: the component kind, the product → repository edge, the realisation edge,
  the agent's read of a parented file's text, and the inapplicability mark.
- A second repository, federation, merges, and the disputes and resolutions of sources other than the fill's plugins and
  its agent.
- The wiki's own templates and pages; the walk reads the pages it finds.

## Where it is seen

Kind: command
Place: `MADARCH_FOUNDATION_E2E=1 bun test test/foundation-slice-e2e.test.ts` in a checkout whose `wiki/app` is built
1. A person runs the command; the test prints a skip line without `MADARCH_FOUNDATION_E2E=1`, and with it the walk runs
   a fill with a scripted agent, reads the graph through `madarch mcp`, opens the wiki's pages in a browser and answers a
   failure as one list of problems, each naming the kind, the edge or the page it is about.

## Preserved contracts

- fill-orchestrator/publish: one publication per unit generation; the walk reads the units' states.
- graph-queries/children: the folders' and the files' parent edges are read through the graph.
- product-wiki/pages: the product's documents and entities are the wiki's pages; the walk opens them.
- product-wiki/catalog: the starter set holds the entity catalog; the walk reads the catalogue's counts and marks.

## Coverage

- fill-orchestrator/publish: test
- graph-queries/children: test
- product-wiki/pages: test
- product-wiki/catalog: test
