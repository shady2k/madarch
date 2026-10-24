# A question is asked once, linked from its sentence, and starting over preserves people's answers

Change: madarch-m38l.22
Base: e8e971b852f410cf131b9eaf55fa774cd3d319ae
Tasks: madarch-m38l.22
Kind: behavior

## Intent
A person reading the product wiki should answer a decision once and see the answer used, rather than encounter duplicate questions or an unexplained raw question id. The owner's 2026-10-24 walk found repeated questions, English question text and headings in a Russian wiki, reference-only headings, a false ungrounded statement after “См.”, and an answer still visible after starting over without the dialog explaining that it stays. This change makes questions reusable by meaning, keeps question references beside the affected sentence, and makes start over explicitly preserve human answers and corrections while removing unanswered agent questions. Preserving people's input takes priority over completing a reset when its inputs cannot be read safely.

## Rationale
This is a behavior change to question acceptance, the checked page format and reset. The complete proposed capability is `capabilities/product-wiki.md`: the full current capability at the pinned origin/main baseline plus `questions-once`, `sentence-question-links` and `reset-keeps-human-input`. Existing current requirements are retained unchanged. Earlier m38l.7 and m38l.13 change records describe questions and overlap deduplication but have not promoted those requirements into the current capability file at this baseline; this proposal does not promote their unrelated pending requirements.

Baseline inspected without running an agent: `ask_question` matches same-type questions using a Jaccard entity overlap of 0.5 and returns existing answers, but does not compare the decision by meaning. Question headings already have English and Russian renderers. The shared abbreviation mask restricts Russian matches by the following lowercase character, so “См.” before a capitalized navigation label can split. Reset removes the graph and agent product/domain pages only; question/correction files and their resolution metadata remain unchanged, and the dialog has no question/answer counts.

## Out of scope
- Real agent runs; all fill evidence uses the scripted ACP test agent and fixture/generated training repositories.
- Bulk consolidation or deletion of existing duplicate questions, translation of people's answers, or a new question taxonomy.
- Graph extraction, diagram layout, general page content/layout or template changes owned by the parallel workers.
- Product content or human input stored in the engine or machine-local store.
- Removing people's answers or corrections as part of start over; this change explicitly preserves them.

## Changes to requirements
- product-wiki/questions-once (new): compare question meaning across fresh open/answered questions; reuse equivalent questions and answers; distinguish separate decisions on the same entity; enforce wiki-language question content and headings. Scenarios: `semantic-question-reuse`, `different-decisions-on-one-entity`, `answered-question-is-used`, `question-comparison-fails-explicitly`, `question-content-follows-wiki-language`.
- product-wiki/sentence-question-links (new): reject raw entity ids and reference-only headings; use localized sentence-end question links; preserve abbreviation boundaries and exempt navigation-only lines from grounding. Scenarios: `raw-id-and-reference-heading-refused`, `sentence-end-question-link`, `abbreviations-and-navigation`.
- product-wiki/reset-keeps-human-input (new): remove unanswered agent questions, retain human input, clear removed-page resolutions, show exact counts before reset and refuse unsafe input before deletion. Scenarios: `reset-removes-only-unanswered-agent-questions`, `reset-clears-only-deleted-page-resolutions`, `localized-reset-preview`, `reset-rejects-unsafe-input-before-deletion`.

Complete proposed capability text: `capabilities/product-wiki.md`. Deltas are computed by the document adapter from the pinned baseline, not written by hand.

## Preserved contracts
- product-wiki/pages: product Markdown remains the source of wiki pages and human input stays in the product repository.
- product-wiki/serve: existing wiki routes keep their addresses; the existing reset and question surfaces are extended.
- product-wiki/internationalization: all changed generated labels and dialog strings support English and Russian.
- product-wiki/acp-agent: use the existing bounded ACP writer and the scripted test agent; no real agent run is authorized.

## Coverage
- product-wiki/questions-once: test
- product-wiki/sentence-question-links: test
- product-wiki/reset-keeps-human-input: test
- product-wiki/pages: test
- product-wiki/serve: test
- product-wiki/internationalization: test
- product-wiki/acp-agent: test

## Where it is seen

Kind: screen
Place: a product/domain sentence, its question page and the product's start-over confirmation dialog
Mockup: docs/changes/madarch-m38l.22/questions-reset-mockup.html

