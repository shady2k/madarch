# A fill reads the pages it just wrote as a newcomer, asks an assigned editing role for bounded revisions, and lets the page's own unit rework only the passages named

Change: madarch-ztyq.9
Base: 96b0558801d17eacdeecd2a604351aca89a62ee2
Tasks: madarch-ztyq.9
Kind: behavior

## Intent
Decision 0032, section 6, asks the wiki to be for people first: an editorial unit reads the written pages as a
newcomer, whether a page says what it is for, whether one fact is stated the same way on every page, whether
glossary terms are used, whether internal jargon stands in reader prose, and it sends bounded revision requests to
the units that wrote the pages. Before this change the writer published the pages its units wrote and stopped.
Nothing read them together; no model role could be asked to edit them; a request had no bound, no way to name only
one passage, and no journal entry that a reader could inspect.

This change runs the pass after the product and domain batch and again after the overview. Deterministic checks find
conflicting numbers on a shared ground, a glossary synonym where the term's title is absent, and a graph key, path
or code name in a reader's sentence. An explicitly assigned editing role, or a host jev before it, may then name a
page and passage it was shown and ask for a change with a reason; the requests are bounded per page by a saved
product setting and over the whole pass. The pass writes nothing. The page's own unit reworks only the named
passages under a revision scope, and a refused revision leaves the page and its written outcome exactly as they
stood. Findings, requests, skips and warnings are journal entries, so a revision is never a hidden edit.

## Rationale
A reader now gets pages that were read against one another and against the glossary and graph before they stand. A
contradiction such as a refund taking nine days on one page and fourteen on another is found from the pages' own
grounds, not from a model's memory; a synonym that the glossary itself declares is caught from the term's body, and
an internal key is caught from the graph's own names. Those checks run even when no editing model is assigned, so
the pass has value without spending an agent call.

A model is asked only for what the deterministic checks cannot see, and it is asked as an editor with a bounded
pack: it cannot invent a page, a passage, a change or a reason it was not shown. The per-page bound is the owner's
setting, not a constant hidden in code, and zero is a real choice that keeps the deterministic checks and skips the
model. Revisions are changes to a reader page, so they go through the unit that owns the page and its tools; the
revision scope makes "only the passages that were named" checkable rather than a request the model could ignore. A
failed or refused revision must not make a page that was written look failed, and the journal and the run report
make every finding and request visible.

A new capability, `editorial-pass`, carries these requirements; its complete proposed text is in
`capabilities/editorial-pass.md`.

## Out of scope
- Invalidating the units downstream of a revised page within the same fill (decision 0032, section 11). This change
  reworks the page and keeps the run's written outcome; a later fill decides what must be written again from the
  inputs it sees.
- The editorial page unit `docs/editorial.md` and the full set of document readings it consumes. The pass in this
  change reads the product, domain and overview pages; it is not another writer page.
- A general prose-quality model, a second editing model, or a panel of judges. One explicitly assigned editing role
  and one optional host jev are the whole reading.
- Deterministic checks beyond the three stated kinds, including a check for every possible contradiction or a
  general identifier taxonomy.
- A change to the owner's milestone acceptance or to the tracker. No check here starts a real model: every
  committed test uses a scripted agent, a fake jev or a fake editing judge.

## Changes to requirements
- editorial-pass/after-the-batches (new): the pass reads the product and domain pages after their batch and the
  complete set after the overview. Scenarios: `the-batch-precedes-the-overview`, `the-complete-set-is-read-last`.
- editorial-pass/deterministic-findings (new): conflicting facts, glossary aliases and internal identifiers are
  found without a model. Scenarios: `one-fact-two-values`, `a-glossary-synonym-and-a-code-label`,
  `an-identifier-in-prose`.
- editorial-pass/bounded-requests (new): a judge may name only a page and passage it was shown, within the per-page
  and whole-pass bounds; the bound is a product setting from 0 to 12. Scenarios:
  `a-request-outside-the-pack-is-refused`, `the-per-page-bound-holds`, `zero-still-checks`.
- editorial-pass/scoped-revisions (new): only named passages may change, and a refused revision leaves the page and
  its written outcome as they stood. Scenarios: `a-change-beside-the-passage-is-refused`,
  `the-named-passage-may-change`, `a-refusal-keeps-the-written-outcome`.
- editorial-pass/editing-role (new): only an explicitly assigned editing pair starts the judge; a jev reads first;
  a failed judge is a warning. Scenarios: `the-jev-reads-first`, `no-fallback-editor`,
  `a-failed-judge-does-not-withdraw-a-page`.
- editorial-pass/journal (new): findings, requests, skips and warnings are journal entries at their pass point.
  Scenarios: `a-request-is-a-journal-entry`, `a-skip-is-never-silent`.

Complete proposed capability text: `capabilities/editorial-pass.md`. It is the whole capability, not a hand-written
delta.

