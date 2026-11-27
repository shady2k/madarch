# Prepare a selected fill before choosing its agent

Change: madarch-64o5.123
Base: 16d0caf41f5914df258c15dbb1c30e91f2e0b11b
Tasks: madarch-64o5.123
Kind: no-behavior

## Intent

Let a catalogue selection reach preparation without a saved agent. Show which kinds and fields a plugins-only fill leaves empty. Give disabled buttons a visible, localized explanation and an accessible description.

## Out of scope

The existing fill planner owns producer declarations and execution order.

## Rationale

The preparation page owns the run's agent choice. A plan warning in the catalogue could prevent the reader from reaching that choice. The plan exposes which kinds rely entirely on the agent so the preparation page can distinguish them from kinds with individual unfilled fields.

## Preserved contracts

- fill-orchestrator/plan: the plan still identifies the units to run from the declared producers and selected mode.
- fill-stages/starvation: preparation still reports errors for missing producers and names the work left unfilled.
- product-wiki/internationalization: new button explanations and fill summaries are available in English and Russian.

## Coverage

- fill-orchestrator/plan: static test
- fill-stages/starvation: static test
- product-wiki/internationalization: static test

## Where it is seen

Kind: screen
Place: the catalogue at `/p/catalogue` and the preparation page at `/p/prepare`
Mockup: docs/changes/madarch-64o5.133/catalogue-1440-light.png

1. Enter catalogue selection mode without a saved agent. The disabled preparation button asks for a selection.
2. Select Dependency cycles. The preparation button opens the next page and agent-only kinds carry an agent label.
3. Choose Plugins only. The open list names the kinds and fields that will stay empty. Choose an available agent to run the full plan.
