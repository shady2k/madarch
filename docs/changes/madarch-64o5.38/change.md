# Translated relation labels

Change: madarch-64o5.38
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.38
Kind: behavior

## Intent
Show every built-in catalogue relation label in the selected wiki language, on kind declarations and reader pages.

## Out of scope
Changing relation identities, graph queries, direction semantics, or product-authored custom vocabulary.

## Rationale
The owner saw English "contains" and "part of" on Russian Files pages on 2026-11-12. Equal locale key sets alone cannot detect a vocabulary missing from both languages.

## Preserved contracts
None.

## Coverage
- product-wiki/relation-label-language: static, test, mutation, review

## Where it is seen
Kind: screen
Place: `/kind/code.file` and entity relation tables and diagrams, in both wiki languages
Mockup: docs/changes/madarch-64o5.38/relation-labels.html

1. Open the Files kind declaration in English and Russian.
2. Read outgoing contains and incoming part-of labels.
3. Read entity relation tables, backlinks and diagram groups in both languages.
4. Compare the complete built-in catalogue vocabulary with both language dictionaries.


## Acceptance evidence
- Behavioral Chromium red on the pre-change built app: both English and Russian fail to show the translated relation wording. Earlier Chrome launch failures are setup failures, not red evidence.
- The unit red also found absent explicit relation labels in both language resources.
- Relation labels share one root vocabulary used by app resources and server diagram generation; neither duplicates the other language inventory.
- Full-suite validation exposed a settings save/refresh race. The saved budgets must finish reloading before Run can be pressed; a test-only wait was rejected because it hid the user-visible race. The repair keeps the pending state continuous across save and refresh, without changing request semantics or timeout bounds.
- Owner approval is not recorded by the agent.

- Final Chromium acceptance: **2 passed, 0 failed, 1,474 assertions**. In each language it checks all 61 catalogue relations, with 122 declarations, 122 related headings, 122 relation lists, 61 backlinks and 122 neighborhood controls. Toggling a relation preserves its original graph ID. The fixture uses no live agent or model.
- Final root `bun run check`: passed, including architecture, UI, catalogue, workflow and quarantine checks.
- Final related root tests as `box`: **29 passed, 0 failed, 637 assertions**, across relation readers, direct vocabulary completeness, view rendering regressions and UI architecture.
- Wiki frozen install, type/UI checks and production build: passed.
- Wiki full-suite attempts: first **414 passed, 1 failed**; repeated **415 passed, 1 failed** after the additional layout regression. Both fail the same settings graph-verdict test at `wiki/app/src/knowledge/settings.test.tsx:388`. Its isolated file passes **22 tests**. An unchanged `origin/main` full-suite run passes **412 tests**, so this was not classified as pre-existing. Investigation found the save/refresh pending-state gap described above. After the one-line production repair and a coherent persisted-budget fixture, the final full suite passes **416 tests, 0 failures, 4,916 assertions**. The controlled pending-refresh test also passes before the repair, so it is invariant coverage, not a separately killed mutation. The earlier failed runs remain part of the record.
- Bounded mutations were killed: English-only language selection (**6 passed, 2 failed**); raw kind-declaration labels (**3 passed, 2 failed**); removing the explicit Russian `contains` entry (**1 passed, 1 failed**). All mutations were restored before final checks.
- Independent read-only source review: no remaining blockers. It checked catalogue completeness, actual bare Git labels, shipped code relation labels, all client surfaces and server-generated diagram arrows.

Validation logs are scratch artifacts under `/tmp/relation38-*.log`; the counts and limitations above are the retained record. Unknown custom relation names retain their established readable spelling. No graph relation ID, direction, timeout, or production lifecycle constant was changed.

