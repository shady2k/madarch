# A page carries only what a reader needs, and everything it names can be reached

Change: madarch-m38l.21
Base: 96b05588
Tasks: madarch-m38l.21
Kind: behavior

## Intent

The milestone's walk of the generated training product found pages that carried
what the engine had rather than what a reader needs (findings 32 and 33): a page
for every field and every facet, raw keys and raw JSON standing in a Details
value, and generated English text inside the Russian wiki. The review of the
delivered pages added four common findings and the rare ones: a starter upgrade
that could not offer the `details` and `member` lines the starter set now
writes; a Details value with no label for the keys of an object; nested values
labelled from the keys of the manifest; the walk judging a page's language by
its kind's prefix rather than by who wrote the text; an audit that counted a
symbol's far ends by the prefix of their record keys instead of their kinds; a
members list that drew 200 of 201 rows and said 200; a treemap note that counted
files it drew no cell for; and a member with no parent drawn as a page of one
row. This change makes a page carry only what a reader needs and makes every
name on it reachable: members are listed on the page that holds them, in full;
values are labelled from the manifest and a field shows the value it is
initialised with; a count says what is drawn; a page's text is judged by what
wrote it; and a member no parent holds is refused with the manifest line that
declared it.

## Out of scope

The pages' layout, templates, components and CSS are unchanged: no block kind is
added and no page gains or loses a section. Which entities the extractor reads,
and the shape of the graph, are unchanged. The starter set keeps the lines it
already writes; this change adds no line to the product's manifest that the
extractor does not read. The documents app, the static site export and the
fill's scheduling are untouched. The whole-root test suite's memory failure on
this VM and the two git-date-format tests that fail on this VM's older git are
environment failures, not part of this change.

## Rationale

