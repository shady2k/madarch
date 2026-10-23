# Graph relations stay visible and history pages explain their records

Change: madarch-m38l.16
Base: 05af1efa4ccd3b72531c9f0c93fea0dd8d260982
Tasks: madarch-m38l.16
Kind: behavior

## Intent
Readers of a product's graph need the neighbourhood diagram and the page's
relations block to tell the same story. A reader should not see a page report
that it has no graph relations while the relations block names a task or
commit. History pages must also answer what the work was: tasks show their
commits with date, author and message; commits show changed files, line counts
and touched symbols; authors show their commits and most-touched files and
modules. The generated training repository provides a repeatable audit for
connectivity and a test that compares the two relation reads.

## Out of scope
- Changes to the graph storage model or the historical facts' source data.
- Changes to task document pages (`task` kind in `docs/tasks`), owned by madarch-m38l.14; this change covers only graph kind `code.task` and history graph pages.
- Changes to diagram modeling or diagram renderers owned by madarch-m38l.15.
- Changes to the reader shell or writer, owned by madarch-m38l.12 and madarch-m38l.13.
- Adding product content to the engine or requiring an outside repository in tests.

## Changes to requirements
- product-wiki (extended): graph neighbourhoods include every page-backed relation also exposed by the page's related block, and graph history pages summarize tasks, commits and authors. Complete proposed text is in `capabilities/product-wiki.md`.

## Preserved contracts
None.

## Coverage
- product-wiki/graph-neighborhood: test, generated-training-repository-audit
- product-wiki/history-pages: test, generated-training-repository-audit, browser-walk

## Where it is seen

Kind: screen
Place: graph entity pages in the product wiki, including task, commit and author pages
Mockup: docs/prototypes/madarch-m38l.9/function-pay-1150-light.png

1. A reader opens a graph page and compares its neighbourhood diagram with its relations block; both show the same connected records.
2. The reader opens a task and sees the commits that name it, with date, author and message.
3. The reader opens a commit and sees changed files, line additions and removals, and touched symbols.
4. The reader opens an author and sees their commits and the files and modules they touch most.

## Blocking questions
None.

## Design and decisions
The neighbourhood is audited at depth one for every node in every graph kind in
the generated training repository. The test compares page-backed relation
identities and directions from the graph neighbourhood with those made
available to the related block at the same revision. It reports counts of
isolated nodes per kind before and after the fix. Standalone kinds are an
explicit exception in starter template data and carry a reason; none is
silently excused by the audit. Query results and summaries do not silently
truncate: a capped view must expose the full total or a clear continuation.

History summaries use only facts already indexed by the graph fill. They do
not read an external checkout or invent missing metadata. New relation
seed-template blocks, if needed, are added only in `src/knowledge/seed.ts`
`TEMPLATES` text, not in the seed mechanism. Reader-facing additions are
provided in both English and Russian. The implementation owns `src/fill`
extractors, `src/knowledge/graph-read.ts`, and the contract renderers in the
wiki; it does not alter the parallel workers' files except as required for
integration.

## Acceptance evidence
To be completed after implementation: generated-repository isolated-node
counts before and after; relation parity test; focused SkyPilot checks; rendered
English and Russian screenshots in light and dark at 1150 px and 390 px;
read-only Codex review; CI on the PR head.

## DONE WHEN
The generated training repository has an audited depth-one neighbourhood for
every node of every kind, with no unjustified isolated nodes and relation
parity against each page's related block. Task, commit and author graph pages
show their required history summaries. Reader-facing changes are bilingual and
have been inspected at desktop and phone widths in light and dark themes.
