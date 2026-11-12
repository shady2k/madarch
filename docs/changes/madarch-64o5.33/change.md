# A persistent Fill action and a dedicated run page

Change: madarch-64o5.33
Base: 9cb594bf2b72b9610f811413d934aeba05f209f1
Tasks: madarch-64o5.33
Kind: behavior

## Intent
Replace the sync menu badge with an always-visible shared UI-kit Fill Button.
Keep selection separate from execution: a started fill opens its own run page,
where the reader can follow time, progress and results and return to older runs.

## Rationale
The owner's request includes: «нужно отображать время, сколько работает… Можно
отделить по сущностям, по разделам… примерную оценку времени».
The agreed direction is a top-bar `Заполнить…` Button, selection at `/fill`, and
progress at its returned-id address, for example `/fill/runs/run-20261112-demo`. This quote records the request, not an approval
receipt for a revision. No approval, task closure or completed acceptance is
claimed by this proposal.

## Out of scope
- Changing the agent discovery or selection fields supplied by PR #280.
- Changing fill planning, scheduling, publication, pause or cancellation semantics.
- Replacing the existing run log or token-reporting source with a second source.
- Real agent/model execution, tracker writes, or acceptance/closure records.

## Changes to requirements
- product-wiki/fill-entry: add the localized persistent UI-kit Button, active-run destination, selection-to-run navigation and removal of the selection page's bottom progress panel.
- product-wiki/fill-run: add the run page's grouped progress, elapsed and approximate remaining time, token and record counts, log, controls and history summary.

The baseline product-wiki capability has no `fill-entry` or `fill-run`
requirement. The complete proposed capability is
`capabilities/product-wiki.md`: it retains the baseline and adds those two
requirements with Given/When/Then scenarios. Accepted current documents are not
changed by this proposal.

## Preserved contracts
- product-wiki/shell: the persistent action uses the existing top bar; the document work area and navigation remain the reading shell.
- product-wiki/internationalization: new app-owned labels use the selected English or Russian catalogue; product names are not translated by the app.
- product-wiki/acp-agent: token usage remains the agent's reported figure, and unreported usage is not invented.
- fill-orchestrator/cancel: Pause drains in-flight work and stops admission; Stop retains cancellation semantics.
- fill-orchestrator/completion: run results remain the orchestrator's results, not inferred from a browser progress bar.

## Coverage
- product-wiki/fill-entry: fill-entry-idle, fill-start-opens-run, fill-entry-active, fill-selection-fields-preserved
- product-wiki/fill-run: fill-run-progress-and-time, fill-run-unavailable-measurements, fill-run-pause-stop, fill-run-history-and-result
- product-wiki/shell: fill-entry-idle, fill-entry-active
- product-wiki/internationalization: fill-entry-idle, fill-entry-active
- product-wiki/acp-agent: fill-run-unavailable-measurements
- fill-orchestrator/cancel: fill-run-pause-stop
- fill-orchestrator/completion: fill-run-history-and-result

## Where it is seen
Kind: screen
Place: wiki top bar, `/fill`, `/fill/runs/run-20261112-demo` and fill history
Mockup: docs/changes/madarch-64o5.33/fill-runs.html

1. Open the served fixture wiki in Russian and English with no active fill.
   See the shared-kit Fill Button without opening a sync menu.
2. Open `/fill`. Keep the existing kind selection and agent settings, start a
   scripted fixture fill, and land on the returned run's address.
3. Read overall, plugin, section and kind progress, elapsed time, approximate
   remaining time when available, tokens, canonical applied-fact counts, separately labelled published-unit
   counts and log on the run page.
   A fixture with missing measurements must not show invented zeroes.
4. Navigate to another page. The active Button shows `Заполняется · N из M`
   in Russian and returns to that run without starting another one.
5. Pause and stop scripted fixture runs. See actual transitional and
   terminal states, not an immediate claim of settlement.
6. Reopen selection. There is no bottom progress panel; the PR #280 agent
   discovery and selection fields remain.
7. Read history rows with when, selection and result. Open and reload an older
   run while another run is active. Its result, fixed elapsed time and log
   still belong to the older run.

## Blocking questions
None.

## Design and decisions
Use the shared UI-kit Button rather than a new sync badge or custom control.
Keep the selection form for configuration and the stable run route for
execution and history. Read progress, times and controls from the existing run
source; any additional projection fields must carry those source facts, not a
second scheduler. Product section and kind names remain declaration data.

## Acceptance evidence
These are planned scenario check ids, not runner receipts. Final test, browser,
mutation and review evidence must identify the final judged inputs separately.

Pending. This document is a proposal, not a record of passing tests or owner
approval. The coordinator collects source, test, browser, mutation, review and
document-gate evidence for the final revision. No real model run is required
or claimed here.

## DONE WHEN
The reader can start filling through the persistent Button, follow and control
the addressed run on its own page, leave and return through the active Button,
and inspect history with when, selection and result. The selection page has
no bottom progress panel and retains its existing agent configuration fields.
