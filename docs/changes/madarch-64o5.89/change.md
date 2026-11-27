# Clear or select all shown kinds in the catalogue

Change: madarch-64o5.89
Base: c97952c854b88332398c0d65d0de3f227059e249
Tasks: madarch-64o5.89
Kind: no-behavior

## Intent

Give the catalogue's existing kind selection a one-click reset and a way to choose every kind shown by the current filters. Put both controls beside Show selected and in the bottom bar.

## Rationale

A reader opening the catalogue with the recommended kinds already chosen can clear that selection in one step and use the filters to choose the kinds to fill.

## Out of scope

The fill planner and the layout of the catalogue and preparation pages stay as defined by their existing contracts.

## Preserved contracts

- fill-orchestrator/plan: preparation still sends the explicit selection to the planner, which resolves prerequisites.
- product-wiki/internationalization: the selection controls and empty count use the wiki language.

## Coverage

- fill-orchestrator/plan: test
- product-wiki/internationalization: static test

## Where it is seen

Kind: screen
Place: `/p/catalogue?select=1`
Mockup: docs/changes/madarch-64o5.133/catalogue-1440-light.png

1. Open the catalogue from the first-fill card with the recommended kinds chosen.
2. Filter the catalogue and press Clear selection. The count shows no kinds chosen, the address drops `kinds`, and the preparation control explains that a kind must be chosen.
3. Press Select all while the filter is active. The address and count reflect the kinds shown by the filter.
