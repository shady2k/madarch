# A problem's sentence is the reader's, built from a code the server sends

Change: madarch-64o5.92
Base: 39bf4ae12863dc42f0808cf0641d042f1e8d71b9
Tasks: madarch-64o5.92
Kind: no-behavior

## Intent
The owner read «.shady2k/checks/check-product.mjs is 674 lines long…» on his Russian Problems page. Every
problem the engine makes now carries a code and its values, and the page says the sentence from its
locales: the reason of a code rule, a broken link, a ground that is gone, an answer that reaches no page,
a consistency finding, and a check's note. The engine stores no English sentence for the page to show.

## Out of scope
- The words a check itself writes (a manifest finding's message): those are the check's own data and the
  page shows them inside a localized sentence («Проверка сообщила: …»), never as the engine's sentence.
- The wording of problem tasks' titles and bodies, which already come from the rule's words.
- A locale for a third language.

## Rationale
A visible string belongs to the reader's catalogue (product-wiki/internationalization); an English
sentence in the engine made one language the product's. A code with values keeps the engine's data
language-free, lets the page inflect counts in Russian, and makes a missing translation a finding the
app's tests catch instead of a silent English line.

## Changes to requirements
None. The change realizes the existing internationalization requirement's rule that every app-owned
visible string uses the selected catalogue.

## Preserved contracts
- product-wiki/internationalization: every visible string of the page is said from the English and Russian catalogues, and a code the engine can send has both (test)
- product-wiki/app: the page is still served by madarch's own app from the same route and reads the same listing answer (static)

## Coverage
- product-wiki/internationalization: static test
- product-wiki/app: static test

## Where it is seen
Kind: screen
Place: a served product's Problems page at `/p/problems`, in Russian and in English
Mockup: docs/changes/madarch-64o5.92/problems-1440-light.png

1. Open a product with a file over the manifest's line threshold on `/p/problems`: the row's sentence reads «src/big.ts: 674 строки при пороге 600 — в одном модуле слишком много, чтобы менять его безопасно.» in Russian and its English words in English.
2. Switch the language: the same problems say their sentences in the other language, and no English sentence of the engine stands on the Russian page.
3. Read a broken link's and an answer's problem: «В графе нет «payments».» and «Ни одна страница продукта не рассказывает о …».

## Blocking questions
None.

## Design and decisions
`ProblemText {code, args}` replaces the English `reason` (and its textKey/textArgs fallback) in the
engine's problem drafts and in the loop's rows. `PROBLEM_TEXT_CODES` in `src/problems/types.ts` is the
one list of sentences the page can say; the engine's code strings are typed with it, and the app's
i18n test reads both catalogues for every code. The app says `loop.problemText.<code>` with its values,
`defaultValue: ''`, so a missing translation is blank rather than a key — and the test refuses a blank.
The secret-configuration sentences no longer print the secret's literal value, only where it stands.

## Acceptance evidence
Static: `bun run check` passed (tsc, architecture, UI, catalog, workflows, quarantine).
Test: `test/problems-rules.test.ts`, `problems-findings`, `problems-wiki`, `problems-manifest`,
`problems-dismissal`, `problem-task`, `plugin-partial-problems`, `loop-entities` passed; the app's
`bun test` passed including the new per-code locale test and the page's Russian sentences.
Mutation: not made; filed per the stage rule.
Review: pending; this record is for the review.

## DONE WHEN
No problem row shows a sentence the engine wrote in English: every problem's text is a code with its
values, and both catalogues hold a sentence for every code the engine sends.
