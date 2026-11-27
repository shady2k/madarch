# A product without documents still has a Problems page

Change: madarch-64o5.181
Base: 6fa60fcee7ef543009bdc377c843b5311d6ab315
Tasks: madarch-64o5.181
Kind: no-behavior

## Intent

`GET /api/problems` is the wiki frame's own read on every page, and it answered HTTP 500 for a product whose manifest
declares no `document` kind: the listing projects documents through the catalogue's `document` semantic role, and the
projection refused with `semantic role "document" is required by this operation`. The list and its count both went
through that read, so every page lost the count.

## Rationale

The semantic roles are the product's (decision 0031), and documents are one projection a product may never declare: a
product that declares no `document` role has no documents to project. `documentOpinions` returns an empty list when the
manifest declares no binding for the role it projects, which is the answer the Sources page and the Problems page both
need. A role the manifest does declare stays exact: a field the kind does not declare, a value its kind does not
declare, an endpoint of another role and a malformed anchor are still refusals.

## Out of scope

- The roles the Problems read genuinely requires — the file index's `repository` role and the page's `problem-task`
  role — still refuse when a manifest leaves them out; they name facts the page reads, not an optional projection.
- The foundation-slice walk keeps its `document` kind declared: its cut keeps the kinds the catalogue's roles name, and
  the walk itself is not run by this change.

## Preserved contracts

- product-wiki/pages: a product that declares the `document` role still has its documents projected, with their repository and commit endpoints; a declared role's own faults are still refusals.

## Coverage

- product-wiki/pages: test

## Where it is seen

Kind: request
Place: `GET /api/problems` and `GET /api/problems?count=1` of a product whose manifest declares no `document` kind

1. Open a product whose manifest declares no `document` kind and read `GET /api/problems`: HTTP 200 with the listing
   (no problems, empty sections) and no note about a failed document read.
2. Read `GET /api/problems?count=1` of the same product: HTTP 200 with the open, closed and dismissed counts and the
   per-section counts.
