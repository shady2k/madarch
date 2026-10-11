# The agent describes each connected repository: the model and its evidence, the architecture page, the derived requirements and decisions, shown in the wiki

Change: wiki-describe-repos
Base: 36aeb263c60c918c0364f810b0f8a6d63d240867
Tasks: madarch-iuc.17
Kind: behavior

## Intent
The owner's variant 2 (2026-10-11 ~16:40 MSK, note-two-paths.md): an engineer
creates a product, connects the repositories they already have with
`madarch repo add`, and gets everything variant 1 gives. Today the connected
repositories sit under `repos/` as code and the wiki shows none of them: the
engineer has no step that turns a connected repository into the artifacts the
wiki shows. After this change the engineer asks the agent to describe each
repository; the product's own instructions (its `AGENTS.md`) and the skill
the product skeleton carries say how: the repository's intended model with
its evidence written into the repository's own `madarch/` folder, the
architecture page under the product's `docs/`, the capabilities found in the
code as requirements and use cases marked derived from code, the decisions
found in the code or its ADRs, each linked to the model elements it shapes —
and every page appears in the wiki as it is saved, through the serving the
product already has.

Stories:
- As the engineer who connected three repositories, I ask the agent to
  describe each one and the wiki then shows its model-backed architecture
  page, its derived requirements and use cases, and its decisions.
- As a reader of a derived requirement, I follow its evidence to the exact
  file and lines of the repository it was read from.
- As the second engineer who cloned the product, `madarch bootstrap` brings
  the repositories home and every description stands, the links between the
  pages intact.

## Out of scope
Serving the repositories' own files as wiki pages, and any server or app
change: the wiki reads `docs/` and `README.md` only, and showing the
repositories' `madarch/` models and views in the wiki is the diagrams work
(madarch-iuc.14, E's server side), not this change; the commands themselves
(`madarch repo add` and its siblings, the onboarding run's feature
madarch-525o, read and never changed here); running the description without
an agent; the repository tasks read from a tracker export (feature D);
translating the descriptions.

## Changes to requirements
- product-repository/describe-step (new): the skeleton's `AGENTS.md` carries
  the step that says what describing a connected repository is — the model
  with its evidence in the repository's own `madarch/` folder, the
  architecture page, the capabilities found in the code as requirements and
  use cases marked derived from code, the decisions found in the code or its
  ADRs — and names the product's own skill that carries the procedure, so an
  agent reading the product's constitution knows the step exists before it
  is asked.
- product-repository/describe-skill (new): a new product's `skills/` folder
  holds the product's own describe-repository skill, whose procedure is the
  four artifacts above, every statement traceable to a file and line, the
  model written through the model-writing machinery madarch pins (the
  set's `write-intended-model` procedure and the model check run from a
  madarch checkout), finishing on a passing check and the product's document
  check.
- product-wiki/describe-guide (new): the engineer's guide to starting a
  product from existing repositories carries the describing step: after
  `madarch repo add`, ask the agent to describe each repository, with what
  lands where and what the wiki shows.

## Preserved contracts
- product-repository/draft: test
- product-repository/manifest: test
- product-repository/list: test
- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test

## Coverage
- product-repository/describe-step: test
- product-repository/describe-skill: test, browser-walk
- product-repository/draft: test
- product-repository/manifest: test
- product-repository/list: test
- product-wiki/describe-guide: test, browser-walk
- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test

## Blocking questions
None.

## Design and decisions
- Nothing in the product's creation moves. The skeleton is the pinned
  program's byte for byte (decision 0019); the describing step lands in the
  two places a product's own writing lives, `AGENTS.md` and `skills/`, and
  this change carries both texts — the `AGENTS.md` step as the wording an
  engineer or the set's program puts under the maintained part, the skill as
  the product's own skill folder — because madarch does not own a product's
  constitution once the program has written it (decision 0019: the set owns
  the forms, madarch the wiki).
- The model is written through the machinery madarch already pins: the
  set's `write-intended-model` procedure (the claims ledger, the evidence
  rules, the review report) and the model check run from a madarch checkout.
  The model lands in the repository's own `madarch/` folder — the layout the
  diagrams work (E) serves later from `repos/<name>/madarch`, this change
  adds no second shape for it and no server work.
- The wiki's part is already there: the pages a description writes are
  Markdown under the product's `docs/`, so serving, live update and the
  reading shell show them with no new server code. The walker's scope stays
  `docs/` and `README.md`; the repositories' own files are not pages, and
  this change does not widen it.
- Derived requirements and use cases are the set's document forms, marked
  derived from code in two places the set's own check accepts (decision
  0019: the set owns the forms, and its check refuses a field it does not
  know): the title carries the mark — `... (derived from code)` — and the
  document's `## Sources` section carries the provenance lines `Source:
  code` and `Evidence:` naming the files and lines. The lines are data a
  reader follows, not new document kinds; every statement carries its own
  file-and-line citation beside it, and a description keeps the product's
  own id numbering.
- Decisions found in the code or the repository's ADRs are MADR records
  under `docs/repositories/<name>/decisions/`, each naming the model ids it
  shapes, so a later viewer can lay a record on the model's pages; the ids
  are the same ones the review report and the model use.
- The guide's step extends the onboarding run's guide (their file, their
  commands untouched): a new section before the where-resolution section,
  naming what to ask the agent and what lands where.

## Acceptance evidence
Recorded on the change's tasks as `check:` comments: the tests, the
mutation sample of the changed ranges, and the browser walk of the described
repository's pages in both themes at 1000 and 1440, both languages, on the
fixture product with a small repository described by the skill itself.

## DONE WHEN
On a fixture product holding one small real repository entered by
`madarch repo add`'s step (the manifest entry and the checkout), the
describe-repository skill run by an agent produces: the repository's
`madarch/` model with a passing model check, an architecture page under
`docs/repositories/<name>/`, at least one requirement and one use case
marked derived from code with file-and-line evidence, and one decision
record linked to a model id; the wiki shows every page in both languages; the
skeleton's `AGENTS.md` names the step and the skill; the guide carries the
describing step; nothing under the real products home was touched, and no
server or app code moved.
