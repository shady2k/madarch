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

The measurable benefit is linear reading. Before this change a 2,000-statement
page with 2,000 code spans and 2,000 footnote grounds took 555.3 ms. The same
page now takes 406.7 ms (median of ten runs each), which is 1.37 times faster, and
the cost grows with the page rather than with its square: at 1,000, 2,000 and
4,000 statements the new check takes 187.8, 404.2 and 836.7 ms, against 262.6,
555.3 and 1,309.1 ms before.

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

- product-wiki/pages: a page still has the front matter of its kind, a footnote of grounds on every statement, its links in order of appearance, and the canonical form; `checkPage()` still judges the product, domain, enrichment, overview, validation and editorial pages by the same rules; a sentence that is unchanged keeps the `sentenceKey()` it had and the name stored for that key, so a refresh does not rename the page's statements, and a sentence new to the page gets a name from its own word segments.
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
  gone.
- **A name is a sequence of word segments.** `words()` uses
  `new Intl.Segmenter(language, { granularity: 'word' })`, keeps `isWordLike`
  segments, transliterates Cyrillic and folds case, without a stop list. The
  segmenter is cached per language. The old `STOP_WORDS` set and the regex-based
  camel split are gone. Direct name production therefore changes for new text
  (`A refund is allowed within 14 days.` becomes `refund-is-allowed-within`,
  where the old name was `refund-allowed-within-days`); stored names dominate for
  unchanged text.
- **The sentence key does not move with the name.** `sentenceKey()` collapses whitespace by
  character and keeps the case and punctuation the old key kept, so an unchanged
  sentence has the same key. `nameStatements()` maps the
  previous page's key to its stored name before producing any new name, and the
  migration test writes a page, appends one sentence and proves the old names are
  reused and only the new sentence's name is new.
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
  - `tools.ts` `BROAD_ENTITY` classifies a graph key; its front-matter expression reads a question file's own header; its `bounded()` and claim guards refuse headings, rules, fences, links, line breaks and footnote marks in a question's own fields. None of them reads a document being checked.
  - `TOKEN_EDGES` is punctuation, not a word list: it trims the edges of a token before the graph's key prefixes are asked.
  No `STOP_WORDS`, `REFERENCE_HEADINGS`, route/symbol span regex or text word list remains.

## Acceptance evidence

Filled from the commands actually run on this tree; the counts and timings are
replaced by the final numbers in the handback.

- `bun run check`: `tsc --noEmit` exited 0 on the final tree.
- `bun test test/writer-*.test.ts`: 426 tests passed across 36 files, 5,886 `expect()` calls, 48.70 s; no failure. They include the new `test/writer-structure.test.ts`, the migrated `test/writer-names.test.ts` and the linear-time `test/writer-performance.test.ts` (2.84 s).
- `bun test test/knowledge-*.test.ts`: 539 tests passed across 42 files, no failure; 135,216 `expect()` calls, 414.06 s of test time. The combined single process was killed by this container's memory ceiling (dmesg records the OOM kill), so every file was run in a fresh Bun process; all 42 exited 0.
- The 2,000-statement page with 2,000 code spans and 2,000 footnote grounds: 555.3 ms before, 406.7 ms after, both the median of ten runs (first run included) of `/tmp/perf-ztyq12-v2.ts` against the base worktree at `eaf70258` and this tree. At 1,000, 2,000 and 4,000 statements the after times are 187.8, 404.2 and 836.7 ms (five runs), so doubling the page doubles the check; the before times are 262.6, 555.3 and 1,309.1 ms. `test/writer-performance.test.ts` checks the same growth (1,000 against 2,000 statements, three runs, median) and refuses more than three times the work.
- `bun scripts/wiki-walk-ci.ts --baseline scripts/wiki-walk-baseline.json`: 15,189 findings and every class exactly at its baseline — 3,252 empty-section, 4,704 raw-key, 6,357 foreign-language, 426 raw-id and 450 node-without-evidence — so the ratchet passes.
- `node .shady2k/documents.mjs check --phase feature --change madarch-ztyq.12 --target origin/main`: refused only `untracked-change: change/taskIds — a change names existing leaf tasks`; this repository has no `.beads/issues.jsonl` and no tracker leaf for `madarch-ztyq.12`, so the gate cannot see one. No other violation is reported. Its canonical change digest is `9b376d9769b97023eefeeffbb739a2e6771e2c2c89b1623729da701919464998`.

## DONE WHEN

The writer checks the same pages and writes the same format without a regular
expression or a hardcoded word list over document text: a question link is read
by its target, a reference heading by its structure, a raw id by a graph key
prefix, a code span by an `inlineCode` node, and a statement name by
`Intl.Segmenter` word segments. A page that already exists keeps every unchanged
sentence's stored name, and a 2,000-statement page is checked in linear time.
