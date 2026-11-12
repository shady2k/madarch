# Fixed dialog controls, complete sidebar icons and filled-first kind listings

Change: madarch-64o5.42
Base: 9cb594bf2b72b9610f811413d934aeba05f209f1
Tasks: madarch-64o5.42
Kind: behavior

## Intent
Keep every wiki dialog's title, close control, actions and notes visible while its body scrolls. Give every sidebar entry a shared-kit icon and reject missing icons in the kit check. Show filled Pages by kind sections first in stable declared order, then muted empty sections; apply the same rule to kinds inside each section and update it after live fill.

## Out of scope
- Changes to page routes, localization, existing kind visibility exclusions, counts or page-link code point order.
- New content producers, fill scheduling or new document kinds.
- Owner approval or a claim that a check not run has passed.

## Changes to requirements
- Replace product-wiki/shell with the complete proposed requirement, adding mandatory shared-kit icons for every sidebar entry and checker refusal for missing icons.
- Add product-wiki/dialogs for the shared fixed-header, body-only-scroll and fixed-footer dialog layout and its kit check.
- Replace product-wiki/front-matter navigation ordering with stable filled-first sidebar sections, subgroups and kinds.
- Add product-wiki/pages-by-kind for the sidebar's stable filled-first ordering, muted empty entries and live updates.

## Preserved contracts
- product-wiki/pages: existing page addresses, links and code point page ordering remain unchanged.
- product-wiki/live: saved data continues to update the open wiki without a reload.

## Coverage
- product-wiki/shell: test
- product-wiki/dialogs: test
- product-wiki/pages-by-kind: test
- product-wiki/pages: test
- product-wiki/front-matter: test
- product-wiki/live: test

## Where it is seen
Kind: screen
Place: The wiki role chooser and other dialogs, the sidebar's Pages by kind section and the UI-kit preview.
Mockup: docs/changes/madarch-64o5.42/dialog-sidebar.html
1. Open a long wiki dialog at desktop and narrow widths, then scroll its body; the title, close control, actions and notes remain in view.
2. Inspect the sidebar; every entry has a shared-kit icon beside its label.
3. Open Pages by kind with both filled and empty sections; filled sections precede muted empty ones, preserving declared order within each partition.
4. Open a section with both filled and empty kinds and observe the same ordering inside it.
5. Fill an empty kind and observe the updated section and kind positions without reloading.
6. Open the UI-kit preview to inspect the shared dialog layout; run the kit check against a whole-dialog scroll or missing sidebar icon and observe refusal.

## Blocking questions
None.

## Design and decisions
The shared kit owns dialog layout. Consumers use its header, body and footer rather than independently arranging scroll containers. Sidebar entries use the kit's icon API. The sidebar's Pages by kind uses a stable filled/empty partition for sections, subgroups and kinds; a count change triggers the same projection again. Existing visibility exclusions and counts are preserved.

## Acceptance evidence
- Sidebar implementation coverage: `wiki/app/src/knowledge/layout.test.tsx` covers stable section, subgroup and kind partitions, mounted reorder after fill and icons/empty styles across fill phases. `wiki/app/src/knowledge/entities.test.tsx` covers navigation with eligible empty kinds visible. The implementation worker records its focused native results in `/tmp/task42-sidebar-report.md`; this document does not replace that report.
- Dialog implementation coverage: `wiki/app/src/components/ui/dialog.test.tsx` covers preview slots and mounted close/footer behavior; `wiki/app/src/knowledge/readers.test.tsx` covers role dialogs; `wiki/app/src/knowledge/kit-page.test.tsx` covers the kit preview. The implementation worker records its focused native results in `/tmp/task42-dialog-report.md`.
- Checker regression coverage belongs to `test/ui-architecture.test.ts` for missing sidebar icons and whole-dialog scrolling.

Check results and remaining blockers are reported in `/tmp/task42-docs-report.md`. No owner approval is invented. Implementation, browser and suite evidence must be collected against the final source tree; this document does not claim those checks have passed.

## DONE WHEN
- Every wiki dialog scrolls only its body while its header and footer remain visible, and the kit check refuses whole-dialog scrolling.
- Every sidebar entry has a shared-kit icon, and the kit check refuses missing icons.
- Filled sections and kinds precede muted empty ones in stable declared order and update after live fill.
