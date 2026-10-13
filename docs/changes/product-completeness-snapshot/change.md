# Product-owned wiki declarations and completeness snapshot

Change: product-completeness-snapshot
Base: 7eb40afd3d57f559ff97b0f117882f8629414151
Tasks: madarch-d7v3.2
Kind: behavior

## Intent
The engine currently embeds parts of the skill set's product vocabulary and
workflow in question parsing, audience lookup, stage defaults, expected records
and navigation. Move those declarations to each product's `docs/kinds.yaml`.
The skill set computes completeness once and commits the result under the
product's `docs/` directory. Madarch validates and renders only that snapshot,
including its localized computation date; it does not recalculate or compare
it with current content.

What users can do after this change: configure their stages, question form and
overview audience source in their own registry, and see the completeness
snapshot the skill set computed for a named product revision. A product without
a registry has no built-in stages, and a product without a snapshot has no
completeness findings.

The owner's approval is recorded in task comments 2522, 2524 and 2525. Comment
2522 says the skill set computes completeness and the engine only displays it;
comments 2524–2525 settle the committed snapshot, computation date, source
revision and localized “as of” display.

## Out of scope
- The skill-set-side writer (`skills-product-completeness-niv6`).
- The empty-folder/no-manifest instruction tracked by madarch-kyi6.
- The independent madarch-0n3p task and any edits it makes in its worktree.

## Changes to requirements
- product-wiki/stages (replaced): the manifest owns stage order and expected
  records; completeness comes only from the committed snapshot. The engine
  displays the snapshot date and findings, and absence means no findings.
- product-wiki/questions-and-overview (added): question identity, fields and
  sections, and the overview audience source are manifest data. The sidebar
  does not carry a built-in Open questions entry.

## Preserved contracts
- product-wiki/pages: test — page enumeration and read-only behavior remain.
- product-wiki/front-matter: test — declared document kinds, links and status findings remain registry-driven.
- product-wiki/live: test — registry and snapshot changes update the live view.
- product-wiki/internationalization: test — chrome remains English/Russian; snapshot dates use the selected locale.

## Coverage
- product-wiki/pages: test
- product-wiki/front-matter: test
- product-wiki/stages: test
- product-wiki/questions-and-overview: test
- product-wiki/live: test
- product-wiki/internationalization: test

## Blocking questions
None.

## Design and decisions
See `design.md`. The schema and cases follow the existing product-registry
contract pattern. The manifest additions remain optional in contract v1; the
snapshot is independently versioned as contract v1.
