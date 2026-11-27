# Read only the document endpoints and evidence subjects needed by the Problems listing

Change: madarch-64o5.180
Base: 16d0caf41
Tasks: madarch-64o5.180
Kind: no-behavior

## Intent

`GET /api/problems` is the frame's own read on every page the wiki opens, so it must not pay for the graph it does
not show. A product the agent has written no document in still paid for every edge kind the catalogue's `document`
role reaches: the role's endpoints (repository, commit) were projected with all their edge slots, and each edge slot is
a whole edge kind read from the store. The current evidence check also read assertions across the entire contract for
each page of attachments, even for kinds that held no evidence.

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

The current evidence check seeks by assertion UUID and link UUID with the existing node and edge indexes.
The external cursor keeps its existing assertion-UID and edge-UID spelling.
It batches assertion reads for the subjects and fields named by each batch and uses the existing selection rules to
check current existence and source activity. A page counts current attachments, including those whose retained evidence
is sound. The historical proof and current applicability are evaluated independently, as in decision 0039 items 19
and 31.

The listing evaluates evidence applicability when the catalogue enables the rule or a saved dismissal names it.
It shares the published catalogue with the evidence check and the product file index. Evidence and code rules
run concurrently, as do the file index, dismissals, Markdown opinions, and document endpoints.

## Out of scope

- The code rules' whole-kind reads (2 475 ms of the same listing).

## Preserved contracts

- product-wiki/pages: a declared document keeps its repository and commit endpoints and its own values, read through the catalogue's declared semantic roles.

## Coverage

- product-wiki/pages: test

## Where it is seen

Kind: command
Place: `bun test test/knowledge-anchors.test.ts test/current-evidence.test.ts test/catalogue-starter-kinds.test.ts test/problems-findings.test.ts`

1. A product with no document reads no edge kind and no endpoint kind for its documents.
2. A document keeps its repository's name without reading the repository role's edge kinds.
3. A slow edge read is never waited for when the document role holds nothing.
4. Evidence pagination skips unrelated kinds and reports the same current vertex and edge evidence in cursor order.
5. The cold Problems listing and count each read four evidence links and only the assertion kind and subject those links name.
6. A catalogue without the evidence applicability rule still shows its configured findings and does not run that check.
7. A dismissal for an active evidence problem still counts after the rule is disabled or removed. It stops counting when the assertion ends.
