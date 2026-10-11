# The design of the documents view

## Context and constraints
The wiki serves pages read from the working tree; the documents follow
the set's forms, and the check the set owns must be able to read them.
The shell is the accepted reading shell: navigation, document, panel
place.

## Approach and alternatives
The server reads each document's form — kind, id, fields, links — beside
its text, computes the backlinks across the product's documents, and runs
the set's product check once per product revision. The page shows the
form's truth in its header and the findings on the page that fails.
Alternatives: rendering the form client-side from the raw text (the app
would re-implement the set's reading), or running the check per request
(refused: one product revision, one run).

## Boundaries and contracts
The page API carries the document's form and findings beside the text;
the app holds no form knowledge of its own beyond labels.

## Delivery and recovery
One slice: the server read, the header and the findings block, the
sidebar's kind order; each acceptable on the fixture product.

## Verification
The fixture product's pages in both themes at both widths; the failing
example shows the findings; the app's tests hold the header and the
blocks to the API.
