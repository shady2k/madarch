# All sidebar sections before and after fill

Change: madarch-64o5.35
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.35
Kind: behavior

## Intent
The Pages by kind sidebar keeps all declared sections visible, each with its actual count. Empty sections are muted rather than removed.

## Out of scope
Changing the catalogue, per-kind pages, fill execution, role ordering or real model execution.

## Changes to requirements
- product-wiki/shell: persistent declared section navigation and zero counts, including expanded child sections.

## Preserved contracts
None.

## Coverage
- product-wiki/shell: static test review

## Where it is seen
Kind: request
Place: wiki sidebar before a fill and after a selective fixture fill

1. Open an unfilled scripted fixture with several declared sections.
2. See every declared section with 0 count and muted text.
3. Expand a parent: empty child sections remain visible with zero count.
4. Populate one section in the fixture and refresh: all other sections remain visible and muted; the populated section has its actual count.

## Acceptance evidence
Actual red `/tmp/q35-sidebar-red.log` (13 pass, 4 fail) then green `/tmp/q35-sidebar-green.log` for `wiki/app/src/knowledge/layout.test.tsx`: all declared sections, child sections and no-kind sections before/selective/after fill, actual zero and positive counts, muted kit styling, unchanged per-kind and waiting-list behavior. Native root and wiki checks, full wiki suite; review `/tmp/q35-review.md`. No mutation or visual check claimed. Logs and before/after report `/tmp/madarch-64o5.35-report.md`.

## Design and decisions
No new label grammar checker: this task adds no action-label changes.