## Preserved contracts
- product-wiki/pages: a reader page keeps decision 0029's format, front matter and grounding; the pass only reads it, and a revision may change only named statements, never its page identity or unrelated prose.
- product-wiki/front-matter: the revision scope neither compares nor rewrites front matter, so a revision cannot change the document a page is or the set it belongs to.
- product-wiki/stages: a page that stands is not written again because the pass read it; an unassigned editing role or a zero bound leaves every page byte-identical, and a run with no editorial option is unchanged.

## Coverage
- editorial-pass/after-the-batches: test
- editorial-pass/deterministic-findings: test
- editorial-pass/bounded-requests: test
- editorial-pass/scoped-revisions: test
- editorial-pass/editing-role: test
- editorial-pass/journal: test
- product-wiki/pages: test
- product-wiki/front-matter: test
- product-wiki/stages: test

## Where it is seen

Kind: internal
Place: a fill of a product whose reader pages stand, and the wiki's existing journal and settings page
Reason: the pass adds no screen, command or request of its own; it changes what a fill writes beside the pages it already writes, and what the existing journal and settings show. No new screen is drawn, so no mockup is judged.

1. Fill the training product with an editing role assigned and the editorial bound set to 1.
2. Open the fill's journal: the editorial findings, revision requests and their pass point (`batch` or `overview`) are there.
3. Open a revised page: the named sentence changed and the rest of the page is as the writer wrote it.
4. Clear the editing role and fill again: every page is byte-identical and the journal carries the skip reason.
5. Set the bound to 0 and fill: the deterministic findings are journaled, no editing model is asked, and no revision is applied.

## Blocking questions
None.

## Design and decisions
The pass is read-only and deterministic-first. `runEditorialPass()` parses every reader page into grounded
statements, runs the three checks, journals their findings, and only then builds a judge pack of titles, statement
ids, lines, texts, findings and the bound. It returns findings and requests; it has no sink. The writer decides
whether and how to rework a request.

The three checks use the same parsed statement model as the pages. Conflicting facts are grouped by a shared ground,
then compared by word shape and by numeric value, so `09` and `9` agree and `1,000` and `1000` agree while `9` and
`14` on one ground do not. Glossary aliases come from the parsed term body's own synonyms and are skipped inside code
blocks. Internal identifiers come from the graph's keys, path-like keys, code-shaped labels and properties, longest
first, rather than from a fixed jargon list.

The judge seam is `EditorialJudge`. The host's jev runs first over the whole pack; pages it names as unread are the
ones the editing role is asked about, and a jev that read every page means no editing model is asked. A judge answer
is filtered against the pack and the bounds before any request reaches the writer. An unassigned editing role never
falls back to the writing pair, because that pair wrote the pages and is not an independent reading.

The writer reworks requests through the page's own unit — product, domain or overview — with the page as it stands
and the requested passage ids in `revisionScope`. `revisionScopeProblems()` parses both versions as Markdown blocks
and grounded statement segments, matches blocks in order, and permits only named passages and the definitions they
stand on to change; front matter is out of the comparison, and a passage may move without being a change. A refused
revision restores the bytes, records the full path and line, and does not create a second unit outcome.

The per-page bound, `editorialRequestsPerPage`, is validated at the product, server and fill start as an integer
from 0 to 12 with default 2, saved beside the product's model roles and carried in `WorkerStart`. Zero skips only
the model reading; the deterministic checks and their journal entries remain. Every finding, request, skip and
judge warning is journaled with the pass point, and the writer report carries the same result.

## Acceptance evidence
`bun run check` exits 0 at the repository root and in `wiki/app`. The touched test files pass: 60 tests in
`writer-editorial`, `editorial-acp-judge`, `fill-worker-editorial` and `graph-verdicts`; 51 tests in
`knowledge-agent`, `knowledge-settings` and `wiki-readers`; 56 tests in `writer` and `writer-graph` — 167 pass, 0
fail, 1350 expect calls. The document gate's raw output and the exact commands are in
`/workspace/repo/out/report-ztyq9ci.md`.

Merged `origin/main` (`b96a5904`, #202's mention pass) on top: the pass is unchanged and the mention pass runs
after it, so the same checks hold — `bun run check` exits 0 at the repository root and in `wiki/app`, `test/writer.test.ts`
passes 38 tests, the writer and knowledge suites pass file by file, `wiki/app` passes 296 tests, and the wiki walk
ratchet reports every class at its baseline.

## DONE WHEN
A fill of the training product reads its product, domain and overview pages first through the deterministic checks
and then, when an editing role is explicitly assigned, through the editing judge at the batch and overview points.
Every request names a shown page and passage, respects the saved per-page bound and the whole-pass bound, and is
journaled with its point. The page's own unit reworks only the named passages under the revision scope, a refused
revision leaves the page and its written outcome byte-identical, and a run with no editorial option or no assigned
editing role writes exactly the pages it wrote before.
