# Open questions, a person's answers and acceptances, and a next step on every graph page

Change: madarch-tzte.25.2
Base: dbf138d80a8a83a4b60f691e39fd18ee369dcf14
Tasks: madarch-tzte.25.2
Kind: no-behavior

## Intent

Stage 7 of decision 0026 and the self-filling charter's outcome 5, in the owner's own
words: «у нас неинтерактивная сессия, все вопросы должны идти в открытые вопросы,
разбитые по типам»; «Открытые вопросы должны закрываться, если агент в процессе нашел
ответ»; «Всегда должна быть рекомендация что делать. Это зачатки трекера». The pages
and the checked writes landed in stages 19–23: a `question` fact is what a checked write
raises (`checked-writes.ts`), a page already lists the questions about its node
(`graph-pages.ts`), and a person's answer had nowhere to go.

This change makes the questions the charter's questions, gives a person the two acts the
charter asks for, and puts a next step on every page:

- **`src/fill/question-types.ts`** is the charter's eight types as data —
  meaning, contradiction, undocumented behaviour, assumption check, term, unverifiable,
  decision rationale, access or document needed — in the charter's order, with the order a
  page groups questions in. A type an agent invented is grouped after the eight and never
  dropped.
- **`src/fill/facts.ts`** gains one fact kind, `answer`: the record that closes a question
  or settles what a page proposes. Its `decision` is `answers`, `accepts` or `rejects`; its
  `subject` is the node it decides about; its `text` is the words; its `by` is the person's
  own name, when the record is theirs. A person's answer is `declared` and accepted as it
  stands (0005's one declared layer a stage never writes, as `claim` carries it too); an
  agent's is `inferred`, proposed, and the schema refuses it without the `evidence` it read —
  a proposed answer nobody can check is no answer.
- **`src/fill/graph-pages.ts`**: a page's questions now carry what depends on the answer
  (`dependsOn`: the pages a reading of the answer would change — the node the question is
  about and the page-worthy nodes its edges name) and its rank (that list's size), the
  answer that closed it, and whether it is open; a page carries the decision a person
  recorded about its proposed content and its own `nextStep`; the page set carries the
  product's questions grouped by the charter's types (`readProductQuestions`) and the
  product's own next step. The three reads of a decision (`answer` facts by their
  decision, by their subject, and a node read for a decision) are narrow index-backed
  reads of one kind.
- **`src/fill/next-step.ts`** is the rule, and it is pure: the charter's order — the page's
  own most depended-on open question first, then a scope nobody covered on a node stage
  5 ranked important, then an assumption to review, and nothing when nothing waits. The
  product's own page reads the same rule over the whole graph: its most asked question,
  else the most important node no complete coverage reached.
- **`src/fill/decisions.ts`** is a person's decision as Markdown in the product's git, beside
  the discussion record the wiki already keeps: `answers/` and `acceptances/`, one file per
  decided node, dated, signed, with the person's own Markdown under its heading unchanged — a
  heading of their own inside an answer stays their text. A file that is neither document is a problem with its full path and 1-based line.
- **`src/fill/declared.ts`** reads those documents back into the graph in one transaction
  (a person's write is staged in the product's git, committed only once the graph holds it,
  and a refused graph write leaves the earlier document standing):
  the `answer` fact each one names, held by the product itself (`fill_fact_holding.product`,
  the holder `person`) rather than by a unit, the person's earlier answer about the same node
  retired so one answer closes a question, and `fill_page_change` rows for the pages the
  decision moved — the question's page and the page it is about for an answer, the page
  itself for an acceptance.
- **`src/fill/fact-store.ts`**, **`src/fill/graph-reads.ts`**, **`src/fill/page-changes.ts`**
  and **`src/fill/page-cache.ts`**: the two columns a product's own record needs
  (`fill_fact_holding.product`, `fill_page_change.product`), every product-scoped read
  finding it beside the units' facts, the change queries reading a product's own change, and
  a page cache that drops the pages one decision moved and no other — so only the pages that
  depend on a decision are read again.
- **`src/fill/orchestrator-host.ts`** and **`src/server/graph-pages.ts`** wire the two routes
  the app posts to: `POST /api/graph/answer` and `POST /api/graph/decide`. The document is
  written first and the graph reads it back at once; a graph write the schema refuses removes
  the document it had just written, so a decision stands in the product's git and in the
  graph or in neither, and a refusal answers the status the app tells apart (404 a node the
  graph does not hold, 400 a request no decision can be about, 503 a home with no fill).
- **`wiki/app/src/api.ts`**, **`graph-pages.tsx`**, the two locales and the stylesheet**: every
  page shows its next step; the graph's index groups the product's questions by the charter's
  types, each naming what depends on it and ranked by that; a question stands with the form
  that answers it, or with the answer the graph holds — an agent's with the evidence it read;
  and a page that proposes facts no person accepted asks for that acceptance.

## Out of scope

- **Narrative text.** madarch-tzte.25.1 writes it; this change's pages show facts, questions
  and decisions, and no agent writes a sentence here.
- **A dedicated questions view.** The product's questions stand on the graph's index and on
  the pages they concern; a view of their own, and the registry's own question documents
  (`src/product-wiki/questions.ts`, unchanged), are not this task's.
- **Assigning a question to a person.** The charter's "open questions assigned to people" is
  the next horizon's; a decision records who wrote it and assigns nothing.
- **Notifying anyone.** A decision wakes the product's live channel and no other channel.
- **The fill's capability text**, proposed by `fill-pipeline-monday` and not current: the
  graph pages' own requirement text lands with the stage that closes decision 0026, as
  madarch-tzte.20.1–23.8 recorded theirs.

## Design and decisions

- **One record kind, one act.** A question's answer and a page's acceptance are the same act
  by the same two kinds of author, so they are one fact kind (`answer`) with a `decision`:
  one read, one page section, one place for a test to state what a decision is.
- **A person's record belongs to the product, not to a unit.** `fill_fact_holding.product`
  and the holder `person` make it visible to every product-scoped read and to no unit's
  replacement; a unit's publication drops only its own holdings, so a person's answer cannot
  be deleted by a fill that publishes the same node again.
- **Two steps, in both places or in neither.** A decision is written to a temporary file
  beside its document, the graph takes the record, and only then is the document renamed
  into place: a refused graph write discards the temporary and leaves the person's earlier
  answer in the product's git. A crash in the window between the graph write and the rename
  leaves the graph holding the record while git keeps the earlier document — the state the
  read-back `madarch-bylg` names is what repairs, and until it lands a person who re-answers
  repairs it by writing again.
- **A person's word wins over an agent's, by one selector.** A node's answer and its
  acceptance are read with `declared` first and `inferred` after, then the smallest id of the
  layer (`byAnswerPrecedence`) — the question set, the index and a question's own page all
  read answers through it, so one question shows one answer everywhere; an agent whose answer
  an earlier run published cannot outrank the person who answered afterwards, and a person's
  record replaces an agent's row of the same words whole (value and provenance with it).
- **Ranked by what depends on it.** A question's rank is the pages an answer would change —
  the node it is about and the page-worthy nodes that node's edges name — measured from the
  graph's own reads, never a separate table.
- **The step, in the charter's order.** The page's own open question first, then a scope
  nobody covered on a node stage 5 ranked important (a page whose coverage landed under its
  place scope is covered too, `coverageScopesOf`'s own three tokens), then an assumption to
  review while nobody has decided, then nothing; a question's own page recommends answering
  it, since that is the one act it is for.
- **Open points for the integrator**, in the order they matter:
  1. **Reading the documents back on their own.** A decision reaches the graph in the request
     that writes it (`applyDecisions`); nothing reads `answers/` and `acceptances/` at a
     service start or after a store is rebuilt from git, so a decision hand-edited in the
     product's repository, or one written while the store was gone, waits for its next write.
     `readDecisions` is the reader such a step needs; a fill run's start is where it belongs.
  2. **What the page set pays for the ranks.** The page set now reads one question set — two
     narrow reads of two kinds and, per distinct node a question is about, that node's edges
     (`QUESTIONS_RANKED = 200`, with the marker that names what the bound left out). On a
     product with hundreds of questions the first page-set read after a publication pays that
     cost; the answer is kept until the next publication, and nothing measured it yet on a
     fill of the madarch tree.

## Acceptance evidence

- `bun run check` (`tsc --noEmit`) exit **0** at every edit round and at hand-over; the wiki app's own `tsc --noEmit` exit **0** after the rebase.
- The feature document gate (`node .shady2k/documents.mjs check --phase feature --change madarch-tzte.25.2 --candidate worktree --target origin/main`) exit **0**, clean, after every edit round and at hand-over.
- The focused suites run in SkyPilot (the owner's rule), each with the tests' own exit status, on the branch rebased onto origin/main b7cbcfe0:
  - `test/fill-question-types.test.ts` + `test/fill-next-step.test.ts` + `test/fill-decisions.test.ts` + `test/fill-facts.test.ts` + `test/fill-page-cache.test.ts` + `test/server-graph-decisions.test.ts` + `test/fill-page-questions.test.ts` — **143 pass, 0 fail, exit 0** (`run-20261020-122953`): the charter's eight types and the grouping, the next step's order, the decision documents and their refusals, the `answer` kind's samples and its evidence rule, the page cache that drops a decision's pages and the page set with them, the routes' refusals, and the end-to-end answer and acceptance over a real fill service (the document in the product's git, the graph reading it back, the pages announced, the person's name on the record).
  - `test/fill-graph-pages.test.ts` + `test/fill-fact-store.test.ts` + `test/fill-checked-writes.test.ts` + `test/server-graph-pages.test.ts` — **84 pass, 0 fail, exit 0** (`run-20261020-121346`): the pages this change reads beside the ones that landed, the store's product holding and its sweep, the checked writes with the new kind among the agent unit's, and the routes over a real server.
  - `test/fill-agent-unit.test.ts` — **16 pass, 0 fail, exit 0** (`run-20261020-121644`): the fake ACP agent closes a question with `assert_fact` and the evidence it read, and the question's page shows it closed.
  - `wiki/app`: `bun install --frozen-lockfile` exit 0, `bun run check` exit 0, `bun test` **227 pass, 1 fail** (`run-20261020-121951`), `bun run build` exit 0. The one failure is `src/graph-diagrams.test.tsx` "the app stops watching once the diagram is near", which this change does not touch: it fails identically at origin/main b7cbcfe0 on its own checkout (**11 pass, 1 fail**, `run-20261020-120039`, cluster `madarch-madarch-main-e22da3`), and it is named in the queue entry rather than fixed here.
- Review, two read-only rounds over the diff, every finding answered. First round
  (`--model deepseek-v4.1-flash-auto`), 18 findings: the page cache drops the page set with a decision's pages; a person's name rides in the answer's value; a question's own page recommends answering itself and an answered one waits for nobody; a decision is staged, committed only once the graph holds it, and dropped whole on a refusal; the question set's truncation marker is rendered; a decision document's fields are read from its header only; the subject read is product-scoped; an agent's proposed answer is refused without evidence; a person's word outranks an agent's at the same node; `mostAskedQuestion` reads `byQuestionRank`; the step's reason reads one page or N pages; the dead `at` option is gone; "nothing to do" claims only what the rule checked; the step opens the question's own page; the verdict the wiki does not know is refused at the
  service too. Second round (`--model glm-5.3-flash-auto`, after those fixes): the ten fixes
  verified in the code at `2a1700d9`, and seven findings, answered — the answers' one
  precedence shared by the question set, the index and a question's own page
  (`byAnswerPrecedence`: a person's word first, then the smallest id), the declared upsert
  replacing the row whole so it carries the person's name and drops the superseded evidence,
  the staged file named per decision (two concurrent decisions about one node cannot rename
  each other's words), the answer step's reason stating the dependency measure and not a
  recompute claim, a question's own rank measured from its about node the way the question set
  measures it, and this record's crash-window sentence said as it is.

## Preserved contracts

- product-wiki/pages: unchanged — a document page is still the product's Markdown read from the working tree at every ask, the graph pages stand beside it, and the two new routes write `answers/` and `acceptances/` at the product's root, which neither place the wiki's pages are read from.
- product-wiki/live: unchanged — the wiki's own change stream (`GET /api/events`) and its revision rule are untouched; the graph's channel (`/api/graph/events`) now also carries a person's decision, which is a change of the graph and is announced the same way.
- product-wiki/serve: unchanged — the routes stand only where the server was given the fill's graph (`options.graphPages`), and a server without one answers the empty page set and the refusals it already named.
- product-wiki/internationalization: the new strings ride the same catalogues, English and Russian, with the units' plural forms (one / few / many).
- product-repository/manifest: nothing here reads the manifest beyond the product's own name, which the pages already read, and the decision documents are not manifest data.
- fill-stages/registry: a stage is still a module plus registration and this change registers none; the one fact kind it adds is written by the agent unit's own checked write (the kind joins that stage's `AGENT_UNIT_KINDS`) and by a person's record, never by a stage of its own.

## Coverage

- product-wiki/pages: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/internationalization: test
- fill-stages/registry: test
- product-repository/manifest: test

## Rationale

`no-behavior`: the change implements the accepted decision 0026's "Writing" and the
charter's outcome 5 on the graph's pages, and adds no requirement of the product. The fill's
capability is proposed by `fill-pipeline-monday` and is not closed, so the graph pages' own
requirement text lands with the stage that closes decision 0026, exactly as
madarch-tzte.20.1–23.8 recorded theirs.

What a person sees is new: every graph page names what to do next, the graph's index groups
the product's questions by the charter's types with what depends on each, a question stands
with the form that answers it, and a page that proposes facts no person accepted asks for
that decision; an answer and an acceptance are Markdown in the product's git and the graph
reads them back. None of it moves a current capability's requirement: the pages the wiki
serves from the product's Markdown are unchanged, a server given no fill's graph answers
exactly what it answered before, and the questions, answers and decisions are the graph's
own records, which no capability file describes yet.

The one fact kind and the two columns are what make a person's word a record of the graph
rather than a second store: 0005 keeps a person's acceptance beside the fact it accepts and
never as a rewrite of it, and 0027 gives the product's units their own holdings. A person's
record belongs to no unit, so its holding names the product (`fill_fact_holding.product`) and
every read that scopes itself to a product finds it beside the units' facts. `answer` is the
kind because 0005's acceptance and a question's answer are one act — a person's or an agent's
words about a node — and one kind is one read, one page section and one place for a test to
state what a decision is.
