# The lifecycle commands are madarch's own code; the vendored skill-set program leaves

Change: standalone-lifecycle
Base: 7f316ae72b4ce74bc75c6c6a8a442aa417a28b6f
Tasks: madarch-x73l.1
Kind: behavior

## Intent
Decision 0021 item (b): the lifecycle commands are madarch's code, revising
the clause of 0019 that gave them to the skill set and pinned its vendored
release. `madarch new`, `rename`, `repo add`, `bootstrap`, `remote` and
`clone` create and change product folders by madarch's own modules
(`src/product/manifest.ts` reading and writing the manifest,
`src/product/draft.ts` creating the draft,
`src/product/lifecycle.ts` the rest, `src/product/git.ts` the git runs),
with the refusal words, exit codes and printed fact lines unchanged — the
engineers' surface the guide (docs/guides/start-a-product.md) records. The
vendored folder `vendor/shady2k-skills/` leaves the repository, and the
manifest-layout consumer tests read the contract's schema and conformance
examples (`schema/product-registry.schema.json`, `examples/contract/`) and
fixture folders the tests build themselves, not the set's program fixtures.

What a user can do that they could not before: a person with only this
repository can run `madarch new` and the whole lifecycle — no vendored
release in the checkout decides their product's folder, its words and its
git; the observable answers stay the ones the guide records.

## Out of scope
- The kinds vocabulary in the wiki's code (decision 0021 outcome 3,
  madarch-d7v3): this change touches no kind table, no prefix and no stage
  mapping in `src/product-wiki`, `src/wiki`, `src/server` or `wiki/app`.
- `vendor/archify/` (the wiki's architecture renderer, a different vendored
  component of `src/wiki`, no lifecycle part of it): untouched.
- The skills move (0021 (d), madarch-2j93) and the set's registry writing at
  setup (outcome 7, madarch-d3yt).
- The manifest's published JSON schema (the contract keeps
  `schema/product-registry.schema.json` and
  `schema/product-document.schema.json`; the manifest's own shape is held by
  the reader through its cases, not by a new generated schema).

## Changes to requirements
- product-repository/draft (reworded): the creation is madarch's own code
  (`src/product/draft.ts`), no pinned release involved; the skeleton, the
  constitution and the git history are what the schema version fixes;
  the scenario `same-folder-two-ways` (draft made twice, by the pinned
  program and by the program beside it) ends, because no second program
  exists to run; the scenario `constitution-is-written-once` keeps its
  byte-for-byte pin, held against the constitution `examples/contract/`
  `set-made-product/AGENTS.md` carries and the tests' builds.
- product-repository/manifest (reworded): the reader is madarch's own
  (`src/product/manifest.ts`); the refusal words are the contract's own —
  held by `examples/contract/manifest-cases.json`, which madarch publishes
  as the reader's conformance cases where the set's fixture cases stood;
  the scenario `set-manifest-cases` is renamed `manifest-cases` and the
  scenario `set-made-folder-reads` names the contract's example product
  (`examples/contract/set-made-product/`).
- product-repository/list (wording): "the set's made folder" names the
  contract's example product; the requirement's own behaviour is unchanged.
- product-repository/describe-step (wording): the describing step is carried
  beside the lifecycle's own modules, not "beside the pinned program"; the
  draft stays byte for byte what madarch's creation writes.
- product-repository/contract: no requirement delta of its own (the
  capability's proposal carries the current spec; the contract requirement
  itself is madarch-mr8i's replay). The change record alone extends the
  landed check command: `bun run contract:check` now also runs the manifest
  cases through the reader (`--manifest-cases`, default
  `examples/contract/manifest-cases.json`, beside the registry cases, the
  document-field cases and the example products' folder walk, whose manifest
  each product's reader must read) — the command's own extension without a
  requirement line, recorded here so its receipts and CI line have a text.

## Rationale
Decision 0021: "the lifecycle commands are madarch's code (revising the
clause of 0019 that gave them to the set and pinned the vendored program):
`madarch new`, `rename`, `repo add`, `bootstrap`, `remote`, `clone` and
`list` read and write the contract's own files; the vendored folder leaves
the repository, and the contract's schema and conformance examples take the
manifest-shape tests' place, on 0016's pattern." The lifecycle behavior was
one pinned copy of the set's program; removing that copy keeps the observable
surface (the guide's recorded refusal words, exit codes and fact lines) as
the contract this repository itself holds.

## Preserved contracts
- product-repository/describe-skill: test
- product-wiki/serve: test
- product-wiki/pages: test
- product-wiki/repositories: test
- product-wiki/live: test

## Coverage
- product-repository/draft: test
- product-repository/manifest: test
- product-repository/list: test
- product-repository/describe-step: test
- product-repository/describe-skill: test
- product-wiki/serve: test
- product-wiki/pages: test
- product-wiki/repositories: test
- product-wiki/live: test
