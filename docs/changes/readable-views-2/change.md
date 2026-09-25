# Make the reference system's views readable

Change: readable-views-2
Base: a2c8658a7ecdbb945e13c39f837a31f78999fe10
Tasks: madarch-48x.2.1, madarch-48x.2.2
Kind: behavior

## Intent
The views of the reference system parse and render, but a person cannot read
most of them. Rendered by GitHub's own Mermaid in a 1150-pixel column, five of
the eight pages show arrow labels under 12 pixels (the landscape 7.8) and seven
have labels over other labels or boxes: merged labels of up to 103 characters
widen every diagram until GitHub shrinks it. After this change every arrow
carries a short label, the full names behind each arrow sit in a table under
its diagram, an element's own view shows the module that does the work rather
than an arrow from its frame, and every page meets numbers a reader can check.

Stories:
- As an architect, I read every label of the landscape on a wide screen
  without zooming.
- As an architect, I open the checkout service and see which module takes the
  payment.
- As a writer of documentation, I find every relation behind an arrow in the
  table under the diagram.

## Out of scope
Drawing events from the broker to their consumers (waits on the owner's
decision madarch-48x.1 and joins this change or follows it); direct
producer-to-consumer arrows through a topic; LikeC4, which labels each relation
on its own; views per environment or state; the server.

## Rationale
The owner looked at the merged views on 2026-09-25 and found them unreadable;
the numbers above were measured afterwards on every page. The earlier reading
of refinement-counted-once (a refinement is drawn only when both its own ends
are shown) hid, in a service's own view, the module that does the work behind
an arrow from the service's frame; the owner accepted drawing the module's
refinement there instead.

## Changes to requirements
- views: labels are short with a table of every arrow's names; Mermaid pages
  carry that table and meet a label size and no-overlap measure on GitHub.
- graph-queries: in a view with its context, a module's refinement replaces
  the relation it refines when that relation starts or ends at the scope
  itself.

## Preserved contracts
None.

## Coverage
- views/labels: test
- views/mermaid: test, views-check, readability
- graph-queries/view: test

## Blocking questions
None.

## Design and decisions
Decided with the owner on 2026-09-25: short labels with the list in a table
under the diagram; the module's refinement in its element's own view; the
acceptance measured in numbers on GitHub's own renderer. Measured before: see
Intent. The measure is taken by rendering each page with the Mermaid renderer
GitHub itself serves, in a 1150-pixel column, and reading the rendered labels'
size and boxes; the numbers are recorded per page in the acceptance record.
It is not automated in CI (it needs a browser).

## Acceptance evidence
Recorded on the change's tasks as `check:` comments and in the stage's
acceptance record, with the per-page numbers.

## DONE WHEN
On every page of the reference system, rendered by GitHub's Mermaid in a
1150-pixel column, labels are at least 12 pixels and none overlaps another
label or a box; every arrow is labelled and its names are in the table under
the diagram; the checkout service's page draws its payment step to Payments.
Where it is seen: the pages under `examples/reference-system/views/mermaid/`
on GitHub.
