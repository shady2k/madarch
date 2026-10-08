# Describe use cases and data entities in the model, traced to requirements

Change: use-cases-data-entities
Base: 123b2e8d580bacd326da55da5f51afcc48d99416
Tasks: madarch-hnq.1.1, madarch-hnq.1.2, madarch-hnq.1.3, madarch-hnq.1.4, madarch-hnq.1.5, madarch-hnq.2.1, madarch-hnq.2.2, madarch-hnq.2.3
Kind: behavior

## Intent
Today a model says which parts exist and how they depend on each other, and a
transfer names only coarse data categories. Nothing says how a use case runs
through the parts, which requirement it realises, or which pieces of data
(a session id, a user's name) cross a relation. After this change a model
declares data entities with their classification and use cases as scenarios
whose steps follow the model's relations and name the requirements they
realise; the model check refuses a scenario whose relation or requirement is
gone. This is outcome 2 of the knowledge-base charter: the product wiki's
use-case pages, data catalogue and backlinks (outcome 3) are built on it.

Stories:
- As a security engineer, I see that the login topic carries the session id
(communications secrecy) and the user's name (personal data), not only
"personal".
- As an analyst, I write the use case "place an order" once, as steps over
the model, and name the requirement it realises; the check tells me when a
step's relation or the requirement disappears.
- As an engineer on a legacy repository, I may leave an entity's
classification unstated for now: the model still loads and the gap is
reported as a warning, while `categories: []` records that I checked and
found nothing sensitive.

## Out of scope
- A scenario's status by evidence (planned, partly built, built), sequence
diagrams, the data catalogue and backlinks: the wiki's outcome 3
(madarch-1ui).
- Links from steps to symbols in code: the code index, outcome 4 (madarch-mv2).
- Rules over classifications and zones; data flow inside code.
- Scenarios across several repositories.
- Finding requirements at paths other than `docs/system/capabilities/`: the
document contract's path mapping, outcome 1 (madarch-o3b).
- Changing what the write-intended-model skill asks or writes: authoring moves
to shady2k-skills (decision 0016); only its format reference documents the
new constructs.
- A CI check of madarch's own model: keeping models current from CI is the
`registry` milestone (madarch-tah).

## Rationale
Decision 0016 (2026-10-08) makes madarch the product's knowledge base and
writes use cases as scenarios over the model, so that their diagrams, data
flows, status and backlinks are computed rather than written. The format
choices below were accepted by the owner at the preflight of madarch-hnq on
2026-10-08 ("Пока здесь, делай").

## Changes to requirements
- intended-model/entities (new): data entities with a classification from the
model's categories; `categories: []` is an answer, a missing list a warning.
- intended-model/scenarios (new): scenarios with an actor, requirements,
ordered steps over relations and alternatives starting at a main-flow step.
- intended-model/transfers (replaced): a transfer names categories, entities
or both; its categories include those of its entities.
- intended-model/ids, intended-model/references, intended-model/evidence
(replaced): the new kinds have unique ids, their references resolve, an
entity may carry evidence.
- compiled-model/shape (replaced): the compiled model holds entities and
scenarios, and each transfer its entities and combined categories.
- model-check/requirements-resolve (new): every requirement a scenario names
exists as a heading in the repository's capability specs.
- model-check/evidence-resolves (replaced): a data entity's evidence, when
given, is resolved like any other item.
- model-check/staleness (replaced): a data entity's evidence item is
reported stale like any other.
- model-history/store-version (replaced): the history records a source's data
entities and scenarios like every other assertion; the enumeration of what it
records names them.

## Preserved contracts
- intended-model/schema: unchanged; the new fields are part of the published schema and refused when misspelt like any other, and models written before this change still load; their compiled form may differ (transfer categories sorted by code point, entities and scenarios always present), accepted by the owner on 2026-10-08 since no stored model exists (greenfield).
- intended-model/files: unchanged; entities and scenarios may be split across the folder's files like everything else.
- intended-model/strict-yaml: unchanged for the new constructs.
- compiled-model/deterministic: entities and scenarios are ordered by id, steps and alternatives as written; the same model compiles to the same bytes.
- model-check/evidence-complete: still asks evidence of elements, interfaces and relations only; a scenario's steps stand on relations that have it.
- views/view-set: the pages are those the compiled model gives; a transfer's categories, its entities' included and sorted by code point, show as categories do today, and the committed reference-system views are regenerated.
- wiki/pages: unchanged; the wiki shows neither entities nor scenarios until outcome 3.
- model-history/lossless: a compiled model holding data entities and scenarios reads back as compiled (madarch-hnq.1.4).

## Coverage
- intended-model/entities: test, use-cases-data-entities
- intended-model/scenarios: test, use-cases-data-entities
- intended-model/transfers: test, use-cases-data-entities
- intended-model/ids: test
- intended-model/schema: test
- intended-model/files: test
- intended-model/strict-yaml: test
- intended-model/references: test
- intended-model/evidence: test
- compiled-model/shape: test, use-cases-data-entities
- compiled-model/deterministic: test
- model-check/requirements-resolve: test, use-cases-data-entities
- model-history/store-version: test
- model-check/evidence-complete: test
- model-check/evidence-resolves: test
- model-check/staleness: test
- views/view-set: test
- wiki/pages: test
- model-history/lossless: test

## Blocking questions
None.

## Design and decisions

Format, accepted at the preflight (2026-10-08):

```yaml
categories:
  - { id: personal, name: Personal data }
  - { id: communications-secrecy, name: Communications secrecy }
entities:
  - id: session-id
    name: Session id
    categories: [communications-secrecy]
  - id: order-number
    name: Order number
    categories: []          # checked: of no category
relations:
  - id: auth-publishes-login
    transfers:
      - direction: forward
        confidentiality: confidential
        entities: [session-id, user-name]
scenarios:
  - id: place-order
    name: Place an order
    description: A signed-in customer orders the cart's contents.
    actor: customer
    requirements: [ordering/place-order]
    steps:
      - { id: s1, relation: checkout-places-order }
      - { id: s2, relation: orders-publishes-placed, name: the order is announced }
    alternatives:
      - id: card-declined
        at: s2
        when: the payment is declined
        steps:
          - { id: d1, relation: checkout-shows-error }
```

- Classification reuses the model's data categories; there is no second
vocabulary. A transfer's compiled categories are the union of its own and its
entities', sorted by code point.
- An entity without `categories` is a warning, not a refusal, so a legacy
repository's model loads while its gaps are open; outcome 3 turns these
warnings into open questions.
- A step names a relation at any level; a scenario written early over coarse
relations stays valid when they are refined.
- An alternative replaces the main flow from the step it starts at; rejoining
the main flow is not expressed in this change.
- Requirement ids are `capability/requirement`, the form change records
already use; the loader checks only their form, the model check their
existence, at `docs/system/capabilities/<capability>.md`, by a heading
`## Requirement: <id>` followed by the end of the line, a space or ` — `.
- Every error and warning names the model file and line, as the rest of the
format does; the JSON report of the check carries the same fields.
- madarch gets its own model in `madarch/` at the repository root, written by
the write-intended-model skill on its own checkout, with three to five main
scenarios; the reference system gains data entities. Both are where outcomes
3 and 4 will be checked.

Owner's architecture decision of the same day, recorded on madarch-o3b and
madarch-yhy: the contract file in each repository holds no graph; the madarch
engine with LadybugDB is installed once per machine; the server is optional.

## Acceptance evidence
Recorded on the change's tasks as `check:` comments and in the stages'
acceptance records.

## DONE WHEN
madarch's own model describes its main use cases as scenarios and the
reference system's model its data entities; removing a relation a step stands
on makes the model check name the broken scenario and step; an entity a
transfer names without a classification, or a scenario naming an unknown
requirement, is reported by the check with its file and line. Where it is
seen: `bun scripts/check-model.ts <repository>` run from a checkout of
madarch, on madarch's own checkout and on fixtures, its printed report and
`--json`, and the compiled `model.json` holding the entities and scenarios.