A page that lists 200 of 201 members and says 200 is a page that quietly lies,
and a member drawn as a page of its own is a page a reader cannot use: the
entity that holds it is the page, and the member is a place on it. So the list
is read again at the total it was told (`views.ts:552-556` does the same for
the writer's own lists), the total is the number of rows drawn, and a member's
address resolves to its parent's page at the member's fragment; a member no
parent holds has no page to show, and saying so with the declaration's file and
line is more use than a page of one row. A Details value that prints `{"context":
".", "dockerfile": "Dockerfile"}` prints the engine's keys at a reader; the
manifest already names what a property is called, so it names the keys of an
object value too, and a page prints those words. A field's value is the
expression it is initialised with, which only the syntax tree holds: reading it
from the file's text would be a guess about which occurrence is the
initializer. A count of a drawing is a claim about the drawing, so it counts
what is drawn, as the treemap component does. And a language finding is a claim
about who wrote a passage: the product's author writes in the product's
language, the engine writes the template's own words in the interface language,
so the walk judges by provenance and not by the kind's prefix, which was wrong
for every generated kind whose body the author wrote.

## Changes to requirements

- product-wiki/member-pages (new): a member has no page of its own; the page of
  the entity that holds it lists every member in full with its anchor and the
  readers and writers of it, and its total is the number of rows drawn; a
  member's address opens its parent's page at the member's fragment, finding a
  container whose relation is declared in either direction; a member no entity
  holds is refused with its address, kind, relation, direction, parent kind and
  the manifest file and line of its declaration. Scenarios:
  `every-member-is-listed`, `a-member-opens-its-parent`,
  `a-member-no-parent-holds-is-refused`.
- product-wiki/manifest-labels (new): a property declaration names its English
  and Russian labels and the labels of the keys of an object value; a page
  prints the declared label of the property and of each key, and a key the
  declaration does not name stands under its own name; a declaration that names
  a key wrongly is a finding with file, line and path; a field's value is the
  initializer the syntax tree holds; the starter set declares these lines and an
  upgrade offers every line the starter set names while keeping a person's
  words. Scenarios: `labels-come-from-the-manifest`,
  `a-field-shows-its-initializer`, `an-upgrade-keeps-a-persons-words`.
- product-wiki/drawn-counts (new): a list or picture that shows part of a whole
  says how many it shows of how many there are, and the number shown is the
  number drawn; a list a template limits keeps the total of the whole it was
  read from and draws every entity the page claims. Scenarios:
  `the-treemap-counts-its-cells`, `a-cut-list-keeps-its-total`.
- product-wiki/page-language (new): the walk judges each block by what wrote it
  — the product's own text in the product's language, a template's own words in
  the interface language — and a generated kind is not judged by its prefix.
  Scenario: `authored-text-is-product-language`.

## Preserved contracts

- product-wiki/pages: the documents app, its home, its page addresses and its page bodies are unchanged.
- product-wiki/internationalization: every new label, note and total is written in both languages through the plural families the engine already has, and the ordinary English form is `_other`.
- product-wiki/serve: the API's block and page answers keep their shape, and a refused member is a 404 in the same envelope as the other refusals.

## Coverage

- product-wiki/member-pages: test, static
- product-wiki/manifest-labels: test, static
- product-wiki/drawn-counts: test, static
- product-wiki/page-language: test, static
- product-wiki/pages: test, static
- product-wiki/internationalization: test, static
- product-wiki/serve: test, static

## Where it is seen

Kind: screen
Place: the generated training product's knowledge wiki — an entity page's members list, a type page's Details, a kind catalogue's treemap
Mockup: docs/prototypes/madarch-m38l.1/function-page.png

1. A reader opens the class that holds 201 fields and finds all 201 listed, each with its own anchor, and the list's total saying 201.
2. The reader follows a member's address and lands on the class's page at that member's fragment; a member of a kind whose manifest declares it a member of a parent opens the parent entity's page.
3. The reader opens a Docker-build page and reads `Context: .` and `Dockerfile: Dockerfile`, not the raw keys of the object; a field page shows `Value: EUR` for a field declared `= 'EUR'`.
4. The reader opens a file catalogue's treemap beside its ten fullest files, and the note says how many cells are drawn of how many files there are.
5. The reader opens the wiki in English and Russian; the product's authored bodies stay in the product's language and the engine's own headings and notes follow the interface language.

## Blocking questions

None.

## Design and decisions

- **A member is a place, not a page.** `render.ts`'s member branch resolves the
  parent through the declared relation (`memberParent`, which reads the
  relation's direction from the manifest and matches either end), answers with
  the parent's page, and returns the parent page's own error when the parent's
  page fails, rather than falling through to the member's template. A member
  with no parent answers 404 with the message that names the address, the kind,
  the declared relation and direction, the parent kind and the manifest
  `file:line`.
- **No truncation, and a true total.** `membersBlock` re-reads the neighbours at
  the total the first read returned (`take`), and reads the readers and writers
  through `edgesOf` at that total; `total` is `rows.length`. This mirrors
  `views.ts:552-556`, which already re-reads a writer's lists at their total.
- **Labels are manifest data.** `PropertyDecl` carries `fields?: { key: {en, ru,
  format?} }`, validated by `propertyFields` in `kinds.ts`: only `en`, `ru`,
  `format` and `fields` may stand in a property's body, only `en`, `ru` and
  `format` in a field's, and a field's labels are required in both languages.
  A finding is reported at the nearest existing node's line — the property's
  declaration — because a missing leaf would make `lineForPath` answer 1.
  `objectWords` renders the declared label of each key, the raw key when none is
  declared, and `propertyText`/`objectWords` are what a page prints.
- **A field's value is its initializer.** `initializerOf` in
  `src/extract/code/decls.ts` reads the initializer from the syntax tree
  (`MemberDecl.value`), and `src/extract/code/index.ts` writes it into the
  property row's `value`; the seed labels it `Value`/`Значение`. The text of the
  file is never searched: string quotes are found by code point, not by a
  regular expression.
- **A count counts what is drawn.** `diagrams.ts` passes
  `files.filter((file) => file.lines > 0).length` to `filesRead`, which is the
  rule `wiki/app/src/knowledge/diagrams/treemap.tsx` already applies when it
  drops zero-line files.
- **Language by provenance.** `scripts/wiki-walk.ts` calls `inspectBlock` with
  `product: options.language` and judges an authored block (`body`, `markdown`,
  `term.definition`) in the product's language and a template's Markdown in the
  interface language (`tools.user`). No page text is matched against a word
  list or a regular expression; the language of a run of text is decided by the
  script it is written in.
- **The audit reads kinds.** `test/graph-audit-training.test.ts` reads each
  relation's far end by the kind the graph's row carries (`kindOfKey` from
  `graph.rows`), so `code.reads` is measured as 214 ends that are
  `code.symbol` and 367 that are `code.field` — 581 in all — where the old
  prefix rule counted 559 by mistaking 22 field rows for symbols. A mutation
  case declares a field's row a symbol and is refused.
- **One upgrade source.** `upgradeFields(kind)` in `starter-upgrade.ts` is
  derived from `starterDeclaration(kind, true)`, so the starter set, the offer
  and the applied upgrade cannot drift; only fields the manifest lacks are
  added, so a person's own words survive.
- **A changed member is named by its parent.** `pagesChangedSince` maps a
  changed member row to the parent page a reader can open, with the parent's
  declared title; a member with no parent is left out because no page exists
  for it.

## Acceptance evidence

- `bun run check` answers `CHECK 0` on the branch.
- `test/knowledge-m38l21.test.ts` holds the fixtures for the 201-field class,
  the 101-reader field, the orphan member, the labelled object value and the
  starter upgrade; `/tmp/m38-members-red.log` records the failing run before the
  fix (`200` where `201` was read) and `/tmp/m38-members2.log` the passing one.
- `test/knowledge-treemap-generated.test.ts` holds the twelve-file fixture with
  two empty files and asserts `Showing the first 8 of 12 files by path.`;
  `/tmp/m38-tree-red.log` is the failing run before the fix.
- `test/wiki-walk.test.ts` holds the template whose own Russian heading is read
  in English beside the author's English body read in Russian.
- `test/extract-code-truth.test.ts` holds the field whose initializer is a
  string and the field without one.
- `test/starter-set-upgrade.test.ts` holds the manifest without `details` and
  `member` and the person's own labels.
- `test/graph-audit-training.test.ts` reports the measured 214 + 367 = 581 and
  refuses the mutation case.
- `bun scripts/wiki-walk-ci.ts --baseline scripts/wiki-walk-baseline.json`
  reports `findings: 0` for every class and `ratchet: every class is at its
  baseline`, over 1 326 entity pages and 2 652 renders.
- The touched tests and the knowledge batches pass: 187 tests in 10 files, 297
  in 20 files, 152 in 13 files and 17 in one file, 0 failures.

## DONE WHEN

- A class page lists every field it holds, each with its anchor, and the list's
  total is the number of rows drawn.
- A member's address opens the page of the entity that holds it at the member's
  fragment, and a member no parent holds answers 404 with the manifest's file
  and line.
- A Details value prints the manifest's labels for the keys of an object value
  and a field prints the value it is initialised with.
- The starter upgrade offers `details` and `member` and adds them without
  touching a person's words.
- A treemap's note counts the files it draws a cell for, and a list a template
  limits keeps the total of the whole.
- The wiki walk reports no foreign-language finding for a page whose body the
  product's author wrote in the product's language, and its ratchet stands at
  its baseline.
- The audit of the training repository counts every far end by its kind and
  reports 581.
- `bun run check` passes and `docs/changes/madarch-m38l.21/change.md` with its
  proposed capability passes `documents.mjs check --phase feature`.
