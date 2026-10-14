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
- Reader E2E (real server and Chromium, 1150×900): English `MADARCH_WIKI_E2E=1 MADARCH_WIKI_LANGUAGE=en MADARCH_WIKI_SCREENSHOT=/tmp/madarch-gj94-reader-en.png bun test test/wiki-chrome-e2e.test.ts` — exit 0 (1 passed, 9 assertions); Russian `MADARCH_WIKI_E2E=1 MADARCH_WIKI_LANGUAGE=ru MADARCH_WIKI_SCREENSHOT=/tmp/madarch-gj94-reader-ru.png bun test test/wiki-chrome-e2e.test.ts` — exit 0 (1 passed, 9 assertions). Both fresh screenshots were visually inspected outside the repository.
- App checks: `cd wiki/app && bun install --frozen-lockfile && bun run check && bun test && bun run build` — exit 0; app suite: 150 passed, 0 failed. `cd wiki/app && bun test src/shell.styles.test.ts` — exit 0 (14 passed).
- Root static check: `bun run check` — exit 0. The full root test suite was not rerun for this follow-up.
- Feature-document gate after rebase: `node .shady2k/documents.mjs check --phase feature --change wiki-chrome-gj94 --candidate worktree --target origin/main` — exit 0, clean.
- Independent gpt-6-luna review found one breadcrumb-context defect; it was fixed, and the second review reported no findings.

## DONE WHEN
The browser-rendered reader view has no tab strip, no repeated document title, no Fieldnote disclosure affordance, and no dead bottom status strip; a disjoint reader E2E test asserts these facts and captures a screenshot outside the repository.
