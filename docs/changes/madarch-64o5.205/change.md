# Keep the default Problems listing clear before Fill

Change: madarch-64o5.205
Base: b1b9ceb27238dd19806e74929bff643878966f99
Tasks: madarch-64o5.205
Kind: no-behavior

## Intent

A product created from the default template lists zero open problems before Fill. Its Problems page also omits the dependency and operation ownership warnings for that empty graph.

## Rationale

The starter catalogue represents dependency declarations as graph edges. The unused dependency rule needs entities with a `detector-dependency` binding, so the starter catalogue disables the rule. A product that enables the rule still receives a diagnostic if the binding is missing.

Operation ownership matters to route coverage when the rule is enabled and the graph contains both a contract operation and an unserved route. The note stays visible when those inputs exist and the operation binding lacks an ownership relation.

## Out of scope

Changes to the graph model for dependencies and operation ownership, and migration of existing product catalogues.

## Changes to requirements

None.

## Preserved contracts

- model-check/problems: applicable rules still expose findings and diagnostics when they lack the facts they need.

## Coverage

- model-check/problems: test

## Where it is seen

Kind: request
Place: `GET /api/problems` and the Problems page that displays its notes

1. Create a minimal Git checkout and run `madarch init --template everything`.
2. Open Problems before pressing Fill. The listing reports zero problems and shows neither detector warning.

## Blocking questions

None.
