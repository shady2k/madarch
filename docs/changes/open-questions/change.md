# The wiki lists the product's open questions

Change: open-questions
Base: 01eca2e44ab09182b23526f2b521f5674984f467
Tasks: madarch-pddl, madarch-hui1
Kind: behavior

## Intent
The owner ordered the wiki to list the product's open questions: the
documents the skill set writes for them, with a sidebar count ("Открытые
вопросы" in the mockup), an answered question closing out of the count,
`Not applicable:` closing the same way and an empty answer leaving the
question open, and a new draft showing the two facts it carries — the
manifest's name and the audience/who-it-is-for line — on the home page.

## Out of scope
Editing or answering questions from the wiki (the wiki serves read-only, the
set's editor work is madarch-j0a), question templates, the id-to-page
resolution of the `Concerns:` ids, the set's check findings display
(madarch-fe1), and any change to the set's own forms or `check-product.mjs`.

## Rationale
Open questions are the product's own record of what is unsettled; a reader
working from the wiki needs to see what still waits for an answer without
walking every document. The state follows the set's rule — status computed,
never written — so the wiki invents no status and no asked date.

## Changes to requirements
- product-wiki/open-questions: NEW. The wiki reads the set's open-question
  documents wherever they stand under the product's `docs/`, computes each
  question's state from the answer's own text (empty or absent stays open;
  `Not applicable:` is not-applicable; any other non-empty answer closes it
  as answered), serves the questions list, offers the view at `/questions`
  with the open ones first and the closed ones as a muted read, and carries
  the live count in the sidebar through the wiki's own change stream.
- product-wiki/shell: the sidebar also carries an open-questions entry
  beside the product's overview entry, with the count of the open questions;
  the entry opens the questions view at `/questions`.
- product-wiki/pages: the questions answer reads the same page walk the
  pages requirement holds; nothing else in the two places is read.
- product-wiki/internationalization: the questions and audience strings ride
  the same catalogues; the count uses the unit's plural forms
  (`1 открытый вопрос / 2 открытых вопроса / 5 открытых вопросов`).

## Preserved contracts
- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- product-wiki/internationalization: test

## Coverage
- product-wiki/open-questions: test, mutation, browser-walk
- product-wiki/shell: test, browser-walk
- product-wiki/pages: test
- product-wiki/live: test, browser-walk
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- product-wiki/internationalization: test
