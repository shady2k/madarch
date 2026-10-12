# The product repository contract: schema, examples, check command

Change: product-contract
Base: 8ccc6ab27fc307f6c0388b5f36753ca72aed104d
Tasks: madarch-mr8i
Kind: behavior

## Intent
A product's knowledge is written under the skill set's own forms, and nothing
in madarch holds that vocabulary (decision 0021): the mechanism — the
document fields, the kinds registry, the stages — is madarch's to define and
read, while the kinds are data the product (usually the set, at setup)
writes. This change publishes that mechanism as madarch's contract: one
versioned JSON schema of the product repository format
(`schema/product-registry.schema.json`, generated beside the model
schemas), the kinds registry's reading (`src/product/contract.ts`, with the
checks the schema alone cannot carry: the prefix shape, the folder under
`docs/`, the stage being one of the list, the hint's non-emptiness), and a
check command (`bun run contract:check`, beside `bun run views:check`, also
in CI) that runs the conformance examples the repository holds and names
every refusal by its file, line and words.

What a user can do that they could not before: a tool can validate a
product's kinds registry against a published JSON schema at a pinned path,
and CI reads the product's mechanism against the shipped examples.

## Out of scope
- The wiki's reads of kinds, groups, eyebrows and hints: the built-in kind
  table, id prefixes and stage kind mapping stay where they stand today
  (decision 0021 outcome 3, madarch-d7v3); this change removes none of them.
- The lifecycle commands' move to madarch's own code and the vendored
  program's leaving (outcome 2, madarch-x73l): `src/product/manifest.ts` and
  `src/product/program.ts` read as they read today.
- The set's writing of the registry at setup: the set's own work (outcome 7,
  madarch-d3yt, in the set's repository).
- `madarch list`/`serve` reading the registry: their refusals stay the
  vendored program's words; the contract's check command is the reading
  surface this change lands.

## Rationale
Decision 0021 gives madarch "madarch knows the mechanism, not the kinds".
The contract takes 0016's pattern for the model contract — a TypeBox source,
a published schema at `schema/`, a freshness test, and a check command in
CI — and the set's own fixtures pattern for the refusal cases
(`vendor/shady2k-skills/0.94.0/fixtures/workspace/cases.json`, read here for
its style, untouched). The check command lands beside `views:check` in
package.json and CI because both stand after the tests as whole-product
readings of shipped data.

## Changes to requirements
- product-repository/contract (new): the published, versioned JSON schemas
  of the product kinds registry and its stage list
  (`schema/product-registry.schema.json`) and of the generic document
  fields (`schema/product-document.schema.json`), generated beside the
  model schemas' sources; the readings with their own refusals (each naming
  the file, the line and the field's path); and `bun run contract:check`
  running the repository's conformance examples — two conforming example
  products (one without a registry, one with it), every registry refusal
  case and every document-field case, each with its printed words — in CI.

## Preserved contracts
- product-repository/draft: test
- product-repository/manifest: test
- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- intended-model/schema: test
- intended-model/files: test
- compiled-model/shape: test
- views/view-set: test
- wiki/links: test
- wiki/pages: test

## Coverage
- product-repository/contract: test
- product-repository/draft: test
- product-repository/manifest: test
- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- intended-model/schema: test
- intended-model/files: test
- compiled-model/shape: test
- views/view-set: test
- wiki/links: test
- wiki/pages: test
