# A committed answer-key check compares the training product item by item and reports fully, partly and none per class

Change: madarch-j6ho.2
Base: d6b617e57d39bee8cc3cbcac23eef95e3d3dbf85
Tasks: madarch-j6ho.2
Kind: behavior

## Intent
The answer key of the training repository becomes a committed check. The check reads the filled product's wiki through its page and document readers, builds one deterministic evidence pack per answer-key item, and decides `none` only when an item has no location; every item with a location stays unsure in a separate file for the judge. The judge chain is jev, then classification, then analysis, with what analysis still cannot decide reaching a person. Answers carry a verdict, a one-line reason and passage ids from the pack, and an invented id is refused. A judge that could not start, was stopped by a bound or cancellation, or gave no answer leaves its packs unjudged rather than unsure.

The eight expected questions from the agent-stage key are read beside the main key and checked against the product's actual question pages by kind and title phrase. The report counts fully, partly and none per class and computes the milestone threshold (at least 90% fully, no none, eight expected questions) without gating on it. The settings page assigns an agent and model pair to writing, classification and analysis, offers every named agent, and says where to assign a role when none is assigned.

## Out of scope
- Starting a real model in a test; the tests use fake judges and a scripted agent.
- Gating a milestone on the computed threshold; this change reports it and leaves the decision to the milestone.
- Treating a missing page as proof that the wiki does not answer an item; the item's words retrieve passages from the product's documents instead.

## Rationale
The owner asked why the answer key was not being compared. A deterministic pack per item makes the comparison inspectable and repeatable, and keeps meaning and history for a judge rather than letting a word match decide. Passing every unsure pack through the same role chain the writer uses keeps one place to assign agents, and refusing an invented passage id stops a judge from citing text the pack does not hold.

## Changes to requirements
- answer-key-check/evidence-packs (new): one deterministic evidence pack per item; `none` is decided only when an item has no location, every located item stays unsure for the judge, and a missing page retrieves passages from the product's documents rather than proving absence. Scenarios: `an-item-with-no-location-is-none`, `a-located-item-stays-unsure`.
- answer-key-check/judge-chain (new): unsure packs go to jev, then classification, then analysis, then a person; answers name a verdict, reason and passage ids from the pack, and an invented id is refused. Scenarios: `an-invented-passage-is-refused`, `an-unstarted-judge-leaves-packs-unjudged`.
- answer-key-check/role-settings (new): writing, classification and analysis roles are assigned an agent and model pair in the product settings; every named agent is offered, and an unassigned role falls back to writing and says so. Scenarios: `a-role-selects-a-named-agent`, `an-unassigned-role-says-so`.
- answer-key-check/report (new): the report counts fully, partly and none per class, checks the eight expected questions by kind and title phrase, and computes the threshold without gating on it. Scenarios: `the-report-counts-each-class`, `expected-questions-are-matched`.

## Preserved contracts
- product-wiki/pages: the check reads the pages the wiki already serves through the page and document readers and changes no page, route or rendering.

## Coverage
- answer-key-check/evidence-packs: test
- answer-key-check/judge-chain: test
- answer-key-check/role-settings: test
- answer-key-check/report: test
- product-wiki/pages: test

## Where it is seen

Kind: internal
Place: the answer-key check run after a fill, its report, and the roles section of the product settings
Reason: the check is a command and a settings section, not a page: the product's wiki is unchanged, and what a person reads is the check's report and the role selectors.

1. Run the answer-key check on a filled training product and read one evidence pack per item, with the exact findings and the separate unsure file.
2. Read the report: fully, partly and none per class, the eight expected questions beside the actual question pages, and the computed threshold.
3. Open the settings page and assign a different agent or model to classification or analysis; see every named agent offered, and an unassigned role say where it falls back.

## Blocking questions
None.

## Design and decisions
The deterministic layer returns `none` only when an item has no location at all; every other item is unsure, so exact needles, meaning, a page that denies the claim and unresolved links all go to the judge. A missing page is a gap in extraction, not proof: the item's words retrieve evidence from the product page, domain pages, READMEs and decisions, and those passages travel in the pack once with the ids a judge quotes. Judges are addressed by the same role mechanism the writer uses, with the legacy writer choice as writing. The expected questions are matched by kind and title phrase, so eight pages about other matters do not pass. The report computes the threshold but never gates on it.

## Acceptance evidence
- PR #191 (`af58da3d`) added the answer-key evidence check, the judge chain and role settings in `src/knowledge/answer-key-check.ts`, `src/knowledge/answer-key-judge.ts`, `src/knowledge/answer-key-acp-judge.ts` and `src/knowledge/model-roles.ts`.
- `test/answer-key-check.test.ts`, `test/answer-key-judge.test.ts`, `test/answer-key-acp-judge.test.ts` and `wiki/app/src/knowledge/settings.test.tsx` hold the packs, the refusals, the unjudged outcomes, the expected questions and the role selectors.
