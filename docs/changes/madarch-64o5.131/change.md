# One fill control in the top bar

Change: madarch-64o5.131
Base: 39bf4ae12863dc42f0808cf0641d042f1e8d71b9
Tasks: madarch-64o5.131
Kind: behavior

## Intent
The top bar has one fill control: while a fill runs it is the run's state, naming how many units are published and
opening the run; otherwise it is «Заполнить…». The two never stand together, and a run's start or end switches the one
control without a page reload.

## Rationale
Owner, 2026-11-15: «Зачем здесь две кнопки заполнения?» The old frame rendered `FillEntry` always and `RunIndicator`
beside it while a fill ran, so a person saw two places to press for one thing.

## Out of scope
- The contents of the runs page and the run's own page; this change only chooses the one top-bar control.
- The sidebar's «Запуски» link, which stays the way to the history when no run is live.

## Changes to requirements
- product-wiki/top-bar-fill: add. One control, the run's state while it runs, «Заполнить…» otherwise, never both, and a
  switch without reload.

## Preserved contracts
- product-wiki/shell: the top bar keeps its search, refresh, role and language controls, and the run control stays a kit Button (static test)
- product-wiki/internationalization: the run words remain in English and Russian (test)

## Coverage
- product-wiki/top-bar-fill: static test mutation review
- product-wiki/shell: static test mutation review
- product-wiki/internationalization: static test

## Where it is seen
Kind: screen
Place: any page of a served product, in the top bar
Mockup: docs/prototypes/top-bar-running.png

1. Open a product with no live fill: the top bar has one «Заполнить…» control.
2. While a fill runs, the same place says «Идёт заполнение · 3 из 5» and opens the run; no second fill control stands beside it.
3. When the run ends, the same open page shows «Заполнить…» again without a reload.

## Blocking questions
None.

## Design and decisions
`RunIndicator` is the one component: it reads `/api/status` and the live run, and renders the run control while the fill
goes and `FillEntry` otherwise. The frame renders it alone; `FillEntry` is no longer mounted beside it. A status or run
change reloads the shared read through the change stream, and a live run asks every second, so the switch lands in the
mounted page.

## Acceptance evidence
Static: `bun run check` passed; the wiki app's `bun run check` passed.
Test: `run-indicator.test.tsx` 2 passed (never both; one mounted page switches from the run to the fill entry after the
status read); the app suite 122 passed, 0 failed.
Screens: `docs/changes/madarch-64o5.131/mockups/` holds the idle and running control at 1440 and 390, light and dark,
in English and Russian; their text and geometry were read: one control in each state, no first-visit role dialog, and the
page's scroll width equals its viewport.
Mutation: not run, filed per the stage rule.
Review: pending; this record is for the review.

## DONE WHEN
Every page shows one fill control; while a fill runs it names the run's progress and opens it; otherwise it is
«Заполнить…»; a run's start or end switches it in place.
