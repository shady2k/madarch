# Answer-key check

Capability: answer-key-check

## Purpose
The training repository's answer key is compared with the filled product's wiki item by item. A
deterministic evidence pack gathers each item's location, the exact needles and the passages that may
answer it; an item with no location is `none`, and every located item goes to a judge chain that ends
with a person. The report counts fully, partly and none per class, checks the expected questions, and
computes the milestone threshold without gating on it.

## Requirement: evidence-packs — One deterministic pack per answer-key item
When the answer-key check reads a filled product, it shall build one deterministic evidence pack per
answer-key item from the wiki's page and document readers. It shall decide `none` only when an item
has no location; every item with a location shall stay unsure in a separate file for the judge,
whatever exact needles the pack finds. A missing page shall not be treated as proof that the wiki
does not answer the item: the item's words shall retrieve evidence from the product page, domain
pages, READMEs and decisions, and those passages shall travel in the pack once with the ids a judge
quotes.

### Scenario: an-item-with-no-location-is-none
- Given: an answer-key item with no location
- When: the check builds the item's pack
- Then: the item is `none` and no judge is asked

### Scenario: a-located-item-stays-unsure
- Given: an answer-key item whose claim is stated at a page with exact structured evidence
- When: the check builds the item's pack
- Then: the pack names the page and the evidence, and the item stays unsure for the judge

## Requirement: judge-chain — Unsure packs go through the role chain
When an evidence pack stays unsure, the check shall send it to jev first when the host has one,
otherwise to classification, with only its unsure packs going to analysis, and what analysis still
cannot decide shall reach a person. An answer shall carry a verdict, a one-line reason and passage
ids from the pack; an invented id shall be refused. A judge that could not start, was stopped by a
bound or cancellation, or gave no answer shall leave its packs unjudged rather than unsure.

### Scenario: an-invented-passage-is-refused
- Given: a judge answer naming a passage id the pack does not hold
- When: the answer is read
- Then: the answer is refused and its packs stay unjudged

### Scenario: an-unstarted-judge-leaves-packs-unjudged
- Given: a judge role whose agent cannot start
- When: the check runs
- Then: its packs are reported unjudged, not unsure, and the warning names the role

## Requirement: role-settings — Roles choose a named agent and model
The product settings shall assign an agent and model pair to writing, classification and analysis,
and the writer choice shall remain the writing role. A role selector shall offer every agent the
settings name, in that order, before the asynchronously read agent list adds availability. An
unassigned role shall fall back to writing and say so in the report and the settings page.

### Scenario: a-role-selects-a-named-agent
- Given: product settings naming several agents while the agents request has not answered
- When: a classification role's selector is opened
- Then: every named agent is offered, and the writing pair label uses the same names

### Scenario: an-unassigned-role-says-so
- Given: no assignment for analysis and no default pair
- When: the check runs
- Then: nothing is judged for that role and the report says where to assign it

## Requirement: report — Fully, partly and none, and the expected questions
The check shall report the answer-key items as fully, partly or none per class, and shall read the
eight expected questions from the agent-stage key beside the main key's open items. It shall check
those questions against the product's actual question pages by kind and title phrase. It shall
compute the milestone threshold — at least 90% fully, no none, eight expected questions — and shall
not gate on it.

### Scenario: the-report-counts-each-class
- Given: a filled product and its answer key
- When: the check finishes
- Then: the report counts fully, partly and none for each class

### Scenario: expected-questions-are-matched
- Given: eight expected questions and eight question pages about other matters
- When: the check reads the expected questions
- Then: the eight pages do not pass as the expected questions
