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

Integration decision: resolve kind-details.tsx using the full catalogue for bounded two-hop focus while retaining the selected-language-only description and all declaration/source fields. Resolve kind-graph.tsx using section-first layout plus .31 plugin folders and absent-label markers. Center the chosen card using the kit transformed viewport rather than obsolete scroll offsets; keep its max-h-96 bound. Integration evidence and limitations: /tmp/i26-report.md. New-base focused tests: 25 pass, 0 fail; wiki check and normal production build exit 0. Chromium 148 walked Graph and a detailed code.file kind page at 1400/390 in English/Russian. Graph counts, section collapse/expansion, bounded sets, drag/wheel, dedicated CDP pinch and overview routes were measured. The chosen kind card is centered inside the retained 384px bound at both widths; declaration, meaning, field labels and sources match the archived published detailed response. Fixtures are intercepted, not a new native fill. No complete root or wiki aggregate is claimed. Historical q26 reports above are not new-base passes. No owner approval or tracker closure is asserted.
