# The writer reads its pages' structure, ids and names from the Markdown tree, the graph and the language's word segments, not from regular expressions or word lists

Change: madarch-ztyq.12
Base: c94462329cb670511326b6b7de1420d9a411984f
Tasks: madarch-ztyq.12
Kind: no-behavior

## Intent

The writer's format and naming code decided what a page said by matching its
text. `src/writer/format.ts` held `REFERENCE_HEADINGS`, the English and Russian
words "question"/"вопрос" and their prefixes, `ROUTE_SPAN`, `SYMBOL_SPAN`, a
line-based code-span matcher, and a regular expression over the whole body for
raw `madarch:` ids. `src/writer/names.ts` split sentences with `STOP_WORDS` and
regular expressions. A document that used the same structure in another wording
was read differently; a sentence that named a graph key was recognized by a
pattern of characters rather than by the graph's own key prefixes; and every
paragraph and every reference could scan the whole page again.

This change makes the decisions structural. A question link is recognized by its
target `madarch:question:…`; a reference-only heading is a heading whose words
all stand in links and which has at least one (a question link in a heading is
refused separately); a raw entity id is a parsed text or code token whose prefix
the graph declares; a code span is a tree `inlineCode` node; and a statement's name is
built from `Intl.Segmenter` word segments in the wiki's language. The sentence
reader masks only the spans inside the paragraph it is reading, and its footnote
walk advances a cursor instead of searching the page for every reference.

The stored names of pages that already exist are preserved. `sentenceKey()` is
kept stable for unchanged text, and `nameStatements()` reuses the name a sentence
had on the page it replaces; only a sentence that is new to the page receives a
new name.

## Rationale

The kind is `no-behavior`: no requirement of this repository changes. Decision
0029 fixes the page format (a statement sentence, its grounds, its links), and
the writer's existing capability already says that a page names each statement
for what it says and keeps the name of a sentence that did not change. This
change replaces how those rules are read, not what they require. The owner's
rule is direct: no regular expression and no hardcoded word list may decide what
document text means. The Markdown tree already holds headings, links, code
spans and text nodes; the graph already holds the key prefixes and the language
already has a segmenter, so matching the rendered text again is both a second
source of truth and a source of engine-specific behaviour.

The measurable benefit is linear reading. On the original 2,000-statement page
with 2,000 code spans and 2,000 footnote grounds the base at `eaf70258` takes
548.2 ms and this tree 426.3 ms (median of five runs each), 1.29 times faster. On
the review fixture, which adds a question suffix, a resolved code span and shared
opening words to every statement, the base takes 368.7, 775.3 and 1,847.9 ms at
1,000, 2,000 and 4,000 statements, and this tree 409.7, 830.0 and 1,859.9 ms:
each doubling of the page is about twice the work, not four times it.

## Out of scope

- A change to the page format, its capabilities or the words a page says. The
  headings, grounds, footnotes, links and canonical form are the landed ones.
- A real model run, a mutation run and a tracker change. The committed checks
  answer the writer with a scripted agent; no check starts an agent.
- Regular expressions that decide a filesystem path, a graph key, a product slug
  or a serialized label. They are listed under "What remains" below and none of
  them reads document prose.
- The rest of the writer's prompt and run orchestration. The changes outside
  `format.ts` and `names.ts` are the same rule applied to helper functions that
  still collapsed whitespace or recognized a heading by a regular expression.

## Preserved contracts

- product-wiki/pages: a page still has the front matter of its kind, a footnote of grounds on every statement, its links in order of appearance, and the canonical form; `checkPage()` still judges the product, domain, enrichment, overview, validation and editorial pages by the same rules; a sentence that is unchanged keeps the `sentenceKey()` it had and the name stored for that key, so a refresh does not rename the page's statements, and a sentence new to the page gets a name from its own word segments. A question, correction, task and question-file footnote keep the id main gave them.
- product-wiki/front-matter: a page still names the entity it is and the document sections it stands on; its `relates` still holds only graph keys.
- product-wiki/stages: which pages a refresh writes is still the run's decision, and a page whose inputs did not move is kept.

