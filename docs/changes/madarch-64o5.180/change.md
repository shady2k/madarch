# The problems listing reads the endpoints a document names, not a role's whole edge kinds

Change: madarch-64o5.180
Base: 16d0caf41
Tasks: madarch-64o5.180
Kind: no-behavior

## Intent

`GET /api/problems` is the frame's own read on every page the wiki opens, so it must not pay for the graph it does
not show. A product the agent has written no document in still paid for every edge kind the catalogue's `document`
role reaches: the role's endpoints (repository, commit) were projected with all their edge slots, and each edge slot is
a whole edge kind read from the store.

## Rationale

`documentOpinions` projects the documents' endpoint identities and the endpoints' own display values. It needs the
repository's `name` and the commit's `hash`; it never reads the endpoints' edge slots. The role's edge slots belong to
the pages that show them.

Two changes, both in the projection itself, so every reader of a semantic role gains them:

- `semanticEntities` takes `{ edges: false }`, and reads no edge kind when the role has no row to project.
- `documentOpinions` asks for the endpoint roles without their edges, and returns before reading any endpoint when the
  product holds no document at all.

Measured on the acceptance walk's product (`test/foundation-slice-e2e.test.ts`, scripted agent, no documents): the
documents phase of one listing fell from 27 368 ms to 24–40 ms on a loaded box.

## Out of scope

- The applicability scan's cost (`vanishedCurrentEvidence`): it walks every kind of the contract per listing, and it is
  the remaining cost of a cold listing. Measured on the same product, that phase had not returned after sixteen
  minutes, so it is its own defect and its own task.
- The code rules' whole-kind reads (2 475 ms of the same listing).
- The listing's cache (unchanged: one collection per key, served to every reader that asks while it runs).

## Preserved contracts

- product-wiki/pages: a declared document keeps its repository and commit endpoints and its own values, read through the catalogue's declared semantic roles.

## Coverage

- product-wiki/pages: test

## Where it is seen

Kind: command
Place: `bun test test/knowledge-anchors.test.ts`

1. A product with no document reads no edge kind and no endpoint kind for its documents.
2. A document keeps its repository's name without reading the repository role's edge kinds.
3. A slow edge read is never waited for when the document role holds nothing.
