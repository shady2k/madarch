# Settings keeps what the reader set: the verdicts, the bounds, the place and the dangerous actions

Change: madarch-64o5.136
Base: dd6c44f53c5d07a6dff790adeebef801645db591
Tasks: madarch-64o5.136
Kind: behavior

## Intent
PR #299 replaced the app with the template layer and the settings page lost four of its sections. The owner's walk of
the restored pages asked for them back (madarch-64o5.136, the audit /tmp/audit-299-lost.md, section 16):

- **Graph verdicts** (row 132): the saved report's totals of nodes and edges that are valid, invalid and unreviewed, the
  reasons and kinds, one bounded page of the rows a person still has to look at, and the two budgets a run may spend —
  read from `GET /api/graph-verdicts`, saved with `POST`, and «Check again» running one pass (`force=1`).
- **Bounds** (row 133): the writer's turns, minutes, tool calls, write attempts and domain pages are shown, and the one
  bound a person sets — the revision requests per page — is editable and saved through `/api/product-settings`.
- **Where this lives** (row 134): the product checkout and its graph store on this machine, and the sentence that
  nothing here pushes or sends anything.
- **Dangerous actions** (row 135): «Rewrite the pages» and «Start from scratch», each behind the plan it would carry
  out — the pages the agent wrote, the pages kept, the store, the questions and the answers — with the confirm press
  sending that plan. Rewriting says why it cannot run when no agent is chosen, and a refusal stands beside the buttons.

Every read and write goes through the retained command routes; the sections are kit components and every string is a
key of the locale files, so the page reads in Russian and English alike. One kit change came with the page: an inline
code (a path, a key) wraps anywhere rather than widening the phone's page, a card in a grid never widens it, and a
definition list folds to one column below the two-column width. The four mockups beside this record are that page at
1440 and 390, light and dark, read at both widths for its text and for overflow (no element wider than its box, the
page never scrolls sideways).

## Out of scope
The audit's section 12 and row 124 are not in this change. Row 117 (a commit's files with lines added and removed, an
author's commits and most-touched files) needs per-kind page templates for the commit and author kinds and a history
section the GraphQL read does not answer today. Row 118 (a term's definition, synonyms, code names, where it is
defined and its usages with counts) needs a term page template and a usages read over the mentions and grounds edges.
Row 119 (the glossary's definition column, synonyms, ambiguity, «defined in» with usage counts, filter, count and
findings) needs the richer listing read on top of that. Row 124 (a run's usage table by kind, field and model) needs a
per-run usage read: the server keeps the agent's usage rows but answers them per kind, not per run, so the table has
no source to read today. Each is named for the owner rather than half-built.

## Rationale
A page a person set the product's agent, language and bounds on, and started the two dangerous actions from, is where
the product's own machinery is visible; losing it left those settings reachable only through the command line. The
server routes were kept through #299 precisely because they are commands, so the page is the missing half.

Mutation is not run on this branch: it is filed for the stage's assembled mutation run, as the stage rule has it.

## Preserved contracts
- product-wiki/app: the page is the app's own, served from madarch's build, with its strings in the locale files.
- server/serves-wiki: every read and write is a retained command route; no page read and no new route is added for it.
- fill-orchestrator/host: a run started from the verdicts section is the host's run, with the budgets the page saves.

## Coverage
- product-wiki/settings: static, test, mutation, review
- product-wiki/app: static, test
- server/serves-wiki: static, test
- fill-orchestrator/host: static, test

## Where it is seen
Kind: screen
Place: /p/settings of a product, sections «Graph verdicts», «Writer bounds», «Where this lives» and «Dangerous actions»
Mockup: docs/changes/madarch-64o5.136/settings-1440-light.png

1. The page shows the saved verdict report with its totals, reasons, kinds and one page of rows; setting both budgets and pressing «Check again» saves them and starts a run.
2. The bounds stand with the revision-request bound editable; the checkout and the store stand with the no-push sentence.
3. «Start from scratch» asks first, listing the pages the agent wrote, the store, the questions and the answers; only the confirm press posts the plan, and the page then opens the home. With no agent chosen, «Rewrite the pages» says why it cannot run.