## Coverage

- product-wiki/pages: test
- product-wiki/front-matter: test
- product-wiki/stages: test

## Where it is seen

Kind: internal
Place: the writer's page check and statement naming of a product wiki page
Reason: no screen, command, request or log changes. A fill writes the same pages with the same format and the same stored statement names; what changes is how the writer reads the Markdown tree, the graph's key prefixes and the language's word segments, and how long the check takes.

1. Fill a product whose pages already name their statements, then read a page and keep its statement names.
2. Add a sentence to a page and let the writer check and rewrite it: the old sentences keep their names, and only the new sentence gets a new name.
3. Check a 2,000-statement page: the check completes in linear time, and a page that names a question, a code span and a graph id in the old wording is read by structure rather than by a word list.

## Blocking questions

None.

## Design and decisions

- **A link is known by its target.** `parseTarget()` still parses a target once;
  `questionLinksOf()` now asks whether the parsed target is a question, and
  `linkLabel()` reads the label from the tree. The English and Russian prefix
  checks and `REFERENCE_HEADINGS` are gone. A heading is reference-only when all
  its words stand inside links and it has at least one link; a question link in a
  heading is refused by its target. A heading that merely says "See question" is
  an ordinary topic heading and is no longer accepted as a reference heading by a
  word list.
- **A raw id is a token the graph recognizes.** `GraphView.keyPrefixes()` answers
  the `node_kind` prefixes of the graph plus the page and document prefixes; the
  format scans parsed text and `inlineCode` tokens outside link and heading spans
  and refuses a token whose prefix is one of them. The sequence `madarch:` in a
  link label is text like any other; the target is not scanned as prose.
- **A code span is a tree node.** `linkCodeSpans()` reads the page once and walks
  `inlineCode` nodes, skipping links, headings and definitions. A route is
  recognized by its method and absolute path characters, a symbol by its
  identifier characters; the resolver still decides whether the graph holds
  exactly one route or symbol. Line-by-line matching and the two span regexes are
  gone. Every replacement is assembled in one pass over the original body.
- **A question's prose is parsed, not matched.** `ask_question` reads the Markdown
  tree of `title`, `question`, `why` and of each side's `claim`: a heading, a code
  block, a thematic break or a footnote is refused as question prose, and a side
  claim also refuses a link or a line break. Front matter is split with
  `splitFrontMatter()` and written with `replaceAll`. No regular expression reads
  the question file's text.
- **A question title is prose in any language.** The format refuses an empty
  label, an arrow alone, or a label written as one unspaced `kind:value` token;
  a title containing a space is accepted whatever its wording, so
  `[question: Which limit?]` and `[вопрос: Какой срок?]` both pass and
  `[question:limit]` is refused. No English or Russian prefix decides it.
- **A raw id needs a complete declared key.** The graph's `node_kind` prefixes are
  the authority; the fallback list holds the graph's own code kinds. A wildcard
  prefix, if one is supplied, must be followed by a non-empty kind and value, so
  `code.example` is prose while `code.symbol:src/a.ts#a` is a key. The
  unrestricted `code.` fallback is gone.
- **Glossary fields come from the term parser.** `parseTermText()` now lives in
  `src/knowledge/term-fields.ts`, which both the glossary and the localized-source
  reader import without a cycle. `detectDocumentLanguage()` counts only
  `parseTermText(text).definition`, so a definition that holds a colon
  (`An order: a purchase made by a customer.`) remains prose; capitalization is
  no longer a field test.
- **The hot paths are linear.** Link labels are indexed once in `indexSource()`,
  code-span replacements are assembled once, footnote labels are a `Set`, each
  base name keeps its own suffix counter, and a cursor skips question spans when
  the reader filters tokens. The performance fixture now holds question suffixes,
  resolved code spans, distinct footnotes and statements sharing their opening
  words.
