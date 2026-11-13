# Revise the human-agent tracker concept after maintainer review

Change: tracker-human-agent-concept
Base: ad6c2f9d
Tasks: madarch-ae8g
Kind: supporting

## Intent

Revise the documentation-only concept and ADRs in draft PR 218 against
[@shady2k's review](https://github.com/shady2k/madarch/pull/218#issuecomment-6705724890),
then return the revised materials for discussion before implementation.

The original proposal and permission to publish a draft came from a contributor's
assistant session, **not repository owner @shady2k**. PR author is @avlokhturov.
The current session requested this rewrite. Previous "owner requested/approved"
wording was inaccurate; it did not establish maintainer approval of the concept,
workflow exceptions or publication.

`madarch-ae8g` above is local bookkeeping required by the installed document check,
not an upstream tracker task. `madarch-rt5d` likewise records the local workflow
installation/publication finding. Neither has been published to the upstream tracker;
publication was denied. This PR does not pretend that local tracking satisfies an
upstream tracking requirement.

## Out of scope

- Runtime implementation, a production API, coordination proof or live migration.
- Accepting proposed ADRs, changing current capability specs, scheduling a tracker
  milestone or opening ready implementation tasks.
- Upgrading or bypassing installed workflow checks, changing unrelated backlog
  records or merging this draft PR.

## Rationale

The initial draft contradicted the maintainer's desired data/coordination model.
This revision replaces it rather than preserving incompatible aliases or a hidden
fixed lifecycle. All work data belongs in PostgreSQL; Git is segmented operation
transport. Shared taking is online and covers a subtree. Free human intake, ordered
agent work, owner-managed levels, nonexpiring reservations, separate responsibility
and execution, configurable lanes and kind workflows are one contract.

The first two agreements are the uniform manifest rule and table structure. A usable
local tracker, early br importer and fill can progress together after that agreement;
the parallel Git proof gates shared grants, not all local planning.

Supporting proposals live here, not in current capabilities. ADRs 0034/0035 remain
proposed. Existing accepted ADR bodies remain unchanged and carry explicit pending
amendments; ADR 0033 point 29's per-task approval/human-merge rule needs an actual
amendment, not a claim that the new concept already complies with it. Point 28's
protected wiki text does not ban ordinary work-data edits. The HTML is a static
illustrative document, not a working tracker.

## Preserved contracts

None.

## Coverage

None.

## Where it is seen

Kind: internal
Place: docs/changes/tracker-human-agent-concept/concept.md and draft PR 218
Reason: this change revises proposals and a static mockup, not a running product surface.

1. Follow R01–R12 from maintainer feedback into the model, both interfaces, ADRs and plan.
2. Review Q1's manifest/table proposal, then Q2–Q4's named mechanism decisions.
3. Open the static HTML at desktop and narrow widths; business controls are inert.
4. Trace M0/L1/G1/I1/O1 and their future acceptance scenarios without treating them as run results.
5. Discuss and accept the relevant agreements before starting development.

## Blocking questions

None.

## Design and decisions

[Concept](concept.md), [model contract](model-contract.md),
[human interface](human-interface.md), [agent interface](agent-interface.md),
[design](design.md), [development plan](development-plan.md),
[static mockup](mockup.html),
[0034](../../decisions/0034-human-and-agent-work-interfaces.md) and
[0035](../../decisions/0035-work-reservations-and-operation-sync.md).

Source inventory was refreshed against main `ef37484d`; the change's original base
above is retained for the supporting-document record. Current graph temporal tables
are not represented as the maintainer's intended as-is/multiple-to-be/snapshot model.

Q1–Q4 block their corresponding design/runtime acceptance, not publication of this
explicitly proposed revision. The PR must distinguish maintainer requirements from
candidate mechanisms and unperformed proof.

## Acceptance evidence

Revision-specific evidence, replacing the previous draft's results:

- Two independent read-only reviews covered the human/model/plan contract and the
  agent/storage/coordination/ADR contract; both reported no substantive findings.
  No different-model assurance is claimed.
- Nine revised Markdown documents and four pending-ADR annotation blocks:
  **66 local links/anchors resolved; four JSON examples parsed**.
- Product-documents and supporting-change feature/acceptance gates: clean.
  Present-documents check against `origin/main`: zero new errors, with 16 existing
  dead references in current capability documents; those are not fixed by this PR.
- Static mockup rendered in Chromium at **1150 × 900** and **360 × 900** CSS pixels.
  Document scroll width equaled viewport width at both sizes; no inspected
  paragraph/list/button/label/table-cell/summary text was below 12px, and the mobile
  text-overflow inspection found none. All business controls were disabled.
  Review/Problems links navigated and the ownership disclosure opened.
- The local review receipt is tied to `content:112c5952eadcec0c`. It is evidence for
  this supporting-document change, not maintainer approval or runtime acceptance.

Publication limitations remain explicit: installed checks are 0.58.0 rather than the
current setup's 0.66.0; setup/hooks/upstream tracker publication are incomplete. The
global backlog gate still refuses four pre-existing stale holds (`madarch-alzf`,
`madarch-u3vw.8`, `madarch-ztyq.11`, `madarch-ztyq.8`) and reports eight time-record
warnings; it also warns that bulk-edited timestamps may contaminate hold ages. No
unrelated task, gate configuration or hook was changed to make that gate green.
The contributor session authorized a draft-only discussion PR; this is not a
maintainer waiver of those requirements.

No runtime implementation, product suite, concurrency proof, migration,
10,000-item performance result, keyboard/200%-zoom acceptance or complete
accessibility audit was exercised.

## DONE WHEN

Draft PR 218 contains the corrected attribution, all twelve maintainer requirements,
one manifest/table proposal, both interfaces, coherent revised ADRs and explicit
pending amendments, a static human-work mockup, and the M0/L1/G1/I1/O1 development
sequence. Revised links/examples and rendered mockup are checked; review results and
remaining agreements are explicit. No implementation, live migration or merge starts.
