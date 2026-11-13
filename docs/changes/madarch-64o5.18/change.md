# Role-based facts on the product home

Change: madarch-64o5.18
Base: 568bc3cf
Tasks: madarch-64o5.18
Kind: behavior

## Intent
A kind declares its audience and deterministic graph aggregates in its own YAML file.
The filled home shows the reader role's facts in manifest order. Every fact opens
through the statement path with its aggregate and population as ground.

## Out of scope
- Agent conclusions and their system prompt (madarch-stm0.10).
- Purpose-based sidebar (madarch-64o5.19).
- Persisting computed facts as authored opinions or inventing a new statement kind.

## Changes to requirements
- product-wiki/role-facts-home: kind contracts declare audience and facts; the engine computes them and the home assembles them.

Complete proposed capability: `capabilities/product-wiki.md`.

## Preserved contracts
- product-wiki/pages: entity pages and the existing sentence/ground statement path remain reachable.

## Coverage
- product-wiki/role-facts-home: static, test, mutation, review

## Where it is seen
Kind: screen
Place: The home of a filled product with the developer role selected
Mockup: docs/changes/madarch-64o5.18/home.md

1. Fill a product declaring code.file.
2. Choose developer and open its home: count, language, folder, age, largest and most changed are facts.
3. Open a fact statement and inspect its aggregate ground and complete population.
4. Choose another role: its declarations supply the home, in manifest order.
5. Edit a fact label in the kind file and refresh after manifest publication.

## Blocking questions
None.