- **A name is a sequence of word segments.** `words()` uses
  `new Intl.Segmenter(language, { granularity: 'word' })`, keeps `isWordLike`
  segments, transliterates Cyrillic and folds case, without a stop list. The
  segmenter is cached per language. The old `STOP_WORDS` set and the regex-based
  camel split are gone from statement naming. Direct name production therefore
  changes for new text (`A refund is allowed within 14 days.` becomes
  `refund-is-allowed-within`, where the old name was
  `refund-allowed-within-days`); stored names dominate for unchanged text.
- **Ids keep main's spelling; statement names do not.** `idSlugOf()` reproduces
  main's old `slugOf()` spelling over ASCII id input, including its stop words,
  for exactly four identities: a question, a correction, a task and a
  question-file footnote. Those ids are links and file names that already exist,
  and the correction and task ids are what a reader follows; changing them would
  break the pages and the API. `slugOf()` and `nameStatements()` never call it.
  The compatibility table is an identity table over ids, not a way to decide what
  page prose says.
- **A label's full stop is part of a name.** The writer's `segmentationText()`
  masks punctuation over link spans as well as over code and question spans, and
  the knowledge reader's `sentencesOf()` does not end a sentence on punctuation
  inside a link. A home-page bullet such as
  `[BR-5 Promotion cap.](madarch:doc:…) — A promotion …` is therefore one
  grounded sentence; its link label is a name, not an ungrounded statement.
- **The sentence key does not move with the name.** `sentenceKey()` collapses whitespace by
  character and keeps the case and punctuation the old key kept, so an unchanged
  sentence has the same key. `nameStatements()` maps the
  previous page's key to its stored name before producing any new name. The
  migration test loads an old-writer canonical page from
  `test/fixtures/old-writer-pages.json`, appends one sentence, checks the result
  through `checkPage()`, and proves the old names are reused and only the new
  sentence's name is new. `canonical()` passes the wiki language to
  `nameStatements()`, so a name is built with that language's segmenter.
- **The reader advances instead of scanning again.** `segmentationText()` masks
  only the spans inside the paragraph under reading, and the footnote walk in
  `sentences.ts` keeps a cursor into the definition list instead of searching the
  whole page for each reference. This is what makes the 2,000-statement cost
  grow linearly.
- **What remains is not prose.** A grep of `src/writer` for `RegExp`, `new RegExp` and word-list `Set`s leaves these, each over an identity, a path or a field the writer itself writes, not over document prose:
  - `format.ts` `SLUG` and the `parseTarget()` shape check read a page id or a `madarch:` target; the `question|correction` checks at the ground and `code.service|code.module` check at a support read graph ids.
  - `answers.ts` recognizes a graph key in a flow entry and parses a `METHOD path` command entry.
  - `prompts.ts` filters `product:` and `domain:` ids out of a question's `about` list; `graph.ts` validates a kind slug from the manifest.
  - `view.ts` `DOCUMENT_EXTENSIONS` and `tools.ts`'s matching check read a repository path; `journal.ts` reads a journal file name; `basis.ts` reads a commit hash.
  - `tools.ts` `BROAD_ENTITY` classifies a graph key; `splitFrontMatter()` and the Markdown reader inspect a question file's own header and authored prose. Neither reads a document being checked.
  - `TOKEN_EDGES` is punctuation, not a word list: it trims the edges of a token before the graph's key prefixes are asked.
  No `STOP_WORDS`, `REFERENCE_HEADINGS`, route/symbol span regex or text word list remains over page prose. `ID_STOP_WORDS` in `names.ts` is the compatibility table described under "Ids keep main's spelling"; only `idSlugOf()` reads it, and it names question, correction, task and question-file footnote ids.

## Acceptance evidence

Filled from the commands actually run on this tree; the counts and timings are
replaced by the final numbers in the handback.

