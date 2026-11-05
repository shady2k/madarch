# Prepare the tracker concept for human planning and agent work

Change: tracker-human-agent-concept
Base: ad6c2f9d
Tasks: madarch-ae8g
Kind: supporting

## Intent

Prepare a reviewable development concept for a first-class human task-work and
decomposition interface plus an agent interface over the same work model. Record
proposed ADRs and explicit proposed amendments to existing decisions, then publish
a discussion PR. The owner requested discussion of comments before development.

## Out of scope

- Runtime implementation, an operational tracker, a production API or executable prototype.
- Accepting proposed ADRs, changing current capability specs, scheduling the tracker
  milestone or opening ready implementation tasks.
- Migrating the current backlog or changing the installed workflow rules as part of
  this documentation PR.

## Rationale

Supporting design documentation only. Proposed behavior lives in this change folder,
not in current capabilities. New ADRs are marked proposed; earlier accepted ADRs gain
explicit pending-amendment references without losing their accepted text. The static
HTML is an illustrative document, not a working UI or fake implementation.

## Preserved contracts

None.

## Coverage

None.

## Where it is seen

Kind: internal
Place: docs/changes/tracker-human-agent-concept/concept.md and the concept discussion PR
Reason: this change prepares proposals and a static mockup, not a running product surface.

1. Read the concept, human interface, agent interface and proposed ADRs 0034/0035.
2. Open the HTML mockup at desktop and narrow widths; its business controls are explicitly inert.
3. Trace the shared lifecycle, authority, concurrency and migration scenarios through the development plan.
4. Discuss the named choices in the PR before authorizing implementation.

## Blocking questions

None.

## Design and decisions

[Concept](concept.md), [human interface](human-interface.md),
[agent interface](agent-interface.md), [design](design.md),
[development plan](development-plan.md), [static mockup](mockup.html),
[0034](../../decisions/0034-human-and-agent-work-interfaces.md) and
[0035](../../decisions/0035-work-reservations-and-operation-sync.md).

The concept's review choices block acceptance and implementation, not publication of
this clearly labeled proposal.

## Acceptance evidence

Two independent agent reviews examined the human/planning contract and the
coordination/publication contract. No cross-model assurance is claimed. Six findings
were corrected; focused rechecks reported no remaining findings in those scopes.

| Finding | Resolution |
| --- | --- |
| Incomplete human drafts had no shared adoption path | Structurally valid incomplete definitions can be retained as shared drafts; opening/claiming still requires completeness. |
| Returning a definition proposal had no service operation | `definition.return` retains rationale and attribution; proposal decision revisions serialize it against adoption. |
| Accepted work could acquire unreviewed criteria or children | Acceptance-basis changes require explicit reopen; earlier acceptance remains historical. |
| Sibling splitting contradicted the identity rule | The original identity may remain a residual executable leaf, become a decomposition container, or be explicitly cancelled when wholly replaced. |
| P2 depended on reconnect behavior scheduled in P3 | Full H12 synchronization acceptance belongs to P3; P2 covers only bounded cached/offline display and refusal of new grants. |
| A later publication could strand an earlier lost completion | Recovery verifies the exact journal-bound target/manifest in the managed publication chain, finalizes the earlier operation once and never rewinds the ref; P0-C covers both the crash and negative cases. |

Observed documentation checks:

- 12 Markdown files: 51 local paths/anchors resolved and two JSON examples parsed.
- Supporting-change feature gate: clean.
- Product-documents check: clean; present-documents check: zero new errors,
  with 16 pre-existing dead-reference findings.
- Static mockup rendered in Chromium at 1150 × 900 and 360 × 900 CSS pixels.
  Document scroll width equaled viewport width at both sizes; no inspected
  paragraph/list/button/label/table-cell text was below 12 px. Mobile inspection
  found zero enabled business controls, and the result-review anchor navigated.
  This is static layout evidence, not functional, keyboard, 200%-zoom or complete
  accessibility acceptance.
- No runtime implementation, product suite, concurrency prototype, migration or
  10,000-item performance claim was exercised. Those remain future acceptance work.

## DONE WHEN

A discussion PR contains both interfaces, one explicit lifecycle and field-authority
model, proposed ADRs and amendments, falsifiable acceptance scenarios and a staged
migration/development proposal. Local links and JSON examples are checked, the mockup
is rendered, and a documentation review reports any remaining concept choices. No
implementation or migration is started, and the tracker milestone remains deferred.
