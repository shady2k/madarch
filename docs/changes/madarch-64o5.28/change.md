# Declaration-driven plugin fill

Change: madarch-64o5.28
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.28
Kind: behavior

## Intent

Use the kind and plugin declarations in contract.md to select and order fill
work, detect conflicts before startup and retain source-preserving refinements.

## Out of scope

Drafting derives-from for the starter catalogue; real agent or model execution.

## Rationale

The owner requires every kind to have agent filling and plugins to declare
inputs and outputs, not engine classifications or numeric stage ordering.

## Coverage

- fill-stages/plugin-declarations: test static review

## Where it is seen

Kind: command
Place: madarch fill --entity document.summary --agent scripted --token-cap 1000

1. Select a kind in the CLI or wiki fill page.
2. Review its prerequisites and named producers.
3. Start the fill, or read a refusal naming the declaration file and line.
4. Read the final refined page with its preserved sources.

## Blocking questions

None.