- `bun run check`: `tsc --noEmit` exited 0 on the final tree.
- `bun test test/writer-*.test.ts`: 472 tests passed across 38 files, 6,069 `expect()` calls, 122.69 s; no failure. They include the new `test/writer-structure.test.ts`, the migrated `test/writer-names.test.ts`, `test/writer-home-page.test.ts`, `test/writer-editorial.test.ts` and the linear-time `test/writer-performance.test.ts`.
- `bun test test/knowledge-*.test.ts`: 574 tests passed across 47 files, no failure; 108,180 `expect()` calls, 762 s of test time. The combined single process exceeds this container's memory ceiling, so every file was run in a fresh Bun process; all 47 exited 0.
- The six files named by the CI log were each run alone on this tree and all exited 0, with these raw summaries:
  - `test/loop-entities.test.ts`: 29 pass, 0 fail, 120 `expect()` calls; `Ran 29 tests across 1 file. [660.00ms]`.
  - `test/loop-refresh.test.ts`: 16 pass, 0 fail, 208 `expect()` calls; `Ran 16 tests across 1 file. [5.78s]`.
  - `test/loop-server.test.ts`: 11 pass, 0 fail, 182 `expect()` calls; `Ran 11 tests across 1 file. [7.02s]`.
  - `test/loop-tasks.test.ts`: 9 pass, 0 fail, 107 `expect()` calls; `Ran 9 tests across 1 file. [3.93s]`.
  - `test/loop-training.test.ts`: 9 pass, 0 fail, 174 `expect()` calls; `Ran 9 tests across 1 file. [146.89s]`.
  - `test/madarch-init-e2e.test.ts`: 3 pass, 0 fail, 139 `expect()` calls; `Ran 3 tests across 1 file. [139.33s]`.
- The two red tests first failed, then passed after the fixes: `test/writer-sentence-reader.test.ts` proves a link label with a full stop is one sentence (`14 pass`, 22 `expect()` calls), and `test/knowledge-parse.test.ts` proves the knowledge reader counts the same bullet as one grounded statement (`17 pass`, 171 `expect()` calls). `test/writer-quality.test.ts` now expects main's id `question:how-long-orders-kept` rather than the segmenter's `question:how-long-are-orders` (38 pass, 182 `expect()` calls).
- The original 2,000-statement page with 2,000 code spans and 2,000 footnote grounds: 548.2 ms at `eaf70258`, 426.3 ms here, both the median of five runs of `/tmp/perf-ztyq12-v2.ts`. The review fixture adds a question suffix, a resolved code span and shared opening words to every statement: 368.7, 775.3 and 1,847.9 ms at 1,000, 2,000 and 4,000 statements at the base, and 409.7, 830.0 and 1,859.9 ms here (five runs, median); each doubling is about twice the work. `test/writer-performance.test.ts` checks the same growth (1,000 against 2,000 statements, three runs, median) and refuses more than three times the work.
- `bun scripts/wiki-walk-ci.ts --baseline scripts/wiki-walk-baseline.json`: 0 findings — empty-section, raw-key, foreign-language, raw-id and node-without-evidence are all 0 and all at their baseline — over 1,326 entity pages (2,652 renders), 12 documents, 65 kind catalogues and 1,326 catalogue rows and 0 questions; fill 49.7 s, total 161.7 s; the ratchet passes.
- `node .shady2k/documents.mjs check --phase feature --change madarch-ztyq.12 --target origin/main`: refused only `untracked-change: change/taskIds — a change names existing leaf tasks`; this repository has no `.beads/issues.jsonl` and no tracker leaf for `madarch-ztyq.12`, so the gate cannot see one. No other violation is reported. Its canonical change digest is `9b376d9769b97023eefeeffbb739a2e6771e2c2c89b1623729da701919464998`.

## DONE WHEN

The writer checks the same pages and writes the same format without a regular
expression or a hardcoded word list over document text: a question link is read
by its target, a reference heading by its structure, a raw id by a graph key
prefix, a code span by an `inlineCode` node, and a statement name by
`Intl.Segmenter` word segments. A page that already exists keeps every unchanged
sentence's stored name, and a 2,000-statement page is checked in linear time.
