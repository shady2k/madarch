# Reader chrome without dead controls

Change: wiki-chrome-gj94
Base: 986ee65a532e548ea68d7d3ed897065f6d52b3f5
Tasks: madarch-gj94
Kind: behavior

## Intent
Remove the inert tab strip and bottom status strip from the reading shell, avoid repeating a document heading in the top bar, and keep the product card visibly passive. Readers navigate between one page at a time through links, browser history, and the sidebar.

## Rationale
The owner decided to remove the tabs and avoid a repeated title (comments 2486/2488: “Убирай”; one document on screen; the top bar does not repeat the title). The owner also approved either a working products-home switcher or no chevron on the Fieldnote product card (comment 2518); the existing card is passive, so the no-chevron/no-disclosure option is the bounded choice.

## Out of scope
- Multi-document tabs or split views.
- A product switcher; the product card remains a noninteractive label.
- Changing status data producers in `app.tsx` or behavior in `app.test.ts`.
- Changes in files owned by XQ0V.

## Changes to requirements
- Replace `product-wiki/shell` with the complete proposed requirement in `capabilities/product-wiki.md`. It removes tab-strip and status-strip contracts, states that the document title is not repeated in the top bar, and pins passive product-card chrome.

## Preserved contracts
- product-wiki/pages: links between wiki pages continue to navigate to one page at a time through the existing routes and browser history.

## Coverage
- product-wiki/pages: test
- product-wiki/shell: test

## Blocking questions
None.

## Design and decisions
Use the no-switcher option already supported by the noninteractive product block. Remove the status footer and tab row from the shell. Keep the category context in the toolbar but omit the document title; the reader sees the title once in the document heading. XQ0V-owned app and locale files remain untouched.

## Acceptance evidence
- Shell-only tests: `cd wiki/app && bun test src/shell.styles.test.ts` — exit 0 (14 passed).
- Reader E2E: `MADARCH_WIKI_E2E=1 MADARCH_WIKI_SCREENSHOT=/tmp/madarch-gj94-reader.png bun test test/wiki-chrome-e2e.test.ts` — exit 0 (1 passed, 10 assertions); screenshot rendered and inspected outside the repository at `/tmp/madarch-gj94-reader.png` (1150×900).
- Static/build: `cd wiki/app && bun run check` — exit 0; `cd wiki/app && bun run build` — exit 0; root `bun run check` — exit 0.
- Root tests: `MADARCH_SKIP_PERF=1 bun test test/` — exit 0 (1677 passed, 45 skipped).
- Full wiki-app suite is pending the authorized update of stale chrome assertions in `app.test.ts` after XQ0V's change lands; the earlier suite run exited 1 on those assertions. It must be rerun before this task is handed off as accepted.

## DONE WHEN
The browser-rendered reader view has no tab strip, no repeated document title, no Fieldnote disclosure affordance, and no dead bottom status strip; a disjoint reader E2E test asserts these facts and captures a screenshot outside the repository.
