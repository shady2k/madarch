# Clarify illustrative paths in capability examples

Change: madarch-8nfh-example-paths
Base: 195aaff555992397e802e522dc136d592662c088
Tasks: madarch-8nfh
Kind: behavior

## Intent
Clarify that eight paths in product capability examples are illustrative examples, not paths in the Madarch repository. This wording-only capability update changes no product runtime behavior and leaves all scenario outcomes unchanged. The separate `docs/completeness.json` reference and the examples assigned to madarch-hsz5 remain out of scope.

## Out of scope
Changing product behavior, the present-document checker or its configuration; changing the madarch-hsz5 scope.

## Changes to requirements
- product-repository/describe-step: clarify the product example directory path.
- product-repository/describe-skill: label the architecture-page path as an example.
- product-wiki/architecture: label the repository checkout path as an example.
- product-wiki/repositories: label checkout paths as examples.
- product-wiki/describe-guide: label the repository description path as an example.

## Preserved contracts
None.

## Coverage
- product-repository/describe-step: test
- product-repository/describe-skill: test
- product-wiki/architecture: test
- product-wiki/repositories: test
- product-wiki/describe-guide: test