1. A reader opens a grounded product/domain sentence and follows “→ question: …” / “→ вопрос: …” at its end to one question in the wiki's language, not a raw id or a reference-only heading.
2. The reader answers it; a later scripted fill proposing the same decision receives the existing answer and uses it on the relevant page without another question.
3. The reader opens Start over. Before confirming, the dialog gives the number of unanswered agent questions to remove and answers to keep, in either interface language.
4. After confirming, agent pages and unanswered agent questions are gone; human answers and corrections remain with no resolution links to removed pages. A later fill can use them again.

## Blocking questions
None.

## Design and decisions
- Keep the existing `ask_question`, question Markdown, checker and reset surfaces. The core reads the fresh full question set before accepting an ask. The writing agent compares the proposed decision against open and answered candidates and returns an explicit semantic disposition; a bounded incomplete comparison or unreadable candidate is a refusal, never permission to create a duplicate. Entity overlap can help order candidates but cannot decide equivalence or exclude unmatched candidates. No title-only or entity-only fallback.
- Reuse the existing question id, answer and authorship. For an open match, add the current page without dropping earlier associations. For an answered match, return the answer as a usable ground and keep association with the new page. Enforce the existing bounds explicitly rather than silently truncate associations or comparison candidates. The scripted ACP agent supplies deterministic comparisons in tests; no external judge or live agent is needed for acceptance.
- Keep language enforcement at the checked write boundary, with guidance to repair a wrong-language proposal. Existing bilingual question parsers stay compatible. People's answer text stays exactly as written.
- Extend the shared sentence reading used by the writer and index; do not add a second splitter. A question link belongs to its grounded sentence and does not weaken the two-sided contradiction check. Navigation remains link-checked and cannot hide an ungrounded factual assertion.
- Reset has one plan used for preview and application. Read and validate affected loop files and path containment before deleting; preserve answer/correction content, clear only resolution references to deleted pages, and make corrections pending when their applied page was removed. Reuse existing loop parsers/renderers while preserving human text and authorship.
- Primary ownership: `src/writer`, question-related `src/loop`, `src/knowledge/reset.ts` and reset locale text. Necessary adjacent changes are reset-plan transport/defaults in `src/knowledge/product.ts`, app reset API/types and `wiki/app/src/knowledge/settings.tsx`, plus `src/product/cli.ts` so the same reset reports its question/answer effects. Keep these narrow; do not change parallel workers' templates, extraction or diagrams. Related tests and a relevant shots script may change.

## Acceptance evidence
No implementation or runtime evidence is claimed yet. After approval:
- TDD slices on the SkyPilot AVX2 pod only: writer question and format/splitter checks, loop entity/refresh/training tests, reset/settings/server tests, then wiki app checks and settings/loop UI tests. No local Bun test or build. Every error must identify file, line and full path; every bounded result must expose incompleteness.
- The scripted training fill asks one decision three ways, asks a different decision about the same entity, uses an existing answer, and verifies files plus page grounds. No outside checkout, owner infrastructure or real agent is used.
- Render the touched reader surfaces with the relevant knowledge/loop/settings shots on an 8 GB AVX2 pod. Seed the scratch madarch home's settings with `{"role":"everything","roleAsked":true}`. Inspect question list/page, sentence link and reset dialog in English/Russian, light/dark, at 1150 px and 390 px. Record exact paths and observations; this HTML is a proposed mockup, not a claim of rendered acceptance.
- Walk every touched generated page through `/products/<p>/api/k/page?id=<id>&lang=ru` and the kind lists through `/api/k/entities?kind=<kind>` on the pod, not a sample. Verify reset files and counts before/after and ensure kept inputs can drive the next fill.
- Bounded mutation testing of changed writer/reset logic on the pod, from scratch outside the repository, against focused tests; report survivors, failures or unsupported tooling accurately.
- Read-only Codex review before the PR; fix supported findings. Merge current origin/main before final push, rerun affected checks, open one PR with the required footer, wait for green head CI and hand it to the owner. Never merge it here. Shut down any pod when done.

## DONE WHEN
A scripted fill asking the same decision three ways files one question and later uses its retained answer; different decisions on one entity remain distinct; question text/headings follow the wiki language; pages show localized sentence-end question links, reject raw ids/reference-only headings, and split abbreviations/navigation correctly; start over states exact removed-question/kept-answer counts, removes only unanswered agent questions with agent pages, preserves human answers/corrections and clears obsolete resolutions. Focused pod checks, the complete touched-page JSON walk, inspected bilingual light/dark wide/phone screenshots, mutation evidence, read-only review and green head CI are recorded before the PR is submitted for owner merge.
