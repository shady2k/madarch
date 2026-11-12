# Stable kind-page filtering

Change: madarch-64o5.37
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.37
Kind: behavior

## Intent
Keep the reader's screen fixed while filtering a kind table, without flashing empty results between queries.

## Out of scope
Changing catalogue queries, result ordering, or relation labels.

## Rationale
Typing and erasing must not flash an empty list or move the reader's screen when the table changes size. The owner reported this on 2026-11-12.

## Preserved contracts
None.

## Coverage
- product-wiki/kind-filter-stability: static, test, mutation, review

## Where it is seen
Kind: screen
Place: `/kind/code.file` in the product wiki
Mockup: docs/changes/madarch-64o5.37/filter-stability.html

1. Scroll to the filter above a long Files table.
2. Type a query, pause for a small or empty result, and erase it.
3. Observe that the filter stays in the same viewport position and existing rows stay visible while replacement results load.

## Acceptance evidence
- Root UI architecture regression: 9 pass, 0 fail, 59 assertions.
- Root `bun run check` passed with the UI implementation and no added architecture debt.
- Browser checks measure the filter input before and after both one-row and zero-row replacements, then erasing to restore 80 rows, at 1150 px and 390 px widths.
- The query pause is 200 ms for both typing and erasing; erasing previously used 0 ms. The viewport reservation has no timing constant.
- Browser setup required missing Chromium system libraries on this machine. Early fixture errors are not counted as behavioral red evidence.
- Browser regression before source edits: both 1150 px and 390 px cases fail because the old rows disappear while the filtered request is pending (`old rows remain pending`, received null). The browser uses scripted HTTP responses; no agent/model runs.
- Wiki app frozen install, type/UI checks and full unit suite passed: 412 pass, 0 fail.
- Targeted manual mutation removed the viewport reservation. All four browser cases failed with 440–510 px movement (allowed maximum 1 px). This is a manual mutation, not a Stryker run; the reservation is restored before final validation.
- Owner approval is not recorded by the agent.

- Final browser run after resuming and restoring all mutations: 4 passed, 0 failed, 68 assertions. At 1150 px the input stayed at y=259.78125 before shrinking, after shrinking and after erasing; at 390 px it stayed at y=260.15625. Both one-row and empty results were checked.
- The browser loads an appended page before filtering. Old rows remain pending; More is disabled pending replacement; a DOM observer rejects any frame combining a new total with old appended rows. Appended rows, metadata, cursor and errors now belong to the exact base listing response.
- Independent final review found no remaining blocker after the pagination correction.
- Pagination mutation removed the listing-identity guard. All four browser cases failed: a one-row replacement still showed two rows, and an empty replacement still showed one appended row. The guard was restored and the app rebuilt.
