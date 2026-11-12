# Readable section-first catalogue graph

Change: madarch-64o5.26
Base: 0148a638fa234accc37a871416f954d4ae3bcf15
Tasks: madarch-64o5.26
Kind: behavior

## Intent
Replace the unreadable all-kinds graph with a section-first, expandable graph and bounded kind neighbourhoods. Restore direct background pan and wheel/pinch zoom.

## Out of scope
Changing plugins or published kind interpretation, fill execution, real model calls, and catalogue contents navigation (.27).

## Changes to requirements
- product-wiki/catalog: section aggregation, counted dependency edges, single-section expansion, bounded kind focus and direct graph manipulation.

## Preserved contracts
None.

## Coverage
- product-wiki/catalog: static test review

## Where it is seen
Kind: request
Place: catalogue Graph view at 1400 and 390 CSS pixels

1. Open the scripted catalogue fixture with the published 519 kinds (the native manifest supplies kinds and dependencies; scripted record counts do not run an agent).
2. Read full section names and kind/record counts without clipped text or overlapping labels; counted arrows distinguish dependency direction.
3. Expand a section; other sections remain collapsed.
4. Choose a kind by search or click; inspect one or two dependency steps in either direction.
5. Drag the background and wheel/pinch to move and zoom the graph.

## Acceptance evidence
Red-before-green graph tests; focused tests, root bun run check and wiki app checks. Browser fixture walk and source review `/tmp/q26-browser-report.md`; implementation evidence `/tmp/q26-graph-report.md`. Final before/after report `/tmp/madarch-64o5.26-report.md` records actual results and any limitations. No mutation or approval claim. Browser evidence uses real Chromium with scripted API data; screenshots are retained, while readability checks are bounded by reported DOM geometry rather than unperformed human visual inspection.

## Design and decisions
Use existing published purpose groups and dependency declarations. No hardcoded readers, alternate graph path or fallback. All new actions come from the wiki UI kit.
