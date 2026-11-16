# A problem's actions look like buttons, and a row shows it can be opened

Change: madarch-64o5.93
Base: 39bf4ae12863dc42f0808cf0641d042f1e8d71b9
Tasks: madarch-64o5.93
Kind: no-behavior

## Intent
The owner asked for the page's actions to look like actions («Не проблема», «Создать задачу» and the
rest were plain text) and for a problem row to show that it opens. Every action is now the kit's one
Button, the section filter is the kit's segmented choice, and each row is a disclosure whose summary
names the rule, the severity, what it needs and the place, with the sentence, evidence and actions
inside.

## Out of scope
- The kit's own reduction to one Button style, which madarch-64o5.127 owns; this change passes no
  variant the kit does not already have.
- New components or local variants.

## Rationale
An action drawn as text is not found by the reader who needs it, and a row that opens without a marker
is read as a dead list. The kit already holds the Button and the segmented choice; the page uses them.

## Changes to requirements
None. The change realizes the existing presentation of the app on the kit.

## Preserved contracts
- product-wiki/internationalization: every new label («Раздел», «Нужна правка кода») is in both catalogues (test)
- product-wiki/reading-typography: the controls read on the shared design tokens, drawn by the kit's components alone (static)

## Coverage
- product-wiki/internationalization: static test
- product-wiki/reading-typography: static test

## Where it is seen
Kind: screen
Place: a served product's Problems page at `/p/problems`, 1440 and 390 px wide, light and dark
Mockup: docs/changes/madarch-64o5.93/problems-390-light.png

1. Open the Problems page: the section filter is one segmented control; every action is a button, and none is bare text.
2. A row shows a disclosure marker; opening it shows the sentence, the evidence, the file and line, and the two actions.
3. At 390 px the summary wraps inside the column and nothing runs past its edge.

## Blocking questions
None.

## Design and decisions
Each row is `Disclosure`/`DisclosureSummary` from the kit, with the summary carrying the rule, the four
badges and the place as `InlineCode`; the actions stay inside the body. The filters are `SegmentedChoice`
so the active section reads without a second Button variant. No action passes `variant`.

## Acceptance evidence
Static: `bun run check` and the wiki app's `bun run check` passed.
Test: the app's Problems page test presses the actions, reads the marker, and passes at both languages.
Mutation: not made; filed per the stage rule.
Review: pending; this record is for the review.

## DONE WHEN
Every action of the page is a kit Button, the filter is the kit's segmented choice, and a row shows it
opens at 1440 and 390 px.
