# Split the starter catalogue into kind files

Change: madarch-64o5.17
Base: 9bdeee934090fb23e72530d19fa343d0a369b926
Tasks: madarch-64o5.17
Kind: behavior

## Intent
Keep each starter kind as data in its group and subgroup folder, ship the catalogue offline, and use the same layout for a product's declarations. Preserve the catalogue's definitions and sources.

## Out of scope
New kind definitions, changes to graph semantics, and migration of an outside product repository in this change record.

## Preserved contracts
- product-repository/manifest: the product's identity and workspace manifest remain unchanged.

## Coverage
- product-repository/contract: static test review
- product-repository/manifest: static test review

## Where it is seen
Kind: command
Place: `madarch init` and the product catalogue
1. Initialize a product from a starter template.
2. Inspect its `madarch/kinds/` folder and open the catalogue.
3. Try a product with only `madarch/kinds.yaml`; the refusal names the new layout.

## Blocking questions
None.
