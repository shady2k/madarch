# Counts take the language's plural form in the app and in the page files an agent reads

Change: madarch-u3vw.7
Base: fc303d14d354106b1b8d9c1233b4fa8911a0f374
Tasks: madarch-u3vw.7
Kind: no-behavior

## Intent
Counts were written with a fixed label and a separate numeral — `commits: 1`, `files: 1`, a settings row or a journal line that read like a data dump — and Russian counts kept the many-form for every value: `1 коммитов`. The merge writes both sides through one `pluralForm`: the numeral and the word agree in the page's language, so `1 commit`, `2 commits`, `21 коммит`, `11 коммитов`, and a Russian fraction takes the genitive singular — `1.5 коммита`, never `1.5 коммитов`.

The same words reach the app's history bar, history note, catalogue, journal, settings, unit limits, diagrams and treemap, and the page files an agent reads; `PageModel.language` carries the page's language into those files. The app's i18next plural resolver is patched to the shared rule, and a test holds the app's locale words and the page files' words to each other, so changing one side alone fails.

## Out of scope
- Changing which counts the product shows or what they count.
- Adding a language beyond English and Russian, or changing the interface's language other than through the existing setting.
- Adding a new requirement; the internationalization contract already required plural forms.

## Rationale
This is a defect against the internationalization requirement: counts were declared to follow the language's plural rules but were rendered with a fixed form and a separate label. Routing both the app and the page files through one plural rule restores the written behaviour, and the cross-check between the two word lists stops them from drifting again.

## Changes to requirements
None. The internationalization requirement already said that counts and relative times are written in the page's declared language with the language's plural forms; this merge makes the English and Russian counts match it.

## Preserved contracts
- product-wiki/internationalization: in both English and Russian the counts keep their value and their noun, now in the form the language's plural rule selects, and the page files an agent reads use the same words as the app; relative times and the language setting are unchanged.

## Coverage
- product-wiki/internationalization: test

## Where it is seen

Kind: internal
Place: history, catalogue, journal, settings, diagram and treemap counts in the app, and the page files an agent reads
Reason: the change corrects the wording of counts the product already shows; no new screen, command or message is added, and the tests hold the existing surfaces.

1. Open a Russian product's history at one commit, then at two, five, twenty-one and eleven, and read `1 коммит`, `2 коммита`, `5 коммитов`, `21 коммит`, `11 коммитов`.
2. Open the same counts in English and read `1 commit` and `2 commits`; open a page file and see the same words the app draws.
3. Open a Russian count of `1.5` or `1.25` and see the genitive singular («1.5 коммита»), and a count of `0` and see the many-form («0 коммитов»).

## Blocking questions
None.

## Design and decisions
One `pluralForm` reads `Intl.PluralRules` for the language and gives a Russian fraction the `few` form, because CLDR reports `other` for every fraction and Russian writes the genitive singular. The English and Russian word tables live in `history-figures.ts` for page files and in the app's locale files, and `i18n.test.ts` holds the two copies to each other. `PageModel.language` is set from the reader's language or the product's content language and travels into `itemLine`, so a history figure is written where it is rendered rather than as a `kind: value` pair. The app's i18next plural resolver takes its suffix from the same rule, so its count sites select the same form.

## Acceptance evidence
- PR #195 (`96b05588`) changed the history figures, page-file counts and plural rule in `src/knowledge/history-figures.ts`, `src/knowledge/page-files.ts` and `src/knowledge/plural.ts`, carried the language through `src/knowledge/model.ts`, `src/knowledge/product.ts` and `src/knowledge/render.ts`, and changed the app's plural resolver in `wiki/app/src/i18n.ts` and its count sites in `wiki/app/src/knowledge/`.
- `test/page-files.test.ts`, `test/knowledge-server.test.ts`, `wiki/app/src/i18n.test.ts` and `wiki/app/src/knowledge/knowledge.test.tsx` hold the page-file words, the Russian one, few and many forms, the fractional form, the page language and the app's counts.
