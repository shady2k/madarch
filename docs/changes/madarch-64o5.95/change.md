# A problem says what it needs, not who fixes it

Change: madarch-64o5.95
Base: 39bf4ae12863dc42f0808cf0641d042f1e8d71b9
Tasks: madarch-64o5.95
Kind: no-behavior

## Intent
The owner asked «Исправит человек когда уберем?» of the badge on every code problem. The page now says
what a problem needs — «Нужна правка кода», «Нужна правка документов», «Нужна правка вики» — and the
fixer field is gone from the listing and its categories: people and agents both change code.

## Out of scope
- Who any one problem is assigned to; that is a task's business, opened from the row.
- The escalation of a question to a role, which names a role and not a fixer.

## Rationale
The badge told the reader a person fixes a code finding, while an agent's fill changes code every day,
and it hid what the reader has to do. The section says what has to change; who does it depends on the
work, not on the kind of finding.

## Changes to requirements
None. The change realizes the existing internationalization requirement for the page's words.

## Preserved contracts
- product-wiki/internationalization: the badge's three words are in both catalogues (test)
- product-wiki/app: the page reads the same listing answer, whose rows no longer carry a fixer (static)

## Coverage
- product-wiki/internationalization: static test
- product-wiki/app: static test

## Where it is seen
Kind: screen
Place: a served product's Problems page at `/p/problems`, in Russian and in English
Mockup: docs/changes/madarch-64o5.95/problems-1440-light.png

1. Open a product with a code finding: its row and its rule's heading carry «Нужна правка кода», never «Исправит человек».
2. Read a wiki finding: it carries «Нужна правка вики»; a document finding carries «Нужна правка документов».
3. Switch to English: the same badges read "Needs a code change" and so on.

## Blocking questions
None.

## Design and decisions
`fixer` (agent/person) leaves `Problem`, `ProblemCategory` and `ProblemDraft`; the page's badge and the
category line read `loop.needs.<section>`. No fallback keeps the old words.

## Acceptance evidence
Static: `bun run check` passed.
Test: the problems suites pass without a fixer; the app's Problems page test reads «Нужна правка кода»
and refuses «Исправит человек».
Mutation: not made; filed per the stage rule.
Review: pending; this record is for the review.

## DONE WHEN
No problem badge names a fixer; each says what the problem needs, in both languages.
